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
import * as path from "node:path";

import {
  createDurableStore,
  generateStoreId,
  parseFutureIsoParam,
  parseMinutesParam,
} from "./durable-store";
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
 *  injection). Shared with the task tool — defined in durable-store.ts. */
export { CLAIM_TTL_MS } from "./durable-store";
/** Max sleep length: 30 days. */
export const MAX_WAKE_MS = 30 * 24 * 60 * 60 * 1000;

export function sleepsDir(home = defaultHome()): string {
  return path.join(home, ".pi", "agent", "sleep");
}

export function wakesPath(home = defaultHome()): string {
  return path.join(sleepsDir(home), "wakes.json");
}

// ─── State file ────────────────────────────────────────────────────────────

/** Per-entry validation for loadWakes; null drops the entry. */
function validateWake(raw: unknown): SleepWake | null {
  const w = raw as any;
  if (typeof w?.id !== "string" || !w.id) return null;
  if (typeof w?.channelId !== "string" || !w.channelId) return null;
  if (typeof w?.wakeAt !== "number" || !Number.isFinite(w.wakeAt)) return null;
  const wake: SleepWake = {
    id: w.id,
    channelId: w.channelId,
    wakeAt: w.wakeAt,
    createdAt: typeof w.createdAt === "number" ? w.createdAt : w.wakeAt,
    status: w.status === "claimed" ? "claimed" : "pending",
  };
  if (typeof w.channelName === "string" && w.channelName)
    wake.channelName = w.channelName;
  if (typeof w.note === "string" && w.note) wake.note = w.note;
  if (w.status === "claimed" && typeof w.claimedAt === "number")
    wake.claimedAt = w.claimedAt;
  return wake;
}

const wakeStore = createDurableStore<SleepWake>({
  dir: sleepsDir,
  file: wakesPath,
  wrapperKey: "wakes",
  validate: validateWake,
  dueAt: (w) => w.wakeAt,
});

/** All wakes on disk; missing/corrupt file -> empty list. */
export function loadWakes(home = defaultHome()): SleepWake[] {
  return wakeStore.load(home);
}

/** Save all wakes atomically (tmp file in the same dir, rename over). */
export function saveWakes(wakes: SleepWake[], home = defaultHome()): void {
  wakeStore.save(wakes, home);
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
  const hasMinutes =
    params.minutes !== undefined &&
    params.minutes !== null &&
    params.minutes !== "";
  const hasUntil =
    params.until !== undefined && params.until !== null && params.until !== "";
  if (hasMinutes && hasUntil)
    return { error: "pass minutes or until, not both" };
  if (!hasMinutes && !hasUntil)
    return { error: "pass minutes (number) or until (ISO time)" };

  if (hasUntil) {
    const r = parseFutureIsoParam(
      String(params.until),
      "until",
      now,
      MAX_WAKE_MS,
    );
    return r.ms === undefined ? { error: r.error! } : { wakeAt: r.ms };
  }

  const r = parseMinutesParam(params.minutes as number | string, MAX_WAKE_MS);
  return r.ms === undefined ? { error: r.error! } : { wakeAt: now + r.ms };
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
  const home = opts.home ?? defaultHome();
  const now = opts.now ?? Date.now();
  const id = generateStoreId(now);
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
  return wakeStore.removeById(id, home);
}

/** Mark a wake claimed (before injection). No-op when the id is gone. */
export function markClaimed(
  id: string,
  now = Date.now(),
  home = defaultHome(),
): void {
  wakeStore.claim(id, now, home);
}

/**
 * Complete a delivered wake: remove it from the file. Completion = deletion,
 * which keeps wakes.json bounded and /sleep list honest. Call only AFTER
 * injection succeeded — crash between injection and completion leaves the
 * stale claim, which re-delivers once after CLAIM_TTL_MS (at-least-once).
 * True when something was removed.
 */
export function completeWake(id: string, home = defaultHome()): boolean {
  return wakeStore.removeById(id, home);
}

/**
 * Cancel all PENDING wakes for a channel (claimed ones are mid-delivery and
 * left alone). Kimaki parity: any real inbound user message means the agent
 * is awake again, so the pending wake is stale. Returns the count removed.
 */
export function cancelPendingWakes(
  channelId: string,
  home = defaultHome(),
): number {
  const wakes = wakeStore.load(home);
  const next = wakes.filter(
    (w) => !(w.channelId === channelId && w.status === "pending"),
  );
  const removed = wakes.length - next.length;
  if (removed > 0) wakeStore.save(next, home);
  return removed;
}

/**
 * Collect orphan tmp files (crash between tmp write and rename). Best-effort:
 * never throws, called once per process start. Files are wakes.json.*.tmp.
 */
export function collectOrphanTmpFiles(home = defaultHome()): number {
  return wakeStore.collectOrphans(home);
}

/**
 * Wakes that should be delivered now: pending ones at/after their wakeAt,
 * plus claimed ones whose claim has gone stale (crash between claim and
 * injection — at-least-once).
 */
export function dueWakes(
  channelId: string,
  now = Date.now(),
  home = defaultHome(),
): SleepWake[] {
  return wakeStore.due(channelId, now, home);
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
  const lines = [
    `Woke after sleeping until ${until} (slept ${slept}). Resuming this session.`,
  ];
  if (wake.note) lines.push(`Note: ${wake.note}`);
  lines.push("Continue the work you were waiting for.");
  return lines.join("\n");
}
