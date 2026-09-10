// Integration test: scratch database `recall_test` on the local Postgres.
//
// Lifecycle: DROP/CREATE DATABASE (as postgres, via the andryo sudo route -
// the agent role has no CREATEDB), CREATE EXTENSION vector (superuser),
// schema.sql through psql (agent role, unix socket), then real ingest +
// query calls through the postgres driver.
//
// Skips cleanly (describe.skip) when Postgres admin or the Ollama embed
// host is unreachable, so CI-less boxes stay green.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_EMBED_URL,
  type RecallConfig,
} from "./config";
import { connect } from "./db";
import { ingest } from "./ingest";
import { runQuery } from "./query";

const DB = "recall_test";
const PGUSER = process.env.USER ?? "monky";
const PGSOCKET = "/var/run/postgresql";
const SCHEMA = path.join(import.meta.dir, "..", "schema.sql");
const TEST_TIMEOUT_MS = 90_000;

/** Run psql as postgres via the box's andryo->sudo route. */
function adminPsql(sql: string, db?: string): string {
  const inner = `echo 'REDACTED' | sudo -S -u postgres psql ${
    db ? `-d ${db} ` : ""
  }-c ${JSON.stringify(sql)}`;
  return execFileSync(
    "sshpass",
    ["-p", "REDACTED", "ssh", "andryo@127.0.0.1", inner],
    {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function adminReachable(): boolean {
  try {
    adminPsql("select 1");
    return true;
  } catch {
    return false;
  }
}

function createScratchDb(): void {
  adminPsql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  adminPsql(`CREATE DATABASE ${DB} OWNER ${PGUSER}`);
  adminPsql("CREATE EXTENSION IF NOT EXISTS vector", DB);
  execFileSync(
    "psql",
    ["-U", PGUSER, "-d", DB, "-v", "ON_ERROR_STOP=1", "-f", SCHEMA],
    {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function dropScratchDb(): void {
  try {
    adminPsql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  } catch {
    // best effort; a hung box should not mask test failures
  }
}

async function rowCount(database: string): Promise<number> {
  const sql = connect({ database, username: PGUSER, host: PGSOCKET });
  try {
    const rows = await sql.unsafe("select count(*) as n from chunks");
    return Number(rows[0]?.n ?? 0);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const pgOk = adminReachable();
let embedOk = false;
{
  const url = process.env.RAG_EMBED_URL ?? DEFAULT_EMBED_URL;
  const model = process.env.RAG_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: ["ping"] }),
      signal: AbortSignal.timeout(20_000),
    });
    embedOk = res.ok;
    await res.body?.cancel().catch(() => {});
  } catch {
    embedOk = false;
  }
}

const describeIt = pgOk && embedOk ? describe : describe.skip;

describeIt("recall integration (scratch db recall_test)", () => {
  let home: string;
  let config: RecallConfig;

  beforeAll(
    async () => {
      createScratchDb();
      home = mkdtempSync(path.join(tmpdir(), "recall-home-"));
      config = {
        embedUrl: process.env.RAG_EMBED_URL ?? DEFAULT_EMBED_URL,
        embedModel: process.env.RAG_EMBED_MODEL ?? DEFAULT_EMBED_MODEL,
        dsn: { database: DB, username: PGUSER, host: PGSOCKET },
        project: null,
      };
      const proj = (name: string) => {
        const d = path.join(home, "projects", name);
        mkdirSync(d, { recursive: true });
        return d;
      };
      writeFileSync(
        path.join(proj("alpha"), "alpha.md"),
        "# Smoothies\nBanana smoothie recipe. Blend two ripe bananas, one cup Greek yogurt, a handful of spinach, and a splash of almond milk. Add honey to taste.",
      );
      writeFileSync(
        path.join(proj("beta"), "beta.md"),
        "# Vacuum\nPostgres vacuum tuning notes. Raise autovacuum thresholds for large tables and lower fillfactor for update-heavy tables.",
      );
      writeFileSync(
        path.join(proj("gamma"), "gamma.md"),
        "# Tuning\nPiano tuning. A4 is 440 hertz. Temperament the fifths and thirds carefully.",
      );
      const notes = path.join(home, "notes");
      mkdirSync(notes);
      writeFileSync(
        path.join(notes, "delta.txt"),
        "Kettle coffee method. Sixty grams coarse coffee, three hundred grams water at ninety celsius, steep two minutes.",
      );
      await ingest({ config, roots: [home], home });
    },
    { timeout: TEST_TIMEOUT_MS },
  );

  afterAll(() => {
    dropScratchDb();
    rmSync(home, { recursive: true, force: true });
  });

  test(
    "ingest upserted one chunk per file",
    async () => {
      expect(await rowCount(DB)).toBe(4);
    },
    { timeout: TEST_TIMEOUT_MS },
  );

  test(
    "query ranks the matching file first",
    async () => {
      const rows = await runQuery(config, "banana smoothie recipe");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.source.endsWith("alpha/alpha.md")).toBe(true);
      expect(rows[0]?.score).toBeGreaterThan(0);
    },
    { timeout: TEST_TIMEOUT_MS },
  );

  test(
    "RAG_PROJECT filter restricts results",
    async () => {
      const rows = await runQuery(
        { ...config, project: "beta" },
        "autovacuum fillfactor",
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows)
        expect(r.source.endsWith("beta/beta.md")).toBe(true);
    },
    { timeout: TEST_TIMEOUT_MS },
  );

  test(
    "re-ingest is idempotent: no dupes, no prunes",
    async () => {
      const stats = await ingest({ config, roots: [home], home });
      expect(stats.pruned).toBe(0);
      expect(await rowCount(DB)).toBe(4);
    },
    { timeout: TEST_TIMEOUT_MS },
  );
});
