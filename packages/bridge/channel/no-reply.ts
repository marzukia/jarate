// NO_REPLY line protocol (op order, Andryo via piboy 2026-10-31): the token
// marks "post nothing". Detection is LENIENT: any line equal to the token
// (line-trimmed, case-insensitive) is removed from the final text; the
// trimmed remainder is posted, and an empty remainder is silence. The token
// must never appear in a posted message. (2026-10-31: a "Healthy: \nNO_REPLY"
// final used to post the token verbatim because detection was exact-match on
// the whole text.)
const NO_REPLY = "NO_REPLY";

/** Remove every NO_REPLY line (line-trimmed, case-insensitive) and trim
 *  the remainder. Returns "" = silence, or the non-empty text to post. */
export function stripNoReply(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim().toUpperCase() !== NO_REPLY)
    .join("\n")
    .trim();
}
