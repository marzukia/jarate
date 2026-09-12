# recall

Shared project knowledge RAG on Postgres + pgvector. Plan: [PLAN.md](PLAN.md).

TypeScript port (2026-09-10) of the old Python `pgrag` (`packages/memory/`,
removed). Same behavior: same chunking, same embed endpoint, same
upsert/prune semantics, same output shape. **The db `rag` data is unchanged —
no data migration.** The old `uv run ingest.py / query.py` workflow is dead.

- Schema: `schema.sql` (dim 768, nomic-embed-text) — the data contract, kept
  exactly.
- Embeddings: Ollama on neon — `http://localhost:11434/v1/embeddings`
- DB: Postgres 16 on hydrogen, db `rag`, roles `monky` / `frank` (scram,
  127.0.0.1)

## Usage

```bash
# from this package dir (or the box symlink ~/projects/recall)
bun recall ingest ~/memory ~/projects ~/AGENTS.md   # prune on by default
bun recall ingest ~/memory ~/projects ~/AGENTS.md --no-prune

# query (the only canonical query path)
bun recall query "your question"
RAG_PROJECT=memory bun recall query "optional project filter"
```

## Env

| var | default |
|---|---|
| `RAG_DSN` | `host=127.0.0.1 dbname=rag user=monky` (key=value or postgres:// URL) |
| `RAG_EMBED_URL` | `http://localhost:11434/v1/embeddings` |
| `RAG_EMBED_MODEL` | `nomic-embed-text` |
| `RAG_PROJECT` | *(unset = search all projects)* |

Passwords: `.env` file in the cwd / package root (`KEY=VALUE` lines; never
overrides set env vars), the `PGPASSWORD` env var, or `~/.pgpass` (built-in
lookup, `*` wildcards — the box keeps the rag password there). `PG*` env
vars are honored by the driver when `RAG_DSN` leaves a field unset.

## Tests

```bash
bun x tsc --noEmit
bun test          # unit + integration (integration needs Postgres + Ollama;
                  # skips cleanly when either is unreachable)
```

## Rules (see PLAN.md)

- Every caller goes through the `search()` SQL function. No ad-hoc SQL.
- Docs and queries must use the same embed model. Model swap = full re-embed.
- Ingest is idempotent: upsert on sha256(source || content), prune on by default.
