// Detects a `. queue` suffix at the end of a Discord message.
//
// Kimaki parity: a plain message during an active run ARMS the mid-run
// interrupt (jump the queue). A message ending in ". queue" is parked in
// the re-wake queue explicitly — it waits its turn and does NOT arm the
// interrupt. The suffix is stripped from the stored/forwarded text; the
// bot's ack shows the message's position in line.
//
// Supported forms (case-insensitive):
// - ". queue", "! queue", "; queue", ": queue" (punctuation, then the word)
// - "....queue" style punctuation runs: "text... queue", "text.queue"
// - optional trailing period/spaces: "text. queue.", "text. queue   "
// Non-matches:
// - "put it in the queue" (no punctuation before the word)
// - "buy eggs, queue" (comma = list, ambiguous)
// - "do this. queued" (not the bare word)
// - "queue" alone

const QUEUE_SUFFIX_RE = /(?:[.!?;:]\s*)+queue\.?\s*$/i;

export function extractQueueSuffix(content: string): {
  prompt: string;
  forceQueue: boolean;
} {
  if (!QUEUE_SUFFIX_RE.test(content)) {
    return { prompt: content, forceQueue: false };
  }
  return {
    prompt: content.replace(QUEUE_SUFFIX_RE, "").trimEnd(),
    forceQueue: true,
  };
}
