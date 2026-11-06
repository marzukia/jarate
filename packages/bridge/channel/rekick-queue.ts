// rekick-queue — the #315 half of the restart-queue family. Split out as
// its own module by the size gate (restart-queue.ts crossed 800 non-blank
// lines with this section; ratcheted files may only shrink, new code
// goes to a sibling module).

import * as fs from "node:fs";
import { loadRewakeQueue } from "./restart-queue";
import type { ChannelMessage } from "./types";

// ─── #315 (incident 2026-11-03, lane janky): delivered-but-unanswered re-kick ───
//
// rewakeUnpersisted owns the "accepted but not persisted" gap (the commit
// reached .delivered, the process died before the steering queue flushed
// to the session file). The 2026-11-03 roll incident is the mirror image:
// the deploy restarted pi.service 62s into the turn an op question
// started; the prompt IS in the session file, the delivered set says done,
// no assistant answer followed, and the agent idled out unanswered (the
// #306 flag fired report-only and the startup kick found .pending empty).
// This check closes that gap: a committed id whose prompt is in the
// session file but whose turn window (the entries up to the NEXT
// user-level inbound) carries no assistant answer is re-queued at a real
// process start; the existing startup kick then delivers it (the wake-fail
// direct delivery when the bridge is idle).

/** #315 re-kick age guard: a trigger committed more than this long ago is
 *  not re-kicked (an older unanswered ask is presumed handled in a
 *  since-rotated session or superseded; the same 30-min window the #306
 *  amnesia flag reports with). */
export const REKICK_MAX_AGE_MS = 30 * 60 * 1000;

/** #315 re-kick: a delivered id ready to re-queue (mirrors AmnesiaEntry). */
export interface RekickEntry {
  id: string;
  msg: ChannelMessage;
  at: number;
}

/** Is this parsed session entry a user-level inbound (a turn boundary)?
 *  Bridge inbounds land as custom_message; TUI/steered inbounds as
 *  role=user messages. */
function isUserLevelEntry(o: unknown): o is any {
  if (!o || typeof o !== "object") return false;
  const e = o as Record<string, any>;
  if (e.type === "custom_message") return true;
  return e.type === "message" && e.message?.role === "user";
}

/** The prompt text of one user-level entry (same extraction rules as
 *  readSessionPrompts: custom_message content, or the user message's
 *  string content / joined text blocks). Null for every non-inbound. */
function entryPrompt(o: Record<string, any>): string | null {
  if (o.type === "custom_message" && typeof o.content === "string")
    return o.content;
  if (o.type === "message" && o.message?.role === "user") {
    const c = o.message.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const text = c
        .filter(
          (b: any) =>
            typeof b === "string" ||
            (b && typeof b === "object" && typeof b.text === "string"),
        )
        .map((b: any) => (typeof b === "string" ? b : b.text))
        .join("");
      if (text) return text;
    }
  }
  return null;
}

/** Does this entry settle an answer: an assistant message carrying a
 *  non-empty text block (string content counts too)? Thinking-only and
 *  toolCall-only assistant entries do NOT settle — the turn produced no
 *  reply (killed mid-thinking, or the text arrived later / never). */
function settlesAnswer(o: unknown): boolean {
  if (!o || typeof o !== "object") return false;
  const e = o as Record<string, any>;
  if (e.type !== "message" || e.message?.role !== "assistant") return false;
  const c = e.message.content;
  if (typeof c === "string") return c.trim().length > 0;
  if (!Array.isArray(c)) return false;
  return c.some(
    (b: any) =>
      b &&
      typeof b === "object" &&
      b.type === "text" &&
      typeof b.text === "string" &&
      b.text.trim().length > 0,
  );
}

/** One parse of a pi session file (JSONL) for the re-kick check.
 *  Returns the set of prompt texts that are PERSISTED but UNANSWERED:
 *  the prompt's LAST occurrence (a user-level inbound) has no assistant
 *  answer after it before the next user-level inbound (the turn window).
 *  The window ends at the next inbound on purpose: an answer to a LATER
 *  inbound (a following machine wake) must not count as the answer to
 *  this one. A prompt that never appears is absent (the amnesia path
 *  owns it). Never throws: an unreadable file or a torn tail line
 *  (process died mid-write) degrades to "nothing unanswered" — the
 *  conservative direction, same tolerance as readSessionPrompts. */
export function scanUnansweredPrompts(sessionFile: string): Set<string> {
  const out = new Set<string>();
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return out;
  }
  const entries: Record<string, any>[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === "object") entries.push(o);
    } catch {
      // torn tail line: skip it (readSessionPrompts' tolerance)
    }
  }
  // Prompt texts -> their occurrence indices (user-level entries only).
  const occurrences = new Map<string, number[]>();
  entries.forEach((e, i) => {
    if (!isUserLevelEntry(e)) return;
    const p = entryPrompt(e);
    if (p === null || p.length === 0) return;
    const list = occurrences.get(p) ?? [];
    list.push(i);
    occurrences.set(p, list);
  });
  // Boundary map: each user-level index -> the index where its window
  // ends (the next user-level entry, or the file end).
  const boundaryEnd = new Map<number, number>();
  let next = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isUserLevelEntry(entries[i])) {
      boundaryEnd.set(i, next);
      next = i;
    }
  }
  for (const [p, idxs] of occurrences) {
    const last = idxs[idxs.length - 1]; // last occurrence wins (re-kicks re-post the same prompt)
    const end = boundaryEnd.get(last) ?? entries.length;
    let answered = false;
    for (let i = last + 1; i < end; i++) {
      if (settlesAnswer(entries[i])) {
        answered = true;
        break;
      }
    }
    if (!answered) out.add(p);
  }
  return out;
}

/** #315: the delivered ids that are PERSISTED but UNANSWERED (the mirror
 *  of rewakeUnpersisted's accepted-but-unpersisted gap). Guards match
 *  rewakeUnpersisted: SAME-FILE (meta.sf === sessionFile) and AGE
 *  (committed within maxAgeMs). An id whose prompt is absent from the
 *  file is NOT here — that is the amnesia path's gap. Returns the ids
 *  ready to re-queue, oldest commit first (file insertion order). */
export function rewakeUnanswered(
  stateDir: string | null | undefined,
  channelId: string,
  sessionFile: string | null | undefined,
  now = Date.now(),
  maxAgeMs = REKICK_MAX_AGE_MS,
): RekickEntry[] {
  if (!sessionFile) return [];
  const file = loadRewakeQueue(stateDir, channelId);
  const meta = file.deliveredMeta;
  if (!meta) return [];
  const unanswered = scanUnansweredPrompts(sessionFile);
  const out: RekickEntry[] = [];
  for (const id of file.delivered) {
    const m = meta[id];
    if (!m) continue; // no commit metadata (pre-field file) — cannot check
    if (m.sf !== sessionFile) continue; // same-file guard
    if (now - m.at > maxAgeMs) continue; // stale
    if (!unanswered.has(m.prompt)) continue; // answered, or amnesia's gap
    out.push({ id, msg: m.msg, at: m.at });
  }
  return out;
}
