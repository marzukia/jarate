// inbox.ts — the bridge leg of the durable per-agent comm inbox (issue #254, wave 2): inbound channel posts are recorded via POST /api/fleet/inbox/receive at receipt (before delivery, so a row exists even if pi dies mid-delivery), and the unread set is re-delivered + consumed (POST /api/fleet/inbox/consume) on bridge startup and on the post-compaction wake — read state lives in the DB, never in the pi session.
//
// The API leg is injected (setInboxHttp) so unit tests are hermetic: no test touches the live hall-monitor API.
//
// Config (all via env; unset URL or key = the whole feature is a silent no-op): JARATE_INBOX_URL = the hall-monitor API base (e.g. http://<host>:8001/api), operator-set in the pi.service env file; JARATE_INBOX_KEY = the per-agent key (X-Agent-Key), falling back to the first non-comment line of ~/.config/hall-monitor/agent-key; JARATE_INBOX_AGENT = this agent's name, used to render say rows as `say <from> -> <to>: <body>` (unset = `say <from>: <body>`).
//
// Delivery is at-least-once, never at-most-once: a row is consumed only after its delivery to pi succeeded, so a bridge death between delivery and consume re-delivers on the next trigger (a duplicated comm is tolerable; a lost one is the failure class this module exists to close).
//
// Delivered-vs-actioned call (documented in the PR body): the bridge consumes each re-delivered row with actioned=false (delivered = read; the first-read time is recorded and kept by the server). actioned=true is the terminal "the agent acted" state and is only ever set by the agent/operator when it has actually acted — the bridge never posts actioned=true at delivery, so the unread -> consumed -> actioned chain stays a faithful floor.
//
// Redelivery is once per trigger (a startup or a compaction settle) and fires only UNREAD rows: a consumed row never re-fires (the server returns only the status=unread set), and a row delivered while pi was down stays unread until the next trigger consumes it.
//
// Fleet runs (isFleetRun) skip all channel startup activity; the redelivery hooks sit after the fleet gate, so a dispatch run never ingests the interactive agent's inbox.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendDiscordMessage } from "./discord";
import { sendToPi } from "./index";
import type { ChannelConfig } from "./types";

export type InboxKind = "channel_post" | "say" | "mail";

export type InboxStatus = "unread" | "consumed" | "actioned";

export interface InboxRow {
  id: number;
  kind: InboxKind;
  sender: string;
  body: string;
  source_ref: string | null;
  status: InboxStatus;
  consumed_at: string | null;
  consumed_note: string;
  created_at: string;
}

export interface InboxConfig {
  url: string;
  key: string;
  agent: string;
}

// The registered delivery target for a re-delivered row: posts the line to the agent channel (best-effort) and delivers it to pi; true = delivered (the caller may then consume the row).
export type InboxDeliverer = (row: InboxRow, line: string) => Promise<boolean>;

// Injectable HTTP leg (unit tests replace fetch with a mock server).
type HttpFn = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

let httpImpl: HttpFn | null = null;

// Swap the HTTP leg (tests); null restores the real fetch.
export function setInboxHttp(fn: HttpFn | null): void {
  httpImpl = fn;
}

let deliverer: InboxDeliverer | null = null;

// Register the delivery target (index.ts wires it at session_start); null clears it.
export function setInboxDeliverer(d: InboxDeliverer | null): void {
  deliverer = d;
}

// The key file the operator hands out: the first non-comment, non-blank line.
export const INBOX_KEY_FILE = path.join(
  os.homedir(),
  ".config",
  "hall-monitor",
  "agent-key",
);

function readKeyFile(file: string): string {
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#")) return t;
    }
  } catch {
    // missing/unreadable key file = no key
  }
  return "";
}

let configCache: { at: number; cfg: InboxConfig | null } | null = null;
const CONFIG_TTL_MS = 5_000;

// Resolve the config (env + key file); null = the feature is off. Cached 5s so the per-inbound record path does not re-read the key file per message.
export function resolveInboxConfig(): InboxConfig | null {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS)
    return configCache.cfg;
  const url = (process.env.JARATE_INBOX_URL ?? "").trim().replace(/\/+$/, "");
  let key = (process.env.JARATE_INBOX_KEY ?? "").trim();
  if (!key) key = readKeyFile(INBOX_KEY_FILE);
  const cfg =
    url && key
      ? { url, key, agent: (process.env.JARATE_INBOX_AGENT ?? "").trim() }
      : null;
  configCache = { at: Date.now(), cfg };
  return cfg;
}

// True when the feature is on (URL + key resolved).
export function inboxConfigured(): boolean {
  return resolveInboxConfig() !== null;
}

// Test hook: clear the config cache (env changes between tests).
export function resetInboxConfigCache(): void {
  configCache = null;
}

const HTTP_TIMEOUT_MS = 10_000;

async function rawHttp(
  cfg: InboxConfig,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<unknown | null> {
  const http = httpImpl ?? ((u: string, i: RequestInit) => fetch(u, i));
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await http(`${cfg.url}${pathname}`, {
        method,
        headers: {
          "X-Agent-Key": cfg.key,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

// POST /api/fleet/inbox/receive — idempotent on (agent, source_ref); the server returns the existing row on a re-post. Fire-and-forget: a dead API must never break delivery (the row is lost, the comm still gets delivered).
export function recordInbox(
  kind: InboxKind,
  sender: string,
  body: string,
  sourceRef?: string | null,
): void {
  const cfg = resolveInboxConfig();
  if (!cfg) return;
  void rawHttp(cfg, "POST", "/inbox/receive", {
    kind,
    sender,
    body,
    ...(sourceRef ? { source_ref: sourceRef } : {}),
  }).then((row) => {
    if (row)
      console.log(
        `[inbox] recorded ${kind} from ${sender} (row ${(row as InboxRow).id})`,
      );
  });
}

interface InboxListResponse {
  count: number;
  messages: InboxRow[];
}

async function getUnread(
  cfg: InboxConfig,
  limit: number,
): Promise<InboxListResponse | null> {
  return (await rawHttp(
    cfg,
    "GET",
    `/inbox?status=unread&limit=${limit}`,
  )) as InboxListResponse | null;
}

// POST /api/fleet/inbox/consume — unread -> consumed (actioned=false), or a 200 no-op on an already-consumed/actioned row (byte-for-byte wave-1 semantics; the first-read time is kept by the server).
async function consumeRow(
  cfg: InboxConfig,
  id: number,
  note: string,
): Promise<InboxRow | null> {
  return (await rawHttp(cfg, "POST", "/inbox/consume", {
    id,
    note,
  })) as InboxRow | null;
}

// Render a row in the kind-appropriate wake shape: say rows as say wakes (`say <from> -> <to>: <body>`), mail rows as mail wakes (`mail <sender>: <body>`), channel posts re-posted verbatim.
export function renderRow(row: InboxRow, agentName: string): string {
  if (row.kind === "say")
    return agentName
      ? `say ${row.sender} -> ${agentName}: ${row.body}`
      : `say ${row.sender}: ${row.body}`;
  if (row.kind === "mail") return `mail ${row.sender}: ${row.body}`;
  return row.body;
}

let redeliverInFlight = false;

// Record one inbound channel post at receipt (before/at delivery) with the Discord message id as the idempotent ref; a synthetic post without an id is a one-off (never re-recorded, so re-deliveries can never re-fire their own row).
export function recordChannelPost(msg: {
  from: string;
  body: string;
  messageId?: string;
}): void {
  recordInbox(
    "channel_post",
    msg.from,
    msg.body.trim(),
    msg.messageId ? `discord-${msg.messageId}` : undefined,
  );
}

// Arm the bridge leg for one session (index.ts calls it once per session_start, after the fleet-run gate): registers the deliverer (re-post to the agent channel as best-effort visibility, then send to pi — the pi delivery is the delivery) and fires the startup redelivery; a null channel leaves the rows unread until a channel exists.
export function armInbox(
  pi: ExtensionAPI,
  ch: ChannelConfig | null | undefined,
): void {
  setInboxDeliverer(
    ch
      ? async (row, line) => {
          sendDiscordMessage(ch, line).catch(() => {});
          return sendToPi(pi, ch.id, line, `inbox/${row.kind}`, line);
        }
      : null,
  );
  void redeliverUnread("startup").catch((e) =>
    console.error(
      "[inbox] startup redelivery failed:",
      e instanceof Error ? e.message : String(e),
    ),
  );
}

// Post-compaction redelivery hook (index.ts's session_compact handler): deferred one macrotask because pi is not idle yet at event time (the queued-inbound drain's pattern); `ready` = pi idle + no handoff restart armed + not a fleet run (an armed handoff restart rotates the session and would drop the delivery; the rows stay unread for the post-restart redelivery).
export function redeliverOnCompact(ready: () => boolean): void {
  setTimeout(() => {
    if (ready())
      void redeliverUnread("compaction").catch((e) =>
        console.error(
          "[inbox] post-compact redelivery failed:",
          e instanceof Error ? e.message : String(e),
        ),
      );
  }, 0);
}

// Redeliver the unread set (oldest first, capped at `limit`) to the registered deliverer, consuming each delivered row with a durable one-line note; returns the number of rows delivered+consumed. A delivery failure leaves the row unconsumed (it re-fires on the next trigger); a consume failure after a successful delivery logs a warning and leaves the row unread (at-least-once).
export async function redeliverUnread(
  reason: "startup" | "compaction",
  limit = 200,
): Promise<number> {
  if (redeliverInFlight) return 0;
  redeliverInFlight = true;
  try {
    const cfg = resolveInboxConfig();
    if (!cfg) return 0;
    if (!deliverer) {
      console.log(
        "[inbox] deliverer not registered; unread rows left for the next trigger",
      );
      return 0;
    }
    const list = await getUnread(cfg, limit);
    if (!list) {
      console.warn(
        "[inbox] unread fetch failed; rows left unread (API down or auth failure)",
      );
      return 0;
    }
    if (list.messages.length === 0) return 0;
    console.log(
      `[inbox] redelivering ${list.messages.length} unread row(s) (${reason}; ${list.count} total unread)`,
    );
    let delivered = 0;
    for (const row of list.messages) {
      const line = renderRow(row, cfg.agent);
      let ok = false;
      try {
        ok = await deliverer(row, line);
      } catch (e) {
        console.error(
          `[inbox] delivery threw for row ${row.id}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
      if (!ok) {
        console.warn(
          `[inbox] row ${row.id} (${row.kind}) not delivered; left unread for the next trigger`,
        );
        continue;
      }
      const consumed = await consumeRow(
        cfg,
        row.id,
        `bridge redelivered at ${reason}`,
      );
      if (!consumed || consumed.status === "unread")
        console.warn(
          `[inbox] consume failed for delivered row ${row.id}; the row stays unread and re-delivers next trigger (at-least-once)`,
        );
      delivered++;
    }
    if (list.count > list.messages.length)
      console.warn(
        `[inbox] ${list.count - list.messages.length} further unread row(s) beyond the ${limit} cap; they re-fire on the next trigger`,
      );
    return delivered;
  } finally {
    redeliverInFlight = false;
  }
}
