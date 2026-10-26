# detpipe — deterministic handoff generator

Zero-LLM context transfer between run continuations (operator order
2026-10-27, via warden; design: `docs/DETERMINISTIC-PIPING.md`).

Pure function of `(session.jsonl, brief, worktree) → (handoff.md,
handoff.json)`. Stdlib only; no LLM calls, no network. The same input
bytes always produce the same output bytes (with a fixed `--at` stamp).

**Placement (ruling 2026-10-27; hall-monitor PR #131, merged 1005ee06):**
the generator's canonical home is hall-monitor
`deploy/fleetwork/detpipe/`. This directory keeps the schema of record
(`docs/DETERMINISTIC-PIPING.md`), the real ticket-555 demo as a test
fixture (`demo/`), and the in-session 80% handover (TS side:
`packages/bridge/channel/handover.ts`, `extractDeterministic`).
`tests/` imports the generator from the canonical home (override with
`DETPIPE_HOME`).

## Triggers

- `context-threshold` — last usage total ≥ 80% of `--window`
- `empty-final` — last assistant message has zero text blocks
- `stop-length` — last assistant message `stopReason=length`, no text
- `rumination` — a 40-char thinking window repeated ≥5× in one block, or
  3+ consecutive turns with ≥8 000 chars of thinking

## Usage

```bash
cd /path/to/hall-monitor/deploy/fleetwork/detpipe   # canonical generator
uv sync
uv run python detpipe.py --session /path/session.jsonl \
  [--brief .fleetwork/brief] [--worktree /path/wt] \
  [--window 131072] [--tail 12] [--tool-calls 10] \
  [--out handoff.md] [--json handoff.json] [--at 2026-10-27T00:00:00Z]
```

## Tests

```bash
cd dispatch/detpipe
uv run pytest   # synthetic triggers + the REAL ticket-555 session
uv run ruff check .
```

## Demo

`demo/handoff-555.md` + `demo/handoff-555.json` — generated from the real
ticket-555 session record (the case study: turn 161,
`stopReason=length`, 58 946-char thinking-only block, usage
input=107 538 / output=16 384 / total=123 922, `g6_reason=empty-final`).

Reproduce (generator from the canonical home; the demo fixture lives here):

```bash
cd /path/to/hall-monitor/deploy/fleetwork/detpipe
uv run python detpipe.py --session /srv/fleetwork/work/555/.fleetwork/session.jsonl \
  --out <jarate>/dispatch/detpipe/demo/handoff-555.md \
  --json <jarate>/dispatch/detpipe/demo/handoff-555.json \
  --at 2026-10-27T00:00:00Z --window 131072
```
