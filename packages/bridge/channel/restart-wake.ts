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
//   restart-wake.lock last wake claim (epoch ms), 60s dedup window
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

/** Dedup window for racing startups (issue #111: two starts within 60s). */
export const WAKE_DEDUP_WINDOW_MS = 30 * 60_000;

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

/** Atomically claim the wake slot: true for exactly one startup per
 *  (restart class, WAKE_DEDUP_WINDOW_MS), even when two startups race
 *  (O_EXCL create). #306: the window is 30min — the observed
 *  double-post gap was 21.7min (two clean startups, both posting
 *  "planned"); and the lock is CLASS-AWARE: a different restart class
 *  (an unplanned start after a planned card) always takes over, so the
 *  crash signal is never suppressed by an earlier planned card. A claim
 *  that never posts (crash between claim and post) just eats the window
 *  — the next start after the window still posts. */
export function claimWake(
  stateDir: string,
  now = Date.now(),
  klass: RestartClass = "planned",
  windowMs: number = WAKE_DEDUP_WINDOW_MS,
): boolean {
  const p = wakeLockPath(stateDir);
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const fd = fs.openSync(p, "wx");
      fs.writeSync(fd, `${now} ${klass}\n`);
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") return false;
      let t = Number.NaN;
      let prevKlass: string | null = null;
      try {
        const raw = fs.readFileSync(p, "utf8").trim();
        const sp = raw.lastIndexOf(" ");
        t = Number(sp === -1 ? raw : raw.slice(0, sp));
        prevKlass = sp === -1 ? null : raw.slice(sp + 1);
      } catch {
        return false; // unreadable claim: assume someone holds it
      }
      if (!Number.isFinite(t)) return false; // same: unknown age = held
      // #306: a different restart class always takes over (the crash
      // signal must not be suppressed); the legacy lock (no class)
      // dedupes conservatively (treated as the same class).
      const sameKlass = prevKlass === null || prevKlass === klass;
      if (sameKlass && now - t < windowMs) return false;
      try {
        fs.unlinkSync(p); // stale (or class-change) claim: take over
      } catch {
        return false; // lost the unlink race to the other start
      }
    }
  }
  return false;
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
}

export interface RestartWakeResult {
  posted: boolean;
  reason: "posted" | "not-startup" | "no-channel" | "dedup" | "post-failed";
  message?: string;
  restartClass?: RestartClass;
}

/** One full wake cycle. The caller must fire and forget:
 *  `void runRestartWake(deps).catch(...)` — it must never block startup. */
export async function runRestartWake(
  deps: RestartWakeDeps,
): Promise<RestartWakeResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now();
  if (deps.reason !== "startup")
    return { posted: false, reason: "not-startup" };
  if (!deps.target) return { posted: false, reason: "no-channel" };
  // Consume the marker only on a real process start: in-process /new and
  // /reload cycles must not burn it.
  const restartClass = readCleanStop(deps.stateDir, now);
  if (!claimWake(deps.stateDir, now, restartClass)) {
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
  if (!ok)
    log(
      "[wake] post failed (up to 2 routes x 3 attempts, 15s each) - no wake in channel",
    );
  return {
    posted: ok,
    reason: ok ? "posted" : "post-failed",
    message: payload.content,
    restartClass,
  };
}
