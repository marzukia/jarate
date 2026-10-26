# Adversarial review — marzukia/jarate PR #296 (fix/worktree-add-retry)

- **Head:** 7da60ee3771d2d4f9825b7515c45b9a5418063e9 (re-verified at start: `gh pr view 296 --json state,headRefOid` → state=OPEN, headRefOid=7da60ee377, baseRefOid=0dd4cb6b83, mergeable=MERGEABLE)
- **Base:** main 0dd4cb6b83
- **Reviewer:** fresh session, no authoring context (franktropic)
- **Date:** 2026-10-27

## Verdict summary

**B=0, M=0, m=1, n=2** → **PASS**

| # | Severity | Finding |
|---|----------|---------|
| 1 | m | Gate claim "1147 pass" does not match observed 1088 pass; observed count is exactly the repo-documented baseline (1087, AGENTS.md) + 1 new test. Substantive gate (0 fail) satisfied. Claim is inaccurate, code is not. |
| 2 | n | Task states assigned email stabbish@gmail.com "already global"; actual global identity is franktropic / franky@ag.mrzk.io. Committed with the actual global identity per "do not change". |
| 3 | n | `origin/main` in the review checkout is a stale remote-tracking ref (d8e33577, an ancestor of the PR base). Size gate still passes; both changed files are small (246 / 313 non-blank lines) and not ratcheted, so the outcome is base-independent. |

## Check 1 — git() raw stderr; [!] carries last stderr line; [ok] byte-unchanged

**PASS.**

- `git()` (worktree.ts:91) now returns `{ code, out, stderr }`. Failure path: `stderr: String(err.stderr ?? "").trimEnd()` — raw stderr, not the merged output. Success path: `stderr: ""`.
- `[!]` line (worktree.ts:175): `` `[!] worktree add failed: ${lastLine(add.stderr) || firstLine(add.out) || `ref ${from}`}` `` — `lastLine` (worktree.ts:123) returns the last non-blank line, where git puts `fatal:`.
- Fallback chain is sane: empty/all-blank stderr → `lastLine` returns `""` → `firstLine(add.out)` (first non-blank line of merged stdout+stderr, as before) → `ref ${from}` (as before).
- `[ok]` line byte-identical: base (line 151) and head (line 190) are both `` `[ok] worktree ${wtPath} (branch ${branch}, from ${from})` ``.
- No leak beyond the intended line: `git()` is module-private (not in the export list); the new `stderr` field is consumed exactly once (line 175); all other call sites use `code`/`out` and ignore the additive field. The `[!]` format change is confined to the single second-failure return.

## Check 2 — exactly one automatic retry, 250ms bounded backoff

**PASS.**

- worktree.ts:168-176: `let add = git(...)`; `if (add.code !== 0) { sleepSync(RETRY_BACKOFF_MS); add = git(...); if (add.code !== 0) return [!]; }` — a single `if`, no loop. Success path (first call code 0) skips the block entirely: no retry, no sleep.
- Backoff: `RETRY_BACKOFF_MS = 250`; `sleepSync` = `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)` — synchronous, bounded at 250ms.
- On second failure the `[!]` line (with the `fatal:` last-stderr line) is returned — real failures fail exactly as before, plus the format fix. A non-transient failure costs one extra git call + 250ms; acceptable.

## Check 3 — PATH-shim test: retry, 2 attempts, cleanup; 5/5 local runs

**PASS.**

- Shim (worktree.test.ts:180-227): fake `git` intercepts only `$1=worktree && $2=add`; first call increments the count file, prints `Preparing worktree ...` + `fatal: could not lock the worktree (transient)` to stderr, exits 1; second call falls through to `exec "$REAL_GIT" "$@"`. `newWorktree`'s only matching git call is `worktree add` (the `rev-parse` preflight is not intercepted), so the count file must read exactly "2" for the assertion to hold.
- Assertions: `[ok]` via retry (`/^\[ok\] worktree /`), exactly 2 attempts (`countFile === "2"`), valid recorded worktree (`loadWorktreeState` non-null + `base.txt` exists in the worktree path).
- Cleanup: `try/finally` restores `process.env.PATH` and deletes `REAL_GIT`/`SHIM_COUNT_FILE`; shim dir + count file live under `tmp`, removed by `afterEach` `fs.rmSync(tmp, { recursive: true, force: true })`. The test's `env` object is not what `git()` sees (execFileSync inherits `process.env`), and the test correctly sets the shim env vars on `process.env` directly.
- Local runs: **5/5 pass** (each ~280ms wall — consistent with the 250ms backoff; no flake observed):
  ```
  run 1: 1 pass 0 fail [280.22ms]
  run 2: 1 pass 0 fail [279.88ms]
  run 3: 1 pass 0 fail [280.39ms]
  run 4: 1 pass 0 fail [279.93ms]
  run 5: 1 pass 0 fail [279.48ms]
  ```

## Check 4 — gates on fresh checkout at 7da60ee377

**PASS** (with m-1 on the pass-count claim).

| Gate | Result |
|------|--------|
| `bun install --frozen-lockfile` | OK — 144 packages, 523ms; `git status` clean afterwards (no lockfile churn) |
| `bun x tsc --noEmit` | exit 0, no diagnostics |
| Full bridge suite `bun test` | **1088 pass / 0 fail** (4049 expect() calls, 26 files, 27.3s). Claim was 1147 — see m-1: AGENTS.md documents the baseline as 1087, the diff adds exactly 1 test, 1087+1=1088. 0 fail is the substantive gate. |
| `bunx biome check .` | exit 0 — "Checked 70 files. No fixes applied." |
| `bun run size -- --base origin/main` | exit 0 — "SIZE GATE: OK (8 ratcheted)" (see n-3 re: stale origin/main) |

PR CI (no wait, observed only): run 40368576164 — `biome` SUCCESS, `bridge` SUCCESS (2026-10-26).

## Check 5 — scope

**PASS.**

- `git diff --stat 0dd4cb6b83 7da60ee377`: exactly 2 files — `packages/bridge/channel/worktree.ts` (+38/-5) and `packages/bridge/channel/worktree.test.ts` (+48). Single commit 7da60ee3.
- No `bun.lock` churn (frozen install left the tree clean).
- No behavior change outside the worktree-add path: `git()` signature change is additive (private function); `[ok]` byte-identical; `[!]` format change only on the second-failure return; `sleepSync`/`lastLine`/`RETRY_BACKOFF_MS` are new module-private symbols.

## Notes

- **n-2 (identity):** global git identity is franktropic / franky@ag.mrzk.io; the task text said stabbish@gmail.com. Per "already global, do not change", the commit uses the actual global identity (via per-invocation `-c`, config files untouched).
- **n-3:** `refs/remotes/origin/main` in this checkout = d8e33577 (2026-10-17, ancestor of the PR base); the size gate passed against it and the outcome is base-independent for this diff.

## Verdict

All five checks pass with evidence; one minor discrepancy (pass-count claim), two notes. No blockers.

VERDICT: PASS
