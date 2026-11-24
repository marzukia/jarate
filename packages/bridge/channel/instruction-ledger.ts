/**
 * #380: instruction ledger — the CHANNEL-TRUTH source for operator inbounds.
 *
 * Append-only per-channel JSONL at <storeDir-parent>/instructions/<channel>.jsonl
 * (default store ~/.jarate/handovers → ~/.jarate/instructions/<channel>.jsonl).
 * Entry shape: {ts, msgId, authorId, body, ackedTs}.
 *
 * The bridge appends on EVERY human in-channel inbound (the isHumanInbound
 * class, non-bot / non-webhook / non-embed) BEFORE the runActive/queue
 * decision, so a message QUEUED during the compaction window is recorded
 * even though it never became a session turn (invariant I1: every human
 * channel inbound before a doc write is in the ledger, independent of
 * session-turn state). `ackedTs` is set when a final assistant message
 * (isFinalAssistant) posts after the entry. Duplicate msgIds (the #306
 * redelivery face) append once. Body cap 280 chars (same as the asks).
 *
 * The file is strictly append-only: acking appends an {ackAllBefore}
 * record, and readers fold it (the first ack strictly after the entry
 * sets ackedTs). No rewrite ever happens.
 */
import fs from "node:fs";
import path from "node:path";
// NOTE: the handover <-> instruction-ledger import cycle is safe — every
// cross-module reference below is runtime-only (function bodies).
import {
  ASK_SELF_CHECK_WINDOW_MS,
  type ChannelHistoryMessage,
  docAsksIsNone,
  splitDoc,
} from "./handover";
import { defaultHome } from "./todos";
import type { ChannelMessage } from "./types";

export interface LedgerEntry {
  /** inbound ts (ms epoch). */
  ts: number;
  /** channel message id (the #306 dedupe key). */
  msgId: string;
  /** author id (null when unknown). */
  authorId: string | null;
  /** inbound body, capped at INSTRUCTION_BODY_CAP. */
  body: string;
  /** ts of the first final assistant post after the entry; null when
   *  unacked. */
  ackedTs: number | null;
}

/** Body cap (same rule as the asks extraction). */
export const INSTRUCTION_BODY_CAP = 280;

/** Cap the body (same 277+"..." rule as the asks). */
export function capBody(body: string): string {
  const b = body.trim();
  return b.length > INSTRUCTION_BODY_CAP ? `${b.slice(0, 277)}...` : b;
}

const slug = (channelId: string) => channelId.replace(/[^a-zA-Z0-9_-]/g, "-");

/** The ledger dir: the sibling "instructions" of the (expanded) handover
 *  store dir — the default store ~/.jarate/handovers lands the ledger at
 *  ~/.jarate/instructions (the spec path). */
export function ledgerDir(storeDir: string, home = defaultHome()): string {
  const expanded =
    storeDir === "~" || storeDir.startsWith("~/")
      ? path.join(home, storeDir.slice(2))
      : storeDir;
  return path.join(path.dirname(expanded), "instructions");
}

export function ledgerPath(
  channelId: string,
  storeDir: string,
  home = defaultHome(),
): string {
  return path.join(ledgerDir(storeDir, home), `${slug(channelId)}.jsonl`);
}

type RawLine = {
  ts?: unknown;
  msgId?: unknown;
  authorId?: unknown;
  body?: unknown;
  ackAllBefore?: unknown;
};

function normalizeLine(
  l: RawLine,
): LedgerEntry | { ackAllBefore: number } | null {
  if (typeof l.ackAllBefore === "number" && Number.isFinite(l.ackAllBefore))
    return { ackAllBefore: l.ackAllBefore };
  const ts = Number(l.ts);
  const msgId = typeof l.msgId === "string" ? l.msgId : "";
  if (!Number.isFinite(ts) || !msgId) return null;
  return {
    ts,
    msgId,
    authorId: typeof l.authorId === "string" ? l.authorId : null,
    body: typeof l.body === "string" ? l.body : "",
    ackedTs: null,
  };
}

/** Parse + fold one ledger file: entry lines, with the ackedTs field
 *  folded from the append-only {ackAllBefore} records (the first ack
 *  strictly after the entry's ts). */
function parseFile(file: string): LedgerEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries: LedgerEntry[] = [];
  const acks: number[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let l: RawLine;
    try {
      l = JSON.parse(t);
    } catch {
      continue; // torn line (best-effort append) — skip
    }
    const n = normalizeLine(l);
    if (!n) continue;
    if ("ackAllBefore" in n) acks.push(n.ackAllBefore);
    else entries.push(n);
  }
  for (const e of entries) {
    const first = acks.filter((a) => e.ts < a).sort((a, b) => a - b)[0];
    if (first != null) e.ackedTs = first;
  }
  return entries;
}

/** Read a channel's ledger entries. [] when missing/unreadable. */
export function readEntries(
  channelId: string,
  storeDir: string,
  home = defaultHome(),
): LedgerEntry[] {
  return parseFile(ledgerPath(channelId, storeDir, home));
}

/** Append one inbound. Returns true when appended, false when the msgId
 *  is a duplicate (the #306 redelivery face appends once). */
export function appendInbound(
  channelId: string,
  storeDir: string,
  e: { ts: number; msgId: string; authorId?: string | null; body: string },
  home = defaultHome(),
): boolean {
  const msgId = String(e.msgId ?? "");
  if (
    msgId &&
    readEntries(channelId, storeDir, home).some((x) => x.msgId === msgId)
  )
    return false;
  const entry: LedgerEntry = {
    ts: e.ts,
    msgId,
    authorId: e.authorId ?? null,
    body: capBody(e.body),
    ackedTs: null,
  };
  const file = ledgerPath(channelId, storeDir, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return true;
}

/** Mark every unacked entry posted before upToTs as answered at upToTs:
 *  a final assistant message (isFinalAssistant) posted after the entries
 *  answers them. Appends one {ackAllBefore} record (append-only). Returns
 *  the count marked. */
export function ackUpTo(
  channelId: string,
  storeDir: string,
  upToTs: number,
  home = defaultHome(),
): number {
  try {
    const entries = readEntries(channelId, storeDir, home);
    const n = entries.filter((e) => e.ackedTs == null && e.ts < upToTs).length;
    if (n === 0) return 0;
    const file = ledgerPath(channelId, storeDir, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ackAllBefore: upToTs })}\n`);
    return n;
  } catch {
    return 0; // best-effort (a dead store never breaks the send path)
  }
}

/** ALL channels' in-window ledger entries (one-agent-per-HOME invariant:
 *  one channel per bridge process; the doc write + the boot seed do not
 *  need the channel id). ts ascending; [] when the dir is missing. */
export function inWindowEntries(
  sinceTs: number,
  untilTs: number,
  storeDir: string,
  home = defaultHome(),
): LedgerEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(ledgerDir(storeDir, home));
  } catch {
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    for (const e of parseFile(path.join(ledgerDir(storeDir, home), n)))
      if (e.ts >= sinceTs && e.ts <= untilTs) out.push(e);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** One doc/seed line: `ts | msgId | body` (ISO ts). */
export function formatEntryLine(e: LedgerEntry): string {
  return `${new Date(e.ts).toISOString()} | ${e.msgId} | ${e.body}`;
}

/** In-window lines, unacked entries first (the open instructions), then
 *  acked — each group ts ascending. */
export function inWindowLines(
  sinceTs: number,
  untilTs: number,
  storeDir: string,
  home = defaultHome(),
): string[] {
  const all = inWindowEntries(sinceTs, untilTs, storeDir, home);
  const unacked = all.filter((e) => e.ackedTs == null);
  const acked = all.filter((e) => e.ackedTs != null);
  return [...unacked, ...acked].map(formatEntryLine);
}

/**
 * The isHumanInbound class applied to a live ChannelMessage (the inbound
 * path has no session entry yet): non-webhook, non-bot-relay sender, free
 * text (not empty, not a <embed>, not a [bg: line).
 */
export function isHumanChannelMsg(
  m: ChannelMessage,
  nonHumanSenders: ReadonlySet<string> = BEEPY,
): boolean {
  if (m.fromWebhook) return false;
  if (nonHumanSenders.has(m.from.toLowerCase())) return false;
  const b = m.body.trim();
  if (!b || b === "(empty)") return false;
  if (b.startsWith("<embed>")) return false;
  if (b.startsWith("[bg:")) return false;
  return true;
}

/** #380 (I1) hook: the bridge calls this on EVERY human in-channel
 *  inbound, BEFORE the runActive/queue decision — a message queued during
 *  the compaction window is recorded even though it never became a
 *  session turn. Non-human inbounds do not append. Deduped by messageId
 *  (the #306 redelivery face appends once). Returns true when appended.
 */
export function recordInboundInstruction(
  channelId: string,
  storeDir: string,
  m: ChannelMessage,
  home = defaultHome(),
): boolean {
  try {
    if (!isHumanChannelMsg(m)) return false;
    const ts = Date.parse(m.timestamp);
    if (!Number.isFinite(ts)) return false;
    return appendInbound(
      channelId,
      storeDir,
      {
        ts,
        msgId: m.messageId,
        authorId: m.fromId ?? m.from ?? null,
        body: m.body,
      },
      home,
    );
  } catch {
    return false; // best-effort (a dead store never breaks the inbound path)
  }
}

/** The bot-relay sender set (kept in sync with handover.ts
 *  NON_HUMAN_SENDERS; case-insensitive). */
export const BEEPY = new Set(["beepy"]);

// ─── #380: the doc-write gate + the session-start seed seam ───────────
// (moved from handover.ts for the size gate; re-exported from there so
// the existing imports keep working.)

/** #380 doc-write gate: the in-window ledger inbounds (the channel truth)
 *  must be carried in the doc (instructions + asks sections, by msgId),
 *  and "(none)" under "Last user asks" is only valid when no unacked
 *  ledger entry has ts newer than the last final assistant ts (the #344
 *  spec, verbatim). Pure; deterministic; no LLM. */
export function docGateCheck(
  doc: string,
  window: LedgerEntry[],
  lastFinalTs: number | null,
): { fail: boolean; reason: string } {
  const uncovered = window.filter((e) => !doc.includes(`| ${e.msgId} |`));
  if (uncovered.length > 0)
    return {
      fail: true,
      reason: `${uncovered.length} in-window operator inbound(s) not present in the doc`,
    };
  const { sections } = splitDoc(doc);
  const asks = sections.find((x) => x.title.includes("user asks"));
  const none = asks
    ? !asks.body.split("\n").some((l) => /^\d+\./.test(l.trim()))
    : false;
  if (none) {
    const unackedNewer = window.filter(
      (e) => e.ackedTs == null && (lastFinalTs == null || e.ts > lastFinalTs),
    );
    if (unackedNewer.length > 0)
      return {
        fail: true,
        reason: `${unackedNewer.length} unacked operator inbound(s) newer than the last final assistant post while "Last user asks" is (none) (the #344 (none) rule)`,
      };
  }
  return { fail: false, reason: "" };
}

/** #380 (I3): the unanswered operator messages the session-start check
 *  fires on, as ledger-ready items — the fired lines feed the boot seed
 *  through the instruction ledger (the same source buildSeedKickoff
 *  reads), no longer log-only. */
export interface SessionStartUnanswered {
  msgId: string;
  ts: number;
  authorId: string | null;
  body: string;
}

export function sessionStartUnansweredMessages(
  doc: string,
  history: ChannelHistoryMessage[],
  botUserId: string | null,
  now: number = Date.now(),
): SessionStartUnanswered[] {
  if (!docAsksIsNone(doc)) return [];
  const isAnswer = (m: ChannelHistoryMessage): boolean =>
    botUserId != null ? m.authorId === botUserId : m.bot && !m.webhook;
  return history
    .filter(
      (m) =>
        !m.bot &&
        Number.isFinite(m.ts) &&
        now - m.ts < ASK_SELF_CHECK_WINDOW_MS &&
        !history.some((x) => x.ts > m.ts && isAnswer(x)),
    )
    .map((m) => ({
      msgId: m.msgId,
      ts: m.ts,
      authorId: m.authorId,
      body: m.body,
    }));
}

/** #380 (I3): the session-start fired lines feed the boot seed. The
 *  production sink appends them to the instruction ledger (appendInbound
 *  dedupes by msgId, so a message already in the ledger is a no-op).
 *  Tests replace this export via setSessionStartSeedFeed. */
export let sessionStartSeedFeed: (
  chId: string,
  storeDir: string,
  items: SessionStartUnanswered[],
) => void = (chId, storeDir, items) => {
  for (const m of items)
    appendInbound(chId, storeDir, {
      ts: m.ts,
      msgId: m.msgId,
      authorId: m.authorId,
      body: m.body,
    });
};

/** The test override seam (module exports are live bindings; the test
 *  cannot reassign the import). null = restore the default sink. */
export function setSessionStartSeedFeed(
  fn:
    | ((
        chId: string,
        storeDir: string,
        items: SessionStartUnanswered[],
      ) => void)
    | null,
): void {
  sessionStartSeedFeed =
    fn ??
    ((chId, storeDir, items) => {
      for (const m of items)
        appendInbound(chId, storeDir, {
          ts: m.ts,
          msgId: m.msgId,
          authorId: m.authorId,
          body: m.body,
        });
    });
}
