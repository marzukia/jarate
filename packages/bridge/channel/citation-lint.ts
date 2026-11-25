/**
 * #384 guard E — the inbound-citation lint.
 *
 * After each final post the bridge scans the post body for 17-20
 * digit runs (snowflake-like IDs) and checks each against the
 * channel's delivered/seen set (the seen list in channel-state.json,
 * live in the discord state). Any cited ID absent from the set
 * appends ONE deterministic footnote per ID:
 *
 *   [bridge note: cited message id <id> not in this channel's
 *   delivered set — verify before acting]
 *
 * Set membership only — no parsing of meaning. (Catches the
 * 2026-11-25 07:57Z confabulation: the cited ID was not in the
 * delivered set.) When the seen set is empty (no delivered history
 * in this process) nothing is flagged.
 */

import { loadChannelStateFile } from "./channel-state";
import { getDiscordStates } from "./discord";

/** The deterministic footnote for one absent ID. */
export function citationFootnote(id: string): string {
  return `[bridge note: cited message id ${id} not in this channel's delivered set — verify before acting]`;
}

/** The 17-20 digit runs in the body (maximal runs, deduped, in
 *  order of first appearance). */
export function citedIds(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/\d+/g)) {
    const run = m[0];
    if (run.length < 17 || run.length > 20 || seen.has(run)) continue;
    seen.add(run);
    out.push(run);
  }
  return out;
}

/** The footnotes for the cited IDs absent from the delivered set
 *  (joined on newlines; null when none / empty set). */
export function citationLintNote(
  body: string,
  seenIds: ReadonlySet<string>,
): string | null {
  if (seenIds.size === 0) return null;
  const notes = citedIds(body)
    .filter((id) => !seenIds.has(id))
    .map(citationFootnote);
  return notes.length > 0 ? notes.join("\n") : null;
}

/** The channel's delivered/seen set: the live discord-state seen ids
 *  plus the persisted channel-state.json seen list (belt: a state the
 *  poller has not seeded yet still lints against the file). */
export function channelSeenIds(channelId: string): Set<string> {
  const st = getDiscordStates().get(channelId);
  const out = new Set<string>(st?.seen.seenIds ?? []);
  if (st?.stateDir) {
    for (const id of loadChannelStateFile(st.stateDir).seen[channelId] ?? [])
      out.add(id);
  }
  return out;
}

/** The post-processor hook: append the footnotes (with a blank-line
 *  separator) to the final post body, or return it unchanged. */
export function applyCitationLint(body: string, channelId: string): string {
  const note = citationLintNote(body, channelSeenIds(channelId));
  return note ? `${body}\n\n${note}` : body;
}
