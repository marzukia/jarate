// #306: persistent seen sets — at-most-once channel delivery across
// restarts + restart-wake card dedupe.
//
// The persisted cursor (channel-state.json "cursors") is the in-order
// gate: a message below the cursor is never re-delivered. The op window
// rewinds that cursor (restart-ops.ts), so a re-fetched, already
// delivered message would otherwise be delivered again — the older wake
// card replayed after a newer one. The seen sets add the cross-rewind
// at-most-once record:
//   seen     — message ids already delivered (delivery-ordered, capped,
//             age-pruned by snowflake time)
//   seenWake — restart-wake card keys (hash of the wake embed); a
//             double-posted card (retry double-post; two clean startups
//             both posting) has two Discord message ids but one key.
// Both sections live in channel-state.json next to the cursors.
import fs from "node:fs";
import path from "node:path";
import { WAKE_TAG } from "./restart-wake";
import type { AttachmentRef } from "./types";

/** Keep the newest N seen ids (bounded file). */
export const SEEN_IDS_CAP = 500;
/** Keep the newest N seen wake keys. */
export const SEEN_WAKE_CAP = 100;
/** Seen ids older than this are pruned (snowflake time). */
export const SEEN_MAX_AGE_MS = 72 * 3_600_000;

/** Snowflake → ms timestamp (Discord epoch 2015-01-01). 0 when
 *  unparseable. */
export function snowflakeTimeMs(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + 1420070400000n);
  } catch {
    return 0;
  }
}

/** Prune a seen-id list: drop ids whose snowflake time is older than
 *  SEEN_MAX_AGE_MS; ids with an implausible snowflake time (too old for
 *  the Discord epoch, or in the future beyond clock skew) are kept.
 *  Order (delivery order) is preserved; the newest cap is kept. */
export function pruneSeenIds(
  ids: string[],
  now: number = Date.now(),
): string[] {
  const minT = 1420070400000 + 86_400_000; // Discord epoch + 1 day
  const maxT = now + 86_400_000; // clock-skew tolerance
  const kept = ids.filter((id) => {
    const t = snowflakeTimeMs(id);
    if (t < minT || t > maxT) return true; // not a plausible snowflake → keep
    return now - t <= SEEN_MAX_AGE_MS;
  });
  return kept.length > SEEN_IDS_CAP ? kept.slice(-SEEN_IDS_CAP) : kept;
}

export function pruneSeenWakeKeys(keys: string[]): string[] {
  return keys.length > SEEN_WAKE_CAP ? keys.slice(-SEEN_WAKE_CAP) : keys;
}

export interface SeenSections {
  seen: Record<string, string[]>;
  seenWake: Record<string, string[]>;
}

function strArr(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) if (typeof x === "string") out.push(x);
  return out;
}

/** Parse the optional seen sections from a channel-state.json object. */
export function parseSeenSections(data: Record<string, unknown>): SeenSections {
  const seen: Record<string, string[]> = {};
  const seenWake: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(
    (data.seen ?? {}) as Record<string, unknown>,
  )) {
    const a = strArr(v);
    if (a) seen[k] = a;
  }
  for (const [k, v] of Object.entries(
    (data.seenWake ?? {}) as Record<string, unknown>,
  )) {
    const a = strArr(v);
    if (a) seenWake[k] = a;
  }
  return { seen, seenWake };
}

/** djb2 (same basis as handover.ts). */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/** The dedupe key for a restart-wake card: the hash of the wake embed
 *  (author + title + description + fields + footer). A double-posted
 *  card has two Discord message ids but one key → at-most-once at the
 *  session. Non-wake messages → null. */
export function wakeEmbedKey(raw: any): string | null {
  const author = raw?.embeds?.[0]?.author?.name;
  if (typeof author !== "string" || !author.startsWith(WAKE_TAG)) return null;
  const e = raw.embeds[0];
  const parts: string[] = [author];
  if (e.title) parts.push(e.title);
  if (e.description) parts.push(e.description);
  for (const f of e.fields ?? []) parts.push(`${f.name}:${f.value}`);
  if (e.footer?.text) parts.push(e.footer.text);
  return `w${djb2(parts.join("\n"))}`;
}

export interface SeenState {
  seenIds: Set<string>;
  seenWakeKeys: Set<string>;
}

/** Empty seen sections (for fresh/legacy state files). */
export function emptySeenSections(): SeenSections {
  return { seen: {}, seenWake: {} };
}

/** Empty in-memory seen state. */
export function emptySeenState(): SeenState {
  return { seenIds: new Set(), seenWakeKeys: new Set() };
}

/** Seed the in-memory seen sets from the persisted sections. */
export function seedSeenSets(
  sections: SeenSections,
  channelId: string,
): SeenState {
  return {
    seenIds: new Set(sections.seen[channelId] ?? []),
    seenWakeKeys: new Set(sections.seenWake[channelId] ?? []),
  };
}

/** Apply the seen sections to a state file object (pruned). */
export function applySeenSections(
  data: SeenSections,
  channelId: string,
  seenIds: Iterable<string>,
  seenWakeKeys: Iterable<string>,
): void {
  data.seen = { ...data.seen, [channelId]: pruneSeenIds([...seenIds]) };
  data.seenWake = {
    ...data.seenWake,
    [channelId]: pruneSeenWakeKeys([...seenWakeKeys]),
  };
}

/** #306 at-most-once check. Returns true when the message must be
 *  dropped (already seen). Records the id/key on delivery. The cursor
 *  checks (in-order gate) run first in the caller. */
export function seenDrop(state: SeenState, id: string, raw: any): boolean {
  const wk = wakeEmbedKey(raw);
  if (wk) {
    if (state.seenWakeKeys.has(wk)) return true;
    state.seenWakeKeys.add(wk);
  }
  if (state.seenIds.has(id)) return true;
  state.seenIds.add(id);
  return false;
}

/** True when both ids are snowflakes and a sorts before b. */
export function isOlderSnowflake(a: string, b: string | null): boolean {
  if (!b) return false;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) < BigInt(b);
  return false;
}

/** Map a raw Discord attachments array to AttachmentRefs. */
export function mapAttachmentRefs(raw: any): AttachmentRef[] {
  return (raw || []).map((a: any) => ({
    id: a.id,
    filename: a.filename || "file",
    contentType: a.content_type || "application/octet-stream",
    size: a.size || 0,
    url: a.url,
    duration: typeof a.duration === "number" ? a.duration : undefined,
    waveform: typeof a.waveform === "string" ? a.waveform : undefined,
  }));
}

// ─── Per-channel state file (cursors + runtime flags + seen) ────────
// Per-channel lastMessageId survives process restarts so messages sent
// while pi was down are picked up (instead of the cursor re-seeding to
// "now" and losing them). The file is the bridge's per-channel state
// store; the cursor section coexists with per-channel runtime flags
// (#39 hold, #10 verbosity) and the #306 seen sections without a
// second store.
//
// Format (the legacy flat cursor map still reads):
//   { "cursors": { "<discordChannelId>": "<lastMessageId>" },
//     "channels": { "<configId>": { "hold": true, "verbose": 1 } },
//     "seen": { "<discordChannelId>": ["<messageId>", ...] },
//     "seenWake": { "<discordChannelId>": ["<wakeKey>", ...] } }
// Cursors + seen are keyed by Discord channel id (numeric); channel
// flags by config id (the settings.json "id") — separate key spaces,
// one file.

export interface ChannelSettingsState {
  /** #39: channel held — plain messages buffer in the re-wake queue. */
  hold?: boolean;
  /** #10: 3-level verbosity override (0 text / 1 essential / 2 all). */
  verbose?: number;
}

export interface ChannelStateFile extends SeenSections {
  cursors: Record<string, string>;
  channels: Record<string, ChannelSettingsState>;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Read the per-channel state file. Missing/corrupt file → empty. */
export function loadChannelStateFile(
  stateDir: string | null | undefined,
): ChannelStateFile {
  const empty: ChannelStateFile = {
    cursors: {},
    channels: {},
    ...emptySeenSections(),
  };
  if (!stateDir) return empty;
  let data: unknown;
  try {
    data = JSON.parse(
      fs.readFileSync(path.join(stateDir, "channel-state.json"), "utf-8"),
    );
  } catch {
    return empty;
  }
  if (!isObj(data)) return empty;
  // Legacy format: a flat discordChannelId → lastMessageId map (no
  // "cursors" section) — treat every string value as a cursor.
  if (!isObj(data.cursors)) {
    const cursors: Record<string, string> = {};
    for (const [k, v] of Object.entries(data))
      if (typeof v === "string") cursors[k] = v;
    return { cursors, channels: {}, ...emptySeenSections() };
  }
  const cursors: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.cursors))
    if (typeof v === "string") cursors[k] = v;
  const channels: Record<string, ChannelSettingsState> = {};
  if (isObj(data.channels)) {
    for (const [k, v] of Object.entries(data.channels)) {
      if (!isObj(v)) continue;
      channels[k] = {
        hold: v.hold === true ? true : v.hold === false ? false : undefined,
        verbose: typeof v.verbose === "number" ? v.verbose : undefined,
      };
    }
  }
  return { cursors, channels, ...parseSeenSections(data) };
}

/** Persist the current cursor + seen sections. No-op without a
 *  stateDir; never throws. Preserves the sibling "channels" section. */
export function persistChannelCursor(state: {
  stateDir: string | null;
  channelId: string;
  lastMessageId: string | null;
  seen: SeenState;
}): void {
  if (!state.stateDir || !state.lastMessageId) return;
  try {
    const file = path.join(state.stateDir, "channel-state.json");
    const data = loadChannelStateFile(state.stateDir);
    data.cursors[state.channelId] = state.lastMessageId;
    applySeenSections(
      data,
      state.channelId,
      state.seen.seenIds,
      state.seen.seenWakeKeys,
    );
    fs.mkdirSync(state.stateDir, { recursive: true });
    // Atomic write: temp file + rename so a crash cannot leave a torn
    // channel-state.json (the loader treats non-JSON as empty state,
    // which would reseed and lose history).
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  } catch {}
}

/** Merge per-channel runtime flags (hold / verbose) into the state
 *  file. No-op without a stateDir; never throws. */
export function patchChannelState(
  stateDir: string | null | undefined,
  configId: string,
  patch: ChannelSettingsState,
): void {
  if (!stateDir) return;
  const file = path.join(stateDir, "channel-state.json");
  const data = loadChannelStateFile(stateDir);
  const cur = data.channels[configId] ?? {};
  data.channels[configId] = { ...cur, ...patch };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/** Read persisted cursors (discord channel id → last message id).
 *  Corrupt file = empty. */
export function loadPersistedCursors(
  stateDir: string | null | undefined,
): Record<string, string> {
  return loadChannelStateFile(stateDir).cursors;
}
