// inbox.ts — the bridge leg of the durable per-agent comm inbox (issue #254, wave 2): inbound channel posts are recorded via POST /api/fleet/inbox/receive at receipt (before delivery, so a row exists even if pi dies mid-delivery), and the unread set is re-delivered + consumed (POST /api/fleet/inbox/consume) on bridge startup and on the post-compaction wake — read state lives in the DB, never in the pi session.
//
// The API leg is injected (setInboxHttp) so unit tests are hermetic: no test touches the live hall-monitor API.
//
// Config (all via env; unset URL or key = the whole feature is a silent no-op): JARATE_INBOX_URL = the hall-monitor API base (e.g. http://<host>:8001/api), operator-set in the pi.service env file; JARATE_INBOX_KEY = the per-agent key (X-Agent-Key), falling back to the first non-comment line of ~/.config/hall-monitor/agent-key; JARATE_INBOX_AGENT = this agent's name, used to render say rows as `say <from> -> <to>: <body>` (unset = `say <from>: <body>`).
//
// Delivery is at-least-once, never at-most-once: a row is consumed only after its delivery to pi succeeded, so a bridge death between delivery and consume re-delivers on the next trigger (a duplicated comm is tolerable; a lost one is the failure class this module exists to close).
//
// Consume-on-live-delivery (documented choice, review #321 f1): "delivered = read" applies to the bridge's OWN delivery paths, not just to redelivery — recordChannelPost returns a handle, and the handle is consumed the moment a live path commits (sendToPi accepted, a command or ! shell executed, a mid-run interrupt sent, or a queued drain re-runs the inbound through handleInbound). Only genuinely undelivered rows (pi down, bridge death mid-flight, queue entry dropped) stay unread for the next trigger, so redelivery is a gap backfill instead of a full-session replay. Rows this process already delivered live are filtered out of the redelivery list, so the compaction drain and the post-compaction redelivery in the same settle cannot double-deliver. The alternative — gating redelivery to rows recorded while no delivery path could have run — was rejected: every delivery path (direct, re-wake, restart, compaction-window) also runs live, so the gate would have to mirror every delivery path anyway; a consume at the commit point is one hook per path. One documented exception: the file-only buffer early-return (bufferFileOnly) leaves the row unread — the 10-minute batch flush delivers without re-running handleInbound, so the redelivery is the safety net (a duplicate is tolerable; a lost one is the failure class).
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

// The key file the operator hands out: the first non-comment, non-blank line (exported for the fallback test).
export function readKeyFile(file: string): string {
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
let configTtlMs = 5_000;

// Test hook: shrink the config TTL so cache expiry is testable without real waits (restored to 5000 between tests).
export function setInboxConfigTtlForTests(ms: number): void {
  configTtlMs = ms;
}

// Resolve the config (env + key file); null = the feature is off. Cached 5s so the per-inbound record path does not re-read the key file per message.
export function resolveInboxConfig(): InboxConfig | null {
  if (configCache && Date.now() - configCache.at < configTtlMs)
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

// Client-side receive body cap: a channel post body includes serialized embeds (unbounded — Discord content is 2000-char bounded, embeds are not). 16k chars is the client-side cap (the row is truncated, not dropped: the live delivery keeps the full text and the hall-monitor server's own payload limit is the backstop, so a truncated row never 4xxs the server for size).
const MAX_INBOX_BODY_CHARS = 16_000;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Over-cap bodies are truncated with a marker + a warn (the loss is observable; the live delivery is unaffected).
function capBody(body: string, what: string): string {
  if (body.length <= MAX_INBOX_BODY_CHARS) return body;
  console.warn(
    `[inbox] receive body over the ${MAX_INBOX_BODY_CHARS} char cap (${body.length} chars, ${what}); the row is truncated (the live delivery is unaffected; the server-side payload limit is the backstop)`,
  );
  return `${body.slice(0, MAX_INBOX_BODY_CHARS)}… (truncated)`;
}

// Raw HTTP leg: throws on non-2xx and on network failure — the caller decides whether to swallow (redelivery path) or warn (intake path, where a dead API must be observable).
async function rawHttp(
  cfg: InboxConfig,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<unknown> {
  const http = httpImpl ?? ((u: string, i: RequestInit) => fetch(u, i));
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Non-throwing wrapper for the redelivery path (null = API down / auth failure; the caller logs).
async function safeHttp(
  cfg: InboxConfig,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<unknown | null> {
  try {
    return await rawHttp(cfg, method, pathname, body);
  } catch {
    return null;
  }
}

// POST /api/fleet/inbox/receive — idempotent on (agent, source_ref); the server returns the existing row on a re-post. Fire-and-forget from the delivery path: a dead API must never break delivery (the row is lost, the comm still gets delivered — and the loss is warn-logged so the at-most-once intake leg is observable).
async function postReceive(
  cfg: InboxConfig,
  kind: InboxKind,
  sender: string,
  body: string,
  sourceRef?: string | null,
): Promise<InboxRow | null> {
  try {
    const row = (await rawHttp(cfg, "POST", "/inbox/receive", {
      kind,
      sender,
      body: capBody(body, `from ${sender}`),
      ...(sourceRef ? { source_ref: sourceRef } : {}),
    })) as InboxRow | null;
    if (row)
      console.log(`[inbox] recorded ${kind} from ${sender} (row ${row.id})`);
    return row;
  } catch (e) {
    console.warn(
      `[inbox] intake failed for ${kind} from ${sender}: ${errText(e)} — the comm still delivers live; the row is lost (at-most-once intake leg)`,
    );
    return null;
  }
}

export function recordInbox(
  kind: InboxKind,
  sender: string,
  body: string,
  sourceRef?: string | null,
): void {
  const cfg = resolveInboxConfig();
  if (!cfg) return;
  void postReceive(cfg, kind, sender, body, sourceRef);
}

interface InboxListResponse {
  count: number;
  messages: InboxRow[];
}

async function getUnread(
  cfg: InboxConfig,
  limit: number,
): Promise<InboxListResponse | null> {
  return (await safeHttp(
    cfg,
    "GET",
    `/inbox?status=unread&limit=${limit}`,
  )) as InboxListResponse | null;
}

// POST /api/fleet/inbox/consume — unread -> consumed (actioned=false), or a 200 no-op on an already-consumed/actioned row (byte-for-byte wave-1 semantics; the first-read time is kept by the server). null = API down / auth failure (the caller warns).
async function consumeRow(
  cfg: InboxConfig,
  id: number,
  note: string,
): Promise<InboxRow | null> {
  return (await safeHttp(cfg, "POST", "/inbox/consume", {
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

// The handle for one recorded channel post. Consume marks the row as live-delivered ("delivered = read"): it fires the consume once the receive has settled, and it is a no-op when the row was never recorded (feature off, dead API).
export interface InboxRecordHandle {
  // Consume the recorded row as live-delivered. Fire-and-forget: never throws and never delays the delivery path. A failed consume warns and leaves the row unread (at-least-once: it re-delivers on the next trigger). Idempotent per handle.
  consume(note: string): void;
}

// The receive promise per source_ref, so a delivery commit that does NOT re-run handleInbound (the mid-run interrupt) can still consume the row once the receive settles.
const pendingRows = new Map<string, Promise<InboxRow | null>>();

// Rows this process has already delivered live, keyed by source_ref. Marked at the delivery commit — BEFORE the receive has settled — so a redelivery trigger racing the live consume (the compaction drain and the post-compaction redelivery in the same settle) skips the row; the live path owns the consume.
const liveDeliveredRefs = new Set<string>();

function markLiveDelivered(ref: string): void {
  if (liveDeliveredRefs.size > 5000) liveDeliveredRefs.clear();
  liveDeliveredRefs.add(ref);
}

// Consume a recorded row by its id; a failure warns and leaves the row unread (at-least-once).
async function consumeRecordedRow(
  cfg: InboxConfig,
  row: InboxRow,
  note: string,
): Promise<void> {
  const c = await consumeRow(cfg, row.id, note);
  if (!c || c.status === "unread")
    console.warn(
      `[inbox] live consume failed for row ${row.id} (${note}); the row stays unread and re-delivers on the next trigger (at-least-once)`,
    );
}

// Record one inbound channel post at receipt (before/at delivery) with the Discord message id as the idempotent ref; a synthetic post without an id is a one-off (never re-recorded, so re-deliveries can never re-fire their own row). The returned handle is consumed when the live delivery path commits (delivered = read; only genuinely undelivered rows survive to redelivery).
export function recordChannelPost(msg: {
  from: string;
  body: string;
  messageId?: string;
}): InboxRecordHandle {
  const cfg = resolveInboxConfig();
  const ref = msg.messageId ? `discord-${msg.messageId}` : null;
  const rowPromise = cfg
    ? postReceive(cfg, "channel_post", msg.from, msg.body.trim(), ref)
    : Promise.resolve(null);
  if (ref && pendingRows.size < 5000) pendingRows.set(ref, rowPromise);
  let consumed = false;
  return {
    consume(note: string): void {
      if (consumed) return;
      consumed = true;
      if (ref) markLiveDelivered(ref);
      void rowPromise.then((row) => {
        if (row && cfg) void consumeRecordedRow(cfg, row, note);
      });
    },
  };
}

// Consume the recorded row for a message id (the mid-run interrupt's delivery commit: the entry is spliced out of the re-wake queue, so handleInbound's record does not re-run). No-op when this process never recorded the message (feature off, dead API, or a message that predates the process).
export function consumeRecordedByRef(messageId: string, note: string): void {
  const ref = `discord-${messageId}`;
  const rowPromise = pendingRows.get(ref);
  if (!rowPromise) return;
  const cfg = resolveInboxConfig();
  markLiveDelivered(ref);
  void rowPromise.then((row) => {
    if (row && cfg) void consumeRecordedRow(cfg, row, note);
  });
}

// NOTE (tokenless webhook self-echo, forward-looking): the redelivery self-echo loop is closed today BY CONFIGURATION — egress uses the bot token when one is set (and deliverInboundMessage skips the bot's own messages), and the webhook egress fallback only engages tokenless, in which case a channel has no ingest route on this bridge. If a tokenless webhook ingest route is ever added, a redelivered channel post would re-ingest (isBgWebhook exemption) and mint a fresh one-off row on every trigger — guard redelivery against webhook-sourced posts or dedupe by content before that happens.

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

// Redeliver the unread set (oldest first, capped at `limit`) to the registered deliverer, consuming each delivered row with a durable one-line note; returns the number of rows delivered AND consumed (honest counter: a delivered row whose consume failed is only in the warn log, not in the return — it re-fires on the next trigger). A delivery failure leaves the row unconsumed (it re-fires on the next trigger); a consume failure after a successful delivery logs a warning and leaves the row unread (at-least-once). Rows this process already delivered live are skipped (the live path owns their consume — the compaction-drain / post-compaction-redelivery race).
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
    // Rows this process already delivered live are skipped: the delivery commit marked them before the receive settled (or the receive is still in flight), and the live path owns the consume — redelivering them here (the compaction drain and the post-compaction redelivery fire in the same settle) would double-deliver.
    const rows = list.messages.filter(
      (r) => !r.source_ref || !liveDeliveredRefs.has(r.source_ref),
    );
    if (rows.length === 0) return 0;
    const skipped = list.messages.length - rows.length;
    console.log(
      `[inbox] redelivering ${rows.length} unread row(s) (${reason}; ${list.count} total unread${skipped > 0 ? `; ${skipped} already delivered live` : ""})`,
    );
    let delivered = 0;
    let consumed = 0;
    for (const row of rows) {
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
      delivered++;
      const c = await consumeRow(
        cfg,
        row.id,
        `bridge redelivered at ${reason}`,
      );
      if (!c || c.status === "unread")
        console.warn(
          `[inbox] consume failed for delivered row ${row.id}; the row stays unread and re-delivers next trigger (at-least-once)`,
        );
      else consumed++;
    }
    if (list.count > list.messages.length)
      console.warn(
        `[inbox] ${list.count - list.messages.length} further unread row(s) beyond the ${limit} cap; they re-fire on the next trigger`,
      );
    if (delivered !== consumed)
      console.warn(
        `[inbox] ${delivered} delivered but only ${consumed} consumed this trigger; the rest stay unread and re-fire`,
      );
    return consumed;
  } finally {
    redeliverInFlight = false;
  }
}
