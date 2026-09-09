# pgrag setup (from zero)

Runbook for setting up the RAG corpus on a new agent box. Verified
2026-09-09 against marzuki-hydrogen (PostgreSQL 16.13, Ollama on
marzuki-neon). Two gotchas at the end — read them first.

- **Gotcha 1 — model/dim match.** The schema is `vector(768)`. The embed
  model MUST produce 768-dim vectors (`nomic-embed-text` does). Any other
  model means the schema and every existing row must be rebuilt — a full
  re-embed.
- **Gotcha 2 — embed host down = pgrag down.** All queries and ingests
  call the embed URL first. If the Ollama host (default: neon) is
  unreachable, `query.py` / `ingest.py` fail immediately with
  `httpx.ConnectError: [Errno 111] Connection refused` (verified). Postgres
  data is untouched; it recovers when the host is back.

## Live facts (baseline this runbook reproduces)

- Postgres 16, db `rag` owned by the agent role. Role: can-login,
  non-superuser, scram auth, reachable from `127.0.0.1` only. Password
  lives in `~/.pgpass` (`127.0.0.1:5432:rag:<user>:<password>`).
- `pgrag/schema.sql`: `vector` extension; table `chunks`
  (`vector(768)`, tsvector, unique `content_hash`); HNSW cosine index,
  GIN FTS index, btree on `project`; SQL function
  `search(q text, qvec vector(768), p_project text, k int)` —
  reciprocal-rank fusion of vector + FTS.
- Embeddings: Ollama, `http://<ollama-host>:11434/v1/embeddings`, model
  `nomic-embed-text` (137M params, F16, `embedding_length: 768` —
  verified with `curl :11434/api/tags` and a live embeddings call).
- Env knobs (from the script headers; defaults shown):

  | var | default |
  |---|---|
  | `RAG_DSN` | `host=127.0.0.1 dbname=rag user=monky` |
  | `RAG_EMBED_URL` | `http://100.91.94.56:11434/v1/embeddings` |
  | `RAG_EMBED_MODEL` | `nomic-embed-text` |
  | `RAG_PROJECT` | *(unset = search all projects)* |

- `uv run` here is PEP-723: the `# /// script` block in `query.py` /
  `ingest.py` declares `requires-python = ">=3.10"` and
  `dependencies = ["httpx", "psycopg"]`. No venv setup needed.

## A. Database (on the box hosting Postgres, run as postgres)

```bash
# 1. Role: login only, no superuser, scram password
CREATE ROLE <agentuser> LOGIN PASSWORD '<password>';

# 2. Db, owned by the role
CREATE DATABASE rag OWNER <agentuser>;
```

`pg_hba.conf`: ensure a line for this db on loopback only, then
`pg_ctl reload` (or `systemctl reload postgresql`). Loopback-only scram,
e.g.:

```
host    rag    <agentuser>    127.0.0.1/32    scram-sha-256
```

Apply the schema (as the agent role; adjust the two `GRANT ... TO frank`
lines to the new role if it is not `frank`):

```bash
psql "host=127.0.0.1 dbname=rag user=<agentuser>" -f pgrag/schema.sql
```

Store the password for psql/psycopg (the default `RAG_DSN` carries no
password; libpq reads `~/.pgpass`):

```bash
echo "127.0.0.1:5432:rag:<agentuser>:<password>" > ~/.pgpass
chmod 600 ~/.pgpass
```

(Alternative: put `password=<password>` inside `RAG_DSN` and export it —
see F.)

## B. Embeddings

Use an existing Ollama host, or set one up. Check a host:

```bash
curl -s http://<ollama-host>:11434/api/tags | python3 -m json.tool
```

If fresh: install Ollama on that box, then:

```bash
ollama pull nomic-embed-text
```

Point pgrag at it: `RAG_EMBED_URL=http://<ollama-host>:11434/v1/embeddings`.

**Must be a 768-dim model** (gotcha 1). Verify before ingesting anything:

```bash
curl -s http://<ollama-host>:11434/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"nomic-embed-text","input":"hello"}' \
  | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"][0]["embedding"]))'
# expect: 768
```

## C. Tools

```bash
git clone <jarate-url> jarate && cd jarate
uv --version || curl -LsSf https://astral.sh/uv/install.sh | sh
./install.sh            # syncs pgrag/ -> ~/projects/pgrag
```

`install.sh` never touches the database (see DEPLOY.md).

## D. First ingest (as the agent user, from `~/projects/pgrag`)

```bash
uv run ingest.py ~/memory ~/projects ~/AGENTS.md
```

(The script's built-in default is `~/memory ~/projects`; the fleet passes
`~/AGENTS.md` too.) Idempotent; `--no-prune` keeps orphans.

## E. Verify

```bash
cd ~/projects/pgrag
RAG_PROJECT=pgrag uv run query.py "what does search() do"
```

Must print scored rows like:

```
--- 0.0325  /home/monky/projects/pgrag/PLAN.md
### 3. Search (one SQL function)
...
```

Empty db → `no results`. Network error instead → gotcha 2.

## F. Non-default layout (where env vars go)

Any of: `RAG_DSN` (other host/db/role), `RAG_EMBED_URL`,
`RAG_EMBED_MODEL`, plus per-query `RAG_PROJECT`.

- **Interactive shells:** export them in `~/.bashrc` (or `~/.zshrc`).
- **Agent (pi runs as a user service):** env in the unit —
  `systemctl --user edit pi.service`:

  ```ini
  [Service]
  Environment="RAG_EMBED_URL=http://<ollama-host>:11434/v1/embeddings"
  ```

  Then the human restarts `pi.service` (agents do not). Without this, the
  defaults from the script headers apply.
