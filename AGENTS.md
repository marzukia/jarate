# AGENTS.md — AI agents working in this repo

You are an AI agent making changes in the **jarate** monorepo (pi + piscord
agent stack). Read this before touching anything.

## Layout

- `packages/bridge/` — the Discord bridge, `@jarate/bridge` (TypeScript, bun,
  strict tsc). Source of truth for the bridge; the live boxes run rsync
  copies of this dir.
- `packages/recall/` — `@jarate/recall`, the RAG CLI (`bun recall ingest|query`).
  TS port of the old Python pgrag (removed 2026-09-10); db `rag` unchanged.
- `dispatch/` — `pi-bg`, `pi-wait` bash scripts (the orchestration machinery).
- `bin/agent-say` — agent-to-agent messaging.
- `install.sh` — idempotent installer; `--dry-run` must keep working.
- `docs/` — DISPATCH.md (orchestration), COMMANDS.md, DEPLOY.md.
- `.githooks/pre-commit` — biome gate; `core.hooksPath` is set by install.sh.

## Commands

```bash
cd packages/bridge && bun install
cd packages/bridge && bun x tsc --noEmit   # must stay clean
cd packages/bridge && bun x bun test       # 168 pass, 0 fail
cd packages/recall && bun x tsc --noEmit   # must stay clean
cd packages/recall && bun test             # unit + integration (integration
                                           # skips if Postgres/Ollama unreachable)
bunx biome check .                 # from repo root; 0 diagnostics
bunx biome check --write .         # fix formatting + safe lints
bash install.sh --dry-run          # installer regression check
```

## Rules

- **Do not touch live boxes:** `~/.pi/agent/settings.json`,
  `~/.pi/agent/piscord`, `/home/frank/projects/jarate/packages/bridge` are
  live deployments, not
  part of this repo. Never edit, restart, or `git config` anything there.
  (Reading them for reference is fine.)
- **Never restart `pi.service`** as part of a change. Restart reminders are
  printed by install.sh for humans to act on.
- **No direct pushes to `main`.** `main` has branch rule `protect-main`
  (non-fast-forward). All work goes through a PR on `pi-bg/<id>` or
  `feature/*` — see [CONTRIBUTING.md](CONTRIBUTING.md).
- **Do not force-push** to your PR branch after review has started.
- `install.sh` must stay idempotent and `--dry-run`-clean. Test with a fake
  HOME: `HOME=/tmp/fake bash install.sh --dry-run`.

## Style

- **No emoji in user-facing strings.** Command acks, warnings, error lines,
  and anything posted to Discord use kimaki-style ASCII tags:
  `[!]` warning/error, `[ok]` success, `[new]`/`[..]`/`[queued]` state, `- ` list
  items. Plain words beat decoration. (Andryo, 2026-09-10)
- Emoji are allowed ONLY where the platform requires them: Discord
  **reactions** (the 👀 inbound ack is a reaction and stays).
- Applies to new code; don't bulk-strip emoji outside your change's scope.
- `marzukia/piscord` (the standalone repo) stays untouched. jarate
  (`packages/bridge/`) is the source of truth; do not re-sync from the old
  repo.

## Test expectations

- Any change under `packages/bridge/`: tsc clean + all 168 tests pass, before
  committing.
- Biome must be clean at the repo root before committing (pre-commit hook
  enforces it; if you bypass git, run `bunx biome check .`).
- Behavior changes in `packages/bridge/` need a test. Format/lint-only changes need
  zero behavior diff — prove it by running the suite.

## PR flow

1. Branch `pi-bg/<id>` or `feature/<name>` from `main`.
2. Commit, push, `gh pr create --base main`
   (`GH_TOKEN=$(cat /home/monky/.config/marzukia-pat)`).
3. PR description: what / why / verification (see CONTRIBUTING template).
4. Adversarial reviewer agent verdict `VERDICT: PASS` is required before
   merge: `~/scripts/pi-bg reviewer "adversarially review <branch/PR> ..."`.
5. Merge only on PASS + green `ci` (biome + bridge jobs).

## Do-not-touch list

- `~/.pi/agent/settings.json` on live boxes (bot tokens)
- `/home/monky/.pi/agent/piscord`, `/home/frank/projects/jarate/packages/bridge` (live checkouts)
- `pi.service` (never restart from within a task)
- `marzukia/piscord` repo (legacy upstream)
- `bun.lock` churn beyond what `bun install` does
