# Contributing

Changes to jarate land on `main` by pull request. `main` is protected by
branch rule **`protect-main`** (non-fast-forward): direct pushes and
force-push rewrites are rejected; merges must be fast-forward or squash via
PR.

## Branches

- Branch from `main`.
- Names: `pi-bg/<id>` (worker-dispatched work) or `feature/<name>`.
- No force-push to your branch after review has started.
- No direct pushes to `main`.

## Checks (all required, green before review)

```bash
bunx biome check .            # repo root: 0 diagnostics (pre-commit enforces staged files)
cd packages/bridge && bun install
cd packages/bridge && bun x tsc --noEmit
cd packages/bridge && bun x bun test  # 482 pass, 0 fail
bash install.sh --dry-run     # if install.sh changed
```

The pre-commit hook (`.githooks/pre-commit`) runs biome on staged
TS/JS/JSON and fails fast on violations. `install.sh` sets
`core.hooksPath .githooks` on every checkout it syncs. The `ci` workflow
(biome + bridge jobs) re-runs everything on the PR; the branch rule
references context `ci` when the org upgrades to Pro.

## Style (user-facing strings)

**No emoji** in command acks, warnings, or anything posted to Discord —
use kimaki-style ASCII tags: `[!]` warning/error, `[ok]` success,
`[new]`/`[..]`/`[queued]` state, `- ` list items. Emoji only where the
platform requires them (Discord reactions, e.g. the 👀 inbound ack).
See AGENTS.md § Style. (Andryo, 2026-09-10)

## PR description template

```markdown
## What
(one line + short list of changed paths)

## Why
(the problem, the decision, links to threads/issues)

## Verification
- biome: <result>
- tsc: <result>
- tests: <result, e.g. 482 pass / 0 fail>
- install.sh --dry-run: <if touched>
- anything else you ran
```

## Review gate

**Every PR requires an adversarial reviewer agent verdict
(`VERDICT: PASS`) before merge.** Dispatch:

```bash
~/scripts/pi-bg reviewer "Adversarial review of PR <#> / branch <name> in <repo>.
Read the diff vs main. Check: behavior changes, test coverage, install.sh
idempotency, live-box safety (no settings.json/piscord checkout edits, no pi
restarts). End with VERDICT: PASS or VERDICT: FAIL and ranked findings."
```

- Reviewer findings are actionable: one fix round by a worker, then re-review
  or the orchestrator decides. No infinite loops.
- Merge only on `VERDICT: PASS` + green `ci`.
- Humans (Andryo) can override a FAIL; note the override in the PR.
