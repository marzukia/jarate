/**
 * channel/queue — mid-turn re-wake queue + queued acks + queue control.
 *
 * God-file split 2/5 (2026-10-19). Moved verbatim from index.ts: the
 * re-wake queue (queueMidTurnInbound / pop / clear / drain / drop),
 * queued acks (consume/renumber), and queue control (update/delete of
 * queued inbounds). Absorbs the
 * pre-existing queue.ts (extractQueueSuffix) — same path, no import
 * changes for that function.
 *
 * Shared state owned elsewhere: configRoot + runtimeStateDir +
 * interrupt state stay in index.ts (hub-and-spoke, runtime-only
 * cross-refs); hold state (heldChannels) likewise.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractBtwSuffix } from "./btw";
import { hasOwnerConfigured, isOwnerUser } from "./commands";
import { deleteDiscordMessage, editDiscordMessage } from "./discord";
import {
  armInterruptTimer,
  buildChannelContext,
  buildRepliedMessageBlock,
  channelTitle,
  configRoot,
  ensureRuntimeStateLoaded,
  heldChannels,
  interruptingChannels,
  interruptStepTimeoutMs,
  isBgInbound,
  pendingInterrupts,
  runtimeStateDir,
} from "./index";
import { persistLivePlaceholders } from "./live";
import {
  collectRewakeOrphans,
  rewakeAddPending,
  rewakePending,
  rewakeRemovePending,
  rewakeUpdatePendingMsg,
} from "./restart-queue";
import {
  type AttachmentRef,
  type ChannelConfig,
  type ChannelMessage,
  getChannel,
  loadChannelConfig,
} from "./types";

// Detects a `. queue` suffix at the end of a Discord message.
//
// Kimaki parity: a plain message during an active run ARMS the mid-run
// interrupt (jump the queue). A message ending in ". queue" is parked in
// the re-wake queue explicitly — it waits its turn and does NOT arm the
// interrupt. The suffix is stripped from the stored/forwarded text; the
// bot's ack shows the message's position in line.
//
// Supported forms (case-insensitive):
// - ". queue", "! queue", "; queue", ": queue" (punctuation, then the word)
// - "....queue" style punctuation runs: "text... queue", "text.queue"
// - optional trailing period/spaces: "text. queue.", "text. queue   "
// Non-matches:
// - "put it in the queue" (no punctuation before the word)
// - "buy eggs, queue" (comma = list, ambiguous)
// - "do this. queued" (not the bare word)
// - "queue" alone

const QUEUE_SUFFIX_RE = /(?:[.!?;:]\s*)+queue\.?\s*$/i;

export function extractQueueSuffix(content: string): {
  prompt: string;
  forceQueue: boolean;
} {
  if (!QUEUE_SUFFIX_RE.test(content)) {
    return { prompt: content, forceQueue: false };
  }
  return {
    prompt: content.replace(QUEUE_SUFFIX_RE, "").trimEnd(),
    forceQueue: true,
  };
}

// ─── Mid-turn re-wake queue ─────────────────────────────────────────────
// An inbound that arrives while a run is in flight is NOT steered into the
// in-flight run (pi's deliverAs:"steer" folds it in, and if the run ends
// before a model step consumes it the message is swallowed with no new
// turn). Instead we queue the FULL ChannelMessage here — per channel, in
// arrival order — and re-run it as a fresh inbound at agent_end, which
// guarantees a dedicated new run. One entry = one message = one re-wake run.
interface QueuedInbound {
  msg: ChannelMessage;
  queuedAt: number;
  /** Pre-rendered LLM text (channel ctx + body/attachments), captured at
   *  queue time so the mid-run interrupt can force-deliver it without async
   *  re-rendering (re-rendering is async and would widen the send/abort
   *  race window). The re-wake path still re-renders via handleInbound. */
  text?: string;
  title?: string;
  display?: string;
}
export const midTurnQueues = new Map<string, QueuedInbound[]>();

// ─── Queue acks ([queued] N in line) ─────────────────────────────────────
// One ack message per queued inbound, keyed by the inbound's Discord
// message id. Deleted when the entry is consumed/dropped; renumbered when
// an entry ahead of it leaves the line (delete or consume).
export const queuedAcks = new Map<
  string,
  { ackId: string; fromId?: string; pos: number }
>();
export function resolveChannel(channelId: string): ChannelConfig | undefined {
  return configRoot
    ? getChannel(loadChannelConfig(configRoot), channelId)
    : undefined;
}

/** Drop the stored ack for a consumed/dropped message, then renumber the
 *  acks of the entries still in line. The REST delete is fire-and-forget
 *  unless `deletes` is given — the shutdown drain passes one and awaits
 *  it, because the process may exit before an unawaited delete lands. */
export function consumeQueuedAck(
  channelId: string,
  messageId: string,
  deletes?: Promise<unknown>[],
): void {
  const ack = queuedAcks.get(messageId);
  if (ack) {
    queuedAcks.delete(messageId);
    const ch = resolveChannel(channelId);
    if (ch) {
      const del = deleteDiscordMessage(ch, ack.ackId).catch(() => {});
      if (deletes) deletes.push(del);
    }
  }
  renumberQueuedAcks(channelId);
  persistLivePlaceholders(); // #84: the ack line left (or was renumbered)
}

/** Re-edit the channel's remaining queued acks so positions stay true
 *  after an entry ahead of them left the line. No-op when already correct.
 *  The ack is one-line op status — prose, unfenced (STYLE.md v4 §2.3). */
function renumberQueuedAcks(channelId: string): void {
  const ch = resolveChannel(channelId);
  if (!ch) return;
  const q = midTurnQueues.get(channelId) ?? [];
  q.forEach((e, i) => {
    const ack = queuedAcks.get(e.msg.messageId);
    if (!ack || ack.pos === i + 1) return;
    ack.pos = i + 1;
    editDiscordMessage(ch, ack.ackId, `[queued] ${i + 1} in line`).catch(
      () => {},
    );
  });
}

/** Queue a mid-turn inbound for a re-wake. Returns the new queue depth
 *  (the message's 1-based position in its channel's line). `armInterrupt`
 *  defaults to true; ". queue"-suffixed messages pass false so they wait
 *  their turn instead of jumping it. */
export function queueMidTurnInbound(
  channelId: string,
  msg: ChannelMessage,
  text?: string,
  title?: string,
  display?: string,
  armInterrupt = true,
): number {
  let q = midTurnQueues.get(channelId);
  if (!q) {
    q = [];
    midTurnQueues.set(channelId, q);
  }
  const entry: QueuedInbound = {
    msg,
    queuedAt: Date.now(),
    text,
    title,
    display,
  };
  q.push(entry);
  // #180 (survival path): mirror the entry into the per-channel state
  // file. session_shutdown clears MEMORY only; the file is what a
  // respawn drains. Synchronous tmp+rename right after the push — the
  // in-memory → file window is the same tick, no await in between.
  rewakeAddPending(runtimeStateDir, channelId, {
    msg,
    queuedAt: entry.queuedAt,
  });
  console.log(
    `[channel] queued mid-turn inbound, will re-wake (${q.length} queued)`,
  );
  // #177: machine wakes are queue-only. The re-wake queue already
  // guarantees agent_end delivery; the interrupt only jumps the line, and
  // a machine alert is never more urgent than the in-flight turn — so it
  // never arms one. (2026-10-06 incident: a reviewer callback posted
  // mid-turn armed the 3s interrupt, was never consumed, and was lost at
  // compact.)
  if (armInterrupt && !isBgInbound(msg)) {
    // 4x (12s) case: an interrupt is already in flight (re-wake run in
    // progress). Without this, rapid-fire messages cascade — each new
    // message arms a 3s interrupt that kills the re-wake run mid-LLM-call,
    // forcing a full 120K-token prefill restart. The message is queued
    // with a guaranteed re-wake either way, so the longer window only
    // changes WHEN the interrupt cuts in. All other senders keep the 3s
    // default (quick cut-in).
    const delay = interruptingChannels.has(channelId)
      ? interruptStepTimeoutMs() * 4 // 12s: give the in-flight run room
      : undefined; // default 3s
    armInterruptTimer(channelId, msg.messageId, delay);
  }
  return q.length;
}

// ─── Re-wake FIFO ────────────────────────────────────────────────────────

/** Pop the globally oldest queued inbound across all channels (FIFO).
 *  Held channels (#39) are skipped: their buffer drains on /hold off,
 *  not at agent_end. (The #231 P3 in-turn-consumed marker drop is gone
 *  with jarate-wait, the only marker producer — #279 drain.) */
export function popOldestQueuedInbound(): {
  channelId: string;
  msg: ChannelMessage;
} | null {
  ensureRuntimeStateLoaded();
  for (;;) {
    let oldest: {
      channelId: string;
      msg: ChannelMessage;
      queuedAt: number;
    } | null = null;
    for (const [channelId, q] of midTurnQueues) {
      if (heldChannels.has(channelId)) continue;
      const head = q[0];
      if (!head) continue;
      if (!oldest || head.queuedAt < oldest.queuedAt)
        oldest = { channelId, msg: head.msg, queuedAt: head.queuedAt };
    }
    if (!oldest) return null;
    const q = midTurnQueues.get(oldest.channelId)!;
    // The head can move between scan and shift (a delete or interrupt
    // cancel splices it): recompute on a stale snapshot instead of
    // shifting the wrong entry.
    if (q[0]?.queuedAt !== oldest.queuedAt) continue;
    q.shift();
    if (q.length === 0) midTurnQueues.delete(oldest.channelId);
    consumeQueuedAck(oldest.channelId, oldest.msg.messageId);
    return { channelId: oldest.channelId, msg: oldest.msg };
  }
}

/** Drop all queued inbounds for a channel (/stop, shutdown drain).
 *  `deletes` collects the ack-delete promises so the caller can await
 *  them (session_shutdown must — the process dies right after). Returns
 *  the count dropped. `keepFile` (session_shutdown only): the in-memory
 *  drain is the fast path (ack cleanup); the #180 state file is the
 *  SURVIVAL path and must outlive the process. */
export function clearQueuedInbound(
  channelId: string,
  deletes?: Promise<unknown>[],
  opts?: { keepFile?: boolean },
): number {
  const q = midTurnQueues.get(channelId);
  if (!q) return 0;
  for (const e of q) {
    consumeQueuedAck(channelId, e.msg.messageId, deletes);
    if (!opts?.keepFile)
      rewakeRemovePending(runtimeStateDir, channelId, e.msg.messageId);
  }
  const n = q.length;
  midTurnQueues.delete(channelId);
  return n;
}

/** #180 (survival drain): re-queue persisted pending entries into the
 *  in-memory re-wake queue at a real process start. The file is left in
 *  place — entries are pruned from it exactly when committed to pi
 *  (sendToPi) or dropped, so a second death before delivery re-drains
 *  the same file and the message is still delivered exactly once.
 *  Returns the count re-queued. Exported for tests. */
export function drainRewakeSurvival(
  stateDir: string,
  channels: ChannelConfig[],
): number {
  let n = 0;
  for (const ch of channels) {
    if (ch.type !== "discord") continue;
    // Best-effort cleanup of tmp files orphaned by a crash mid-write
    // (the shared atomic-write naming scheme makes them recognizable).
    collectRewakeOrphans(stateDir, ch.id);
    const pending = rewakePending(stateDir, ch.id);
    if (pending.length === 0) continue;
    const q = midTurnQueues.get(ch.id) ?? [];
    for (const e of pending) {
      // Fresh process: midTurnQueues is empty; the guard is for
      // in-process reuse and is idempotent either way.
      if (q.some((x) => x.msg.messageId === e.msg.messageId)) continue;
      q.push({ msg: e.msg, queuedAt: e.queuedAt });
      // #194 interaction: the fresh process has an EMPTY queuedAcks
      // map, but the `[queued] N in line` line survived the restart
      // (the crash-settle keeps it alive when a rewake entry is
      // restored) — restore its id at its line position so the
      // re-wake drain's consumeQueuedAck deletes it exactly once.
      if (e.ackId)
        queuedAcks.set(e.msg.messageId, {
          ackId: e.ackId,
          pos: q.length,
        });
      n += 1;
    }
    midTurnQueues.set(ch.id, q);
  }
  if (n > 0)
    console.log(
      `[channel] rewake survival: re-queued ${n} queued inbound(s) from state files`,
    );
  return n;
}

/** Pop the oldest queued inbound for ONE channel (#39 /hold off drain).
 *  Returns null when the channel's line is empty. */
export function popChannelQueuedInbound(
  channelId: string,
): QueuedInbound | null {
  const q = midTurnQueues.get(channelId);
  if (!q || q.length === 0) return null;
  const e = q.shift()!;
  if (q.length === 0) midTurnQueues.delete(channelId);
  consumeQueuedAck(channelId, e.msg.messageId);
  return e;
}

/** Drop one queued entry by id WITHOUT delivering it (#186 F1): the
 *  delivery already happened through another path (the cursor-replay
 *  direct send) and its commit must not leave the drained copy behind
 *  for the agent_end re-wake to pop — that second pop is exactly the
 *  double delivery. Consume the ack like a pop would. No-op when the
 *  id is not queued (the normal pop-then-send order reaches here with
 *  the entry already out of the line). */
export function dropQueuedInbound(channelId: string, messageId: string): void {
  const q = midTurnQueues.get(channelId);
  if (!q) return;
  const idx = q.findIndex((e) => e.msg.messageId === messageId);
  if (idx === -1) return;
  q.splice(idx, 1);
  if (q.length === 0) midTurnQueues.delete(channelId);
  consumeQueuedAck(channelId, messageId);
}

/** Remove one armed interrupt timer (the queue entry for it is gone).
 *  No-op when the message never armed one. */
export function disarmInterrupt(channelId: string, messageId: string): void {
  const list = pendingInterrupts.get(channelId);
  if (!list) return;
  const i = list.findIndex((p) => p.messageId === messageId);
  if (i === -1) return;
  clearTimeout(list[i].timer);
  list.splice(i, 1);
  if (list.length === 0) pendingInterrupts.delete(channelId);
}

// ─── Mid-run interrupt ─────────────────────────────────────────────────

// ─── Queue control: edit + delete of queued inbounds ─────────────────────
// The re-wake queue keeps the FULL ChannelMessage per entry, so the
// Discord MESSAGE_UPDATE / MESSAGE_DELETE gateway events (routed per
// channel in discord.ts) can target an entry by message id. Owner-only,
// same isOwner rule as the channel commands.

/** Re-render a queued entry after its Discord message was edited.
 *  Updates the stored ChannelMessage (the re-wake path re-processes it
 *  through the full inbound pipeline) and the pre-rendered interrupt text
 *  (the plain-path ctx pipeline: channel-ctx + replied-message +
 *  suffix-stripped body). FIFO position is kept. Returns false when
 *  the message is not queued or the editor is not the owner. */
export async function updateQueuedInbound(
  ctx: ExtensionContext,
  channelId: string,
  messageId: string,
  content: string,
  attachments: AttachmentRef[],
  authorId: string | undefined,
): Promise<boolean> {
  const q = midTurnQueues.get(channelId);
  const entry = q?.find((e) => e.msg.messageId === messageId);
  if (!entry) return false;
  const ch = getChannel(loadChannelConfig(ctx.cwd), channelId);
  if (hasOwnerConfigured(ch) && !isOwnerUser(ch, authorId)) return false;
  entry.msg.body = content;
  entry.msg.attachments = attachments;
  // #186 (F2): rewrite the FILE copy too — the file is the survival
  // path; a restart before delivery must drain the edited
  // body/attachments, not the pre-edit msg.
  rewakeUpdatePendingMsg(runtimeStateDir, channelId, messageId, entry.msg);

  // Plain-path re-render (same pipeline as handleInbound's no-attachment
  // branch). Entries queued WITH attachments keep their stored file-folder
  // text stale for the interrupt path; the re-wake path (the common one)
  // re-downloads and re-renders them fully from entry.msg.
  const { prompt: body, forceBtw } = extractBtwSuffix(content.trim());
  const channelCtx = buildChannelContext(ch, entry.msg, { btw: forceBtw });
  const repliedBlock = buildRepliedMessageBlock(entry.msg.repliedMessage);
  const ctxBlock = [channelCtx, repliedBlock].filter(Boolean).join("\n\n");
  entry.text = `${ctxBlock}\n\n${body || "(empty)"}`;
  entry.title = channelTitle(ch, entry.msg);
  entry.display = body || "(empty)";
  console.log(
    `[channel] queued inbound ${messageId} re-rendered from message edit`,
  );
  return true;
}

/** Drop a queued entry after its Discord message was deleted. Removes the
 *  entry, disarms its interrupt timer, deletes the "[queued] N in line"
 *  ack, and renumbers the remaining line. Owner-only. */
export async function deleteQueuedInbound(
  ctx: ExtensionContext,
  channelId: string,
  messageId: string,
): Promise<void> {
  const ch = getChannel(loadChannelConfig(ctx.cwd), channelId);
  const q = midTurnQueues.get(channelId);
  const idx = q ? q.findIndex((e) => e.msg.messageId === messageId) : -1;
  const ack = queuedAcks.get(messageId);
  if (idx === -1 && !ack) return; // never queued, no ack: not ours
  if (hasOwnerConfigured(ch)) {
    const fromId = idx !== -1 && q ? q[idx].msg.fromId : ack?.fromId;
    if (!isOwnerUser(ch, fromId)) return; // owner only
  }
  if (idx !== -1 && q) {
    q.splice(idx, 1);
    if (q.length === 0) midTurnQueues.delete(channelId);
    disarmInterrupt(channelId, messageId);
    // #180: the operator deleted the message — the survived copy must
    // not resurrect it on the next restart.
    rewakeRemovePending(runtimeStateDir, channelId, messageId);
    console.log(
      `[channel] queued inbound ${messageId} dropped (message deleted)`,
    );
  }
  if (ack) {
    queuedAcks.delete(messageId);
    if (ch) deleteDiscordMessage(ch, ack.ackId).catch(() => {});
  }
  renumberQueuedAcks(channelId);
}
