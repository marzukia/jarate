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
{"ok": false, "ts": "...", "error": "unknown command: bogus", "usage": "jarate <cmd> [args]", "commands": ["setup", "ctx-report", "journal-errors", "memory-grep", "rag", "projects", "projects-backfill", "agents-check", "agents-bless"]}
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
`--since` takes an absolute datetime only (relative forms like `-1h` are
rejected, usage error): `2026-09-13T00:00:00Z`, `2026-09-13 00:00:00`
(the space form is re-joined), or a bare date. Default: one hour back,
absolute UTC.

```json
{
  "ok": true, "ts": "...", "error": null, "since": "2026-09-13T03:00:00Z",
  "agents": [
    {"name": "monky", "source": "local", "count": 1,
     "warnings": ["..."], "truncated": false, "error": null},
    {"name": "frank", "source": "ssh+sudo", "count": 0,
     "warnings": [], "truncated": false, "error": null}
  ]
}
```

- Discovery: self + every local user with a `/home/<u>` (uid > 900), each
  probed for a `pi.service` user unit. Peers are probed through the
  `sshpass + sudo -u` hop (same pattern as pi-bg cross-user reads); a peer
  without the unit is silently skipped.
- Rows: `source` = `local` | `ssh+sudo`; `warnings` capped at 100 lines
  (`truncated` true when cut); row `error` set when the hop itself failed
  (row `warnings` = `null` then).
- `ok:false` when any agent row errored or no agents matched `--agent`.
- Hop env: `JARATE_SSH_HOST` (default `andryo@127.0.0.1`),
  `JARATE_SUDO_PASS` (env, else `~/.config/sudo-pass` 0600 file - never a
  literal in code), `JARATE_AGENT_HOMES` (test
  override: colon-separated home list).

### `memory-grep <query> [--root D] [--regex] [--case]`

Fixed-string (rg `-F`), case-INsensitive search over `~/memory` (default
root) via ripgrep. Top-20 matches kept; `count` is capped at 1000 lines
(`truncated` true when cut). `--` ends flag parsing so dash-leading
queries work.

```json
{
  "ok": true, "ts": "...", "error": null,
  "query": "dispatch", "root": "/home/monky/memory",
  "count": 16, "truncated": false,
  "matches": [{"file": "/home/monky/memory/2026-09-08-x.md", "line": 12, "text": "..."}]
}
```

- `--regex`: query is an ERE (bad regex -> `ok:false`, `rg failed ...`).
- `--case`: case-sensitive. Match order is deterministic (`rg --sort path`).

### `rag <question> [--project P]`

One-call RAG query over project knowledge. Backend = the `recall` CLI
(TS port of pgrag; pgrag itself was removed 2026-09-10), invoked as
`bun <recall-cli> query --json`; `--project P` maps to `RAG_PROJECT`.

```json
{
  "ok": true, "ts": "...", "error": null,
  "backend": "recall",
  "question": "...", "project": "jarate",
  "count": 3,
  "results": [{"source": "/home/monky/memory/x.md", "content": "...", "score": 0.91}]
}
```

- `results` = recall's `SearchRow` array verbatim (may be empty).
- `recall` stderr is captured separately: noise on stderr never fails a
  successful query; on failure the first stderr line lands in `error`.
- Any failure (CLI missing, Postgres/Ollama down, non-array output) is
  `ok:false` — never a crash.

### `projects [--project TAG] [--since YYYY-MM-DD] [--agent NAME]`

Per-project rollup of pi-bg run records (the `--project` tag, see
DISPATCH.md) across every agent home on this host. Read-only. Scans
`<home>/.pi-dispatch/runs/pi-bg-*.json` per agent; peers go through the
same `sshpass + sudo -u` hop as journal-errors (a failing hop degrades that
agent's row with `error` + a top-level `warn` — the doc stays `ok:true`).

```json
{
  "ok": true, "ts": "...", "error": null,
  "since": null, "project": null, "warn": null,
  "projects": [
    {"project": "nestfinder", "runs": 12, "workers": 10, "reviewers": 2,
     "tokens": {"input": 100, "output": 50, "cacheRead": 200, "cacheWrite": 5, "total": 350},
     "cost_usd": 0.12345, "cost_covered": 12,
     "first": "2026-09-01T00:00:00Z", "last": "2026-09-18T00:00:00Z"}
  ],
  "agents": [
    {"agent": "monky", "source": "local", "scanned": 40, "error": null},
    {"agent": "frank", "source": "ssh+sudo", "scanned": null, "error": "cross-user hop failed (...)"}
  ]
}
```

- Buckets: one row per tag; records without `project` land in `unspecified`.
  `--project` filters to one bucket (an unknown tag yields a single
  zeroed-out row, `ok:true` — not an error).
- **Cost null semantics:** `cost_usd` is `null` when ANY contributing record
  lacks a priced `cost_usd` (never a partial sum); `cost_covered` counts how
  many were priced. `tokens` sums per field over contributing records
  (missing -> 0).
- Rows sort by `runs` desc, then `project` asc (deterministic).
- `--since` (shape-validated `YYYY-MM-DD`) drops records with `started`
  earlier than the date (string compare); `--agent` narrows the agent list
  (no match -> `ok:false` rc 1).
- `scanned` = records read; a degraded agent row has `scanned: null` +
  `error` and contributes nothing.

### `projects-backfill [--agent NAME] [--dry-run] [--set RUN=TAG ...]`

Tag the untagged historical records (ones pre-dating `--project`). First
match wins per record:

1. `--set <run>=<tag>` — explicit override (tag validated against the same
   `[a-z0-9][a-z0-9-]{0,31}` rule; multiple `--set` allowed);
2. record `cwd` under `<home>/.pi-bg-wt/<repo>/` -> tag `<repo>`
   (worktree runs — records carry no worktree field, the cwd is the
   source of truth);
3. record `cwd` under `<home>/projects/<name>` -> tag `<name>`;
4. per-agent default: owner `frank` -> `nestfinder`, every other agent ->
   `unspecified`.

Writes `project`, `backfilled: true`, `backfilled_at` (ISO UTC) atomically
(tmp + replace). **Idempotent:** a record that has a `project` is skipped
and never overwritten (even by `--set`). `--dry-run` plans without writing.

```json
{
  "ok": true, "ts": "...", "error": null, "dry_run": true,
  "agents": [
    {"agent": "monky", "source": "local", "scanned": 40, "tagged": 30, "skipped": 10,
     "map": [{"run": "20260910-123456-1", "project": "jarate", "source": "worktree"}],
     "error": null}
  ],
  "total": {"scanned": 40, "tagged": 30, "skipped": 10}
}
```

- `map` lists only the records tagged (or would be, under `--dry-run`),
  with the derivation `source`: `set` | `worktree` | `cwd` | `default`.
- Hop failure degrades the agent row (`scanned/tagged/skipped: null` +
  `error`); `total` counts the agents that answered. Still `ok:true`.
- `--agent` narrows; no match -> `ok:false` rc 1.

### `agents-check`

Drift check for the agent's AGENTS.md — the main profile's law file. Target
resolution: `~/.pi/agent/AGENTS.md` if present, else `~/AGENTS.md` (live
boxes keep the law in `~/AGENTS.md`), else `JARATE_AGENTS_MD` wins over both.
Changes require Andryo's explicit approval (2026-09-14). Compares the live
file's sha256 against the manifest `~/.pi/agent/.agents-md-hash` (one line:
`<sha256>  <UTC ts>  <note>` — fixed path; only `JARATE_AGENTS_MD` moves it,
to the checked file's directory). ALERT-ONLY: the check never reverts and
never blocks — `ok:true` even on drift; `ok:false` only when AGENTS.md
itself is unreadable/missing (rc 1).

```json
{"ok": true, "ts": "...", "error": null,
 "hash": "<sha256 of the live file>",
 "expected": "<manifest hash, null if manifest missing>",
 "drift": true}
```

- `drift:true` = manifest missing OR hash mismatch.
- The pi-bg-watchdog sweep (15 min) is the consumer: one channel warning per
  drifted hash, deduped via `~/.pi/agent/.agents-md-drift-warned`.

### `agents-bless [note]`

Re-bless: rewrite the manifest with the CURRENT AGENTS.md hash + UTC
timestamp + note. This is how an approved change stops the drift alarm.
Note optional (empty -> `-`). `ok:false` rc 1 when AGENTS.md is
unreadable/missing (nothing is written then). Manifest write is atomic
(tmp + mv).

```json
{"ok": true, "ts": "...", "error": null, "hash": "<new sha256>", "note": "andryo approved"}
```

- Both commands honor `JARATE_AGENTS_MD` (default resolution: `~/.pi/agent/AGENTS.md`,
  fallback `~/AGENTS.md`); the manifest stays at `~/.pi/agent/.agents-md-hash`
  unless the override moves it next to the checked file.

## Env overrides (tests + machines)

| Var | Meaning |
| --- | --- |
| `JARATE_TIMEOUT_S` | per-helper timeout, default 25 |
| `JARATE_TOKEN_COST` | explicit path to pi-token-cost.py |
| `JARATE_CTX_LIMIT` | fallback context limit when models.json has none |
| `JARATE_AGENT_HOMES` | colon-separated agent home list (skips auto-discovery) |
| `JARATE_SSH_HOST` / `JARATE_SUDO_PASS` | peer-hop identity / password |
| `JARATE_RECALL_CLI` | explicit path to the recall CLI |
| `JARATE_AGENTS_MD` | explicit AGENTS.md path (else `~/.pi/agent/AGENTS.md`, fallback `~/AGENTS.md`) |
| `JARATE_ROOT` | repo root for the bundled recall (auto-detected otherwise) |

## Consumers

- **LLM tool**: `packages/bridge/channel/jarate.ts` registers ONE tool,
  `jarate {cmd, args}` — the entrypoint is the single source of truth for
  the JSON shape; the tool spawns `$HOME/bin/jarate` (30s cap, process-group
  kill, 20k output cap) and returns the doc as text.
- **pi-bg workers**: no extensions — they run the same entrypoint via plain
  bash (`~/scripts/jarate`).
- **pi-bg-watchdog**: runs `agents-check` every sweep (15 min) as the
  AGENTS.md drift tripwire; see DISPATCH.md.
- **Deploy**: `install.sh` symlinks `~/bin/jarate` and `~/scripts/jarate`
  into the checkout (idempotent, `--dry-run` clean).
