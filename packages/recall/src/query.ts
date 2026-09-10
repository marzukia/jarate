// Query pipeline: embed the question, call search(), return ranked rows.
// Port of main() from the Python pgrag query.

import type { RecallConfig } from "./config";
import { connect, type SearchRow, search } from "./db";
import { embed } from "./embed";

const QUERY_EMBED_TIMEOUT_MS = 60_000;
const QUERY_K = 8;

export async function runQuery(
  config: RecallConfig,
  question: string,
): Promise<SearchRow[]> {
  const qvec = await embed(
    {
      url: config.embedUrl,
      model: config.embedModel,
      timeoutMs: QUERY_EMBED_TIMEOUT_MS,
    },
    question,
  );
  const sql = connect(config.dsn);
  try {
    return await search(sql, question, qvec, config.project, QUERY_K);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
