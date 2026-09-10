import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadDotEnv, parseDsn } from "./config";

describe("parseDsn", () => {
  test("key=value form (psycopg style)", () => {
    const d = parseDsn("host=127.0.0.1 dbname=rag user=monky");
    expect(d).toEqual({
      host: "127.0.0.1",
      database: "rag",
      username: "monky",
    });
  });

  test("accepts database= and username= spellings, port, password", () => {
    const d = parseDsn(
      "host=localhost port=5433 database=rag username=monky password=secret",
    );
    expect(d).toEqual({
      host: "localhost",
      port: 5433,
      database: "rag",
      username: "monky",
      password: "secret",
    });
  });

  test("postgres:// URL form", () => {
    const d = parseDsn("postgres://monky:secret@127.0.0.1:5433/rag");
    expect(d).toEqual({
      host: "127.0.0.1",
      port: 5433,
      database: "rag",
      username: "monky",
      password: "secret",
    });
  });

  test("missing dbname throws", () => {
    expect(() => parseDsn("host=127.0.0.1 user=monky")).toThrow(/dbname/);
  });
});

describe("loadDotEnv", () => {
  test("missing file is a no-op", () => {
    expect(() => loadDotEnv("/nonexistent/.env")).not.toThrow();
  });

  test("sets vars, never overrides, skips comments", () => {
    const dir = mkdtempSync(`${tmpdir()}/recall-env-`);
    const file = `${dir}/.env`;
    process.env.RECALL_TEST_A = "keep";
    process.env.RECALL_TEST_C = "first";
    writeFileSync(
      file,
      [
        "# comment",
        "",
        "RECALL_TEST_A=override",
        "RECALL_TEST_B=from-file",
        "RECALL_TEST_C=second",
        'RECALL_TEST_D="quoted value"',
      ].join("\n"),
    );
    loadDotEnv(file);
    expect(process.env.RECALL_TEST_A).toBe("keep");
    expect(process.env.RECALL_TEST_B).toBe("from-file");
    expect(process.env.RECALL_TEST_C).toBe("first");
    expect(process.env.RECALL_TEST_D).toBe("quoted value");
    for (const k of [
      "RECALL_TEST_A",
      "RECALL_TEST_B",
      "RECALL_TEST_C",
      "RECALL_TEST_D",
    ]) {
      delete process.env[k];
    }
  });
});
