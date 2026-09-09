import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { condenseMemoryMd, memoryToc } from "./memory";

describe("condenseMemoryMd", () => {
  test("produces line-numbered TOC of headings only", () => {
    const md = [
      "# Top",
      "",
      "Intro text.",
      "",
      "## Section A",
      "",
      "Body A.",
      "",
      "## Section B",
    ].join("\n");
    const toc = condenseMemoryMd(md);
    expect(toc).toBe("1: # Top\n...\n5: ## Section A\n...\n9: ## Section B");
  });

  test("non-heading content becomes ellipsis", () => {
    const md = "# Top\n\ntext here\n\n## Sub\n\nmore text";
    const toc = condenseMemoryMd(md);
    expect(toc).toContain("1: # Top");
    expect(toc).toContain("...");
    expect(toc).toContain("5: ## Sub");
    expect(toc).not.toContain("text here");
    expect(toc).not.toContain("more text");
  });

  test("headings inside code fences ignored", () => {
    const md = "# Real\n\n```\n## not a heading\n```\n\n## Also real";
    const toc = condenseMemoryMd(md);
    expect(toc).toBe("1: # Real\n...\n7: ## Also real");
  });

  test("heading-free content becomes ellipsis", () => {
    expect(condenseMemoryMd("")).toBe("");
    expect(condenseMemoryMd("no headings here\njust text")).toBe("...");
  });
});

describe("memoryToc", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "piscord-memory-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing MEMORY.md returns empty string", async () => {
    expect(await memoryToc(join(dir, "nope"))).toBe("");
  });

  test("missing directory returns empty string", async () => {
    expect(await memoryToc(join(dir, "does", "not", "exist"))).toBe("");
  });

  test("reads MEMORY.md from workspace", async () => {
    const ws = join(dir, "ws1");
    mkdirSync(ws);
    writeFileSync(join(ws, "MEMORY.md"), "# Main\n\n## Sub\n");
    expect(await memoryToc(ws)).toBe("1: # Main\n3: ## Sub");
  });

  test("oversized MEMORY.md returns empty string", async () => {
    const ws = join(dir, "ws2");
    mkdirSync(ws);
    const huge = `# T\n\n${"x".repeat(200_000)}\n`;
    writeFileSync(join(ws, "MEMORY.md"), huge);
    expect(await memoryToc(ws)).toBe("");
  });
});
