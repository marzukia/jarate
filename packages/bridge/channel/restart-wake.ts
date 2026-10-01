// restart-wake — post-restart wake (issue #111, P0).
//
// When the pi process really starts (session_start reason "startup"), the
// bridge posts ONE "back online" message to the agent's channel:
//   - restart class: planned (the clean-stop marker is present + fresh)
//     or unplanned (marker absent/stale — the last stop never ran
//     session_shutdown: crash, OOM, SIGKILL, power loss)
//   - inflight summary: every pi-bg run record with state=running
//     (~/.pi-dispatch/runs/*.json): ticket id, profile, elapsed, cwd,
//     and best-effort task text from the live wrapper argv (after a real
//     restart the wrappers are usually dead, so the task line is absent)
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
import { collectInflightJobs, type InflightJob } from "./jobs";

// ─── constants ───────────────────────────────────────────────────────────

/** A clean-stop marker older than this no longer describes the stop right
 *  before this start — classify unclean (default: 24h). */
export const CLEAN_STOP_MAX_AGE_MS = 24 * 3_600_000;

/** Dedup window for racing startups (issue #111: two starts within 60s). */
export const WAKE_DEDUP_WINDOW_MS = 60_000;

/** Cap the inflight list (a restart can strand many tickets; keep the
 *  message bounded, point at /jobs for the rest). */
export const MAX_INFLIGHT = 10;

/** Task text budget per run (issue #111: first ~80 chars). */
export const TASK_CHARS = 80;

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

function firstLine(s: string | undefined): string {
  if (typeof s !== "string") return "";
  return s.split("\n")[0].trim();
}

export interface WakeMessageOpts {
  /** true = the last stop ran session_shutdown (planned restart). */
  clean: boolean;
  runs: RunRecord[];
  /** Best-effort task text per ticket id (live wrapper argv via /jobs). */
  taskFor?: (runId: string) => string | undefined;
  now?: number;
}

/** Build the wake message. Pure — all I/O is injected by the caller.
 *
 *  Zero inflight = ONE short line, no list (issue #111). Inflight =
 *  status line + plain bullets (STYLE.md: lists go outside box frames).
 */
export function buildWakeMessage({
  clean,
  runs,
  taskFor,
  now = Date.now(),
}: WakeMessageOpts): string {
  const status = clean
    ? "[ok] back online (planned restart)"
    : "[!] back online (unplanned restart - last turn may have been interrupted)";
  const { list, more } = selectInflight(runs);
  if (list.length === 0) {
    return `${status} - no in-flight pi-bg work`;
  }
  const lines: string[] = [`${status} - ${list.length} in-flight pi-bg run(s)`];
  for (const r of list) {
    const who =
      r.profile && String(r.profile).length > 0 ? String(r.profile) : "unknown";
    lines.push(
      `- ${r.run} ${who} ${elapsedStr(elapsedSeconds(r.started, now))}`,
    );
    if (typeof r.cwd === "string" && r.cwd.length > 0)
      lines.push(`  cwd ${r.cwd}`);
    const task = firstLine(taskFor?.(r.run));
    if (task.length > 0) lines.push(`  task ${task.slice(0, TASK_CHARS)}`);
  }
  if (more > 0) lines.push(`- +${more} more - see /jobs`);
  return lines.join("\n");
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
 *  WAKE_DEDUP_WINDOW_MS, even when two startups race (O_EXCL create).
 *  A claim that never posts (crash between claim and post) just eats
 *  the 60s window — the next start after the window still posts. */
export function claimWake(
  stateDir: string,
  now = Date.now(),
  windowMs: number = WAKE_DEDUP_WINDOW_MS,
): boolean {
  const p = wakeLockPath(stateDir);
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const fd = fs.openSync(p, "wx");
      fs.writeSync(fd, `${now}\n`);
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") return false;
      let t = Number.NaN;
      try {
        t = Number(fs.readFileSync(p, "utf8").trim());
      } catch {
        return false; // unreadable claim: assume someone holds it
      }
      if (!Number.isFinite(t)) return false; // same: unknown age = held
      if (now - t < windowMs) return false;
      try {
        fs.unlinkSync(p); // stale claim: take over
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

/** Bounded post, pi-bg bg_post pattern: up to `attempts` tries per route,
 *  hard timeout per try, backoff i*backoffMs between tries, 2xx = success.
 *  Bot API first (visible channel identity), webhookUrl as fallback route
 *  for outbound-only configs. Neither configured = silent no-op. Never
 *  throws — a dead network must not take the startup down with it. */
export async function postWakeText(
  target: WakeTarget,
  text: string,
  opts: PostOpts = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? POST_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? POST_TIMEOUT_MS;
  const backoffMs = opts.backoffMs ?? POST_BACKOFF_MS;
  const body = JSON.stringify({ content: text });
  const routes: Array<{ url: string; headers: Record<string, string> }> = [];
  if (target.botToken) {
    routes.push({
      url: `${DISCORD_API}/channels/${encodeURIComponent(target.channelId)}/messages`,
      headers: {
        Authorization: `Bot ${target.botToken}`,
        "Content-Type": "application/json",
      },
    });
  }
  if (target.webhookUrl) {
    routes.push({
      url: target.webhookUrl,
      headers: { "Content-Type": "application/json" },
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
  /** Live pi-bg wrappers (task text); default: collectInflightJobs(). */
  jobs?: InflightJob[];
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
  if (!claimWake(deps.stateDir, now)) {
    return { posted: false, reason: "dedup", restartClass };
  }
  const runs = readRunRecords(deps.runDir ?? defaultRunDir());
  const jobs = deps.jobs ?? collectInflightJobs();
  const taskById = new Map(
    jobs.filter((j) => j.id !== null).map((j) => [j.id as string, j.task]),
  );
  const message = buildWakeMessage({
    clean: restartClass === "planned",
    runs,
    taskFor: (id) => taskById.get(id),
    now,
  });
  log(
    `[wake] restart class=${restartClass} inflight=${selectInflight(runs).list.length}`,
  );
  // egressText = the single egress choke point (docs/secret-censor.md):
  // the task text comes from argv and can carry secrets.
  const ok = await postWakeText(deps.target, egressText(message), {
    ...deps.postOpts,
    fetchImpl: deps.fetchImpl ?? deps.postOpts?.fetchImpl,
  });
  if (!ok)
    log("[wake] post failed (3 attempts, 15s each) - no wake in channel");
  return {
    posted: ok,
    reason: ok ? "posted" : "post-failed",
    message,
    restartClass,
  };
}
