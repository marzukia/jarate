import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pgpassLookup } from "./db";

describe("pgpassLookup", () => {
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), "recall-pgpass-")),
    ".pgpass",
  );
  writeFileSync(
    file,
    [
      "# comment",
      "127.0.0.1:5432:rag:monky:secret123",
      "localhost:5432:*:monky:other",
      "127.0.0.1:*:rag:*:wildcard",
      "127.0.0.1:5434:rag2:monky:col:ons:in:pw",
      "other:5432:rag:monky:nomatch",
    ].join("\n"),
  );

  test("exact match wins, first line takes precedence", () => {
    expect(pgpassLookup("127.0.0.1", 5432, "rag", "monky", file)).toBe(
      "secret123",
    );
  });

  test("wildcards match, more specific earlier lines win", () => {
    expect(pgpassLookup("127.0.0.1", 5499, "rag", "frank", file)).toBe(
      "wildcard",
    );
    expect(pgpassLookup("localhost", 5432, "anything", "monky", file)).toBe(
      "other",
    );
  });

  test("no match -> undefined", () => {
    expect(
      pgpassLookup("127.0.0.1", 5432, "otherdb", "monky", file),
    ).toBeUndefined();
  });

  test("password with colons is preserved", () => {
    expect(pgpassLookup("127.0.0.1", 5434, "rag2", "monky", file)).toBe(
      "col:ons:in:pw",
    );
  });

  test("missing file -> undefined", () => {
    expect(
      pgpassLookup("127.0.0.1", 5432, "rag", "monky", "/nonexistent/.pgpass"),
    ).toBeUndefined();
  });
});
