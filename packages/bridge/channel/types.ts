/**
 * Channel types for piscord pi package.
 *
 * Channels are configured in settings.json under `channels` array.
 * Example:
 *   {
 *     "channels": [
 *       { "id": "disc-main", "type": "discord", "channel": "123", "botToken": "xxx", "name": "Main", "default": true }
 *     ]
 *   }
 */

/** A configured messaging channel. */
export interface ChannelConfig {
  /** Unique id for this channel (used in tool calls). */
  id: string;
  /** Human-readable name (shown in channel-context). */
  name: string;
  /** Channel type. */
  type: "discord";
  /** Whether this channel is enabled for bidirectional communication. */
  enabled: boolean;
  /** Ack incoming messages with a 👀 reaction (default true). Set false
   *  when the typing indicator is enough. */
  ack?: boolean;
  /** Discord channel identifier (numeric id or channel name). */
  channel: string;
  /** Discord bot token (discord only). */
  botToken?: string;
  /** Discord webhook URL for outbound-only (discord only). */
  webhookUrl?: string;
  /** Optional instructions for how the LLM should use this channel. */
  instructions?: string;
  /** Whether this is the default channel for replies when no channel is specified. */
  default?: boolean;
  /** Owner user ID for multi-user asking (discord). When set, only this user's reply resolves. */
  ownerUserId?: string;
  /** When true, tool calls and results are forwarded to the channel alongside the final response. */
  forwardToolCalls?: boolean;
  /** Buffer file-only messages (no text, no voice note) for up to 10
   *  minutes until follow-up text arrives (default false — file-only
   *  messages fire a turn immediately by default). Set true to buffer;
   *  buffered batches are auto-flushed as a file-only turn at 10 minutes. */
  bufferFileOnly?: boolean;
  /** Message posted when a channel connects. Unset or empty = no message. */
  startupMessage?: string | null;
  /** Bot user IDs exempt from the other-bot filter — peer agents posting
   *  into this channel via agent-say (discord only). */
  peerBotIds?: string[];
}

/** Settings shape: channels live under settings.channels. */
export interface ChannelSettings {
  channels?: ChannelConfig[];
}

/** Normalized representation of an inbound message. */
export interface ChannelMessage {
  channelId: string;
  channelName: string;
  channelType: "discord";
  messageId: string;
  from: string;
  fromId?: string;
  body: string;
  timestamp: string;
  /** Attachments, downloaded eagerly on arrival (20 MB per-file cap). */
  attachments: AttachmentRef[];
  /** Set when the message replies to another message (Discord
   *  referenced_message). The LLM gets it as a <replied-message> block. */
  repliedMessage?: { author: string; text: string };
  /** Whether this message is from a group/room (multi-user). */
  isRoom: boolean;
  /** Room name (if isRoom). */
  roomName?: string;
}

/** Reference to an attachment — downloaded when the message arrives. */
export interface AttachmentRef {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url?: string; // download URL
  /** Voice-note duration in seconds (Discord voice messages). */
  duration?: number;
  /** Waveform peaks (Discord voice messages). */
  waveform?: string;
}

/** Discord embed (minimal REST shape). */
export interface DiscordEmbedField {
  name?: string | null;
  value?: string | null;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  author?: {
    name?: string | null;
    url?: string | null;
    icon_url?: string | null;
  };
  footer?: { text?: string | null; icon_url?: string | null };
  fields?: DiscordEmbedField[];
}

/** Loaded attachment content. */
export interface AttachmentContent {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  path: string; // saved to disk
  text?: string; // text content if extractable (txt, code, etc.)
  base64?: string; // for images
}

/** Status of a channel's connection. */
export interface ChannelStatus {
  id: string;
  name: string;
  type: "discord";
  enabled: boolean;
  connected: boolean;
  lastPoll?: string;
  error?: string;
}

// ─── Settings loading ─────────────────────────────────────────────────────

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/**
 * Load channel config from settings cascade:
 *   1. .pi/settings.json (project-level)
 *   2. ~/.pi/agent/settings.json (global)
 */
export function loadChannelConfig(cwd: string): ChannelConfig[] {
  const sources = [
    path.join(cwd, ".pi", "settings.json"),
    path.join(homedir(), ".pi", "agent", "settings.json"),
  ];

  for (const src of sources) {
    try {
      if (!fs.existsSync(src)) continue;
      const data = JSON.parse(fs.readFileSync(src, "utf-8"));
      const channels = data?.channels;
      if (Array.isArray(channels) && channels.length > 0) {
        return channels.map(normalizeChannel);
      }
    } catch {
      /* continue to next source */
    }
  }

  return [];
}

function normalizeChannel(raw: any): ChannelConfig {
  return {
    id: raw.id || raw.channel || raw.channelId || "",
    name: raw.name || raw.id || raw.channel || raw.channelId || "unnamed",
    type: raw.type || "discord",
    enabled: raw.enabled !== false,
    ack: raw.ack !== false,
    channel: raw.channel || raw.channelId || raw.id || "",
    botToken: raw.botToken,
    webhookUrl: raw.webhookUrl,
    instructions: raw.instructions,
    default: raw.default === true,
    ownerUserId: raw.ownerUserId,
    forwardToolCalls: raw.forwardToolCalls === true,
    bufferFileOnly: raw.bufferFileOnly === true,
    startupMessage: raw.startupMessage,
    peerBotIds: Array.isArray(raw.peerBotIds)
      ? raw.peerBotIds.filter((x: any) => typeof x === "string")
      : undefined,
  };
}

/** Return the default channel (first with default:true, or first enabled). */
export function getDefaultChannel(
  channels: ChannelConfig[],
): ChannelConfig | undefined {
  const def = channels.find((c) => c.enabled && c.default);
  if (def) return def;
  return channels.find((c) => c.enabled);
}

/** Find a channel by id or name. */
export function getChannel(
  channels: ChannelConfig[],
  idOrName: string,
): ChannelConfig | undefined {
  return channels.find((c) => c.id === idOrName || c.name === idOrName);
}
