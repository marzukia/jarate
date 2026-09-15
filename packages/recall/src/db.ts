// Postgres access via the `postgres` driver (postgres.js).
//
// DSN from config: explicit host/port/database/username/password. Values
// left undefined fall back to PG* env vars, and ~/.pgpass is consulted by
// the driver for passwords - same resolution order as psycopg.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import type { DsnOptions } from "./config";

export type Sql = postgres.Sql;

/**
 * Minimal ~/.pgpass lookup (postgres.js has no built-in support, psycopg
 * did via libpq). First matching line wins; `*` matches any field.
 */
export function pgpassLookup(
  host: string,
  port: number,
  database: string,
  username: string,
  file?: string,
): string | undefined {
  const passfile =
    file ?? process.env.PGPASSFILE ?? path.join(os.homedir(), ".pgpass");
  let raw: string;
  try {
    raw = readFileSync(passfile, "utf-8");
  } catch {
    return undefined;
  }
  const eq = (want: string | undefined, have: string) =>
    want === undefined || want === "*" || want === have;
  for (const line of raw.split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [h, p, d, u, ...rest] = t.split(":");
    if (
      h === undefined ||
      p === undefined ||
      d === undefined ||
      u === undefined
    )
      continue;
    if (
      eq(h, host) &&
      eq(p, String(port)) &&
      eq(d, database) &&
      eq(u, username) &&
      rest.length > 0
    ) {
      return rest.join(":");
    }
  }
  return undefined;
}

export function connect(dsn: DsnOptions): Sql {
  // host as a path starting with '/' = unix socket (driver builds
  // <dir>/.s.PGSQL.<port>); undefined host falls back to PG* env vars and
  // the driver's default.
  let password = dsn.password ?? process.env.PGPASSWORD;
  if (!password && dsn.host && !dsn.host.startsWith("/")) {
    password = pgpassLookup(
      dsn.host,
      dsn.port ?? 5432,
      dsn.database,
      dsn.username ?? "",
    );
  }
  return postgres({
    host: dsn.host,
    port: dsn.port,
    database: dsn.database,
    username: dsn.username,
    password,
  });
}

export interface ChunkRow {
  project: string;
  source: string;
  content: string;
  hash: string;
  embedding: number[];
}

/** Multi-row upsert on content_hash. Same semantics as the Python ingest. */
export async function upsertChunks(
  sql: Sql,
  rows: ChunkRow[],
  embedModel: string,
  ingestVersion: string,
): Promise<void> {
  const values: Array<string | number | null> = [];
  const placeholders: string[] = [];
  for (const r of rows) {
    const n = placeholders.length;
    values.push(
      r.project,
      r.source,
      r.content,
      r.hash,
      vecLiteral(r.embedding),
      embedModel,
      ingestVersion,
    );
    placeholders.push(
      `($${n * 7 + 1},$${n * 7 + 2},$${n * 7 + 3},$${n * 7 + 4},$${n * 7 + 5}::vector,$${n * 7 + 6},$${n * 7 + 7})`,
    );
  }
  await sql.unsafe(
    "INSERT INTO chunks (project, source, content, content_hash, embedding, embed_model, ingest_version) VALUES " +
      placeholders.join(",") +
      " ON CONFLICT (content_hash) DO UPDATE SET" +
      " content = EXCLUDED.content," +
      " embedding = EXCLUDED.embedding," +
      " updated_at = now()",
    values,
  );
}

/** Delete rows of this model+version whose hash is no longer present. */
export async function pruneOrphans(
  sql: Sql,
  hashes: string[],
  sources: string[],
  embedModel: string,
  ingestVersion: string,
): Promise<number> {
  // Scoped to this run's source files: a partial ingest (one docs dir)
  // must not delete other projects' chunks (2026-09-15: the table-wide
  // version would have nuked 1345 foreign chunks on a 45-chunk run).
  const res = await sql.unsafe(
    "DELETE FROM chunks WHERE embed_model = $1 AND ingest_version = $2 AND source = ANY($3) AND NOT (content_hash = ANY($4))",
    [embedModel, ingestVersion, sources, hashes] as Array<
      string | string[] | null
    >,
  );
  return res.length;
}

/** The one canonical query path: the search() SQL function. */
export interface SearchRow {
  source: string;
  content: string;
  score: number;
}

export async function search(
  sql: Sql,
  question: string,
  qvec: number[],
  project: string | null,
  k = 8,
): Promise<SearchRow[]> {
  const res = await sql.unsafe(
    "SELECT source, content, score FROM search($1, $2::vector, $3, $4)",
    [question, vecLiteral(qvec), project, k],
  );
  return res.map((r) => ({
    source: String(r.source),
    content: String(r.content),
    score: Number(r.score),
  }));
}

function vecLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
