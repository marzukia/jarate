# AGENTS.md — AI agents working in this repo

You are an AI agent making changes in the **jarate** monorepo (pi + piscord
agent stack). Read this before touching anything.

## Layout

- `packages/bridge/` — the Discord bridge, `@jarate/bridge` (TypeScript, bun,
  strict tsc). Source of truth for the bridge; the live boxes run rsync
  copies of this dir.
- `dispatch/` — `jarate-bg`, `jarate-wait` bash scripts (+ `pi-*` deprecation
  shims; the orchestration machinery).
- `install.sh` — idempotent installer; `--dry-run` must keep working.
- `docs/` — DISPATCH.md (orchestration), COMMANDS.md, DEPLOY.md, NEW-AGENT.md (fleet onboarding runbook).
- `.githooks/pre-commit` — biome gate; `core.hooksPath` is set by install.sh.

## Commands

```bash
cd packages/bridge && bun install
cd packages/bridge && bun x tsc --noEmit   # must stay clean
cd packages/bridge && bun x bun test       # 923 pass, 0 fail
bunx biome check .                 # from repo root; 0 diagnostics
bunx biome check --write .         # fix formatting + safe lints
bash install.sh --dry-run          # installer regression check
```

## Rules

- **Do not touch live boxes:** `~/.pi/agent/settings.json`,
  `~/.pi/agent/piscord`, and the deployed `projects/jarate/packages/bridge`
  checkouts are live deployments, not part of this repo. Never edit,
  restart, or `git config` anything there.
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

- **No emoji in user-facing strings.** Anything posted to Discord uses
  kimaki-style ASCII tags where the scheme applies: `[new]`/`[..]`/`[queued]`
  state, `- ` list items. `[ok]`/`[!]` are MACHINE OUTPUT ONLY (Andryo
  2026-10-20): fenced `/command` replies, `pi-postcheck` lines, bg-card
  embeds. Chat one-liners (op status: compacted, restart wake, interrupted,
  run failure) are plain words - no tag. Queue acks + interrupt
  notifications are SILENT at verbose 0, post at verbose 1+. Full rules:
  `docs/STYLE.md` §3.1. (operator, 2026-09-10; tag scope 2026-10-20)
- Emoji are allowed ONLY where the platform requires them: Discord
  **reactions** (the 👀 inbound ack is a reaction and stays).
- Applies to new code; don't bulk-strip emoji outside your change's scope.
- `marzukia/piscord` (the standalone repo) stays untouched. jarate
  (`packages/bridge/`) is the source of truth; do not re-sync from the old
  repo.

## Test expectations

- Any change under `packages/bridge/`: tsc clean + all 482 tests pass, before
  committing.
- Biome must be clean at the repo root before committing (pre-commit hook
  enforces it; if you bypass git, run `bunx biome check .`).
- Behavior changes in `packages/bridge/` need a test. Format/lint-only changes need
  zero behavior diff — prove it by running the suite.

## PR flow

1. Branch `pi-bg/<id>` or `feature/<name>` from `main`.
2. Commit, push, `gh pr create --base main`
   (GitHub via hall-monitor vault: claim `gh_pat` in a plan; `GH_TOKEN=$gh_pat gh ...` -
   injected for that run only).
3. PR description: what / why / verification (see CONTRIBUTING template).
4. Adversarial reviewer agent verdict `VERDICT: PASS` is required before
   merge. Nohup form (foreground launch is rejected, rc 4, #144):
   `nohup ~/scripts/jarate-bg reviewer "adversarially review <branch/PR> ..." > review.log 2>&1 &`
5. Merge only on PASS + green `ci` (biome + bridge jobs).

## Do-not-touch list

- `~/.pi/agent/settings.json` on live boxes (bot tokens)
- `~/.pi/agent/piscord` and deployed `projects/jarate/packages/bridge` checkouts (live checkouts)
- `pi.service` (never restart from within a task)
- `marzukia/piscord` repo (legacy upstream)
- `bun.lock` churn beyond what `bun install` does
