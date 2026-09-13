import { describe, expect, test } from "bun:test";
import { parseIngestArgs, parseQueryArgs } from "./cli";
import {
  formatResult,
  formatScore,
  formatSnippet,
  SNIPPET_CHARS,
} from "./format";

describe("parseIngestArgs", () => {
  test("no args -> default roots ~/memory ~/projects", () => {
    const r = parseIngestArgs([], "/fake/home");
    expect(r.roots).toEqual(["/fake/home/memory", "/fake/home/projects"]);
    expect(r.noPrune).toBe(false);
  });

  test("explicit roots are kept, --no-prune sets the flag", () => {
    const r = parseIngestArgs(["/a", "--no-prune", "/b"], "/fake/home");
    expect(r.roots).toEqual(["/a", "/b"]);
    expect(r.noPrune).toBe(true);
  });

  test("unknown flag throws", () => {
    expect(() => parseIngestArgs(["--wat"], "/fake/home")).toThrow(
      /unknown flag/,
    );
  });
});

describe("parseQueryArgs", () => {
  test("joins all args with spaces", () => {
    const r = parseQueryArgs(["what", "does", "search()", "do"]);
    expect(r.question).toBe("what does search() do");
    expect(r.json).toBe(false);
  });

  test("--json sets the flag, question words around it are joined", () => {
    const r = parseQueryArgs(["--json", "what", "is", "dispatch"]);
    expect(r.question).toBe("what is dispatch");
    expect(r.json).toBe(true);
  });

  test("empty question throws", () => {
    expect(() => parseQueryArgs([])).toThrow();
    expect(() => parseQueryArgs(["   "])).toThrow();
    expect(() => parseQueryArgs(["--json"])).toThrow();
  });

  test("unknown flag throws", () => {
    expect(() => parseQueryArgs(["--wat", "q"])).toThrow(/unknown flag/);
  });
});

describe("formatScore", () => {
  test("4 decimal places like python f'{score:.4f}'", () => {
    expect(formatScore(0.03251)).toBe("0.0325");
    expect(formatScore(0.03245)).toBe("0.0324"); // same double as python; both round down
    expect(formatScore(1)).toBe("1.0000");
  });
});

describe("formatSnippet", () => {
  test("first 300 chars, stripped", () => {
    const long = "x".repeat(SNIPPET_CHARS + 50);
    expect(formatSnippet(long).length).toBe(SNIPPET_CHARS);
    expect(formatSnippet("  padded  ")).toBe("padded");
    expect(formatSnippet("short")).toBe("short");
  });
});

describe("formatResult", () => {
  test("matches the python output shape", () => {
    const out = formatResult({
      source: "/home/monky/projects/pgrag/PLAN.md",
      content: "body text",
      score: 0.0325,
    });
    expect(out).toBe(
      "--- 0.0325  /home/monky/projects/pgrag/PLAN.md\nbody text",
    );
  });
});
