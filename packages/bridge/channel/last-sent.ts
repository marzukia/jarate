/**
 * #315 P1 leg (promoted P0): the last-sent-message guards. The live failure mode is the MID-TURN SPLIT: compaction lands mid-turn, the capture boundary cuts the turn, and the restored agent comes back not knowing its own last SENT message (the final reply it posted to the channel).
 *
 * This module carries the three guards. (1) DEDICATED FIELD: the doc's "Last sent message" section — the last assistant FINAL message the SEND PIPELINE ACTUALLY POSTS, extracted from the FULL session transcript (a type/role scan of the session jsonl entries), NOT from the size-limited tail window; a mid-turn split (last entry = a tool call) must still surface it, "(none)" when no posted final exists. The extraction applies the SAME pure functions as the send pipeline (cleanThinking in live.ts, stripNoReply in no-reply.ts, the finalRepeatStep core of index.ts recordFinalRepeat — imported, not re-implemented): a final that cleans to empty (thinking-tag-only), is NO_REPLY-silent, or is the third consecutive identical one (dropped) is NOT sent, and the field walks back to the previous posted final. (2) DOC-WRITE GUARD: after extraction, re-scan the FULL transcript through the same gate; a POSTED assistant final newer than the field (or any, when the field is (none)) → one LAST-SENT-MISSING flag line + a doc tag (the #315 P1 section-tag mechanism, same as INCOMPLETE-ASKS); numeric ts compare only — no inference. (3) SESSION-START GUARD: the doc's field = (none) but channel history shows a post BY THIS AGENT < 30 min old → one flag line (the restored agent posted just before rotation; the doc dropped it); same shape as the #315 P1 unanswered-ask check.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { finalRepeatStep } from "./final-repeat";
import {
  ASK_SELF_CHECK_WINDOW_MS,
  assembleDoc,
  type ChannelHistoryMessage,
  splitDoc,
} from "./handover";
import { cleanThinking } from "./live";
import { stripNoReply } from "./no-reply";

/** One assistant final that the send pipeline posts, found by a transcript scan: the posted text (joined text blocks, cleaned of leaked thinking tags, NO_REPLY lines stripped) + its numeric ordinal (ms epoch; 0 when unparseable). */
export interface SentMessage {
  /** the posted text (cleaned + token-stripped, as posted). */
  text: string;
  /** numeric ordinal (ms epoch; 0 when unparseable). */
  ts: number;
}

type Block = { type?: string; text?: unknown };

function contentOf(e: SessionEntry): unknown {
  return (e as { message?: { content?: unknown } }).message?.content;
}

/** The reply text of an entry: a string content as-is; an array content is its text blocks joined. "" when there is none. */
function textOf(e: SessionEntry): string {
  const c = contentOf(e);
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return (c as Block[])
      .filter((b) => b && b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("");
  }
  return "";
}

function hasToolCall(e: SessionEntry): boolean {
  const c = contentOf(e);
  return Array.isArray(c)
    ? (c as Block[]).some((b) => b && b.type === "toolCall")
    : false;
}

/** True when a session entry is an assistant FINAL message: role assistant, non-empty text, and NO toolCall block — the structural gate of live.ts finalText. A mid-turn message (a toolCall present, or no text) is NOT a final. Whether a structural final is actually POSTED is the send-pipeline gate (postedText): cleanThinking → stripNoReply → the recordFinalRepeat drop. */
export function isFinalAssistant(e: SessionEntry): boolean {
  if (e.type !== "message") return false;
  if ((e as { message?: { role?: string } }).message?.role !== "assistant")
    return false;
  return textOf(e).trim() !== "" && !hasToolCall(e);
}

/** The SEND-PIPELINE view of a structural final — the same pure functions both live send paths (message_end, agent_end) apply, imported not re-implemented: cleanThinking (live.ts) → stripNoReply (no-reply.ts). Returns the text the bridge posts; null = the bridge posts NOTHING (cleaned to empty = thinking-tag-only, or the NO_REPLY silence check: empty remainder after the token lines are removed). */
export function postedText(e: SessionEntry): string | null {
  if (!isFinalAssistant(e)) return null;
  const clean = cleanThinking(textOf(e).trim());
  if (!clean) return null;
  const stripped = stripNoReply(clean);
  return stripped === "" ? null : stripped;
}

/** True when a session entry is an inbound channel message — the transcript analog of the "new inbound user message" that resets the live repetition counter (resetFinalRepeats on the bridge's inbound path). */
function isInbound(e: SessionEntry): boolean {
  return (
    e.type === "custom_message" &&
    (e as { customType?: string }).customType === "channel-inbound"
  );
}

/** Numeric ts (ms epoch) of an entry: the message payload's numeric timestamp first (pi message entries carry one), then the entry-level ISO timestamp. 0 when unparseable. */
export function entryTs(e: SessionEntry): number {
  const t = Number(
    (e as { message?: { timestamp?: unknown } }).message?.timestamp,
  );
  if (Number.isFinite(t) && t > 0) return t;
  const s = Date.parse(String((e as { timestamp?: unknown }).timestamp ?? ""));
  return Number.isFinite(s) ? s : 0;
}

/** The last assistant FINAL the send pipeline ACTUALLY POSTS in the FULL session transcript (newest by numeric ts; entry order breaks ties — the branch is chronological). The pipeline gate is applied per candidate and replayed in order: cleanThinking → stripNoReply (empty = silence) → the recordFinalRepeat drop (finalRepeatStep pure core; a new inbound resets the streak, as in live). A candidate that is NOT sent (empty/silent/dropped) is skipped and the field walks back to the previous posted final; null when no final survives at all. Deliberately NOT the size-limited tail window: a mid-turn split (last entry = a tool call) must still surface the last completed turn's posted reply. */
export function lastSentMessage(entries: SessionEntry[]): SentMessage | null {
  let best: SentMessage | null = null;
  let bestIdx = -1;
  let streak: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!isFinalAssistant(e)) {
      if (isInbound(e)) streak = [];
      continue;
    }
    const posted = postedText(e);
    if (posted == null) continue; // not posted (cleaned to empty / NO_REPLY silence)
    const { drop, next } = finalRepeatStep(streak, posted);
    streak = next;
    if (drop) continue; // third consecutive identical — the pipeline drops it
    const ts = entryTs(e);
    if (best == null || ts > best.ts || (ts === best.ts && i > bestIdx)) {
      best = { text: posted, ts };
      bestIdx = i;
    }
  }
  return best;
}

/** #315 P1 leg, the doc-write guard (deterministic, no inference): re-scan the FULL transcript through the same send-pipeline gate; if it contains a POSTED assistant final message NEWER than the one in the field (numeric ts compare, entry order breaking ties) — or ANY, when the field is (none) — the extraction dropped the last reply. A silent (NO_REPLY / thinking-tag-only) or repeat-dropped newer final is NOT a miss. Returns the missed message; null when the field is current. */
export function lastSentMissing(
  field: string,
  fieldTs: number,
  entries: SessionEntry[],
): SentMessage | null {
  const best = lastSentMessage(entries);
  if (best == null) return null;
  const f = field.trim();
  if (f === "" || f === "(none)") return best;
  return best.ts > fieldTs ? best : null;
}

/** Tag the doc's "Last sent message" section body — the #315 P1 section-tag mechanism (same as INCOMPLETE-ASKS): one `>` line, inert for the boot seed (parseKickoff never reads this section) and the section is sizeGuard-protected, so the tag survives the size cut. The doc is returned unchanged when the section is absent. */
export function tagLastSentMissing(doc: string, missed: SentMessage): string {
  const parts = splitDoc(doc);
  const s = parts.sections.find((x) => x.title.includes("sent message"));
  if (!s) return doc;
  const tag = `> LAST-SENT-MISSING: the transcript carries an assistant final (ts=${missed.ts}) newer than the doc field (issue #315 P1 leg)`;
  s.body = `${s.body}\n${tag}`;
  return assembleDoc(parts);
}

/** True when the doc's "Last sent message" section renders (none) (the case the session-start guard looks for). Missing section → false (pre-feature docs: cannot distinguish, conservative no-fire). */
export function docLastSentIsNone(doc: string): boolean {
  const { sections } = splitDoc(doc);
  const s = sections.find((x) => x.title.includes("sent message"));
  if (!s) return false;
  for (const line of s.body.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith(">")) continue;
    return t === "(none)";
  }
  return false;
}

/** #315 P1 leg, the exact session-start condition: the doc says (none) but channel history shows a post BY THIS AGENT < 30 min old = flag (the restored agent posted just before rotation; the doc dropped it). "This agent" = a bot post by botUserId (when known), else any non-webhook bot post (a machine-wake card is not the agent's reply). Numeric ts compare only. Returns the flag line; null when nothing to flag. */
export function sessionStartSentFlag(
  doc: string,
  history: ChannelHistoryMessage[],
  botUserId: string | null,
  now: number = Date.now(),
): string | null {
  if (!docLastSentIsNone(doc)) return null;
  const isOwn = (m: ChannelHistoryMessage): boolean =>
    botUserId != null ? m.authorId === botUserId : m.bot && !m.webhook;
  const own = history.filter(
    (m) =>
      isOwn(m) &&
      Number.isFinite(m.ts) &&
      now - m.ts < ASK_SELF_CHECK_WINDOW_MS,
  );
  if (own.length === 0) return null;
  return `session start: the handoff doc says (none) but this agent posted ${own.length} message(s) < 30m ago (issue #315 P1 leg)`;
}
