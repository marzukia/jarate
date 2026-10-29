# AGENTS.md — AI agents working in this repo

You are an AI agent making changes in the **jarate** monorepo (pi + piscord
agent stack). Read this before touching anything.

## Layout

- `packages/bridge/` — the Discord bridge, `@jarate/bridge` (TypeScript, bun,
  strict tsc). Source of truth for the bridge; the live boxes run from
  their checkout (symlinks only, no rsync — see `docs/DEPLOY.md`).
- `dispatch/` — the drained dispatch lane (#279): `jarate-bg` launch stub
  (exit 10; the `signal` subcommand stays live until the fleet timer lands)
  and `pi-postcheck.sh` (live; the watchdog left with #280).
- `install.sh` — idempotent installer; `--dry-run` must keep working.
- `docs/` — DISPATCH.md (dispatch pointer), COMMANDS.md, DEPLOY.md, NEW-AGENT.md (fleet onboarding runbook).
- `.githooks/pre-commit` — biome gate; enabled per checkout via repo-local
  git config `core.hooksPath .githooks` (not set by install.sh).

## Commands

```bash
cd packages/bridge && bun install
cd packages/bridge && bun x tsc --noEmit   # must stay clean
cd packages/bridge && bun x bun test       # 1087 pass, 0 fail
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
  2026-10-20): `pi-postcheck` lines, bg-card embeds. Chat one-liners (op status: compacted, restart wake, interrupted,
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

- Any change under `packages/bridge/`: tsc clean + all 1087 tests pass, before
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
   merge. Review runs dispatch to the fleet (jarate-bg is RETIRED -
   hall-monitor #35, 2026-10-20; see the dispatch/jarate-bg stub).
5. Merge only on PASS + green `ci` (biome + bridge jobs).

## Do-not-touch list

- `~/.pi/agent/settings.json` on live boxes (bot tokens)
- `~/.pi/agent/piscord` and deployed `projects/jarate/packages/bridge` checkouts (live checkouts)
- `pi.service` (never restart from within a task)
- `marzukia/piscord` repo (legacy upstream)
- `bun.lock` churn beyond what `bun install` does

## Size gate (harden-repo, 2026-10-20)

- File size is a load-bearing signal, checked by `bun run size` (CI + pre-commit).
  >800 non-blank lines = must be in size-ratchet.json; ratcheted files may only shrink.
  `--update` lowers budgets after a split - never to raise one.
- >2,000-line file: no NEW top-level exports (CI export gate). New code goes to a
  sibling module. Test files: x3 budget.
- Task rule: a change adding code to a >2,000-line file must name the target module,
  not the god file. "Add X to index.ts" is an invalid task.
