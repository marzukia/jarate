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

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BTW_HINT, extractBtwSuffix } from "./btw";

import {
  connectDiscord,
  connectDiscordPresence,
  type DiscordCallbacks,
  deferInteraction,
  deleteDiscordMessage,
  disconnectDiscord,
  editDiscordMessage,
  editInteractionMessage,
  getDiscordChannelId,
  getDiscordToken,
  loadDiscordAttachment,
  MAX_ATTACHMENT_BYTES,
  registerDiscordCommands,
  respondToInteraction,
  sendDiscordMessage,
  sendDiscordMessageWithFiles,
  sendDiscordTyping,
  sendFilesToDiscord,
  setDiscordInteractionHandler,
  setDiscordPresenceActivity,
  stopDiscordPresence,
  suppressAutoReact,
  unreactMessage,
} from "./discord";

import { mdToDiscord } from "./format";
import { memoryToc } from "./memory";
import { sanitizeSensitiveText, sanitizeUnknownValue } from "./sanitize";
import {
  extractTodoLines,
  isBgCallbackBody,
  listBoards,
  loadBoard,
  mergeTodoLines,
  openCount,
  renderBoard,
  sanitizeTodos,
  saveBoard,
  type TodoBoard,
  todoBoardContextBlock,
  todoLine,
} from "./todos";
import {
  type AttachmentRef,
  type ChannelConfig,
  type ChannelMessage,
  getChannel,
  getDefaultChannel,
  loadChannelConfig,
} from "./types";
import { isVoiceAttachment, voiceNoteText } from "./voice";

let lastActiveChannel: ChannelConfig | null = null;
let sessionStartTs = 0;
let agentBusy = false;
// /compact queued while the session is busy (run in progress, or a
// compaction already in flight). pi's compact() starts with await
// abort(), so a mid-run compact would silently kill the in-flight
// reply; we defer to agent_end instead. One slot: a later /compact
// replaces the earlier. Flushed at agent_end, or when the blocking
// compaction settles (session_compact / session_compact_failed — an
// in-flight compaction never triggers agent_end on its own).
let pendingCompact: { ch: ChannelConfig; instructions?: string } | null = null;
const verboseOverride = new Map<string, boolean>();
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

/** Queue a mid-turn inbound for a re-wake. Returns the new queue depth. */
export function queueMidTurnInbound(
  channelId: string,
  msg: ChannelMessage,
  text?: string,
  title?: string,
  display?: string,
): number {
  let q = midTurnQueues.get(channelId);
  if (!q) { q = []; midTurnQueues.set(channelId, q); }
  q.push({ msg, queuedAt: Date.now(), text, title, display });
  console.log(`[channel] queued mid-turn inbound, will re-wake (${q.length} queued)`);
  armInterruptTimer(channelId, msg.messageId);
  return q.length;
}

/** Pop the globally oldest queued inbound across all channels (FIFO). */
export function popOldestQueuedInbound(): {
  channelId: string;
  msg: ChannelMessage;
} | null {
  let oldest: {
    channelId: string;
    msg: ChannelMessage;
    queuedAt: number;
  } | null = null;
  for (const [channelId, q] of midTurnQueues) {
    const head = q[0];
    if (!head) continue;
    if (!oldest || head.queuedAt < oldest.queuedAt)
      oldest = { channelId, msg: head.msg, queuedAt: head.queuedAt };
  }
  if (!oldest) return null;
  const q = midTurnQueues.get(oldest.channelId)!;
  if (q[0].queuedAt === oldest.queuedAt) q.shift();
  if (q.length === 0) midTurnQueues.delete(oldest.channelId);
  return { channelId: oldest.channelId, msg: oldest.msg };
}

/** Drop all queued inbounds for a channel (/stop). Returns the count dropped. */
export function clearQueuedInbound(channelId: string): number {
  const q = midTurnQueues.get(channelId);
  if (!q) return 0;
  const n = q.length;
  midTurnQueues.delete(channelId);
  return n;
}

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
const DEFAULT_INTERRUPT_STEP_TIMEOUT_MS = 3000;

/** Interrupt step timeout in ms (env PISCORD_INTERRUPT_STEP_TIMEOUT_MS, default 3000). */
export function interruptStepTimeoutMs(): number {
  const raw = process.env.PISCORD_INTERRUPT_STEP_TIMEOUT_MS;
  if (!raw) return DEFAULT_INTERRUPT_STEP_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERRUPT_STEP_TIMEOUT_MS;
}

interface PendingInterrupt { messageId: string; at: number; timer: ReturnType<typeof setTimeout>; }
export const pendingInterrupts = new Map<string, PendingInterrupt[]>();
const interruptingChannels = new Set<string>();
let interruptHandler: ((channelId: string, messageId: string) => void) | null = null;
let interruptCtx: ExtensionContext | null = null;

/** Set by the extension factory: fires when an armed interrupt timer elapses. May be async (fire-and-forget). */
export function setInterruptHandler(fn: ((channelId: string, messageId: string) => void) | null): void {
  interruptHandler = fn;
}

/** The pi context for out-of-event aborts (session_start / shutdown). Exported for tests. */
export function setInterruptCtx(ctx: ExtensionContext | null): void {
  interruptCtx = ctx;
}

/**
 * Arm (or re-arm) an interrupt timer for a queued mid-turn message.
 * Re-arming the same messageId replaces the earlier timer.
 */
export function armInterruptTimer(channelId: string, messageId: string, delayMs?: number): void {
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
      console.error("[channel] mid-run interrupt failed:", sanitizeUnknownValue(e));
    }
  }, delay);
  list.push({ messageId, at, timer });
  pendingInterrupts.set(channelId, list);
  console.log(`[channel] armed mid-run interrupt for ${messageId} (in ${delay}ms)`);
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
  for (const list of pendingInterrupts.values()) for (const p of list) clearTimeout(p.timer);
  pendingInterrupts.clear();
  interruptingChannels.clear();
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
export async function runMidRunInterrupt(pi: ExtensionAPI, ctx: ExtensionContext, channelId: string, messageId: string): Promise<void> {
  if (interruptingChannels.has(channelId)) {
    // Another interrupt is in flight for this channel; re-arm shortly —
    // the message is still in the re-wake queue as the fallback owner.
    armInterruptTimer(channelId, messageId, 200);
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
  console.log(`[channel] mid-run interrupt: aborting current step, then sending ${messageId}`);
  try {
    userStoppedRun = true; // silence the aborted run's failure post
    try { ctx.abort(); } catch { /* best-effort abort */ }
    // Wait for the session to fully settle (see function doc). If another
    // queued message's re-wake starts a run during this window, we wait
    // for that run too — the interrupt message then follows it as a fresh
    // run. Nothing is lost; order may be inverted for the other message.
    for (let i = 0; i < 400 && !ctx.isIdle(); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    sendToPi(pi, channelId, entry.text, entry.title ?? "", entry.display ?? entry.msg.body, entry.msg.messageId);
  } finally {
    interruptingChannels.delete(channelId);
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
let userStoppedRun = false;

// ─── Repetition guard ────────────────────────────────────────────────────
// 3 consecutive byte-identical finals (after trim) in one channel = a
// stuck loop. The third one is dropped, the run is aborted, and one
// warning line is posted instead. The counter resets on any different
// final or on a new inbound user message.
const finalReps = new Map<string, string[]>();
export const REPEAT_WARNING =
  "[!] repetition loop detected — run stopped. Say /reset if it persists.";

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

function isVerbose(ch: ChannelConfig): boolean {
  return verboseOverride.get(ch.id) ?? ch.forwardToolCalls ?? false;
}

/** One-line tool summary with kimaki box glyphs (┣ call, ◼︎ file edit/write). */
function formatToolCallLine(toolName: string, input: any): string {
  const esc = (s: string) => s.replace(/([\\*_`])/g, "\\$1");
  const one = (s: string, n: number) => {
    s = s.replace(/\s*\n\s*/g, " ").trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
  };
  const p = String(input?.path ?? "");
  switch (toolName) {
    case "bash": {
      // first segment only: "bun run build 2>&1 | tail -4" -> "bun run build"
      const seg = String(input?.command ?? "")
        .split(/\s*(?:\||&&|;|>)\s*/)[0]
        .replace(/\s*2>&1\s*$/, "");
      return `┣ bash ${esc(one(seg, 80))}`;
    }
    case "read":
      return `┣ read ${esc(one(p, 80))}`;
    case "edit":
      return `◼︎ edit ${esc(one(p, 80))}`;
    case "write":
      return `◼︎ write ${esc(one(p, 80))}`;
    default: {
      let args: string;
      try {
        args = JSON.stringify(input);
      } catch {
        args = String(input);
      }
      return `┣ ${toolName} ${esc(one(args, 60))}`;
    }
  }
}

/** Status line with running counter: "<action> · N calls · Xs". */
function statusLine(action: string, n: number, t0: number): string {
  const secs = Math.round((Date.now() - t0) / 1000);
  return `${action} · ${n} call${n === 1 ? "" : "s"} · ${secs}s`;
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

/** Send final text, auto-attaching any local files referenced in it. */
async function sendFinalWithFiles(
  ch: ChannelConfig,
  text: string,
  files: string[],
  replyTo?: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const md = mdToDiscord(text);
  if (files.length === 0) return sendDiscordMessage(ch, md, replyTo);
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

/** Strip leaked Qwen thinking tags (
 /
) from assistant text. */
function cleanThinking(text: string): string {
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
  let allowed: Set<string> | null = null;
  for (const m of messages as any[]) {
    if (m?.customType === CHANNEL_MSG_TYPE) {
      replyTo = m.details?.messageId;
      const ids = Array.isArray(m.details?.messageIds)
        ? m.details.messageIds
        : replyTo
          ? [replyTo]
          : [];
      allowed = new Set(ids.map(String));
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
    const chosen =
      rt.replyTo && allowed?.has(rt.replyTo) ? rt.replyTo : replyTo;
    finals.push({ text: rt.text, replyTo: chosen });
  }
  return finals;
}

/**
 * Command matcher: every command requires a leading '/'. Exception:
 * bare "stop" (exact match, no args) is also a command — the no-slash
 * form absorbs nothing, so "stop that" is chat, not /stop.
 * Exported for tests.
 */
export function matchCommand(
  body: string,
): { name: string; arg?: string } | null {
  const m = body.match(
    /^(?:\/(stop|help|btw|status|reset|restart|verbose|compact|model|jobs|todos)(?:\s+([\s\S]+))?|stop)$/i,
  );
  if (!m) return null;
  return { name: m[1] ?? "stop", arg: m[2] };
}

// ─── /jobs: in-flight pi-bg dispatches ─────────────────────────────────
// The pi-bg wrapper's command line carries profile + task, and the wrapper
// process exists only while the run is live, so `ps` is the reliable
// in-flight marker (the prompt/out artifacts are written at run end).
// Match the wrapper line shape: <etime> <bash> <...>scripts/pi-bg <profile> <task>
export function parseJobsFromPs(
  psOut: string,
): { profile: string; age: string; task: string }[] {
  const out: { profile: string; age: string; task: string }[] = [];
  for (const line of psOut.split("\n")) {
    const m = line
      .trim()
      .match(
        /^(\S+)\s+\S*bash\s+\S*scripts\/pi-bg\s+(worker|reviewer)\s+(.+)$/,
      );
    if (!m) continue;
    const task = m[3]
      .trim()
      .replace(/^"+|"+$/g, "")
      .split("\n")[0]
      .slice(0, 70);
    out.push({ age: m[1], profile: m[2], task });
  }
  return out;
}

export function listInflightJobs(): string {
  let raw = "";
  try {
    const uid = process.getuid?.();
    raw = execSync(
      `ps ${uid !== undefined ? `-u ${uid}` : "-eo"} -o etime,args | grep '[s]cripts/pi-bg'`,
      { encoding: "utf8", timeout: 5000 },
    );
  } catch {
    return "No jobs in flight.";
  }
  const jobs = parseJobsFromPs(raw);
  if (jobs.length === 0) return "No jobs in flight.";
  const lines = jobs.map((j) => `- ${j.profile} · ${j.age} · ${j.task}`);
  return `${jobs.length} job${jobs.length > 1 ? "s" : ""} in flight:\n${lines.join("\n")}`;
}

/** ! shell passthrough: run bash -c in the working directory, 60s cap.
 *  Keeps the first 20k chars of combined stdout+stderr. Exported for tests. */
export function runShellPassthrough(
  cmd: string,
  cwd: string,
): Promise<{ out: string; code: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const p = spawn("bash", ["-c", cmd], { cwd, env: process.env });
    let out = "";
    let timedOut = false;
    const cap = (s: string) => {
      if (out.length < 20_000) out += s.slice(0, 20_000 - out.length);
    };
    const t = setTimeout(() => {
      timedOut = true;
      try {
        p.kill("SIGKILL");
      } catch {}
    }, 60_000);
    p.stdout?.on("data", (d) => cap(String(d)));
    p.stderr?.on("data", (d) => cap(String(d)));
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ out: `spawn failed: ${e.message}`, code: 1, timedOut: false });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ out, code: code ?? 1, timedOut });
    });
  });
}

/** Fenced code block sized to the content's backtick runs. */
function wrapFence(t: string): string {
  const n = (t.match(/`+/g) || ["`"]).reduce(
    (m, r) => Math.max(m, r.length),
    0,
  );
  const f = "`".repeat(Math.max(3, n + 1));
  return `${f}\n${t}\n${f}`;
}

/**
 * Silent-run-failure check (A2): pi's handleRunFailure emits agent_end
 * with a fresh empty-text failure message that yields no finals and no
 * tool block. If the last message has stopReason "error" — or "aborted"
 * with an errorMessage when the run was NOT user-stopped — return the
 * post text; null otherwise. Exported for tests.
 */
export function failurePostText(
  messages: unknown[],
  userStopped: boolean,
): string | null {
  const last = messages.at(-1) as any;
  if (last?.role !== "assistant") return null;
  const err = typeof last.errorMessage === "string" ? last.errorMessage : "";
  // An abort surfaces as stopReason "error" + errorMessage "This operation
  // was aborted" (pi stream layer), or stopReason "aborted". Suppress the
  // failure post for both shapes when the user stopped the run (/stop,
  // /reset, or a mid-run interrupt) — it is expected, not a model/API failure.
  const isAbort = last.stopReason === "aborted" || (last.stopReason === "error" && /abort/i.test(err));
  if (userStopped && isAbort) return null;
  if (last.stopReason === "error" || (last.stopReason === "aborted" && err)) {
    return `[!] ${err || "run failed"}`;
  }
  return null;
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

/** Messages already forwarded by the message_end path — agent_end skips them. */
const earlySent = new WeakSet<object>();

// ─── Inbound message custom type ─────────────────────────────────────────
// Sent via pi.sendMessage(); the LLM sees the full content (with <channel-ctx>),
// while the TUI renders only the type/name title + message body.
const CHANNEL_MSG_TYPE = "channel-inbound";

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

export default function (pi: ExtensionAPI) {
  let channels: ChannelConfig[] = [];
  let workspaceRoot = "";
  let toolCallsThisTurn: string[] = [];
  // Live status line: one message per run, edited in place per tool call.
  let statusMsgId: string | null = null;
  let statusChannelId: string | null = null;
  let statusMsgAt = 0;
  let runToolCount = 0;
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
      console.error("[channel] mid-run interrupt failed:", sanitizeUnknownValue(e));
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
  pi.on("session_start", async (_event, ctx) => {
    sessionStartTs = Date.now();
    setInterruptCtx(ctx);
    workspaceRoot = ctx.cwd;
    channels = loadChannelConfig(ctx.cwd);

    const enabled = channels.filter((c) => c.enabled);
    if (enabled.length === 0) return;

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

    // LLM tools: send local file(s) / maintain the todo board.
    if (
      enabled.some(
        (c) => c.type === "discord" && (getDiscordToken(c.id) || c.botToken),
      )
    ) {
      registerSendFileTool(pi, channels);
      registerTodoTool(pi, channels);
    }
  });

  pi.on("session_shutdown", async () => {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
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
    pendingAttachments.clear();
    midTurnQueues.clear();
    clearAllInterrupts();
    setInterruptCtx(null);
    finalReps.clear();
  });

  // ─── Live status line (edit-in-place, deleted at run end) ───
  pi.on("tool_call", async (event) => {
    if (!lastActiveChannel) return;
    const ch = lastActiveChannel;
    if (statusChannelId !== ch.id) {
      // new channel: this channel gets its own line (old channel's line stays)
      statusMsgId = null;
      statusChannelId = ch.id;
    }
    if (!runOpen) {
      runOpen = true;
      runToolCount = 0;
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
    runToolCount += 1;
    const line = statusLine(
      formatToolCallLine(event.toolName, event.input),
      runToolCount,
      runStartedAt,
    );
    toolCallsThisTurn.push(line);
    try {
      if (!statusMsgId) {
        const r = await sendDiscordMessage(ch, line);
        if (r.success && r.messageId) {
          statusMsgId = r.messageId;
          statusMsgAt = Date.now();
        } else if (!r.success)
          console.error(
            `[channel] status send failed: ${sanitizeSensitiveText(r.error || "")}`,
          );
      } else {
        const r = await editDiscordMessage(ch, statusMsgId, line);
        if (!r.success)
          console.error(
            `[channel] status edit failed: ${sanitizeSensitiveText(r.error || "")}`,
          );
      }
    } catch {}
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
      runToolCount = 0;
      runStartedAt = Date.now();
      // fresh block per user message; previous blocks stay in history
      const r = await sendDiscordMessage(ch, "┣ working…");
      if (r.success && r.messageId) {
        statusMsgId = r.messageId;
        statusChannelId = ch.id;
        statusMsgAt = Date.now();
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
      const text = parts.join(" • ");
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
    earlySent.add(msg);
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
  const flushPendingCompact = (ctx: ExtensionContext) => {
    if (!pendingCompact) return;
    const pc = pendingCompact;
    pendingCompact = null;
    const err = startCompact(pc, ctx);
    if (err !== null)
      sendDiscordMessage(pc.ch, `[!] compact failed: ${err}`).catch(() => {});
  };
  pi.on("session_compact", (_event, ctx) => {
    flushPendingCompact(ctx);
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    flushPendingCompact(ctx);
  });

  // ─── Auto-forward on turn end ──────────────────────────────────────────
  // An assistant message with no tool calls is the final answer of its
  // step. A run can contain several (steering messages interrupt the
  // turn), so forward every one of them.
  pi.on("agent_end", async (event, ctx) => {
    // Clear turn state FIRST: since step-finals are forwarded at
    // message_end, a normal turn reaches agent_end with finals.length === 0
    // and the early return below. Clearing at the bottom leaked the typing
    // timer (typing indicator ran forever) and left agentBusy stuck (presence
    // stuck on "working") — 2026-09-08.
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
    agentBusy = false;
    refreshActivity(ctx);
    // Deferred /compact (queued while this run was in progress). The
    // IIFE inside pi's compact() awaits abort()+waitForIdle() before it
    // compacts, so it runs only after this run settles (including the
    // re-wake continuation below) and cannot abort that run.
    flushPendingCompact(ctx);

    // Capture the run's channel BEFORE the re-wake await: a second channel's
    // inbound can arrive during that await and overwrite lastActiveChannel,
    // which would mis-target this run's activity block, failure post, and
    // finals. The re-wake message's own run will get a fresh agent_end with
    // its own captured channel.
    const ch = lastActiveChannel;

    // Re-wake: inbounds that arrived while this run was in flight were queued
    // (not steered into it) so they cannot be swallowed. Start a fresh run for
    // the oldest queued one now. Awaiting it guarantees the message is handed
    // to pi before this handler returns, so the new turn actually starts
    // (triggerTurn; pi continues the run for a steer queued at agent_end).
    // Repeats on each agent_end until the queue drains.
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

    if (!ch) return;

    const finals = collectFinals(event.messages ?? []);

    // close the activity block: 0 tool calls -> delete it (a leftover
    // "done · 0 calls" box is noise); otherwise it stays up showing the run.
    if (statusMsgId && statusChannelId === ch.id) {
      if (runToolCount === 0) {
        await deleteDiscordMessage(ch, statusMsgId).catch(() => {});
      } else {
        const secs = Math.round((Date.now() - runStartedAt) / 1000);
        await editDiscordMessage(
          ch,
          statusMsgId,
          `┗ done · ${runToolCount} call${runToolCount === 1 ? "" : "s"} · ${secs}s`,
        ).catch(() => {});
      }
    }
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

const HELP_TEXT = [
  "**Commands**",
  "`/stop` — stop the current run",
  "plain message during a run — interrupts the step after ~3s, then takes over",
  "`/btw <question>` — quick side question, answered briefly",
  "`/status` — session stats (owner)",
  "`/reset` - start a NEW session, clearing context (owner)",
  "`/restart` - restart pi, resuming THIS session (owner)",
  "`/verbose on|off` — forward tool calls to the channel (owner)",
  "`/compact [instructions]` — compact session context (owner)",
  "`/model [name]` — switch or list models (owner)",
  "`/jobs` — list in-flight pi-bg dispatches",
  "`/todos` — show the channel todo board (arg `all` for every channel)",
  "`/help` — this message",
].join("\n");

function channelTitle(
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

function buildChannelContext(
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

// ─── Native slash-command handler (INTERACTIONS_CREATE) ───────────────────
// Defer-first: the type-5 ack lands BEFORE any command work, so a slow
// handler or a throwing command can never produce "did not respond in
// time" (Discord's 3s window). Immediate results EDIT the deferred
// message; /btw leaves the defer alone (answer arrives as a normal
// channel message). Exported for tests.
export function buildInteractionHandler(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  ch: ChannelConfig,
  botToken: string,
): (d: any) => Promise<void> {
  return async (d: any) => {
    // Config fallback covers the pre-resolution window where no gateway
    // state exists yet (and keeps tests simple).
    const cid = getDiscordChannelId(ch.id) || ch.channel;
    if (!cid || String(d.channel_id) !== String(cid)) {
      // No async work before this ack — a plain type-4 reply is safe.
      respondToInteraction(botToken, d, `use me in #${ch.name}`).catch(
        () => {},
      );
      return;
    }
    await deferInteraction(botToken, d);
    const opt = Array.isArray(d.data?.options)
      ? d.data.options.find((o: any) =>
          ["question", "mode", "instructions", "name", "scope"].includes(
            o?.name,
          ),
        )
      : undefined;
    let text: string | undefined;
    try {
      const r = await runChannelCommand(
        pi,
        ctx,
        ch,
        d.data?.name,
        opt?.value ?? undefined,
        d.user?.id,
        true,
      );
      text = r.btw ? undefined : (r.immediate ?? "ok");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      text = `[!] command failed: ${sanitizeSensitiveText(msg)}`;
    }
    if (text !== undefined) await editInteractionMessage(botToken, d, text);
  };
}

// ─── /compact: execute + report ─────────────────────────────────────────
// pi's ctx.compact() is fire-and-forget and swallows failures silently
// (the dist IIFE only calls onError when one is passed). Always report:
// onComplete → token delta, onError → [!] line. A sync throw returns the
// sanitized error message (null on success) so the caller reports it on
// its own path (command reply vs channel post).
function startCompact(
  pending: { ch: ChannelConfig; instructions?: string },
  ctx: ExtensionContext,
): string | null {
  const { ch, instructions } = pending;
  const report = (text: string) => {
    sendDiscordMessage(ch, text).catch(() => {});
  };
  try {
    ctx.compact({
      customInstructions: instructions,
      onComplete: (result) => {
        const before =
          typeof result?.tokensBefore === "number" ? result.tokensBefore : null;
        const after =
          typeof result?.estimatedTokensAfter === "number"
            ? result.estimatedTokensAfter
            : null;
        report(
          before != null && after != null
            ? `[ok] compacted: ${before} → ${after} tokens`
            : "[ok] compacted",
        );
      },
      onError: (err) => {
        const msg =
          err instanceof Error && err.message ? err.message : String(err);
        report(`[!] compact failed: ${sanitizeSensitiveText(msg)}`);
      },
    });
    return null;
  } catch (e) {
    return sanitizeSensitiveText(e instanceof Error ? e.message : String(e));
  }
}

// ─── Shared command execution ─────────────────────────────────────────────
// Used by both text messages and native slash commands (INTERACTIONS_CREATE).
// `native` = came from a Discord interaction: non-owners get a reply instead
// of the message falling through as normal chat. Async: /model awaits
// pi.setModel().

async function runChannelCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  ch: ChannelConfig,
  name: string,
  arg: string | undefined,
  fromId: string | undefined,
  native: boolean,
): Promise<{ immediate?: string; btw?: boolean }> {
  const isOwner = !ch.ownerUserId || fromId === ch.ownerUserId;
  const ownerOnly = !isOwner
    ? { immediate: native ? "owner only" : undefined }
    : {};
  switch (name.toLowerCase()) {
    case "stop": {
      // A4: drain the mid-turn re-wake queue so /stop does not immediately
      // re-wake a message that was waiting for this run to end. (Steer
      // messages already queued in pi are a known upstream gap — the
      // extension context exposes hasPendingMessages() but no clearQueue(),
      // so they land at the next run's first turn boundary.) Armed mid-run
      // interrupts are cleared too: a stopped run is not interrupted by a
      // stale message.
      const dropped = clearQueuedInbound(ch.id);
      clearInterrupts(ch.id);
      if (dropped > 0) console.log(`[channel] /stop dropped ${dropped} queued mid-turn inbound(s)`);
      if (!ctx.isIdle()) {
        userStoppedRun = true;
        ctx.abort();
      }
      return { immediate: "⏹️ stopped" };
    }
    case "help":
      return { immediate: HELP_TEXT };
    case "btw": {
      const question = (arg || "").trim();
      if (!question) return { immediate: "usage: `/btw <question>`" };
      const msg: ChannelMessage = {
        channelId: ch.id,
        channelName: ch.name,
        channelType: "discord",
        messageId: "",
        from: fromId || "unknown",
        fromId,
        body: question,
        timestamp: new Date().toISOString(),
        attachments: [],
        isRoom: false,
      };
      const channelCtx = buildChannelContext(ch, msg);
      sendToPi(
        pi,
        ch.id,
        `${channelCtx}\n\n${BTW_HINT}\n\n${question}`,
        `${ch.type}/${ch.name}`,
        question,
      );
      return { btw: true };
    }
    case "status": {
      if (!isOwner) return ownerOnly;
      let text: string;
      try {
        const u = ctx.getContextUsage?.();
        const model = (ctx.model as any)?.id ?? (ctx.model as any)?.name ?? "?";
        const elapsed = Date.now() - sessionStartTs;
        const up = `${Math.floor(elapsed / 3600000)}h${Math.floor((elapsed % 3600000) / 60000)}m`;
        const parts = [
          `ctx ${typeof u?.percent === "number" ? Math.round(u.percent) + "%" : "?"}`,
          `model ${model}`,
          `up ${up}`,
          ctx.isIdle() ? "idle" : "running",
        ];
        // Interrupt state, honestly: in flight, or armed with time to fire.
        if (interruptingChannels.has(ch.id)) {
          parts.push("interrupting");
        } else {
          const pend = pendingInterrupts.get(ch.id);
          if (pend && pend.length > 0) {
            const msLeft = Math.max(0, Math.min(...pend.map((p) => p.at)) - Date.now());
            parts.push(`interrupt in ${Math.ceil(msLeft / 1000)}s`);
          }
        }
        text = parts.join(" • ");
      } catch {
        text = "status unavailable";
      }
      return { immediate: text };
    }
    case "reset": {
      if (!isOwner) return ownerOnly;
      userStoppedRun = true;
      clearInterrupts(ch.id);
      try { ctx.abort(); } catch {}
      // /reset = NEW session. Mechanism: move the current session file aside,
      // then shutdown. The systemd respawn runs 'pi -c' (continue LAST
      // session); with the last file gone it starts fresh. (ctx.newSession
      // does NOT exist on event ctx — only on registerCommand ctx — reviewer
      // F1, jarate 2026-09-10.)
      setTimeout(() => {
        try {
          const home = process.env.HOME || "/root";
          const sessionsBase = path.join(home, ".pi", "agent", "sessions");
          const encDir = path.join(
            sessionsBase,
            `-${String(ctx.cwd).replace(/\//g, "-")}-`,
          );
          let target: string | null = null;
          const candidates: Array<[string, number]> = [];
          const scan = (dir: string) => {
            for (const f of fs.readdirSync(dir)) {
              if (!f.endsWith(".jsonl")) continue; // skips *.jsonl.reset-*
              const p = path.join(dir, f);
              try {
                candidates.push([p, fs.statSync(p).mtimeMs]);
              } catch {}
            }
          };
          if (fs.existsSync(encDir)) scan(encDir);
          else if (fs.existsSync(sessionsBase)) {
            for (const d of fs.readdirSync(sessionsBase)) {
              const sub = path.join(sessionsBase, d);
              try {
                if (fs.statSync(sub).isDirectory()) scan(sub);
              } catch {}
            }
          }
          candidates.sort((a, b) => b[1] - a[1]);
          target = candidates[0]?.[0] ?? null;
          if (target) fs.renameSync(target, `${target}.reset-${Date.now()}`);
          try {
            ctx.shutdown();
          } catch {
            process.exit(1);
          }
        } catch (e) {
          console.error("[reset] failed, forcing respawn:", e);
          process.exit(1); // F3: never leave a zombie half-state
        }
      }, 800);
      return {
        immediate: "[new] new session (context cleared) - restarting...",
      };
    }
    case "restart": {
      if (!isOwner) return ownerOnly;
      // /restart = process restart that RESUMES this session: systemd respawns
      // 'pi -c' which continues the last session file (the opposite of /reset,
      // which moves that file aside first).
      userStoppedRun = true;
      try { ctx.abort(); } catch {}
      setTimeout(() => { try { ctx.shutdown(); } catch {} }, 800);
      return { immediate: "[..] restarting pi - this session resumes on boot…" };
    }
    case "verbose": {
      if (!isOwner) return ownerOnly;
      const a = arg?.toLowerCase();
      const next = a === undefined ? !isVerbose(ch) : a === "on";
      verboseOverride.set(ch.id, next);
      return { immediate: `verbose ${next ? "on" : "off"} (until restart)` };
    }
    case "compact": {
      if (!isOwner) return ownerOnly;
      const instructions = (arg || "").trim() || undefined;
      if (!ctx.isIdle()) {
        // Run in progress (compact would abort it) or a compaction already
        // in flight: queue it. One slot — a later /compact replaces the
        // earlier. Flushed at agent_end or when the current compaction
        // settles (see pendingCompact + the flush handlers).
        const replacing = pendingCompact !== null;
        pendingCompact = { ch, instructions };
        const why = agentBusy
          ? "run in progress"
          : "compact already in progress";
        return {
          immediate: `[queued] compact (${why})${replacing ? ", replaces earlier" : ""}`,
        };
      }
      const err = startCompact({ ch, instructions }, ctx);
      return {
        immediate:
          err !== null ? `[!] compact failed: ${err}` : "[..] compacting...",
      };
    }
    case "jobs": {
      // Informational, open to all channel members (private channel).
      return { immediate: listInflightJobs() };
    }
    case "todos": {
      // Informational, open to all channel members (private channel).
      if ((arg || "").trim().toLowerCase() === "all") {
        const names = new Map(
          loadChannelConfig(ctx.cwd).map((c) => [c.id, c.name]),
        );
        const parts = listBoards()
          .filter((b) => b.todos.length > 0)
          .map(
            (b) =>
              `▤ ${names.get(b.channelId) || b.channelId} · ${openCount(b.todos)} open\n${b.todos.map(todoLine).join("\n")}`,
          );
        return {
          immediate: parts.length > 0 ? parts.join("\n\n") : "no open todos",
        };
      }
      const board = loadBoard(ch.id);
      if (!board || board.todos.length === 0)
        return { immediate: "no open todos" };
      return { immediate: renderBoard(board.todos) };
    }
    case "model": {
      if (!isOwner) return ownerOnly;
      const req = (arg || "").trim();
      let models: any[] = [];
      try {
        models = ctx.modelRegistry?.getAvailable?.() ?? [];
      } catch {}
      if (!req) {
        if (models.length === 0) return { immediate: "no models available" };
        const names = models
          .slice(0, 20)
          .map((m: any) => `${m.provider}/${m.id}`);
        return {
          immediate: `models:\n${names.join("\n")}${models.length > 20 ? `\n…+${models.length - 20} more` : ""}`,
        };
      }
      const lower = req.toLowerCase();
      let found: any | undefined = models.find(
        (m: any) =>
          String(m.id).toLowerCase() === lower ||
          `${m.provider}/${m.id}`.toLowerCase() === lower,
      );
      if (!found) {
        const partial = models.filter(
          (m: any) =>
            String(m.id).toLowerCase().includes(lower) ||
            String(m.name ?? "")
              .toLowerCase()
              .includes(lower),
        );
        if (partial.length === 1) found = partial[0];
        else if (partial.length > 1) {
          const cands = partial
            .slice(0, 5)
            .map((m: any) => `${m.provider}/${m.id}`)
            .join(", ");
          return {
            immediate: `ambiguous "${req}": ${cands}${partial.length > 5 ? "…" : ""}`,
          };
        }
      }
      if (!found) return { immediate: `model not found: ${req}` };
      const ok = await pi.setModel(found);
      return {
        immediate: ok
          ? `[ok] model ${found.provider}/${found.id}`
          : `[!] no auth configured for ${found.provider}/${found.id}`,
      };
    }
    default:
      return {};
  }
}

// ─── send-file tool ────────────────────────────────────────────────
// Uploads local file(s) to the active Discord channel in one message
// (multipart upload, 25 MB per-file cap). Replaces the webdrop round-trip
// for anything small.

function registerSendFileTool(
  pi: ExtensionAPI,
  channels: ChannelConfig[],
): void {
  pi.registerTool({
    name: "send-file",
    label: "Send file",
    description:
      "Send file(s) from this machine to the active Discord channel. Use it when the user should receive an image, report, log, or any file. Files up to 25 MB each; all files are sent in one message (images shown in a grid).",
    promptSnippet: "Send local file(s) to the active Discord channel",
    promptGuidelines: [
      "Use send-file to deliver files to the user instead of pasting long paths or webdrop links.",
    ],
    parameters: Type.Object({
      files: Type.Array(Type.String(), {
        minItems: 1,
        description:
          "File paths (absolute, or relative to the working directory)",
      }),
    }),
    async execute(
      _toolCallId,
      params: { files: string[] },
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const active =
        lastActiveChannel && lastActiveChannel.type === "discord"
          ? lastActiveChannel
          : null;
      const ch = active || getDefaultChannel(channels);
      if (ch?.type !== "discord") {
        return {
          content: [{ type: "text", text: "No Discord channel available" }],
          details: {},
        };
      }
      const token = getDiscordToken(ch.id) || ch.botToken;
      const channelId = getDiscordChannelId(ch.id);
      if (!token || !channelId) {
        return {
          content: [
            {
              type: "text",
              text: `Channel ${ch.name}: no bot token/channel id`,
            },
          ],
          details: {},
        };
      }
      // Some models prefix paths with @ — normalize it.
      const files = params.files.map((f) =>
        path.resolve(ctx.cwd, f.replace(/^@/, "")),
      );
      const r = await sendFilesToDiscord(channelId, files, token);
      if (r.success) {
        return {
          content: [
            {
              type: "text",
              text: `Sent ${files.length} file(s) to ${ch.name}`,
            },
          ],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: r.error || "send failed" }],
        details: {},
      };
    },
  });
}

// ─── todo tool ─────────────────────────────────────────────────────────
// Maintains the per-channel todo board. FULL-LIST semantics: the model
// always sends the complete updated list; an empty array clears the
// board. State: ~/.pi/agent/todos/<channelId>.json. The Discord board
// message is posted once, then edited in place; board send/edit failures
// never fail the tool call (state is the source of truth).
// Description text is opencode's proven todo prompt.
export const TODO_TOOL_DESCRIPTION = `Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.
## When to use
Use proactively when:
- The task requires 3+ distinct steps or actions (not just 3 tool calls for a single conceptual step)
- The work is non-trivial and benefits from planning
- The user provides multiple tasks (numbered or comma-separated) or explicitly asks for a todo list
- New instructions arrive - capture them as todos
- You start a task - mark it in_progress (only one at a time) before working
- You finish a task - mark it completed and add any follow-ups discovered during the work
## When NOT to use
Skip when:
- The work is a single, straightforward task (or <3 trivial steps)
- The request is purely informational or conversational
- Tracking adds no organizational value
## States
- pending - not started
- in_progress - actively working (exactly ONE at a time)
- completed - finished successfully
- cancelled - no longer needed
## Rules
- Update status in real time; do not batch completions
- Mark completed only after the required work is actually done, including any required verification. Never based on intent
- Keep exactly one in_progress while work remains
- If blocked or partial, keep it in_progress and add a follow-up todo describing the blocker
- Preserve user-provided commands verbatim (flags, args, order)
- Items should be specific and actionable; break large work into smaller steps
When in doubt, use it.`;

/**
 * Post or edit the channel's Discord todo board message. Never throws:
 * a failed post/edit is logged, and the state file remains authoritative
 * (the next sync retries, or re-posts when the message id was lost).
 * Exported for tests.
 */
export async function syncTodoBoard(
  ch: ChannelConfig,
  board: TodoBoard,
): Promise<void> {
  try {
    if (board.todos.length === 0) {
      if (board.boardMessageId) {
        await deleteDiscordMessage(ch, board.boardMessageId);
        board.boardMessageId = undefined;
        saveBoard(board);
      }
      return;
    }
    const text = renderBoard(board.todos);
    if (board.boardMessageId) {
      const r = await editDiscordMessage(ch, board.boardMessageId, text);
      if (!r.success)
        console.error(
          `[todos] board edit failed: ${sanitizeSensitiveText(r.error || "")}`,
        );
      return;
    }
    const r = await sendDiscordMessage(ch, text);
    if (r.success && r.messageId) {
      board.boardMessageId = r.messageId;
      saveBoard(board);
    } else {
      // Webhook-only channels return no message id — the next sync re-posts.
      console.error(
        `[todos] board post failed: ${sanitizeSensitiveText(r.error || "")}`,
      );
    }
  } catch (e) {
    console.error(`[todos] board sync failed: ${sanitizeUnknownValue(e)}`);
  }
}

export function registerTodoTool(
  pi: ExtensionAPI,
  channels: ChannelConfig[],
): void {
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: TODO_TOOL_DESCRIPTION,
    promptSnippet:
      "Maintain the channel todo board (send the FULL updated list every time)",
    promptGuidelines: [
      "Call todo with the complete updated list whenever a task's status changes; empty list clears the board.",
    ],
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({
            description: "What to do (specific and actionable)",
          }),
          status: Type.Union(
            [
              Type.Literal("pending"),
              Type.Literal("in_progress"),
              Type.Literal("completed"),
              Type.Literal("cancelled"),
            ],
            { description: "Item status" },
          ),
        }),
        {
          maxItems: 50,
          description:
            "The COMPLETE updated list (empty array clears the board)",
        },
      ),
    }),
    async execute(
      _toolCallId,
      params: { todos: any[] },
      _signal,
      _onUpdate,
      _ctx: ExtensionContext,
    ) {
      const active =
        lastActiveChannel && lastActiveChannel.type === "discord"
          ? lastActiveChannel
          : null;
      const ch = active || getDefaultChannel(channels);
      if (ch?.type !== "discord") {
        return {
          content: [{ type: "text", text: "No Discord channel available" }],
          details: {},
        };
      }
      const todos = sanitizeTodos(params.todos);
      const prev = loadBoard(ch.id);
      const board: TodoBoard = {
        channelId: ch.id,
        todos,
        updatedAt: new Date().toISOString(),
        ...(prev?.boardMessageId
          ? { boardMessageId: prev.boardMessageId }
          : {}),
      };
      let stateNote = "";
      try {
        saveBoard(board);
      } catch (e) {
        // State write failed — report it but still echo the list so the
        // model keeps its copy.
        stateNote = `\n\n[!] board save failed: ${sanitizeUnknownValue(e)}`;
      }
      await syncTodoBoard(ch, board);
      const text =
        todos.length === 0 ? "todo board cleared" : renderBoard(todos);
      return {
        content: [{ type: "text", text: text + stateNote }],
        details: {},
      };
    },
  });
}

// ─── Inbound handler ──────────────────────────────────────────────────────
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
  if (msg.messageId) lastInboundIds.set(ch.id, msg.messageId);
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
    sendDiscordMessage(ch, text, msg.messageId).catch(() => {});
  };
  // Commands reply directly instead of running a turn — tell the poller
  // not to ack these messages with 👀 (synchronous, no race).
  const noAck = () => {
    if (ch?.type === "discord" && msg.messageId)
      suppressAutoReact(msg.messageId);
  };

  const cmd = matchCommand(rawBody);
  if (cmd) {
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
    if (r.immediate !== undefined) {
      noAck();
      replyCmd(r.immediate);
      return;
    }
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
    if (ch.ownerUserId && msg.fromId !== ch.ownerUserId) {
      replyCmd("`!` shell is owner-only");
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

  // Channel ctx (+ btw hint) + optional memory TOC — LLM-only, not shown
  // in the TUI.
  const channelCtx = buildChannelContext(ch, msg, { btw: forceBtw });
  const repliedBlock = buildRepliedMessageBlock(msg.repliedMessage);
  const toc = await memoryToc(ctx.cwd);
  const ctxBlock = [
    channelCtx,
    repliedBlock,
    toc ? `<channel-memory>\n${toc}\n</channel-memory>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const withCtx = (text: string) => `${ctxBlock}\n\n${text}`;

  // A run is in flight (streaming or has pending messages). Mid-turn inbounds
  // are queued for a guaranteed re-wake at agent_end instead of steered into
  // the in-flight run, which pi may swallow if the run ends first. forceDirect
  // (the re-wake path) bypasses the gate so the message is never re-queued.
  const runActive = forceDirect
    ? false
    : !ctx.isIdle() || ctx.hasPendingMessages?.();
  // Returns true (caller should `return`) when the inbound was queued for a
  // re-wake. Ownership is unambiguous: a message is either sent to pi now or
  // queued for a re-wake — never both.
  const gateForRewake = (text: string, gateTitle: string, display: string): boolean => {
    if (!runActive) return false;
    queueMidTurnInbound(ch.id, msg, text, gateTitle, display);
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
    // so the LLM is not pointed at a missing file.
    const notes = new Map<string, string>();
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
              if (!content) {
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

    const voiceLines = msg.attachments
      .filter((a) => isVoiceAttachment(a))
      .map((a) => voiceNoteText(a));

    // No text and no voice note
    let prompt = body;
    if (!body && voiceLines.length === 0) {
      if (ch?.bufferFileOnly !== false) {
        // Default: buffer file info, wait for follow-up text
        const batches = prunePendingBatches(msg.channelId);
        batches.push({
          folder: batchFolderRel,
          files: msg.attachments,
          addedAt: ts,
          notes: Object.fromEntries(notes),
        });
        pendingAttachments.set(msg.channelId, batches);
        return;
      }
      // bufferFileOnly: false — fire a turn with a synthesized prompt
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
  const plainText = withCtx(body || "(empty)");
  if (gateForRewake(plainText, title, body || "(empty)")) return;

  sendToPi(pi, ch.id, plainText, title, body || "(empty)", msg.messageId);
}

// ─── Send to pi session ──────────────────────────────────────────────────

function sendToPi(
  pi: ExtensionAPI,
  channelId: string,
  text: string,
  title: string,
  displayBody: string,
  messageId?: string,
  messageIds?: string[],
) {
  const ids = messageIds ?? (messageId ? [messageId] : []);
  if (ids.length > 0) runInboundIds.set(channelId, ids);
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
  } catch (e) {
    console.error("[channel] sendMessage failed:", sanitizeUnknownValue(e));
  }
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
