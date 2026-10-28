/**
 * piscord — Transparent channel bridge for pi.
 *
 * Mostly a bridge:
 *   Inbound:  channel message → "channel-inbound" custom message → triggers LLM response
 *   Outbound: assistant response → auto-forwarded to last active channel
 *
 * LLM tools: `send-file` uploads local file(s) to the active channel;
 * `todo` maintains the per-channel todo board (state file + Discord board
 * message re-rendered in place; the board is re-injected into the LLM
 * context on every inbound run).
 *
 * The LLM context keeps a small <channel-ctx> block (channel type, sender,
 * DM/group, reply destination, format hints, per-channel instructions) so the
 * LLM can tailor its answer to the channel. The TUI shows only a compact
 * type/name title (via a custom message renderer) plus the message body.
 *
 * Attachments: downloaded eagerly on arrival into .tmp/attachments/<ts>/
 * (20 MB per-file cap, skipped files noted in the LLM message); file info
 * is included in the LLM message as a folder reference.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { BTW_HINT, extractBtwSuffix } from "./btw";
import { censor } from "./censor";
import {
  buildInteractionHandler,
  channelError,
  failurePostText,
  isOwnerUser,
  matchCommand,
  runChannelCommand,
  runShellPassthrough,
  startCompact,
  wrapFence,
} from "./commands";
import {
  connectDiscord,
  connectDiscordPresence,
  type DiscordCallbacks,
  deleteDiscordMessage,
  disconnectDiscord,
  discordFetch,
  editDiscordMessage,
  getDiscordChannelId,
  getDiscordStates,
  getDiscordToken,
  loadChannelStateFile,
  loadDiscordAttachment,
  loadPersistedCursors,
  MAX_ATTACHMENT_BYTES,
  patchChannelState,
  registerDiscordCommands,
  sendDiscordMessage,
  sendDiscordMessageWithFiles,
  sendDiscordTyping,
  setChannelCursor,
  setDiscordInteractionHandler,
  setDiscordPresenceActivity,
  startSlashReput,
  stopDiscordPresence,
  suppressAutoReact,
  unreactMessage,
} from "./discord";
import { isFleetRun } from "./fleet-run";
import { fmtTokensLC, mdToDiscord, styleGuard } from "./format";
import { FRAME_COL_MAX } from "./frame";
import {
  buildHandover,
  type HandoverComplete,
  isHandoffFreshWindow,
  parsePriorTags,
  resolveHandoffSettings,
  shouldHandoff,
} from "./handover";
import { registerJarateTool } from "./jarate";
import {
  armOpTick,
  cleanThinking,
  compactPlaceholders,
  earlySendText,
  earlySent,
  fence,
  finalText,
  interruptEntryInFlight,
  LIVE_TEXT_THROTTLE_MS,
  type LiveFrameRec,
  opTickLine,
  opTicks,
  persistLivePlaceholders,
  readLivePlaceholders,
  setLivePlaceholderSnapshot,
  settleCompactTick,
  settleOpTick,
  stopAllOpTicks,
  stopOpTick,
  stopOpTickPrefix,
  truncateLiveText,
  unlinkLivePlaceholders,
} from "./live";
import {
  clearQueuedInbound,
  consumeQueuedAck,
  deleteQueuedInbound,
  drainRewakeSurvival,
  dropQueuedInbound,
  extractQueueSuffix,
  midTurnQueues,
  popOldestQueuedInbound,
  queuedAcks,
  queueMidTurnInbound,
  resolveChannel,
  updateQueuedInbound,
} from "./queue";
import {
  consumeOpMarker,
  handoffRestartForSize,
  safeSessionFile,
} from "./restart-ops";
import {
  loadRewakeQueue,
  rewakeAddPending,
  rewakeClearPending,
  rewakeCommitDelivered,
  rewakeRemovePending,
  rewakeSetPendingAck,
  scanUndeliveredBgInbounds,
} from "./restart-queue";
import { runRestartWake, writeCleanStop } from "./restart-wake";
import { sanitizeSensitiveText, sanitizeUnknownValue } from "./sanitize";
import {
  cancelPendingWakes,
  collectOrphanTmpFiles,
  completeWake,
  dueWakes,
  formatWakePrompt,
  markClaimed,
} from "./sleep";
import {
  collectOrphanTaskTmpFiles,
  completeTask,
  dueTasks,
  formatTaskPrompt,
  markTaskClaimed,
} from "./tasks";
import {
  extractTodoLines,
  fit,
  isBgCallbackBody,
  loadBoard,
  mergeTodoLines,
  saveBoard,
  todoBoardContextBlock,
} from "./todos";
import {
  registerSendFileTool,
  registerSleepTool,
  registerTaskTool,
  registerTodoTool,
  syncTodoBoard,
} from "./tools";
import { isVoiceAudio, transcribeVoice } from "./transcribe";
import {
  type AttachmentRef,
  type ChannelConfig,
  type ChannelMessage,
  getChannel,
  getDefaultChannel,
  loadChannelConfig,
} from "./types";
import {
  consumeRerun,
  findSessionFile,
  finishRun,
  stageFileTouch,
  startRun,
  type UndoRun,
} from "./undo";
import { estimateCost, hasUsage, sumRunUsage, type UsageStats } from "./usage";
import { isVoiceAttachment, voiceNoteText } from "./voice";

export let lastActiveChannel: ChannelConfig | null = null;
export let sessionStartTs = 0;
export let agentBusy = false;
// /undo run store: the in-flight run's snapshot handle (pre-state captured
// at run start, file touches staged during the run, finalized at agent_end).
let undoRun: UndoRun | null = null;

// 30s poller for due wakes + scheduled tasks (session_start /
// session_shutdown owned).
let schedPoller: ReturnType<typeof setInterval> | null = null;
// 60s ticker that auto-flushes buffered file-only batches at 10 minutes
// (session_start / session_shutdown owned). (#24)
let bufferFlushTicker: ReturnType<typeof setInterval> | null = null;
// /compact queued while the session is busy (run in progress, or a
// compaction already in flight). pi's compact() starts with await
// abort(), so a mid-run compact would silently kill the in-flight
// reply; we defer to agent_end instead. One slot: a later /compact
// replaces the earlier. Flushed at agent_end, or when the blocking
// compaction settles (session_compact / session_compact_failed — an
// in-flight compaction never triggers agent_end on its own).
export let pendingCompact: {
  ch: ChannelConfig;
  instructions?: string;
} | null = null;
export function getPendingCompact(): {
  ch: ChannelConfig;
  instructions?: string;
} | null {
  return pendingCompact;
}
export function setPendingCompact(
  v: { ch: ChannelConfig; instructions?: string } | null,
): void {
  pendingCompact = v;
}
// /verbose per-channel override (until restart). Exported for tests and
// for #10 (3-level display + persistence builds on this).
// /verbose per-channel override (#10): 3-level tool-call display,
// persisted in channel-state.json (survives restarts).
//   0 = text only (no tool calls)
//   1 = text + essential tools (edits, side-effect bash, MCP/custom)
//   2 = all tool calls
export type VerboseLevel = 0 | 1 | 2;
export const VERBOSE_LEVEL_NAMES: Record<VerboseLevel, string> = {
  0: "text",
  1: "essential",
  2: "all",
};
export const verboseOverride = new Map<string, VerboseLevel>();

// #40: the last completed run's usage (tokens + est. cost), for
// `/usage last`. Set at agent_end; null until the first run completes.
export const lastRunUsage: {
  value: { stats: UsageStats; at: Date } | null;
} = { value: null };

/** #10: parse a /verbose arg into a level. on/2 = all, off/0 = text,
 *  kimaki names (text/essential/all) accepted; null = not a level. */
export function parseVerboseLevel(a: string): VerboseLevel | null {
  switch (a.toLowerCase()) {
    case "0":
    case "off":
    case "text":
    case "text-only":
      return 0;
    case "1":
    case "essential":
    case "text-and-essential-tools":
      return 1;
    case "2":
    case "on":
    case "all":
    case "tools":
    case "tools-and-text":
      return 2;
    default:
      return null;
  }
}
// /hold per-channel flag (#39): while held, plain messages buffer in the
// re-wake queue without starting a run; /hold off drains them in order.
// Survives restarts via channel-state.json (persistChannelRuntimeState).
export const heldChannels = new Set<string>();
// Per-channel runtime state (hold flags, later #10 verbosity) lives in
// <cwd>/.tmp/channel-state.json — the same store the Discord cursor uses
// (discord.ts loadChannelStateFile / patchChannelState). runtimeStateDir
// is set at session_start; ensureRuntimeStateLoaded re-reads the file at
// most once per dir (a fresh process starts with a null guard, so boot
// always loads; in-process re-starts reload via setRuntimeStateDir).
export let runtimeStateDir: string | null = null;
let runtimeStateLoadedFor: string | null = null;
/** Set the runtime-state dir + reset the load guard. Exported for tests. */
export function setRuntimeStateDir(dir: string | null): void {
  runtimeStateDir = dir;
  runtimeStateLoadedFor = null;
}
/** Wipe in-memory runtime state (hold flags, verbose overrides, guard) —
 *  a process-restart simulation. Exported for tests. */
export function resetRuntimeStateForTest(): void {
  runtimeStateLoadedFor = null;
  heldChannels.clear();
  verboseOverride.clear();
  handoffInFlight = false;
  sessionStartTs = 0; // /status "up" baseline: no session_start in this test
  interruptEntryInFlight.clear();
  compactPlaceholders.clear();
  setLivePlaceholderSnapshot(null);
}
export function ensureRuntimeStateLoaded(): void {
  const dir = runtimeStateDir ?? "";
  if (runtimeStateLoadedFor === dir) return;
  runtimeStateLoadedFor = dir;
  if (!dir) return;
  try {
    const { channels } = loadChannelStateFile(dir);
    for (const [id, s] of Object.entries(channels)) {
      if (s.hold === true) heldChannels.add(id);
      // #10: persisted verbosity (valid levels only; garbage is dropped)
      if (
        typeof s.verbose === "number" &&
        (s.verbose === 0 || s.verbose === 1 || s.verbose === 2)
      )
        verboseOverride.set(id, s.verbose as VerboseLevel);
    }
  } catch (e) {
    console.error(
      "[channel] runtime state load failed:",
      sanitizeUnknownValue(e),
    );
  }
}
/** Persist per-channel runtime flags to channel-state.json. Never throws. */
export function persistChannelRuntimeState(
  chId: string,
  patch: { hold?: boolean; verbose?: number },
): void {
  try {
    patchChannelState(runtimeStateDir, chId, patch);
  } catch (e) {
    console.error(
      "[channel] runtime state persist failed:",
      sanitizeUnknownValue(e),
    );
  }
}
// Display gate (#38): the extension closure owns the live status-block
// state; the module-level command paths reach it through this hook (one
// extension instance per process, registered in the extension body).
export let onDeleteStatusBlock: ((ch: ChannelConfig) => Promise<void>) | null =
  null;
// Workspace root captured at session_start — lets module-level queue
// helpers resolve ChannelConfig without a ctx.
export let configRoot: string | null = null;

// ─── Mid-run interrupt ─────────────────────────────────────────────────
// A PLAIN message that arrives while a run is active is queued for a
// re-wake (above) AND armed with an interrupt timer. If the current step
// is still in flight when the timer fires (default 3000 ms, env
// PISCORD_INTERRUPT_STEP_TIMEOUT_MS), the message is force-delivered: the
// in-flight step (LLM stream or tool call) is aborted and the message
// starts a fresh run, so the agent continues with it — a redirect, not a
// full stop.
//
// Abort semantics (verified in a live pi session, 2026-09-10):
// ctx.abort() kills ONLY the active run — not the session. It does not
// clear the steering queue, but a steer enqueued while the run is active
// gets drained into the dying loop's transcript and its LLM call fails on
// the already-aborted signal (message in history, never processed). So the
// interrupt aborts FIRST, waits for isIdle, then sends the message as a
// fresh prompt (see runMidRunInterrupt for the full sequence).
//
// Commands (/stop, /reset, ...) never reach this path — they are consumed
// before the mid-turn gate. /stop clears the timers so a stopped run is
// not interrupted by a stale message.
// #84 L3: max lifetime for a run's live working frame. A run that never
// ends (hung tool or stream) would otherwise count up forever — nothing
// closes the frame without agent_end. On expiry the tick settles the frame
// to its true state (stalled) and stops. 30 min default (env-overridable).
export function workingMaxMs(): number {
  const raw = process.env.PISCORD_WORKING_MAX_MS;
  if (!raw) return 30 * 60 * 1000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
}
const DEFAULT_INTERRUPT_STEP_TIMEOUT_MS = 3000;

/** Interrupt step timeout in ms (env PISCORD_INTERRUPT_STEP_TIMEOUT_MS, default 3000). */
export function interruptStepTimeoutMs(): number {
  const raw = process.env.PISCORD_INTERRUPT_STEP_TIMEOUT_MS;
  if (!raw) return DEFAULT_INTERRUPT_STEP_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERRUPT_STEP_TIMEOUT_MS;
}

interface PendingInterrupt {
  messageId: string;
  at: number;
  timer: ReturnType<typeof setTimeout>;
}
export const pendingInterrupts = new Map<string, PendingInterrupt[]>();
export const interruptingChannels = new Set<string>();
// Channels whose in-flight interrupt was cancelled by /stop, /reset or
// /restart while the settle wait was running — the pending send is dropped
// (consistent with those commands dropping queued mid-turn inbounds).
export const interruptCancelled = new Set<string>();
// #84: the in-flight interrupt's entry is spliced OUT of midTurnQueues,
// so this registry (channelId -> queued messageId) is the only way
// session_shutdown can find its "[..] interrupting… Ns" ack line to
// clear. Cleared in the same finally as interruptingChannels.
export const interruptInFlight = new Map<string, string>();
let interruptHandler: ((channelId: string, messageId: string) => void) | null =
  null;
let interruptCtx: ExtensionContext | null = null;

/** Set by the extension factory: fires when an armed interrupt timer elapses. May be async (fire-and-forget). */
export function setInterruptHandler(
  fn: ((channelId: string, messageId: string) => void) | null,
): void {
  interruptHandler = fn;
}

/** The pi context for out-of-event aborts (session_start / shutdown). Exported for tests. */
export function setInterruptCtx(ctx: ExtensionContext | null): void {
  interruptCtx = ctx;
}

/** Arm (or re-arm) an interrupt timer for a queued mid-turn message.
 * Re-arming the same messageId replaces the earlier timer. `quiet` suppresses
 * the log for the short re-arm used while another interrupt is in flight. */
export function armInterruptTimer(
  channelId: string,
  messageId: string,
  delayMs?: number,
  quiet = false,
): void {
  if (!messageId) return;
  const delay = delayMs ?? interruptStepTimeoutMs();
  const list = pendingInterrupts.get(channelId) ?? [];
  const existing = list.find((p) => p.messageId === messageId);
  if (existing) clearTimeout(existing.timer);
  const at = Date.now() + delay;
  const timer = setTimeout(() => {
    const l = pendingInterrupts.get(channelId);
    if (l) {
      const i = l.findIndex((p) => p.messageId === messageId);
      if (i !== -1) l.splice(i, 1);
      if (l.length === 0) pendingInterrupts.delete(channelId);
    }
    if (!interruptHandler) return;
    try {
      interruptHandler(channelId, messageId);
    } catch (e) {
      console.error(
        "[channel] mid-run interrupt failed:",
        sanitizeUnknownValue(e),
      );
    }
  }, delay);
  list.push({ messageId, at, timer });
  pendingInterrupts.set(channelId, list);
  if (!quiet)
    console.log(
      `[channel] armed mid-run interrupt for ${messageId} (in ${delay}ms)`,
    );
}

/** Cancel pending interrupt timers for a channel (/stop, /reset). */
export function clearInterrupts(channelId: string): void {
  const list = pendingInterrupts.get(channelId);
  if (!list) return;
  for (const p of list) clearTimeout(p.timer);
  pendingInterrupts.delete(channelId);
}

/** Cancel every interrupt timer (session_shutdown). */
export function clearAllInterrupts(): void {
  for (const list of pendingInterrupts.values())
    for (const p of list) clearTimeout(p.timer);
  pendingInterrupts.clear();
  interruptingChannels.clear();
  interruptCancelled.clear();
  interruptInFlight.clear();
  interruptEntryInFlight.clear();
  persistLivePlaceholders();
}

// ─── Compaction window (per channel) ─────────────────────────────────────
// Set when /compact is dispatched for a channel (startCompact), cleared
// when pi settles the compaction (session_compact / session_compact_failed
// extension events), by /stop, on session_shutdown, or by the 10-min
// fallback timer. While set, inbounds for that channel are QUEUED WITHOUT
// arming the mid-run interrupt: an interrupt calls ctx.abort(), which kills
// the in-flight compaction (live incident on the frank agent, 2026-09-10).
const COMPACT_FALLBACK_MS = 10 * 60 * 1000;
/** Op window labels: compaction + the restart-class ops. */
export type OpLabel =
  | "compacting"
  | "resetting"
  | "restarting"
  | "undoing"
  | "redoing"
  | "handing-off";

export interface CompactingEntry {
  since: number;
  timer: ReturnType<typeof setTimeout>;
  /** Which op owns the window (status display + tick text). */
  label: OpLabel;
  /** Discord cursor captured at window open; restart-class ops rewind to
   *  it before shutdown so inbounds delivered during the op replay after
   *  the respawn instead of dying with the process. Null for compaction
   *  (no process restart, no replay needed). */
  rewindTo: string | null;
}
export const compactingChannels = new Map<string, CompactingEntry>();
/** Pending op-shutdown timers by channel (F1). The window is cleared on
 *  /stop, which clears this timer, so the shutdown chain never runs. */
export const opShutdownTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

// ─── Handover compaction state (mechanism A, design v2) ────────────────────
// F10: set SYNCHRONOUSLY at session_before_compact handler entry, before
// any await — the gate reads it, so a second compaction in the same tick
// never starts a second handover generation. Cleared in the handler's
// finally (success AND failure paths).
let handoffInFlight = false;
export function isHandoffInFlight(): boolean {
  return handoffInFlight;
}
export function setHandoffInFlight(v: boolean): void {
  handoffInFlight = v;
}
/** True when buildHandover just wrote a doc in THIS process's current
 *  compact. Set in session_before_compact (doc written), consumed by
 *  maybeHandoffRestart on the resulting session_compact. The compact that
 *  WROTE the doc must restart into a fresh session — its own write sets the
 *  latest.md stamp, so without this arm the isHandoffFreshWindow loop-guard
 *  would block the very restart that doc triggers (issue #85: compact -> NEW
 *  session, /usage turns reset to 0). A restart is a new process, so the arm
 *  is naturally absent in the seeded session; its first settle IS loop-gated
 *  by the fresh window. */
export let handoffRestartArmed = false;
export function isHandoffRestartArmed(): boolean {
  return handoffRestartArmed;
}
export function setHandoffRestartArmed(v: boolean): void {
  handoffRestartArmed = v;
}
/** Test seam: stub the handover LLM call in the session_before_compact
 *  wiring (null → default completeSimple path). */
let handoverCompleteForTest: HandoverComplete | null = null;
export function setHandoverCompleteForTest(fn: HandoverComplete | null): void {
  handoverCompleteForTest = fn;
}

/**
 * True while an op window is open: compaction OR a restart-class op
 * (/reset /restart /undo /redo). The name is historical — everything
 * that checks "is the channel busy with a long op" uses this.
 */
export function isCompacting(channelId: string): boolean {
  return compactingChannels.has(channelId);
}

/** Label of the open op window for a channel, or null. */
export function opWindowLabel(channelId: string): OpLabel | null {
  return compactingChannels.get(channelId)?.label ?? null;
}

/** Double-op refusal text (F5, owner 2026-09-11): name the ACTIVE op —
 *  a compaction window says "already compacting", a restart-class op
 *  window says "already restarting". One-line op status = prose, ships
 *  unfenced (STYLE.md v4 §2.3). */
export function opBusyRefusal(channelId: string): string {
  // Bare chat one-liner - plain words, no tag (machine output only, Andryo
  // 2026-10-20).
  return opWindowLabel(channelId) === "compacting"
    ? "already compacting"
    : "already restarting";
}

/** Clear the flag (no-op when not set). `warn` = the 10-min fallback timer
 *  fired without a completion event. */
export function clearCompacting(channelId: string, warn = false): void {
  // #84: the placeholder-line record follows the window's life
  compactPlaceholders.delete(channelId);
  const e = compactingChannels.get(channelId);
  if (!e) {
    persistLivePlaceholders();
    return;
  }
  clearTimeout(e.timer);
  compactingChannels.delete(channelId);
  persistLivePlaceholders();
  // F1: window closed = restart-class op cancelled — drop the pending
  // op-shutdown timer so its chain never runs.
  const opTimer = opShutdownTimers.get(channelId);
  if (opTimer) clearTimeout(opTimer);
  opShutdownTimers.delete(channelId);
  if (warn)
    console.warn(
      `[channel] ${channelId} still compacting after ${COMPACT_FALLBACK_MS / 60000} min; clearing flag (no completion event)`,
    );
}

/** Clear every flag + timer (session_shutdown). */
export function clearAllCompacting(): void {
  for (const id of [...compactingChannels.keys()]) clearCompacting(id);
}

/** Open the window: set the flag + arm the 10-min fallback. The fallback
 *  clears with a console.warn and drains whatever was queued behind the
 *  op, in case the completion event never arrives. */
export function beginCompacting(
  pi: ExtensionAPI,
  ch: ChannelConfig,
  ctx: ExtensionContext,
  opts: { label?: OpLabel; rewindTo?: string | null } = {},
): void {
  clearCompacting(ch.id);
  const label = opts.label ?? "compacting";
  const rewindTo = opts.rewindTo ?? null;
  const timer = setTimeout(() => {
    // #84: the completion event never arrived — settle the placeholder to a
    // terminal line (a frozen counting tick is the stale placeholder this
    // fix kills), then clear + drain as before. No-op for restart-class ops
    // (their tick is not armed; the op marker covers them).
    settleCompactTick(ch.id, "compact stalled");
    clearCompacting(ch.id, true);
    drainQueuedAfterCompact(pi, ctx);
  }, COMPACT_FALLBACK_MS);
  (timer as any).unref?.();
  compactingChannels.set(ch.id, {
    since: Date.now(),
    timer,
    label,
    rewindTo,
  });
  console.log(`[op:${label}] window open for ${ch.id}`);
}

/** Deliver ONE queued inbound that was waiting out a compaction (same
 *  re-wake as the agent_end path). No-op when a run is already active:
 *  that run's agent_end drains the rest. */
export function drainQueuedAfterCompact(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  if (!ctx.isIdle()) return;
  const queued = popOldestQueuedInbound();
  if (!queued) return;
  console.log(
    `[channel] compaction settled: re-waking queued inbound (${queued.channelId})`,
  );
  handleInbound(pi, queued.msg, ctx, true).catch((e) => {
    console.error(
      "[channel] post-compact re-wake failed:",
      sanitizeUnknownValue(e),
    );
  });
}

/**
 * Force-deliver one queued message and abort the in-flight step.
 * Called by the interrupt timer. Sequence (verified against a live pi
 * session, 2026-09-10):
 *   1. ctx.abort() — kills the current run (the in-flight LLM stream or
 *      tool call). The tool gets a "Command aborted" result; the run
 *      settles with an empty assistant message (stopReason "error",
 *      errorMessage "This operation was aborted" — the pi stream layer
 *      maps the abort there, NOT to stopReason "aborted").
 *   2. wait for isIdle — the post-run loop may retry/compact/continue;
 *      isIdle() covers run + compaction. Common case settles in tens of
 *      ms (the aborted LLM call fails immediately).
 *   3. sendToPi — now idle, the message starts a FRESH run. The agent
 *      continues with it: a clean redirect in the transcript.
 * The message is spliced out of the re-wake queue BEFORE the abort, so it
 * is owned by exactly one path (never re-woken at the aborted run's
 * agent_end). Do NOT steer before aborting: a steer enqueued while the
 * run is still active gets drained into the dying loop's transcript and
 * its LLM call fails on the already-aborted signal — the message lands
 * in history but the agent never replies to it.
 */
export async function runMidRunInterrupt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  channelId: string,
  messageId: string,
): Promise<void> {
  if (interruptingChannels.has(channelId)) {
    // Another interrupt is in flight for this channel; re-arm shortly —
    // the message is still in the re-wake queue as the fallback owner.
    armInterruptTimer(channelId, messageId, 200, true);
    return;
  }
  if (ctx.isIdle()) return; // run settled; the re-wake queue owns delivery
  const q = midTurnQueues.get(channelId);
  const idx = q ? q.findIndex((e) => e.msg.messageId === messageId) : -1;
  if (!q || idx === -1) return; // already re-woken or cleared by /stop
  const [entry] = q.splice(idx, 1);
  if (q.length === 0) midTurnQueues.delete(channelId);
  if (!entry.text) {
    // No pre-rendered text: put the entry back, the re-wake path owns it.
    const qq = midTurnQueues.get(channelId) ?? [];
    qq.splice(Math.min(idx, qq.length), 0, entry);
    midTurnQueues.set(channelId, qq);
    return;
  }
  interruptingChannels.add(channelId);
  interruptInFlight.set(channelId, messageId);
  // #84: record the spliced entry so a crash before sendToPi can redeliver
  // it — the queue no longer holds it, so nobody else would.
  interruptEntryInFlight.set(channelId, {
    text: entry.text,
    title: entry.title ?? "",
    display: entry.display ?? entry.msg.body,
  });
  persistLivePlaceholders();
  console.log(
    `[channel] mid-run interrupt: aborting current step, then sending ${messageId}`,
  );
  // Live tick on the [queued] ack: the interrupt can wait up to the settle
  // cap (120s) — show it moving instead of a frozen "[queued] N in line".
  // The ack post must have landed first (it is queued ahead of the timer).
  const interruptAck = queuedAcks.get(messageId);
  const interruptCh = resolveChannel(channelId);
  if (interruptAck && interruptCh)
    armOpTick(
      `interrupt:${channelId}`,
      interruptCh,
      interruptAck.ackId,
      (secs) =>
        interruptingChannels.has(channelId)
          ? opTickLine("interrupting", secs)
          : null,
    );
  try {
    userStoppedRun = true; // silence the aborted run's failure post
    try {
      ctx.abort();
    } catch {
      /* best-effort abort */
    }
    // Wait for the session to fully settle (see function doc). The
    // agent_end re-wake yields to this in-flight interrupt (it does not
    // start a re-wake run while we wait), so the window covers only
    // post-run compaction/retries — NOT another queued message's full run.
    // Cap: 120 s (compaction/retry are LLM calls and can be slow). If
    // /stop, /reset or /restart lands in this window the send is dropped
    // (interruptCancelled), consistent with those commands dropping queued
    // mid-turn inbounds.
    for (
      let i = 0;
      i < 4800 && !ctx.isIdle() && !interruptCancelled.has(channelId);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (interruptCancelled.has(channelId)) {
      // Consume the cancel so it cannot go stale and drop a LATER
      // legitimate interrupt (F7): the flag is only ever set while an
      // interrupt is in flight for this channel, and is cleared the moment
      // it is acted on.
      interruptCancelled.delete(channelId);
      console.log(
        `[channel] mid-run interrupt cancelled: ${messageId} dropped`,
      );
      // Settle the tick before the delete: the final edit must land while
      // the ack message still exists (same race as the success path).
      settleOpTick(`interrupt:${channelId}`, `interrupted`);
      consumeQueuedAck(channelId, messageId);
      // #180: the entry is dropped (never sent to pi) — prune the
      // survived copy so a restart does not re-deliver the cancel.
      rewakeRemovePending(runtimeStateDir, channelId, messageId);
      // Re-wake vehicle: this run's agent_end deferred to us, so if we are
      // dropped, no run exists to re-wake the deferred entries. Kick the
      // oldest one when idle (no-op while a run is active — its
      // agent_end owns delivery; the compaction-drain path covers
      // compaction-abort, drainQueuedAfterCompact).
      // #124: the one-shot isIdle() check raced the agent_end handler
      // window — pi clears the run flag only AFTER the awaited agent_end
      // handler resolves (_emitAgentSettled), and /stop can land inside
      // that window after the handler already deferred its re-wake to us.
      // A check at the cancel instant then sees false, skips the kick, and
      // the deferred entry orphans (the deferral is one-shot). Poll for
      // settle (same cadence and cap as the settle loop above) so the
      // kick lands on the first idle tick instead of at the cancel
      // instant. The pop is atomic: if a run starts meanwhile, its
      // agent_end owns the queue and the kick finds nothing — no
      // double-wake.
      if (!ctx.isIdle()) {
        for (let i = 0; i < 4800 && !ctx.isIdle(); i++) {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      if (ctx.isIdle()) {
        const queued = popOldestQueuedInbound();
        if (queued)
          handleInbound(pi, queued.msg, ctx, true).catch((e) => {
            console.error(
              "[channel] cancel re-wake failed:",
              sanitizeUnknownValue(e),
            );
          });
      }
      return;
    }
    if (!ctx.isIdle()) {
      // Settle exceeded the cap: restore the entry (FIFO position kept) so
      // the re-wake path owns delivery from here on — never steer into a
      // still-active run (that is the lossy path this feature avoids).
      // #84 L1: settle the tick back to the queued line (its TRUE state)
      // instead of stopping it frozen mid-interrupt. The ack stays with the
      // queued entry and is deleted when the re-wake consumes it.
      const qq = midTurnQueues.get(channelId) ?? [];
      const at = Math.min(idx, qq.length);
      qq.splice(at, 0, entry);
      midTurnQueues.set(channelId, qq);
      const pos = at + 1;
      const ack = queuedAcks.get(messageId);
      if (ack) ack.pos = pos;
      settleOpTick(`interrupt:${channelId}`, `[queued] ${pos} in line`);
      console.log(
        `[channel] mid-run interrupt: settle exceeded cap, ${messageId} left to re-wake`,
      );
      return;
    }
    // Settle the interrupt tick BEFORE consuming the ack: the tick edits
    // the ack message in place, so the final edit must land while the
    // message still exists. consumeQueuedAck then deletes it.
    const tickKey = `interrupt:${channelId}`;
    settleOpTick(tickKey, `interrupted`);
    consumeQueuedAck(channelId, messageId); // entry is owned by the fresh run
    sendToPi(
      pi,
      channelId,
      entry.text,
      entry.title ?? "",
      entry.display ?? entry.msg.body,
      entry.msg.messageId,
    );
  } finally {
    interruptingChannels.delete(channelId);
    interruptInFlight.delete(channelId);
    // #167 LOW-2: /stop, /reset or /restart landing while the cancel branch
    // polls for settle re-sets the flag AFTER the cancel branch consumed it.
    // That re-set has no consumer left: the NEXT same-channel interrupt's
    // settle loop exits immediately on it and drops that interrupt (message
    // + ack) before the flag is finally consumed. Sweep it when the
    // interrupt releases the channel: at this point every set is either
    // already consumed (cancel branch) or stale (re-set during the poll).
    // The success and cap paths run synchronously from the settle-loop
    // exit, so they cannot leave a live flag behind.
    interruptCancelled.delete(channelId);
    interruptEntryInFlight.delete(channelId); // #84: redelivery record is over
    persistLivePlaceholders(); // #84: entry consumed (or restored to queue)
    // Fallback: if the tick was never armed (no ack) or settle raced, drop it.
    stopOpTick(`interrupt:${channelId}`);
  }
}
// Last inbound Discord message id per channel — the 👀 ack target. The
// message_end early-send path unreacts it (A1: step-finals carry no
// replyTo, so the agent_end unreact branch never sees them).
const lastInboundIds = new Map<string, string>();
// Inbound message ids that triggered the current run, per channel — the
// validation set for <reply-to:MSGID> on the message_end early-send path
// (event.messages is not available there). Updated on every sendToPi.
const runInboundIds = new Map<string, string[]>();
// Set when /stop or a mid-run interrupt aborts a run, so agent_end does not
// post the abort's errorMessage as if it were a model/API failure (A2).
export let userStoppedRun = false;
export function setUserStoppedRun(v: boolean): void {
  userStoppedRun = v;
}

// ─── Repetition guard ────────────────────────────────────────────────────
// 3 consecutive byte-identical finals (after trim) in one channel = a
// stuck loop. The third one is dropped, the run is aborted, and one
// warning line is posted instead. The counter resets on any different
// final or on a new inbound user message.
const finalReps = new Map<string, string[]>();
export const REPEAT_WARNING =
  "repetition loop detected - run stopped. Say /reset if it persists.";

/** Record a posted final; true on the third consecutive identical one. */
export function recordFinalRepeat(channelId: string, text: string): boolean {
  const t = text.trim();
  const arr = finalReps.get(channelId) ?? [];
  if (arr.length > 0 && arr[arr.length - 1] === t) arr.push(t);
  else {
    arr.length = 0;
    arr.push(t);
  }
  if (arr.length >= 3) {
    finalReps.set(channelId, []);
    return true;
  }
  finalReps.set(channelId, arr);
  return false;
}

/** Reset the repetition counter for a channel. */
export function resetFinalRepeats(channelId: string): void {
  finalReps.delete(channelId);
}

/** #10: the channel's effective verbosity level — the /verbose override,
 *  else the settings default (forwardToolCalls true = 2, unset = 0). */
export function verboseLevel(ch: ChannelConfig): VerboseLevel {
  ensureRuntimeStateLoaded();
  const o = verboseOverride.get(ch.id);
  if (o !== undefined) return o;
  return ch.forwardToolCalls ? 2 : 0;
}

export function isVerbose(ch: ChannelConfig): boolean {
  return verboseLevel(ch) > 0;
}

/** #39: is this channel held (plain messages buffer until /hold off)? */
export function isHeld(ch: ChannelConfig): boolean {
  ensureRuntimeStateLoaded();
  return heldChannels.has(ch.id);
}

/** #39: set + persist the hold flag for a channel. */
export function setHeld(chId: string, on: boolean): void {
  if (on) heldChannels.add(chId);
  else heldChannels.delete(chId);
  persistChannelRuntimeState(chId, { hold: on });
}

/**
 * v3 message style (mockup3, 2026-09-13): state glyphs ┘ ┣ ├ ┤, `·`
 * separators, ASCII words, no emoji/arrows/em-dashes/dingbats, and every
 * rendered line fits the 40-col mobile budget (FRAME_COL_MAX).
 */

/** Hard mobile budget for rendered frame lines (mockup3). */
export const TOOL_LINE_MAX = FRAME_COL_MAX;

/** Max action text on a sub-step line: `│ ├ <text>` fits FRAME_COL_MAX. */
export const TOOL_TEXT_MAX = FRAME_COL_MAX - "│ ├ ".length; // 28

/** Clip to max code points, leading ellipsis (keep the tail). */
function clipStart(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  return `…${s.slice(s.length - (max - 1))}`;
}

/**
 * Bare action text for a tool call (no glyph, no counters). Capped at
 * TOOL_TEXT_MAX (28) code points so a done-frame sub-step
 * (`│ ├ <action>`) fits FRAME_COL_MAX (32).
 * Paths clip the head (the filename is the useful tail); commands and arg
 * dumps clip the tail (the verb is the useful head).
 * Censor runs BEFORE the clip: [REDACTED:...] must respect the frame
 * budget, not expand a 28-col line to 52 after the fact (audit 2026-09-15,
 * aesthetics #2).
 */
export function toolActionText(toolName: string, input: any): string {
  const esc = (s: string) => s.replace(/([\\*_`])/g, "\\$1");
  const one = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
  const censored = (s: string) => esc(censor(s));
  const p = one(String(input?.path ?? ""));
  switch (toolName) {
    case "bash": {
      // first segment only: "bun run build 2>&1 | tail -4" -> "bun run build"
      const seg = one(
        String(input?.command ?? "")
          .split(/\s*(?:\||&&|;|>)\s*/)[0]
          .replace(/\s*2>&1\s*$/, ""),
      );
      return `bash ${fit(censored(seg), TOOL_TEXT_MAX - 5)}`;
    }
    case "read":
      return `read ${clipStart(censored(p), TOOL_TEXT_MAX - 5)}`;
    case "edit":
      return `edit ${clipStart(censored(p), TOOL_TEXT_MAX - 5)}`;
    case "write":
      return `write ${clipStart(censored(p), TOOL_TEXT_MAX - 6)}`;
    default: {
      let args: string;
      try {
        args = JSON.stringify(input);
      } catch {
        args = String(input);
      }
      return fit(censored(`${toolName} ${one(args)}`), TOOL_TEXT_MAX);
    }
  }
}

// #10 level 1: essential-tool filter. Spec (mockup3 section 6): edits +
// MCP/custom shown, reads/searches hidden. pi core tool names, verified
// against pi dist core/tools (review M1: the first port used kimaki/
// OpenCode names - list/glob/todoread/skill/question/webfetch are dead
// in pi; its navigation tools are ls and find).
const NON_ESSENTIAL_TOOLS = new Set(["read", "grep", "ls", "find"]);

// L1 (review): recognized bash heads with write flags escape the head
// check (find . -delete, sort -o out) - rare, accepted.
const READONLY_BASH_HEADS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "find",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "pwd",
  "which",
  "type",
  "printenv",
  "env",
  "date",
  "whoami",
  "hostname",
  "uname",
  "realpath",
  "basename",
  "dirname",
  "sort",
  "uniq",
  "diff",
  "comm",
  "tree",
  "true",
  "echo",
  "ps",
  "uptime",
]);

/** #10 level 1: read-only `git` subcommands (write commands are essential). */
const GIT_READONLY_SUBS = new Set([
  "log",
  "status",
  "diff",
  "show",
  "ls-files",
  "describe",
  "rev-parse",
  "shortlog",
]);

function gitReadonly(sub: string, third: string | undefined): boolean {
  if (GIT_READONLY_SUBS.has(sub)) return true;
  if (sub === "branch") return !third; // bare list; `branch -d` etc. write
  if (sub === "tag") return !third || third === "-l" || third === "--list";
  if (sub === "stash") return third === "list" || third === "show";
  return false;
}

/** #10: would a `bash` command only read? Redirects and unknown heads
 *  count as side effects (shown). Segments are split on pipes, &&, ||, ;. */
export function bashToolEssential(input: any): boolean {
  const cmd = String(input?.command ?? "").trim();
  if (!cmd) return false;
  if (cmd.includes(">")) return true; // a redirect writes something
  for (const seg of cmd.split(/\s*(?:\|\||&&|;|\|)\s*/)) {
    const parts = seg.trim().split(/\s+/).filter(Boolean);
    // skip env VAR=x prefixes on the first token(s)
    while (parts.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0]!))
      parts.shift();
    const head = parts[0] ?? "";
    if (head === "git") {
      const sub = parts[1] ?? "";
      if (gitReadonly(sub, parts[2])) continue;
      return true;
    }
    if (READONLY_BASH_HEADS.has(head)) continue;
    return true;
  }
  return false;
}

/** #10: would this tool call render at verbosity level 1? */
export function isEssentialToolCall(toolName: string, input: any): boolean {
  if (NON_ESSENTIAL_TOOLS.has(toolName)) return false;
  if (toolName === "bash") return bashToolEssential(input);
  return true; // edits, writes, tasks, MCP/custom: all essential
}

/** Run-frame header state (live-frame unification, operator 2026-09-13):
 *  the in-run "working" message and the end-of-run message are the SAME
 *  frame; only the header flips working -> done/failed in place. */
export type RunFrameState = "working" | "done" | "failed" | "stopped";

/** Max sub-step lines in the run frame (older calls overflow to the +N line). */
export const RUN_FRAME_MAX_STEPS = 8;

/**
 * Unified run frame (v3, mockup3 + live-frame unification): ONE builder
 * for the live "working" status and the end-of-run done/failed summary —
 * same shape, same fence, same Discord message; only the header changes
 * state:
 *
 *   ┌ working · 12 calls · 96s
 *   ├ … +9 earlier calls
 *   │ ├ read /home/monky/…/index.ts
 *   │ ├ edit /home/monky/…/index.ts
 *   │ └ bash cargo test
 *   └
 *
 * Sub-steps are the last RUN_FRAME_MAX_STEPS shown calls; earlier overflow
 * lands right under the header as `├ … +N earlier calls`. `calls` is the
 * shown list (level 1 pre-filters to essentials), `count` its length.
 * Every line fits TOOL_LINE_MAX. The header formats count/secs with the
 * k/m compact form (fmtTokensLC): raw `123456 calls · 999999s` is 34 cols;
 * the compact form bounds the header at 32 (PR #64 review P3).
 */
export function runFrame(
  state: RunFrameState,
  calls: string[],
  count: number,
  secs: number,
  trailing?: string,
): string {
  // k/m compact form: the raw `123456 calls · 999999s` shape breached 32
  // (PR #64 review P3); fmtTokensLC bounds count/secs at 5 cols for any
  // value under ~1e10 (1e10 secs = 317 years). The fit is the hard
  // guarantee: the header can never exceed TOOL_LINE_MAX, however big.
  const n = `${fmtTokensLC(count)} call${count === 1 ? "" : "s"} · ${fmtTokensLC(secs)}s`;
  const header = state === "failed" ? `┤ failed · ${n}` : `┌ ${state} · ${n}`;
  const lines: string[] = [fit(header, TOOL_LINE_MAX)];
  const shown = calls.slice(-RUN_FRAME_MAX_STEPS);
  const earlier = count - shown.length;
  if (earlier > 0)
    lines.push(`├ … +${earlier} earlier call${earlier === 1 ? "" : "s"}`);
  shown.forEach((a, i) => {
    const prefix = i === shown.length - 1 ? "│ └ " : "│ ├ ";
    lines.push(`${prefix}${fit(a, TOOL_LINE_MAX - prefix.length)}`);
  });
  // #40: run usage trailing line — append-only, right before the closing
  // bar, same budget as every other frame line.
  if (trailing) lines.push(fit(trailing, TOOL_LINE_MAX));
  lines.push("└");
  return lines.join("\n");
}

/** #40: the run-usage trailing line for the done/failed frame.
 *  `│ ~219.9k tok · ~$0.042` (lowercase k, 3-decimal est. cost, same
 *  pricing as ~/scripts/pi-token-cost.py). null when the run carried no
 *  billable usage. Already carries the `│ ` prefix; the frame clips it
 *  to the 40-col budget. */
export function runUsageLine(s: UsageStats): string | null {
  const total = s.input + s.output + s.cacheRead + s.cacheWrite;
  if (total <= 0) return null;
  const tok =
    total >= 1_000_000
      ? `${(total / 1_000_000).toFixed(1)}m`
      : `${(total / 1000).toFixed(1)}k`;
  return `│ ~${tok} tok · ~$${estimateCost(s).toFixed(3)}`;
}

/** Local files referenced in final text (images + common docs). */
const ATTACHABLE_RE =
  /(?:\/[\w.+-]+)+\.(?:png|jpe?g|gif|webp|bmp|mp4|mov|webm|pdf|md|txt|log|csv|json)(?=[\s)`"',.:;!?)\]]|$)/gi;

function detectAttachmentFiles(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.match(ATTACHABLE_RE) ?? []) {
    const p = m.replace(/[).,;:!?\]]+$/, "");
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > 25 * 1024 * 1024) continue;
      out.push(p);
    } catch {
      continue;
    }
    if (out.length >= 10) break;
  }
  return out;
}

/** No-reply token: a final that is exactly this (trim + case-insensitive)
 *  closes the turn WITHOUT posting anything. Lets the agent stay silent on
 *  system pings (watchdog events, heartbeats, duplicate deliveries). */
const NO_REPLY = "NO_REPLY";
export function isNoReply(text: string): boolean {
  return text.trim().toUpperCase() === NO_REPLY;
}

/** Send final text, auto-attaching any local files referenced in it. */
async function sendFinalWithFiles(
  ch: ChannelConfig,
  text: string,
  files: string[],
  replyTo?: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const md = mdToDiscord(text);
  if (files.length === 0)
    return sendDiscordMessage(
      ch,
      md,
      replyTo ? { replyToMessageId: replyTo } : undefined,
    );
  return sendDiscordMessageWithFiles(ch, md, files, replyTo);
}

/** Hard-split a single line into max-sized pieces without breaking surrogate pairs. */
function splitLongLine(line: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const cp of Array.from(line)) {
    if (cur.length + cp.length > max) {
      out.push(cur);
      cur = cp;
    } else cur += cp;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Split text into chunks that fit within max chars.
 * Line-aware, code-point safe (no split surrogate pairs), and fence-aware:
 * a ``` block is never split in the middle; if one fence alone exceeds max,
 * it is split and each piece re-wrapped in its own fence.
 */
export function chunkText(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) {
      out.push(cur);
      cur = "";
    }
  };
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const open = fenceMatch[1];
      const info = fenceMatch[2].trim();
      const closeRe = new RegExp(`^\\s{0,3}${open[0]}{${open.length},}\\s*$`);
      const block: string[] = [line];
      let closed = false;
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        block.push(lines[i]);
        i++;
        closed = true;
      } // closing fence
      const blockText = block.join("\n");
      if (blockText.length > max) {
        flush();
        const inner = block.slice(1, closed ? -1 : block.length);
        // Reserve the re-wrap cost (two fence lines + info string) so each
        // emitted piece fits in max, and split inner lines that exceed
        // the remaining budget.
        const fenceOverhead = open.length * 2 + (info ? info.length : 0) + 2;
        const budget = Math.max(1, max - fenceOverhead);
        const innerLines: string[] = [];
        for (const l of inner) {
          if (l.length > budget) innerLines.push(...splitLongLine(l, budget));
          else innerLines.push(l);
        }
        const rewrap = (body: string) => `${open}${info}\n${body}\n${open}`;
        let buf = "";
        for (const l of innerLines) {
          if (buf && buf.length + l.length + 1 > budget) {
            out.push(rewrap(buf));
            buf = "";
          }
          buf = buf ? `${buf}\n${l}` : l;
        }
        if (buf) out.push(rewrap(buf));
      } else if (cur && cur.length + blockText.length + 1 > max) {
        flush();
        cur = blockText;
      } else {
        cur = cur ? `${cur}\n${blockText}` : blockText;
      }
    } else {
      if (line.length > max) {
        flush();
        for (const p of splitLongLine(line, max)) out.push(p);
      } else if (cur && cur.length + line.length + 1 > max) {
        flush();
        cur = line;
      } else {
        cur = cur ? `${cur}\n${line}` : line;
      }
      i++;
    }
  }
  flush();
  return out;
}

/**
 * Parse `<reply-to:MSGID>` tags from assistant text. The tag lets the LLM
 * thread its reply to a specific person's message in a multi-person burst.
 * Tags inside code fences are content, not directives — untouched. All
 * occurrences are stripped; the FIRST tag (outside fences) is the target.
 * Returns the text with the tags stripped (and the leading blank line a
 * leading tag leaves behind) plus the parsed id. Exported for tests.
 */
const REPLY_TO_TAG = /<reply-to:\s*(\d+)\s*>/;
const REPLY_TO_TAG_ALL = /<reply-to:\s*(\d+)\s*>/g;
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
export function parseReplyTo(text: string): { text: string; replyTo?: string } {
  let replyTo: string | undefined;
  let openFence: string | null = null;
  const lines = text.split("\n").map((line) => {
    const f = line.match(FENCE_LINE);
    if (f) {
      if (!openFence) {
        openFence = f[1];
      } else if (
        f[1][0] === openFence[0] &&
        f[1].length >= openFence.length &&
        f[2].trim() === ""
      ) {
        openFence = null;
      }
      return line; // fence lines are never tag carriers
    }
    if (openFence) return line; // inside a code fence: untouched
    if (!replyTo) {
      const m = line.match(REPLY_TO_TAG);
      if (m) replyTo = m[1];
    }
    return line.replace(REPLY_TO_TAG_ALL, "");
  });
  if (!replyTo) return { text };
  return { text: lines.join("\n").replace(/^\s*\n/, ""), replyTo };
}

/**
 * Collect the final assistant texts of a run, each paired with the reply
 * target (message id) of the nearest inbound message that precedes it.
 * A final may carry `<reply-to:MSGID>`; if the id is one of the triggering
 * inbound message ids (details.messageIds), it wins over the default
 * last-message target. Exported for tests.
 */
export function collectFinals(
  messages: unknown[],
): { text: string; replyTo?: string }[] {
  const finals: { text: string; replyTo?: string }[] = [];
  let replyTo: string | undefined;
  const allowed = new Set<string>();
  for (const m of messages as any[]) {
    if (m?.customType === CHANNEL_MSG_TYPE) {
      replyTo = m.details?.messageId;
      const ids = Array.isArray(m.details?.messageIds)
        ? m.details.messageIds
        : replyTo
          ? [replyTo]
          : [];
      for (const id of ids) allowed.add(String(id));
      continue;
    }
    if (m?.role !== "assistant") continue;
    if (earlySent.has(m)) continue; // already forwarded at message_end
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (blocks.some((b: any) => b.type === "toolCall")) continue;
    const text = blocks
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    const clean = cleanThinking(text.trim());
    if (!clean) continue;
    const rt = parseReplyTo(clean);
    const chosen = rt.replyTo && allowed.has(rt.replyTo) ? rt.replyTo : replyTo;
    finals.push({ text: rt.text, replyTo: chosen });
  }
  return finals;
}

// ─── Inbound message custom type ─────────────────────────────────────────
// Sent via pi.sendMessage(); the LLM sees the full content (with <channel-ctx>),
// while the TUI renders only the type/name title + message body. Exported for tests.
export const CHANNEL_MSG_TYPE = "channel-inbound";

interface ChannelMessageDetails {
  title: string; // e.g. "discord/Discord Main"
  body: string; // user-visible message body (no channel-ctx)
  messageId?: string; // source message id, used for reply threading
  messageIds?: string[]; // all source message ids (burst merges carry >1)
}

// ─── Pending attachments buffer ──────────────────────────────────────────
// When user sends files without text, buffer them per-channel.
// Each entry: folder path for the batch + list of files. Batches expire
// after ATTACHMENT_BATCH_TTL_MS so a file-only message that never gets a
// follow-up does not accumulate forever.
interface AttachmentBatch {
  folder: string;
  files: AttachmentRef[];
  addedAt: number;
  /** att id → skip/failure note (eager download did not save the file). */
  notes?: Record<string, string>;
}
export const pendingAttachments = new Map<string, AttachmentBatch[]>();
const ATTACHMENT_BATCH_TTL_MS = 10 * 60 * 1000;

/** Synthesized prompt for file-only messages when bufferFileOnly is off. */
export function fileOnlyPrompt(files: AttachmentRef[]): string {
  const names = files.map((f) => f.filename).join(", ");
  return `[user sent ${files.length} ${files.length === 1 ? "file" : "files"} without text: ${names}]`;
}

/** Drop expired batches for a channel; return the ones still fresh. */
export function prunePendingBatches(
  channelId: string,
  now = Date.now(),
): AttachmentBatch[] {
  const all = pendingAttachments.get(channelId) || [];
  const fresh = all.filter((b) => now - b.addedAt < ATTACHMENT_BATCH_TTL_MS);
  if (fresh.length === all.length) return fresh;
  if (fresh.length === 0) pendingAttachments.delete(channelId);
  else pendingAttachments.set(channelId, fresh);
  return fresh;
}

/** Pull expired batches (older than ATTACHMENT_BATCH_TTL_MS) out of a
 *  channel's pending list; fresh ones stay. (#24) */
export function collectExpiredBatches(
  channelId: string,
  now = Date.now(),
): AttachmentBatch[] {
  const all = pendingAttachments.get(channelId) || [];
  const expired = all.filter((b) => now - b.addedAt >= ATTACHMENT_BATCH_TTL_MS);
  if (expired.length === 0) return [];
  const fresh = all.filter((b) => now - b.addedAt < ATTACHMENT_BATCH_TTL_MS);
  if (fresh.length === 0) pendingAttachments.delete(channelId);
  else pendingAttachments.set(channelId, fresh);
  return expired;
}

/** Auto-flush expired buffered batches as a file-only turn (#24): a
 *  buffered batch that never got follow-up text must not sit forever —
 *  at 10 minutes it fires the same fileOnlyPrompt turn as
 *  bufferFileOnly:false. Returns the number of turns fired. */
export async function flushExpiredPendingBatches(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  now = Date.now(),
): Promise<number> {
  let fired = 0;
  for (const channelId of [...pendingAttachments.keys()]) {
    const expired = collectExpiredBatches(channelId, now);
    if (expired.length === 0) continue;
    const ch = getChannel(loadChannelConfig(ctx.cwd), channelId);
    if (!ch) continue;
    const allFiles = expired.flatMap((b) => b.files);
    const prompt = fileOnlyPrompt(allFiles);
    const attParts = expired.map((b) => {
      const files = b.files
        .map((a) => {
          const note = b.notes?.[a.id];
          return `  ${a.filename} (${a.contentType}, ${formatBytes(a.size)})${note ? ` — ${note}` : ""}`;
        })
        .join("\n");
      return `<user-action-ctx>User attached file(s) in ${b.folder}/\n${files}</user-action-ctx>`;
    });
    const channelCtx = buildChannelContext(ch, {
      channelId: ch.id,
      channelName: ch.name,
      channelType: "discord",
      messageId: "",
      from: "buffered files (no text sent)",
      body: "",
      timestamp: new Date().toISOString(),
      attachments: allFiles,
      isRoom: false,
    });
    const fwd = [attParts.join("\n\n"), prompt].filter(Boolean).join("\n\n");
    const disp =
      [attachmentSummary(allFiles), prompt].filter(Boolean).join("\n\n") ||
      "(empty)";
    sendToPi(
      pi,
      ch.id,
      `${channelCtx}\n\n${fwd}`,
      channelTitle(ch, {
        channelId: ch.id,
        channelName: ch.name,
        channelType: "discord",
        messageId: "",
        from: "buffered files (no text sent)",
        body: "",
        timestamp: new Date().toISOString(),
        attachments: allFiles,
        isRoom: false,
      }),
      disp,
    );
    fired++;
  }
  return fired;
}

export default function (pi: ExtensionAPI) {
  let channels: ChannelConfig[] = [];
  let workspaceRoot = "";
  let toolCallsThisTurn: {
    name: string;
    action: string;
    essential: boolean;
  }[] = [];
  // Live status line: one message per run, edited in place per tool call.
  let statusMsgId: string | null = null;
  let statusChannelId: string | null = null;
  let statusMsgAt = 0;
  // Live intermediate text (SPEC B): one ephemeral message per run —
  // posted on the first tool call (below the tool-call block), edited in
  // place with the latest intermediate assistant text, deleted when the
  // final is sent or the run ends. See updateLiveText / deleteLiveText.
  let liveTextMsgId: string | null = null;
  let liveTextChannelId: string | null = null;
  let liveTextAt = 0; // last post/edit time (edit throttle)
  let liveTextShown: string | null = null; // last posted content (skip-unchanged)
  let liveTextLatest: string | null = null; // latest intermediate text this run
  let liveTextArmed = false; // a tool call has fired this run (post gate)
  let runStartedAt = 0;
  let runOpen = false;
  let typingTimer: ReturnType<typeof setInterval> | null = null;

  // Mid-run interrupt: when an armed timer fires, abort the in-flight step
  // and, once the session settles, send the queued message as a fresh run
  // (see runMidRunInterrupt).
  setInterruptHandler((channelId, messageId) => {
    const c = interruptCtx;
    if (!c) return;
    runMidRunInterrupt(pi, c, channelId, messageId).catch((e) => {
      console.error(
        "[channel] mid-run interrupt failed:",
        sanitizeUnknownValue(e),
      );
    });
  });

  // ─── TUI rendering for inbound channel messages ──────────────────────
  // Mimics the user-message look (boxed markdown) with a type/name title;
  // the <channel-ctx> block stays LLM-only.
  pi.registerMessageRenderer<ChannelMessageDetails>(
    CHANNEL_MSG_TYPE,
    (message, _options, theme) => {
      const details = message.details ?? { title: "channel", body: "" };
      const body =
        details.body ||
        (typeof message.content === "string" ? message.content : "");

      const box = new Box(1, 1, (t: string) => theme.bg("userMessageBg", t));
      box.addChild(
        new Text(
          theme.fg("customMessageLabel", theme.bold(details.title)),
          0,
          0,
        ),
      );
      if (body) {
        box.addChild(new Spacer(1));
        box.addChild(
          new Markdown(
            body,
            0,
            0,
            getMarkdownTheme(),
            { color: (t: string) => theme.fg("userMessageText", t) },
            { preserveOrderedListMarkers: true },
          ),
        );
      }
      return box;
    },
  );

  // ─── Startup / Shutdown ────────────────────────────────────────────────
  pi.on("session_start", async (event, ctx) => {
    sessionStartTs = Date.now();
    setInterruptCtx(ctx);
    workspaceRoot = ctx.cwd;
    configRoot = ctx.cwd;
    channels = loadChannelConfig(ctx.cwd);
    // #39/#10: per-channel runtime state (hold flags, verbosity) reloads
    // from <cwd>/.tmp/channel-state.json on every session start (the same
    // file the Discord cursor persists to; see discord.ts).
    setRuntimeStateDir(path.join(ctx.cwd, ".tmp"));
    ensureRuntimeStateLoaded();

    const enabled = channels.filter((c) => c.enabled);
    if (enabled.length === 0) return;

    // Fleet-run gate (hall-monitor #35 gut, 2026-10-20): a fleetwork
    // dispatch run skips ALL channel startup activity — connect, #180
    // re-wake drain + history scan, the post-restart wake + its startup
    // recovery kick, tool registration, sched pollers. The channel is
    // the interactive agent's runtime; the run's own events go through
    // the fleetwork wrapper. (Pilot 2026-10-20: dispatch runs 3/5/6
    // each posted an "unplanned restart" wake card onto the agent's
    // channel on start, re-waking it with a ticket event about a
    // different process.)
    if (isFleetRun()) {
      console.log(
        "[channel] fleet dispatch run - channel startup gated (no connect, no scans, no tools)",
      );
      return;
    }

    // #180: re-wake survival (same startup machinery as the wake below;
    // reason "startup" = a real process start, the same guard
    // runRestartWake uses). Real start: drain the per-channel state
    // files back into the in-memory re-wake queue — session_shutdown
    // cleared memory only, and the Discord cursor already advanced past
    // those inbounds at receipt, so without this the queue dies with
    // the process (2026-10-06 incident: pi-bg callback queued
    // 04:19:44, restart 04:19:52, callback never consumed). In-process
    // /new and /reload (reason != "startup"): the same entries were
    // just wiped from memory by session_shutdown's midTurnQueues.clear()
    // — clear the files too, so a restart never resurrects a
    // /new-dropped queue.
    const rewakeStateDir = path.join(ctx.cwd, ".tmp");
    if (event?.reason === "startup") {
      drainRewakeSurvival(rewakeStateDir, enabled);
    } else {
      for (const ch of enabled)
        if (ch.type === "discord") rewakeClearPending(rewakeStateDir, ch.id);
    }

    const defaultCh = getDefaultChannel(channels);
    if (defaultCh) lastActiveChannel = defaultCh;

    for (const ch of enabled) {
      if (ch.type === "discord") {
        const discordCallbacks: DiscordCallbacks = {
          onMessage(msg) {
            msg.channelId = ch.id;
            handleInbound(pi, msg, ctx).catch((e) => {
              console.error(
                "[channel] inbound failed:",
                sanitizeUnknownValue(e),
              );
            });
          },
          onMessageUpdate(
            channelId,
            messageId,
            content,
            attachments,
            authorId,
          ) {
            updateQueuedInbound(
              ctx,
              channelId,
              messageId,
              content,
              attachments,
              authorId,
            ).catch((e) => {
              console.error(
                "[channel] queued inbound edit failed:",
                sanitizeUnknownValue(e),
              );
            });
          },
          onMessageDelete(channelId, messageId) {
            deleteQueuedInbound(ctx, channelId, messageId).catch((e) => {
              console.error(
                "[channel] queued inbound delete failed:",
                sanitizeUnknownValue(e),
              );
            });
          },
          onError(_c, err) {
            console.error(`[discord] ${sanitizeSensitiveText(err)}`);
          },
        };
        const ok = await connectDiscord(
          ch,
          discordCallbacks,
          path.join(ctx.cwd, ".tmp"),
        );
        if (!ok) {
          ctx.ui.setStatus("Channel", `discord/${ch.name}: connection failed`);
        } else {
          ctx.ui.setStatus("Channel", `discord/${ch.name}`);
          const bt = ch.botToken;
          if (bt) {
            connectDiscordPresence(bt);
            registerDiscordCommands(bt).catch(() => {});
            // Periodic re-registration guard (2026-10-08 drift: both guilds
            // cleared ~2-3h after boot, no audit trail). unref'd, idempotent;
            // JARATE_SLASH_REPUT_MS=0 disables.
            startSlashReput(bt);
            setDiscordInteractionHandler(
              bt,
              buildInteractionHandler(pi, ctx, ch, bt),
            );
          }
          // startupMessage is posted by the poller once the bot's own user
          // id is resolved (prevents the self-echo window).
        }
      }
    }
    writeChannelState(workspaceRoot, channels);

    // Restart-class op marker (reset/restart/undo/redo): the previous
    // process died mid-op. Settle its placeholder with the final line —
    // to the user the channel is blocked from the op until this lands
    // (see beginRestartOp). Stale markers are dropped, not shown.
    try {
      consumeOpMarker(pi, ctx);
    } catch (e) {
      console.error("[op] marker settle failed:", sanitizeUnknownValue(e));
    }

    // Crash settle (#84): a process death that never ran agent_end /
    // session_shutdown (OOM, SIGKILL, power loss) left live placeholders
    // frozen in the channel — working frame, SPEC B live text, in-flight
    // interrupt ack, compact line, queued acks. The previous process
    // persisted them on every transition; drive whatever survived to a
    // terminal state now. Real process starts only (reason "startup"): an
    // in-process /new//reload re-fire must not settle placeholders the
    // live process still owns. Queued-inbound entry REDISPATCH is issue
    // #180's scope — here the placeholder LINES are settled, plus the
    // spliced in-flight interrupt entry (the queue no longer holds it, so
    // nobody else redelivers it).
    if (event?.reason === "startup") {
      try {
        await settleCrashedPlaceholders(pi, ctx);
      } catch (e) {
        console.error(
          "[channel] crash settle failed:",
          sanitizeUnknownValue(e),
        );
      }
    }

    // Post-restart wake (issue #111, P0): on a real process start
    // (reason "startup"), post ONE "back online" message — planned /
    // unplanned restart class + the in-flight pi-bg summary — to the
    // default channel. Fire-and-forget: never blocks or fails startup;
    // no channel/token/webhook = silent no-op; two startups racing
    // within 60s post once.
    {
      const wakeCh =
        defaultCh ?? enabled.find((c) => c.type === "discord") ?? null;
      // event?.reason: the test harness fires session_start(null, ctx);
      // real pi always passes the event (reason "startup" on process start)
      void runRestartWake({
        reason: event?.reason,
        stateDir: rewakeStateDir,
        target:
          wakeCh && (wakeCh.botToken || wakeCh.webhookUrl)
            ? {
                channelId: getDiscordChannelId(wakeCh.id) ?? wakeCh.channel,
                botToken: wakeCh.botToken,
                webhookUrl: wakeCh.webhookUrl,
              }
            : null,
      })
        .then((r) => {
          if (r.posted) {
            console.log(
              `[wake] posted restart wake (${r.restartClass}) to ${wakeCh?.id}`,
            );
            return;
          }
          if (r.reason === "dedup") return; // a racing start owns the post
          // #180: the wake post never lands — the wake inbound is what
          // starts the run whose agent_end re-wakes the survived queue.
          // Kick the oldest entry directly (the bridge is idle at
          // startup; if a run is live, its agent_end owns the queue and
          // the pop is left to it — no double delivery).
          const queued = ctx.isIdle() ? popOldestQueuedInbound() : null;
          if (queued) {
            console.log(
              `[channel] wake post failed: delivering queued inbound directly (${queued.channelId})`,
            );
            handleInbound(pi, queued.msg, ctx, true).catch((e) =>
              console.error(
                "[channel] wake-fail direct delivery failed:",
                sanitizeUnknownValue(e),
              ),
            );
          }
        })
        .catch((e) =>
          console.error("[wake] restart wake failed:", sanitizeUnknownValue(e)),
        );
    }

    // #180 (option 1): bounded startup history scan — ONE fetch per
    // channel (messages?before=<cursor>&limit=$PISCORD_REWAKE_LOOKBACK,
    // default 50) re-queueing any machine-wake (webhook_id) post the old
    // process RECEIVED (cursor already past it) but never committed to
    // pi. Backstop for the primary file layer: the cursor-vs-queue-file
    // micro-window and any other pre-queue loss. Dedupes against the
    // persisted delivered set (committed ids) + the pending list; non-bg
    // human messages (incl. a human quoting a callback) have no
    // webhook_id and are never re-queued. Fire-and-forget like the
    // wake: a dead network at boot is a silent no-op, never a startup
    // failure.
    if (event?.reason === "startup") {
      const scanChannels = enabled
        .filter((c) => c.type === "discord")
        .map((c) => {
          const discordId = getDiscordChannelId(c.id) ?? c.channel;
          return {
            config: c,
            discordId,
            // Live state (connectDiscord seeded it from the persisted
            // cursor) or the file directly if connect has not run yet.
            cursor:
              getDiscordStates().get(c.id)?.lastMessageId ??
              loadPersistedCursors(rewakeStateDir)[discordId] ??
              null,
            token: getDiscordToken(c.id) || c.botToken || "",
          };
        })
        .filter((s) => s.token.length > 0);
      void scanUndeliveredBgInbounds({
        stateDir: rewakeStateDir,
        channels: scanChannels,
        fetcher: (token, urlPath) => discordFetch(token, urlPath),
        requeue: (entry, chId) => {
          const id = entry.msg.messageId;
          const q = midTurnQueues.get(chId) ?? [];
          if (q.some((x) => x.msg.messageId === id)) return; // already covered (survival drain or live delivery)
          // #186 (F1 secondary): live re-check at push time, not the
          // scan's pre-fetch snapshot — a startup delivery (replay /
          // wake-fail kick) that committed this id after the snapshot
          // must not be re-queued (the commit prunes the pending copy
          // and records the delivered id — re-read both).
          const f = loadRewakeQueue(rewakeStateDir, chId);
          if (f.delivered.includes(id)) return; // committed after the snapshot
          if (f.pending.some((p) => p.msg.messageId === id)) return; // queued after the snapshot
          q.push({ msg: entry.msg, queuedAt: entry.queuedAt });
          midTurnQueues.set(chId, q);
          rewakeAddPending(rewakeStateDir, chId, entry);
          console.log(
            `[channel] rewake bg scan: re-queued undelivered machine wake ${entry.msg.messageId} (${chId})`,
          );
        },
      })
        .then((r) => {
          if (r.requeued > 0)
            console.log(
              `[channel] rewake bg scan: ${r.requeued} undelivered post(s) re-queued (${r.scanned} window msgs)`,
            );
        })
        .catch((e) =>
          console.error(
            "[channel] rewake bg scan failed:",
            sanitizeUnknownValue(e),
          ),
        );
    }

    // /undo re-run (F1): RPC-mode pi never auto-prompts at startup, so the
    // kept trigger in the session file alone would not re-run the prompt.
    // performUndo parked a durable rerun trigger before the restart; if
    // this session is the one it targeted and the record is fresh, re-send
    // the trigger text as a new inbound (same path as a channel message).
    try {
      const cur = safeSessionFile(ctx) ?? findSessionFile(ctx.cwd);
      const rerunText = consumeRerun(cur);
      if (rerunText) {
        const ch =
          lastActiveChannel ??
          enabled.find((c) => c.type === "discord") ??
          null;
        if (ch) {
          console.log(
            `[channel] /undo re-run: re-sending kept trigger to ${ch.id}`,
          );
          sendToPi(pi, ch.id, rerunText, "undo re-run", rerunText);
        }
      }
    } catch (e) {
      console.error("[undo] re-run consume failed:", sanitizeUnknownValue(e));
    }

    // LLM tools: send local file(s) / maintain the todo board / session
    // sleep / scheduled tasks.
    if (
      enabled.some(
        (c) => c.type === "discord" && (getDiscordToken(c.id) || c.botToken),
      )
    ) {
      registerSendFileTool(pi, channels);
      registerTodoTool(pi, channels);
      registerSleepTool(pi, channels);
      registerTaskTool(pi, channels);
      registerJarateTool(pi);
    }

    // Sleep wakes + scheduled tasks: deliver anything due NOW (the pending
    // lists are on disk, so this catches up after a pi.service restart or a
    // machine reboot), then poll every 30s for the rest.
    if (enabled.some((c) => c.type === "discord")) {
      // Best-effort cleanup of tmp files orphaned by a crash mid-write.
      try {
        const orphans = collectOrphanTmpFiles() + collectOrphanTaskTmpFiles();
        if (orphans > 0)
          console.log(`[sched] collected ${orphans} orphan tmp file(s)`);
      } catch {
        /* best-effort only */
      }
      const due = deliverDueWakes(pi, channels);
      if (due > 0)
        console.log(`[sleep] delivered ${due} due wake(s) on startup`);
      const tDue = deliverDueTasks(pi, channels);
      if (tDue > 0)
        console.log(`[task] delivered ${tDue} due task(s) on startup`);
      // Live marker (issue #191 M2): touch once at startup, then every
      // poll tick — a wedge anywhere in this process goes stale.
      touchLiveMarker();
      if (schedPoller) clearInterval(schedPoller);
      schedPoller = setInterval(() => {
        try {
          touchLiveMarker();
          const n = deliverDueWakes(pi, channels);
          if (n > 0) console.log(`[sleep] delivered ${n} due wake(s)`);
          const tn = deliverDueTasks(pi, channels);
          if (tn > 0) console.log(`[task] delivered ${tn} due task(s)`);
        } catch (e) {
          console.error("[sched] poller failed:", sanitizeUnknownValue(e));
        }
      }, 30_000);
      (schedPoller as any).unref?.();
    }

    // Buffered file-only batches: auto-flush anything older than 10 minutes
    // as a file-only turn so the buffer never holds files forever. (#24)
    if (bufferFlushTicker) clearInterval(bufferFlushTicker);
    bufferFlushTicker = setInterval(() => {
      try {
        flushExpiredPendingBatches(pi, ctx).catch((e) => {
          console.error(
            "[channel] buffer flush failed:",
            sanitizeUnknownValue(e),
          );
        });
      } catch (e) {
        console.error(
          "[channel] buffer flush failed:",
          sanitizeUnknownValue(e),
        );
      }
    }, 60_000);
    (bufferFlushTicker as any).unref?.();
  });

  pi.on("session_shutdown", async () => {
    // Clean-stop marker (issue #111): the next process start classifies
    // this stop as PLANNED; a crash that never runs this hook leaves no
    // marker, so the wake says unplanned. In-process /new and /reload
    // also fire this — harmless, the marker is only consumed on a real
    // process start.
    writeCleanStop(path.join(workspaceRoot, ".tmp"));
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
    // F2: inbounds delivered between the op's rewind and this shutdown
    // advanced the persisted cursor — re-rewind BEFORE the disconnects
    // below (which drop the live state setChannelCursor needs) so the
    // respawn replays the full op window. Restart-class ops only:
    // rewindTo is null for compaction.
    for (const [id, e] of compactingChannels)
      if (e.rewindTo) setChannelCursor(id, e.rewindTo);
    // #84b (follow-up to #84 L2): drain queued inbounds BEFORE the
    // disconnects below — deleteDiscordMessage resolves the channel id
    // via the state set, which disconnectDiscord deletes (the fallback
    // is the raw config value, which may be a name). session_shutdown
    // runs on EVERY process death (deploy, systemd restart, crash,
    // reboot) — without this the map clears below would wipe the only
    // in-memory reference to queued ack messages, orphaning the
    // "[queued] N in line" / "[..] interrupting" messages in the channel
    // forever. A HELD channel's acks are kept on purpose (operator
    // buffer, /stop A4, /reset #84 L2) — but the buffer entries
    // themselves are lost with the clears below (as pre-PR); only the
    // placeholder line remains in the channel.
    const shutdownDeletes: Promise<unknown>[] = [];
    for (const ch of channels) {
      if (isHeld(ch)) continue;
      // #180: keepFile — this drain is the fast path (ack cleanup
      // before the disconnects drop REST state); the per-channel state
      // file is the survival path a respawn drains instead of clearing.
      const dropped = clearQueuedInbound(ch.id, shutdownDeletes, {
        keepFile: true,
      });
      if (dropped > 0)
        console.log(
          `[channel] shutdown drained ${dropped} queued mid-turn inbound(s) from ${ch.id}`,
        );
    }
    // #84 (settle owner): a shutdown while a run is still active (handoff
    // restart mid-run, crash, deploy) never fires agent_end, so the working
    // frame would freeze mid-count. Close it here through the same owner
    // as agent_end (0 shown calls -> delete, else morph to the terminal
    // state), before the disconnects below drop the channel state REST
    // resolution needs.
    if (runOpen)
      settleWorkingFrame({ state: "stopped", deletes: shutdownDeletes });
    // SPEC B live text: agent_end's deleteLiveText never runs on a dying
    // process — the ephemeral line would stay frozen in the channel.
    if (liveTextMsgId && liveTextChannelId) {
      const lch = channels.find(
        (c) => c.id === liveTextChannelId && c.type === "discord",
      );
      if (lch) {
        const id = liveTextMsgId;
        shutdownDeletes.push(deleteDiscordMessage(lch, id).catch(() => {}));
        liveTextMsgId = null;
        liveTextChannelId = null;
        liveTextAt = 0;
        liveTextShown = null;
        liveTextLatest = null;
        liveTextArmed = false;
      }
    }
    // In-flight interrupt: its entry was spliced OUT of midTurnQueues
    // (invisible to the drain above), and its "[..] interrupting… Ns" line
    // IS the queued ack — consume it so the line does not freeze (the
    // entry's text is lost with the process; there is nothing to redeliver).
    for (const [channelId, messageId] of interruptInFlight)
      consumeQueuedAck(channelId, messageId, shutdownDeletes);
    // Open compact window (no op marker to settle it on respawn): a
    // mid-compact crash would otherwise leave the ticking "[..] compacting…"
    // line frozen. Restart-class op windows are settled by the respawn's
    // op marker instead — leave them.
    for (const [id, e] of compactingChannels) {
      if (e.label !== "compacting") continue;
      const t = opTicks.get(`compact:${id}`);
      if (!t) continue;
      clearInterval(t.timer);
      opTicks.delete(`compact:${id}`);
      compactPlaceholders.delete(id); // #84: record follows the settle
      shutdownDeletes.push(
        editDiscordMessage(
          t.ch,
          t.msgId,
          "compact interrupted - restart",
        ).catch(() => {}),
      );
    }
    for (const ch of channels) {
      if (ch.type === "discord") {
        disconnectDiscord(ch.id);
        if (ch.botToken) {
          stopDiscordPresence(ch.botToken);
          setDiscordInteractionHandler(ch.botToken, null);
        }
      }
    }
    lastActiveChannel = null;
    pendingCompact = null; // F4: don't flush a queued /compact onto a dying/new session
    clearAllCompacting();
    stopAllOpTicks();
    pendingAttachments.clear();
    midTurnQueues.clear();
    queuedAcks.clear();
    clearAllInterrupts();
    setInterruptCtx(null);
    finalReps.clear();
    if (schedPoller) {
      clearInterval(schedPoller);
      schedPoller = null;
    }
    if (bufferFlushTicker) {
      clearInterval(bufferFlushTicker);
      bufferFlushTicker = null;
    }
    // pi may process.exit in the microtask chain right after this handler
    // (zero I/O turns) — await the drain's REST deletes so they reach
    // Discord before the process dies. Worst case a few x ~300ms, well
    // inside the systemd stop timeout.
    await Promise.allSettled(shutdownDeletes);
    // #84: crash-settle record — every placeholder above was driven to its
    // terminal state in-process; drop the record so the respawn's startup
    // settle is a no-op. After the await on purpose: a death mid-drain
    // leaves the file behind and the startup settle retries the REST.
    unlinkLivePlaceholders();
  });

  // ─── /undo store: non-git preimages ─────────────────────────────────
  // tool_execution_start fires in the preflight phase, BEFORE the tool
  // executes — the only window to capture the pre-write content of a file
  // the run touches (write/edit). Git dirs do not need this (the git
  // snapshot at run start covers them).
  pi.on("tool_execution_start", async (event, ctx) => {
    try {
      if (!undoRun || undoRun.git) return;
      if (event.toolName !== "write" && event.toolName !== "edit") return;
      const p = event.args?.path;
      if (typeof p !== "string" || p.length === 0) return;
      stageFileTouch(undoRun, ctx.cwd, p); // resolve against CURRENT cwd (agent may have cd'd)
    } catch (e) {
      console.error("[undo] stage touch failed:", sanitizeUnknownValue(e));
    }
  });

  // ─── Live status frame (edit-in-place, deleted at run end) ───
  // Shared op-tick (5s): the block re-renders the FULL working frame —
  // same builder and fence as the end-of-run done frame (live-frame
  // unification 2026-09-13), 5s-step elapsed, even while no tool call has
  // fired yet (model thinking: `┌ working · 0 calls · 10s`). Render
  // returns null when the run closes or the block is gone; the entry stops
  // at agent_end.
  /** Current live working frame for ch, fenced: sub-steps = calls so far
   *  (level 1: essentials only). count = shown length, so the live header
   *  matches the done frame that morphs this message at run end. */
  const workingFrameBody = (ch: ChannelConfig, secs: number): string => {
    const shown = (
      verboseLevel(ch) === 1
        ? toolCallsThisTurn.filter((c) => c.essential)
        : toolCallsThisTurn
    ).map((c) => c.action);
    return runFrame("working", shown, shown.length, secs);
  };
  const workingFrame = (ch: ChannelConfig, secs: number): string =>
    fence(workingFrameBody(ch, secs));
  const armWorkingTick = () => {
    const ch = lastActiveChannel;
    if (!ch || !statusMsgId) return;
    const key = `working:${ch.id}`;
    armOpTick(
      key,
      ch,
      statusMsgId,
      () => {
        if (!runOpen || !statusMsgId || !lastActiveChannel) return null;
        const wch = lastActiveChannel;
        if (wch.type !== "discord" || statusChannelId !== wch.id) return null;
        const secs = Math.floor((Date.now() - runStartedAt) / 1000);
        // #84 L3: cap the frame's lifetime. A run that never ends would
        // count up forever — settle to the true state (stalled) and stop.
        if (Date.now() - runStartedAt >= workingMaxMs()) {
          settleOpTick(key, "run stalled - /stop to abort");
          return null;
        }
        // UNFENCED body: the fenced=true tick arg fences it exactly once
        // (review F1).
        const body = workingFrameBody(wch, Math.floor(secs / 5) * 5);
        persistLivePlaceholders(); // #84: keep the crash-settle body fresh
        return body;
      },
      true,
    );
  };

  // ─── Live intermediate text (SPEC B) ──────────────────────────────────
  // Available at EVERY verbose level (level 0 "text" included): the level
  // gates the tool-call FRAMES only, never the live text. Post only on a
  // tool_call event (first call of the run) so the message always lands
  // BELOW the tool-call block; message_end only edits an already-posted
  // message. Throttle: LIVE_TEXT_THROTTLE_MS between edits; skip when the
  // content is unchanged. Every network path is best-effort — logged,
  // never breaks the run.
  const isLiveTextChannel = (ch: ChannelConfig): boolean =>
    ch.type === "discord";

  const updateLiveText = async (ch: ChannelConfig, mayPost: boolean) => {
    if (!isLiveTextChannel(ch)) return;
    // No placeholder: the message only ever carries real intermediate text.
    // First post happens on the first text that arrives after a tool call.
    if (liveTextLatest === null) return;
    const next = truncateLiveText(liveTextLatest);
    if (liveTextMsgId && next === liveTextShown) return; // unchanged
    const now = Date.now();
    if (liveTextMsgId && now - liveTextAt < LIVE_TEXT_THROTTLE_MS) return;
    try {
      if (liveTextMsgId && liveTextChannelId === ch.id) {
        const r = await editDiscordMessage(
          ch,
          liveTextMsgId,
          mdToDiscord(next),
        );
        if (r.success) {
          liveTextShown = next;
          liveTextAt = now;
          persistLivePlaceholders(); // #84: live text refreshed
        } else
          console.error(
            `[channel] live-text edit failed: ${sanitizeSensitiveText(r.error || "")}`,
          );
      } else {
        if (!mayPost) return; // the post happens on the first tool call
        if (liveTextMsgId) {
          // channel switched mid-run: clear the old channel's ephemeral
          // block before re-posting on the new one
          const old = channels.find((c) => c.id === liveTextChannelId);
          if (old)
            await deleteDiscordMessage(old, liveTextMsgId).catch(() => {});
        }
        const r = await sendDiscordMessage(ch, mdToDiscord(next));
        if (r.success && r.messageId) {
          liveTextMsgId = r.messageId;
          liveTextChannelId = ch.id;
          liveTextAt = now;
          liveTextShown = next;
          persistLivePlaceholders(); // #84: live text posted
        } else if (!r.success)
          console.error(
            `[channel] live-text post failed: ${sanitizeSensitiveText(r.error || "")}`,
          );
      }
    } catch (e) {
      console.error(
        "[channel] live-text update failed:",
        sanitizeUnknownValue(e),
      );
    }
  };

  const deleteLiveText = async (ch: ChannelConfig) => {
    if (!liveTextMsgId || liveTextChannelId !== ch.id) return;
    const id = liveTextMsgId;
    liveTextMsgId = null;
    liveTextChannelId = null;
    liveTextAt = 0;
    liveTextShown = null;
    liveTextLatest = null;
    liveTextArmed = false;
    try {
      const r = await deleteDiscordMessage(ch, id);
      if (!r.success)
        console.error(
          `[channel] live-text delete failed: ${sanitizeSensitiveText(r.error || "")}`,
        );
    } catch (e) {
      console.error(
        "[channel] live-text delete failed:",
        sanitizeUnknownValue(e),
      );
    }
    persistLivePlaceholders(); // #84: the live text is gone
  };

  // ─── Working frame settle owner (#84: stale placeholders) ──────────
  // The ONE place the working frame reaches a terminal state. Every
  // exit path funnels here: agent_end (done/failed — including the
  // finally net when a handler throw skips the close block), the
  // run's channel switch at tool_call (stopped), session_shutdown
  // (stopped; #173's inline settle is this call), and /verbose on->off
  // (erase). Idempotent: it nulls the pointer, so a second settle is a
  // no-op. Returns false when it left the pointer alone (not this
  // run's frame, #38) so a caller can still reset it.
  const settleWorkingFrame = (opts: {
    state?: "done" | "failed" | "stopped";
    erase?: boolean;
    trailing?: string;
    deletes?: Promise<unknown>[];
    onlyChannelId?: string;
    chFallback?: ChannelConfig | null;
  }): boolean => {
    const msgId = statusMsgId;
    const fchId = statusChannelId;
    if (!msgId || !fchId) return false;
    if (opts.onlyChannelId && fchId !== opts.onlyChannelId) return false;
    // Only close a frame created by THIS run (statusMsgAt >=
    // runStartedAt): a verbose-off run must not touch the previous run's
    // terminal line (#38).
    if (statusMsgAt < runStartedAt) return false;
    // Channel resolution: the caller's captured channel (inbound-fresh)
    // when it matches, then the session config, then a live re-load —
    // the closure `channels` is empty before session_start (tests and
    // the earliest events), which is exactly when a /verbose off can hit.
    let fch: ChannelConfig | undefined;
    if (opts.chFallback && opts.chFallback.id === fchId) fch = opts.chFallback;
    else {
      fch = channels.find((c) => c.id === fchId && c.type === "discord");
      if (!fch) {
        const rc = resolveChannel(fchId);
        if (rc && rc.type === "discord") fch = rc;
      }
    }
    statusMsgId = null;
    statusMsgAt = 0;
    stopOpTick(`working:${fchId}`);
    if (fch) {
      const lvl = verboseLevel(fch);
      const shown = (
        lvl === 1
          ? toolCallsThisTurn.filter((c) => c.essential)
          : toolCallsThisTurn
      ).map((c) => c.action);
      const p =
        opts.erase || shown.length === 0
          ? deleteDiscordMessage(fch, msgId).catch(() => {})
          : editDiscordMessage(
              fch,
              msgId,
              fence(
                runFrame(
                  opts.state ?? "stopped",
                  shown,
                  shown.length,
                  Math.round((Date.now() - runStartedAt) / 1000),
                  opts.trailing,
                ),
              ),
            ).catch(() => {});
      if (opts.deletes) opts.deletes.push(p);
    }
    persistLivePlaceholders(); // #84: frame record cleared
    return true;
  };

  // Crash settle (#84): persist the live working frame + SPEC B live text
  // on every transition so the next process start can drive them to a
  // terminal state. The body is re-rendered from the CURRENT call list at
  // the 5s step, so a crash mid-tick resumes from the last whole step.
  setLivePlaceholderSnapshot(() => {
    const msgId = statusMsgId;
    const fchId = statusChannelId;
    let frame: LiveFrameRec | null = null;
    if (msgId && fchId) {
      const fch = channels.find((c) => c.id === fchId && c.type === "discord");
      const secs =
        Math.floor(Math.max(0, Date.now() - runStartedAt) / 1000 / 5) * 5;
      const lvl = fch ? verboseLevel(fch) : 2;
      const shown = (
        lvl === 1
          ? toolCallsThisTurn.filter((c) => c.essential)
          : toolCallsThisTurn
      ).map((c) => c.action);
      frame = {
        channelId: fchId,
        msgId,
        calls: shown.length,
        body: fch ? workingFrameBody(fch, secs) : null,
      };
    }
    const liveText =
      liveTextMsgId && liveTextChannelId
        ? { channelId: liveTextChannelId, msgId: liveTextMsgId }
        : null;
    return { frame, liveText };
  });

  /** #84: drive the crash-surviving placeholders (live-placeholders.json)
   *  to a terminal state on a real process start. All REST in parallel,
   *  awaited so the channel is settled before the wake post; the record is
   *  unlinked once the calls land. */
  const settleCrashedPlaceholders = async (
    pi: ExtensionAPI,
    _ctx: ExtensionContext,
  ): Promise<void> => {
    const state = readLivePlaceholders();
    if (!state) return;
    const rest: Promise<unknown>[] = [];
    const chOf = (id: string): ChannelConfig | null =>
      channels.find((c) => c.id === id && c.type === "discord") ?? null;
    if (state.frame) {
      const fch = chOf(state.frame.channelId);
      if (fch) {
        // Same rules as the in-process settles: 0 shown calls (or an
        // unrenderable body) -> delete; else the header flips working ->
        // stopped in place (the recorded body is the last whole 5s step).
        rest.push(
          (state.frame.calls === 0 || !state.frame.body
            ? deleteDiscordMessage(fch, state.frame.msgId)
            : editDiscordMessage(
                fch,
                state.frame.msgId,
                fence(state.frame.body.replace(/^┌ working/, "┌ stopped")),
              )
          ).catch(() => {}),
        );
      }
    }
    if (state.liveText) {
      const ch = chOf(state.liveText.channelId);
      if (ch)
        rest.push(
          deleteDiscordMessage(ch, state.liveText.msgId).catch(() => {}),
        );
    }
    for (const c of state.compacts) {
      const ch = chOf(c.channelId);
      if (!ch) continue;
      rest.push(
        editDiscordMessage(ch, c.msgId, "compact interrupted - restart").catch(
          () => {},
        ),
      );
    }
    for (const q of state.queueAcks) {
      const kept = (midTurnQueues.get(q.channelId) ?? []).some(
        (e) => e.msg.messageId === q.inboundId,
      );
      if (kept) continue; // #180 restored the entry: its drain owns the ack
      const ch = chOf(q.channelId);
      if (ch) rest.push(deleteDiscordMessage(ch, q.ackId).catch(() => {}));
    }
    for (const r of state.interrupts) {
      const ch = chOf(r.channelId);
      if (!ch) continue;
      // The entry was spliced out of the queue before the crash —
      // redeliver it as a fresh run (the in-process interrupt success
      // path, minus the tick), then clear its ack line.
      lastActiveChannel = ch; // the fresh run's frame lands on its channel
      try {
        sendToPi(pi, r.channelId, r.text, r.title, r.display, r.msgId);
      } catch (e) {
        console.error(
          "[channel] crash-settle interrupt redelivery failed:",
          sanitizeUnknownValue(e),
        );
      }
      if (r.ackId) rest.push(deleteDiscordMessage(ch, r.ackId).catch(() => {}));
    }
    if (rest.length > 0) await Promise.allSettled(rest);
    unlinkLivePlaceholders();
  };

  // Display gate (#38): called on a live /verbose on->off transition —
  // deletes the in-flight block so it does not sit in history as a stale
  // "working…" line. The next tool call re-arms a fresh block only if
  // verbose comes back on. runChannelCommand is module-level, so the
  // closure hands this in instead of reaching for the state directly.
  const deleteLiveStatusBlock = async (ch: ChannelConfig) => {
    // #84: the frame's terminal-state owner (erase: delete, no morph).
    // Channel-scoped: a /verbose off on ch1 must not kill ch2's live frame.
    settleWorkingFrame({ erase: true, onlyChannelId: ch.id, chFallback: ch });
    // SPEC B: the ephemeral live-text message goes with the block.
    await deleteLiveText(ch);
  };
  onDeleteStatusBlock = deleteLiveStatusBlock;

  pi.on("tool_call", async (event) => {
    if (!lastActiveChannel) return;
    const ch = lastActiveChannel;
    if (statusChannelId !== ch.id) {
      // #84: the run's display is moving channels — settle the old
      // channel's frame in place (a frozen mid-count box is the stale
      // placeholder this fix kills) before this channel takes over.
      settleWorkingFrame({ state: "stopped" });
      statusMsgId = null; // covers a not-this-run frame the owner left (#38)
      statusMsgAt = 0;
      statusChannelId = ch.id;
    }
    if (!runOpen) {
      runOpen = true;
      runStartedAt = Date.now();
      // reuse the line only while it is fresh; an old one is buried in
      // history — delete it and start near the current conversation
      if (
        statusMsgId &&
        statusChannelId === ch.id &&
        Date.now() - statusMsgAt > 10 * 60 * 1000
      ) {
        await deleteDiscordMessage(ch, statusMsgId).catch(() => {});
        statusMsgId = null;
      }
    }
    const action = toolActionText(event.toolName, event.input);
    // #10: record EVERY call (the live frame and the done frame at run end
    // both filter to essentials at level 1 from this same list).
    const essential = isEssentialToolCall(event.toolName, event.input);
    toolCallsThisTurn.push({
      name: event.toolName,
      action,
      essential,
    });
    // Display gate (#38/#10): level 0 renders nothing; level 1 renders
    // essential tools only (reads, read-only bash, ... stay hidden);
    // level 2 renders every call. The edit renders the FULL working frame
    // (live-frame unification) — same builder as the end-of-run morph.
    const lvl = verboseLevel(ch);
    if (lvl > 0 && (lvl === 2 || essential)) {
      const frame = workingFrame(
        ch,
        Math.round((Date.now() - runStartedAt) / 1000),
      );
      try {
        if (!statusMsgId) {
          const r = await sendDiscordMessage(ch, frame);
          if (r.success && r.messageId) {
            statusMsgId = r.messageId;
            statusMsgAt = Date.now();
            armWorkingTick();
            persistLivePlaceholders(); // #84: frame posted
          } else if (!r.success)
            console.error(
              `[channel] status send failed: ${sanitizeSensitiveText(r.error || "")}`,
            );
        } else {
          const r = await editDiscordMessage(ch, statusMsgId, frame);
          if (!r.success)
            console.error(
              `[channel] status edit failed: ${sanitizeSensitiveText(r.error || "")}`,
            );
          else persistLivePlaceholders(); // #84: frame refreshed
        }
      } catch {}
    }
    // SPEC B: live intermediate text. A tool call ARMS the ephemeral
    // message; it is posted on the first real intermediate text at or
    // after that point (never a placeholder), then edited in place
    // (throttled, skip-unchanged). Available at every verbose level —
    // the level gates the frames only; a run with zero tool calls or zero
    // intermediate text never posts one.
    liveTextArmed = true;
    await updateLiveText(ch, liveTextArmed);
  });

  // ─── Typing indicator while working ────────────────────────────────────
  pi.on("turn_start", async (_event, ctx) => {
    const ch = lastActiveChannel;
    if (ch?.type !== "discord") return;
    userStoppedRun = false; // a new run makes any earlier /stop flag stale
    // activity block: every run gets a placeholder, edited in place as
    // tool calls fire, closed at agent_end. turn_start fires per step,
    // so the runOpen gate makes this once-per-run.
    if (!runOpen) {
      runOpen = true;
      runStartedAt = Date.now();
      // Reset the status pointer for every new run, gate or no gate: a
      // verbose-off run must not leave the previous run's block addressable
      // to a mid-run on->off->on re-edit (review finding, #38 merge round).
      statusMsgId = null;
      statusChannelId = null;
      statusMsgAt = 0;
      // SPEC B: fresh run, fresh ephemeral text slot. A leftover message
      // from an abnormal run end is deleted here (agent_end normally
      // already did); the pointers are cleared either way. #84: delete it
      // on ITS channel — lastActiveChannel may have moved mid-run.
      {
        const ltId = liveTextMsgId;
        const ltChId = liveTextChannelId;
        if (ltId && ltChId) {
          const ltCh = channels.find(
            (c) => c.id === ltChId && c.type === "discord",
          );
          if (ltCh) deleteDiscordMessage(ltCh, ltId).catch(() => {});
        }
      }
      liveTextMsgId = null;
      liveTextChannelId = null;
      liveTextAt = 0;
      liveTextShown = null;
      liveTextLatest = null;
      liveTextArmed = false;
      persistLivePlaceholders(); // #84: pointers cleared for the new run
      // /undo store: capture the pre-run state (once per run). Best-effort:
      // a snapshot failure must never break the run.
      try {
        undoRun = startRun(ctx.cwd);
      } catch (e) {
        undoRun = null;
        console.error("[undo] start failed:", sanitizeUnknownValue(e));
      }
      // fresh block per user message; previous blocks stay in history.
      // Display gate (#38/#10): level 2 posts the placeholder up front;
      // level 1 waits for the first essential call (tool_call creates the
      // block) so a reads-only run shows nothing; level 0 shows nothing.
      // Run state still tracks the run, so agent_end's done-line no-ops
      // cleanly.
      if (verboseLevel(ch) === 2) {
        // live-frame unification: the placeholder IS the working frame
        // (0 calls); every later state edits the same message in place.
        const r = await sendDiscordMessage(ch, workingFrame(ch, 0));
        if (r.success && r.messageId) {
          statusMsgId = r.messageId;
          statusChannelId = ch.id;
          statusMsgAt = Date.now();
          armWorkingTick();
          persistLivePlaceholders(); // #84: frame posted
        }
      }
    }
    console.log("[channel] typing indicator started");
    sendDiscordTyping(ch).catch(() => {});
    if (typingTimer) clearInterval(typingTimer);
    typingTimer = setInterval(
      () => sendDiscordTyping(ch).catch(() => {}),
      8000,
    );
    agentBusy = true;
    refreshActivity(ctx);
  });

  // ─── Live ctx% in bot status ───────────────────────────────────────────
  // ─── Live presence status: ctx% • model • state ────────────────────
  const refreshActivity = (ctx: ExtensionContext) => {
    try {
      const u = ctx.getContextUsage?.();
      const pct = u?.percent;
      const modelId = String(
        (ctx.model as any)?.id ?? (ctx.model as any)?.name ?? "",
      );
      const model = modelId.split("/").pop() || "";
      const parts: string[] = [];
      if (typeof pct === "number" && Number.isFinite(pct))
        parts.push(`ctx ${Math.round(pct)}%`);
      if (model) parts.push(model);
      parts.push(agentBusy ? "working" : "idle");
      const text = parts.join(" · ");
      for (const ch of channels) {
        if (ch.type === "discord" && ch.botToken)
          setDiscordPresenceActivity(ch.botToken, text);
      }
    } catch {}
  };

  pi.on("message_end", async (event, ctx) => {
    refreshActivity(ctx);

    // Early send: intermediate assistant messages (text + toolCall) AND
    // step-finals (text only) are forwarded live at message_end. Step-finals
    // are marked so the agent_end path skips them — a final from a step
    // interrupted by a steering message never reaches agent_end, so relying
    // on agent_end dropped it silently (2026-09-08 incident). This path is
    // the live delivery path for normal turns: it strips <reply-to:MSGID>
    // and threads the final to the tagged inbound (when the id is one of
    // this run's triggering ids) or, untagged, to the last inbound.
    const ch = lastActiveChannel;
    if (!ch || !agentBusy) return;
    const msg = event.message;
    const early = earlySendText(msg);
    const text = early ?? finalText(msg);
    if (!text) return;
    if (isNoReply(text)) {
      // Silence chosen: close the turn (ack + live text) without posting.
      // earlySent keeps collectFinals from re-posting it at agent_end.
      earlySent.add(msg);
      if (isLiveTextChannel(ch)) await deleteLiveText(ch);
      if (ch.type === "discord") {
        const inboundId = lastInboundIds.get(ch.id);
        const token = getDiscordToken(ch.id) || ch.botToken;
        const channelId = getDiscordChannelId(ch.id) || ch.channel;
        if (inboundId && token && channelId)
          unreactMessage(token, channelId, inboundId, "👀").catch(() => {});
      }
      return;
    }
    earlySent.add(msg);
    if (early !== null && isLiveTextChannel(ch)) {
      // SPEC B: intermediate text (text + toolCall) with forwarding on
      // lands in the ONE ephemeral live-text message — edited in place
      // here (posted on the first tool call, below the tool-call block)
      // instead of a separate early-sent message. The <reply-to> tag is
      // stripped; threading applies only to standalone messages.
      liveTextLatest = parseReplyTo(early).text;
      await updateLiveText(ch, liveTextArmed);
    } else {
      if (early === null && recordFinalRepeat(ch.id, text)) {
        // Third consecutive identical final — a stuck loop. Drop the
        // repeated final, abort the run, post one warning line instead.
        userStoppedRun = true;
        if (ch.type === "discord")
          sendDiscordMessage(ch, REPEAT_WARNING).catch(() => {});
        try {
          ctx.abort();
        } catch {}
        return;
      }
      const rt = parseReplyTo(text);
      const allowed = runInboundIds.get(ch.id);
      const tagged =
        rt.replyTo && allowed?.includes(rt.replyTo) ? rt.replyTo : undefined;
      const replyTo =
        tagged ?? (early === null ? lastInboundIds.get(ch.id) : undefined);
      const chunks = chunkText(rt.text, 1900);
      const files = detectAttachmentFiles(rt.text);
      for (let i = 0; i < chunks.length; i++) {
        try {
          const r = await sendFinalWithFiles(
            ch,
            chunks[i],
            i === 0 ? files : [],
            i === 0 ? replyTo : undefined,
          );
          if (!r.success)
            console.error(
              `[channel] early send failed: ${sanitizeSensitiveText(r.error || "")}`,
            );
        } catch {}
      }
      // SPEC B: the final is out — delete the ephemeral live-text message
      // (best effort; the agent_end delete is the safety net for runs
      // whose final never reaches this path).
      if (isLiveTextChannel(ch)) await deleteLiveText(ch);
    }
    // Unreact the 👀 ack on this channel's last inbound message (A1):
    // the final lands on this path, so the ack is cleared here too.
    // No-op when the ack was never added (suppressed / ack off).
    if (ch.type === "discord") {
      const inboundId = lastInboundIds.get(ch.id);
      const token = getDiscordToken(ch.id) || ch.botToken;
      const channelId = getDiscordChannelId(ch.id) || ch.channel;
      if (inboundId && token && channelId) {
        unreactMessage(token, channelId, inboundId, "👀").catch(() => {});
      }
    }
  });

  // A /compact queued while a compaction was already in flight: no run
  // is active, so agent_end will never flush it — flush it when the
  // blocking compaction settles, success or failure. (Aborted-settle is
  // fine: a superseding compaction's own settle flushes the pending one.)
  const flushPendingCompact = (ctx: ExtensionContext): boolean => {
    if (!pendingCompact) return false;
    const pc = pendingCompact;
    pendingCompact = null;
    const err = startCompact(pi, pc, ctx, true);
    if (err !== null) {
      const t = channelError(err);
      if (t !== null)
        sendDiscordMessage(pc.ch, styleGuard(`compact failed: ${t}`)).catch(
          () => {},
        );
    }
    return err === null;
  };
  // A compaction settled (success or failure): close the window, then
  // flush a /compact queued behind it. Clear BEFORE the flush: a flushed
  // /compact re-opens the window for its own channel and must not be
  // swept by this settle. When no new compaction started, drain whatever
  // was queued behind the window (no agent_end fires on its own while pi
  // is idle, so queued inbounds would stall otherwise).
  const settleCompacting = (ctx: ExtensionContext): void => {
    for (const id of [...compactingChannels.keys()]) clearCompacting(id);
    const started = flushPendingCompact(ctx);
    if (started) return;
    // Drain on BOTH settle paths, but deferred one macrotask. pi's SUCCESS
    // path emits session_compact BEFORE clearing its own compaction state
    // (agent-session.js: emit, then _clearManualCompactionState), and the
    // extension runner awaits the handler inside the emit — so at event
    // time ctx.isIdle() is still false there, and a synchronous drain
    // bails (the queued message then stalls until the next inbound). The
    // failure path clears state before emitting, so the deferral is
    // harmless there. By the time the timer fires pi has cleared state
    // and isIdle() is true; if a run started in between, the drain
    // no-ops and that run's agent_end owns delivery.
    setTimeout(() => drainQueuedAfterCompact(pi, ctx), 0);
  };
  pi.on("session_compact", (_event, ctx) => {
    settleCompacting(ctx);
    // Mechanism B: the restart gate runs AFTER the settle above (F1).
    // No-op unless handoff is enabled; on a qualifying compact it restarts
    // into a fresh seeded session (armed by the doc write in
    // session_before_compact). No size gate — every handoff-qualifying
    // compact rotates the session so /usage turns reset to 0 (issue #85).
    handoffRestartForSize(pi, ctx);
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    settleCompacting(ctx);
  });

  // ─── Handover compaction (mechanism A, design v2, PR1) ────────────────
  // A qualifying compaction returns a DURABLE handover doc as pi's custom
  // compaction result ({ compaction: { summary } }) — never cancel:true
  // (F1: that emits session_compact_failed and disturbs the op-window
  // settle flow). Gate: handoff.enabled (PR1 default false), reason
  // manual|threshold (threshold only at/over the HANDOFF_THRESHOLD
  // fraction of the TOTAL window), no handover in flight. LLM failure or
  // abort → undefined → pi falls back to the built-in compact (the
  // sanitized channel notice is posted inside buildHandover).
  pi.on("session_before_compact", (event, ctx) => {
    const settings = resolveHandoffSettings(ctx.cwd);
    let percent: number | null = null;
    try {
      percent = ctx.getContextUsage?.()?.percent ?? null;
    } catch {
      percent = null;
    }
    if (
      !shouldHandoff(event, {
        enabled: settings.enabled,
        threshold: settings.threshold,
        inFlight: handoffInFlight,
        percent,
        // A just-written doc (possibly with a mechanism B restart + seed
        // still pending) keeps this session non-handoff-eligible for a
        // short window — the fresh session must not immediately rebuild
        // the doc it was just seeded with.
        freshWindow: isHandoffFreshWindow(settings.storeDir),
      })
    )
      return undefined;
    // F10: synchronous, before any await.
    handoffInFlight = true;
    return (async () => {
      try {
        const doc = await buildHandover({
          preparation: event.preparation,
          branchEntries: event.branchEntries,
          ctx,
          pi,
          settings,
          instructions: event.customInstructions,
          signal: event.signal,
          complete: handoverCompleteForTest ?? undefined,
        });
        // Doc written -> THIS compact must restart into a fresh session.
        // Arm now (before returning) so maybeHandoffRestart, which runs on
        // session_compact after this handler resolves, exempts itself from
        // the fresh window this doc just set.
        setHandoffRestartArmed(true);
        const tags = parsePriorTags(doc);
        return {
          compaction: {
            summary: doc,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details: {
              readFiles: tags.readFiles,
              modifiedFiles: tags.modifiedFiles,
            },
          },
        };
      } catch (e) {
        console.error(
          "[handover] fallback to built-in compact:",
          sanitizeUnknownValue(e),
        );
        return undefined;
      } finally {
        handoffInFlight = false;
      }
    })();
  });

  // ─── Auto-forward on turn end ──────────────────────────────────────────
  // An assistant message with no tool calls is the final answer of its
  // step. A run can contain several (steering messages interrupt the
  // turn), so forward every one of them.
  pi.on("agent_end", async (event, ctx) => {
    // #84: the finally net below settles the working frame if ANY throw
    // skips the close block (the tick stops at the top of this handler, so
    // a skip would leave the box frozen mid-count).
    let runStats: UsageStats = {
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    try {
      // Clear turn state FIRST: since step-finals are forwarded at
      // message_end, a normal turn reaches agent_end with finals.length === 0
      // and the early return below. Clearing at the bottom leaked the typing
      // timer (typing indicator ran forever) and left agentBusy stuck (presence
      // stuck on "working") — 2026-09-08.
      if (typingTimer) {
        clearInterval(typingTimer);
        typingTimer = null;
      }
      stopOpTickPrefix("working:");
      agentBusy = false;
      refreshActivity(ctx);
      // /undo store: finalize THIS run's snapshot before the re-wake below
      // hands the queue to pi (so the post-state reflects this run, not the
      // next). Best-effort: a snapshot failure must never break run end.
      try {
        if (undoRun) {
          // F3: record whether this run actually answered, so /undo skips
          // empty runs (/stop before the first step) instead of cutting the
          // previous run's conversation while keeping this run's file state.
          const assistantOutput = (event.messages ?? []).some((m: any) => {
            if (m?.role !== "assistant") return false;
            if (Array.isArray(m.content)) {
              return m.content.some(
                (b: any) =>
                  b?.type === "text" &&
                  typeof b.text === "string" &&
                  b.text.trim() !== "",
              );
            }
            return typeof m.content === "string" && m.content.trim() !== "";
          });
          finishRun(undoRun, ctx.cwd, safeSessionFile(ctx), assistantOutput);
          undoRun = null;
        }
      } catch (e) {
        undoRun = null;
        console.error("[undo] finish failed:", sanitizeUnknownValue(e));
      }
      // Deferred /compact (queued while this run was in progress). The
      // IIFE inside pi's compact() awaits abort()+waitForIdle() before it
      // compacts, so it runs only after this run settles (including the
      // re-wake continuation below) and cannot abort that run.
      flushPendingCompact(ctx);

      // Proactive token-% gate (first shot): context at/over the handoff
      // threshold with nothing in flight → the same compact /compact runs.
      // Deferred one macrotask like the size gate — if the re-wake run below
      // starts before the timer fires, the gate skips (not idle). The
      // RELIABLE shot is the agent_settled listener below (issue #85): pi
      // clears the run-active flag (isIdle → true) only AFTER this awaited
      // handler resolves, so on runs that await Discord I/O the timer fires
      // while isIdle() is still false and this shot bails. A flush-started
      // compact above already owns the op window, so the gate yields to it.
      autoCompactByToken(pi, ctx);

      // Capture the run's channel BEFORE the re-wake await: a second channel's
      // inbound can arrive during that await and overwrite lastActiveChannel,
      // which would mis-target this run's failure post and finals. The
      // re-wake message's own run will get a fresh agent_end with its own
      // captured channel. (The frame settle is channel-independent: the owner
      // resolves the frame's OWN channel — #84.)
      const ch = lastActiveChannel;

      // SPEC B: clear the ephemeral live-text message on run end — error,
      // stop, timeout, or a final delivered on this path instead of
      // message_end. Before the re-wake below: the next run's turn_start
      // would otherwise reset the pointers and orphan this run's message.
      // #84: delete it on ITS OWN channel — lastActiveChannel may have
      // moved mid-run. Best effort — logged, never breaks the run.
      {
        const ltId = liveTextMsgId;
        const ltChId = liveTextChannelId;
        if (ltId && ltChId) {
          const ltCh =
            channels.find((c) => c.id === ltChId && c.type === "discord") ??
            (ch && ch.id === ltChId ? ch : null);
          if (ltCh) await deleteLiveText(ltCh);
        }
      }

      // #40: keep the last completed run's usage for /usage last. Any run
      // with billable tokens, done or failed (the synthetic failure message
      // carries empty usage, so a hard-failed run keeps the previous value).
      runStats = sumRunUsage(event.messages ?? []);
      if (hasUsage(runStats))
        lastRunUsage.value = { stats: runStats, at: new Date() };

      // Re-wake: inbounds that arrived while this run was in flight were queued
      // (not steered into it) so they cannot be swallowed. Start a fresh run for
      // the oldest queued one now. Awaiting it guarantees the message is handed
      // to pi before this handler returns, so the new turn actually starts
      // (triggerTurn; pi continues the run for a steer queued at agent_end).
      // Repeats on each agent_end until the queue drains.
      //
      // YIELD TO IN-FLIGHT INTERRUPTS (any channel): an in-flight interrupt's
      // settle loop is waiting on isIdle() so its message can start the next
      // run. A re-wake run started here would hold isIdle() false for the run's
      // whole duration (minutes), the interrupt would burn its 120 s settle
      // cap, and its placeholder would linger until a later re-wake finally
      // delivered it (2026-09-30 incident: re-wake run started 2 s after the
      // abort and ate the entire settle window). The entries stay queued
      // (FIFO position and acks intact — nothing popped); the interrupt run's
      // own agent_end re-wakes them. /stop in the window clears only its OWN
      // channel's queue (non-held) — cross-channel entries are rescued by the
      // interrupt cancel branch's re-wake kick (runMidRunInterrupt); held
      // channels are skipped by popOldestQueuedInbound. Nothing is lost or
      // double-sent.
      if (interruptingChannels.size > 0) {
        console.log(
          `[channel] re-wake deferred: interrupt in flight (${[...interruptingChannels].join(", ")})`,
        );
      } else {
        const queued = popOldestQueuedInbound();
        if (queued) {
          console.log(
            `[channel] re-wake: starting run for queued mid-turn inbound (${queued.channelId})`,
          );
          try {
            await handleInbound(pi, queued.msg, ctx, true);
          } catch (e) {
            console.error("[channel] re-wake failed:", sanitizeUnknownValue(e));
          }
        }
      }

      if (!ch) return;

      const finals = collectFinals(event.messages ?? []);

      // Close the activity block (single owner, #84): 0 tool calls ->
      // delete (a leftover "done · 0 calls" box is noise); otherwise it
      // stays up showing the run. The owner resolves the frame's OWN
      // channel (lastActiveChannel may have moved mid-run) and only
      // closes a block created by THIS run (statusMsgAt >= runStartedAt):
      // a verbose-off run leaves statusMsgId pointing at the previous
      // run's line, which history keeps as-is (#38).
      settleWorkingFrame({
        state: failurePostText(event.messages ?? [], userStoppedRun)
          ? "failed"
          : "done",
        trailing: runUsageLine(runStats) ?? undefined,
        chFallback: ch,
      });
      runOpen = false;

      toolCallsThisTurn = [];

      const send = (text: string, replyTo?: string) => {
        const files = detectAttachmentFiles(text);
        return sendFinalWithFiles(ch, text, files, replyTo);
      };

      if (finals.length === 0) {
        // Surface silent run failures (A2): without this, a model/API error
        // (empty-text failure message) ends the run with no channel output.
        const failText = failurePostText(event.messages ?? [], userStoppedRun);
        userStoppedRun = false;
        if (failText) {
          try {
            const r = await send(failText);
            if (!r.success)
              console.error(
                `[channel] error post failed: ${sanitizeSensitiveText(r.error || "")}`,
              );
          } catch {}
        }
        return;
      }
      userStoppedRun = false;

      for (const f of finals) {
        if (isNoReply(f.text)) {
          // Silence chosen: clear the ack if threaded, post nothing.
          if (ch.type === "discord" && f.replyTo) {
            const token = getDiscordToken(ch.id) || ch.botToken;
            const channelId = getDiscordChannelId(ch.id);
            if (token && channelId)
              unreactMessage(token, channelId, f.replyTo, "👀").catch(() => {});
          }
          continue;
        }
        if (recordFinalRepeat(ch.id, f.text)) {
          // Repetition loop (seen across the whole run, incl. the
          // message_end path): one warning, abort, skip the repeated final.
          userStoppedRun = true;
          if (ch.type === "discord") {
            try {
              const r = await send(REPEAT_WARNING);
              if (!r.success)
                console.error(
                  `[channel] repetition warning failed: ${sanitizeSensitiveText(r.error || "")}`,
                );
            } catch {}
            try {
              ctx.abort();
            } catch {}
          }
          continue;
        }
        const chunks = chunkText(f.text, 1900);
        for (let i = 0; i < chunks.length; i++) {
          try {
            const r = await send(chunks[i], i === 0 ? f.replyTo : undefined);
            if (!r.success)
              console.error(
                `[channel] send failed: ${sanitizeSensitiveText(r.error || "")}`,
              );
          } catch {}
        }
        // Clear the ack even when every chunk failed, so a failed reply
        // does not leave a stale 👀 on the user's message.
        if (ch.type === "discord" && f.replyTo) {
          const token = getDiscordToken(ch.id) || ch.botToken;
          const channelId = getDiscordChannelId(ch.id);
          if (token && channelId)
            unreactMessage(token, channelId, f.replyTo, "👀").catch(() => {});
        }
      }
    } finally {
      // #84: last line of defense — the frame reaches a terminal state on
      // EVERY exit path. No-op on the normal path (the close above already
      // settled it and nulled the pointer).
      let state: "done" | "failed" = "done";
      let trailing: string | undefined;
      try {
        state = failurePostText(event.messages ?? [], userStoppedRun)
          ? "failed"
          : "done";
        trailing = runUsageLine(runStats) ?? undefined;
      } catch {}
      try {
        settleWorkingFrame({
          state,
          trailing,
          chFallback: lastActiveChannel,
        });
      } catch (e) {
        console.error(
          "[channel] agent_end frame settle failed:",
          sanitizeUnknownValue(e),
        );
      }
    }
  });

  // ─── Handoff token gate: settled re-check (issue #85) ─────────────────
  // pi clears _isAgentRunActive (isIdle → true) only in _emitAgentSettled,
  // which runs AFTER the awaited agent_end handler resolves. On any run
  // whose handler awaits Discord I/O (live-text delete, re-wake) the
  // agent_end 0ms timer fires while isIdle() is still false → the gate
  // bails and is never re-run. pi emits agent_settled exactly once per
  // completed run, after every continuation (a re-wake started from
  // agent_end settles inside the same _runAgentPrompt), so at this point
  // isIdle() is reliably true — except while a re-wake run is active, in
  // which case the gate skips and that run's own agent_settled re-checks.
  // The agent_end call above stays as a belt-and-braces first shot; the
  // guards (isCompacting, fresh window) make a double-fire safe.
  pi.on("agent_settled", (_event, ctx) => {
    autoCompactByToken(pi, ctx);
  });
}

// ─── Channel context ──────────────────────────────────────────────────────
// Prepended to every inbound message so the LLM knows where the message
// came from and where its reply will be delivered — it can then adapt
// format, length, and tone to the channel.

const CHANNEL_FORMAT_HINTS: Record<ChannelConfig["type"], string> = {
  discord:
    "Discord message: markdown supported (bold, bullets, code blocks); keep it compact for chat reading.",
};

export function channelTitle(
  ch: ChannelConfig | undefined,
  msg: ChannelMessage,
): string {
  const type = ch?.type || msg.channelType;
  const name = ch?.name || msg.channelName || msg.channelId;
  return `${type}/${name}`;
}

// ─── Reply message context ────────────────────────────────────────────────
// When the user replies to a message, its author + text are injected as a
// <replied-message> block so the LLM knows what is being pointed at.
// Ported from kimaki's reply-context handling.

function escapePromptAttr(value: string): string {
  return value.replace(/"/g, "'").replace(/\s+/g, " ");
}

function escapePromptText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Build the <replied-message> LLM block, or "" when there is no reply ref. Exported for tests. */
export function buildRepliedMessageBlock(rm?: {
  author: string;
  text: string;
}): string {
  if (!rm?.text) return "";
  const author = rm.author ? ` author="${escapePromptAttr(rm.author)}"` : "";
  return `This message was a reply to message\n\n<replied-message${author}>\n${escapePromptText(rm.text)}\n</replied-message>`;
}

/** #177: true when the inbound is a machine wake (pi-bg callback,
 *  dead-letter alert, ETL alert). Machine wakes are never more urgent than
 *  the in-flight turn: they ride the re-wake queue and deliver at agent_end,
 *  and arm no mid-run interrupt (queue-only, #177).
 *
 *  Classifies via isBgCallbackBody: the 2026-10-21 de-prefix shape
 *  (content="", body = serialized embed starting `Author: pi-bg`) and the
 *  legacy "[bg:" content prefix (one release: in-flight history, dead
 *  letters, not-yet-restyled cross-repo producers). */
export function isBgInbound(msg: ChannelMessage): boolean {
  return isBgCallbackBody(msg.body.trimStart());
}

export function buildChannelContext(
  ch: ChannelConfig | undefined,
  msg: ChannelMessage,
  opts?: { btw?: boolean },
): string {
  const type = ch?.type || msg.channelType;
  const name = (ch?.name || msg.channelName || msg.channelId).replace(
    /"/g,
    "'",
  );
  const from = (msg.isRoom ? msg.roomName || msg.from : msg.from).replace(
    /"/g,
    "'",
  );
  const attrs = [`type="${type}"`, `name="${name}"`, `from="${from}"`];
  if (msg.isRoom) {
    attrs.push(`sender="${(msg.fromId || msg.from).replace(/"/g, "'")}"`);
    attrs.push(`room="true"`);
  }
  if (msg.messageId) attrs.push(`msgId="${msg.messageId}"`);

  const lines = [
    `<channel-ctx ${attrs.join(" ")}>`,
    `This message arrived via ${type}${msg.isRoom ? " group chat (your reply is visible to all members)" : ""}; your reply will be delivered back there automatically.`,
    CHANNEL_FORMAT_HINTS[type],
    "Reply in the same language the user wrote in (e.g. a Chinese message gets a Chinese reply).",
    "Stay in lane: in a shared channel, a message may be aimed at ANOTHER agent or person. You are NOT required to reply when: (a) they are mid-conversation and not addressed to you, (b) you are @-mentioned only to observe, or (c) the message is a reply to someone else's turn. Only speak when explicitly addressed to you, when you have something directly relevant, or when asked. No reply is a valid reply.",
    "Attribute precisely: when a <replied-message> block is present, the author of that block is the one who SPOKE the quoted words. Do not restate their statement as if it were the current sender's, and do not attribute their words to anyone else. Name the actual speaker when you reference what they said.",
    "To reply to a specific person's message, prefix your reply with <reply-to:MSGID> using their id from the [msgId=...] markers in this message (each part of a rapid-fire burst carries its own marker, including parts outside this block) or from the msgId= attribute of this block; the reply threads to that message and the tag is stripped before sending.",
  ];
  if (ch?.instructions) lines.push(ch.instructions);
  if (opts?.btw) lines.push(BTW_HINT);
  lines.push("</channel-ctx>");
  const block = lines.join("\n");
  // Todo board re-injection: a non-empty board is appended after the
  // channel-ctx block so the model sees it on EVERY run (survives
  // compaction and restarts).
  if (!ch) return block;
  const board = loadBoard(ch.id);
  const todoBlock =
    board && board.todos.length > 0 ? todoBoardContextBlock(board.todos) : "";
  return todoBlock ? `${block}\n\n${todoBlock}` : block;
}

// ─── Live marker (issue #191 M2: agent liveness) ─────────────────────────
// Touch /var/tmp/jarate-live/<uid> (0644) once per poll cycle. The marker
// is the agent-liveness input: the watchdog's fleet liveness sweep (gone
// with #280/3a) consumed it; liveness paging is now on the hall-monitor
// control plane (hm#59). The class it exists for: a pi.service death with
// NO in-flight tickets produced zero ticket-class events (2026-10-04 monky
// OOM incident, 33 min dark). /var/tmp not /tmp: the pre-boot marker must
// survive a reboot so a reboot classifies as BOOT-GAP, not a fresh-boot
// alert. The dir is sticky world-writable (like /tmp): each agent user
// writes its own <uid> file, the orchestrator's sweep reads everyone's.
// Best-effort: a marker failure must never break the bridge poll loop.
export const LIVE_MARKER_DIR =
  process.env.JARATE_LIVE_DIR ?? "/var/tmp/jarate-live";

export function touchLiveMarker(dir: string = LIVE_MARKER_DIR): string | null {
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid === null) return null;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o1777 });
    } catch {
      // exists or not creatable — the file write below decides
    }
    try {
      // mkdir's mode is umask-filtered; the sticky bit is required so
      // the orchestrator's sweep (a different user) can read the markers
      fs.chmodSync(dir, 0o1777);
    } catch {
      // not the dir owner: fine if it is already world-writable
    }
    const f = path.join(dir, String(uid));
    fs.writeFileSync(f, `${Date.now()}\n`);
    try {
      fs.chmodSync(f, 0o644); // world-readable for the sweep
    } catch {
      // not the file owner (uid squat); mtime still advances if writable
    }
    return f;
  } catch {
    return null;
  }
}

// ─── Handoff proactive gate: token-% auto-compact (design v2, PR3) ────────
// Registered on agent_end (first shot) and agent_settled (issue #85: the
// reliable shot — pi clears the run-active flag only after the awaited
// agent_end handler resolves, so on runs that await Discord I/O the
// agent_end timer fires while isIdle() is still false and bails). After
// EVERY settled turn, if the context is at/over the handoff threshold
// (the same number shouldHandoff's "threshold" reason uses —
// settings.threshold, default 0.8) and nothing is in flight, start the
// SAME compact /compact runs (startCompact). The handover doc is written
// by the session_before_compact path; the size gate
// (handoffRestartForSize on session_compact) then decides the restart as
// before. Composes with the size gate: token gate = "compact when big in
// tokens", size gate = "restart when the file is big". Covers the case
// the size gate misses: high token % + small session file (many small
// messages). Deferred one macrotask (same model as handoffRestartForSize):
// a re-wake run may start before the timer fires; the idle check skips it
// and that run's own agent_settled re-checks. The guards (isCompacting,
// fresh window) make a double-fire from both events safe.
export function autoCompactByToken(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  setTimeout(() => {
    try {
      // The gate is async: a throw inside REJECTS the promise, it does
      // not hit this try/catch (sync throws only). A stale ctx (session
      // replaced after the timer armed — pi -p always: the session ends
      // at run end) rejects on the first ctx.cwd read; unhandled, that
      // rejection kills `pi -p` at exit (2026-10-19 crash).
      maybeAutoCompactByToken(pi, ctx).catch((e) => {
        console.error(
          "[handoff] auto-compact gate failed:",
          sanitizeUnknownValue(e),
        );
      });
    } catch (e) {
      console.error(
        "[handoff] auto-compact gate failed:",
        sanitizeUnknownValue(e),
      );
    }
  }, 0);
}

/** The actual token-% gate + compact trigger (exported for direct tests).
 *  Failure-tolerant: any error logs and returns — never crashes the
 *  settle path. */
export async function maybeAutoCompactByToken(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  // The settle timer may fire after the session was replaced or reloaded:
  // the ctx.cwd getter throws "stale" then. Guard the first read — a
  // stale ctx logs one line and skips the gate (the replacement session's
  // own settle re-runs it).
  let cwd: string;
  try {
    cwd = ctx.cwd;
  } catch (e) {
    console.error(
      "[handoff] auto-compact gate: stale ctx, skipping:",
      sanitizeUnknownValue(e),
    );
    return;
  }
  const settings = resolveHandoffSettings(cwd);
  if (!settings.enabled) return;
  const ch = lastActiveChannel ?? getDefaultChannel(loadChannelConfig(cwd));
  if (ch?.type !== "discord") return;
  // A compact/restart op window is open for this channel: let it settle —
  // its own settle re-runs this gate.
  if (isCompacting(ch.id)) return;
  // Handover doc build in flight, or a doc was just written (the fresh
  // window covers the just-seeded session): don't re-compact.
  if (isHandoffInFlight()) return;
  if (isHandoffFreshWindow(settings.storeDir)) return;
  // A re-wake run started after agent_end (still active at agent_settled):
  // let it settle — its own agent_settled re-checks.
  if (!ctx.isIdle()) return;
  let percent: number | null = null;
  try {
    percent = ctx.getContextUsage?.()?.percent ?? null;
  } catch {
    percent = null;
  }
  if (percent == null || !Number.isFinite(percent)) return;
  if (percent < settings.threshold * 100) return;
  console.log(
    `[handoff] auto-compact: ctx ${percent}% >= ${settings.threshold * 100}%`,
  );
  // Same path /compact uses: ctx.compact + the op window (beginCompacting)
  // inside startCompact. postPlaceholder=true = the text-command path
  // (ticking placeholder, settle-in-place report).
  const err = startCompact(pi, { ch }, ctx, true);
  if (err !== null) console.error(`[handoff] auto-compact failed: ${err}`);
}

// ─── Inbound handler ──────────────────────────────────────────────────────
// ─── Sleep wake delivery ────────────────────────────────────────────────
// Claim (markClaimed) BEFORE injection so a crash between claim and
// sendToPi re-delivers once the claim goes stale (at-least-once, kimaki's
// session-sleep invariant). After injection SUCCEEDS the wake is completed
// (removed from the file) — otherwise the stale-claim path would re-deliver
// it every CLAIM_TTL_MS, forever. Returns the number of wakes delivered.
export function deliverDueWakes(
  pi: ExtensionAPI,
  channels: ChannelConfig[],
  home?: string,
  now = Date.now(),
): number {
  const enabledIds = new Set(
    channels.filter((c) => c.enabled && c.type === "discord").map((c) => c.id),
  );
  const due = [...enabledIds].flatMap((id) => dueWakes(id, now, home));
  if (due.length === 0) return 0;
  for (const w of due) markClaimed(w.id, now, home);
  for (const w of due) {
    const ch = getChannel(channels, w.channelId);
    const name = ch?.name || w.channelName || w.channelId;
    const text = formatWakePrompt(w, now);
    console.log(`[sleep] delivering wake ${w.id} for ${name}`);
    const ok = sendToPi(pi, w.channelId, text, `discord/${name}`, text);
    if (ok) completeWake(w.id, home);
    else
      console.error(
        `[sleep] injection failed for wake ${w.id} — claim stays, retried after TTL`,
      );
  }
  return due.length;
}

// ─── Scheduled task delivery ──────────────────────────────────────────────
// Same at-least-once discipline as sleep wakes: claim before injection,
// complete AFTER injection succeeds (one-shot: removed; cron: advance to
// the next slot). A crash between claim and completion re-delivers once
// the claim goes stale (> CLAIM_TTL_MS). Returns the number delivered.
export function deliverDueTasks(
  pi: ExtensionAPI,
  channels: ChannelConfig[],
  home?: string,
  now = Date.now(),
): number {
  const enabledIds = new Set(
    channels.filter((c) => c.enabled && c.type === "discord").map((c) => c.id),
  );
  const due = [...enabledIds].flatMap((id) => dueTasks(id, now, home));
  if (due.length === 0) return 0;
  for (const t of due) markTaskClaimed(t.id, now, home);
  for (const t of due) {
    const ch = getChannel(channels, t.channelId);
    const name = ch?.name || t.channelName || t.channelId;
    const text = formatTaskPrompt(t);
    console.log(`[task] delivering ${t.id} for ${name}`);
    const ok = sendToPi(pi, t.channelId, text, `discord/${name}`, text);
    if (ok) completeTask(t.id, now, home);
    else
      console.error(
        `[task] injection failed for ${t.id} — claim stays, retried after TTL`,
      );
  }
  return due.length;
}

// (named export for test harness; pi itself only uses the default factory)

export async function handleInbound(
  pi: ExtensionAPI,
  msg: ChannelMessage,
  ctx: ExtensionContext,
  forceDirect = false,
) {
  const ch = getChannel(loadChannelConfig(ctx.cwd), msg.channelId);
  // Channel removed/renamed in settings while running: drop the message
  // instead of dereferencing `ch` further down.
  if (!ch) return;
  lastActiveChannel = ch;
  if (msg.messageId) {
    lastInboundIds.set(ch.id, msg.messageId);
  }
  resetFinalRepeats(ch.id); // a new inbound user message restarts the repetition counter

  // Update status to show active channel
  ctx.ui.setStatus("Channel", channelTitle(ch, msg));

  const rawBody = msg.body.trim();
  const title = channelTitle(ch, msg);

  // ── Channel commands ─────────────────────────────────────────────────
  // stop / /stop — anyone. /help /btw — anyone.
  // /status /reset /verbose — owner only. Commands consume the message.
  const replyCmd = (text: string) => {
    if (!ch) return;
    // Command replies ship fenced (STYLE.md 2.7): the guard fences bare
    // machine-state lines; already-fenced replies pass through unchanged.
    sendDiscordMessage(ch, styleGuard(text), {
      replyToMessageId: msg.messageId,
    }).catch(() => {});
  };
  // Commands reply directly instead of running a turn — tell the poller
  // not to ack these messages with 👀 (synchronous, no race).
  const noAck = () => {
    if (ch?.type === "discord" && msg.messageId)
      suppressAutoReact(msg.messageId);
  };

  const cmd = matchCommand(rawBody);
  if (cmd) {
    // While compacting: /status, /jobs, /sleep stay read-only, /stop
    // clears the window and stops, /compact reports it, /reset and
    // /restart refuse (window already open). Everything else
    // falls through and is queued like a plain message — executed on the
    // re-wake, after the compaction settles.
    const allowedWhileCompacting =
      cmd.name === "status" ||
      cmd.name === "usage" ||
      cmd.name === "context" ||
      cmd.name === "jobs" ||
      cmd.name === "diff" ||
      cmd.name === "sleep" ||
      cmd.name === "tasks" ||
      cmd.name === "stop" ||
      cmd.name === "hold" ||
      cmd.name === "compact" ||
      cmd.name === "handover" ||
      cmd.name === "reset" ||
      cmd.name === "restart";
    if (!isCompacting(ch.id) || allowedWhileCompacting) {
      const r = await runChannelCommand(
        pi,
        ctx,
        ch,
        cmd.name,
        cmd.arg,
        msg.fromId,
        false,
      );
      if (r.btw) {
        noAck();
        return;
      }
      if (r.consumed) {
        // The command posted its own reply (e.g. the ticking compact
        // placeholder) — no ack, no fall-through to a run.
        noAck();
        return;
      }
      if (r.immediate !== undefined) {
        noAck();
        replyCmd(r.immediate);
        return;
      }
    }
  }

  // Kimaki parity: a real inbound user message means the agent is awake
  // again — cancel this channel's PENDING wakes (claimed ones are
  // mid-delivery and left alone). /btw and commands returned above and
  // never reach this line.
  try {
    const cancelled = cancelPendingWakes(ch.id);
    if (cancelled > 0)
      console.log(
        `[sleep] ${cancelled} pending wake(s) cancelled by inbound message in ${ch.name || ch.id}`,
      );
  } catch (e) {
    console.error("[sleep] cancel-on-inbound failed:", sanitizeUnknownValue(e));
  }

  // ── pi-bg worker intake: a callback body carrying "TODO: " lines adds
  //    new pending items to this channel's board (deduped on content,
  //    existing items untouched) and re-renders the board message. The
  //    callback still starts its normal run below — intake only files
  //    follow-ups, it never swallows the wake.
  if (isBgCallbackBody(rawBody)) {
    const lines = extractTodoLines(rawBody);
    if (lines.length > 0) {
      try {
        const board = loadBoard(ch.id) ?? {
          channelId: ch.id,
          todos: [],
          updatedAt: "",
        };
        board.todos = mergeTodoLines(board.todos, lines);
        board.updatedAt = new Date().toISOString();
        saveBoard(board);
        await syncTodoBoard(ch, board);
      } catch (e) {
        console.error(
          `[todos] worker intake failed: ${sanitizeUnknownValue(e)}`,
        );
      }
    }
  }

  // ── ! shell passthrough (owner only) ─────────────────────────────────
  const bang = rawBody.match(/^!\s*([\s\S]+)$/);
  if (bang && ch) {
    noAck();
    if (!isOwnerUser(ch, msg.fromId)) {
      replyCmd(fence("[!] ! shell is owner-only"));
      return;
    }
    const shellCmd = bang[1].trim();
    sendDiscordTyping(ch).catch(() => {});
    const r = await runShellPassthrough(shellCmd, ctx.cwd);
    const truncated = r.out.length >= 20_000;
    const shown = r.out.length > 4000 ? r.out.slice(0, 4000) : r.out;
    const status = r.timedOut
      ? "timeout 60s"
      : r.code === 0
        ? r.out
          ? ""
          : "exit 0"
        : `exit ${r.code}`;
    const tail = [
      shown ? (truncated ? `… (truncated)` : "") : "(no output)",
      status,
    ]
      .filter(Boolean)
      .join(" · ");
    replyCmd(r.out ? `${wrapFence(shown)}\n${tail}` : tail);
    return;
  }

  // ── Side-question suffix: "fix the bug. btw" → brief-answer flag ─────
  const { prompt: body, forceBtw } = extractBtwSuffix(rawBody);

  // Channel ctx (+ btw hint) — LLM-only, not shown in the TUI.
  const channelCtx = buildChannelContext(ch, msg, { btw: forceBtw });
  const repliedBlock = buildRepliedMessageBlock(msg.repliedMessage);
  const ctxBlock = [channelCtx, repliedBlock].filter(Boolean).join("\n\n");
  const withCtx = (text: string) => `${ctxBlock}\n\n${text}`;

  // A run is in flight (streaming or has pending messages). Mid-turn inbounds
  // are queued for a guaranteed re-wake at agent_end instead of steered into
  // the in-flight run, which pi may swallow if the run ends first. forceDirect
  // (the re-wake path) bypasses the gate so the message is never re-queued.
  const runActive = forceDirect
    ? false
    : !ctx.isIdle() || ctx.hasPendingMessages?.() || isCompacting(ch.id);
  // #39: while held, EVERY plain message (attachments included) buffers in
  // the re-wake queue without starting a run — even while idle. The buffer
  // drains on /hold off. Held messages never arm the mid-run interrupt:
  // they wait their turn (an interrupt would jump the buffer line).
  const held = isHeld(ch);
  // Returns true (caller should `return`) when the inbound was queued for a
  // re-wake. Ownership is unambiguous: a message is either sent to pi now or
  // queued for a re-wake — never both. `armInterrupt` false = ". queue"-
  // suffixed: wait the line, no mid-run interrupt.
  const gateForRewake = (
    text: string,
    gateTitle: string,
    display: string,
    armInterrupt = true,
  ): boolean => {
    if (!held && !runActive) return false;
    // While compacting the message waits the line WITHOUT arming the
    // mid-run interrupt (an interrupt aborts the compaction). It drains
    // when the compaction settles (drainQueuedAfterCompact) or at the
    // next agent_end.
    // Compaction is session-wide (one shared pi session): an interrupt
    // from ANY channel calls ctx.abort(), which aborts the in-flight
    // compaction (agent-session.js abort() → abortCompaction). So suppress
    // arming for every channel while ANY window is open, not just the
    // compacting one — a ch2 interrupt would otherwise kill ch1's compact.
    // #39: held messages wait their turn, interrupt or no interrupt.
    const arm = armInterrupt && !held && compactingChannels.size === 0;
    const pos = queueMidTurnInbound(ch.id, msg, text, gateTitle, display, arm);
    // Ack = one line with the position; suppress the 👀 so the line IS the
    // ack. The ack id is tracked for edit/delete cleanup + renumbering.
    noAck();
    // #231 P2: machine wakes queue SILENTLY — no "[queued] N in
    // line" post. No human waits in a machine-wake line, so the line is
    // pure channel noise. The entry still queues (and re-wakes) exactly
    // as today; human inbounds keep the post (the line IS their ack).
    if (isBgInbound(msg)) return true;
    // Verbose 0: queue acks + interrupt notifications are SILENT (Andryo
    // 2026-10-20) - no "[queued] N in line" line, and the mid-run interrupt
    // ticks only edit the ack message, so it stays silent too. The entry
    // still queues (and re-wakes) exactly as today; verbose 1+ posts it.
    if (verboseLevel(ch) === 0) return true;
    sendDiscordMessage(ch, `[queued] ${pos} in line`, {
      replyToMessageId: msg.messageId,
    })
      .then((res) => {
        if (res.success && res.messageId) {
          queuedAcks.set(msg.messageId, {
            ackId: res.messageId,
            fromId: msg.fromId,
            pos,
          });
          // #194 interaction: mirror the ack id into the survival
          // file — a restart before delivery restores it into the
          // fresh queuedAcks map (drainRewakeSurvival) so the re-wake
          // drain deletes the line exactly once. No-op when the entry
          // is already committed/dropped from the file.
          rewakeSetPendingAck(
            runtimeStateDir,
            ch.id,
            msg.messageId,
            res.messageId,
          );
          persistLivePlaceholders(); // #84: the ack line is live
        }
      })
      .catch(() => {});
    return true;
  };

  // ── Handle attachments ──────────────────────────────────────────────
  // Create a batch folder per incoming message batch and download the
  // files NOW (eagerly), so they are on disk before the LLM sees the
  // folder reference.
  if (msg.attachments.length > 0) {
    const wsRoot = ctx.cwd;
    const ts = Date.now();
    const batchFolderRel = `.tmp/attachments/${ts}`;
    const batchFolderAbs = path.join(wsRoot, batchFolderRel);
    fs.mkdirSync(batchFolderAbs, { recursive: true });

    // Eager download; record why a file was not saved (skipped/failed)
    // so the LLM is not pointed at a missing file. Also record where a
    // file WAS saved so voice notes can be transcribed after download.
    const notes = new Map<string, string>();
    const savedPaths = new Map<string, string>();
    if (ch?.type === "discord") {
      const token = getDiscordToken(ch.id) || ch.botToken;
      if (token) {
        await Promise.all(
          msg.attachments.map(async (att) => {
            try {
              const content = await loadDiscordAttachment(
                token,
                att,
                batchFolderAbs,
              );
              if (content) {
                savedPaths.set(att.id, content.path);
              } else {
                const reason =
                  att.size > MAX_ATTACHMENT_BYTES
                    ? `skipped, larger than ${formatBytes(MAX_ATTACHMENT_BYTES)} cap`
                    : "download failed";
                notes.set(att.id, reason);
                console.error(
                  `[channel] attachment not saved: ${sanitizeSensitiveText(att.filename)} (${att.contentType}, ${formatBytes(att.size)}) — ${reason}`,
                );
              }
            } catch (e) {
              notes.set(att.id, "download failed");
              console.error(
                `[channel] attachment download error: ${sanitizeSensitiveText(String(e))}`,
              );
            }
          }),
        );
      }
    }
    const fileLine = (a: AttachmentRef) => {
      const note = notes.get(a.id);
      return `  ${a.filename} (${a.contentType}, ${formatBytes(a.size)})${note ? ` — ${note}` : ""}`;
    };

    // #42: transcribe voice notes so the agent sees words, not a marker.
    // Channel opt-out: transcribe: false. A null result (failure/timeout,
    // missing file, missing binary) keeps the [voice note: …] marker line.
    const transcripts = new Map<string, string>();
    if (ch.transcribe !== false) {
      for (const att of msg.attachments) {
        if (!isVoiceAudio(att)) continue;
        const p = savedPaths.get(att.id);
        if (!p) continue;
        try {
          const text = await transcribeVoice(p, { mime: att.contentType });
          if (text) transcripts.set(att.id, text);
        } catch (e) {
          console.error(
            `[channel] transcribe failed: ${sanitizeSensitiveText(String(e))}`,
          );
        }
      }
    }

    const voiceLines = msg.attachments
      .filter((a) => isVoiceAttachment(a))
      .map((a) => transcripts.get(a.id) ?? voiceNoteText(a));

    // No text and no voice note
    let prompt = body;
    if (!body && voiceLines.length === 0) {
      if (ch?.bufferFileOnly !== false) {
        // bufferFileOnly: true — buffer file info, wait for follow-up
        // text. Batches auto-flush as a file-only turn at 10 minutes
        // (flushExpiredPendingBatches ticker) so they never sit forever. (#24)
        const batches = prunePendingBatches(msg.channelId);
        batches.push({
          folder: batchFolderRel,
          files: msg.attachments,
          addedAt: ts,
          notes: Object.fromEntries(notes),
        });
        pendingAttachments.set(msg.channelId, batches);
        // One visible ack line (same noAck pattern as the [queued] acks):
        // the user must know the file was received and is waiting on text.
        noAck();
        const n = msg.attachments.length;
        // Bare one-liner, no [ok]/[!] tag (machine output only, Andryo
        // 2026-10-20) - the summary is the later todo board post.
        sendDiscordMessage(
          ch,
          `[buffered] ${n} ${n === 1 ? "file" : "files"} - send text to attach them`,
          { replyToMessageId: msg.messageId },
        ).catch(() => {});
        return;
      }
      // Default (bufferFileOnly unset/false) — fire a turn with a
      // synthesized prompt. (#24)
      prompt = fileOnlyPrompt(msg.attachments);
    }

    // Has text, voice note, or synthesized prompt — include this batch
    // folder reference directly, plus any batches still pending (files
    // sent earlier without text).
    const fileLines = msg.attachments.map(fileLine).join("\n");
    const attParts = [
      `<user-action-ctx>User attached file(s) in ${batchFolderRel}/\n${fileLines}</user-action-ctx>`,
    ];
    const prior = prunePendingBatches(msg.channelId);
    if (prior.length > 0) {
      // Batch is only consumed (deleted) below, when the message is actually
      // sent — if this inbound is gated for a re-wake, the pending batch must
      // survive so the re-wake pass re-applies the file context.
      for (const b of prior) {
        const lines = b.files
          .map((a) => {
            const note = b.notes?.[a.id];
            return `  ${a.filename} (${a.contentType}, ${formatBytes(a.size)})${note ? ` — ${note}` : ""}`;
          })
          .join("\n");
        attParts.push(
          `<user-action-ctx>User attached file(s) in ${b.folder}/\n${lines}</user-action-ctx>`,
        );
      }
    }
    const fwd = [attParts.join("\n\n"), ...voiceLines, prompt]
      .filter(Boolean)
      .join("\n\n");
    const dispFiles = [...prior.flatMap((b) => b.files), ...msg.attachments];
    const disp =
      [attachmentSummary(dispFiles), ...voiceLines, prompt]
        .filter(Boolean)
        .join("\n\n") || "(empty)";
    const fwdText = withCtx(fwd);
    if (gateForRewake(fwdText, title, disp)) return;
    if (prior.length > 0) pendingAttachments.delete(msg.channelId);
    sendToPi(pi, ch.id, fwdText, title, disp, msg.messageId);
    return;
  }

  // ── No attachments — check for buffered batches ─────────────────────
  const batches = prunePendingBatches(msg.channelId);

  if (batches.length > 0) {
    // Batch is only consumed (deleted) below, when the message is actually
    // sent — same re-wake retention as the attachment branch above.
    const allFiles = batches.flatMap((b) => b.files);
    const allVoiceLines = allFiles
      .filter((a) => isVoiceAttachment(a))
      .map((a) => voiceNoteText(a));
    const attParts = batches.map((b) => {
      const files = b.files
        .map((a) => {
          const note = b.notes?.[a.id];
          return `  ${a.filename} (${a.contentType}, ${formatBytes(a.size)})${note ? ` — ${note}` : ""}`;
        })
        .join("\n");
      return `<user-action-ctx>User attached file(s) in ${b.folder}/\n${files}</user-action-ctx>`;
    });
    const fwd = [attParts.join("\n\n"), ...allVoiceLines, body]
      .filter(Boolean)
      .join("\n\n");
    const disp =
      [attachmentSummary(allFiles), ...allVoiceLines, body]
        .filter(Boolean)
        .join("\n\n") || "(empty)";
    const fwdText = withCtx(fwd);
    if (gateForRewake(fwdText, title, disp)) return;
    pendingAttachments.delete(msg.channelId);
    sendToPi(pi, ch.id, fwdText, title, disp, msg.messageId);
    return;
  }

  // ── Plain text message — forward with channel context ───────────────
  // While a run is in flight, queue for a guaranteed re-wake at agent_end
  // (one message = one queued run) instead of steering into the in-flight
  // run, which pi may swallow if the run ends before a model step consumes it.
  // The queued message is also armed with a mid-run interrupt: if the step
  // is still in flight after the timeout, the step is aborted and, once the
  // session settles, the message starts a fresh run (runMidRunInterrupt).
  // A ". queue" suffix opts OUT of the interrupt: the message waits its
  // turn in the re-wake queue (kimaki parity: interrupt = jump the queue,
  // ". queue" = wait your turn).
  const { prompt: queuedBody, forceQueue } = extractQueueSuffix(body);
  const plainText = withCtx(queuedBody || "(empty)");
  if (gateForRewake(plainText, title, queuedBody || "(empty)", !forceQueue))
    return;

  sendToPi(pi, ch.id, plainText, title, queuedBody || "(empty)", msg.messageId);
}

// ─── Send to pi session ──────────────────────────────────────────────────

export function sendToPi(
  pi: ExtensionAPI,
  channelId: string,
  text: string,
  title: string,
  displayBody: string,
  messageId?: string,
  messageIds?: string[],
): boolean {
  const ids = messageIds ?? (messageId ? [messageId] : []);
  if (ids.length > 0) {
    const prev = runInboundIds.get(channelId) ?? [];
    runInboundIds.set(channelId, [...new Set([...prev, ...ids])]);
  }
  interruptCancelled.delete(channelId); // a fresh send opens a fresh run
  try {
    pi.sendMessage(
      {
        customType: CHANNEL_MSG_TYPE,
        content: text, // LLM context: full channel-ctx + body
        display: true,
        // TUI: title + body only; messageId/messageIds drive reply threading
        details: {
          title,
          body: displayBody,
          ...(messageId ? { messageId } : {}),
          ...(ids.length > 0 ? { messageIds: ids } : {}),
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    // #180: pi accepted the message — the delivery is committed. Prune
    // the survived copy (if this was a queued re-wake) and record the
    // id in the delivered set (the startup history-scan dedupe). A
    // sendMessage throw returns false BEFORE this line: the file keeps
    // the entry, the next restart re-delivers (at-least-once).
    if (messageId) {
      rewakeCommitDelivered(runtimeStateDir, channelId, messageId);
      // #186 (F1): the commit prunes the FILE copy; prune the drained
      // in-memory copy too (same id still queued by the survival drain
      // or a replay re-queue) — otherwise the agent_end re-wake pops
      // it and delivers the same inbound twice.
      dropQueuedInbound(channelId, messageId);
    }
  } catch (e) {
    console.error("[channel] sendMessage failed:", sanitizeUnknownValue(e));
    return false;
  }
  return true;
}

// ─── Utility ─────────────────────────────────────────────────────────────

// One-line-per-file display summary (no XML tags) shown in the TUI body.
function attachmentSummary(files: AttachmentRef[]): string {
  return files
    .map((a) => `- ${a.filename} (${formatBytes(a.size)})`)
    .join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ─── State for web package ────────────────────────────────────────────────

function writeChannelState(wsRoot: string, chs: ChannelConfig[]): void {
  const stateDir = path.join(wsRoot, ".tmp", "web", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const status: Record<string, any> = {
    count: chs.length,
    connected: chs
      .filter((c) => c.enabled)
      .map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
      })),
  };
  fs.writeFileSync(
    path.join(stateDir, "channel.json"),
    JSON.stringify(
      {
        pkg: "channel",
        ts: new Date().toISOString(),
        status,
        settings: {
          channels: chs.map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            enabled: c.enabled,
          })),
        },
      },
      null,
      2,
    ),
  );
}
