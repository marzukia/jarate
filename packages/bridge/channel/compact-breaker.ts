/**
 * #384 guard D — the compaction rate breaker.
 *
 * Per-channel compaction event timestamps, persisted in
 * `compact-breaker.json` NEXT TO channel-state.json (the same
 * `<stateDir>` — `<cwd>/.tmp`). Rule: MORE THAN 2 compactions within
 * a rolling 60-minute window trips the breaker: ONE loud line
 *
 *   COMPACT-LOOP <channelId>: <N> compactions in 60m — auto-compact
 *   paused, operator action required
 *
 * (posted once per trip), auto-compaction is SKIPPED while tripped
 * (manual /compact unaffected), and the breaker auto-resets 120
 * minutes after the trip. The skip reuses the #381 stale-ctx skip
 * path pattern: one leg-named log line, the gate skips for this
 * firing. Deterministic constants only — no LLM in the path.
 */
import fs from "node:fs";
import path from "node:path";

import { sendDiscordMessage } from "./discord";
import { machine } from "./live";
import type { ChannelConfig } from "./types";

/** The rolling count window. */
export const COMPACT_LOOP_WINDOW_MS = 60 * 60_000;
/** The breaker trips when the window count exceeds this. */
export const COMPACT_LOOP_TRIP_THRESHOLD = 2;
/** Auto-reset: the trip expires after this long. */
export const COMPACT_LOOP_RESET_MS = 120 * 60_000;
/** Keep at most this many timestamps per channel. */
const EVENT_KEEP = 10;

interface ChannelRec {
  events: number[];
  trippedAt: number | null;
}
interface BreakerFile {
  v: 1;
  channels: Record<string, ChannelRec>;
}

const FILE_NAME = "compact-breaker.json";

export function compactBreakerPath(stateDir: string): string {
  return path.join(stateDir, FILE_NAME);
}

function load(stateDir: string): BreakerFile {
  try {
    const d = JSON.parse(fs.readFileSync(compactBreakerPath(stateDir), "utf8"));
    if (d?.v !== 1 || typeof d?.channels !== "object" || d.channels == null)
      return { v: 1, channels: {} };
    const channels: Record<string, ChannelRec> = {};
    for (const [k, v] of Object.entries(d.channels as Record<string, any>)) {
      if (!v || typeof v.events !== "object" || v.events == null) continue;
      channels[k] = {
        events: (v.events as unknown[]).filter(
          (t): t is number => typeof t === "number",
        ),
        trippedAt: typeof v.trippedAt === "number" ? v.trippedAt : null,
      };
    }
    return { v: 1, channels };
  } catch {
    return { v: 1, channels: {} };
  }
}

function save(stateDir: string, f: BreakerFile): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const p = compactBreakerPath(stateDir);
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(f, null, 2));
    fs.renameSync(`${p}.tmp`, p);
  } catch {
    /* a breaker persist failure must never break the compact path */
  }
}

/** Auto-reset check: a trip older than COMPACT_LOOP_RESET_MS clears. */
function resetIfExpired(rec: ChannelRec, now: number): void {
  if (rec.trippedAt != null && now - rec.trippedAt >= COMPACT_LOOP_RESET_MS)
    rec.trippedAt = null;
}

/**
 * Record a (non-manual) compaction event for the channel. Returns the
 * rolling-window count, whether THIS call tripped the breaker (the
 * loud line is carried once per trip — subsequent events while tripped
 * carry no line), and the line when tripped.
 */
export function noteCompactionEvent(
  stateDir: string,
  channelId: string,
  now = Date.now(),
): { count: number; tripped: boolean; line: string | null } {
  const f = load(stateDir);
  const rec = f.channels[channelId] ?? { events: [], trippedAt: null };
  resetIfExpired(rec, now);
  rec.events = rec.events.filter((t) => now - t < COMPACT_LOOP_WINDOW_MS);
  rec.events.push(now);
  if (rec.events.length > EVENT_KEEP)
    rec.events = rec.events.slice(-EVENT_KEEP);
  let tripped = false;
  let line: string | null = null;
  if (
    rec.trippedAt == null &&
    rec.events.length > COMPACT_LOOP_TRIP_THRESHOLD
  ) {
    rec.trippedAt = now;
    tripped = true;
    line = `COMPACT-LOOP ${channelId}: ${rec.events.length} compactions in 60m — auto-compact paused, operator action required`;
  }
  f.channels[channelId] = rec;
  save(stateDir, f);
  return { count: rec.events.length, tripped, line };
}

/** True while the breaker is tripped (auto-compact is skipped; manual
 *  /compact is unaffected). Auto-reset after 120 minutes. */
export function isAutoCompactPaused(
  stateDir: string,
  channelId: string,
  now = Date.now(),
): boolean {
  const f = load(stateDir);
  const rec = f.channels[channelId];
  if (!rec || rec.trippedAt == null) return false;
  if (now - rec.trippedAt >= COMPACT_LOOP_RESET_MS) {
    rec.trippedAt = null;
    save(stateDir, f);
    return false;
  }
  return true;
}

/** The #381-pattern skip for the token gate: one leg-named line, the
 *  gate skips for this firing. True = skip. */
export function autoCompactGateBlocked(
  cwd: string,
  channelId: string,
  now = Date.now(),
): boolean {
  const stateDir = path.join(cwd, ".tmp");
  if (isAutoCompactPaused(stateDir, channelId, now)) {
    console.error(
      "[handoff] auto-compact gate: compact-loop tripped, skipping:",
      channelId,
    );
    return true;
  }
  return false;
}

/** Fire a compaction event for the channel (non-manual compactions
 *  only) and post the loud line when this event trips the breaker.
 *  Best-effort: never throws. */
export function noteAutoCompact(
  cwd: string,
  ch: ChannelConfig | null,
  now = Date.now(),
): void {
  if (ch?.type !== "discord") return;
  const r = noteCompactionEvent(path.join(cwd, ".tmp"), ch.id, now);
  if (r.line) {
    console.error(`[handoff] ${r.line}`);
    sendDiscordMessage(ch, machine(r.line)).catch(() => {});
  }
}
