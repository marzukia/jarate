// Embeddings over the OpenAI-compatible /v1/embeddings endpoint (Ollama).
// Port of embed_batched()/embed() from the Python pgrag: results re-sorted
// by `index` so they line up with the input order.
// Batch: on hydrogen's CPU Ollama a 400-word chunk embeds in ~6.5s, so a
// 64-item batch took 163s and a 32-item batch ~208s (120s timeout,
// 2026-09-15). 12 items ~= 78s leaves margin; override with
// JB_RECALL_EMBED_BATCH for fast GPUs.
const EMBED_BATCH = Math.max(
  1,
  Number(process.env.JB_RECALL_EMBED_BATCH ?? 12) || 12,
);

export interface EmbedOpts {
  url: string;
  model: string;
  timeoutMs: number;
}

interface EmbedDatum {
  index: number;
  embedding: number[];
}

interface EmbedResponse {
  data: EmbedDatum[];
}

export async function embedBatched(
  opts: EmbedOpts,
  texts: string[],
): Promise<number[][]> {
  const vecs: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = await fetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model, input: batch }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `embed HTTP ${res.status} from ${opts.url}: ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as EmbedResponse;
    const data = [...json.data].sort((a, b) => a.index - b.index);
    vecs.push(...data.map((d) => d.embedding));
  }
  return vecs;
}

export async function embed(opts: EmbedOpts, text: string): Promise<number[]> {
  const [v] = await embedBatched(opts, [text]);
  if (!v) throw new Error("embed: no embedding returned");
  return v;
}

/** Postgres vector literal: [0.1,0.2,...] */
export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
