# Contributing to {{PROJECT}}

Short rules for human contributors. Agents follow [`AGENTS.md`](AGENTS.md);
this file describes the same loop in prose, so a human PR and an agent PR
look the same shape to a reviewer.

## Flow

1. **Issue first.** Use `.github/ISSUE_TEMPLATE/bug.md` for regressions,
   `feature.md` for new work. Evidence beats prose: paste the log, the
   query output, the screenshot. Fill every section; write "unknown"
   rather than skip.
2. **Branch from fresh `origin/main`.** Name it `pi-bg/<id>` for
   dispatched agent work, `feature/<name>` otherwise.
3. **Keep PRs small.** One issue, one PR. A second issue found
   mid-flight gets its own issue.
4. **Squash-merge only.** `main` stays linear. The lead (or an agent,
   once merge conditions hold) presses merge.

## Tests

- **Regression fixes ship a test that fails before the fix and passes
  after.** Paste both runs in the PR's Evidence section. A fix without a
  red-then-green test is unverified.
- **New features get tests for behaviour, not implementation.**

## Preflight and CI

Before pushing:

```bash
make preflight
```

CI re-runs the same gates. Check status with `gh pr checks <N>` (bare;
`--watch` ties up the terminal). **Never merge red.** Skipped jobs are
fine; a red job is not.

## Review

Every PR gets an independent adversarial review pass before merge,
ending in a verdict: `VERDICT: PASS` or `VERDICT: FAIL` with ranked
findings. A FAIL gets ONE fix round: BLOCKER, HIGH, and MEDIUM
findings get fixed; any deferral is an explicit decision recorded in
the PR. After that round the orchestrator decides — the human operator
can override a FAIL. No infinite fix loops.

## Secrets

No secrets in code, ever. Env vars only. Every new secret needs a row in
`.env.example` and in `docs/SECRETS.md`, in the same PR. `.env` is
gitignored.

## Commits

Conventional commit style: `type: short imperative subject (#N)`. Close
the issue in the PR body (`Closes #N`), not the commit subject — the
squash-merge inherits the PR title.

## Practicalities

- Dev setup: `docs/DEVELOPMENT.md` (cold-clone walkthrough).
- Worktree users: never `git stash`; it is shared across worktrees.
  Commit a WIP checkpoint instead.
- Where to ask: the project channel. Tag the lead for calls only they
  can make.
