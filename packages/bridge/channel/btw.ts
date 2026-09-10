// Detects `. btw` suffix at the end of a Discord message.
//
// Ported from kimaki's btw-prefix-detection.ts. When present the suffix is
// stripped and the remaining message is flagged as a side question, so the
// agent answers briefly instead of treating it as a full task.
//
// Supported forms:
// - punctuation + btw: ". btw", "! btw", ". btw.", "!btw."
// - btw as its own final line: "text\nbtw"
// Non-matches: "btw fix this" (start only), "hello btw" (no punctuation)

const BTW_SUFFIX_RE = /(?:[.!?,;:])\s*btw\.?\s*$|\n\s*btw\.?\s*$/i;

/** Hint appended to btw-flagged messages so the agent answers briefly. */
export const BTW_HINT =
  "Side question (btw): answer briefly, in one or two sentences.";

export function extractBtwSuffix(content: string): {
  prompt: string;
  forceBtw: boolean;
} {
  if (!BTW_SUFFIX_RE.test(content)) {
    return { prompt: content, forceBtw: false };
  }
  return {
    prompt: content.replace(BTW_SUFFIX_RE, "").trimEnd(),
    forceBtw: true,
  };
}
