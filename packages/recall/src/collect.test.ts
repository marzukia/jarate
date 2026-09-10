import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collect } from "./collect";

function setup(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(path.join(tmpdir(), "recall-collect-"));
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe("collect", () => {
  test("tags projects/<name> files with the inner project", () => {
    const { home, cleanup } = setup();
    try {
      const dir = path.join(home, "projects", "alpha");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "a.md"), "alpha note");
      const out = collect([path.join(home, "projects")], home);
      expect(out).toEqual([
        {
          project: "alpha",
          source: path.join(dir, "a.md"),
          content: "alpha note",
        },
      ]);
    } finally {
      cleanup();
    }
  });

  test("top-level files are tagged with the relpath first element", () => {
    const { home, cleanup } = setup();
    try {
      writeFileSync(path.join(home, "AGENTS.md"), "agents");
      const out = collect([path.join(home, "AGENTS.md")], home);
      expect(out.map((f) => f.project)).toEqual(["AGENTS.md"]);
    } finally {
      cleanup();
    }
  });

  test("skips SKIP_DIRS, SKIP_EXT, empty, oversized and bad-utf8 files", () => {
    const { home, cleanup } = setup();
    try {
      writeFileSync(path.join(home, "keep.md"), "keep");
      mkdirSync(path.join(home, "node_modules"));
      writeFileSync(path.join(home, "node_modules", "m.js"), "nope");
      mkdirSync(path.join(home, ".git"));
      writeFileSync(path.join(home, ".git", "config"), "nope");
      writeFileSync(path.join(home, "keep.png"), Buffer.from([1, 2, 3]));
      writeFileSync(path.join(home, "empty.md"), "   \n");
      writeFileSync(path.join(home, "big.md"), Buffer.alloc(1_000_001, 97));
      writeFileSync(
        path.join(home, "bin.md"),
        Buffer.from([0xff, 0xfe, 0x00, 0x01]),
      );
      const out = collect([home], home);
      expect(out.map((f) => path.basename(f.source))).toEqual(["keep.md"]);
    } finally {
      cleanup();
    }
  });
});
