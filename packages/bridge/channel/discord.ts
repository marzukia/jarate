/**
 * Discord channel client — gateway ingest + REST backfill + send.
 *
 * Primary ingest is gateway MESSAGE_CREATE push. A REST poll runs as a
 * backfill safety net (60s while the gateway is connected, 5s otherwise).
 * Both paths share one delivery pipeline (deliverInboundMessage) deduped
 * against a single per-channel cursor, so a message lands at most once.
 *
 * Attachments are downloaded eagerly into a batch folder on arrival
 * (20 MB per-file cap). All message text is wrapped in <channel-context>
 * before reaching the LLM.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import WebSocket from "ws";
import { censor } from "./censor";
import { serializeEmbeds } from "./format";
import { isSupportedImageMime, optimizeImageBuffer } from "./image-optimizer";
import { sanitizeSensitiveText } from "./sanitize";
import type {
  AttachmentContent,
  AttachmentRef,
  ChannelConfig,
  ChannelMessage,
} from "./types";

const DISCORD_API = "https://discord.com/api/v10";
/** Poll interval (ms) when the gateway is NOT delivering messages. */
export const POLL_INTERVAL_MS = 5_000;
/** Backfill poll interval (ms) when the gateway is connected. */
export const POLL_BACKFILL_MS = 60_000;
/** Gateway intents: GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | GUILD_MESSAGE_CONTENT = 37377. */
const GATEWAY_INTENTS = 1 | (1 << 9) | (1 << 12) | (1 << 15);

// ─── Private state per channel ─────────────────────────────────────────────

interface DiscordState {
  config: ChannelConfig;
  channelId: string;
  botUserId: string | null;
  lastMessageId: string | null;
  /** Directory for cursor persistence (channel-state.json). Unset = no persistence. */
  stateDir: string | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  consecutiveErrors: number;
  pollPauseUntil: number;
  polling: boolean;
  /** Live session callbacks — refreshed on every connect so the poller
   *  never talks to a stale session after an in-process restart. */
  callbacks: DiscordCallbacks;
  /** Startup message not yet posted (waiting for bot identity). */
  startupPending: boolean;
}

const states = new Map<string, DiscordState>();

// ─── API helpers ───────────────────────────────────────────────────────────

async function discordFetch(
  token: string,
  urlPath: string,
  opts?: { method?: string; body?: any },
): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  };
  if (opts?.body) opts.body = JSON.stringify(opts.body);

  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(`${DISCORD_API}${urlPath}`, {
      method: opts?.method || "GET",
      headers,
      body: opts?.body,
    });

    if (resp.status === 429) {
      let waitMs = 1500;
      try {
        const data: any = await resp.json();
        if (typeof data?.retry_after === "number")
          waitMs = data.retry_after * 1000 + 100;
      } catch {}
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Discord API ${resp.status}: ${text.slice(0, 200)}`);
    }

    if (resp.status === 204) return null;
    return resp.json();
  }
  throw new Error("Discord API 429: rate limited after 3 attempts");
}

/** Raw-body variant of discordFetch (multipart uploads). Same 429 retry. */
async function discordFetchRaw(
  token: string,
  urlPath: string,
  opts: { method?: string; body: any },
): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bot ${token}` };
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(`${DISCORD_API}${urlPath}`, {
      method: opts.method || "POST",
      headers,
      body: opts.body,
    });
    if (resp.status === 429) {
      let waitMs = 1500;
      try {
        const data: any = await resp.json();
        if (typeof data?.retry_after === "number")
          waitMs = data.retry_after * 1000 + 100;
      } catch {}
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Discord API ${resp.status}: ${text.slice(0, 200)}`);
    }
    if (resp.status === 204) return null;
    return resp.json();
  }
  throw new Error("Discord API 429: rate limited after 3 attempts");
}

// ─── Channel name → ID resolution ──────────────────────────────────────────

// Keyed by token + name — two bots may share a channel name with different ids.
const idCache = new Map<string, string>();
const idCacheKey = (token: string, name: string) => `${token}\u0000${name}`;

/** Resolve a Discord channel reference (numeric id or name) to a channel id. Exported for tests. */
export async function resolveChannelId(
  token: string,
  raw: string,
): Promise<string | null> {
  if (/^\d+$/.test(raw)) return raw; // already an ID
  const key = idCacheKey(token, raw);
  if (idCache.has(key)) return idCache.get(key)!;

  // Try guild channels first
  try {
    const guilds = await discordFetch(token, "/users/@me/guilds");
    for (const guild of guilds || []) {
      const channels = await discordFetch(
        token,
        `/guilds/${guild.id}/channels`,
      );
      for (const ch of channels || []) {
        if (ch.name === raw.replace(/^#/, "") && ch.type === 0) {
          idCache.set(key, ch.id);
          return ch.id;
        }
      }
    }
    // Try DMs
    const dms = await discordFetch(token, "/users/@me/channels");
    for (const dm of dms || []) {
      const name = dm.name || dm.recipients?.[0]?.username;
      if (name === raw.replace(/^@/, "")) {
        idCache.set(key, dm.id);
        return dm.id;
      }
    }
  } catch {
    /* fall through */
  }

  return null;
}

// ─── Connection ────────────────────────────────────────────────────────────

export interface DiscordCallbacks {
  onMessage: (msg: ChannelMessage) => void;
  onError: (channelId: string, error: string) => void;
  /** A message in this channel was EDITED (gateway MESSAGE_UPDATE /
   *  CHANNEL_MESSAGE_UPDATE). content/attachments are the NEW state;
   *  authorId is the message's author (the editor). Optional. */
  onMessageUpdate?: (
    channelId: string,
    messageId: string,
    content: string,
    attachments: AttachmentRef[],
    authorId: string | undefined,
  ) => void;
  /** A message in this channel was DELETED (gateway MESSAGE_DELETE /
   *  CHANNEL_MESSAGE_DELETE). The payload carries no author — the handler
   *  resolves identity from its own state. Optional. */
  onMessageDelete?: (channelId: string, messageId: string) => void;
}

/**
 * Connect to a Discord channel as a bot. Returns true on success.
 * Starts polling for new messages. When `stateDir` is given, the
 * message cursor is seeded from and persisted to
 * `<stateDir>/channel-state.json`, so messages sent while pi was down
 * are not lost on restart.
 */
export async function connectDiscord(
  config: ChannelConfig,
  callbacks: DiscordCallbacks,
  stateDir?: string,
): Promise<boolean> {
  if (config.type !== "discord") return false;
  const existing = states.get(config.id);
  if (existing) {
    // Already connected (e.g. in-process session restart): refresh the live
    // config + callbacks so the poller and outbound sends use the current
    // session's handlers, then keep the running poller.
    existing.config = config;
    existing.callbacks = callbacks;
    return true;
  }

  const token = config.botToken;
  if (!token) {
    callbacks.onError(config.id, "No bot token configured");
    return false;
  }

  const channelId = await resolveChannelId(token, config.channel);
  if (!channelId) {
    callbacks.onError(config.id, `Cannot resolve channel: ${config.channel}`);
    return false;
  }

  // Bot identity (M3 self-filter) and the last-message cursor seed are
  // independent REST calls — fetch them in parallel (~200ms saved on the
  // ~2.6s connect path; restart speed work 2026-09-11).
  const persistedCursor = loadPersistedCursors(stateDir)[channelId] || null;
  const [me, seed] = await Promise.all([
    discordFetch(token, "/users/@me").catch(() => null),
    persistedCursor
      ? Promise.resolve(null as unknown[] | null)
      : discordFetch(token, `/channels/${channelId}/messages?limit=1`).catch(
          () => null,
        ),
  ]);
  const botUserId = me?.id || null;
  if (!botUserId) {
    callbacks.onError(
      config.id,
      "Could not resolve bot user id; will retry on poll",
    );
  }

  const state: DiscordState = {
    config: config,
    channelId,
    botUserId,
    lastMessageId: persistedCursor,
    stateDir: stateDir || null,
    pollTimer: null,
    consecutiveErrors: 0,
    pollPauseUntil: 0,
    polling: false,
    callbacks,
    startupPending: false,
  };
  states.set(config.id, state);

  // Seed the cursor from the channel's last message — only when the
  // persisted cursor did not seed one (restart resumes exactly where it
  // left off instead of re-reading history).
  if (!state.lastMessageId && seed?.length) {
    state.lastMessageId = seed[0].id;
  }
  persistChannelCursor(state);

  // Startup message: only post once the bot's own user id is resolved, so
  // the first poll can skip our own message.
  if (config.startupMessage) {
    if (botUserId) {
      setTimeout(() => {
        if (states.get(config.id) === state && state.config.startupMessage) {
          sendDiscordMessage(state.config, state.config.startupMessage).catch(
            () => {},
          );
        }
      }, 3000);
    } else {
      state.startupPending = true;
    }
  }

  // Start polling (reads live state — no stale closures)
  restartPollTimer(state);
  // First backfill poll IMMEDIATELY, not after one interval: messages
  // sent while pi was down (cursor persisted on disk) replay right away —
  // this is the replay path after a /reset /restart /undo /redo respawn
  // (saves up to one poll interval of dead air on boot).
  pollDiscord(config.id).catch(() => {});
  return true;
}

// ─── Per-channel state file (cursors + runtime flags) ─────────────
// Per-channel lastMessageId survives process restarts so messages sent
// while pi was down are picked up (instead of the cursor re-seeding to
// "now" and losing them). The file is the bridge's per-channel state
// store; the cursor section coexists with per-channel runtime flags
// (#39 hold, #10 verbosity) without a second store.
//
// New format (two sections; the legacy flat cursor map still reads):
//   { "cursors": { "<discordChannelId>": "<lastMessageId>" },
//     "channels": { "<configId>": { "hold": true, "verbose": 1 } } }
// Cursors are keyed by Discord channel id (numeric); channel flags by
// config id (the settings.json "id") — separate key spaces, one file.

export interface ChannelSettingsState {
  /** #39: channel held — plain messages buffer in the re-wake queue. */
  hold?: boolean;
  /** #10: 3-level verbosity override (0 text / 1 essential / 2 all). */
  verbose?: number;
}

export interface ChannelStateFile {
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
  const empty: ChannelStateFile = { cursors: {}, channels: {} };
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
    return { cursors, channels: {} };
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
  return { cursors, channels };
}

/** Persist the current cursor. No-op without a stateDir; never throws.
 *  Preserves the sibling "channels" section. */
export function persistChannelCursor(state: DiscordState): void {
  if (!state.stateDir || !state.lastMessageId) return;
  try {
    const file = path.join(state.stateDir, "channel-state.json");
    const data = loadChannelStateFile(state.stateDir);
    data.cursors[state.channelId] = state.lastMessageId;
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

/** Read persisted cursors (discord channel id → last message id). Corrupt file = empty. */
export function loadPersistedCursors(
  stateDir: string | null | undefined,
): Record<string, string> {
  return loadChannelStateFile(stateDir).cursors;
}

/** Read the live in-memory cursor for a channel, or null. Exported for
 *  the restart-class ops (/reset /restart /undo /redo), which capture it
 *  when the op window opens and rewind it before shutdown — inbounds
 *  delivered during the op then replay after the respawn instead of
 *  dying with the process. */
export function getChannelCursor(configId: string): string | null {
  return states.get(configId)?.lastMessageId ?? null;
}

/** Set + persist the live cursor for a channel. No-op when the channel
 *  is not connected (nothing to rewind). */
export function setChannelCursor(
  configId: string,
  messageId: string | null,
): void {
  const st = states.get(configId);
  if (!st) return;
  st.lastMessageId = messageId;
  persistChannelCursor(st);
}

/** Register a bare channel state (cursor bookkeeping only, no poller,
 *  no gateway). Exported for tests. */
export function seedChannelStateForTest(
  configId: string,
  channelId: string,
  stateDir: string | null = null,
): void {
  const config = { id: configId, type: "discord" } as ChannelConfig;
  states.set(configId, {
    config,
    channelId,
    botUserId: null,
    lastMessageId: null,
    stateDir,
    pollTimer: null,
    consecutiveErrors: 0,
    pollPauseUntil: 0,
    polling: false,
    callbacks: { onMessage: () => {}, onError: () => {} },
    startupPending: false,
  });
}

/** Drop every discord state + poll timer + suppression marks. Exported for tests. */
export function clearDiscordStatesForTest(): void {
  for (const st of states.values()) {
    if (st.pollTimer) clearInterval(st.pollTimer);
  }
  states.clear();
  autoReactSuppressed.clear();
}

/** Poll interval for a channel: backfill (60s) while its token's gateway
 *  is connected, fast (5s) otherwise. */
export function currentPollIntervalMs(state: DiscordState): number {
  const ps = state.config.botToken
    ? presenceStates.get(state.config.botToken)
    : undefined;
  return ps?.gatewayOk ? POLL_BACKFILL_MS : POLL_INTERVAL_MS;
}

/** (Re)start the poll timer at the interval matching gateway status. */
export function restartPollTimer(state: DiscordState): void {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(
    () => pollDiscord(state.config.id),
    currentPollIntervalMs(state),
  );
}

/** Flip gateway status for a token and adjust poll intervals on all its
 *  channels. No-op when the status does not change. */
function setGatewayOk(st: PresenceState, ok: boolean): void {
  if (st.gatewayOk === ok) return;
  st.gatewayOk = ok;
  for (const s of statesForToken(st.token)) restartPollTimer(s);
}

/** Disconnect from a Discord channel. */
export function disconnectDiscord(channelId: string): void {
  const state = states.get(channelId);
  if (!state) return;
  if (state.pollTimer) clearInterval(state.pollTimer);
  states.delete(channelId);
}

/** Poll for new messages on a Discord channel. Exported for tests. */
export async function pollDiscord(configId: string): Promise<void> {
  const state = states.get(configId);
  if (!state) return;
  const { config, channelId, lastMessageId, callbacks } = state;
  const token = config.botToken;
  if (!token) return;
  if (state.polling) return;
  if (state.pollPauseUntil && Date.now() < state.pollPauseUntil) return;
  state.polling = true;

  try {
    if (!state.botUserId) {
      try {
        const me = await discordFetch(token, "/users/@me");
        state.botUserId = me?.id || null;
      } catch {}
    }
    // Bot identity just resolved — post the queued startup message now.
    if (
      state.startupPending &&
      state.botUserId &&
      state.config.startupMessage
    ) {
      state.startupPending = false;
      sendDiscordMessage(state.config, state.config.startupMessage).catch(
        () => {},
      );
    }
    const url = lastMessageId
      ? `/channels/${channelId}/messages?after=${lastMessageId}&limit=10`
      : `/channels/${channelId}/messages?limit=1`;

    const msgs: any[] = (await discordFetch(token, url)) || [];
    state.consecutiveErrors = 0;
    state.pollPauseUntil = 0;

    // Deliver oldest-first so the shared cursor advances monotonically;
    // the isOlderSnowflake drop in deliverInboundMessage would otherwise
    // keep only the newest of a multi-message backfill batch.
    for (const msg of msgs) {
      deliverInboundMessage(state, msg);
    }
  } catch (err) {
    state.consecutiveErrors += 1;
    const pauseMs = Math.min(
      5_000 * 2 ** Math.min(state.consecutiveErrors - 1, 4),
      60_000,
    );
    state.pollPauseUntil = Date.now() + pauseMs;
    const safe = sanitizeSensitiveText((err as Error).message || String(err));
    callbacks.onError(
      config.id,
      `Poll error: ${safe} (retry in ${Math.round(pauseMs / 1000)}s)`,
    );
  } finally {
    state.polling = false;
  }
}

/**
 * pi-bg dispatch callbacks post to the channel via webhook: author.bot is
 * true and webhook_id is set, with content prefixed "[bg:". Exempt those
 * from the other-bot filter — they are the dispatch wake mechanism.
 * Exported for tests.
 */
export function isBgWebhook(raw: any): boolean {
  if (raw?.webhook_id == null) return false;
  if (typeof raw?.content === "string" && raw.content.startsWith("[bg:"))
    return true;
  // Embed-only callbacks (pi-bg Variant D): no top-level content —
  // identify by the embed author name the pi-bg webhook builder sets.
  const authorName = raw?.embeds?.[0]?.author?.name;
  return typeof authorName === "string" && authorName.startsWith("pi-bg");
}

// ─── Shared inbound delivery (poll + gateway) ───────────────────────────

/** Map a raw Discord attachments array to AttachmentRefs. */
function mapAttachmentRefs(raw: any): AttachmentRef[] {
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

/**
 * One delivery path for both ingest routes. Dedupes against the shared
 * per-channel cursor (a message at or below the cursor is dropped),
 * advances the cursor, skips the bot's own messages, builds the
 * ChannelMessage, invokes the inbound callback, and handles the 👀
 * auto-ack. Returns true when the message reached the callback.
 */
export function deliverInboundMessage(state: DiscordState, raw: any): boolean {
  const msgId = raw?.id;
  if (!msgId) return false;
  const id = String(msgId);
  if (id === state.lastMessageId) return false; // duplicate: cursor already here
  if (isOlderSnowflake(id, state.lastMessageId)) return false; // below cursor
  state.lastMessageId = id;
  persistChannelCursor(state);

  const { config, callbacks } = state;
  if (state.botUserId && raw.author?.id === state.botUserId) return false; // skip self
  const peerBots = config.peerBotIds ?? [];
  // Skip other bots unless exempt: [bg: webhook wakes, or peer agents
  // posting into this channel via agent-say (author.id in peerBotIds).
  if (
    raw.author?.bot &&
    !isBgWebhook(raw) &&
    !peerBots.includes(String(raw.author.id))
  )
    return false;

  const attachments: AttachmentRef[] = mapAttachmentRefs(raw.attachments);

  // Embeds (rich text from other bots, app interactions) are not in
  // raw.content — serialize them into the body so the LLM can read them.
  const embedText = serializeEmbeds(raw.embeds || []);
  const body = [raw.content || "", embedText].filter(Boolean).join("\n\n");

  // Reply context: the message this one replies to (both the gateway and
  // poll payloads carry referenced_message). Rendered as a
  // <replied-message> block in the LLM context by the inbound handler.
  const ref = raw.referenced_message;
  const repliedMessage =
    typeof ref?.content === "string" && ref.content
      ? {
          author: ref.author?.global_name || ref.author?.username || "",
          text: ref.content.slice(0, 1000),
        }
      : undefined;

  const channelMsg: ChannelMessage = {
    channelId: config.id,
    channelName: config.name,
    channelType: "discord",
    messageId: id,
    from: raw.author?.global_name || raw.author?.username || "unknown",
    fromId: raw.author?.id,
    body,
    timestamp: raw.timestamp || new Date().toISOString(),
    attachments,
    repliedMessage,
    isRoom: false,
  };

  // onMessage runs its synchronous prefix (command detection marks its
  // own message) before returning, so we can check the flag here.
  callbacks.onMessage(channelMsg);

  // Auto-react to acknowledge (skipped when the channel has acks
  // disabled or the handler marked the message). The id is consumed
  // either way so the suppression set does not leak.
  const suppressed = autoReactSuppressed.delete(id);
  const token = config.botToken;
  if (token && config.ack !== false && !suppressed) {
    reactToMessage(token, state.channelId, id, "👀").catch(() => {});
  }
  return true;
}

// ─── Reactions ─────────────────────────────────────────────────────────────

// Message ids marked by the handler to skip the poller's 👀 auto-ack
// (commands answer with a normal reply, not an ack). Consumed (deleted)
// by the poller, so the set does not grow.
const autoReactSuppressed = new Set<string>();

/** Mark a message so the poller does not auto-ack it with 👀. */
export function suppressAutoReact(messageId: string): void {
  autoReactSuppressed.add(messageId);
}

/** React to a Discord message with an emoji. */
export async function unreactMessage(
  token: string,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  try {
    await discordFetch(
      token,
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: "DELETE" },
    );
  } catch {}
}

async function reactToMessage(
  token: string,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  await discordFetch(
    token,
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    { method: "PUT" },
  );
}

// ─── Sending ───────────────────────────────────────────────────────────────

/**
 * THE egress choke point. Every text-bearing outbound function in this file
 * (sendDiscordMessage, editDiscordMessage, sendDiscordMessageWithFiles,
 * sendFilesToDiscord, respondToInteraction, editInteractionMessage) MUST
 * route its user-visible string through this before it hits the Discord
 * API — see docs/secret-censor.md. A test asserts this at source level.
 */
export function egressText(text: string): string {
  return censor(text);
}

/**
 * allowed_mentions for an outbound body. Default = silent (no pings from
 * echoed mention patterns). A real <@id> mention in the text keeps working:
 * parse:['users'] + explicit user list pings exactly those users.
 * Exported for tests.
 */
export function allowedMentionsFor(text: string): {
  parse: string[];
  users?: string[];
} {
  const ids = [...text.matchAll(/<@!?([0-9]+)>/g)].map((m) => m[1]);
  return ids.length ? { parse: ["users"], users: ids } : { parse: [] };
}

/** Send a text message to a Discord channel. */
export async function sendDiscordMessage(
  config: ChannelConfig,
  raw: string,
  replyToMessageId?: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (config.type !== "discord")
    return { success: false, error: "Not a Discord channel" };

  const text = egressText(raw); // secret censor: single egress choke point
  const channelId = states.get(config.id)?.channelId || config.channel;
  const token = config.botToken;
  if (token) {
    // Bot token: send via REST
    const base = { content: text, allowed_mentions: allowedMentionsFor(text) };
    const withRef = replyToMessageId
      ? { ...base, message_reference: { message_id: replyToMessageId } }
      : base;
    try {
      const result = await discordFetch(
        token,
        `/channels/${channelId}/messages`,
        { method: "POST", body: withRef },
      );
      return { success: true, messageId: result?.id };
    } catch (err) {
      // 50034 = unknown message reference (e.g. target deleted); retry plain
      if (replyToMessageId && (err as Error).message.includes("50034")) {
        try {
          const result = await discordFetch(
            token,
            `/channels/${channelId}/messages`,
            { method: "POST", body: base },
          );
          return { success: true, messageId: result?.id };
        } catch (err2) {
          return { success: false, error: (err2 as Error).message };
        }
      }
      return { success: false, error: (err as Error).message };
    }
  }

  if (config.webhookUrl) {
    // Webhook: POST message
    try {
      const resp = await fetch(config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: text,
          allowed_mentions: allowedMentionsFor(text),
        }),
      });
      if (resp.ok) return { success: true };
      return { success: false, error: `Webhook ${resp.status}` };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  return { success: false, error: "No bot token or webhook URL" };
}

/** Edit a sent channel message in place (used for the live status line). */
export async function editDiscordMessage(
  config: ChannelConfig,
  messageId: string,
  raw: string,
): Promise<{ success: boolean; error?: string }> {
  if (config.type !== "discord")
    return { success: false, error: "Not a Discord channel" };
  const text = egressText(raw); // secret censor
  const channelId = states.get(config.id)?.channelId || config.channel;
  const token = config.botToken;
  if (!token) return { success: false, error: "No bot token" };
  try {
    await discordFetch(token, `/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      body: { content: text },
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Delete a sent channel message (used to clear the live status line). */
export async function deleteDiscordMessage(
  config: ChannelConfig,
  messageId: string,
): Promise<{ success: boolean; error?: string }> {
  if (config.type !== "discord")
    return { success: false, error: "Not a Discord channel" };
  const channelId = states.get(config.id)?.channelId || config.channel;
  const token = config.botToken;
  if (!token) return { success: false, error: "No bot token" };
  try {
    await discordFetch(token, `/channels/${channelId}/messages/${messageId}`, {
      method: "DELETE",
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Outbound file upload ──────────────────────────────────────────

/** Per-file upload cap (Discord bot default). Ported from kimaki. */
export const MAX_OUTBOUND_FILE_BYTES = 25 * 1024 * 1024;

// Minimal extension → MIME map (no runtime dep). Unknown extensions fall
// back to application/octet-stream; Discord still renders the file.
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".json": "application/json",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};
export function mimeForFile(filePath: string): string {
  return (
    MIME_BY_EXT[path.extname(filePath).toLowerCase()] ||
    "application/octet-stream"
  );
}

/**
 * Upload local files to a Discord channel/thread in a single message
 * (multipart: payload_json + files[N] with MIME). All files land in one
 * message so Discord shows images in a grid. Ported from kimaki's
 * uploadFilesToDiscord. Files over 25 MB are rejected before read.
 * Exported for tests.
 */
export async function sendFilesToDiscord(
  channelId: string,
  files: string[],
  botToken: string,
): Promise<{ success: boolean; error?: string }> {
  if (files.length === 0) return { success: true };

  // Secret censor: payload_json carries the API-facing (visible) filename —
  // the Discord API returns it as attachments[].filename, so it must be the
  // redacted name, not just the file part.
  const names = files.map((f) => egressText(path.basename(f)));

  for (const file of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      return {
        success: false,
        error: `Cannot read file: ${path.basename(file)} (${(e as Error).message})`,
      };
    }
    if (stat.size > MAX_OUTBOUND_FILE_BYTES) {
      return {
        success: false,
        error: `File "${path.basename(file)}" is ${(stat.size / 1024 / 1024).toFixed(1)} MB, exceeds Discord's ${(MAX_OUTBOUND_FILE_BYTES / 1024 / 1024).toFixed(0)} MB upload limit`,
      };
    }
  }

  const formData = new FormData();
  formData.append(
    "payload_json",
    JSON.stringify({
      attachments: names.map((name, i) => ({ id: i, filename: name })),
    }),
  );
  for (const [i, file] of files.entries()) {
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch (e) {
      // File disappeared or became unreadable between the stat pre-check
      // and the read (e.g. a directory): fail clean instead of throwing
      // mid-loop after earlier files were already appended.
      return {
        success: false,
        error: `Cannot read file: ${path.basename(file)} (${(e as Error).message})`,
      };
    }
    formData.append(
      `files[${i}]`,
      new Blob([buffer], { type: mimeForFile(file) }),
      egressText(path.basename(file)), // secret censor: filename in payload
    );
  }

  try {
    const resp = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}` },
      body: formData,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        success: false,
        error: `Discord API ${resp.status}: ${text.slice(0, 200)}`,
      };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── Attachment loading ────────────────────────────────────────────────────

/** Hard cap per attachment. Larger files are skipped (Discord allows 25 MB+). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Send a text message WITH file attachments in one multipart POST.
 *  The text is the message content; each file becomes an attachment. */
export async function sendDiscordMessageWithFiles(
  config: ChannelConfig,
  raw: string,
  files: string[],
  replyToMessageId?: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (config.type !== "discord")
    return { success: false, error: "Not a Discord channel" };
  const text = egressText(raw); // secret censor
  const channelId = states.get(config.id)?.channelId || config.channel;
  const token = config.botToken;
  if (!token) return { success: false, error: "No bot token" };
  try {
    const formData = new FormData();
    formData.append(
      "payload_json",
      JSON.stringify({
        content: text,
        allowed_mentions: allowedMentionsFor(text),
        ...(replyToMessageId
          ? { message_reference: { message_id: replyToMessageId } }
          : {}),
        attachments: files.map((f, i) => ({
          id: i,
          filename: egressText(path.basename(f)), // secret censor
        })),
      }),
    );
    for (const [i, file] of files.entries()) {
      const buffer = fs.readFileSync(file);
      formData.append(
        `files[${i}]`,
        new Blob([buffer], { type: mimeForFile(file) }),
        egressText(path.basename(file)), // secret censor
      );
    }
    const result: any = await discordFetchRaw(
      token,
      `/channels/${channelId}/messages`,
      {
        method: "POST",
        body: formData,
      },
    );
    return { success: true, messageId: result?.id };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Download and save a Discord attachment. Called eagerly when a message
 * with attachments arrives, so the file is on disk before the LLM sees
 * the folder reference.
 */
export async function loadDiscordAttachment(
  _token: string,
  attachment: AttachmentRef,
  saveDir: string,
): Promise<AttachmentContent | null> {
  if (!attachment.url) return null;
  if (attachment.size > MAX_ATTACHMENT_BYTES) return null;

  try {
    const resp = await fetch(attachment.url);
    if (!resp.ok) return null;
    const contentLength = Number(resp.headers.get("content-length") || 0);
    if (contentLength > MAX_ATTACHMENT_BYTES) return null;

    let buffer: Buffer = Buffer.from(await resp.arrayBuffer());
    let contentType = attachment.contentType;
    let filename = attachment.filename;

    // Optimize oversized images before saving so they fit LLM API limits.
    if (isSupportedImageMime(contentType)) {
      const optimized = await optimizeImageBuffer(buffer, contentType).catch(
        () => null,
      );
      if (optimized) {
        buffer = optimized.buffer;
        contentType = optimized.mime;
        if (optimized.mime === "image/jpeg" && !/\.(jpe?g)$/i.test(filename)) {
          filename = `${filename.replace(/\.[^.]+$/, "")}.jpg`;
        }
      }
    }

    fs.mkdirSync(saveDir, { recursive: true });
    const safeName = path.basename(filename) || "attachment";
    const filePath = path.join(saveDir, `${attachment.id}-${safeName}`);
    fs.writeFileSync(filePath, buffer);

    const result: AttachmentContent = {
      id: attachment.id,
      filename,
      contentType,
      size: buffer.length,
      path: filePath,
    };

    // Extract text for readable types
    if (
      contentType.startsWith("text/") ||
      contentType === "application/json" ||
      filename.match(/\.(txt|md|json|xml|yaml|yml|log|csv|ts|js|py|html|css)$/i)
    ) {
      result.text = buffer.toString("utf-8").slice(0, 50_000);
    }

    return result;
  } catch {
    return null;
  }
}

/** Get the bot token for a channel. */
export function getDiscordToken(configId: string): string | undefined {
  return states.get(configId)?.config?.botToken;
}

export function getDiscordChannelId(configId: string): string | undefined {
  const s = states.get(configId);
  return s?.channelId || s?.config?.channel;
}

/** Get channel name by config id. */
export function getDiscordChannelName(configId: string): string | undefined {
  return states.get(configId)?.config?.name;
}

/** List all connected Discord channels. */
export function getDiscordStates(): Map<string, DiscordState> {
  return states;
}

// ─── Gateway presence + typing ───────────────────────────────────────────

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

interface PresenceState {
  token: string;
  ws: WebSocket | null;
  hb: ReturnType<typeof setInterval> | null;
  hbAck: boolean | null;
  stopped: boolean;
  ready: boolean;
  activity: string;
  backoff: number;
  rebalance: boolean;
  invalidSession: boolean;
  /** Bot's own user id, from READY d.user.id. */
  botUserId: string | null;
  /** Gateway is connected and delivering MESSAGE_CREATE. */
  gatewayOk: boolean;
}

/** 4004 intent warning is logged once per process, not per reconnect. */
let intent4004Logged = false;

/** True when both ids are snowflakes and a sorts before b. */
function isOlderSnowflake(a: string, b: string | null): boolean {
  if (!b) return false;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) < BigInt(b);
  return false;
}

/** All channel states registered for a bot token. */
function statesForToken(token: string): DiscordState[] {
  const out: DiscordState[] = [];
  for (const s of states.values()) if (s.config.botToken === token) out.push(s);
  return out;
}

const presenceStates = new Map<string, PresenceState>();

function sendPresenceOp(st: PresenceState): void {
  if (st.ws?.readyState !== 1) return;
  st.ws.send(
    JSON.stringify({
      op: 3,
      d: {
        since: 0,
        // type 4 = Custom Status ("Custom Status: …"); type 5 would show "Competing in …".
        activities: st.activity ? [{ name: st.activity, type: 4 }] : [],
        status: "online",
        afk: false,
      },
    }),
  );
}

function connectPresence(st: PresenceState): void {
  if (st.stopped) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(GATEWAY_URL);
  } catch {
    setTimeout(() => connectPresence(st), 5000);
    return;
  }
  st.ws = ws;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: st.token,
          properties: {
            os: "linux",
            browser: "monky",
            device: "monky-channel",
          },
          compress: false,
          intents: GATEWAY_INTENTS,
        },
      }),
    );
  };

  ws.onmessage = (ev: any) => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.op === 10) {
      st.hbAck = true;
      if (st.hb) clearInterval(st.hb);
      st.hb = setInterval(() => {
        if (ws.readyState !== 1) return;
        if (!st.hbAck) {
          console.log("[presence] heartbeat timeout, reconnecting");
          try {
            ws.close();
          } catch {}
          return;
        }
        ws.send(JSON.stringify({ op: 1, d: null }));
        st.hbAck = false;
      }, msg.d.heartbeat_interval);
    } else if (msg.op === 11) {
      st.hbAck = true;
    } else if (msg.op === 7) {
      st.rebalance = true;
    } else if (msg.op === 9) {
      // Invalid Session: our sequence is stale — reconnect immediately.
      st.invalidSession = true;
      console.log("[presence] invalid session, reconnecting");
      try {
        ws.close();
      } catch {}
    } else if (msg.op === 0 && msg.t === "READY") {
      st.ready = true;
      st.backoff = 5_000;
      st.botUserId = msg.d.user?.id || st.botUserId;
      console.log(`[presence] READY as ${msg.d.user?.username}`);
      // Sync bot identity into channel states (closes the /users/@me
      // race) and post any startup message queued on unknown identity.
      for (const s of statesForToken(st.token)) {
        if (!s.botUserId && st.botUserId) {
          s.botUserId = st.botUserId;
          if (s.startupPending && s.config.startupMessage) {
            s.startupPending = false;
            const text = s.config.startupMessage;
            setTimeout(() => {
              if (states.get(s.config.id) === s)
                sendDiscordMessage(s.config, text).catch(() => {});
            }, 3000);
          }
        }
      }
      setGatewayOk(st, true); // poll drops to 60s backfill
      sendPresenceOp(st);
    } else if (msg.op === 0 && msg.t === "MESSAGE_CREATE") {
      try {
        handleMessageCreate(st, msg.d);
      } catch (e) {
        console.error(
          "[gateway] MESSAGE_CREATE failed:",
          sanitizeSensitiveText(String(e)),
        );
      }
    } else if (
      msg.op === 0 &&
      (msg.t === "MESSAGE_UPDATE" || msg.t === "CHANNEL_MESSAGE_UPDATE")
    ) {
      try {
        handleMessageUpdate(st, msg.d);
      } catch (e) {
        console.error(
          "[gateway] MESSAGE_UPDATE failed:",
          sanitizeSensitiveText(String(e)),
        );
      }
    } else if (
      msg.op === 0 &&
      (msg.t === "MESSAGE_DELETE" || msg.t === "CHANNEL_MESSAGE_DELETE")
    ) {
      try {
        handleMessageDelete(st, msg.d);
      } catch (e) {
        console.error(
          "[gateway] MESSAGE_DELETE failed:",
          sanitizeSensitiveText(String(e)),
        );
      }
    } else if (msg.op === 0 && msg.t === "INTERACTIONS_CREATE") {
      const h = interactionHandlers.get(st.token);
      if (h) {
        try {
          h(msg.d);
        } catch (e) {
          console.error(
            "[interactions] handler failed:",
            sanitizeSensitiveText(String(e)),
          );
        }
      } else {
        console.log(
          `[interactions] no handler for command ${msg.d.data?.name}, channel ${msg.d.channel_id}`,
        );
      }
    }
  };

  ws.onclose = (ev: any) => {
    if (st.hb) {
      clearInterval(st.hb);
      st.hb = null;
    }
    st.ready = false;
    if (st.stopped) return;
    setGatewayOk(st, false); // poll goes back to 5s
    const code: number | undefined = ev?.code;
    const reason: string = ev?.reason ? ` reason=${ev.reason}` : "";

    // 4004 = unknown intent: the MESSAGE CONTENT INTENT is not enabled in
    // the developer portal. Keep reconnecting (a portal fix + reconnect
    // restores gateway ingest), but run polling-only meanwhile. Log once
    // per process so persistent 4004s do not spam.
    if (code === 4004 && !intent4004Logged) {
      intent4004Logged = true;
      console.log(
        "gateway: 4004 — enable MESSAGE CONTENT INTENT in https://discord.com/developers/applications (bot tab) — falling back to 5s polling",
      );
    }

    let delay: number;
    if (st.rebalance) {
      st.rebalance = false;
      delay = 500;
    } else if (
      st.invalidSession ||
      code === 1000 ||
      code === 1001 ||
      code === 1012 ||
      code === 1013
    ) {
      // Clean closes and "new session" — retry right away.
      st.invalidSession = false;
      st.backoff = 5_000;
      delay = 0;
    } else {
      delay = st.backoff;
      st.backoff = Math.min(st.backoff * 2, 300_000);
    }
    console.log(
      `[presence] closed code=${code ?? "?"}${reason}, reconnect in ${Math.round(delay / 1000)}s`,
    );
    setTimeout(() => connectPresence(st), delay);
  };

  ws.onerror = () => {};
}

/** Get or create the presence state for a token without opening a socket.
 *  Exported for tests. */
export function ensurePresenceState(token: string): PresenceState {
  let st = presenceStates.get(token);
  if (!st) {
    st = {
      token,
      ws: null,
      hb: null,
      hbAck: null,
      stopped: false,
      ready: false,
      activity: "",
      backoff: 5_000,
      rebalance: false,
      invalidSession: false,
      botUserId: null,
      gatewayOk: false,
    };
    presenceStates.set(token, st);
  }
  return st;
}

/** Open a gateway session so the bot shows ONLINE and delivers
 *  MESSAGE_CREATE. Call once per token. */
export function connectDiscordPresence(
  token: string,
  initialActivity = "",
): void {
  if (!token || presenceStates.has(token)) return;
  const st = ensurePresenceState(token);
  st.activity = initialActivity;
  connectPresence(st);
}

/**
 * Handle a MESSAGE_CREATE dispatch from the gateway. Skips the bot's own
 * messages (id from READY d.user.id) and channels not in config, then
 * feeds the message through the shared delivery pipeline — same cursor,
 * dedupe, callback, and auto-ack as the poller.
 * Exported for tests.
 */
export function handleMessageCreate(st: PresenceState, d: any): void {
  const authorId = d?.author?.id;
  if (st.botUserId && authorId === st.botUserId) return; // skip self
  const chId = d?.channel_id != null ? String(d.channel_id) : null;
  if (!chId) return;
  for (const state of statesForToken(st.token)) {
    if (state.channelId === chId) deliverInboundMessage(state, d);
  }
}

/**
 * Handle a MESSAGE_UPDATE / CHANNEL_MESSAGE_UPDATE dispatch. Skips the
 * bot's own messages (the bridge edits its status line in place) and
 * channels not in config, then forwards the new content to the channel
 * callback. Exported for tests.
 */
export function handleMessageUpdate(st: PresenceState, d: any): void {
  const msgId = d?.id != null ? String(d.id) : null;
  if (!msgId) return;
  if (st.botUserId && d.author?.id === st.botUserId) return; // skip self
  const chId = d?.channel_id != null ? String(d.channel_id) : null;
  if (!chId) return;
  for (const state of statesForToken(st.token)) {
    if (state.channelId !== chId) continue;
    state.callbacks.onMessageUpdate?.(
      state.config.id,
      msgId,
      typeof d.content === "string" ? d.content : "",
      mapAttachmentRefs(d.attachments),
      d.author?.id != null ? String(d.author.id) : undefined,
    );
  }
}

/**
 * Handle a MESSAGE_DELETE / CHANNEL_MESSAGE_DELETE dispatch. The payload
 * carries only id + channel_id — no author. Channels not in config are
 * skipped. Exported for tests.
 */
export function handleMessageDelete(st: PresenceState, d: any): void {
  const msgId = d?.id != null ? String(d.id) : null;
  if (!msgId) return;
  const chId = d?.channel_id != null ? String(d.channel_id) : null;
  if (!chId) return;
  for (const state of statesForToken(st.token)) {
    if (state.channelId !== chId) continue;
    state.callbacks.onMessageDelete?.(state.config.id, msgId);
  }
}

/** Update the bot custom status text. Re-sent immediately when ready. */
export function setDiscordPresenceActivity(
  token: string,
  activity: string,
): void {
  const st = presenceStates.get(token);
  if (!st) return;
  if (st.activity === activity) return;
  st.activity = activity;
  if (st.ready) {
    console.log("[presence] status:", activity);
    sendPresenceOp(st);
  }
}

export function stopDiscordPresence(token: string): void {
  const st = presenceStates.get(token);
  if (!st) return;
  st.stopped = true;
  if (st.hb) clearInterval(st.hb);
  try {
    st.ws?.close();
  } catch {}
  setGatewayOk(st, false);
  presenceStates.delete(token);
}

// ─── Application (slash) commands ──────────────────────────────────────────
// Native slash commands do NOT create channel messages — Discord delivers
// INTERACTIONS_CREATE over the gateway session opened for presence above.
// We reuse that socket and dispatch here.

type InteractionHandler = (d: any) => void;
const interactionHandlers = new Map<string, InteractionHandler>();

/** Route INTERACTIONS_CREATE events for one bot token. */
export function setDiscordInteractionHandler(
  token: string,
  fn: InteractionHandler | null,
): void {
  if (fn) interactionHandlers.set(token, fn);
  else interactionHandlers.delete(token);
}

/** Ack a slash command with text (callback type 4). Use only for
 *  replies with no async command work before them. */
export async function respondToInteraction(
  botToken: string,
  d: any,
  text?: string,
): Promise<void> {
  try {
    await discordFetch(botToken, `/interactions/${d.id}/${d.token}/callback`, {
      method: "POST",
      body: {
        type: 4,
        data: text ? { content: egressText(text) } : {}, // secret censor
      },
    });
  } catch (e) {
    console.error(
      "[interactions] callback failed:",
      sanitizeSensitiveText(String(e)),
    );
  }
}

/** Defer a slash command (callback type 5). This is the ack that keeps
 *  Discord from showing "did not respond in time" (3s window) — call it
 *  BEFORE any command work. The deferred message shows "Thinking" until
 *  edited via editInteractionMessage. */
export async function deferInteraction(
  botToken: string,
  d: any,
): Promise<void> {
  try {
    await discordFetch(botToken, `/interactions/${d.id}/${d.token}/callback`, {
      method: "POST",
      body: { type: 5 },
    });
  } catch (e) {
    console.error(
      "[interactions] defer failed:",
      sanitizeSensitiveText(String(e)),
    );
  }
}

/** Edit the deferred slash-command message ("Thinking" → result text). */
export async function editInteractionMessage(
  botToken: string,
  d: any,
  text: string,
): Promise<void> {
  try {
    await discordFetch(
      botToken,
      `/webhooks/${d.application_id}/${d.token}/messages/@original`,
      {
        method: "PATCH",
        body: { content: egressText(text) }, // secret censor
      },
    );
  } catch (e) {
    console.error(
      "[interactions] edit failed:",
      sanitizeSensitiveText(String(e)),
    );
  }
}

/** Commands piscord supports. NATIVE SLASH UI DISABLED (2026-09-09):
 *  INTERACTIONS_CREATE events are not reaching the gateway session
 *  (parked /status RCA). All commands work via plain text — type
 *  "/status" as a normal message, parsed in channel/index.ts.
 *  registerDiscordCommands pushes an EMPTY list to clear the slash menu. */
const SLASH_COMMANDS = [
  { name: "stop", description: "Stop the current run" },
  {
    name: "btw",
    description: "Quick side question, answered briefly",
    options: [
      {
        type: 3,
        name: "question",
        description: "your question",
        required: true,
      },
    ],
  },
  { name: "help", description: "List the commands" },
  { name: "status", description: "Session stats (owner)" },
  { name: "reset", description: "Restart the session (owner)" },
  { name: "restart", description: "Restart pi, resuming this session (owner)" },
  {
    name: "undo",
    description: "Revert last assistant turn: files + conversation (owner)",
  },
  { name: "redo", description: "Reapply an /undo (one level deep, owner)" },
  {
    name: "verbose",
    description: "Forward tool calls (owner)",
    options: [
      {
        type: 3,
        name: "mode",
        description: "on or off",
        required: false,
        choices: [
          { name: "on", value: "on" },
          { name: "off", value: "off" },
        ],
      },
    ],
  },
  {
    name: "compact",
    description: "Compact session context (owner)",
    options: [
      {
        type: 3,
        name: "instructions",
        description: "optional focus instructions",
        required: false,
      },
    ],
  },
  {
    name: "model",
    description: "Switch or list models (owner)",
    options: [
      {
        type: 3,
        name: "name",
        description: "model id (omit to list)",
        required: false,
      },
    ],
  },
  { name: "jobs", description: "List in-flight pi-bg dispatches" },
  {
    name: "todos",
    description: "Show the channel todo board ('all' for every channel)",
    options: [
      {
        type: 3,
        name: "scope",
        description: "'all' for every channel",
        required: false,
      },
    ],
  },
  {
    name: "sleep",
    description: "List/cancel pending session wakes (owner)",
    options: [
      {
        type: 3,
        name: "scope",
        description: "'list' or 'cancel <id>'",
        required: false,
      },
    ],
  },
];

/** Clear guild + global slash commands so the native "/" menu is empty
 *  and every command is driven by plain text. Re-enable by pushing
 *  SLASH_COMMANDS instead of []. */
export async function registerDiscordCommands(token: string): Promise<void> {
  const list: typeof SLASH_COMMANDS = [];
  try {
    const me = await discordFetch(token, "/applications/@me");
    const guilds = await discordFetch(token, "/users/@me/guilds");
    const guildList: any[] = Array.isArray(guilds) ? guilds : [];
    if (guildList.length === 0) {
      console.log(
        "[interactions] no guilds for guild-scoped registration (DM-only bot?) — skipping",
      );
      return;
    }
    let ok = 0;
    for (const g of guildList) {
      const label = g?.name ?? g?.id ?? "?";
      try {
        await discordFetch(
          token,
          `/applications/${me.id}/guilds/${g.id}/commands`,
          { method: "PUT", body: list },
        );
        ok += 1;
        console.log(
          `[interactions] registered ${list.length} slash commands in guild ${label}`,
        );
      } catch (e) {
        console.error(
          `[interactions] register failed for guild ${label}:`,
          sanitizeSensitiveText(String(e)),
        );
      }
    }
    if (ok === 0)
      console.error(
        `[interactions] guild command registration failed for all ${guildList.length} guilds`,
      );
    // Clear legacy GLOBAL commands too (native slash UI is disabled).
    await discordFetch(token, `/applications/${me.id}/commands`, {
      method: "PUT",
      body: list,
    });
    console.log("[interactions] global command list synced (text-only mode)");
  } catch (e) {
    console.error(
      "[interactions] register failed:",
      sanitizeSensitiveText(String(e)),
    );
  }
}

/** POST the typing indicator (~10s display). */
export async function sendDiscordTyping(config: ChannelConfig): Promise<void> {
  if (config.type !== "discord" || !config.botToken) return;
  const channelId = states.get(config.id)?.channelId || config.channel;
  await discordFetch(config.botToken, `/channels/${channelId}/typing`, {
    method: "POST",
  });
}
