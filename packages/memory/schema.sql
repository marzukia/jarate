-- pgrag schema v2 (per PLAN.md)
-- dim 768 = nomic-embed-text on neon (Ollama, http://10.9.8.7:11434)

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS chunks (
  id            bigserial PRIMARY KEY,
  project       text NOT NULL,          -- derived from source path
  source        text NOT NULL,          -- file path
  content       text NOT NULL,
  content_hash  text NOT NULL,          -- sha256(source || content)
  embedding     vector(768) NOT NULL,
  embed_model   text NOT NULL,          -- e.g. 'nomic-embed-text'
  ingest_version text NOT NULL DEFAULT 'v1',
  tsv           tsvector GENERATED ALWAYS AS
                (to_tsvector('english', content)) STORED,
  updated_at    timestamptz DEFAULT now(),
  UNIQUE (content_hash)
);

CREATE INDEX IF NOT EXISTS chunks_vec ON chunks
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_fts ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_project ON chunks (project);

-- v2 fixes per Frankie's review:
--  1. param p_project (bare 'project' was shadowed by the column)
--  2. websearch_to_tsquery (raw text like !foo can't throw)
--  3. FTS match-before-rank (zero-score rows can't pollute RRF)
CREATE OR REPLACE FUNCTION search(
  q text, qvec vector(768),
  p_project text DEFAULT NULL,
  k int DEFAULT 8
) RETURNS TABLE (id bigint, source text, content text, score real)
LANGUAGE sql STABLE AS $$
  WITH qt AS (SELECT websearch_to_tsquery('english', q) AS w),
       vec AS (
         SELECT id, source, content,
                row_number() OVER (ORDER BY embedding <=> qvec) AS rank
         FROM chunks
         WHERE p_project IS NULL OR project = p_project
       ),
       fts AS (
         SELECT c.id, c.source, c.content,
                row_number() OVER (ORDER BY ts_rank(c.tsv, qt.w) DESC) AS fr
         FROM chunks c, qt
         WHERE (p_project IS NULL OR c.project = p_project)
           AND c.tsv @@ qt.w
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

GRANT EXECUTE ON FUNCTION search(text, vector, text, int) TO frank;
GRANT SELECT, INSERT, UPDATE, DELETE ON chunks TO frank;
GRANT USAGE, SELECT ON SEQUENCE chunks_id_seq TO frank;
