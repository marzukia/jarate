// Ingest pipeline: collect -> chunk -> hash -> embed -> upsert (+ prune).
// Port of main() from the Python pgrag ingest.

import { createHash } from "node:crypto";
import { chunkText } from "./chunk";
import { collect } from "./collect";
import type { RecallConfig } from "./config";
import { connect, pruneOrphans, upsertChunks } from "./db";
import { embedBatched } from "./embed";

export const INGEST_VERSION = "v1";
// Per-batch upsert + a generous timeout: on hydrogen's CPU Ollama a
// 400-word chunk embeds in ~6-10s, so one batch can approach the timeout
// under load; 300s (override JB_RECALL_EMBED_TIMEOUT_MS) keeps a batch
// alive, and per-batch upsert (below) means a later failure still keeps
// the earlier work.
const INGEST_EMBED_TIMEOUT_MS =
  Number(process.env.JB_RECALL_EMBED_TIMEOUT_MS ?? 300_000) || 300_000;

export interface IngestOptions {
  config: RecallConfig;
  roots: string[];
  noPrune?: boolean;
  /** $HOME override for project tagging (defaults to os.homedir()). */
  home?: string;
}

export interface IngestStats {
  files: number;
  chunks: number;
  upserted: number;
  pruned: number | null; // null when --no-prune
}

export async function ingest(opts: IngestOptions): Promise<IngestStats> {
  const { config, roots } = opts;
  const files = collect(roots, opts.home);
  const chunks: Array<{
    project: string;
    source: string;
    content: string;
    hash: string;
  }> = [];
  for (const f of files) {
    for (const c of chunkText(f.content, f.source)) {
      const h = createHash("sha256")
        .update(f.source + c)
        .digest("hex");
      chunks.push({
        project: f.project,
        source: f.source,
        content: c,
        hash: h,
      });
    }
  }
  if (chunks.length === 0) {
    return { files: files.length, chunks: 0, upserted: 0, pruned: null };
  }

  const sql = connect(config.dsn);
  try {
    const vecs = await embedBatched(
      {
        url: config.embedUrl,
        model: config.embedModel,
        timeoutMs: INGEST_EMBED_TIMEOUT_MS,
      },
      chunks.map((c) => c.content),
      (start, batchVecs) =>
        upsertChunks(
          sql,
          chunks.slice(start, start + batchVecs.length).map((c, i) => ({
            project: c.project,
            source: c.source,
            content: c.content,
            hash: c.hash,
            embedding: batchVecs[i] as number[],
          })),
          config.embedModel,
          INGEST_VERSION,
        ),
    );
    if (vecs.length !== chunks.length) {
      throw new Error(
        `embed count mismatch: ${vecs.length} vectors for ${chunks.length} chunks`,
      );
    }
    let pruned: number | null = null;
    if (!opts.noPrune) {
      pruned = await pruneOrphans(
        sql,
        chunks.map((c) => c.hash),
        config.embedModel,
        INGEST_VERSION,
      );
    }
    return {
      files: files.length,
      chunks: chunks.length,
      upserted: chunks.length,
      pruned,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
