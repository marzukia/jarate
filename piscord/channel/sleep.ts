/**
 * Session sleep: durable "wake me at X" scheduler for this agent's pi session.
 *
 * The `sleep` tool records a wake; the LLM run ends right after the call.
 * Delivery is EXTERNAL to the run: the bridge checks pending wakes on
 * session_start (so a restart or reboot catches up on due wakes) and via a
 * 30s poller while alive. Wake text is injected through the same
 * channel-inbound path as human messages, so the wake starts a fresh turn
 * in the SAME session.
 *
 * State: ~/.pi/agent/sleep/wakes.json (atomic tmp+rename write). The
 * `home` parameter on every fs function exists for test isolation.
 *
 * Delivery is at-least-once (kimaki's session-sleep invariant): a wake is
 * marked `claimed` before it is injected; after injection succeeds it is
 * COMPLETED (removed from the file), so a healthy process never re-delivers
 * it. A `claimed` wake older than CLAIM_TTL_MS (process died between claim
 * and completion) is stale and re-delivered exactly once. The claim is a
 * crash guard, not a lock — a double wake is one extra turn, a lost wake is
 * the bug we are protecting against.
 *
 * Single-writer assumption: all state ops are read-modify-write with no
 * lock. One pi process per HOME (the normal case) is safe — JS is
 * single-threaded and the initial catch-up finishes before the poller arms.
 * Two concurrent processes sharing one HOME race on the file: a lost claim
 * write can double-wake (accepted, bounded by TTL), a lost scheduleWake
 * write can drop a scheduled wake (known gap, outside at-least-once).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { defaultHome } from "./todos";

export interface SleepWake {
  /** Short id (e.g. "m3x2k9ab") — the /sleep cancel target. */
  id: string;
  channelId: string;
  channelName?: string;
  /** Epoch ms the session should wake at. */
  wakeAt: number;
  /** Epoch ms the sleep was scheduled. */
  createdAt: number;
  /** Optional note the agent stores for its waking self. */
  note?: string;
  status: "pending" | "claimed";
  /** Epoch ms of the delivery claim (stale claims are re-delivered). */
  claimedAt?: number;
}

export interface WakeAtResult {
  /** Set on success. */
  wakeAt?: number;
  /** Set on failure (exactly one of the two is set). */
  error?: string;
}

/** A claimed wake is re-delivered after this long (crash between claim and
 *  injection). */
export const CLAIM_TTL_MS = 10 * 60 * 1000;
/** Max sleep length: 30 days. */
export const MAX_WAKE_MS = 30 * 24 * 60 * 60 * 1000;

export function sleepsDir(home = defaultHome()): string {
  return path.join(home, ".pi", "agent", "sleep");
}

export function wakesPath(home = defaultHome()): string {
  return path.join(sleepsDir(home), "wakes.json");
}

// ─── State file ────────────────────────────────────────────────────────────

/** All wakes on disk; missing/corrupt file -> empty list. */
export function loadWakes(home = defaultHome()): SleepWake[] {
  let raw: string;
  try {
    raw = fs.readFileSync(wakesPath(home), "utf8");
  } catch {
    return [];
  }
  try {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.wakes)) return [];
    const out: SleepWake[] = [];
    for (const w of data.wakes) {
      if (typeof w?.id !== "string" || !w.id) continue;
      if (typeof w?.channelId !== "string" || !w.channelId) continue;
      if (typeof w?.wakeAt !== "number" || !Number.isFinite(w.wakeAt)) continue;
      const wake: SleepWake = {
        id: w.id,
        channelId: w.channelId,
        wakeAt: w.wakeAt,
        createdAt: typeof w.createdAt === "number" ? w.createdAt : w.wakeAt,
        status: w.status === "claimed" ? "claimed" : "pending",
      };
      if (typeof w.channelName === "string" && w.channelName) wake.channelName = w.channelName;
      if (typeof w.note === "string" && w.note) wake.note = w.note;
      if (w.status === "claimed" && typeof w.claimedAt === "number") wake.claimedAt = w.claimedAt;
      out.push(wake);
    }
    return out;
  } catch {
    return [];
  }
}

/** Save all wakes atomically (tmp file in the same dir, rename over). */
export function saveWakes(wakes: SleepWake[], home = defaultHome()): void {
  const dir = sleepsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const target = wakesPath(home);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ wakes }, null, 2));
  fs.renameSync(tmp, target);
}

// ─── Scheduling ────────────────────────────────────────────────────────────

/**
 * Resolve the wake time from either `minutes` (number > 0) or `until`
 * (ISO timestamp, must be in the future). Exactly one of the two.
 */
export function parseWakeAt(
  params: { minutes?: number | string; until?: string },
  now = Date.now(),
): WakeAtResult {
  const hasMinutes = params.minutes !== undefined && params.minutes !== null && params.minutes !== "";
  const hasUntil = params.until !== undefined && params.until !== null && params.until !== "";
  if (hasMinutes && hasUntil) return { error: "pass minutes or until, not both" };
  if (!hasMinutes && !hasUntil) return { error: "pass minutes (number) or until (ISO time)" };

  if (hasUntil) {
    const t = Date.parse(String(params.until));
    if (Number.isNaN(t)) return { error: `invalid until: "${params.until}" (ISO time, e.g. 2026-09-10T15:00:00Z)` };
    if (t <= now) return { error: `until must be in the future: ${params.until}` };
    if (t - now > MAX_WAKE_MS) return { error: "until too far out (max 30d from now)" };
    return { wakeAt: t };
  }

  const minutes = typeof params.minutes === "number" ? params.minutes : Number(params.minutes);
  if (!Number.isFinite(minutes)) return { error: `minutes must be a number, got "${params.minutes}"` };
  if (minutes <= 0) return { error: "minutes must be greater than 0" };
  const ms = minutes * 60 * 1000;
  if (ms > MAX_WAKE_MS) return { error: `minutes too large (max 43200 = 30d)` };
  return { wakeAt: now + ms };
}

/** Record a wake for a channel. Returns the stored entry. */
export function scheduleWake(opts: {
  channelId: string;
  channelName?: string;
  wakeAt: number;
  note?: string;
  home?: string;
  now?: number;
}): SleepWake {
  const home = opts.home;
  const now = opts.now ?? Date.now();
  const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const wake: SleepWake = {
    id,
    channelId: opts.channelId,
    wakeAt: opts.wakeAt,
    createdAt: now,
    status: "pending",
  };
  if (opts.channelName) wake.channelName = opts.channelName;
  if (opts.note) wake.note = opts.note;
  saveWakes([...loadWakes(home), wake], home);
  return wake;
}

/** Remove a wake by id (pending or claimed). True when something was removed. */
export function cancelWake(id: string, home = defaultHome()): boolean {
  const wakes = loadWakes(home);
  const next = wakes.filter(w => w.id !== id);
  if (next.length === wakes.length) return false;
  saveWakes(next, home);
  return true;
}

/** Mark a wake claimed (before injection). No-op when the id is gone. */
export function markClaimed(id: string, now = Date.now(), home = defaultHome()): void {
  const wakes = loadWakes(home);
  let changed = false;
  const next = wakes.map(w => {
    if (w.id !== id) return w;
    changed = true;
    return { ...w, status: "claimed" as const, claimedAt: now };
  });
  if (changed) saveWakes(next, home);
}

/**
 * Complete a delivered wake: remove it from the file. Completion = deletion,
 * which keeps wakes.json bounded and /sleep list honest. Call only AFTER
 * injection succeeded — crash between injection and completion leaves the
 * stale claim, which re-delivers once after CLAIM_TTL_MS (at-least-once).
 * True when something was removed.
 */
export function completeWake(id: string, home = defaultHome()): boolean {
  const wakes = loadWakes(home);
  const next = wakes.filter(w => w.id !== id);
  if (next.length === wakes.length) return false;
  saveWakes(next, home);
  return true;
}

/**
 * Cancel all PENDING wakes for a channel (claimed ones are mid-delivery and
 * left alone). Kimaki parity: any real inbound user message means the agent
 * is awake again, so the pending wake is stale. Returns the count removed.
 */
export function cancelPendingWakes(channelId: string, home = defaultHome()): number {
  const wakes = loadWakes(home);
  const next = wakes.filter(w => !(w.channelId === channelId && w.status === "pending"));
  const removed = wakes.length - next.length;
  if (removed > 0) saveWakes(next, home);
  return removed;
}

/**
 * Collect orphan tmp files (crash between tmp write and rename). Best-effort:
 * never throws, called once per process start. Files are wakes.json.*.tmp.
 */
export function collectOrphanTmpFiles(home = defaultHome()): number {
  const dir = sleepsDir(home);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // no dir yet — nothing to collect
  }
  const target = path.basename(wakesPath(home));
  let removed = 0;
  for (const n of names) {
    if (!n.startsWith(`${target}.`) || !n.endsWith(".tmp")) continue;
    try {
      fs.unlinkSync(path.join(dir, n));
      removed++;
    } catch {
      // best-effort; a locked/dead tmp file can stay, it is harmless
    }
  }
  return removed;
}

/**
 * Wakes that should be delivered now: pending ones at/after their wakeAt,
 * plus claimed ones whose claim has gone stale (crash between claim and
 * injection — at-least-once).
 */
export function dueWakes(channelId: string, now = Date.now(), home = defaultHome()): SleepWake[] {
  return loadWakes(home).filter(w => {
    if (w.channelId !== channelId) return false;
    if (w.status === "pending") return w.wakeAt <= now;
    return now - (w.claimedAt ?? w.wakeAt) > CLAIM_TTL_MS;
  });
}

// ─── Rendering ─────────────────────────────────────────────────────────────

/** Human-facing duration: "30m", "2h", "1d". */
export function formatDurationMs(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

/**
 * The wake message body. Injected as a channel-inbound message at wake
 * time — the agent sees it as a normal message in its own session and
 * continues from there.
 */
export function formatWakePrompt(wake: SleepWake, now = Date.now()): string {
  const until = `${new Date(wake.wakeAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const slept = formatDurationMs(Math.max(1, now - wake.createdAt));
  const lines = [`Woke after sleeping until ${until} (slept ${slept}). Resuming this session.`];
  if (wake.note) lines.push(`Note: ${wake.note}`);
  lines.push("Continue the work you were waiting for.");
  return lines.join("\n");
}
