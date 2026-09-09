// Memory table-of-contents.
//
// Condenses a workspace MEMORY.md into a line-numbered TOC so the channel
// context block can point the agent at specific sections without inlining
// the whole file. Ported from kimaki's condense-memory.ts.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { Lexer } from "marked";

/** Refuse to inline a MEMORY.md larger than this. */
const MAX_MEMORY_FILE_CHARS = 100_000;

/**
 * Condense MEMORY.md content into a line-numbered table of contents.
 * Parses the markdown AST with marked's Lexer, emits each heading prefixed
 * by its source line number, and collapses non-heading content to `...`.
 */
export function condenseMemoryMd(content: string): string {
  const tokens = new Lexer().lex(content);
  const lines: string[] = [];
  // 1-based line number at the start of the current token, advanced by
  // counting newlines in each token's raw — O(n) overall instead of the
  // per-token slice(0, offset)+split that was O(n^2) in file size.
  let line = 1;
  let lastWasEllipsis = false;

  for (const token of tokens) {
    if (token.type === "heading") {
      const prefix = "#".repeat(token.depth);
      lines.push(`${line}: ${prefix} ${token.text}`);
      lastWasEllipsis = false;
    } else if (!lastWasEllipsis) {
      lines.push("...");
      lastWasEllipsis = true;
    }
    for (let i = 0; i < token.raw.length; i++) {
      if (token.raw.charCodeAt(i) === 10) line++;
    }
  }

  return lines.join("\n");
}

/**
 * Read `MEMORY.md` at the workspace root and return a condensed TOC, or an
 * empty string when the file is missing, over the size cap, or unreadable.
 */
export async function memoryToc(workspaceRoot: string): Promise<string> {
  try {
    const file = path.join(workspaceRoot, "MEMORY.md");
    const raw = await readFile(file, "utf8");
    if (raw.length === 0 || raw.length > MAX_MEMORY_FILE_CHARS) {
      return "";
    }
    return condenseMemoryMd(raw);
  } catch {
    return "";
  }
}
