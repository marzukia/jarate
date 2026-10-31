// restart-queue — re-wake queue survival across a process restart (#180).
//
// The mid-turn re-wake queue (index.ts midTurnQueues) is in-memory, and
// session_shutdown drains it on EVERY process death. The Discord cursor
// already advanced past the queued inbound at receipt, so a respawn
// never re-fetches it — the 2026-10-06 incident (pi-bg callback queued
// 04:19:44, process restarted 04:19:52, callback never consumed).
//
// Two complementary survival layers, both keyed on the machine-wake
// contract (isBgWebhook in discord.ts: ANY webhook-posted message):
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
//     machine-wake (webhook_id) post in the window that is not in the
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
// undelivered machine-wake posts — at-least-once over exactly-once is the
// safe direction when the dedupe set itself is suspect).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadChannelStateFile,
  type SeenState,
  seedSeenSets,
  wakeEmbedKey,
} from "./channel-state";
import {
  buildChannelMessageFromRaw,
  isBgWebhook,
  isOlderSnowflake,
} from "./discord";
import { atomicWriteJson, sweepOrphanTmpFiles } from "./durable-store";
import type { ChannelConfig, ChannelMessage } from "./types";

// ─── constants ───────────────────────────────────────────────────────────

/** Startup history-scan lookback: how many messages before the cursor
 *  to inspect (default; $PISCORD_REWAKE_LOOKBACK overrides, clamped). */
export const REWAKE_LOOKBACK_DEFAULT = 50;
/** Hard clamp for the lookback bound (the scan is one REST call). */
export const REWAKE_LOOKBACK_MAX = 200;
/** Delivered-id cap per channel. Decoupled from the lookback clamp
 *  (#1083, replay-gap root fix): sized to survive many restarts of
 *  commit volume (5,000 ids ≈ ~100KB of ~20-byte strings), not just one
 *  scan window — the old tie (LOOKBACK_MAX + 1) evicted an id 201+
 *  commits after its commit, which a busy window breaks. The at-least-
 *  once bias is unchanged: a commit recorded post-acceptance stays the
 *  single dedupe authority for the scan. deliveredMeta detail is capped
 *  separately (REWAKE_DELIVERED_META_CAP). */
export const REWAKE_DELIVERED_CAP = 5000;
/** deliveredMeta cap per channel (#1083, decoupled from the id cap):
 *  it stores full prompts — the 24h amnesia guard needs only recent
 *  commits, so keep it small and independent of the 5,000 id horizon. */
export const REWAKE_DELIVERED_META_CAP = 50;
/** Age guard for the scan: applied uniformly to EVERY scan (file health
 *  is not inspected) — a candidate older than this is dropped, never
 *  re-queued. It bounds the re-queue to the last 72h of history: even a
 *  corrupt file (lost delivered set) cannot resurrect a machine-wake post
 *  older than this. */
export const REWAKE_SCAN_MAX_AGE_MS = 72 * 3_600_000;
export const REWAKE_LOOKBACK_ENV = "PISCORD_REWAKE_LOOKBACK";

/** One persisted queued inbound. `text`/`title`/`display` (the
 *  pre-rendered interrupt copies) are deliberately NOT persisted —
 *  they are derived state; the re-wake path re-renders via
 *  handleInbound, and a resurrected entry without a pre-render simply
 *  does not arm the interrupt (the re-wake path owns it). `ackId`
 *  (the `[queued] N in line` line's Discord message id, mirrored when
 *  the ack POST resolves) IS persisted: a fresh process has an EMPTY
 *  queuedAcks map, so the drain (drainRewakeSurvival) restores the
 *  line from the file and the re-wake drain's consumeQueuedAck deletes
 *  it exactly once — without the id the kept line is orphaned forever
 *  (PR #194's crash-settle keeps it alive across the restart when a
 *  rewake entry is restored). Absent on files written before the
 *  field — it is additive, v:1 unchanged. */
export interface RewakePendingEntry {
  msg: ChannelMessage;
  queuedAt: number;
  ackId?: string;
}

interface RewakeQueueFile {
  v: 1;
  pending: RewakePendingEntry[];
  /** Message ids committed to pi (sendToPi), newest last, capped.
   *  The dedupe set for the startup history scan. */
  delivered: string[];
  /** #306 amnesia: per-delivered-id commit metadata (the full prompt
   *  sent to pi + the inbound's ChannelMessage + commit time + the
   *  session file path at commit). Additive, v:1 unchanged — absent on
   *  files written before the field. */
  deliveredMeta?: Record<string, DeliveredMeta>;
}

/** #306 amnesia: commit metadata for one delivered id. `prompt` is the
 *  FULL prompt (channel ctx + body) sendToPi sent to pi — it matches the
 *  session file's custom_message content exactly, so a committed id is
 *  "persisted" iff its prompt is in the session file. `msg` is the
 *  inbound's ChannelMessage, kept so an accepted-but-unpersisted id can
 *  be re-queued (the re-wake drain re-renders via handleInbound). `sf`
 *  is the session file path at commit — the SAME-FILE guard: a /new
 *  session (a different file) must not re-queue the old session's
 *  messages. */
export interface DeliveredMeta {
  prompt: string;
  msg: ChannelMessage;
  at: number;
  sf: string;
}

/** #306 amnesia: an accepted-but-unpersisted delivered id, ready to
 *  re-queue (the re-wake drain delivers it at the next agent_end). */
export interface AmnesiaEntry {
  id: string;
  msg: ChannelMessage;
  at: number;
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
        if (typeof m.messageId === "string" && m.messageId.length > 0) {
          const entry: RewakePendingEntry = {
            msg: m as ChannelMessage,
            queuedAt:
              typeof (e as RewakePendingEntry).queuedAt === "number"
                ? (e as RewakePendingEntry).queuedAt
                : 0,
          };
          const a = (e as RewakePendingEntry).ackId;
          if (typeof a === "string" && a.length > 0) entry.ackId = a;
          pending.push(entry);
        }
      }
    }
  }
  const delivered: string[] = [];
  if (Array.isArray(d.delivered))
    for (const id of d.delivered)
      if (typeof id === "string") delivered.push(id);
  const deliveredMeta: Record<string, DeliveredMeta> = {};
  if (typeof d.deliveredMeta === "object" && d.deliveredMeta !== null)
    for (const [id, m] of Object.entries(
      d.deliveredMeta as Record<string, unknown>,
    )) {
      const meta = m as Record<string, unknown>;
      if (
        typeof meta?.prompt === "string" &&
        typeof meta?.msg === "object" &&
        meta?.msg !== null &&
        typeof (meta.msg as Record<string, unknown>)?.messageId === "string" &&
        typeof meta?.at === "number" &&
        typeof meta?.sf === "string"
      )
        deliveredMeta[id] = {
          prompt: meta.prompt,
          msg: meta.msg as ChannelMessage,
          at: meta.at,
          sf: meta.sf,
        };
    }
  return { v: 1, pending, delivered, deliveredMeta };
}

/** Atomic write (shared atomicWriteJson: tmp+rename, the one tmp naming
 *  scheme). Never throws; returns false on I/O failure (the in-memory
 *  state stays authoritative for the process lifetime). */
export function saveRewakeQueue(
  stateDir: string | null | undefined,
  channelId: string,
  file: RewakeQueueFile,
): boolean {
  if (!stateDir) return false;
  try {
    atomicWriteJson(rewakeQueuePath(stateDir, channelId), file);
    return true;
  } catch {
    return false;
  }
}

/** Sweep orphan tmp files for this channel's rewake queue (crash
 *  between tmp write and rename). Best-effort: never throws, returns
 *  the count removed. Called once per real process start (the survival
 *  drain). */
export function collectRewakeOrphans(
  stateDir: string | null | undefined,
  channelId: string,
): number {
  if (!stateDir) return 0;
  return sweepOrphanTmpFiles(
    stateDir,
    path.basename(rewakeQueuePath(stateDir, channelId)),
  );
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

/** Set a pending entry's ack line id (the `[queued] N in line` post,
 *  mirrored when the ack POST resolves): a fresh process has an empty
 *  queuedAcks map, so the startup drain restores the line from the
 *  file and the re-wake drain deletes it exactly once — without the
 *  id, PR #194's crash-settle keeps the line alive across the restart
 *  and nothing ever deletes it (orphan). No write when the id is not
 *  pending (entry already committed/dropped — the line was consumed
 *  in-process) or already set. */
export function rewakeSetPendingAck(
  stateDir: string | null | undefined,
  channelId: string,
  messageId: string,
  ackId: string,
): void {
  const file = loadRewakeQueue(stateDir, channelId);
  const e = file.pending.find((p) => p.msg.messageId === messageId);
  if (!e || e.ackId === ackId) return;
  e.ackId = ackId;
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
 *  and record its id in the delivered set (capped). #306: also record
 *  commit metadata (the full prompt + the inbound's ChannelMessage +
 *  commit time + the session file path) when provided — the amnesia
 *  resurrection cross-checks this against the resumed session file.
 *  No write when nothing changed (already-delivered, non-queued direct
 *  inbounds that have no pending copy still record once, then no-op). */
export function rewakeCommitDelivered(
  stateDir: string | null | undefined,
  channelId: string,
  messageId: string,
  meta?: DeliveredMeta,
): void {
  const file = loadRewakeQueue(stateDir, channelId);
  let changed = false;
  const next = file.pending.filter((p) => p.msg.messageId !== messageId);
  if (next.length !== file.pending.length) {
    file.pending = next;
    changed = true;
  }
  const idAlreadyDelivered = file.delivered.includes(messageId);
  if (!idAlreadyDelivered) {
    file.delivered.push(messageId);
    if (file.delivered.length > REWAKE_DELIVERED_CAP)
      file.delivered.splice(0, file.delivered.length - REWAKE_DELIVERED_CAP);
    changed = true;
  }
  // #306: record/refresh the commit metadata. #1083: capped SEPARATELY
  // and small (REWAKE_DELIVERED_META_CAP) — it stores full prompts while
  // the id list carries the 5,000-entry dedupe horizon. A pruned id's
  // meta is dropped too, so the map cannot grow unbounded. A re-commit
  // of an already-delivered id refreshes its meta (a newer commit is the
  // one that can be amnesiac).
  if (meta) {
    if (!file.deliveredMeta) file.deliveredMeta = {};
    file.deliveredMeta[messageId] = meta;
    const ids = Object.keys(file.deliveredMeta);
    if (ids.length > REWAKE_DELIVERED_META_CAP) {
      // Keep the meta for the ids still in the delivered set (newest
      // last); drop the rest.
      const keep = new Set(file.delivered);
      for (const id of ids) if (!keep.has(id)) delete file.deliveredMeta[id];
      // Still over cap (delivered outlives meta by design): keep the
      // newest (insertion order — oldest first), drop the remainder.
      const remaining = Object.keys(file.deliveredMeta);
      for (const id of remaining.slice(
        0,
        remaining.length - REWAKE_DELIVERED_META_CAP,
      ))
        delete file.deliveredMeta[id];
    }
    if (!idAlreadyDelivered) changed = true;
    else if (!file.deliveredMeta[messageId]) changed = true;
    else if (
      file.deliveredMeta[messageId].at !== meta.at ||
      file.deliveredMeta[messageId].sf !== meta.sf
    )
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

// ─── #306 amnesia: accepted-but-unpersisted resurrection ────────────────

/** #306 amnesia age guard: a committed id older than this is never
 *  re-queued (bounds the resurrection to the last 24h — a long-dead
 *  commit is almost certainly answered in a since-rotated session). */
export const AMNESIA_MAX_AGE_MS = 24 * 3_600_000;

// #306 amnesia: the active session file, captured at session_start
// (safeSessionFile ?? findSessionFile). sendToPi stamps it into the
// delivered-set commit metadata (the SAME-FILE guard); the startup
// amnesia check cross-checks the delivered set against this file.
let currentSessionFile: string | null = null;

/** Capture the active session file for the amnesia commit stamp.
 *  Called once at session_start. */
export function setCurrentSessionFile(file: string | null): void {
  currentSessionFile = file;
}

/** The session file captured at the last session_start (null = unknown).
 *  Used by sendToPi to stamp the commit metadata's same-file guard. */
export function getCurrentSessionFile(): string | null {
  return currentSessionFile;
}

/** #306 amnesia: build the commit metadata for one sendToPi commit.
 *  `prompt` is the FULL prompt (channel ctx + body) sent to pi — it
 *  matches the session file's custom_message content exactly. `msg` is
 *  the inbound's ChannelMessage (or a minimal reconstruction from the
 *  display body when the caller has no inbound), kept so an
 *  accepted-but-unpersisted id can be re-queued. `sf` is the session
 *  file path at commit (the SAME-FILE guard). */
export function buildDeliveredMeta(
  text: string,
  msg: ChannelMessage | undefined,
  messageId: string,
): DeliveredMeta {
  return {
    prompt: text,
    // Every sendToPi call site that carries a messageId passes the
    // inbound's ChannelMessage; the fallback (a synthetic prompt with no
    // inbound) keeps the real messageId so the re-queue dedupes it
    // correctly (the channel itself is routed by config, not msg).
    msg: msg ?? {
      channelId: "",
      channelName: "",
      channelType: "discord",
      messageId,
      from: "",
      body: text,
      timestamp: new Date().toISOString(),
      attachments: [],
      isRoom: false,
    },
    at: Date.now(),
    sf: currentSessionFile ?? "",
  };
}

/** Read the set of prompt strings persisted in a pi session file
 *  (JSONL). A bridge inbound lands as a `custom_message` entry whose
 *  `content` is the FULL prompt (channel ctx + body) — exactly what
 *  sendToPi sent. A TUI/`message` user-role entry (string content, or
 *  the joined text blocks of an array content) is included too. Never
 *  throws: an unreadable file yields an empty set (the caller then
 *  re-queues nothing — at-most-once over at-least-once is the safe
 *  direction when the session file itself is suspect). */
export function readSessionPrompts(sessionFile: string): Set<string> {
  const out = new Set<string>();
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    if (o.type === "custom_message" && typeof o.content === "string") {
      out.add(o.content);
      continue;
    }
    if (o.type === "message" && o.message?.role === "user") {
      const c = o.message.content;
      if (typeof c === "string") {
        out.add(c);
      } else if (Array.isArray(c)) {
        const text = c
          .filter(
            (b: any) =>
              typeof b === "string" ||
              (b && typeof b === "object" && typeof b.text === "string"),
          )
          .map((b: any) => (typeof b === "string" ? b : b.text))
          .join("");
        if (text) out.add(text);
      }
    }
  }
  return out;
}

/** #306 amnesia: the delivered ids pi ACCEPTED (committed at sendToPi)
 *  but never PERSISTED to the session file (a mid-turn restart killed
 *  the process before the steering queue drained). These are the ids the
 *  delivered set says "done" but the session file does not have — the
 *  silent amnesia. Returns them ready to re-queue.
 *
 *  Guards: (1) SAME-FILE — only ids committed against THIS session file
 *  (meta.sf === sessionFile); a /new session (a different file) must not
 *  re-queue the old session's messages. (2) AGE — only commits within
 *  maxAgeMs. (3) PERSISTED — an id whose prompt is in the session file
 *  is answered; skip it. */
export function rewakeUnpersisted(
  stateDir: string | null | undefined,
  channelId: string,
  sessionFile: string | null | undefined,
  now = Date.now(),
  maxAgeMs = AMNESIA_MAX_AGE_MS,
): AmnesiaEntry[] {
  if (!sessionFile) return [];
  const file = loadRewakeQueue(stateDir, channelId);
  const meta = file.deliveredMeta;
  if (!meta) return [];
  const persisted = readSessionPrompts(sessionFile);
  const out: AmnesiaEntry[] = [];
  for (const id of file.delivered) {
    const m = meta[id];
    if (!m) continue; // no commit metadata (pre-field file) — cannot check
    if (m.sf !== sessionFile) continue; // same-file guard
    if (now - m.at > maxAgeMs) continue; // stale
    if (persisted.has(m.prompt)) continue; // persisted — answered
    out.push({ id, msg: m.msg, at: m.at });
  }
  return out;
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
  /** #1083 fix A (belt): override for the #306 seen state per channel.
   *  Absent = the scan seeds it itself from channel-state.json in
   *  stateDir (seeded once per scan, per channel — one boot, one
   *  file). An at-most-once cross-check that only ADDS drops: a
   *  candidate whose id is in seen or whose wake key is in seenWake
   *  is dropped before re-queue. The delivered check stays the
   *  primary authority (at-least-once bias preserved). */
  seenLookup?: (configId: string) => SeenState | null;
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

/** Re-queue undelivered machine-wake (webhook_id) posts from the bounded
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
    // #1083 fix A: the #306 seen state (an independent store from the
    // rewake file — the file can be lost/corrupt/cap-evicted while
    // channel-state.json is healthy). One load per channel per boot.
    const seen =
      opts.seenLookup?.(ch.config.id) ??
      (ch.discordId
        ? seedSeenSets(loadChannelStateFile(opts.stateDir), ch.discordId)
        : null);
    for (const raw of raws) {
      scanned += 1;
      const id = String(raw.id);
      if (!isBgWebhook(raw)) continue; // human/peer: not a machine wake
      if (id === ch.cursor) continue; // the cursor message is accounted
      if (delivered.has(id) || pending.has(id)) continue; // already done
      // #1083 fix A: the #306 seen sets (an independent store — the
      // rewake file can be lost/corrupt/cap-evicted while the seen
      // section is healthy). seenWake additionally dedupes a
      // double-posted wake card by content hash (the re-post has a new
      // id the id checks miss). At-most-once: only adds drops, the
      // delivered check above stays the primary authority.
      const wk = wakeEmbedKey(raw);
      if (
        seen &&
        (seen.seenIds.has(id) || (wk !== null && seen.seenWakeKeys.has(wk)))
      )
        continue;
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
