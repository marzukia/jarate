# detpipe — deterministic handoff generator

Zero-LLM context transfer between run continuations (operator order
2026-10-27, via warden; design: `docs/DETERMINISTIC-PIPING.md`).

Pure function of `(session.jsonl, brief, worktree) → (handoff.md,
handoff.json)`. Stdlib only; no LLM calls, no network. The same input
bytes always produce the same output bytes (with a fixed `--at` stamp).

## Triggers

- `context-threshold` — last usage total ≥ 80% of `--window`
- `empty-final` — last assistant message has zero text blocks
- `stop-length` — last assistant message `stopReason=length`, no text
- `rumination` — a 40-char thinking window repeated ≥5× in one block, or
  3+ consecutive turns with ≥8 000 chars of thinking

## Usage

```bash
cd dispatch/detpipe
uv sync
uv run python detpipe.py --session /path/session.jsonl \
  [--brief .fleetwork/brief] [--worktree /path/wt] \
  [--window 131072] [--tail 12] [--tool-calls 10] \
  [--out handoff.md] [--json handoff.json] [--at 2026-10-27T00:00:00Z]
```

## Tests

```bash
uv run pytest   # synthetic triggers + the REAL ticket-555 session
uv run ruff check .
```

## Demo

`demo/handoff-555.md` + `demo/handoff-555.json` — generated from the real
ticket-555 session record (the case study: turn 161,
`stopReason=length`, 58 946-char thinking-only block, usage
input=107 538 / output=16 384 / total=123 922, `g6_reason=empty-final`).

Reproduce:

```bash
uv run python detpipe.py --session /srv/fleetwork/work/555/.fleetwork/session.jsonl \
  --out demo/handoff-555.md --json demo/handoff-555.json \
  --at 2026-10-27T00:00:00Z --window 131072
```
