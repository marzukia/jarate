# pgrag

Shared project knowledge RAG on Postgres + pgvector. Plan: [PLAN.md](PLAN.md).

- Schema: `schema.sql` (dim 768, nomic-embed-text)
- Embeddings: Ollama on neon — `http://10.9.8.7:11434/v1/embeddings`
- DB: Postgres 16 on hydrogen, db `rag`, roles `monky` / `frank` (scram, 127.0.0.1)

## Usage

```bash
# ingest (prune on by default; pass --no-prune to keep orphans)
uv run ingest.py ~/memory ~/projects ~/AGENTS.md

# query (the only canonical query path)
uv run query.py "your question"
RAG_PROJECT=memory uv run query.py "optional project filter"
```

## Rules (see PLAN.md)

- Every caller goes through the `search()` SQL function. No ad-hoc SQL.
- Docs and queries must use the same embed model. Model swap = full re-embed.
- Ingest is idempotent: upsert on sha256(source || content), prune on by default.
