// Reply message context: when the user replies to a message, its author +
// text are injected as a <replied-message> block so the LLM knows what is
// being pointed at. Ported from kimaki's reply-context handling.

function escapePromptAttr(value: string): string {
  return value.replace(/"/g, "'").replace(/\s+/g, " ");
}

function escapePromptText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Build the <replied-message> LLM block, or "" when there is no reply ref. Exported for tests. */
export function buildRepliedMessageBlock(rm?: {
  author: string;
  text: string;
}): string {
  if (!rm?.text) return "";
  const author = rm.author ? ` author="${escapePromptAttr(rm.author)}"` : "";
  return `This message was a reply to message\n\n<replied-message${author}>\n${escapePromptText(rm.text)}\n</replied-message>`;
}
