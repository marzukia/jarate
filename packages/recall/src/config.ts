// Config: env knobs, DSN parsing, .env loading.
//
// Same env contract as the old Python pgrag scripts:
//   RAG_DSN        "host=127.0.0.1 dbname=rag user=monky" (key=value) or
//                  postgres:// URL. Default: the rag db on 127.0.0.1.
//   RAG_EMBED_URL  Ollama OpenAI-compatible embeddings endpoint.
//   RAG_EMBED_MODEL  must match the schema vector dim (768 = nomic-embed-text).
//   RAG_PROJECT    optional per-project filter (query only).
// The postgres driver also honors PG* env vars and ~/.pgpass when a value is
// not pinned here, same as psycopg did.

import { readFileSync } from "node:fs";
import path from "node:path";

export interface DsnOptions {
  /** Hostname/ip, or a unix socket directory (path starting with '/'). */
  host?: string;
  port?: number;
  database: string;
  username?: string;
  password?: string;
}

export interface RecallConfig {
  embedUrl: string;
  embedModel: string;
  dsn: DsnOptions;
  project: string | null;
}

export const DEFAULT_DSN = "host=127.0.0.1 dbname=rag user=monky";
export const DEFAULT_EMBED_URL = "http://localhost:11434/v1/embeddings";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

/** Parse a key=value DSN ("host=... dbname=... user=...") or a postgres:// URL. */
export function parseDsn(dsn: string): DsnOptions {
  if (/^postgres(ql)?:\/\//.test(dsn)) {
    const u = new URL(dsn);
    const out: DsnOptions = {
      host: u.hostname,
      database: u.pathname.replace(/^\//, ""),
    };
    if (u.port) out.port = Number(u.port);
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  }
  const kv: Record<string, string> = {};
  for (const tok of dsn.trim().split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq > 0) kv[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  const database = kv.dbname ?? kv.database;
  if (!database) throw new Error(`DSN has no dbname/database: ${dsn}`);
  const out: DsnOptions = { database };
  if (kv.host) out.host = kv.host;
  if (kv.port) out.port = Number(kv.port);
  if (kv.user ?? kv.username) out.username = kv.user ?? kv.username;
  if (kv.password) out.password = kv.password;
  return out;
}

/**
 * Minimal .env loader (KEY=VALUE lines, # comments). Never overrides an env
 * var that is already set. Same convention the Python scripts used for
 * RAG_DSN / passwords.
 */
export function loadDotEnv(file: string): void {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Load ./.env from the cwd and from the package root. */
export function loadDotEnvFiles(
  cwd = process.cwd(),
  packageRoot?: string,
): void {
  loadDotEnv(path.join(cwd, ".env"));
  loadDotEnv(path.join(packageRoot ?? defaultPackageRoot(), ".env"));
}

export function defaultPackageRoot(): string {
  // src/ -> package root
  return path.resolve(import.meta.dir, "..");
}

/** Build the config from the process env (call loadDotEnvFiles first). */
export function envConfig(): RecallConfig {
  return {
    embedUrl: process.env.RAG_EMBED_URL ?? DEFAULT_EMBED_URL,
    embedModel: process.env.RAG_EMBED_MODEL ?? DEFAULT_EMBED_MODEL,
    dsn: parseDsn(process.env.RAG_DSN ?? DEFAULT_DSN),
    project: process.env.RAG_PROJECT ? process.env.RAG_PROJECT : null,
  };
}
