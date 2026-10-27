/**
 * channel/commands — command surface: text + native slash commands.
 *
 * God-file split 1/5 (2026-10-19). Moved verbatim from index.ts:
 * matchCommand + isOwnerUser/hasOwnerConfigured + the /jobs ! shell
 * passthrough, wrapFence/channelError/failurePostText, HELP_TEXT, the
 * native INTERACTIONS_CREATE handler (buildInteractionHandler),
 * /compact execute+report (startCompact), the /tasks spec-string
 * adapters, and runChannelCommand (the 22-case switch).
 *
 * Shared mutable state (hold flags, op window, re-wake queue, run state)
 * stays owned by index.ts; this module imports it via the hub
 * (index <-> commands is init-safe: all cross-refs are runtime-only).
 */

import { spawn } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BTW_HINT } from "./btw";
import { renderContext } from "./context";
import { publishDiff } from "./diff";
import {
  deferInteraction,
  editInteractionMessage,
  getDiscordChannelId,
  interactionUserId,
  respondToInteraction,
  sendDiscordMessage,
  setChannelCursor,
} from "./discord";
import { fmtTokensLC, styleGuard } from "./format";
import { resolveHandoffSettings } from "./handover";
import {
  agentBusy,
  beginCompacting,
  buildChannelContext,
  clearCompacting,
  clearInterrupts,
  compactingChannels,
  getPendingCompact,
  handleInbound,
  interruptCancelled,
  interruptingChannels,
  isCompacting,
  isHeld,
  lastRunUsage,
  onDeleteStatusBlock,
  opBusyRefusal,
  opWindowLabel,
  parseVerboseLevel,
  pendingInterrupts,
  persistChannelRuntimeState,
  sendToPi,
  sessionStartTs,
  setHeld,
  setPendingCompact,
  setUserStoppedRun,
  VERBOSE_LEVEL_NAMES,
  verboseLevel,
  verboseOverride,
} from "./index";
import { jobsView } from "./jobs";
import {
  armCompactTick,
  COMPACT_PLACEHOLDER,
  fence,
  settleCompactTick,
} from "./live";
import {
  clearQueuedInbound,
  midTurnQueues,
  popChannelQueuedInbound,
} from "./queue";
import {
  archiveStaleSessions,
  beginRestartOp,
  clearOpMarker,
  moveSessionFileAside,
  parseUndoCount,
  runRedo,
  runUndo,
  safeSessionFile,
  scheduleOpShutdown,
} from "./restart-ops";
import { sanitizeSensitiveText, sanitizeUnknownValue } from "./sanitize";
import { cancelWake, formatDurationMs, loadWakes } from "./sleep";
import {
  cancelTask,
  formatTaskLine,
  loadTasks,
  parseTaskSpec,
  rescheduleTask,
  scheduleTask,
} from "./tasks";
import { listBoards, loadBoard, renderBoard } from "./todos";
import {
  type ChannelConfig,
  type ChannelMessage,
  loadChannelConfig,
} from "./types";
import { renderUsage, usageSummary } from "./usage";
import { mergeWorktree, newWorktree } from "./worktree";

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
    /^(?:\/(stop|help|btw|status|usage|context|reset|restart|undo|redo|sleep|verbose|hold|compact|handover|model|jobs|todos|tasks|diff|new-worktree|merge-worktree)(?:\s+([\s\S]+))?|stop)$/i,
  );
  if (!m) return null;
  return { name: m[1] ?? "stop", arg: m[2] };
}

/**
 * Owner check. `ownerUserIds` (list) is preferred; the legacy single
 * `ownerUserId` still works, so existing configs are unaffected. A channel
 * with no owner configured admits nobody.
 *
 * 2026-09-23: an unset owner used to be invisible — owner-only commands
 * silently fell through to the agent as plain text ("why isn't /status
 * working" was the agent answering the command as a prompt). Refusals are
 * now explicit for both transports; see the `ownerOnly` note in
 * runChannelCommand. Exported for tests.
 */
export function isOwnerUser(
  ch: { ownerUserId?: string; ownerUserIds?: string[] } | undefined | null,
  userId: string | undefined,
): boolean {
  if (!ch || !userId) return false;
  if (ch.ownerUserIds?.includes(userId)) return true;
  return !!ch.ownerUserId && ch.ownerUserId === userId;
}

/** Does this channel have any owner configured at all? */
export function hasOwnerConfigured(
  ch: { ownerUserId?: string; ownerUserIds?: string[] } | undefined | null,
): boolean {
  return !!(ch?.ownerUserId || ch?.ownerUserIds?.length);
}

// ─── /jobs: recent pi-bg run history ────────────────────────────────────
// History-only since the drain (#279): the dispatch lane is retired, the
// in-flight ps view and the kill/tail wrappers died with the removed
// completion side. Assembly lives in ./jobs (scanJobHistory / formatJobsView).

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
export function wrapFence(t: string): string {
  const n = (t.match(/`+/g) || ["`"]).reduce(
    (m, r) => Math.max(m, r.length),
    0,
  );
  const f = "`".repeat(Math.max(3, n + 1));
  return `${f}\n${t}\n${f}`;
}

/**
 * Error -> short channel-safe text. The single funnel for error text
 * posted to Discord (run failures, command catches): known error classes
 * map to consistent markers (timeout -> "timed out", rate limit ->
 * "rate limited, retrying", ENOSPC -> "disk full"); aborts return null —
 * suppressed, because an abort is self-evident (the human message landed
 * and the turn continued); everything else is trimmed to its first line,
 * capped at 200 chars, sensitive-text redacted. No raw DOMException/JS
 * message string reaches the send layer. Exported for tests.
 */
export function channelError(e: unknown): string | null {
  if (e === null || e === undefined) return null;
  const obj = (typeof e === "object" ? e : {}) as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : "";
  const code = String(obj.code ?? obj.status ?? obj.statusCode ?? "");
  const msg =
    typeof e === "string"
      ? e
      : typeof (e as Error).message === "string" && (e as Error).message !== ""
        ? (e as Error).message
        : String(e);
  const hay = `${name}\n${code}\n${msg}`;
  // Aborted: DOMException "AbortError", the pi stream layer's "This
  // operation was aborted", the bash tool's "Command aborted".
  if (name === "AbortError" || /abort/i.test(hay)) return null;
  if (
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    /timed? ?out/i.test(hay)
  )
    return "timed out";
  if (code === "429" || /rate.?limit|too many requests|overloaded/i.test(hay))
    return "rate limited, retrying";
  if (code === "ENOSPC" || /no space left on device/i.test(hay))
    return "disk full";
  const line = msg.split(/\r?\n/, 1)[0].trim();
  if (line.length === 0) return "";
  const capped = line.length > 200 ? `${line.slice(0, 197)}...` : line;
  return sanitizeSensitiveText(capped, { redactPaths: true });
}

/**
 * Silent-run-failure check (A2): pi's handleRunFailure emits agent_end
 * with a fresh empty-text failure message that yields no finals and no
 * tool block. If the last message has stopReason "error" — or "aborted"
 * with an errorMessage — return the post text (via channelError); null
 * otherwise. Aborts are suppressed unconditionally: a mid-run interrupt
 * is self-evident, and the user-stopped flag can race a re-wake's
 * turn_start reset (the aborted run's agent_end then runs with the flag
 * already cleared). Exported for tests.
 */
export function failurePostText(
  messages: unknown[],
  userStopped: boolean,
): string | null {
  const last = messages.at(-1) as any;
  if (last?.role !== "assistant") return null;
  const err = typeof last.errorMessage === "string" ? last.errorMessage : "";
  // An abort surfaces as stopReason "error" + errorMessage "This operation
  // was aborted" (pi stream layer), or stopReason "aborted". /stop,
  // /reset and the mid-run interrupt set the user-stopped flag;
  // channelError suppresses the abort markers even when the flag raced.
  const isAbort =
    last.stopReason === "aborted" ||
    (last.stopReason === "error" && /abort/i.test(err));
  if (userStopped && isAbort) return null;
  if (last.stopReason === "error" || (last.stopReason === "aborted" && err)) {
    const t = channelError(err);
    if (t === null) return null;
    // Bare chat one-liner - plain words, no tag (machine output only,
    // Andryo 2026-10-20).
    return `${t || "run failed"}`;
  }
  return null;
}

// Fenced at egress (every command reply ships in a code block) - so no
// markdown markup inside: backticks/asterisks would render literally.
const HELP_TEXT = [
  "Commands",
  "/stop - stop the current run",
  "plain message during a run - interrupts the step after ~3s, then takes over",
  "/btw <question> - quick side question, answered briefly",
  "/status - session stats (owner)",
  "/usage [all|session|last] - token usage: current session, all, or last run",
  "/context [N] - what's eating the window: top-N + category totals (est)",
  "/reset - start a NEW session, clearing context (owner)",
  "/restart - restart pi, resuming THIS session (owner)",
  "/undo [N] - revert last N assistant turns (default 1): files + conversation (owner)",
  "/redo - reapply an /undo (one level deep, owner)",
  "/verbose [0|1|2|on|off] - tool detail: 0 text, 1 essential, 2 all (owner)",
  "/hold [on|off] - buffer messages until released (owner)",
  "/compact [instructions] - compact session context (owner)",
  "/handover [instructions] - compact via the handover doc (owner; needs handoff.enabled)",
  "/model [name] - switch or list models (owner)",
  "/jobs - recent pi-bg run history (json for JSON)",
  "/new-worktree [ref] - worktree for this session's repo (owner)",
  "/merge-worktree [squash] - merge worktree back, keep or squash (owner)",
  "/diff [git-range | file] - publish a diff (default: working tree) to a shareable viewer URL",
  "/todos - show the channel todo board (arg all for every channel)",
  "/sleep [list | cancel <id>] - list or cancel pending session wakes (owner)",
  "/tasks [list | add | reschedule | cancel] - schedule, change or cancel prompt tasks (owner)",
  "/help - this message",
].join("\n");

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
    // MESSAGE_COMPONENT (button/select) events: type 3 per the current
    // Discord spec (it was 4 in the old numbering). The PAT vault
    // (gutted 2026-10-17) was the only component producer — drop them
    // before the command path (the
    // gateway branch calls this handler un-awaited inside a sync-only
    // try/catch; a reply here would need an ack the tap never gets).
    if (d?.type === 3) return;
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
    // Single-string options only: every registered command carries at most
    // one type-3 option; its name must be in this allowlist or the value
    // never reaches runChannelCommand. Keep in lockstep with SLASH_COMMANDS
    // (discord.ts) — the option names in use: question (btw), mode
    // (verbose/hold/merge-worktree), instructions (compact/handover), name
    // (model), scope (usage/todos/sleep), count (context/undo), action
    // (jobs/tasks), ref (new-worktree), source (diff).
    const opt = Array.isArray(d.data?.options)
      ? d.data.options.find((o: any) =>
          [
            "question",
            "mode",
            "instructions",
            "name",
            "scope",
            "count",
            "action",
            "ref",
            "source",
          ].includes(o?.name),
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
        interactionUserId(d),
        true,
      );
      text = r.btw
        ? undefined
        : (r.immediate ?? (r.consumed ? undefined : fence("ok")));
    } catch (e) {
      const t = channelError(e);
      if (t !== null) text = `command failed: ${t}`;
    }
    // Command replies ship fenced (STYLE.md 2.7): the guard fences bare
    // machine-state lines; already-fenced immediates pass through unchanged.
    if (text !== undefined)
      await editInteractionMessage(botToken, d, styleGuard(text));
  };
}

// ─── /compact: execute + report ─────────────────────────────────────────
// pi's ctx.compact() is fire-and-forget and swallows failures silently
// (the dist IIFE only calls onError when one is passed). Always report:
// onComplete → token delta, onError → one line (plain words, no tag -
// op status is prose, Andryo 2026-10-20). A sync throw returns the
// sanitized error message (null on success) so the caller reports it on
// its own path (command reply vs channel post).
export function startCompact(
  pi: ExtensionAPI,
  pending: { ch: ChannelConfig; instructions?: string },
  ctx: ExtensionContext,
  postPlaceholder = false,
): string | null {
  const { ch, instructions } = pending;
  const report = (text: string) => {
    // Replace the ticking placeholder in place when one is armed; the
    // fresh-post fallback covers the native slash path and the (impossible
    // in practice) settle-before-post race. Both settle paths post the
    // SAME bare line: status is prose (STYLE.md v4 §2.3), and styleGuard
    // is a no-op on the plain one-liner that reaches the fresh-post path.
    const guarded = styleGuard(text);
    if (!settleCompactTick(ch.id, text))
      sendDiscordMessage(ch, guarded).catch(() => {});
  };
  try {
    ctx.compact({
      customInstructions: instructions,
      onComplete: (result) => {
        // The session_compact event also settles the window; this is the
        // belt: if the event is ever missing, the fallback timer is the
        // only clear. (No-op once the event has cleared the flag.)
        clearCompacting(pending.ch.id);
        const before =
          typeof result?.tokensBefore === "number" ? result.tokensBefore : null;
        const after =
          typeof result?.estimatedTokensAfter === "number"
            ? result.estimatedTokensAfter
            : null;
        report(
          before != null && after != null
            ? `compacted: ${fmtTokensLC(before)} -> ${fmtTokensLC(after)}`
            : "compacted",
        );
      },
      onError: (err) => {
        const t = channelError(err);
        if (t !== null) report(`compact failed: ${t}`);
        clearCompacting(pending.ch.id);
      },
    });
    beginCompacting(pi, pending.ch, ctx);
    if (postPlaceholder && ch.type === "discord") {
      // Fire-and-forget: the placeholder gets its live tick; a settle
      // faster than the post simply gets the fresh-post fallback via report().
      sendDiscordMessage(ch, COMPACT_PLACEHOLDER)
        .then((r) => {
          if (r.success && r.messageId) armCompactTick(ch, r.messageId);
        })
        .catch(() => {});
    }
    return null;
  } catch (e) {
    return sanitizeSensitiveText(e instanceof Error ? e.message : String(e));
  }
}

// ─── /tasks spec-string adapter ────────────────────────────────────────────
// Turns the raw schedule text of /tasks add|reschedule into parseTaskSpec
// params (the SAME validator the task LLM tool uses — no second parser):
//   1 token: digits = minutes (optional m suffix, e.g. 30m), otherwise an ISO
//   5 tokens: 5-field cron
//   6 tokens: 5-field cron + IANA timezone
// Surrounding double quotes on the spec are decoration (the issue examples
// show /tasks add "..." "0 6 * * *"); no valid spec value (minutes, ISO,
// cron field, IANA tz) contains a quote, so all of them are stripped.
// Anything else is a form error (the command prints its usage line).
function specStringParams(
  raw: string,
): { at?: string; minutes?: number; cron?: string; tz?: string } | undefined {
  const s = raw.trim().replace(/"/g, "");
  if (!s) return undefined;
  const tokens = s.split(/\s+/);
  if (tokens.length === 1) {
    const t0 = tokens[0]!;
    const mins = t0.match(/^(\d+)m?$/);
    if (mins) return { minutes: Number(mins[1]!) };
    return { at: t0 };
  }
  if (tokens.length === 5) return { cron: tokens.join(" ") };
  if (tokens.length === 6)
    return { cron: tokens.slice(0, 5).join(" "), tz: tokens[5] };
  return undefined;
}

/** Schedule label for [ok] lines (same wording as the task tool ack). */
function taskWhenLabel(task: {
  kind: string;
  cron?: string;
  tz?: string;
  atMs?: number;
}): string {
  return task.kind === "cron"
    ? `cron "${task.cron}"${task.tz ? ` (${task.tz})` : " (system tz)"}`
    : `at ${new Date(task.atMs!).toISOString()}`;
}

// ─── Shared command execution ─────────────────────────────────────────────
// Used by both text messages and native slash commands (INTERACTIONS_CREATE).
// `native` = came from a Discord interaction: non-owners get a reply instead
// of the message falling through as normal chat. Async: /model awaits
// pi.setModel().

export async function runChannelCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  ch: ChannelConfig,
  name: string,
  arg: string | undefined,
  fromId: string | undefined,
  native: boolean,
): Promise<{ immediate?: string; btw?: boolean; consumed?: boolean }> {
  const isOwner = isOwnerUser(ch, fromId);
  // A recognised command is NEVER handed to the agent as plain text when the
  // sender is not permitted. It used to be (`immediate` was only set on the
  // native/slash path), so an owner-only command from a non-owner quietly
  // became a prompt and the agent answered it as chat — indistinguishable
  // from the bridge ignoring commands. Refuse explicitly on both transports,
  // and name the misconfiguration when no owner is set at all.
  const ownerOnly = isOwner
    ? {}
    : {
        immediate: fence(
          hasOwnerConfigured(ch)
            ? "[!] owner only"
            : "[!] owner only (no owner configured: set channels[].ownerUserId or ownerUserIds)",
        ),
      };
  // Robustness: a misrouted event (no d.data.name) must fail with a
  // readable line, not a TypeError (2026-10-01: a button tap crashed here
  // before the type gate was fixed).
  if (typeof name !== "string" || name.length === 0)
    return { immediate: fence("[!] unknown command") };
  switch (name.toLowerCase()) {
    case "stop": {
      // /stop while compacting is owner-only (isOwner pattern): it aborts
      // the in-flight compaction, a state change, not a read. Answer
      // immediately for non-owners (even plain text): a queued /stop would
      // re-run ungated after the window closes and drop the channel's
      // re-wake queue (including owner messages) + abort the next run.
      if (isCompacting(ch.id) && !isOwner)
        return { immediate: fence("[!] owner only") };
      // A restart-class op captured its Discord cursor at window open;
      // /stop clears the window AND restores that cursor so inbounds
      // delivered during the op replay on the next boot instead of being
      // lost with the window (they are dropped from the re-wake queue
      // below).
      const stoppedEntry = compactingChannels.get(ch.id);
      // F1 (owner: cancel): a restart-class op (rewindTo set) was in
      // flight — /stop CANCELS it. clearCompacting drops the pending
      // shutdown timer, the marker goes with the op, and the ack says
      // so. A compaction-only stop keeps the plain "[-] stopped".
      const restartCancelled = stoppedEntry?.rewindTo != null;
      clearCompacting(ch.id); // the abort's settle (session_compact_failed)
      // re-clears + drains; the queue drop below wins for THIS /stop
      if (restartCancelled) clearOpMarker(ctx);
      if (stoppedEntry?.rewindTo)
        setChannelCursor(ch.id, stoppedEntry.rewindTo);
      // A4: drain the mid-turn re-wake queue so /stop does not immediately
      // re-wake a message that was waiting for this run to end. (Steer
      // messages already queued in pi are a known upstream gap — the
      // extension context exposes hasPendingMessages() but no clearQueue(),
      // so they land at the next run's first turn boundary.) Armed mid-run
      // interrupts are cleared too: a stopped run is not interrupted by a
      // stale message.
      // #39: a HELD channel's queue is the operator's buffer — /stop clears
      // the run but NOT the buffer. The held queue persists: it drains on
      // /hold off, or entries are deleted one by one. (Documented choice:
      // persist, not clear.)
      const held = isHeld(ch);
      const dropped = held ? 0 : clearQueuedInbound(ch.id);
      clearInterrupts(ch.id);
      // Cancel an in-flight interrupt's pending send — but only when one is
      // actually in flight for this channel, so the flag never goes stale
      // and drops a later legitimate interrupt (F7).
      if (interruptingChannels.has(ch.id)) interruptCancelled.add(ch.id);
      if (dropped > 0)
        console.log(
          `[channel] /stop dropped ${dropped} queued mid-turn inbound(s)`,
        );
      if (!ctx.isIdle()) {
        setUserStoppedRun(true);
        ctx.abort();
      }
      const heldDepth = held ? (midTurnQueues.get(ch.id)?.length ?? 0) : 0;
      return {
        immediate: restartCancelled
          ? fence("[-] stopped (restart cancelled)")
          : heldDepth > 0
            ? fence(`[-] stopped - ${heldDepth} held in line`)
            : fence("[-] stopped"),
      };
    }
    case "hold": {
      if (!isOwner) return ownerOnly;
      const a = (arg ?? "").trim().toLowerCase();
      const on =
        a === "" ? !isHeld(ch) : a === "on" || a === "1" || a === "yes";
      if (a !== "" && !on && a !== "off" && a !== "0" && a !== "no")
        return { immediate: fence("[!] usage: /hold on|off") };
      const depth = midTurnQueues.get(ch.id)?.length ?? 0;
      if (on === isHeld(ch))
        return {
          immediate: on
            ? fence(`[ok] hold on - ${depth} in line`)
            : fence("[ok] hold off"),
        };
      setHeld(ch.id, on);
      if (on) {
        // Held messages wait their turn: disarm interrupts armed before
        // the hold. (An in-flight interrupt runs to completion — its
        // message was queued before the hold. agent_end skips held
        // channels, so the buffer does not drain on its own.)
        clearInterrupts(ch.id);
        return {
          immediate:
            depth > 0
              ? fence(`[ok] hold on - ${depth} in line`)
              : fence("[ok] hold on - buffered until /hold off"),
        };
      }
      // off: drain — send the oldest now when idle; the existing re-wake
      // loop (agent_end) chains the rest, one run each, in order.
      if (depth === 0) return { immediate: fence("[ok] hold off") };
      if (ctx.isIdle() && !isCompacting(ch.id)) {
        const entry = popChannelQueuedInbound(ch.id);
        // Awaits the drained inbound: its send must finish before this
        // command's reply lands, or the in-flight drain can leak into the
        // next message's turn (and the next test, in the suite).
        if (entry)
          await handleInbound(pi, entry.msg, ctx, true).catch((e) => {
            console.error(
              "[channel] hold drain failed:",
              sanitizeUnknownValue(e),
            );
          });
        return {
          immediate: fence(`[ok] hold off - ${depth} in line, running`),
        };
      }
      return { immediate: fence(`[ok] hold off - ${depth} in line, will run`) };
    }
    case "help":
      return { immediate: fence(HELP_TEXT) };
    case "btw": {
      const question = (arg || "").trim();
      if (!question) return { immediate: fence("[!] usage: /btw <question>") };
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
          `ctx ${typeof u?.percent === "number" ? `${Math.round(u.percent)}%` : "?"}`,
          `model ${model}`,
          `up ${up}`,
          // Open op window (compaction OR a restart-class op) shows its
          // label; otherwise the honest idle/running state.
          opWindowLabel(ch.id) ?? (ctx.isIdle() ? "idle" : "running"),
          // Tool-call display level (#10): quiet = 0 (text only),
          // verbose 1 = essential tools, verbose 2 = all.
          verboseLevel(ch) === 0 ? "quiet" : `verbose ${verboseLevel(ch)}`,
          // Channel hold (#39): plain messages buffer, runs don't start.
          isHeld(ch) ? "hold on" : null,
          // Queue depth (#47): mid-turn inbounds waiting for the run.
          midTurnQueues.get(ch.id)?.length
            ? `queue ${midTurnQueues.get(ch.id)!.length}`
            : null,
        ].filter(Boolean);
        // Interrupt state, honestly: in flight, or armed with time to fire.
        if (interruptingChannels.has(ch.id)) {
          parts.push("interrupting");
        } else {
          const pend = pendingInterrupts.get(ch.id);
          if (pend && pend.length > 0) {
            const msLeft = Math.max(
              0,
              Math.min(...pend.map((p) => p.at)) - Date.now(),
            );
            parts.push(`interrupt in ${Math.ceil(msLeft / 1000)}s`);
          }
        }
        text = fence(`[status] ${parts.join(" · ")}`);
      } catch {
        text = fence("[!] status unavailable");
      }
      return { immediate: text };
    }
    case "usage": {
      // #40: /usage last — the last completed run's tokens + est. cost
      // (in-memory; reset on bridge restart, like the rest of run state).
      const scope = (arg ?? "").trim().toLowerCase();
      if (scope === "last") {
        const lu = lastRunUsage.value;
        if (!lu) return { immediate: "no completed run yet (run one first)" };
        const at = lu.at.toISOString().slice(11, 19);
        return { immediate: usageSummary("last run", at, lu.stats) };
      }
      // Read-only token stats from the session store. Session discovery
      // reuses the /undo path: active ctx session file, else newest .jsonl
      // under cwd's session dir (findSessionFile fallback). The error
      // paths stay bare (one-liners, no tag); the stats list ships as
      // normal markdown - unfenced, no width budget (Andryo 2026-10-18).
      try {
        const text = await renderUsage(arg, ctx.cwd, safeSessionFile(ctx));
        return { immediate: text };
      } catch {
        return { immediate: fence("[!] usage stats unavailable") };
      }
    }
    case "context": {
      // #48: what is eating the window: top-N items by token ESTIMATE
      // (char/4, no model, no pricing) + category totals. Read-only, open
      // to all like /usage. Session discovery is the same /undo path;
      // the markdown list is built by renderContext, errors are one
      // [!] line (fenced machine one-liners stay fenced), no stack.
      try {
        const text = await renderContext(arg, ctx.cwd, safeSessionFile(ctx));
        // Success = the markdown summary list (unfenced - Andryo
        // 2026-10-18); [!] errors stay fenced one-liners.
        return { immediate: text.startsWith("[!]") ? fence(text) : text };
      } catch {
        // fenced, mirroring the /usage catch (PR #242 review F4)
        return { immediate: fence("[!] context stats unavailable") };
      }
    }
    case "diff": {
      // Read-only: git + upload to our own webdrop (issue #7). Open to all
      // channel members, like /jobs.
      try {
        const text = await publishDiff(ctx.cwd, arg);
        // #87: the viewer URL is the one link the user asked for - a
        // fenced URL is monospace, not clickable. Fence the status line,
        // leave the URL bare (publishDiff keeps the URL on its own last
        // line for exactly this split).
        const nl = text.lastIndexOf("\n");
        const last = nl > 0 ? text.slice(nl + 1) : "";
        if (/^https?:\/\/\S+$/i.test(last))
          return { immediate: `${fence(text.slice(0, nl))}\n${last}` };
        return { immediate: fence(text) };
      } catch {
        return { immediate: fence("[!] diff publish failed") };
      }
    }
    case "reset": {
      if (!isOwner) return ownerOnly;
      if (isCompacting(ch.id)) return { immediate: opBusyRefusal(ch.id) };
      setUserStoppedRun(true);
      clearInterrupts(ch.id);
      if (interruptingChannels.has(ch.id)) interruptCancelled.add(ch.id); // F7 guard
      // #84 L2: drain queued inbounds while the process is still alive — a
      // restart wipes the in-memory maps at shutdown (no Discord delete), so
      // a queued ack posted now would be orphaned in the channel forever.
      // A HELD channel's queue is the operator's buffer: keep it (/stop A4).
      const held = isHeld(ch);
      const dropped = held ? 0 : clearQueuedInbound(ch.id);
      if (dropped > 0)
        console.log(
          `[channel] /reset dropped ${dropped} queued mid-turn inbound(s)`,
        );
      try {
        ctx.abort();
      } catch {}
      // BLOCK the channel across the respawn (like /compact): placeholder
      // + live tick now, the respawn settles it (op marker), the cursor
      // rewind replays op-window inbounds after boot. /reset = NEW session:
      // move the session file aside at shutdown.
      const placeholderP = beginRestartOp(
        pi,
        ctx,
        ch,
        "reset",
        "resetting",
        "[new] new session (context cleared)",
      );
      scheduleOpShutdown(pi, ctx, ch, placeholderP, () => {
        const live = ctx.sessionManager?.getSessionFile?.();
        moveSessionFileAside(ctx, live);
        // Archive the OTHER stale .jsonl too: 'pi -c' (continueRecent) resumes
        // the newest .jsonl, so without this a /reset can resume a superseded
        // session (turns != 0) instead of a truly fresh one (issue #85).
        if (live) archiveStaleSessions(live);
      });
      return native
        ? { immediate: fence("[..] resetting...") }
        : { consumed: true };
    }
    case "restart": {
      if (!isOwner) return ownerOnly;
      // /restart = process restart that RESUMES this session: systemd respawns
      // 'pi -c' which continues the last session file (the opposite of
      // /reset, which moves that file aside first). Same block + tick +
      // cursor-replay dance as /reset, minus the session-file move.
      if (isCompacting(ch.id)) return { immediate: opBusyRefusal(ch.id) };
      setUserStoppedRun(true);
      clearInterrupts(ch.id);
      if (interruptingChannels.has(ch.id)) interruptCancelled.add(ch.id); // F7 guard
      // #84 L2: drain queued inbounds while the process is still alive — a
      // restart wipes the in-memory maps at shutdown (no Discord delete), so
      // a queued ack posted now would be orphaned in the channel forever.
      // A HELD channel's queue is the operator's buffer: keep it (/stop A4).
      const held = isHeld(ch);
      const dropped = held ? 0 : clearQueuedInbound(ch.id);
      if (dropped > 0)
        console.log(
          `[channel] /restart dropped ${dropped} queued mid-turn inbound(s)`,
        );
      try {
        ctx.abort();
      } catch {}
      const placeholderP = beginRestartOp(
        pi,
        ctx,
        ch,
        "restart",
        "restarting",
        "restarted - session resumed",
      );
      scheduleOpShutdown(pi, ctx, ch, placeholderP);
      return native
        ? { immediate: fence("[..] restarting...") }
        : { consumed: true };
    }
    case "undo": {
      if (!isOwner) return ownerOnly;
      if (isCompacting(ch.id)) return { immediate: opBusyRefusal(ch.id) };
      const n = parseUndoCount(arg);
      if (n === null)
        return { immediate: fence("[!] usage: /undo [N] (N is 1 or more)") };
      const r = await runUndo(ctx, n);
      if (!r.restarted) return { immediate: fence(r.text) };
      // #84 L2: drain queued inbounds while the process is still alive — a
      // restart wipes the in-memory maps at shutdown (no Discord delete), so
      // a queued ack posted now would be orphaned in the channel forever.
      // A HELD channel's queue is the operator's buffer: keep it (/stop A4).
      const held = isHeld(ch);
      const dropped = held ? 0 : clearQueuedInbound(ch.id);
      if (dropped > 0)
        console.log(
          `[channel] /undo dropped ${dropped} queued mid-turn inbound(s)`,
        );
      // performUndo already truncated the session file + parked the re-run
      // trigger (F1); the respawn resumes the pre-turn state. #46: N>1
      // removed every turn back to the Nth trigger in this ONE restart.
      // Block + tick + cursor replay across the respawn, like /reset.
      const placeholderP = beginRestartOp(
        pi,
        ctx,
        ch,
        "undo",
        "undoing",
        r.text,
      );
      scheduleOpShutdown(pi, ctx, ch, placeholderP);
      return native
        ? { immediate: fence("[..] undoing...") }
        : { consumed: true };
    }
    case "redo": {
      if (!isOwner) return ownerOnly;
      if (isCompacting(ch.id)) return { immediate: opBusyRefusal(ch.id) };
      const r = await runRedo(ctx);
      if (!r.restarted) return { immediate: fence(r.text) };
      // #84 L2: drain queued inbounds while the process is still alive — a
      // restart wipes the in-memory maps at shutdown (no Discord delete), so
      // a queued ack posted now would be orphaned in the channel forever.
      // A HELD channel's queue is the operator's buffer: keep it (/stop A4).
      const held = isHeld(ch);
      const dropped = held ? 0 : clearQueuedInbound(ch.id);
      if (dropped > 0)
        console.log(
          `[channel] /redo dropped ${dropped} queued mid-turn inbound(s)`,
        );
      const placeholderP = beginRestartOp(
        pi,
        ctx,
        ch,
        "redo",
        "redoing",
        r.text,
      );
      scheduleOpShutdown(pi, ctx, ch, placeholderP);
      return native
        ? { immediate: fence("[..] redoing...") }
        : { consumed: true };
    }
    case "verbose": {
      if (!isOwner) return ownerOnly;
      const a = (arg ?? "").trim().toLowerCase();
      const prev = verboseLevel(ch);
      // Bare command: show the current level (read-only, no change).
      if (a === "")
        return {
          immediate: fence(
            `[ok] verbose: ${prev} (${VERBOSE_LEVEL_NAMES[prev]})`,
          ),
        };
      const next = parseVerboseLevel(a);
      if (next === null)
        return { immediate: fence("[!] usage: /verbose 0|1|2") };
      verboseOverride.set(ch.id, next);
      persistChannelRuntimeState(ch.id, { verbose: next });
      // Live >0 -> 0 transition: delete the in-flight block so it does
      // not sit in history as a stale "working…" line. The closure-owned
      // hook is registered by the extension instance (module-level
      // command path, see onDeleteStatusBlock above).
      if (prev > 0 && next === 0) await onDeleteStatusBlock?.(ch);
      return {
        immediate: fence(
          `[ok] verbose: ${next} (${VERBOSE_LEVEL_NAMES[next]})`,
        ),
      };
    }
    case "compact": {
      if (!isOwner) return ownerOnly;
      const instructions = (arg || "").trim() || undefined;
      if (isCompacting(ch.id)) {
        // The channel's own op window is open: one op at a time, reject
        // the second instead of queueing it (F5: name the active op).
        return { immediate: opBusyRefusal(ch.id) };
      }
      if (!ctx.isIdle()) {
        // Run in progress (compact would abort it) or a compaction already
        // in flight: queue it. One slot — a later /compact replaces the
        // earlier. Flushed at agent_end or when the current compaction
        // settles (see pendingCompact + the flush handlers).
        const replacing = getPendingCompact() !== null;
        setPendingCompact({ ch, instructions });
        const why = agentBusy
          ? "run in progress"
          : "compact already in progress";
        return {
          immediate: fence(
            `[queued] compact (${why})${replacing ? ", replaces earlier" : ""}`,
          ),
        };
      }
      // Text path: startCompact posts the placeholder (armed with its live
      // tick) and reports settle-in-place. Native: the deferred interaction
      // shows the placeholder instead; the report posts fresh.
      const err = startCompact(pi, { ch, instructions }, ctx, !native);
      if (err !== null) {
        const t = channelError(err);
        if (t !== null) return { immediate: fence(`[!] compact failed: ${t}`) };
      }
      return native ? { immediate: COMPACT_PLACEHOLDER } : { consumed: true };
    }
    case "handover": {
      // Manual mechanism A: same path as /compact (reason=manual), the
      // handoff module builds the doc in session_before_compact when
      // handoff.enabled. Disabled → standard compact (same as /compact).
      if (!isOwner) return ownerOnly;
      const instructions = (arg || "").trim() || undefined;
      if (isCompacting(ch.id)) return { immediate: opBusyRefusal(ch.id) };
      if (!ctx.isIdle()) {
        const replacing = getPendingCompact() !== null;
        setPendingCompact({ ch, instructions });
        const why = agentBusy
          ? "run in progress"
          : "compact already in progress";
        return {
          immediate: fence(
            `[queued] handover (${why})${replacing ? ", replaces earlier" : ""}`,
          ),
        };
      }
      const settings = resolveHandoffSettings(ctx.cwd);
      const err = startCompact(pi, { ch, instructions }, ctx, !native);
      if (err !== null) {
        const t = channelError(err);
        if (t !== null)
          return { immediate: fence(`[!] handover failed: ${t}`) };
      }
      if (!settings.enabled)
        sendDiscordMessage(
          ch,
          styleGuard(
            "handoff disabled - standard compact (set handoff.enabled=true for the handover doc)",
          ),
        ).catch(() => {});
      return native ? { immediate: COMPACT_PLACEHOLDER } : { consumed: true };
    }
    case "jobs": {
      // History-only since the drain (#279): the dispatch lane is retired
      // (zero in-flight runs fleet-wide), so the kill/tail subcommands and
      // their dispatch scripts are gone with the completion side. The
      // history view is informational, open to all channel members
      // (private channel). json = machine output (fenced); text = the
      // markdown summary list (unfenced - Andryo 2026-10-18: no fence,
      // no width budget).
      const sub = ((arg || "").trim().split(/\s+/)[0] ?? "").toLowerCase();
      return {
        immediate: sub === "json" ? fence(jobsView("json")) : jobsView("text"),
      };
    }
    case "new-worktree": {
      // #12: create the interactive session's worktree (owner-only).
      if (!isOwner) return ownerOnly;
      const ref = (arg ?? "").trim() || undefined;
      try {
        return { immediate: fence(newWorktree(ctx.cwd, ref)) };
      } catch (e) {
        return {
          immediate: fence(
            `[!] worktree failed: ${channelError(e) ?? "error"}`,
          ),
        };
      }
    }
    case "merge-worktree": {
      // #12: merge the worktree branch back into the live checkout
      // (owner-only; optional arg `squash` = squash merge).
      if (!isOwner) return ownerOnly;
      const mode =
        (arg ?? "").trim().toLowerCase() === "squash" ? "squash" : "keep";
      try {
        return { immediate: fence(mergeWorktree(ctx.cwd, mode)) };
      } catch (e) {
        return {
          immediate: fence(`[!] merge failed: ${channelError(e) ?? "error"}`),
        };
      }
    }
    case "sleep": {
      if (!isOwner) return ownerOnly;
      const argText = (arg || "").trim();
      const sub = argText ? argText.split(/\s+/)[0]!.toLowerCase() : "list";
      if (sub === "list") {
        const names = new Map(
          loadChannelConfig(ctx.cwd).map((c) => [c.id, c.name]),
        );
        const wakes = loadWakes();
        if (wakes.length === 0)
          return { immediate: fence("[wake] no pending wakes") };
        const pending = wakes.filter((w) => w.status === "pending").length;
        const lines = wakes.map((w) => {
          const chName = names.get(w.channelId) || w.channelName || w.channelId;
          const at = new Date(w.wakeAt).toISOString();
          const m = Math.round((w.wakeAt - Date.now()) / 60000);
          const state =
            w.status === "claimed"
              ? "claimed"
              : m > 0
                ? `in ${formatDurationMs(m * 60000)}`
                : "due";
          const note = w.note ? ` \u00b7 note: ${w.note}` : "";
          return `- ${w.id} \u00b7 ${chName} \u00b7 ${at} (${state})${note}`;
        });
        return {
          immediate: `**[wake] ${pending} pending wake${
            pending > 1 ? "s" : ""
          } (of ${wakes.length} total)**\n\n${lines.join("\n")}`,
        };
      }
      if (sub === "cancel") {
        const id = argText.slice("cancel".length).trim();
        if (!id) return { immediate: fence("[!] usage: /sleep cancel <id>") };
        const ok = cancelWake(id);
        return {
          immediate: fence(
            ok ? `[ok] cancelled wake ${id}` : `[!] no wake with id ${id}`,
          ),
        };
      }
      return { immediate: fence("[!] usage: /sleep [list | cancel <id>]") };
    }
    case "tasks": {
      if (!isOwner) return ownerOnly;
      const argText = (arg || "").trim();
      const sub = argText ? argText.split(/\s+/)[0]!.toLowerCase() : "list";
      if (sub === "list") {
        const names = new Map(
          loadChannelConfig(ctx.cwd).map((c) => [c.id, c.name]),
        );
        const tasks = loadTasks();
        if (tasks.length === 0)
          return { immediate: fence("[tasks] no scheduled tasks") };
        const pending = tasks.filter((t) => t.status === "pending").length;
        const lines = tasks.map((t) =>
          formatTaskLine(t, names.get(t.channelId) || t.channelName),
        );
        return {
          immediate: `**[tasks] ${pending} pending task${
            pending > 1 ? "s" : ""
          } (of ${tasks.length} total)**\n\n${lines.join("\n")}`,
        };
      }
      if (sub === "cancel") {
        const id = argText.slice("cancel".length).trim();
        if (!id) return { immediate: fence("[!] usage: /tasks cancel <id>") };
        const ok = cancelTask(id);
        return {
          immediate: fence(
            ok ? `[ok] cancelled task ${id}` : `[!] no task with id ${id}`,
          ),
        };
      }
      if (sub === "add") {
        const rest = argText.slice("add".length).trim();
        const m = rest.match(/^"([^"]*)"\s*([\s\S]*)$/);
        if (!m)
          return {
            immediate: fence(
              '[!] usage: /tasks add "<prompt>" <minutes|ISO|cron [tz]>',
            ),
          };
        const prompt = m[1]!.trim();
        const spec = specStringParams(m[2] ?? "");
        if (!spec)
          return {
            immediate: fence(
              '[!] usage: /tasks add "<prompt>" <minutes|ISO|cron [tz]>',
            ),
          };
        const res = parseTaskSpec({ prompt, ...spec });
        if (!res.spec || res.error)
          return {
            immediate: fence(`[!] ${res.error ?? "invalid task spec"}`),
          };
        const task = scheduleTask({
          channelId: ch.id,
          channelName: ch.name,
          prompt,
          spec: res.spec,
        });
        return {
          immediate: fence(
            `[ok] task ${task.id} scheduled: ${taskWhenLabel(task)}, next fire ` +
              `${new Date(task.nextFireAt).toISOString()}, ` +
              `cancel with /tasks cancel ${task.id}`,
          ),
        };
      }
      if (sub === "reschedule") {
        const rest = argText.slice("reschedule".length).trim();
        const parts = rest.split(/\s+/).filter(Boolean);
        const id = parts[0] ?? "";
        if (!id)
          return {
            immediate: fence(
              "[!] usage: /tasks reschedule <id> <minutes|ISO|cron [tz]>",
            ),
          };
        // validate the id against THIS session's tasks before touching the spec
        const t = loadTasks().find((x) => x.id === id && x.channelId === ch.id);
        if (!t) return { immediate: fence(`[!] no task with id ${id}`) };
        const spec = specStringParams(parts.slice(1).join(" "));
        if (!spec)
          return {
            immediate: fence(
              "[!] usage: /tasks reschedule <id> <minutes|ISO|cron [tz]>",
            ),
          };
        const res = parseTaskSpec({ prompt: t.prompt, ...spec });
        if (!res.spec || res.error)
          return {
            immediate: fence(`[!] ${res.error ?? "invalid task spec"}`),
          };
        const r = rescheduleTask(id, res.spec, ch.id);
        if (!r.task || r.error)
          return { immediate: fence(`[!] ${r.error ?? "reschedule failed"}`) };
        return {
          immediate: fence(
            `[ok] rescheduled task ${r.task.id}: ${taskWhenLabel(t)} -> ` +
              `${taskWhenLabel(r.task)}, ` +
              `next fire ${new Date(r.task.nextFireAt).toISOString()}`,
          ),
        };
      }
      return {
        immediate: fence(
          "[!] usage: /tasks [list | add | reschedule | cancel]",
        ),
      };
    }
    case "todos": {
      // Informational, open to all channel members (private channel).
      // The board is a normal markdown list: bold header + bullets, full
      // text, no fence, no width budget (Andryo 2026-10-18).
      if ((arg || "").trim().toLowerCase() === "all") {
        const names = new Map(
          loadChannelConfig(ctx.cwd).map((c) => [c.id, c.name]),
        );
        const parts = listBoards()
          .filter((b) => b.todos.length > 0)
          .map((b) =>
            renderBoard(b.todos, names.get(b.channelId) ?? b.channelId),
          );
        return {
          immediate:
            parts.length > 0
              ? parts.join("\n\n")
              : fence("[todos] no open todos"),
        };
      }
      const board = loadBoard(ch.id);
      if (!board || board.todos.length === 0)
        return { immediate: fence("[todos] no open todos") };
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
        if (models.length === 0)
          return { immediate: fence("[model] no models available") };
        const names = models
          .slice(0, 20)
          .map((m: any) => `${m.provider}/${m.id}`);
        return {
          immediate: fence(
            `[model] ${models.length} available:\n${names.join("\n")}${models.length > 20 ? `\n…+${models.length - 20} more` : ""}`,
          ),
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
            immediate: fence(
              `[!] ambiguous "${req}": ${cands}${partial.length > 5 ? "…" : ""}`,
            ),
          };
        }
      }
      if (!found) return { immediate: fence(`[!] model not found: ${req}`) };
      const ok = await pi.setModel(found);
      return {
        immediate: fence(
          ok
            ? `[ok] model ${found.provider}/${found.id}`
            : `[!] no auth configured for ${found.provider}/${found.id}`,
        ),
      };
    }
    default:
      return {};
  }
}
