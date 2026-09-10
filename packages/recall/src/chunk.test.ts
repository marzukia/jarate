import { describe, expect, test } from "bun:test";
import { CHUNK_WORDS, chunkText, OVERLAP_WORDS } from "./chunk";

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("chunkText", () => {
  test("non-markdown: whole file is one chunk, trimmed", () => {
    const out = chunkText("  hello world  \n\n  ", "/tmp/x.txt");
    expect(out).toEqual(["hello world"]);
  });

  test("markdown: splits on headings, heading stays with its section", () => {
    const md =
      "intro line\n# One\nbody one\n## Two\nbody two\n# Three\nbody three";
    const out = chunkText(md, "/tmp/x.md");
    expect(out).toEqual([
      "intro line",
      "# One\nbody one",
      "## Two\nbody two",
      "# Three\nbody three",
    ]);
  });

  test("markdown at byte 0: no empty leading chunk", () => {
    const out = chunkText("# Head\nbody", "/tmp/x.md");
    expect(out).toEqual(["# Head\nbody"]);
  });

  test("blank sections are dropped", () => {
    const out = chunkText("# A\n\n\n# B\n", "/tmp/x.md");
    expect(out).toEqual(["# A", "# B"]);
  });

  test("non-markdown heading markers are not split", () => {
    const out = chunkText("# not a heading\ntext", "/tmp/x.txt");
    expect(out).toEqual(["# not a heading\ntext"]);
  });

  test("exactly CHUNK_WORDS is one chunk", () => {
    const out = chunkText(words(CHUNK_WORDS), "/tmp/x.txt");
    expect(out).toEqual([words(CHUNK_WORDS)]);
  });

  test("oversized section windows with overlap", () => {
    const n = CHUNK_WORDS + OVERLAP_WORDS + 1; // 451 words
    const out = chunkText(words(n), "/tmp/x.txt");
    const step = CHUNK_WORDS - OVERLAP_WORDS;
    expect(out).toEqual([
      words(n).split(" ").slice(0, CHUNK_WORDS).join(" "),
      words(n).split(" ").slice(step).join(" "),
    ]);
    // every window is CHUNK_WORDS except the last; consecutive windows
    // overlap by exactly OVERLAP_WORDS
    expect(out[0]?.split(" ").length).toBe(CHUNK_WORDS);
    expect(out[1]?.split(" ").length).toBe(n - step);
  });

  test("long section produces the same window layout as the Python version", () => {
    const n = 1000;
    const w = words(n).split(" ");
    const out = chunkText(words(n), "/tmp/x.txt");
    const step = CHUNK_WORDS - OVERLAP_WORDS;
    const expected: string[] = [];
    for (let start = 0; start < n; start += step) {
      expected.push(w.slice(start, start + CHUNK_WORDS).join(" "));
    }
    expect(out).toEqual(expected);
  });

  test("identical repeated sections are deduped", () => {
    const md = "# A\nsame\n# A\nsame";
    expect(chunkText(md, "/tmp/x.md")).toEqual(["# A\nsame"]);
  });
});
