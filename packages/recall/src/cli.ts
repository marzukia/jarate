// recall CLI: `recall ingest [ROOT ...] [--no-prune]` and `recall query "..."`.
// Same behavior and output as the Python pgrag scripts (ingest.py/query.py).

import os from "node:os";
import path from "node:path";
import { envConfig, loadDotEnvFiles } from "./config";
import { formatResult } from "./format";
import { ingest } from "./ingest";
import { runQuery } from "./query";

export const USAGE = `recall - shared project knowledge RAG (Postgres + pgvector)

Usage:
  recall ingest [ROOT ...] [--no-prune]   # default roots: ~/memory ~/projects
                                           # prune on by default
  recall query "your question" [--json]   # --json: one SearchRow array on stdout

Env:
  RAG_PROJECT     optional filter to one project (query only)
  RAG_DSN         default "host=127.0.0.1 dbname=rag user=monky"
  RAG_EMBED_URL   default "http://localhost:11434/v1/embeddings"
  RAG_EMBED_MODEL default "nomic-embed-text" (must match schema dim 768)`;

export interface IngestArgs {
  roots: string[];
  noPrune: boolean;
}

/** Parse `ingest` args. Defaults match the Python script: ~/memory ~/projects. */
export function parseIngestArgs(
  args: string[],
  home = os.homedir(),
): IngestArgs {
  const roots: string[] = [];
  let noPrune = false;
  for (const a of args) {
    if (a === "--no-prune") {
      noPrune = true;
    } else if (a.startsWith("-") && a.length > 1) {
      throw new Error(`unknown flag: ${a}\n\n${USAGE}`);
    } else {
      roots.push(a);
    }
  }
  if (roots.length === 0) {
    roots.push(path.join(home, "memory"), path.join(home, "projects"));
  }
  return { roots, noPrune };
}

export interface QueryArgs {
  question: string;
  /** Emit a SearchRow JSON array on stdout instead of formatted text. */
  json: boolean;
}

/** Parse `query` args: free words joined into one question, optional --json. */
export function parseQueryArgs(args: string[]): QueryArgs {
  const words: string[] = [];
  let json = false;
  for (const a of args) {
    if (a === "--json") {
      json = true;
    } else if (a.startsWith("-") && a.length > 1) {
      throw new Error(`unknown flag: ${a}\n\n${USAGE}`);
    } else {
      words.push(a);
    }
  }
  const question = words.join(" ");
  if (!question.trim()) throw new Error(USAGE);
  return { question, json };
}

async function cmdIngest(args: string[]): Promise<number> {
  const { roots, noPrune } = parseIngestArgs(args);
  const config = envConfig();
  const stats = await ingest({ config, roots, noPrune });
  if (stats.chunks === 0) {
    process.stderr.write("no chunks found\n");
    return 1;
  }
  console.log(`${stats.files} files -> ${stats.chunks} chunks`);
  if (noPrune) {
    console.log(`upserted ${stats.upserted} (no prune)`);
  } else {
    console.log(`upserted ${stats.upserted}, pruned ${stats.pruned}`);
  }
  return 0;
}

async function cmdQuery(args: string[]): Promise<number> {
  const { question, json } = parseQueryArgs(args);
  const config = envConfig();
  const rows = await runQuery(config, question);
  if (json) {
    console.log(JSON.stringify(rows));
    return 0;
  }
  if (rows.length === 0) {
    console.log("no results");
    return 0;
  }
  for (const row of rows) {
    console.log(formatResult(row));
    console.log();
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  loadDotEnvFiles();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "-h":
    case "--help":
      process.stderr.write(`${USAGE}\n`);
      return cmd ? 0 : 1;
    case "ingest":
      return cmdIngest(rest);
    case "query":
      return cmdQuery(rest);
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}\n`);
      return 1;
  }
}
