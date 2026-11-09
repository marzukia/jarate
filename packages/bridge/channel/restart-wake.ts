// restart-wake — post-restart wake (issue #111, P0; the self-post removed
// by hall-monitor#757 leg B, 2026-11-09).
//
// When the pi process really starts (session_start reason "startup"), the
// UNCLEAN class (no fresh clean-stop marker: crash / OOM / SIGKILL / power
// loss) fires ONE fire-and-forget back_online liveness event to
// hall-monitor (POST /api/fleet/liveness/event, liveness-event.ts). The
// channel line arrives, when it lands, via the hall-monitor webhook leg
// under a non-agent identity — the bridge no longer self-posts the
// "back online" line (the self-signal class is gone; the sweep + the 30s
// live marker remain the independent signal). An event POST failure is
// log-only, never a startup failure.
//
// The event detail carries the pre-leg-B card text, plain (the italic
// channel markup is the webhook leg's format concern, not the event's):
//   - `restart-wake · unplanned` — the unplanned-restart signal
//   - bg runs in flight at restart: a compact suffix on the SAME line:
//     `restart-wake · unplanned · in-flight N` (N = count of
//     state=running records; job rows live in /jobs)
//   - the PLANNED class posts nothing (the startup message is the one
//     post, #328): no event, no card
//
// Guards (issue #111, adapted to leg B):
//   - never blocks startup: the caller fires and forgets (void + catch);
//     the event POST is bounded — one attempt, 10s hard timeout,
//     log-only on failure (a dead hall-monitor must not take startup down)
//   - hall-monitor config unset (JARATE_INBOX_URL/JARATE_INBOX_KEY)
//     = one local log line, no event (dev runs degrade to the sweep +
//     marker)
//   - two startups racing within 60s post once (atomic O_EXCL claim)
//   - hot reload / session switch (reason != "startup") never posts
//
// ("post" in the marker layout + #322 guards + #328 one-post-per-restart
// below means the liveness event POST since leg B.)
//
// Marker layout (runtime state dir, <agent-cwd>/.tmp on the live boxes):
//   clean-stop        last session_shutdown timestamp (written on every
//                     shutdown, consumed on the next process start)
//   restart-wake.lock last wake claim, `#322 G3 format: <epoch-ms> <class>
//                     <posted:0|1>`; a posted same-class claim suppresses
//                     for WAKE_DEDUP_POSTED_WINDOW_MS (5m), an unposted
//                     claim (crash between claim and post) never suppresses
//
// #322 guards (deterministic, no inference in the enforcement path):
//   - G1: runRestartWake logs ONE line for EVERY terminal reason
//     (posted | post-failed | dedup suppressed | no-channel | not-startup |
//     suppressed-planned); the dedup path is no longer silent (the
//     thin-record class is gone)
//   - G2: per-agent per-window numeric audit: starts ==
//     posted + dedup + post-failed + no-channel + suppressed-planned;
//     a violation logs one flag line (pure numeric compare)
//   - G3: the claim file carries a posted flag; the window suppresses
//     ONLY when the prior same-class claim is in-window AND posted=1
//   - #328: exactly ONE post per restart start — the planned class
//     posts ONLY the startup message (this wake is suppressed, reason
//     "suppressed-planned"); the unclean class posts ONLY the wake
//     card (the startupMessage post is suppressed for this start via
//     the shared once-per-process flag in startup-suppress.ts, set
//     before the claim so a deduped crash-flap start suppresses too)
//
// Out of scope here (documented follow-ups, see PR body):
//   - P1-2/P1-3 cursor-replay holes can still lose queued inbounds across
//     a crash; this wake only tells the operator the work is in flight.
//   - actually RESUMING the runs (re-dispatch into the same worktree,
//     watchdog double-DEAD guard, marker from pi-restart) — issue #111
//     "deeper resume".

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { egressText } from "./discord";
import { resolveLivenessTarget, sendLivenessEvent } from "./liveness-event";
import { suppressStartupMessageForThisStart } from "./startup-suppress";

// ─── constants ───────────────────────────────────────────────────────────

/** A clean-stop marker older than this no longer describes the stop right
 *  before this start — classify unclean (default: 24h). */
export const CLEAN_STOP_MAX_AGE_MS = 24 * 3_600_000;

/** Dedup window for a prior claim that actually POSTED (issue #322 G3,
 *  piboy ruling 2026-11-02: 5 minutes, op-adjustable). Sized to the
 *  crash-flap double-start class; the rotation-cycle overlap (13-35m)
 *  is now harmless because suppression is at most a duplicate card,
 *  never a lost signal - G1 logs every suppression. An UNPOSTED claim
 *  (crash between claim and post) never suppresses, so the signal
 *  cannot go dark across two consecutive restarts. */
export const WAKE_DEDUP_POSTED_WINDOW_MS = 5 * 60_000;

/** G2 audit window: per-agent startup/outcome counts are tallied per
 *  window; the closed window is evaluated (starts == accounted) when a
 *  new window's event arrives. */
export const WAKE_AUDIT_WINDOW_MS = 60 * 60_000;

/** Cap the inflight list (a restart can strand many tickets; keep the
 *  message bounded, point at /jobs for the rest). */
export const MAX_INFLIGHT = 10;

// ─── run records ─────────────────────────────────────────────────────────

/** One pi-bg run record (~/.pi-dispatch/runs/pi-bg-<id>.json). */
export interface RunRecord {
  run: string;
  profile?: string | null;
  project?: string | null;
  cwd?: string | null;
  /** ISO timestamp, e.g. "2026-09-24T13:38:52Z" */
  started?: string;
  delivery?: string;
  state?: string;
  finished?: string;
  reason?: string;
}

/** Default run-record dir (mirrors pi-bg: $PI_DISPATCH_RECORD_DIR or
 *  ~/.pi-dispatch/runs). */
export function defaultRunDir(): string {
  return (
    process.env.PI_DISPATCH_RECORD_DIR ||
    path.join(os.homedir(), ".pi-dispatch", "runs")
  );
}

/** Read every run record in dir. Missing/corrupt entries are skipped —
 *  the wake must never fail on a half-written record. */
export function readRunRecords(runDir: string): RunRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(runDir);
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(
        fs.readFileSync(path.join(runDir, n), "utf8"),
      ) as unknown;
      if (rec && typeof rec === "object" && "run" in rec) {
        out.push(rec as RunRecord);
      }
    } catch {
      // corrupt record: skip (same fault tolerance as pi-bg itself)
    }
  }
  return out;
}

/** state=running records, oldest first, capped at limit. `more` = the
 *  number dropped past the cap. */
export function selectInflight(
  runs: RunRecord[],
  limit: number = MAX_INFLIGHT,
): { list: RunRecord[]; more: number } {
  const inflight = runs.filter((r) => r.state === "running");
  inflight.sort((a, b) =>
    String(a.started ?? "").localeCompare(String(b.started ?? "")),
  );
  const list = inflight.slice(0, limit);
  return { list, more: inflight.length - list.length };
}

// ─── message builder ─────────────────────────────────────────────────────

export function elapsedSeconds(
  started: string | undefined,
  now: number,
): number {
  const t = Date.parse(started ?? "");
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 1000));
}

/** "23s" | "45m" | "3h12m" | "2d" (same shapes as /jobs). */
export function elapsedStr(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400)
    return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d`;
}

/** The machine-wake marker: the wake post's CONTENT prefix (Andryo
 *  2026-10-31 plain-italic shape: the post is ONE italic line,
 *  `*restart-wake · planned|unplanned*` - no embed at all). The marker
 *  is NOT the wake predicate — isBgWebhook (discord.ts) exempts ANY
 *  webhook-posted message (Andryo 2026-10-20); without a
 *  webhook_id the other-bot filter swallows the message and the wake
 *  never lands. isBgCallbackBody matches the prefix (legacy in-flight
 *  cards match via the serialized `Author: pi-bg` embed instead). */
export const WAKE_TAG = "restart-wake \u00b7";

/** The wake post body: ONE short italic content line (Andryo 2026-10-31
 *  - machine surfaces are plain text + italics, no embeds). Kept since
 *  leg B: the event detail is derived from this line (the channel
 *  markup is the webhook leg's concern; the result's `message` field
 *  still carries the pre-leg-B shape for logs/audit). */
export interface WakePayload {
  content: string;
}

export interface WakeMessageOpts {
  /** true = the last stop ran session_shutdown (planned restart). */
  clean: boolean;
  runs: RunRecord[];
  now?: number;
}

/** Build the wake post payload (Andryo 2026-10-31: ONE short italic
 *  line, no more than a few words - no embed, no description, no
 *  footer). Pure — all I/O is injected by the caller.
 *
 *  The content is `*restart-wake · <planned|unplanned>*` (the
 *  planned/unplanned distinction is the functional signal), with a
 *  compact suffix ` · in-flight N` on the SAME line when bg runs were
 *  in flight at the restart (N = count of state=running records; the
 *  old multiline ticket field is gone - job rows are `run profile
 *  elapsed` in /jobs). */
export function buildWakePayload({
  clean,
  runs,
}: WakeMessageOpts): WakePayload {
  const klass = clean ? "planned" : "unplanned";
  const count = runs.filter((r) => r.state === "running").length;
  const line =
    count > 0
      ? `restart-wake \u00b7 ${klass} \u00b7 in-flight ${count}`
      : `restart-wake \u00b7 ${klass}`;
  return { content: `*${line}*` };
}

// ─── clean-stop marker ───────────────────────────────────────────────────

export type RestartClass = "planned" | "unclean";

export function cleanStopPath(stateDir: string): string {
  return path.join(stateDir, "clean-stop");
}

/** Write the clean-stop marker (called from session_shutdown). Atomic
 *  tmp+rename; returns false on I/O failure (the next start just reads
 *  "unclean" — acceptable: a clean stop whose marker write failed is
 *  indistinguishable from a crash). */
export function writeCleanStop(stateDir: string, now = new Date()): boolean {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const p = cleanStopPath(stateDir);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, `${now.toISOString()}\n`);
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

/** Classify + CONSUME the clean-stop marker.
 *
 *  present + fresh  = planned (the last stop ran session_shutdown)
 *  absent/stale     = unclean (crash / OOM / SIGKILL / power loss, or a
 *                     marker so old it no longer describes this stop)
 *
 *  The marker is deleted either way: it describes the shutdown right
 *  before this start, which has now been accounted for. Only called on
 *  a real process start (reason "startup") — in-process /new and /reload
 *  cycles leave it in place.
 */
export function readCleanStop(
  stateDir: string,
  now = Date.now(),
  maxAgeMs: number = CLEAN_STOP_MAX_AGE_MS,
): RestartClass {
  const p = cleanStopPath(stateDir);
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(p, "utf8").trim();
  } catch {
    raw = null;
  }
  try {
    fs.unlinkSync(p);
  } catch {
    // already gone (racing start) — harmless
  }
  if (!raw) return "unclean";
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return "unclean"; // unparseable = stale
  const age = now - t;
  if (age < 0 || age > maxAgeMs) return "unclean";
  return "planned";
}

// ─── startup dedup ───────────────────────────────────────────────────────

export function wakeLockPath(stateDir: string): string {
  return path.join(stateDir, "restart-wake.lock");
}

/** The claim file's parsed content. #322 G3: `<epoch-ms> <class>
 *  <posted:0|1>` — a 2-field file is the pre-G3 format (`<epoch-ms>
 *  <class>`) and a 1-field file the original (`<epoch-ms>`); both are
 *  treated as posted=0 (no log evidence they posted, so they never
 *  suppress). */
export interface WakeClaimPrev {
  t: number;
  klass: string | null;
  posted: boolean;
}

export interface WakeClaimResult {
  claimed: boolean;
  /** The prior claim the decision was based on; non-null whenever the
   *  lock file existed (including unreadable ones: held, unknown age). */
  prev: WakeClaimPrev | null;
}

function parseClaim(raw: string): WakeClaimPrev {
  const f = raw.split(" ");
  return {
    t: Number(f[0]),
    klass: f.length > 1 && f[1] !== undefined ? f[1] : null,
    // G3: posted=1 ONLY for an explicit third field; the legacy
    // 2-field and 1-field formats are posted=0 (never suppress).
    posted: f.length > 2 ? f[2] === "1" : false,
  };
}

/** Atomically claim the wake slot: exactly one startup per (restart
 *  class, WAKE_DEDUP_POSTED_WINDOW_MS) for a claim that POSTED, even
 *  when two startups race (O_EXCL create). #306: the lock is
 *  CLASS-AWARE: a different restart class (an unplanned start after a
 *  planned card) always takes over, so the crash signal is never
 *  suppressed by an earlier planned card. #322 G3: an UNPOSTED claim
 *  (crash between claim and post) never suppresses — the signal cannot
 *  go dark across two consecutive restarts; the claim file format is
 *  `<epoch-ms> <class> <posted:0|1>`, posted=1 set by markWakePosted
 *  after a successful post. */
export function claimWake(
  stateDir: string,
  now = Date.now(),
  klass: RestartClass = "planned",
  windowMs: number = WAKE_DEDUP_POSTED_WINDOW_MS,
): WakeClaimResult {
  const p = wakeLockPath(stateDir);
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const fd = fs.openSync(p, "wx");
      fs.writeSync(fd, `${now} ${klass} 0\n`);
      fs.closeSync(fd);
      return { claimed: true, prev: null };
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST")
        return { claimed: false, prev: null };
      let prev: WakeClaimPrev;
      try {
        prev = parseClaim(fs.readFileSync(p, "utf8").trim());
      } catch {
        // unreadable claim: assume someone holds it (unknown age = held)
        return {
          claimed: false,
          prev: { t: now, klass: null, posted: false },
        };
      }
      if (!Number.isFinite(prev.t)) return { claimed: false, prev }; // same: unknown age = held
      // #306: a different restart class always takes over (the crash
      // signal must not be suppressed); a class-less claim dedupes
      // conservatively (treated as the same class).
      const sameKlass = prev.klass === null || prev.klass === klass;
      // #322 G3: suppress ONLY when the prior same-class claim is
      // in-window AND actually posted; an unposted claim never does.
      if (sameKlass && prev.posted && now - prev.t < windowMs)
        return { claimed: false, prev };
      try {
        fs.unlinkSync(p); // stale / unposted / class-change claim: take over
      } catch {
        return { claimed: false, prev }; // lost the unlink race
      }
    }
  }
  return { claimed: false, prev: null };
}

/** #322 G3: mark the claim as posted (called after a successful
 *  post). Matches on the claim's epoch so a taken-over (or raced)
 *  file is never flipped; atomic tmp+rename. A claim that never
 *  reaches this (crash between claim and post) stays posted=0 and
 *  never suppresses. */
export function markWakePosted(
  stateDir: string,
  epoch: number,
  klass: string,
): boolean {
  const p = wakeLockPath(stateDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8").trim();
  } catch {
    return false;
  }
  const f = raw.split(" ");
  if (Number(f[0]) !== epoch || (f[1] ?? klass) !== klass) return false;
  try {
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, `${epoch} ${klass} 1\n`);
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

// ─── G2: per-window numeric audit ─────────────────────────────────────

/** One agent's per-window startup/outcome tallies. One bridge process
 *  per agent, so the module-level default state IS the per-agent
 *  counter (injected in tests). */
export interface WakeAuditState {
  windowStart: number; // 0 = not started yet (epoch ms, window-aligned)
  starts: number;
  posted: number;
  dedup: number;
  postFailed: number;
  noChannel: number;
  /** #328: a planned restart whose wake was suppressed because the
   *  startup message is the one post. */
  suppressedPlanned: number;
}

export function wakeAuditInit(): WakeAuditState {
  return {
    windowStart: 0,
    starts: 0,
    posted: 0,
    dedup: 0,
    postFailed: 0,
    noChannel: 0,
    suppressedPlanned: 0,
  };
}

/** The per-process (per-agent) audit state. */
const defaultWakeAudit: WakeAuditState = wakeAuditInit();

/** The invariant, evaluated on a closed window: null when it holds,
 *  one flag line when it does not (pure numeric compare — the G2
 *  enforcement path is deterministic, no inference). */
export function wakeAuditEvaluate(state: WakeAuditState): string | null {
  const accounted =
    state.posted +
    state.dedup +
    state.postFailed +
    state.noChannel +
    state.suppressedPlanned;
  if (state.starts === accounted) return null;
  return (
    `[wake] audit flag: window=${state.windowStart} starts=${state.starts} ` +
    `accounted=${accounted} (posted=${state.posted} dedup=${state.dedup} ` +
    `post-failed=${state.postFailed} no-channel=${state.noChannel} ` +
    `suppressed-planned=${state.suppressedPlanned})`
  );
}

function rollWakeAuditWindow(
  state: WakeAuditState,
  now: number,
): string | null {
  const ws = Math.floor(now / WAKE_AUDIT_WINDOW_MS) * WAKE_AUDIT_WINDOW_MS;
  if (state.windowStart === 0) {
    state.windowStart = ws;
    return null;
  }
  if (ws === state.windowStart) return null;
  const flag = wakeAuditEvaluate(state); // the closed window
  state.windowStart = ws;
  state.starts = 0;
  state.posted = 0;
  state.dedup = 0;
  state.postFailed = 0;
  state.noChannel = 0;
  state.suppressedPlanned = 0;
  return flag;
}

/** Periodic evaluation: closes the window `now` left behind (one flag
 *  line on violation). Called on every session_start, startup or not. */
export function wakeAuditCheck(
  state: WakeAuditState,
  now: number,
): string | null {
  return rollWakeAuditWindow(state, now);
}

/** Count a startup event in the current window (closes the previous
 *  window first; its flag line, if any, is returned). */
export function wakeAuditStart(
  state: WakeAuditState,
  now: number,
): string | null {
  const flag = rollWakeAuditWindow(state, now);
  state.starts += 1;
  return flag;
}

/** Count a terminal outcome of a startup event (the five outcomes
 *  that make up `accounted`; not-startup is not a startup event). */
export function wakeAuditOutcome(
  state: WakeAuditState,
  outcome:
    | "posted"
    | "dedup"
    | "post-failed"
    | "no-channel"
    | "suppressed-planned",
): void {
  if (outcome === "posted") state.posted += 1;
  else if (outcome === "dedup") state.dedup += 1;
  else if (outcome === "post-failed") state.postFailed += 1;
  else if (outcome === "suppressed-planned") state.suppressedPlanned += 1;
  else state.noChannel += 1;
}

// ─── orchestrator ────────────────────────────────────────────────────────

export interface RestartWakeDeps {
  /** session_start event.reason; only "startup" posts (undefined —
   *  harness null-event — never posts). */
  reason: string | undefined;
  /** Bridge runtime state dir (<agent-cwd>/.tmp). */
  stateDir: string;
  /** Run-record dir (default: $PI_DISPATCH_RECORD_DIR or ~/.pi-dispatch/runs). */
  runDir?: string;
  now?: number;
  /** G2 audit state (default: the per-process/per-agent counter). */
  auditState?: WakeAuditState;
  /** Log sink (default: console.log). */
  log?: (line: string) => void;
}

export interface RestartWakeResult {
  posted: boolean;
  reason:
    | "posted"
    | "not-startup"
    | "no-channel"
    | "dedup"
    | "post-failed"
    | "suppressed-planned";
  message?: string;
  restartClass?: RestartClass;
}

/** One full wake cycle. The caller must fire and forget:
 *  `void runRestartWake(deps).catch(...)` — it must never block startup.
 *  #322 G1: EVERY terminal reason logs exactly one line — a process
 *  start (reason=startup) always ends in one of posted | post-failed |
 *  dedup suppressed | no-channel | suppressed-planned | not-startup,
 *  each greppable. #328: the planned class ends in suppressed-planned
 *  (the startup message is the one post; no card is sent), and the
 *  unclean class sets the startup-suppress flag before the claim (the
 *  card is the one post; the startup message is skipped). */
export async function runRestartWake(
  deps: RestartWakeDeps,
): Promise<RestartWakeResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now();
  // G2: close the window this event left behind (flag on violation);
  // runs on every session_start, startup or not (periodic tick).
  const audit = deps.auditState ?? defaultWakeAudit;
  const flag = wakeAuditCheck(audit, now);
  if (flag) log(flag);
  if (deps.reason !== "startup") {
    log(`[wake] not-startup: reason=${deps.reason ?? "none"}`);
    return { posted: false, reason: "not-startup" };
  }
  wakeAuditStart(audit, now);
  if (resolveLivenessTarget() === null) {
    wakeAuditOutcome(audit, "no-channel");
    log(
      "[wake] no-channel: hall-monitor config unset (JARATE_INBOX_URL/JARATE_INBOX_KEY) - the back_online event is not sent (log-only; the sweep + live marker remain the independent signal)",
    );
    return { posted: false, reason: "no-channel" };
  }
  // Consume the marker only on a real process start: in-process /new and
  // /reload cycles must not burn it.
  const restartClass = readCleanStop(deps.stateDir, now);
  if (restartClass === "planned") {
    // #328: the startup message is the one post for a planned restart —
    // the wake card is NOT sent (no hall-monitor card) and the
    // startup-suppress flag stays unset, so the startupMessage post
    // path posts as usual. No claim is taken: the next unclean start
    // still claims and posts its card.
    wakeAuditOutcome(audit, "suppressed-planned");
    log("[wake] suppressed-planned: startup message is the post");
    return {
      posted: false,
      reason: "suppressed-planned",
      restartClass,
    };
  }
  // #328: unclean start — the wake card is the one post; the
  // startupMessage post is suppressed for this start (shared
  // once-per-process flag, read by the discord.ts post sites). Set
  // BEFORE the claim: a deduped crash-flap start must not add a
  // second post, and a post-failed start documents itself via the
  // post-failed line while the next start re-posts the card (G3).
  suppressStartupMessageForThisStart();
  const claim = claimWake(deps.stateDir, now, restartClass);
  if (!claim.claimed) {
    const prev = claim.prev ?? { t: now, klass: null, posted: false };
    const sameClass = prev.klass === null || prev.klass === restartClass;
    // G1: the dedup path logs (the thin-record class is gone, #322).
    log(`[wake] dedup suppressed: age=${now - prev.t} same-class=${sameClass}`);
    wakeAuditOutcome(audit, "dedup");
    return { posted: false, reason: "dedup", restartClass };
  }
  const runs = readRunRecords(deps.runDir ?? defaultRunDir());
  // Build the payload now (deterministic given the snapshot).
  const payload = buildWakePayload({
    clean: false, // #328: the planned class returned above; only unclean posts
    runs,
    now,
  });
  log(
    `[wake] restart class=${restartClass} inflight=${runs.filter((r) => r.state === "running").length}`,
  );
  // hall-monitor#757 leg B: the wake is no longer a self-post (webhook
  // or bot); ONE fire-and-forget back_online liveness event. The detail
  // carries the pre-leg-B card text, plain (the italic channel markup is
  // the webhook leg's format concern, not the event's). egressText stays
  // the single egress choke point (docs/secret-censor.md): the line can
  // be re-posted to the channel by hall-monitor, so it is censored here.
  const detail = egressText(
    payload.content.replace(/^\*/, "").replace(/\*$/, ""),
  );
  const ok = await sendLivenessEvent("back_online", detail);
  if (ok) {
    // G3: mark the claim posted — only a POSTED claim suppresses the
    // next same-class start in-window; a crash between claim and post
    // leaves posted=0, so the signal cannot go dark twice in a row.
    markWakePosted(deps.stateDir, now, restartClass);
    wakeAuditOutcome(audit, "posted");
    log(`[wake] posted: class=${restartClass}`);
    return {
      posted: true,
      reason: "posted",
      message: payload.content,
      restartClass,
    };
  }
  wakeAuditOutcome(audit, "post-failed");
  log(
    "[wake] post-failed: the back_online event did not land (log-only - the sweep + live marker remain the independent signal)",
  );
  return {
    posted: false,
    reason: "post-failed",
    message: payload.content,
    restartClass,
  };
}
