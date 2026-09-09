# Plan: Shared Project Knowledge RAG on Postgres

> Canonical location: `pgrag/` in marzukia/jarate (folded in 2026-09-09); the box copy at `~/projects/pgrag` is a synced deployment.

Author: monky, 2026-09-05. For review by Frankie. Status: proposal.

## Goal

One place for shared, project-related knowledge (notes, docs, decisions, code
references) that any tool or agent can query with consistent, hybrid
(full-text + semantic) retrieval. No new services: Postgres + pgvector only.

## Principles

1. **One canonical query path.** Every client calls the same `search()` SQL
   function. No ad-hoc queries from scripts or agents.
2. **Parameters are config, not callsite.** `k`, RRF constant, and filters live
   inside the function with fixed defaults.
3. **One embedding model per index.** Query and docs must use the same model.
   Model is versioned; changing it means a full re-embed, never mixed versions.
4. **Idempotent ingest.** Re-running ingest never duplicates. Upsert keyed on
   content hash.
5. **Deterministic chunking.** Chunker is a pure function of (file bytes,
   chunk size, overlap).

## Components

### 1. Schema (Postgres 16+ with pgvector)

```sql
CREATE EXTENSION vector;

CREATE TABLE chunks (
  id            bigserial PRIMARY KEY,
  project       text NOT NULL,          -- derived from source path
  source        text NOT NULL,          -- file path
  content       text NOT NULL,
  content_hash  text NOT NULL,          -- sha256(source || content)
  embedding     vector(1024) NOT NULL,
  embed_model   text NOT NULL,          -- e.g. 'nomic-embed-text-v1.5'
  ingest_version text NOT NULL DEFAULT 'v1',
  tsv           tsvector GENERATED ALWAYS AS
                (to_tsvector('english', content)) STORED,
  updated_at    timestamptz DEFAULT now(),
  UNIQUE (content_hash)
);

CREATE INDEX chunks_vec ON chunks
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_fts ON chunks USING gin (tsv);
CREATE INDEX chunks_project ON chunks (project);
```

Notes:
- Embedding dimension fixed at 1024 (nomic-embed-text-v1.5 class). If a
  different-dimension model is chosen, the `vector(n)` and function signature
  change in lockstep.
- `UNIQUE (content_hash)` gives idempotent upserts.

### 2. Ingest (one uv script, `~/projects/rag/ingest.py`, ~80 lines)

- Walk configured roots (e.g. `~/projects/**`, `~/memory/**`, `~/research/**`).
- Skip: `.git`, `node_modules`, binaries, lockfiles (skip list in config).
- Chunk: split on markdown headings where present, else ~400-word windows with
  50-word overlap. Deterministic. Cap heading-based chunks: a giant section
  still gets split at the word-window size.
- Embed in batches (e.g. 64) via the local OpenAI-compatible `/v1/embeddings`
  endpoint (Ollama on neon, see embedding model section).
- Upsert on `content_hash`; **prune on by default** (delete hashes no longer
  present, `--no-prune` to disable) — with path-in-hash, a rename otherwise
  orphans the old row.
- No framework. `uv run` + `httpx` + `psycopg`.

### 3. Search (one SQL function)

```sql
CREATE OR REPLACE FUNCTION search(
  q text, qvec vector(1024),
  p_project text DEFAULT NULL,
  k int DEFAULT 8
) RETURNS TABLE (id bigint, source text, content text, score real)
LANGUAGE sql STABLE AS $$
  WITH qt AS (SELECT websearch_to_tsquery('english', q) AS w),
       vec AS (
         SELECT id, source, content,
                row_number() OVER (ORDER BY embedding <=> qvec) AS rank
         FROM chunks
         WHERE project IS NOT DISTINCT FROM p_project
       ),
       fts AS (
         SELECT c.id, c.source, c.content,
                row_number() OVER (ORDER BY ts_rank(qt.w, c.tsv) DESC) AS fr
         FROM chunks c, qt
         WHERE c.project IS NOT DISTINCT FROM p_project
           AND c.tsv @@ qt.w          -- zero-score rows can't pollute RRF
       )
  SELECT COALESCE(v.id, f.id) AS id,
         COALESCE(v.source, f.source) AS source,
         COALESCE(v.content, f.content) AS content,
         COALESCE(1.0/(60 + v.rank), 0) + COALESCE(1.0/(60 + f.fr), 0) AS score
  FROM vec v
  FULL OUTER JOIN fts f USING (id)
  WHERE COALESCE(v.rank, 0) <= k * 3 OR COALESCE(f.fr, 0) <= k * 3
  ORDER BY score DESC
  LIMIT k;
$$;
```

(v2, per Frankie's review:
- param renamed `p_project` — bare `project` collided with the column and the
  filter never worked.
- FTS uses `websearch_to_tsquery` so raw user text like `!foo` or a dangling
  `&` cannot throw; rows that don't match the tsquery are excluded before
  ranking so zero-score rows can't pollute RRF.
- Each branch ranks independently, then a FULL OUTER JOIN + RRF fuse.)

- Hybrid retrieval: HNSW cosine branch + FTS branch, fused with RRF
  (reciprocal rank fusion, constant 60). Each branch pulls top `3k`.
- `p_project IS NULL OR project = p_project` — filter when given, all-projects when
  NULL. (v3 fix: v2's `IS NOT DISTINCT FROM p_project` matched zero rows when the
  param was NULL — found 2026-09-08 in testing.)
- Vector branch naturally returns nothing useful for pure keyword queries and
  FTS covers exact terms; RRF handles the mix without score normalization.

### 4. Query CLI (one uv script, `~/projects/rag/query.py`, ~40 lines)

- `rag-query "text"` → embed query with the same model → call `search()` →
  print top-k with source paths and scores.
- This is the only programmatic door. Agents (monky/frank) and humans both use
  it. A future API is a thin wrapper around the same function.

### 5. Optional later (out of scope for v1)

- Cross-encoder rerank of top-24 before cutting to top-5 (adds one model).
- Thin HTTP API (20-line FastAPI) if a third-party client appears.
- pgvectorscale if we pass ~10M chunks (we will not, soon).

## Embedding model (decision: Ollama on NEON, per Andryo 2026-09-05)

vLLM serves one model per instance — the running hydrogen server has
qwen3.8-27b only, no embed model (verified by Frankie). A 274M-param embed
deploy is CPU-friendly, so: **Ollama on marzuki-neon** (AMD box, 100.91.94.56) —
Andryo's call, over hydrogen. Setup assigned to Frankie 2026-09-05.
Ingest and
query hit Ollama for embeddings, vLLM on hydrogen stays chat-only.

## Rollout

1. (Frankie) Clean up neon, install Ollama, pull `nomic-embed-text`, verify
   `/v1/embeddings` returns 1024-d vectors; endpoint TBA.
2. Create schema on hydrogen Postgres (16.13 confirmed running, pgvector
   0.6.2 available — checked by Frankie).
3. Write `ingest.py` + `query.py`, ingest `~/projects` + `~/memory`.
4. Smoke test: 5 known questions, verify the right source file appears in
   top-k each time. Only then call it working.
5. Document both commands in AGENTS.md so frank and monky share the same path.

## Open items

- ~~Which Postgres instance?~~ → hydrogen (Frankie confirmed PG 16.13 +
  pgvector 0.6.2 there; helium VMs reported gone 2026-09-05).
- Embedding model: Ollama `nomic-embed-text` on neon (decided; Frankie
  installing, endpoint TBA).
- Access: shared DB role with INSERT/SELECT on `chunks` + **EXECUTE on
  `search()`** only (no DDL).

## Review

- 2026-09-05 Frankie: solid, ship after fixes 1–3 (all applied in v2) + embed
  model decision. Agreed on: single query fn, RRF, idempotent upsert,
  re-embed on model change, 5-question smoke test as done bar.
