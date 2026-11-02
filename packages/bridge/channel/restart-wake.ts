// restart-wake — post-restart wake (issue #111, P0).
//
// When the pi process really starts (session_start reason "startup"), the
// bridge posts ONE "back online" message to the agent's channel. Shape
// (2026-10-31, Andryo: machine surfaces are plain text + italics - no
// embeds, no code fences; this SUPERSEDES the 2026-10-19 EMBED CARD
// convention for this surface):
//   - ONE short italic line, no more than a few words: the content is
//     `*restart-wake · planned*` / `*restart-wake · unplanned*` - the
//     planned/unplanned distinction is the functional signal (no
//     author/title/description/footer/embed at all)
//   - bg runs in flight at restart: a compact suffix on the SAME line:
//     `*restart-wake · planned · in-flight N*` (N = count of
//     state=running records; the old multiline in-flight field is gone,
//     detail lives in /jobs)
//   - the WAKE itself rides webhook_id: isBgWebhook exempts any
//     webhook-posted message from the other-bot filter, so the post
//     lands as an agent turn. isBgCallbackBody classifies the plain
//     `restart-wake ·` content prefix (and the legacy `Author: pi-bg`
//     embed shape, kept for in-flight history)
//
// Guards (issue #111):
//   - never blocks startup: the caller fires and forgets (void + catch);
//     the post itself is bounded — 3 attempts, 15s hard timeout each,
//     3s*i backoff (the pi-bg webhook pattern, bg_post)
//   - no channel with a bot token or webhook (dev runs) = silent no-op
//   - two startups racing within 60s post once (atomic O_EXCL claim)
//   - hot reload / session switch (reason != "startup") never posts
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
//     (posted | post-failed | dedup suppressed | no-channel | not-startup);
//     the dedup path is no longer silent (the thin-record class is gone)
//   - G2: per-agent per-window numeric audit: starts ==
//     posted + dedup + post-failed + no-channel; a violation logs one
//     flag line (pure numeric compare)
//   - G3: the claim file carries a posted flag; the window suppresses
//     ONLY when the prior same-class claim is in-window AND posted=1
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

// pi-bg bg_post pattern: 3 attempts, --max-time 15, backoff i*3s.
export const POST_ATTEMPTS = 3;
export const POST_TIMEOUT_MS = 15_000;
export const POST_BACKOFF_MS = 3_000;

const DISCORD_API = "https://discord.com/api/v10";

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
 *  - machine surfaces are plain text + italics, no embeds). */
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

/** Censor the wake's content (docs/secret-censor.md): the in-flight
 *  count ships in the content line. */
function egressPayload(p: WakePayload): WakePayload {
  return { content: egressText(p.content) };
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
}

export function wakeAuditInit(): WakeAuditState {
  return {
    windowStart: 0,
    starts: 0,
    posted: 0,
    dedup: 0,
    postFailed: 0,
    noChannel: 0,
  };
}

/** The per-process (per-agent) audit state. */
const defaultWakeAudit: WakeAuditState = wakeAuditInit();

/** The invariant, evaluated on a closed window: null when it holds,
 *  one flag line when it does not (pure numeric compare — the G2
 *  enforcement path is deterministic, no inference). */
export function wakeAuditEvaluate(state: WakeAuditState): string | null {
  const accounted =
    state.posted + state.dedup + state.postFailed + state.noChannel;
  if (state.starts === accounted) return null;
  return (
    `[wake] audit flag: window=${state.windowStart} starts=${state.starts} ` +
    `accounted=${accounted} (posted=${state.posted} dedup=${state.dedup} ` +
    `post-failed=${state.postFailed} no-channel=${state.noChannel})`
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

/** Count a terminal outcome of a startup event (the four outcomes
 *  that make up `accounted`; not-startup is not a startup event). */
export function wakeAuditOutcome(
  state: WakeAuditState,
  outcome: "posted" | "dedup" | "post-failed" | "no-channel",
): void {
  if (outcome === "posted") state.posted += 1;
  else if (outcome === "dedup") state.dedup += 1;
  else if (outcome === "post-failed") state.postFailed += 1;
  else state.noChannel += 1;
}

// ─── bounded post ────────────────────────────────────────────────────────

export interface WakeTarget {
  /** Discord channel id (numeric). */
  channelId: string;
  botToken?: string;
  webhookUrl?: string;
}

export interface PostOpts {
  fetchImpl?: typeof fetch;
  attempts?: number;
  timeoutMs?: number;
  backoffMs?: number;
}

/** Bounded post of the wake payload, pi-bg bg_post pattern: up to
 *  `attempts` tries per route, hard timeout per try, backoff
 *  i*backoffMs between tries, 2xx = success. WEBHOOK FIRST (the
 *  webhook post IS the wake: isBgWebhook exempts any webhook-posted
 *  message from the other-bot filter, so it lands as a turn), bot API
 *  second for configs without a webhook. Neither configured = silent no-op. Never throws —
 *  a dead network must not take startup down. */
export async function postWakePayload(
  target: WakeTarget,
  payload: WakePayload,
  opts: PostOpts = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? POST_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? POST_TIMEOUT_MS;
  const backoffMs = opts.backoffMs ?? POST_BACKOFF_MS;
  const body = JSON.stringify(payload);
  const routes: Array<{ url: string; headers: Record<string, string> }> = [];
  if (target.webhookUrl) {
    routes.push({
      url: target.webhookUrl,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (target.botToken) {
    routes.push({
      url: `${DISCORD_API}/channels/${encodeURIComponent(target.channelId)}/messages`,
      headers: {
        Authorization: `Bot ${target.botToken}`,
        "Content-Type": "application/json",
      },
    });
  }
  if (routes.length === 0) return false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const route of routes) {
    for (let i = 1; i <= attempts; i++) {
      try {
        const resp = await fetchImpl(route.url, {
          method: "POST",
          headers: route.headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (resp.ok) return true;
      } catch {
        // timeout / network error: retry
      }
      if (i < attempts) await sleep(backoffMs * i);
    }
  }
  return false;
}

/** The pi-bg callback bus webhook: $PI_DISPATCH_WEBHOOK or
 *  ~/.config/pi-dispatch/webhook (the SAME source pi-bg's launcher reads;
 *  missing file = null). This is the route the framed wake posts through.
 */
export function defaultDispatchWebhook(
  home: string = process.env.HOME || os.homedir(),
): string | null {
  const env = process.env.PI_DISPATCH_WEBHOOK?.trim();
  if (env) return env;
  try {
    const raw = fs
      .readFileSync(
        path.join(home, ".config", "pi-dispatch", "webhook"),
        "utf8",
      )
      .trim();
    return raw ? raw : null;
  } catch {
    return null;
  }
}

// ─── orchestrator ────────────────────────────────────────────────────────

export interface RestartWakeDeps {
  /** session_start event.reason; only "startup" posts (undefined —
   *  harness null-event — never posts). */
  reason: string | undefined;
  /** Bridge runtime state dir (<agent-cwd>/.tmp). */
  stateDir: string;
  /** null = no channel/token/webhook → silent no-op. */
  target: WakeTarget | null;
  /** Run-record dir (default: $PI_DISPATCH_RECORD_DIR or ~/.pi-dispatch/runs). */
  runDir?: string;
  now?: number;
  fetchImpl?: typeof fetch;
  /** Post timing overrides (tests shrink the backoff); defaults are the
   *  pi-bg pattern. */
  postOpts?: PostOpts;
  log?: (line: string) => void;
  /** G2 audit state (default: the per-process/per-agent counter). */
  auditState?: WakeAuditState;
}

export interface RestartWakeResult {
  posted: boolean;
  reason: "posted" | "not-startup" | "no-channel" | "dedup" | "post-failed";
  message?: string;
  restartClass?: RestartClass;
}

/** One full wake cycle. The caller must fire and forget:
 *  `void runRestartWake(deps).catch(...)` — it must never block startup.
 *  #322 G1: EVERY terminal reason logs exactly one line — a process
 *  start (reason=startup) always ends in one of posted | post-failed |
 *  dedup suppressed | no-channel | not-startup, each greppable. */
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
  if (!deps.target) {
    wakeAuditOutcome(audit, "no-channel");
    log("[wake] no-channel: no channel/token/webhook configured");
    return { posted: false, reason: "no-channel" };
  }
  // Consume the marker only on a real process start: in-process /new and
  // /reload cycles must not burn it.
  const restartClass = readCleanStop(deps.stateDir, now);
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
  // Build the payload now (deterministic given the snapshot). Every
  // string part is censored at egress (egressPayload, single choke point
  // per docs/secret-censor.md): ticket/run ids come from run records and
  // can carry secrets.
  const payload = buildWakePayload({
    clean: restartClass === "planned",
    runs,
    now,
  });
  log(
    `[wake] restart class=${restartClass} inflight=${runs.filter((r) => r.state === "running").length}`,
  );
  // Bus webhook resolution: the channel config's webhookUrl when set,
  // else the pi-bg dispatch bus (the webhook route that wakes the agent).
  const target: WakeTarget = {
    ...deps.target,
    webhookUrl: deps.target.webhookUrl || defaultDispatchWebhook() || undefined,
  };
  // egressText = the single egress choke point (docs/secret-censor.md):
  // ticket/task text comes from run records and can carry secrets.
  const ok = await postWakePayload(target, egressPayload(payload), {
    ...deps.postOpts,
    fetchImpl: deps.fetchImpl ?? deps.postOpts?.fetchImpl,
  });
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
    "[wake] post-failed: up to 2 routes x 3 attempts, 15s each - no wake in channel",
  );
  return {
    posted: false,
    reason: "post-failed",
    message: payload.content,
    restartClass,
  };
}
