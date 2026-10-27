/**
 * Handover transcript capture (split from handover.ts for the size gate;
 * #291 — capture through the last completed turn).
 *
 * The transcript is the doc's evidence of the session's state at
 * compaction: pi-prep's kept tail in full + the older span filling the
 * remaining cap, newest first.
 */

import {
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { HandoverMessage, HandoverPreparation } from "./handover";

export function msgText(m: HandoverMessage | null | undefined): string {
  if (!m) return "";
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b)
          return String((b as { text: unknown }).text ?? "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

const MSG_CAP = 4_000;
const TRANSCRIPT_CAP = 60_000;

/**
 * Serialize the transcript for the doc (RCA F2 — pi-compaction-lossy-rca.md
 * §5). The old code walked the span oldest→newest and cut at
 * TRANSCRIPT_CAP, silently dropping the NEWEST work — the very state the
 * session was in at compaction. The doc must always contain the current
 * state, so:
 *
 *   1. pi-prep's KEPT TAIL (entries at/after firstKeptEntryId — see
 *      keptTailMessages) is serialized first, in full, chronological. The
 *      restart drops it from pi's context (pi boots from the LLM summary),
 *      so this doc is the only surviving copy of it.
 *   2. The older span (messagesToSummarize + turnPrefixMessages) then fills
 *      the remaining TRANSCRIPT_CAP, walking newest→oldest. The kept subset
 *      renders chronological, with a marker where the oldest messages were
 *      dropped.
 *
 * #291: capture THROUGH the last completed turn. The turn's anchor is the
 * NEWEST user line in the capture range (span then tail, chronological);
 * the turn = the anchor + everything after it. The turn always survives
 * the cap: if it alone overflows, keep the anchor + the NEWEST lines that
 * fit (the middle is dropped with a marker — never the turn's start or its
 * end). Pre-turn content fills the remainder, newest first. A mid-turn
 * capture boundary (isSplitTurn) gets an explicit marker instead of a
 * silent truncation.
 *
 * Each message is still capped at MSG_CAP.
 */
export function serializeTranscript(
  p: HandoverPreparation,
  keptTail: HandoverMessage[] = [],
): string {
  const span = [
    ...(p.messagesToSummarize ?? []),
    ...(p.turnPrefixMessages ?? []),
  ];

  const allTail = keptTail
    .map(formatTranscriptLine)
    .filter((l): l is string => l != null);
  const allSpan = span
    .map(formatTranscriptLine)
    .filter((l): l is string => l != null);
  const size = (ls: string[]): number =>
    ls.reduce((n, l) => n + l.length + 1, 0);

  // The last completed turn: anchor = the newest user line in the capture
  // range; the turn = anchor + everything after it. The tail is entirely
  // newer than the span, so the anchor is in the tail when the tail has a
  // user line, else in the span, else there is no turn to protect.
  const range = [...allSpan, ...allTail];
  let anchor = -1;
  for (let i = range.length - 1; i >= 0; i--) {
    if (range[i].startsWith("[user] ")) {
      anchor = i;
      break;
    }
  }

  // Split the capture into the last turn (protected) and the pre-turn
  // remainder (fills what's left, newest first).
  let turnTail: string[] = [];
  let turnSpan: string[] = [];
  let preTail: string[] = [];
  let preSpan: string[] = [];
  let midTurnDropped = 0;
  if (anchor >= 0) {
    if (anchor < allSpan.length) {
      // anchor in the span: the turn = span[anchor..] + the WHOLE tail.
      turnSpan = allSpan.slice(anchor);
      turnTail = allTail;
      preSpan = allSpan.slice(0, anchor);
    } else {
      // anchor in the tail: the turn = tail[anchor..]; the span is
      // entirely pre-turn.
      const a = anchor - allSpan.length;
      turnTail = allTail.slice(a);
      preTail = allTail.slice(0, a);
      preSpan = allSpan;
    }
    if (size([...turnSpan, ...turnTail]) > TRANSCRIPT_CAP) {
      // The turn alone overflows: keep the anchor + the NEWEST turn lines
      // fitting the rest of the cap (newest tail first, then the span
      // after the anchor). The middle is dropped, marked, never the
      // turn's start or its end.
      const anchorInTail = anchor >= allSpan.length;
      const anchorLine = anchorInTail ? turnTail[0] : turnSpan[0];
      let budget = TRANSCRIPT_CAP - (anchorLine.length + 1);
      const keptTail: string[] = [];
      // the tail loop skips the anchor when the anchor sits in the tail
      for (let i = turnTail.length - 1; i >= (anchorInTail ? 1 : 0); i--) {
        const cost = turnTail[i].length + 1;
        if (budget - cost < 0) break;
        budget -= cost;
        keptTail.push(turnTail[i]);
      }
      const keptSpan: string[] = [];
      for (let i = turnSpan.length - 1; i >= 1; i--) {
        const cost = turnSpan[i].length + 1;
        if (budget - cost < 0) break;
        budget -= cost;
        keptSpan.push(turnSpan[i]);
      }
      midTurnDropped =
        turnSpan.length +
        turnTail.length -
        1 -
        keptTail.length -
        keptSpan.length;
      turnTail = anchorInTail
        ? [anchorLine, ...keptTail.reverse()]
        : keptTail.reverse();
      turnSpan = anchorInTail ? [] : [anchorLine, ...keptSpan.reverse()];
    }
  } else {
    preTail = allTail;
    preSpan = allSpan;
  }

  // Pre-turn remainder: newest first, filling the cap after the turn.
  let total = size(turnTail) + size(turnSpan);
  const preTailKept: string[] = [];
  let preTailTruncated = false;
  for (let i = preTail.length - 1; i >= 0; i--) {
    const cost = preTail[i].length + 1;
    if (total + cost > TRANSCRIPT_CAP) {
      preTailTruncated = true;
      break;
    }
    total += cost;
    preTailKept.push(preTail[i]);
  }
  const preSpanKept: string[] = [];
  let preSpanTruncated = false;
  for (let i = preSpan.length - 1; i >= 0; i--) {
    const cost = preSpan[i].length + 1;
    if (total + cost > TRANSCRIPT_CAP) {
      preSpanTruncated = true;
      break;
    }
    total += cost;
    preSpanKept.push(preSpan[i]);
  }
  preTailKept.reverse(); // render chronological in the doc
  preSpanKept.reverse();

  const out: string[] = [];
  const tailSection = [...preTailKept, ...turnTail]; // chronological
  if (tailSection.length > 0) {
    if (preTailTruncated)
      out.push(
        `…[kept tail truncated: ${preTail.length - preTailKept.length} oldest kept entries dropped]`,
      );
    if (midTurnDropped > 0 && anchor >= allSpan.length)
      out.push(
        `…[mid-turn truncated: ${midTurnDropped} entries dropped from the middle of the last turn]`,
      );
    out.push(...tailSection);
  }
  const spanSection = [...preSpanKept, ...turnSpan]; // chronological
  if (spanSection.length > 0) {
    if (tailSection.length > 0) {
      if (p.isSplitTurn)
        out.push(
          "…[mid-turn at compact: the capture boundary splits the last turn - its user turn is in the older span below, its continuation in the kept tail above]",
        );
      out.push("…[older span]");
    }
    if (preSpanTruncated) out.push("…[transcript truncated]");
    if (midTurnDropped > 0 && anchor < allSpan.length)
      out.push(
        `…[mid-turn truncated: ${midTurnDropped} entries dropped from the middle of the last turn]`,
      );
    out.push(...spanSection);
  }
  return out.join("\n");
}

/** One transcript line: `[role] body`, per-message capped. null = none. */
function formatTranscriptLine(
  m: HandoverMessage | null | undefined,
): string | null {
  const text = msgText(m).trim();
  if (!text) return null;
  const role =
    m?.role === "assistant"
      ? "assistant"
      : m?.role === "toolResult"
        ? "tool"
        : "user";
  let body = text;
  if (body.length > MSG_CAP) body = `${body.slice(0, MSG_CAP)}\n…[truncated]`;
  return `[${role}] ${body}`;
}

/**
 * pi-prep's KEPT TAIL as context messages (RCA F2): the branch entries at/
 * after preparation.firstKeptEntryId — the newest work pi keeps in context
 * across the compaction. The restart still drops it (pi boots from the LLM
 * summary, not the tail), so the handover doc carries it in full. Returns
 * [] when the id is not on the branch (safe: span-only doc).
 */
export function keptTailMessages(
  preparation: HandoverPreparation,
  branchEntries: SessionEntry[],
): HandoverMessage[] {
  if (branchEntries.length === 0) return [];
  const idx = branchEntries.findIndex(
    (e) => e.id === preparation.firstKeptEntryId,
  );
  if (idx < 0) return [];
  const out: HandoverMessage[] = [];
  for (let i = idx; i < branchEntries.length; i++) {
    for (const m of sessionEntryToContextMessages(branchEntries[i])) {
      out.push(m as HandoverMessage);
    }
  }
  return out;
}
