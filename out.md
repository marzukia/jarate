# out — project-tags: `--project` cost itemisation + `jarate projects` rollups

Branch: `pi-bg/20260918-140425-2653975` (base `main`). Spec:
`~/projects/project-tags-plan.md`. One feature, four pieces: pi-bg tag +
cost capture, jarate cross-agent rollup, jarate historical backfill, docs.
No live-box changes, no vLLM, no install run.

## Where each piece landed

| Piece | File | What |
|---|---|---|
| `--project <tag>` flag | `dispatch/pi-bg` | Fork-free arg-parse zone (case), rc 2 usage errors (missing value / bad tag / duplicate), tag stored in the run record as `"project": tag \| null` |
| Cost capture | `dispatch/pi-bg` | New `bg_capture_cost` + shared `bg_session_file`: session token sum, OpenRouter-list pricing (`qwen/qwen3.8-27b`, exact then pi-token-cost.py fuzzy plain fallback), 24h price cache in `$PI_BG_TMPDIR/pi-bg-price-cache.json` (tmpdir ROOT, shared), bounded `curl --max-time` (`PI_BG_PRICING_URL` / `PI_BG_PRICING_TIMEOUT`, `JARATE_TOKEN_COST_PRICING_OFFLINE=1` = offline). Writes `tokens`, `cost_usd`, `model`, `price_ts` (+`price_error`: `offline` \| `fetch failed` \| `parse failed` \| `model not found`) to the record. Called from `bg_mark_record` (terminal paths, idempotent) and in the main flow before the webhook build (normal path) — the callback always carries the real cost. Never blocks or fails the run. |
| Callback line | `dispatch/pi-bg` | `bg_build` gains `BG_PJ_TAG` / `BG_PJ_COST`; frame gets ONE line — `│ pj <tag> · $<cost 2dp>` (or `$-`) — appended LAST (right before `└`), clipped to the 40-col budget, so the ~1.8k truncation eats the tail, never the identity header |
| `jarate projects` | `bin/jarate` | Cross-agent rollup of run records by tag. Single-quote-free base64 Python scanner (`PROJ_SCAN`) per agent; local home runs direct, peers via the existing `sshpass + sudo -u` hop (`jarate_scan`). Hop failure degrades the agent row (`scanned: null` + `error`) with a top-level `warn`; doc stays `ok:true`. Buckets: `runs` / `workers` / `reviewers` / per-field `tokens` / `cost_usd` / `cost_covered` / `first` / `last`. Untagged records -> `unspecified` bucket. **Cost null semantics:** `cost_usd` null if ANY contributing record is unpriced (never a partial sum); `cost_covered` = priced count. `--project` (unknown tag = one zeroed row, not an error), `--since YYYY-MM-DD` (shape-validated, string compare on `started`), `--agent` (no match = ok:false rc 1). Rows sort runs desc, project asc. |
| `jarate projects-backfill` | `bin/jarate` | Tags untagged historical records. First match wins: `--set RUN=TAG` (validated, repeatable) > record `cwd` under `<home>/.pi-bg-wt/<repo>/` -> `<repo>` (source `worktree`) > `cwd` under `<home>/projects/<name>` -> `<name>` (source `cwd`) > per-agent default: owner `frank` -> `nestfinder`, else `unspecified` (source `default`). Writes `project` + `backfilled: true` + `backfilled_at` atomically (tmp + replace); **idempotent** — a record with a `project` is skipped, never overwritten. `--dry-run` plans without writing. `agents[].map` lists tagged (or would-be) records with their source; `total` sums the agents that answered. |
| Tests | `dispatch/pi-bg.test.ts`, `bin/jarate.test.ts` | +8 pi-bg (tag storage, 3 usage errors, cost capture + cache write, webhook embed line + 40-col check, offline, no-session, fresh-cache + failing curl, stale-cache + failing curl) and +13 jarate (rollup incl. null semantics + sort, filters, unknown tag, since, agent, hop-fail degrade, empty, usage errors, dry-run, real + idempotency, --set, frank default via hop, backfill hop-fail, --set validation). Hermetic: stubbed `curl` (canned pricing URL, real curl passthrough for the webhook), stubbed `pi` writing the session file at run time (mtime must beat `-newermt @run_start`), `sshpass` stub that extracts the sudo-hop driver and execs it locally with `PI_HOME` selecting the peer fixture home. Updated the help-doc `commands` assertion + the shared missing-flag-value table. |
| Docs | `docs/DISPATCH.md`, `docs/JARATE.md`, `bin/jarate` header | DISPATCH: usage line, new "Project tags" section (flag rule, record fields, pricing/cache/offline, never-blocks rule, callback line position), callback embed description updated. JARATE: both command sections with output shapes + null semantics + backfill rule order + idempotency; unknown-command `commands` example refreshed (was missing `setup` too). `bin/jarate` header usage + `COMMANDS` array + dispatch cases + unknown-command list updated. |

## Verification

- `bun test` (repo root, 34 files): **922 pass, 7 skip, 0 fail** (2026-09-18 run; bridge + recall deps `bun install`ed in the fresh worktree first).
- `bunx biome check .`: **0 errors** — 1 warning + 1 info remain, both pre-existing on `main` (baseline verified: main reports the identical 1+1).
- `bun x tsc --noEmit`: clean in `packages/bridge` and `packages/recall` (the repo's tsc gates; no root tsconfig — `dispatch/` / `bin/` test files are bun-transpiled only, same as before).
- `bash -n dispatch/pi-bg` + `bash -n bin/jarate`: clean.
- `HOME=/tmp/fake bash install.sh --dry-run`: rc 0, clean.
- Full-suite flake note: `#41 ... at cap: next dispatch refused` failed ONE full-suite run (15.5s records-waitTimeout); passes solo on this branch (1.08s), under sibling-file load (3/3), and on later full-suite runs. It is fleet-activity-sensitive by design (counts live `pi-bg` processes system-wide; 7 were live from other agents during the failed window). Not a regression: main's solo/sibling runs behave identically.

## Spec deviations

1. **Callback line prefix is `│`, not `├`** — spec-literal `│ pj <tag> · $<cost>`. In the jarate frame grammar (STYLE.md) `│` = continuation of the previous field line, which reads correctly: the project line follows the `cwd`/`branch` meta line. Placed LAST so truncation is tail-only.
2. **Backfill "worktree" rule derives from record `cwd`** — real records carry no `worktree` field (verified across 120 live records: fields = run/profile/cwd/started/delivery/state/finished). `cwd` under `~/.pi-bg-wt/<repo>/<id>` is the source of truth; documented in JARATE.md.
3. **`--since` is shape-validated only** (`YYYY-MM-DD`, same convention as `journal-errors --since`'s `since_is_abs`) — `2026-13-99` is accepted and filters via string compare. Semantic date validation would be a journal-errors-level change, out of scope.
4. **Price cache lives in the tmpdir ROOT** (`$PI_BG_TMPDIR/pi-bg-price-cache.json`), not the per-run subdir — the cache must be shared across runs to be a cache; it is a single small JSON file, no per-run cleanup needed (the 24h freshness check handles staleness).

## Commit

Single commit on `pi-bg/20260918-140425-2653975`: 7 files — the 6 code/doc
files above + this report (+1632 / -39 across the code/docs). No `bun.lock`
churn (fresh-worktree `bun install` resolved identical versions).
