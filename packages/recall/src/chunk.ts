// Deterministic chunking. Port of chunk_text() from the Python pgrag:
// split on markdown headings (.md/.markdown only), then window oversized
// sections at CHUNK_WORDS with OVERLAP_WORDS of overlap. Pure function of
// (text, path) - same inputs, same chunks, always.

import path from "node:path";

export const CHUNK_WORDS = 400;
export const OVERLAP_WORDS = 50;

const MD_EXTS = new Set([".md", ".markdown"]);

export function chunkText(text: string, filePath: string): string[] {
  const isMd = MD_EXTS.has(path.extname(filePath).toLowerCase());
  // Python: re.split(r"(?m)^(?=#{1,6} )", text). Lookbehind variant is the
  // same split for all practical cases (a heading at byte 0 only differs by
  // one empty part, dropped below).
  const parts = isMd ? text.split(/(?<=\n)(?=#{1,6} )/) : [text];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const secRaw of parts) {
    const sec = secRaw.trim();
    if (!sec) continue;
    const words = sec.split(/\s+/);
    let candidates: string[];
    if (words.length <= CHUNK_WORDS) {
      candidates = [sec];
    } else {
      candidates = [];
      const step = CHUNK_WORDS - OVERLAP_WORDS;
      for (let start = 0; start < words.length; start += step) {
        candidates.push(words.slice(start, start + CHUNK_WORDS).join(" "));
      }
    }
    for (const c of candidates) {
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
  }
  return out;
}
