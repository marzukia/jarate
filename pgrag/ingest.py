# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx", "psycopg"]
# ///
"""pgrag ingest: walk roots, chunk, embed via Ollama, upsert to Postgres.

Usage:
  uv run ingest.py [ROOT ...]          # default: ~/memory ~/projects
  --no-prune to keep orphans           # prune on by default
"""
import argparse
import hashlib
import os
import re
import sys

import httpx
import psycopg

EMBED_URL = os.environ.get("RAG_EMBED_URL", "http://100.91.94.56:11434/v1/embeddings")
EMBED_MODEL = os.environ.get("RAG_EMBED_MODEL", "nomic-embed-text")
DSN = os.environ.get("RAG_DSN", "host=127.0.0.1 dbname=rag user=monky")
INGEST_VERSION = "v1"

SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__", ".mypy_cache",
             "dist", "build", ".cache", ".pi", ".npm", "stale-20260908",
             ".next", "out", "target", ".turbo", ".parcel-cache"}
SKIP_EXT = {".lock", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
            ".pdf", ".mp3", ".m4a", ".wav", ".zip", ".tar", ".gz", ".ttf",
            ".woff", ".woff2", ".so", ".pyc", ".bin", ".gguf", ".sqlite",
            ".db", ".wasm"}
MAX_BYTES = 1_000_000
CHUNK_WORDS = 400
OVERLAP_WORDS = 50
EMBED_BATCH = 64


def chunk_text(text: str, path: str) -> list[str]:
    """Split on markdown headings (.md only), then window oversized sections."""
    is_md = os.path.splitext(path)[1].lower() in {".md", ".markdown"}
    if is_md:
        parts = re.split(r"(?m)^(?=#{1,6} )", text)
    else:
        parts = [text]
    out = []
    seen = set()
    for sec in parts:
        sec = sec.strip()
        if not sec:
            continue
        words = sec.split()
        if len(words) <= CHUNK_WORDS:
            candidates = [sec]
        else:
            candidates = []
            start = 0
            while start < len(words):
                candidates.append(" ".join(words[start:start + CHUNK_WORDS]))
                start += CHUNK_WORDS - OVERLAP_WORDS
        for c in candidates:
            if c not in seen:
                seen.add(c)
                out.append(c)
    return out


def collect(roots: list[str]) -> list[tuple[str, str, str]]:
    """Yield (project, source, content) for every ingestable file."""
    files = []
    home = os.path.expanduser("~")

    def add(path: str) -> None:
        if os.path.splitext(os.path.basename(path))[1].lower() in SKIP_EXT:
            return
        try:
            if os.path.getsize(path) > MAX_BYTES:
                return
            with open(path, encoding="utf-8") as f:
                content = f.read()
        except (UnicodeDecodeError, OSError):
            return
        if not content.strip():
            return
        rel = os.path.relpath(path, home)
        parts = rel.split(os.sep)
        project = parts[0]
        # ~/projects/<name>/... → tag with the project dir, not "projects"
        if parts[0] == "projects" and len(parts) > 2:
            project = parts[1]
        files.append((project, path, content))

    for root in roots:
        root = os.path.abspath(os.path.expanduser(root))
        if os.path.isfile(root):
            add(root)
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for fn in filenames:
                add(os.path.join(dirpath, fn))
    return files


def embed_batched(client: httpx.Client, texts: list[str]) -> list[list[float]]:
    vecs = []
    for i in range(0, len(texts), EMBED_BATCH):
        batch = texts[i:i + EMBED_BATCH]
        r = client.post(EMBED_URL, json={"model": EMBED_MODEL, "input": batch})
        r.raise_for_status()
        data = r.json()["data"]
        data.sort(key=lambda d: d["index"])
        vecs.extend(d["embedding"] for d in data)
    return vecs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("roots", nargs="*",
                    default=[os.path.expanduser("~/memory"),
                             os.path.expanduser("~/projects")])
    ap.add_argument("--no-prune", action="store_true")
    args = ap.parse_args()

    files = collect(args.roots)
    chunks = []
    for project, source, content in files:
        for c in chunk_text(content, source):
            h = hashlib.sha256((source + c).encode()).hexdigest()
            chunks.append((project, source, c, h))
    if not chunks:
        print("no chunks found", file=sys.stderr)
        return 1

    print(f"{len(files)} files -> {len(chunks)} chunks")
    client = httpx.Client(timeout=120)
    with client:
        vecs = embed_batched(client, [c[2] for c in chunks])

    rows = [(p, s, c, h, v, EMBED_MODEL, INGEST_VERSION)
            for (p, s, c, h), v in zip(chunks, vecs)]
    hashes = [r[3] for r in rows]

    with psycopg.connect(DSN) as conn:
        sql = ("INSERT INTO chunks (project, source, content, content_hash,"
               " embedding, embed_model, ingest_version) VALUES "
               + ",".join("(%s,%s,%s,%s,%s::vector,%s,%s)" for _ in rows)
               + " ON CONFLICT (content_hash) DO UPDATE SET"
               " content = EXCLUDED.content,"
               " embedding = EXCLUDED.embedding,"
               " updated_at = now()")
        conn.execute(sql, [x for r in rows for x in r])
        if not args.no_prune:
            pr = conn.execute(
                "DELETE FROM chunks WHERE embed_model = %s AND"
                " ingest_version = %s AND NOT (content_hash = ANY(%s))",
                (EMBED_MODEL, INGEST_VERSION, hashes),
            )
            conn.commit()
            print(f"upserted {len(rows)}, pruned {pr.rowcount}")
        else:
            conn.commit()
            print(f"upserted {len(rows)} (no prune)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
