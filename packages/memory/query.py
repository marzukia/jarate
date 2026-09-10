# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx", "psycopg"]
# ///
"""pgrag query: embed query with the same model, call search(), print top-k.

Usage:
  uv run query.py "your question"
Env:
  RAG_PROJECT  optional filter to one project
"""
import os
import sys

import httpx
import psycopg

EMBED_URL = os.environ.get("RAG_EMBED_URL", "http://10.9.8.7:11434/v1/embeddings")
EMBED_MODEL = os.environ.get("RAG_EMBED_MODEL", "nomic-embed-text")
DSN = os.environ.get("RAG_DSN", "host=127.0.0.1 dbname=rag user=monky")


def embed(client: httpx.Client, text: str) -> list[float]:
    r = client.post(EMBED_URL, json={"model": EMBED_MODEL, "input": text})
    r.raise_for_status()
    return r.json()["data"][0]["embedding"]


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 1
    q = " ".join(sys.argv[1:])
    project = os.environ.get("RAG_PROJECT")

    with httpx.Client(timeout=60) as client:
        qvec = embed(client, q)

    with psycopg.connect(DSN) as conn:
        rows = conn.execute(
            "SELECT source, content, score FROM search(%s, %s::vector, %s, 8)",
            (q, qvec, project),
        ).fetchall()

    if not rows:
        print("no results")
        return 0
    for source, content, score in rows:
        print(f"--- {score:.4f}  {source}")
        print(content[:300].strip())
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
