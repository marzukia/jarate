// Ingest pipeline: collect -> chunk -> hash -> embed -> upsert (+ prune).
// Port of main() from the Python pgrag ingest.

import { createHash } from "node:crypto";
import { chunkText } from "./chunk";
import { collect } from "./collect";
import type { RecallConfig } from "./config";
import { connect, pruneOrphans, upsertChunks } from "./db";
import { embedBatched } from "./embed";

export const INGEST_VERSION = "v1";
const INGEST_EMBED_TIMEOUT_MS = 120_000;

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

  const vecs = await embedBatched(
    {
      url: config.embedUrl,
      model: config.embedModel,
      timeoutMs: INGEST_EMBED_TIMEOUT_MS,
    },
    chunks.map((c) => c.content),
  );
  if (vecs.length !== chunks.length) {
    throw new Error(
      `embed count mismatch: ${vecs.length} vectors for ${chunks.length} chunks`,
    );
  }

  const sql = connect(config.dsn);
  try {
    await upsertChunks(
      sql,
      chunks.map((c, i) => ({
        project: c.project,
        source: c.source,
        content: c.content,
        hash: c.hash,
        embedding: vecs[i] as number[],
      })),
      config.embedModel,
      INGEST_VERSION,
    );
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
