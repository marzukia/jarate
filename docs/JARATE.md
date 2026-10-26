# jarate — machine-ops JSON entrypoint (issue #17)

One bash entrypoint, one JSON doc on stdout. Built for LLM consumers:
deterministic shape, stable keys, errors in-band.

```
$ jarate <cmd> [args]     # stdout = exactly one JSON document
```

## Entry contract

- **stdout** is ONE JSON document: `{"ok": true|false, "error": "...", ...}`.
  `error` is always present (string) and `null` on success. No prose, no
  color, no emoji.
- **snake_case** keys, deterministic field order (hand-built, not dict order).
- Missing/unavailable fields are `null` — never dropped, never empty strings.
- Timestamps are ISO-8601 UTC (`2026-09-13T05:00:00Z`).
- Exit codes: `0` ok, `1` helper failed (runtime error — JSON says why),
  `2` usage error (unknown command, unknown flag/arg, missing arg value —
  JSON says why).
- Helpers are **read-only**. Every external call is wrapped in `timeout`
  (default 25s, `JARATE_TIMEOUT_S`), so a hung dependency degrades to an
  `ok:false` field, never a hang.
- No TTY, no prompts, no interactive commands — safe to call from an LLM
  tool, a crontab, or a worker.

Usage / unknown command:

```json
{"ok": false, "ts": "...", "error": "unknown command: bogus", "usage": "jarate <cmd> [args]", "commands": ["setup", "ctx-report", "journal-errors"]}
```

## Commands

### `ctx-report [--profile main|worker]`

Context % of the newest session + lifetime token cost (via
`pi-token-cost --json`). `ok:false` only when BOTH context and cost are
unavailable.

```json
{
  "ok": true, "ts": "...", "error": null,
  "agent": "monky", "home": "/home/monky",
  "profile": "main",
  "context": {
    "session": "/home/monky/.pi/agent/sessions/.../xxx.jsonl",
    "age_s": 42, "tokens": 251000, "limit": 262144,
    "pct": 95, "compact_recommended": true
  },
  "cost": {
    "model": "qwen/qwen3.8-27b", "turns": 20299,
    "input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
    "total_tokens": 0, "usd": 332.36
  },
  "cost_error": null
}
```

- `context.pct` = floor(tokens/limit*100); `compact_recommended` when pct >= 80.
- `context.limit` comes from the `X-Switchboard-Context` header in
  `~/.pi/agent/models.json` (or `JARATE_CTX_LIMIT`).
- `cost` = the first agent block (`agents[0]`) `pi-token-cost --json`
  reports (its JSON is the source of truth; the CLI re-queries OpenRouter
  pricing). A single-home call yields one block, so this is the full cost.
- `pi-token-cost` is a machine-local script: resolved from `JARATE_TOKEN_COST`,
  `~/scripts/pi-token-cost.py`, or `<repo>/scripts/pi-token-cost.py`.

### `journal-errors [--since S] [--agent NAME]`

`pi.service` warnings (journalctl `-p warning`) per agent on this host.
Local-only (2026-10-17): hall-monitor owns the privileged cross-user
read; `$HOME` is read via the user journal. `--since` takes an absolute
datetime only (relative forms like `-1h` are rejected, usage error):
`2026-09-13T00:00:00Z`, `2026-09-13 00:00:00` (the space form is
re-joined), or a bare date. Default: one hour back, absolute UTC.

```json
{
  "ok": true, "ts": "...", "error": null, "since": "2026-09-13T03:00:00Z",
  "agents": [
    {"ok": true, "name": "frank", "source": "local", "count": 1,
     "warnings": ["..."], "truncated": false, "error": null},
    {"ok": false, "name": "monky", "source": "cross-user", "count": null,
     "warnings": null, "truncated": false,
     "error": "cross-user read removed: use a hall-monitor plan (SUDO_PW)"}
  ]
}
```

- Discovery: `$HOME` + every local user with a `/home/<u>` (uid > 900),
  or a `JARATE_AGENT_HOMES` override (colon-separated). No `pi.service`
  unit probe: every home on the list yields a row.
- Rows: for `$HOME`, `source` = `local`; `warnings` capped at 100 lines
  (`truncated` true when cut); row `error` set when the journalctl call
  itself failed (row `warnings` = `null` then). Any other home yields
  `source: "cross-user"`, `ok: false`, `warnings: null`, `count: null`,
  and `error` = "cross-user read removed: use a hall-monitor plan
  (SUDO_PW)".
- Top-level `ok` stays `true` with cross-user rows (the run does not
  fail, rc 0). `ok: false` (rc 1) only when the local journalctl call
  failed; `ok: false` (rc 1) also when no agent matched `--agent`.

Per-project rollup (removed 2026-10-26, operator order 'wave 1',
jarate-hm relocation map): hall-monitor `GET /api/fleet/spend?project=<repo>`
(five-dimension tokens) + `GET /api/fleet/runs`.

## Env overrides (tests + machines)

| Var | Meaning |
| --- | --- |
| `JARATE_TIMEOUT_S` | per-helper timeout, default 25 |
| `JARATE_TOKEN_COST` | explicit path to pi-token-cost.py |
| `JARATE_CTX_LIMIT` | fallback context limit when models.json has none |
| `JARATE_AGENT_HOMES` | colon-separated agent home list (skips auto-discovery) |
| `JARATE_ROOT` | repo root (auto-detected otherwise) |

## Consumers

- **LLM tool**: `packages/bridge/channel/jarate.ts` registers ONE tool,
  `jarate {cmd, args}` — the entrypoint is the single source of truth for
  the JSON shape; the tool spawns `$HOME/bin/jarate` (30s cap, process-group
  kill, 20k output cap) and returns the doc as text.
- **jarate-bg workers** (launch path RETIRED 2026-10-20, hall-monitor #35 -
  fleet is the dispatch): no extensions — they run the same entrypoint via
  plain bash (`~/scripts/jarate`).
- **Deploy**: `install.sh` symlinks `~/bin/jarate` and `~/scripts/jarate`
  into the checkout (idempotent, `--dry-run` clean).
