/**
 * channel/restart-ops.ts — restart-class ops: /reset /restart /undo
 * /redo, the op marker + shutdown scheduling, and handoff mechanism B
 * (restart-into-fresh-session).
 *
 * Extracted from channel/index.ts (god-file split 4/5, 2026-10-20).
 * Pure move — code is verbatim from index.ts; only import/export
 * boundaries were added.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  editDiscordMessage,
  getChannelCursor,
  sendDiscordMessage,
  setChannelCursor,
} from "./discord";
import {
  buildSeedKickoff,
  isHandoffFreshWindow,
  type KickoffLiveState,
  liveKickoffState,
  loadPreviousHandover,
  resolveHandoffSettings,
} from "./handover";
import {
  beginCompacting,
  type CompactingEntry,
  clearCompacting,
  compactingChannels,
  drainQueuedAfterCompact,
  handoffRestartArmed,
  lastActiveChannel,
  type OpLabel,
  opShutdownTimers,
  setHandoffRestartArmed,
  setUserStoppedRun,
} from "./index";
import { armOpTick, machine, opTickLine } from "./live";
import { clearQueuedInbound, midTurnQueues } from "./queue";
import { sanitizeUnknownValue } from "./sanitize";
import { defaultHome } from "./todos";
import {
  type ChannelConfig,
  getChannel,
  getDefaultChannel,
  loadChannelConfig,
  resolveSystemdUnit,
} from "./types";
import { findSessionFile, performRedo, performUndo } from "./undo";

// ─── /undo + /redo: session + file revert ──────────────────────────────
// See channel/undo.ts. The conversation revert works like /reset: pi resumes
// with the LAST line of the session file as leaf, so truncating the file and
// restarting pi takes the revert into effect.

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function safeSessionFile(ctx: ExtensionContext): string | null {
  try {
    return ctx.sessionManager?.getSessionFile?.() ?? null;
  } catch {
    return null;
  }
}

// ─── Restart-class ops: /reset /restart /undo /redo ────────────────────
// These restart the pi process (systemd respawns `pi -c`). The channel is
// blocked across the restart the same way compaction blocks it:
//   1. op window opens (inbound queued with [queued] ack, no interrupts)
//   2. placeholder posted + live-ticked (shared op-tick helper)
//   3. op marker written to .tmp/op-marker.json — the RESPAWNED process
//      settles the placeholder with finalText at its session_start
//   4. Discord cursor rewound to the pre-op value before shutdown —
//      inbounds delivered during the op replay after the restart
//      (persisted cursor + immediate first poll; nothing is lost)
//   5. bounded shutdown: wait for the aborted run to settle (2s cap), let
//      the placeholder land (1.5s cap), rewind, op-specific file work,
//      ask systemd to restart the unit early (skips the 5s RestartSec),
//      then ctx.shutdown()
const OP_SHUTDOWN_DELAY_MS = 300;
const OP_MARKER_TTL_MS = 10 * 60 * 1000;
interface OpMarker {
  op: string;
  channelId: string;
  at: number;
  /** Placeholder message id (null = post failed; respawn posts fresh). */
  msgId: string | null;
  /** Final line the respawn posts into the channel. */
  finalText: string;
  /** Handoff op only (mechanism B, F4): false until the respawn seeds
   *  the fresh session from the doc. The op marker is the ONLY seed
   *  gate — reset/restart/undo/redo markers never carry seeded:false,
   *  so ordinary boots (incl. OOM respawns without a handoff) never
   *  seed. */
  seeded?: boolean;
}
const opMarkerPath = (cwd: string) => path.join(cwd, ".tmp", "op-marker.json");

function writeOpMarker(
  ctx: ExtensionContext,
  ch: ChannelConfig,
  op: string,
  finalText: string,
  marker?: { seeded?: boolean },
): void {
  try {
    const p = opMarkerPath(ctx.cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const m: OpMarker = {
      op,
      channelId: ch.id,
      at: Date.now(),
      msgId: null,
      finalText,
    };
    if (marker?.seeded !== undefined) m.seeded = marker.seeded;
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.error("[op] marker write failed:", sanitizeUnknownValue(e));
  }
}

function updateOpMarkerMsgId(
  ctx: ExtensionContext,
  channelId: string,
  msgId: string,
): void {
  try {
    const p = opMarkerPath(ctx.cwd);
    const m = JSON.parse(fs.readFileSync(p, "utf-8")) as OpMarker;
    if (!m || m.channelId !== channelId) return;
    m.msgId = msgId;
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m));
    fs.renameSync(tmp, p);
  } catch {
    /* placeholder post failed or marker gone — fresh-post fallback */
  }
}

/** Respawn-side settle: replace the dead process's op placeholder with
 *  the final line. Called from session_start. Stale markers (>10m —
 *  e.g. pi crashed and the channel sat dark) are dropped, not shown.
 *
 *  Mechanism B seed (F4): ONLY a handoff marker with seeded!=true seeds
 *  the fresh session (sendUserMessage with the doc digest + forced
 *  read of latest.md), then the marker is flipped seeded=true and
 *  unlinked. The flip happens AFTER the send: a crash between them
 *  re-seeds the next boot (harmless duplicate), while a flip-before-
 *  send crash would lose the seed entirely. */
export function consumeOpMarker(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const p = opMarkerPath(ctx.cwd);
  let m: OpMarker | null = null;
  try {
    m = JSON.parse(fs.readFileSync(p, "utf-8")) as OpMarker;
  } catch {
    return; // no marker — normal boot
  }
  const valid =
    typeof m?.channelId === "string" &&
    typeof m?.finalText === "string" &&
    m.finalText.length > 0;
  if (valid && m.op === "handoff" && m.seeded !== true) {
    try {
      seedFromHandoffDoc(pi, ctx);
      markHandoffSeeded(ctx);
    } catch (e) {
      console.error("[handoff] boot seed failed:", sanitizeUnknownValue(e));
    }
  }
  try {
    fs.unlinkSync(p);
  } catch {}
  if (!valid) return;
  if (typeof m.at !== "number" || Date.now() - m.at > OP_MARKER_TTL_MS) {
    console.log(`[op] ${m.op ?? "?"} marker stale (>10m) — dropped`);
    return;
  }
  const ch = getChannel(loadChannelConfig(ctx.cwd), m.channelId);
  if (ch?.type !== "discord") return;
  console.log(
    `[op] ${m.op} settled: channel ${ch.id} back in service (cursor rewound, inbounds replay)`,
  );
  if (m.msgId)
    editDiscordMessage(ch, m.msgId, machine(m.finalText)).catch(() =>
      sendDiscordMessage(ch, machine(m.finalText)).catch(() => {}),
    );
  else sendDiscordMessage(ch, machine(m.finalText)).catch(() => {});
}

/** Flip seeded=true on the handoff op marker (F4 crash-safety flip). */
function markHandoffSeeded(ctx: ExtensionContext): void {
  try {
    const p = opMarkerPath(ctx.cwd);
    const m = JSON.parse(fs.readFileSync(p, "utf8")) as OpMarker;
    if (m?.op !== "handoff") return;
    m.seeded = true;
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.error("[handoff] seeded flip failed:", sanitizeUnknownValue(e));
  }
}

/** Mechanism B: seed the fresh session from the handover doc (F4/F8).
 *  A plain user message (pi.sendUserMessage — always triggers a turn),
 *  NOT a channel-inbound entry: it must not echo to Discord, and the
 *  next handover's "last 3 user asks" keys on channel-inbound entries.
 *  The seed itself cannot re-trigger a handoff: the fresh session is far
 *  under the threshold, and the fresh-window guard (latest.md < 5m)
 *  blocks handoffs for this session either way. */
function seedFromHandoffDoc(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const settings = resolveHandoffSettings(ctx.cwd);
  const doc = loadPreviousHandover({ storeDir: settings.storeDir });
  if (!doc) {
    console.log("[handoff] no handover doc at boot - seed skipped");
    return;
  }
  // Live dispatch + board state (issue #134): the deterministic doc has no
  // Mission/In-flight sections, so the seed reads the SAME sources the doc's
  // State box renders - fresh at restart, not scraped from the doc.
  const live = liveKickoffStateHook
    ? liveKickoffStateHook(ctx.cwd)
    : liveKickoffState(ctx.cwd);
  pi.sendUserMessage(
    buildSeedKickoff(doc, settings.storeDir, defaultHome(), live),
  );
  console.log("[handoff] seeded fresh session from the handover doc");
}

/** Drop the op marker (F1: /stop cancels the op — no respawn comes from
 *  this process, so a stale marker must not settle the old placeholder
 *  on the next unrelated boot). */
export function clearOpMarker(ctx: ExtensionContext): void {
  try {
    fs.unlinkSync(opMarkerPath(ctx.cwd));
  } catch {}
}

let systemdRestartHook: ((unit: string) => void) | null = null;
/** Override the early-restart trigger (tests: no real systemctl around). */
export function setSystemdRestartHookForTest(
  fn: ((unit: string) => void) | null,
): void {
  systemdRestartHook = fn;
}

let liveKickoffStateHook: ((cwd: string) => KickoffLiveState) | null = null;
/** Override the live seed-state source (tests: no real ps / board around).
 *  The boot-seed wiring calls liveKickoffState (ps + todo board), which is
 *  environment-dependent — tests pin it with this hook. */
export function setLiveKickoffStateHookForTest(
  fn: ((cwd: string) => KickoffLiveState) | null,
): void {
  liveKickoffStateHook = fn;
}

let processExitHook: ((code: number) => void) | null = null;
/** Override process.exit (tests: the watchdog F7 death must not kill the
 *  runner). */
export function setProcessExitHookForTest(
  fn: ((code: number) => void) | null,
): void {
  processExitHook = fn;
}

/** The restart command for a resolved unit name (issue #28: the unit is
 *  NOT hardcoded — see resolveSystemdUnit). */
export function buildRestartCommand(unit: string): string {
  return `sleep 3; systemctl --user restart ${unit}`;
}

/** Shortcut the 5s systemd RestartSec wait: ask systemd to restart the
 *  unit ~3s from now — by then our own shutdown has run, so the stop is
 *  a no-op and the start is immediate. If this never lands (systemd not
 *  there, hook eaten) the unit's Restart=always still covers us. */
function requestSystemdRestart(unit: string): void {
  if (systemdRestartHook) {
    systemdRestartHook(unit);
    return;
  }
  if (!process.env.XDG_RUNTIME_DIR) {
    // #28: this early return used to be silent — an operator reading the
    // channel would never know the restart shortcut was skipped.
    console.error(
      `[op] no XDG_RUNTIME_DIR - not under a systemd user unit; cannot ask systemd to restart ${unit} (relying on unit auto-restart)`,
    );
    return;
  }
  try {
    const p = spawn("sh", ["-c", buildRestartCommand(unit)], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    p.on("error", () => {});
    p.unref();
  } catch {
    /* auto-restart covers it */
  }
}

/** Open the op window + post/ARM the ticking placeholder + write the op
 *  marker the respawn settles. Returns the placeholder post promise
 *  (scheduleOpShutdown awaits it, bounded). */
export function beginRestartOp(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  ch: ChannelConfig,
  op: string,
  label: OpLabel,
  finalText: string,
  marker?: { seeded?: boolean },
): Promise<string | null> {
  beginCompacting(pi, ch, ctx, {
    label,
    rewindTo: getChannelCursor(ch.id),
  });
  writeOpMarker(ctx, ch, op, finalText, marker);
  if (ch.type !== "discord") return Promise.resolve(null);
  // One-line op status = machine surface: italic, no code fence (Andryo
  // 2026-10-31); the op-tick edits it in place (opTickLine).
  return sendDiscordMessage(ch, machine(`[..] ${label}...`))
    .then((r) => {
      if (r.success && r.messageId) {
        updateOpMarkerMsgId(ctx, ch.id, r.messageId);
        armOpTick(`op:${ch.id}`, ch, r.messageId, (secs) => {
          const entry = compactingChannels.get(ch.id);
          return entry ? opTickLine(entry.label, secs) : null;
        });
      }
      return r.success ? (r.messageId ?? null) : null;
    })
    .catch(() => null);
}

/** Rewind the Discord cursor to the pre-op value (persisted) so the
 *  respawn's immediate first poll replays op-window inbounds. */
function rewindOpCursor(ch: ChannelConfig): void {
  const entry = compactingChannels.get(ch.id);
  if (entry?.rewindTo) setChannelCursor(ch.id, entry.rewindTo);
}

/** #28 (partial): a restart that never lands (no systemd, unit dead,
 *  hook eaten) leaves the op window open forever. Arm a ~15s watchdog
 *  after the restart request: a successful respawn kills this process
 *  (ctx.shutdown below), so if the timer still fires with the SAME
 *  window entry open, the restart failed. Close the window, drain the
 *  queue, and tell the owner which unit to check. */
const RESTART_WATCHDOG_MS = 15_000;
function armRestartWatchdog(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  ch: ChannelConfig,
  unit: string,
  entry: CompactingEntry,
): void {
  const t = setTimeout(() => {
    // Entry mismatch = window already closed (settle, /stop cancel) or
    // replaced by a newer op — not a failure. Unref'd: a healthy process
    // exit removes the timer with it.
    if (compactingChannels.get(ch.id) !== entry) return;
    console.error(
      `[op] ${ch.id} restart failed - process still alive ${RESTART_WATCHDOG_MS / 1000}s after the request (unit: ${unit})`,
    );
    clearOpMarker(ctx); // the respawn that would settle it never came
    clearCompacting(ch.id); // also drops the pending op-shutdown timer
    drainQueuedAfterCompact(pi, ctx);
    const line = machine(`restart failed - check unit ${unit}`);
    if (ch.type === "discord") sendDiscordMessage(ch, line).catch(() => {});
    // F7 (design v2, PR2): a swallowed restart leaves THIS process alive
    // and the unit "active" — systemd will never auto-respawn it. Die on
    // purpose (after the post lands): Restart=always respawns 'pi -c',
    // which loads the small session file and settles the op marker.
    const exitTimer = setTimeout(
      () => (processExitHook ?? process.exit.bind(process))(1),
      500,
    );
    exitTimer.unref?.();
  }, RESTART_WATCHDOG_MS);
  t.unref?.();
}

export function scheduleOpShutdown(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  ch: ChannelConfig,
  placeholderP: Promise<string | null>,
  preShutdown?: () => void,
): void {
  const entry = compactingChannels.get(ch.id);
  const timer = setTimeout(() => {
    opShutdownTimers.delete(ch.id);
    void (async () => {
      // F1 (owner: cancel): the window was cleared before this fired
      // (/stop) — the op is off. Skip the whole chain: no preShutdown
      // (session-file move), no systemd restart request, no ctx.shutdown.
      // clearCompacting drops the timer; this check covers a stop that
      // landed after the callback was already queued.
      if (!entry || compactingChannels.get(ch.id) !== entry) {
        console.log(
          `[op] ${ch.id} window closed before shutdown — op cancelled`,
        );
        return;
      }
      // Bounded settle: the aborted run is usually done in ms; a stuck
      // session must not hold the respawn hostage (2s cap, then go).
      const t0 = Date.now();
      while (!ctx.isIdle() && Date.now() - t0 < 2000) await sleep(50);
      // Let the placeholder post land (bounded) so the respawn can edit
      // it in place; a failed post gets the fresh-line fallback there.
      try {
        await Promise.race([placeholderP, sleep(1500)]);
      } catch {}
      rewindOpCursor(ch);
      try {
        preShutdown?.();
      } catch (e) {
        console.error(`[op] ${ch.id} pre-shutdown failed, forcing respawn:`, e);
        process.exit(1); // F3 parity: never leave a zombie half-state
      }
      const unit = resolveSystemdUnit(ctx.cwd);
      requestSystemdRestart(unit);
      armRestartWatchdog(pi, ctx, ch, unit, entry);
      try {
        ctx.shutdown();
      } catch {
        process.exit(1);
      }
    })();
  }, OP_SHUTDOWN_DELAY_MS);
  opShutdownTimers.set(ch.id, timer);
}

/** /reset = NEW session: move the current session file aside so the
 *  systemd respawn's 'pi -c' starts fresh. (ctx.newSession does NOT exist
 *  on event ctx — only on registerCommand ctx — reviewer F1, 2026-09-10.)
 *  F5 (2026-09-23 handoff review): move the EXPLICIT live file
 *  (ctx.sessionManager.getSessionFile(), passed by the caller); the
 *  newest-by-mtime scan is a fallback ONLY when that file is gone. The
 *  old mtime-only path picked the wrong file whenever two session files
 *  were live at once (encDir string mismatch + multi-channel ops). */
export function moveSessionFileAside(
  ctx: ExtensionContext,
  targetFile?: string | null,
): void {
  let explicit: string | null = null;
  try {
    explicit = targetFile ?? ctx.sessionManager?.getSessionFile?.() ?? null;
  } catch {
    explicit = targetFile ?? null;
  }
  if (explicit) {
    try {
      if (fs.existsSync(explicit)) {
        fs.renameSync(explicit, `${explicit}.reset-${Date.now()}`);
        return;
      }
      console.warn(
        `[reset] explicit session file missing, falling back to mtime scan: ${explicit}`,
      );
    } catch (e) {
      console.warn(
        `[reset] explicit move failed, falling back to mtime scan: ${sanitizeUnknownValue(e)}`,
      );
    }
  }
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
}

/** F2 (mechanism B, PR2): after the live session file is moved aside by
 *  preShutdown, archive EVERY OTHER .jsonl in the same session dir to
 *  .jsonl.stale-<ts>. The respawn runs 'pi -c' (continueRecent = newest
 *  .jsonl by mtime) — the 2nd-newest is exactly what it would pick, so
 *  without this the "fresh" boot can resume a huge superseded session.
 *  Superseded files stay on disk for PR3's GC sweep. Best-effort: an
 *  archive failure must not abort the restart. */
export function archiveStaleSessions(liveFile: string): void {
  const dir = path.dirname(liveFile);
  const ts = Date.now();
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue; // skips *.jsonl.reset-* / *.stale-*
      const p = path.join(dir, f);
      if (p === liveFile) continue; // preShutdown step 1 already moved it
      fs.renameSync(p, `${p}.stale-${ts}`);
      n++;
    }
  } catch (e) {
    console.warn(
      `[handoff] stale session archive failed: ${sanitizeUnknownValue(e)}`,
    );
  }
  if (n > 0)
    console.log(`[handoff] archived ${n} stale session file(s) in ${dir}`);
}

// ─── Handoff mechanism B: restart-into-fresh-session (design v2) ────────
// Registered on session_compact AFTER the settle ran (F1: the
// compaction window is already closed when the gate decides, so the
// restart op it opens cannot be swept by the settle it reacts to).
// Issue #85 follow-up: EVERY handoff-qualifying compact restarts into a
// fresh seeded session (the file-size cap is gone). The fresh-window
// guard (isHandoffFreshWindow, 5 min) keeps the seeded session from
// immediately re-handoffing and restarting again. Reuses the SAME
// /reset restart chain (op window + marker + cursor rewind + bounded
// shutdown + systemd restart + watchdog). Deferred one macrotask:
// on the MANUAL compact path pi's ctx.compact wrapper calls its
// onComplete belt (clearCompacting) AFTER the session_compact emit —
// a synchronous window open would be wiped by that belt. A 0ms timer
// runs after all pending microtasks (emit + compaction_end + belt).
export function handoffRestartForSize(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  setTimeout(() => {
    try {
      void maybeHandoffRestart(pi, ctx);
    } catch (e) {
      console.error("[handoff] restart gate failed:", sanitizeUnknownValue(e));
    }
  }, 0);
}

/** The restart chain (exported for direct tests). Issue #85 follow-up:
 *  every handoff-qualifying compact (manual /compact, threshold ≥80% auto)
 *  restarts into a fresh seeded session — the file-size cap is gone.
 *  The fresh-window guard (isHandoffFreshWindow) keeps the just-seeded
 *  session from immediately re-handoffing and restarting again. */
export async function maybeHandoffRestart(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const settings = resolveHandoffSettings(ctx.cwd);
  if (!settings.enabled) return;
  const ch = lastActiveChannel ?? getDefaultChannel(loadChannelConfig(ctx.cwd));
  if (ch?.type !== "discord") return;
  // A settle-flushed /compact re-opened the window (label "compacting"):
  // let it finish — its own settle re-runs this gate. Opening the op here
  // would orphan the in-flight compaction's window + belt.
  if (compactingChannels.get(ch.id)?.label === "compacting") return;
  // Fresh window: a handover doc was written <5 min ago (possibly with a
  // restart + seed still pending). Don't re-restart on the seeded
  // session's first settle — it would loop. The compact that just WROTE the
  // doc is exempt: its own write set the window, and THAT compact is the
  // restart the doc triggers (issue #85: compact -> NEW session, /usage
  // turns -> 0). Consume the arm at this decision either way.
  const armed = handoffRestartArmed;
  setHandoffRestartArmed(false);
  if (!armed && isHandoffFreshWindow(settings.storeDir)) return;
  let live: string | null = null;
  try {
    live = ctx.sessionManager?.getSessionFile?.() ?? null;
  } catch {
    live = null;
  }
  if (!live) return;
  let size: number;
  try {
    size = fs.statSync(live).size;
  } catch {
    return; // file gone — nothing to gate on
  }
  const mb = (size / (1024 * 1024)).toFixed(1);
  console.log(`[handoff] compact settled - restart op (session file ${mb}MB)`);
  // F4: the op marker carries seeded:false — the respawn's session_start
  // seeds the fresh session from the doc (the ONLY seed gate). F5: move
  // the EXPLICIT live file at shutdown; F2: archive the other stale
  // .jsonl so the respawn's 'pi -c' resume target is provably small.
  const finalText = `context handoff -> new session (file was ${mb} MB)`;
  const placeholderP = beginRestartOp(
    pi,
    ctx,
    ch,
    "handoff",
    "handing-off",
    finalText,
    { seeded: false },
  );
  scheduleOpShutdown(pi, ctx, ch, placeholderP, () => {
    moveSessionFileAside(ctx, live);
    archiveStaleSessions(live);
  });
}

// /undo + /redo share the idle guard: abort the in-flight run, drop the
// mid-turn re-wake queue (F11: otherwise agent_end starts a fresh run
// that /undo then truncates or kills mid-flight), then wait for idle.
// Bounded — a stuck agent should not block the command forever.
async function waitIdle(ctx: ExtensionContext, label: string): Promise<void> {
  if (ctx.isIdle()) return;
  setUserStoppedRun(true);
  try {
    ctx.abort();
  } catch {}
  let dropped = 0;
  for (const chId of [...midTurnQueues.keys()])
    dropped += clearQueuedInbound(chId);
  if (dropped > 0)
    console.log(`[undo] ${label} dropped ${dropped} queued re-wake inbound(s)`);
  const t0 = Date.now();
  while (!ctx.isIdle() && Date.now() - t0 < 3000) await sleep(100);
}

/**
 * /undo arg (issue #46): N = how many assistant turns to revert, 1 or
 * more. Bare /undo = 1 (legacy behavior). 0 / negative / non-numeric ->
 * null: the command case answers one [!] usage line, no action.
 * Exported for tests.
 */
export function parseUndoCount(arg: string | undefined): number | null {
  const s = (arg ?? "").trim();
  if (s === "") return 1;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && Number.isSafeInteger(n) ? n : null;
}

export async function runUndo(
  ctx: ExtensionContext,
  n = 1,
): Promise<{ text: string; restarted: boolean }> {
  await waitIdle(ctx, "undo");
  const sessionFile = safeSessionFile(ctx) ?? findSessionFile(ctx.cwd);
  // The /undo command case owns the block + tick + op shutdown when the
  // restart actually happens (see beginRestartOp / scheduleOpShutdown).
  // #46: N>1 reverts several turns in this ONE restart-class op.
  return performUndo(sessionFile, n);
}

export async function runRedo(
  ctx: ExtensionContext,
): Promise<{ text: string; restarted: boolean }> {
  await waitIdle(ctx, "redo"); // F6: busy /redo raced the re-wake + restart
  return performRedo();
}
