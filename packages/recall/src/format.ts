// Output formatting. Must match the Python pgrag query output shape:
//   --- <score .4f>  <source>
//   <first 300 chars of content, stripped>
//   (blank line)

import type { SearchRow } from "./db";

export const SNIPPET_CHARS = 300;

export function formatScore(score: number): string {
  return score.toFixed(4);
}

export function formatSnippet(content: string): string {
  return content.slice(0, SNIPPET_CHARS).trim();
}

/** One result block. Caller prints a trailing newline after each. */
export function formatResult(row: SearchRow): string {
  return `--- ${formatScore(row.score)}  ${row.source}\n${formatSnippet(row.content)}`;
}
