// restart-queue — re-wake queue survival across a process restart (#180).
//
// The mid-turn re-wake queue (index.ts midTurnQueues) is in-memory, and
// session_shutdown drains it on EVERY process death. The Discord cursor
// already advanced past the queued inbound at receipt, so a respawn
// never re-fetches it — the 2026-10-06 incident (pi-bg callback queued
// 04:19:44, process restarted 04:19:52, callback never consumed).
//
// Two complementary survival layers, both keyed on the [bg: / pi-bg
// machine-wake contract (isBgWebhook in discord.ts):
//
//   option 2 (primary): every queued inbound is mirrored into a
//     per-channel state file (<stateDir>/rewake-<channelId>.json, the
//     same <cwd>/.tmp root the cursor uses) when it is queued, and
//     pruned when it is committed to pi (sendToPi) or intentionally
//     dropped (/stop, /reset, /restart, message delete, interrupt
//     cancel). session_shutdown keeps draining the in-memory queue
//     (fast path: ack cleanup) but leaves the file alone (survival
//     path). A real process start (session_start reason "startup")
//     drains the file back into the in-memory queue; the normal
//     agent_end re-wake delivers the entries — exactly once, because
//     each entry leaves the file exactly when it is committed or
//     dropped.
//
//   option 1 (backstop): the same startup pass does ONE bounded
//     history fetch per channel (messages?before=<cursor>&limit=N,
//     N = $PISCORD_REWAKE_LOOKBACK, default 50) and re-queues any
//     [bg:/pi-bg webhook post in the window that is not in the
//     delivered set (ids committed to pi, capped) and not already
//     pending. Covers the micro-window where the cursor advanced but
//     the queue-file write did not land (process died mid-ingest),
//     plus any other pre-queue loss. Non-bg human messages (including
//     a human quoting a callback body) have no webhook_id and are
//     never re-queued.
//
// Crash safety: every write is tmp+rename (atomic on POSIX; the
// single-threaded bridge is the only writer of a given file). A
// corrupt or partially-shaped file falls back to EMPTY (documented:
// pending entries are lost from the file, but option 1 re-finds
// undelivered [bg: posts — at-least-once over exactly-once is the
// safe direction when the dedupe set itself is suspect).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildChannelMessageFromRaw,
  isBgWebhook,
  isOlderSnowflake,
} from "./discord";
import type { ChannelConfig, ChannelMessage } from "./types";

// ─── constants ───────────────────────────────────────────────────────────

/** Startup history-scan lookback: how many messages before the cursor
 *  to inspect (default; $PISCORD_REWAKE_LOOKBACK overrides, clamped). */
export const REWAKE_LOOKBACK_DEFAULT = 50;
/** Hard clamp for the lookback bound (the scan is one REST call). */
export const REWAKE_LOOKBACK_MAX = 200;
/** Delivered-id cap per channel. Tied to the lookback clamp (MAX + 1)
 *  so the invariant holds with margin at the edge: any [bg: post inside
 *  the scan window, if ever committed, is within the last DELIVERED_CAP
 *  commits and therefore still in the set. A test pins the tie — raising
 *  REWAKE_LOOKBACK_MAX without the cap cannot slip through silently. */
export const REWAKE_DELIVERED_CAP = REWAKE_LOOKBACK_MAX + 1;
/** Age guard for the scan: applied uniformly to EVERY scan (file health
 *  is not inspected) — a candidate older than this is dropped, never
 *  re-queued. It bounds the re-queue to the last 72h of history: even a
 *  corrupt file (lost delivered set) cannot resurrect a [bg: post older
 *  than this. */
export const REWAKE_SCAN_MAX_AGE_MS = 72 * 3_600_000;
export const REWAKE_LOOKBACK_ENV = "PISCORD_REWAKE_LOOKBACK";

/** One persisted queued inbound. `text`/`title`/`display` (the
 *  pre-rendered interrupt copies) are deliberately NOT persisted —
 *  they are derived state; the re-wake path re-renders via
 *  handleInbound, and a resurrected entry without a pre-render simply
 *  does not arm the interrupt (the re-wake path owns it). */
export interface RewakePendingEntry {
  msg: ChannelMessage;
  queuedAt: number;
}

interface RewakeQueueFile {
  v: 1;
  pending: RewakePendingEntry[];
  /** Message ids committed to pi (sendToPi), newest last, capped.
   *  The dedupe set for the startup history scan. */
  delivered: string[];
}

const EMPTY: RewakeQueueFile = { v: 1, pending: [], delivered: [] };

/** Lookback bound: env override clamped to [1, REWAKE_LOOKBACK_MAX]. */
export function rewakeLookbackBound(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env[REWAKE_LOOKBACK_ENV]);
  if (!Number.isFinite(raw) || raw < 1) return REWAKE_LOOKBACK_DEFAULT;
  return Math.min(Math.floor(raw), REWAKE_LOOKBACK_MAX);
}

// ─── state file (per channel, crash-safe) ────────────────────────────────

export function rewakeQueuePath(stateDir: string, channelId: string): string {
  return path.join(stateDir, `rewake-${channelId}.json`);
}

/** Read the per-channel state file. Missing/corrupt file → empty
 *  (never throws; the caller may be on the startup hot path). */
export function loadRewakeQueue(
  stateDir: string | null | undefined,
  channelId: string,
): RewakeQueueFile {
  if (!stateDir) return { ...EMPTY, pending: [], delivered: [] };
  let data: unknown;
  try {
    data = JSON.parse(
      fs.readFileSync(rewakeQueuePath(stateDir, channelId), "utf8"),
    );
  } catch {
    return { ...EMPTY, pending: [], delivered: [] };
  }
  if (typeof data !== "object" || data === null)
    return { ...EMPTY, pending: [], delivered: [] };
  const d = data as Record<string, unknown>;
  const pending: RewakePendingEntry[] = [];
  if (Array.isArray(d.pending)) {
    for (const e of d.pending) {
      if (
        typeof e === "object" &&
        e !== null &&
        typeof (e as Record<string, unknown>).msg === "object" &&
        (e as Record<string, unknown>).msg !== null
      ) {
        const m = (e as RewakePendingEntry).msg;
        if (typeof m.messageId === "string" && m.messageId.length > 0)
          pending.push({
            msg: m as ChannelMessage,
            queuedAt:
              typeof (e as RewakePendingEntry).queuedAt === "number"
                ? (e as RewakePendingEntry).queuedAt
                : 0,
          });
      }
    }
  }
  const delivered: string[] = [];
  if (Array.isArray(d.delivered))
    for (const id of d.delivered)
      if (typeof id === "string") delivered.push(id);
  return { v: 1, pending, delivered };
}

/** Atomic write (tmp+rename, same pattern as channel-state.json).
 *  Never throws; returns false on I/O failure (the in-memory state
 *  stays authoritative for the process lifetime). */
export function saveRewakeQueue(
  stateDir: string | null | undefined,
  channelId: string,
  file: RewakeQueueFile,
): boolean {
  if (!stateDir) return false;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const p = rewakeQueuePath(stateDir, channelId);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

/** Append a queued inbound to the pending list (idempotent per
 *  message id — a re-queue of the same id is a no-op, so the file
 *  never holds a message twice). No write when nothing changed. */
export function rewakeAddPending(
  stateDir: string | null | undefined,
  channelId: string,
  entry: RewakePendingEntry,
): void {
  const file = loadRewakeQueue(stateDir, channelId);
  if (file.pending.some((p) => p.msg.messageId === entry.msg.messageId)) return;
  file.pending.push(entry);
  saveRewakeQueue(stateDir, channelId, file);
}

/** Remove one pending entry (intentional drop). No write when the id
 *  was not pending. */
export function rewakeRemovePending(
  stateDir: string | null | undefined,
  channelId: string,
  messageId: string,
): void {
  const file = loadRewakeQueue(stateDir, channelId);
  const next = file.pending.filter((p) => p.msg.messageId !== messageId);
  if (next.length === file.pending.length) return;
  file.pending = next;
  saveRewakeQueue(stateDir, channelId, file);
}

/** Rewrite a pending entry's msg in the file (MESSAGE_UPDATE on a
 *  queued message, #186 F2): the in-memory entry is re-rendered on
 *  edit, and a restart before delivery must drain the EDITED
 *  body/attachments, not the pre-edit msg. `queuedAt` (and FIFO order)
 *  are kept. No write when the id is not pending. */
export function rewakeUpdatePendingMsg(
  stateDir: string | null | undefined,
  channelId: string,
  messageId: string,
  msg: ChannelMessage,
): void {
  const file = loadRewakeQueue(stateDir, channelId);
  const e = file.pending.find((p) => p.msg.messageId === messageId);
  if (!e) return;
  e.msg = msg;
  saveRewakeQueue(stateDir, channelId, file);
}

/** Clear the whole pending list (in-process /new, /reload — mirrors
 *  the midTurnQueues.clear() their session_shutdown runs). The
 *  delivered set survives: it dedupes the next scan. No write when
 *  already empty (a restart with an empty queue changes nothing). */
export function rewakeClearPending(
  stateDir: string | null | undefined,
  channelId: string,
): void {
  const file = loadRewakeQueue(stateDir, channelId);
  if (file.pending.length === 0) return;
  file.pending = [];
  saveRewakeQueue(stateDir, channelId, file);
}

/** Commit a message to pi: remove it from pending (if still there —
 *  a cursor-replay re-delivery of a pending id commits through here)
 *  and record its id in the delivered set (capped). No write when
 *  nothing changed (already-delivered, non-queued direct inbounds
 *  that have no pending copy still record once, then no-op). */
export function rewakeCommitDelivered(
  stateDir: string | null | undefined,
  channelId: string,
  messageId: string,
): void {
  const file = loadRewakeQueue(stateDir, channelId);
  let changed = false;
  const next = file.pending.filter((p) => p.msg.messageId !== messageId);
  if (next.length !== file.pending.length) {
    file.pending = next;
    changed = true;
  }
  if (!file.delivered.includes(messageId)) {
    file.delivered.push(messageId);
    if (file.delivered.length > REWAKE_DELIVERED_CAP)
      file.delivered.splice(0, file.delivered.length - REWAKE_DELIVERED_CAP);
    changed = true;
  }
  if (changed) saveRewakeQueue(stateDir, channelId, file);
}

/** Pending entries (file → memory survival drain). */
export function rewakePending(
  stateDir: string | null | undefined,
  channelId: string,
): RewakePendingEntry[] {
  return loadRewakeQueue(stateDir, channelId).pending;
}

export function rewakePendingIds(
  stateDir: string | null | undefined,
  channelId: string,
): Set<string> {
  return new Set(
    rewakePending(stateDir, channelId).map((p) => p.msg.messageId),
  );
}

export function rewakeDeliveredIds(
  stateDir: string | null | undefined,
  channelId: string,
): Set<string> {
  return new Set(loadRewakeQueue(stateDir, channelId).delivered);
}

// ─── option 1: bounded startup history scan ──────────────────────────────

export interface BgScanChannel {
  /** Bridge channel config (builds the ChannelMessage identity). */
  config: ChannelConfig;
  /** Resolved numeric Discord channel id (REST target). */
  discordId: string;
  /** The persisted cursor (last RECEIVED id). null = fresh channel:
   *  nothing was received before, nothing can be lost — skip. */
  cursor: string | null;
  /** Bot token for the REST fetch. */
  token: string;
}

export interface BgScanOpts {
  stateDir: string;
  channels: BgScanChannel[];
  /** REST fetcher (discordFetch in the bridge; a stub in tests).
   *  Must reject on failure — a dead network at boot is a silent
   *  no-op for the scan, never a startup failure. */
  fetcher: (token: string, urlPath: string) => Promise<unknown>;
  lookback?: number;
  maxAgeMs?: number;
  now?: number;
  /** Called once per re-queued candidate. The caller owns BOTH the
   *  memory push (deduped) and any logging; the file append happens
   *  here, so scan + memory stay in sync. */
  requeue: (entry: RewakePendingEntry, channelId: string) => void;
}

export interface BgScanResult {
  /** Raw window messages inspected. */
  scanned: number;
  /** Candidates re-queued (file + memory). */
  requeued: number;
}

/** Re-queue undelivered [bg:/pi-bg webhook posts from the bounded
 *  pre-cursor window. One REST call per channel, fire-and-forget at
 *  the call site. Never throws. */
export async function scanUndeliveredBgInbounds(
  opts: BgScanOpts,
): Promise<BgScanResult> {
  const lookback = opts.lookback ?? rewakeLookbackBound();
  const maxAgeMs = opts.maxAgeMs ?? REWAKE_SCAN_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  let scanned = 0;
  let requeued = 0;
  for (const ch of opts.channels) {
    if (!ch.token || !ch.cursor) continue;
    let raws: any[];
    try {
      const raw = await opts.fetcher(
        ch.token,
        `/channels/${encodeURIComponent(ch.discordId)}/messages?before=${encodeURIComponent(
          ch.cursor,
        )}&limit=${lookback}`,
      );
      raws = Array.isArray(raw) ? raw : [];
    } catch {
      continue; // boot-time network failure: the primary layer stands
    }
    // Oldest-first (the window arrives newest-first or unordered; the
    // re-queue must keep message order).
    raws = raws.filter((m) => m && typeof m.id !== "undefined");
    raws.sort((a, b) =>
      isOlderSnowflake(String(a.id), String(b.id)) ? -1 : 1,
    );
    const file = loadRewakeQueue(opts.stateDir, ch.config.id);
    const pending = new Set(file.pending.map((p) => p.msg.messageId));
    const delivered = new Set(file.delivered);
    for (const raw of raws) {
      scanned += 1;
      const id = String(raw.id);
      if (!isBgWebhook(raw)) continue; // human/peer: not a machine wake
      if (id === ch.cursor) continue; // the cursor message is accounted
      if (delivered.has(id) || pending.has(id)) continue; // already done
      const t = Date.parse(String(raw.timestamp ?? ""));
      if (Number.isFinite(t) && now - t > maxAgeMs) continue; // stale
      opts.requeue(
        { msg: buildChannelMessageFromRaw(ch.config, raw), queuedAt: t },
        ch.config.id,
      );
      requeued += 1;
    }
  }
  return { scanned, requeued };
}
