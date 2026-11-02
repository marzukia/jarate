/**
 * channel/live.ts — live channel text: #84 crash-settle placeholder
 * persistence, the shared long-op live tick (issue #22) + compact
 * placeholder, and SPEC B live intermediate text.
 *
 * Extracted from channel/index.ts (god-file split 3/5, 2026-10-19).
 * Pure move — code is verbatim from index.ts; only import/export
 * boundaries were added.
 */
import * as fs from "node:fs";
import path from "node:path";

import {
  deleteDiscordMessage,
  editDiscordMessage,
  sendDiscordMessage,
} from "./discord";
import {
  compactingChannels,
  interruptCancelled,
  interruptInFlight,
  interruptingChannels,
  isCompacting,
  pendingInterrupts,
  runtimeStateDir,
} from "./index";
import { midTurnQueues, queuedAcks } from "./queue";
import { sanitizeUnknownValue } from "./sanitize";
import type { ChannelConfig } from "./types";

// ─── Live placeholder persistence (#84: crash settle) ───────────────────
// A process death (OOM, SIGKILL, power loss) runs neither agent_end nor
// session_shutdown — the working frame, SPEC B live text, in-flight
// interrupt ack, open compact line, and queued-inbound acks freeze in the
// channel. #173 settled the PLANNED death; this covers the unplanned one.
// Every live placeholder is recorded here on post, cleared on settle (the
// file exists iff a placeholder is live); the next real process start
// (session_start reason "startup") reads the file and drives whatever
// survived to a terminal state. Queued-inbound entry REDISPATCH is issue
// #180's scope — here only the placeholder LINES are settled, plus the
// spliced in-flight interrupt entry (the queue no longer holds it, so
// nobody else redelivers it).
export interface LiveFrameRec {
  channelId: string;
  msgId: string;
  /** Shown call count at snapshot time (0 -> startup deletes, not morphs). */
  calls: number;
  /** Last rendered UNFENCED working frame body (null when unrenderable). */
  body: string | null;
}
interface LiveMsgRec {
  channelId: string;
  msgId: string;
}
interface LiveInterruptRec extends LiveMsgRec {
  ackId: string | null;
  text: string;
  title: string;
  display: string;
}
interface LiveQueueAckRec {
  channelId: string;
  /** The queued inbound message id the ack belongs to. */
  inboundId: string;
  ackId: string;
  pos: number;
}
interface LivePlaceholderState {
  v: 1;
  frame: LiveFrameRec | null;
  liveText: LiveMsgRec | null;
  interrupts: LiveInterruptRec[];
  compacts: LiveMsgRec[];
  queueAcks: LiveQueueAckRec[];
}

/** Pre-rendered entry of an in-flight interrupt, kept alongside
 *  interruptInFlight so a crash can redeliver it (#84). */
export const interruptEntryInFlight = new Map<
  string,
  { text: string; title: string; display: string }
>();

/** Pure-compact placeholder lines (armCompactTick only; restart-class op
 *  windows are covered by the op marker, and #173's shutdown settles both). */
export const compactPlaceholders = new Map<string, string>(); // channelId -> msgId

const LIVE_PLACEHOLDERS_FILE = "live-placeholders.json";

/** Closure-scoped frame/live-text state, registered by the extension.
 *  Null outside an extension instance (e.g. in unit scope). */
let livePlaceholderSnapshot:
  | (() => { frame: LiveFrameRec | null; liveText: LiveMsgRec | null })
  | null = null;

export function setLivePlaceholderSnapshot(
  fn:
    | (() => { frame: LiveFrameRec | null; liveText: LiveMsgRec | null })
    | null,
): void {
  livePlaceholderSnapshot = fn;
}

function livePlaceholdersPath(): string | null {
  return runtimeStateDir
    ? path.join(runtimeStateDir, LIVE_PLACEHOLDERS_FILE)
    : null;
}

/** Snapshot the queued-ack lines: acks whose entries are still in the
 *  queue (an in-flight interrupt's ack rides its interrupt record instead). */
function snapshotQueueAcks(): LiveQueueAckRec[] {
  const out: LiveQueueAckRec[] = [];
  for (const [messageId, ack] of queuedAcks) {
    for (const [channelId, q] of midTurnQueues) {
      if (!q.some((e) => e.msg.messageId === messageId)) continue;
      out.push({
        channelId,
        inboundId: messageId,
        ackId: ack.ackId,
        pos: ack.pos,
      });
      break;
    }
  }
  return out;
}

/** Rewrite <cwd>/.tmp/live-placeholders.json atomically (or unlink it when
 *  no placeholder is live). Never throws — a persist failure must not break
 *  the message path; the crash settle is best-effort on top. */
export function persistLivePlaceholders(): void {
  const p = livePlaceholdersPath();
  if (!p) return;
  try {
    const snap = livePlaceholderSnapshot?.() ?? { frame: null, liveText: null };
    const interrupts: LiveInterruptRec[] = [];
    for (const [channelId, msgId] of interruptInFlight) {
      const entry = interruptEntryInFlight.get(channelId);
      if (!entry) continue;
      interrupts.push({
        channelId,
        msgId,
        ackId: queuedAcks.get(msgId)?.ackId ?? null,
        ...entry,
      });
    }
    const state: LivePlaceholderState = {
      v: 1,
      frame: snap.frame,
      liveText: snap.liveText,
      interrupts,
      compacts: [...compactPlaceholders].map(([channelId, msgId]) => ({
        channelId,
        msgId,
      })),
      queueAcks: snapshotQueueAcks(),
    };
    const empty =
      !state.frame &&
      !state.liveText &&
      state.interrupts.length === 0 &&
      state.compacts.length === 0 &&
      state.queueAcks.length === 0;
    if (empty) {
      unlinkLivePlaceholders();
      return;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.error(
      "[channel] live-placeholder persist failed:",
      sanitizeUnknownValue(e),
    );
  }
}

/** Read + validate the persisted record. `null` = no file or corrupt. */
export function readLivePlaceholders(): LivePlaceholderState | null {
  const p = livePlaceholdersPath();
  if (!p) return null;
  try {
    const s = JSON.parse(fs.readFileSync(p, "utf8")) as any;
    if (typeof s !== "object" || s?.v !== 1) return null;
    const isMsgRec = (r: any): r is LiveMsgRec =>
      !!r && typeof r.channelId === "string" && typeof r.msgId === "string";
    return {
      v: 1,
      frame:
        s.frame &&
        typeof s.frame.channelId === "string" &&
        typeof s.frame.msgId === "string"
          ? {
              channelId: s.frame.channelId,
              msgId: s.frame.msgId,
              calls: typeof s.frame.calls === "number" ? s.frame.calls : 0,
              body: typeof s.frame.body === "string" ? s.frame.body : null,
            }
          : null,
      liveText: isMsgRec(s.liveText) ? s.liveText : null,
      interrupts: Array.isArray(s.interrupts)
        ? (s.interrupts.filter(
            (r: any) =>
              !!r &&
              typeof r.channelId === "string" &&
              typeof r.msgId === "string" &&
              typeof r.text === "string" &&
              (r.ackId === null || typeof r.ackId === "string"),
          ) as LiveInterruptRec[])
        : [],
      compacts: Array.isArray(s.compacts) ? s.compacts.filter(isMsgRec) : [],
      queueAcks: Array.isArray(s.queueAcks)
        ? s.queueAcks.filter(
            (r: any) =>
              !!r &&
              typeof r.channelId === "string" &&
              typeof r.inboundId === "string" &&
              typeof r.ackId === "string",
          )
        : [],
    };
  } catch {
    return null;
  }
}

/** Remove the record (best-effort; a missing file is the normal state). */
export function unlinkLivePlaceholders(): void {
  const p = livePlaceholdersPath();
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch {
    /* already gone */
  }
}

/**
 * Simulate a process death for tests: drop the in-memory live state
 * WITHOUT rewriting the persisted record — a crash runs no code, so the
 * file must survive exactly as the live process last wrote it.
 */
export function simulateProcessDeathForTest(): void {
  pendingInterrupts.clear();
  interruptingChannels.clear();
  interruptCancelled.clear();
  interruptInFlight.clear();
  interruptEntryInFlight.clear();
  compactPlaceholders.clear();
  midTurnQueues.clear();
  queuedAcks.clear();
}

// ─── Shared long-op live tick (issue #22, generalized 2026-09-11) ────
// One 5s edit-in-place ticker for EVERY long-op placeholder: compaction,
// restart-class ops (/reset /restart /undo /redo), the working block
// (statusTick), and mid-run interrupts. `render` returns the next line
// or null to pause (window closed — the entry is KEPT so a settle can
// still replace the message in place). Machine-surface style (Andryo
// 2026-10-31): no code fences, no embeds — one-line ticks ship
// italic (`*[..] compacting… 5s*`); the live working frame keeps its
// box shape, fence-less (header `┌ working · N calls · 10s`).
interface OpTickEntry {
  ch: ChannelConfig;
  msgId: string;
  since: number;
  timer: ReturnType<typeof setInterval>;
  render: (secs: number) => string | null;
}
export const opTicks = new Map<string, OpTickEntry>();

/** `[..] <label>… <inc>s` — 5s-increment elapsed, shared tick style.
 *  Machine surface (Andryo 2026-10-31): short one-line ticks ship
 *  italic, no code fence. */
export function opTickLine(label: string, secs: number): string {
  const inc = Math.floor(secs / 5) * 5;
  return `*[..] ${label}… ${inc}s*`;
}

/** Machine-surface formatting (Andryo 2026-10-31: plain text, no
 *  embeds, no code fences): a short single line (ack, wake, placeholder,
 *  tick) ships ITALIC; a multi-line block (help, json, lists) ships
 *  plain. Stray asterisks in the text are escaped so the italic markup
 *  survives Discord parsing. */
export const machine = (s: string): string => {
  if (s.includes("\n")) return s;
  return `*${s.replace(/\*/g, "\\*")}*`;
};

/** Arm (or re-arm, same key) a live tick on a placeholder message.
 *  Ticks post bare machine text (no fence — Andryo 2026-10-31); the
 *  `render` output is the final form (italic one-liners, bare frames). */
export function armOpTick(
  key: string,
  ch: ChannelConfig,
  msgId: string,
  render: (secs: number) => string | null,
): void {
  const prev = opTicks.get(key);
  if (prev) clearInterval(prev.timer);
  const since = Date.now();
  const timer = setInterval(() => {
    const entry = opTicks.get(key);
    if (!entry) return;
    const text = entry.render(Math.floor((Date.now() - since) / 1000));
    if (text === null) {
      clearInterval(entry.timer); // paused; entry kept for the settle
      return;
    }
    editDiscordMessage(entry.ch, entry.msgId, text).catch(() => {});
  }, 5000);
  (timer as any).unref?.();
  opTicks.set(key, { ch, msgId, since, timer, render });
}

/** Replace the ticking placeholder in place with the final line. Returns
 *  false when no tick was armed (native slash path / settle raced the
 *  post) — the caller then falls back to a fresh post. The settle must
 *  produce the SAME plain form as the fresh-post fallback. */
export function settleOpTick(key: string, text: string): boolean {
  const entry = opTicks.get(key);
  if (!entry) return false;
  clearInterval(entry.timer);
  opTicks.delete(key);
  editDiscordMessage(entry.ch, entry.msgId, text).catch(() => {});
  return true;
}

/** Stop + drop the tick without a final replace (session_shutdown). */
export function stopOpTick(key: string): void {
  const entry = opTicks.get(key);
  if (!entry) return;
  clearInterval(entry.timer);
  opTicks.delete(key);
}

/** Stop every tick whose key has the prefix (e.g. "working:"). */
export function stopOpTickPrefix(prefix: string): void {
  for (const key of [...opTicks.keys()])
    if (key.startsWith(prefix)) stopOpTick(key);
}

export function stopAllOpTicks(): void {
  for (const key of [...opTicks.keys()]) stopOpTick(key);
}

// ─── Compact placeholder (built on the shared op-tick) ──────────────
// One-line op status = machine surface: italic, no code fence (Andryo
// 2026-10-31); the tick edits it in place (opTickLine).
export const COMPACT_PLACEHOLDER = "*[..] compacting...*";

export function armCompactTick(ch: ChannelConfig, msgId: string): void {
  armOpTick(`compact:${ch.id}`, ch, msgId, (secs) =>
    isCompacting(ch.id) ? opTickLine("compacting", secs) : null,
  );
  compactPlaceholders.set(ch.id, msgId); // #84: crash settle for this line
  persistLivePlaceholders();
}

/**
 * Post the compact placeholder and await it bounded (~5s) — the post-first order of startCompact (2026-11-02 orphan fix): the tick must be armed before ctx.compact() can settle. Returns the posted message id, or null on failure/timeout (the report's fresh-post fallback covers that path). A post that resolves LATE, after the timeout, does not count: arming after the settle would re-create the orphan.
 */
export async function postCompactPlaceholder(
  ch: ChannelConfig,
): Promise<string | null> {
  const post = sendDiscordMessage(ch, COMPACT_PLACEHOLDER).catch(() => null);
  const result = (await Promise.race([
    post,
    new Promise<null>((res) => {
      const timer = setTimeout(res, 5000);
      (timer as any).unref?.();
    }),
  ])) as { success?: boolean; messageId?: string } | null;
  return result?.success && result.messageId ? result.messageId : null;
}

/**
 * Synchronous op-window flag arm (2026-11-02 #jimmy double-fire fix):
 * startCompact calls this at entry, BEFORE the first await (the
 * placeholder post), so the second gate check — agent_end AND
 * agent_settled both arm one 0ms timer per settled turn — sees the
 * flag and bails instead of running a second ctx.compact() (whose
 * 'Already compacted' / 'Nothing to compact' no-op surfaced as a
 * spurious 'compact failed:' line, and whose leading this.abort()
 * could kill a re-wake run). beginCompacting keeps its original
 * position (the full window: 10-min fallback timer + log); its
 * leading clearCompacting consumes this partial (timer-less) entry
 * and opens the real one. The entry arm must be cleared on the
 * startCompact sync-throw path (clearCompacting in the catch).
 */
export function armCompacting(ch: ChannelConfig): void {
  if (compactingChannels.has(ch.id)) return;
  compactingChannels.set(ch.id, {
    since: Date.now(),
    timer: null,
    label: "compacting",
    rewindTo: null,
  });
}

/** By-design no-op compact errors (pi's own guards, 2026-11-02 #jimmy
 *  incident): the error is the expected state, not a failure. Keyed
 *  on the channelError first-line text of pi's Error message. */
const COMPACT_NOOP_LINES: Record<string, string> = {
  "Already compacted": "no change - already compacted",
  "Nothing to compact (session too small)": "no change - nothing to compact",
};

/**
 * Settle the compact tick for a by-design no-op error (2026-11-02
 * #jimmy double-fire): the armed tick settles with the neutral line
 * in place (silent when the placeholder post never landed) and NO
 * 'compact failed:' line is ever posted. Returns true when the text
 * is a known no-op (the caller then skips the failure report); false
 * for aborts (null) and real failures (the caller reports those).
 */
export function settleCompactNoOp(
  channelId: string,
  t: string | null,
): boolean {
  if (t === null) return false;
  const line = COMPACT_NOOP_LINES[t];
  if (line === undefined) return false;
  settleCompactTick(channelId, machine(line));
  return true;
}

/**
 * session_shutdown belt (2026-11-02 orphan fix): drive EVERY live compact placeholder to a terminal state BEFORE stopAllOpTicks drops the paused ticks and unlinkLivePlaceholders drops the record. The in-memory op-tick map is not authoritative — a tick whose window is already closed pauses on its first render (null) and the line would freeze. Terminal state per record: window OPEN -> the interrupted line (the crash-settle wording; no op marker settles this on respawn); window CLOSED -> the result line is already posted, the placeholder is a redundant duplicate -> delete. The record is pure-compact (restart-class op windows are settled by the respawn's op marker). Must run before clearAllCompacting (it would make every open window read as closed). Failures are caught — shutdown never blocks on them. Returns the REST promises for the caller to await.
 */
export function settleCompactPlaceholdersOnShutdown(
  channels: ChannelConfig[],
): Promise<unknown>[] {
  const out: Promise<unknown>[] = [];
  const compactMsgs = new Map<string, string>();
  for (const rec of readLivePlaceholders()?.compacts ?? [])
    compactMsgs.set(rec.channelId, rec.msgId);
  for (const [id, msgId] of compactPlaceholders) compactMsgs.set(id, msgId);
  for (const [id, msgId] of compactMsgs) {
    const ch = channels.find((c) => c.id === id && c.type === "discord");
    if (!ch) continue;
    try {
      const open = isCompacting(id);
      out.push(
        (open
          ? editDiscordMessage(
              ch,
              msgId,
              machine("compact interrupted - restart"),
            )
          : deleteDiscordMessage(ch, msgId)
        ).catch(() => {}),
      );
    } catch (e) {
      console.error(
        "[channel] shutdown compact settle failed:",
        sanitizeUnknownValue(e),
      );
    }
    const t = opTicks.get(`compact:${id}`);
    if (t) clearInterval(t.timer);
    opTicks.delete(`compact:${id}`);
    compactPlaceholders.delete(id); // #84: record follows the settle
  }
  return out;
}

export function settleCompactTick(channelId: string, text: string): boolean {
  const ok = settleOpTick(`compact:${channelId}`, text);
  compactPlaceholders.delete(channelId); // #84: settled = no longer live
  persistLivePlaceholders();
  return ok;
}

export function stopCompactTick(channelId: string): void {
  stopOpTick(`compact:${channelId}`);
  compactPlaceholders.delete(channelId);
  persistLivePlaceholders();
}

export function stopAllCompactTicks(): void {
  stopOpTickPrefix("compact:");
}

/**
 * Early-send gate: if `message` is a finalized intermediate assistant
 * message (>=1 text block AND >=1 toolCall block), return its cleaned text;
 * null otherwise. Finals (text only, no toolCall) return null, so the
 * agent_end path can never double-send them. Exported for tests.
 */
export function earlySendText(message: unknown): string | null {
  const m = message as any;
  if (m?.role !== "assistant") return null;
  const blocks = Array.isArray(m.content) ? m.content : [];
  const hasText = blocks.some((b: any) => b.type === "text");
  const hasToolCall = blocks.some((b: any) => b.type === "toolCall");
  if (!hasText || !hasToolCall) return null;
  const text = blocks
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  return cleanThinking(text.trim()) || null;
}

/**
 * Final-text gate: an assistant message with >=1 text block and NO toolCall
 * block is a step-final. Forwarded at message_end (not agent_end) so a final
 * from a step interrupted by a steering message is never dropped — agent_end
 * only fires for the LAST step of the run and only carries that step's
 * messages. Exported for tests.
 */
export function finalText(message: unknown): string | null {
  const m = message as any;
  if (m?.role !== "assistant") return null;
  const blocks = Array.isArray(m.content) ? m.content : [];
  const hasText = blocks.some((b: any) => b.type === "text");
  const hasToolCall = blocks.some((b: any) => b.type === "toolCall");
  if (!hasText || hasToolCall) return null;
  const text = blocks
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  return cleanThinking(text.trim()) || null;
}

// ─── Live intermediate text (SPEC B) ────────────────────────────────────
// The operator watches the agent think: intermediate (non-final) text
// appears as ONE ephemeral message below the tool-call block, edited in
// place as new segments arrive, deleted when the final is sent or the
// run ends. Level-independent: live text posts at every verbose level;
// the level gates tool-call frames only (Andryo 2026-10-19).
/** Tail budget for the live-text message: keep the last N chars, prepend
 *  an ellipsis when cut (900 + ellipsis stays well under Discord's 2000
 *  char limit after markdown conversion). */
export const LIVE_TEXT_TAIL = 900;
/** Minimum gap between live-text edits (Discord edit-rate headroom). */
export const LIVE_TEXT_THROTTLE_MS = 1500;
/** Shown once a tool call has fired but no intermediate text yet. */
export const LIVE_TEXT_PLACEHOLDER = "[..]";

/** Keep the TAIL of the text; prepend an ellipsis when cut.
 *  Exported for tests. */
export function truncateLiveText(text: string, tail = LIVE_TEXT_TAIL): string {
  if (text.length <= tail) return text;
  return `…${text.slice(-tail)}`;
}

/** Messages already forwarded by the message_end path — agent_end skips them. */
export const earlySent = new WeakSet<object>();

/** Strip leaked Qwen thinking tags (
 /
) from assistant text. */
export function cleanThinking(text: string): string {
  const O = "<think>";
  const C = "</think>";
  const strip = (t: string) =>
    t
      .split(O)
      .join("")
      .split(C)
      .join("")
      .replace(/\n{3,}/g, "\n\n");
  const firstO = text.indexOf(O);
  if (firstO >= 0) {
    const lastC = text.lastIndexOf(C);
    if (lastC > firstO) {
      const before = strip(text.slice(0, firstO)).trim();
      const after = strip(text.slice(lastC + C.length)).trim();
      const both = [before, after].filter(Boolean).join("\n\n");
      if (both) return both;
    }
    const before = strip(text.slice(0, firstO)).trim();
    if (before) return before;
    const after = strip(text.slice(firstO + O.length)).trim();
    if (after) return after;
  }
  return strip(text).trim();
}
