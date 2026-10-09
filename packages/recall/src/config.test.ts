import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { defaultDsn, envConfig, loadDotEnv, parseDsn } from "./config";

describe("defaultDsn ($USER default)", () => {
  const saved = {
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
  };
  const restoreUser = () => {
    if (saved.USER === undefined) delete process.env.USER;
    else process.env.USER = saved.USER;
    if (saved.LOGNAME === undefined) delete process.env.LOGNAME;
    else process.env.LOGNAME = saved.LOGNAME;
  };

  test("uses $USER for the default DSN user", () => {
    try {
      process.env.USER = "frank";
      delete process.env.LOGNAME;
      expect(defaultDsn()).toBe("host=127.0.0.1 dbname=rag user=frank");
    } finally {
      restoreUser();
    }
  });

  test("falls back to LOGNAME, then the OS user", () => {
    try {
      delete process.env.USER;
      process.env.LOGNAME = "monky";
      expect(defaultDsn()).toBe("host=127.0.0.1 dbname=rag user=monky");
      delete process.env.LOGNAME;
      expect(defaultDsn()).toBe(
        `host=127.0.0.1 dbname=rag user=${userInfo().username}`,
      );
    } finally {
      restoreUser();
    }
  });

  test("envConfig: default DSN user = $USER; RAG_DSN still wins, unset fields fall back", () => {
    process.env.USER = "frank";
    const savedDsn = process.env.RAG_DSN;
    delete process.env.RAG_DSN;
    try {
      expect(envConfig().dsn).toEqual({
        host: "127.0.0.1",
        database: "rag",
        username: "frank",
      });
      process.env.RAG_DSN = "dbname=rag user=other";
      // RAG_DSN still wins; fields it leaves unset stay undefined and
      // fall back to PG* env vars / driver defaults, as before.
      expect(envConfig().dsn).toEqual({ database: "rag", username: "other" });
      expect(envConfig().dsn.host).toBeUndefined();
    } finally {
      restoreUser();
      if (savedDsn === undefined) delete process.env.RAG_DSN;
      else process.env.RAG_DSN = savedDsn;
    }
  });
});

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

  test("socket URL (postgres:///rag): empty hostname -> host unset (audit F7)", () => {
    // libpq treats a missing host as the unix-socket default; the same
    // holds here: host stays UNSET (never ""), so connect() does not
    // feed pgpassLookup a fake TCP host
    const d = parseDsn("postgres:///rag");
    expect(d).toEqual({ database: "rag" });
    expect(d.host).toBeUndefined();
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
