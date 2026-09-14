# out — wave 2c: in-session worktrees, ctx watch, run usage, jobs kill/tail, agent-say peers

Branch: `pi-bg/20260914-091714-3097` (base `main` @ 5df82b02, live-frame
unification already in). Five features, all in `packages/bridge` + `bin` +
`dispatch/peers.json`. No live-box changes.

## Where each piece landed

| Piece | Location |
| --- | --- |
| #12 `/new-worktree [ref]` | `packages/bridge/channel/worktree.ts` (new) — `newWorktree()`: git repo check, ticket `YYYYMMDD-HHMMSS-NNNN` (UTC, random 4, same shape as pi-bg run ids), `git worktree add -b pi-bg/<id> $PI_BG_WT_DIR/<repo>/<id> <ref>` (ref default `HEAD`), state in `<cwd>/.tmp/worktree.json`. Owner-only at the command layer. |
| #12 `/merge-worktree [squash]` | `worktree.ts` — `mergeWorktree()`: MERGE_HEAD first (a conflicted merge is finalized via `git commit --no-edit` on retry), else `git merge <branch>` (keep; ff when possible) or `git merge --squash` + `git commit -m "squash-merge <branch>"`. Then `git worktree remove` (uncommitted changes block ONLY the removal, merge is kept + retry), `branch -d`/`-D`, state clear. Merges into the live checkout's CURRENT branch — the bridge never checks out another branch in the live repo. |
| #13 ctx boundary notice | `packages/bridge/channel/ctxwatch.ts` (new) — `observeCtx()`: per-session-file tracker (`ctxWatchers` in index.ts, keyed by session file path), edge-triggered on `floor(pct/10) > lastStep`, upward only, first sample per session = silent baseline. Hooked in the `message_end` handler (after the `ch && agentBusy` guard, before the early-send) → one fenced `[ctx] N% (tok/window)` line per 10% boundary crossed per session. `/reset` = new session file = fresh baseline; `/compact` drop + re-cross below the last announced boundary is silent (once per boundary per session). Lowercase k (local `fmtTokensLC`, does not touch `fmtTokens`). |
| #40 run usage line | `packages/bridge/channel/usage.ts` — `sumRunUsage(messages)` (assistant-only over `agent_end` `event.messages`; no dedup needed in-memory) + `hasUsage()`. `runUsageLine()` in index.ts → `│ ~219.4k tok · ~$0.096` (same pricing as `~/scripts/pi-token-cost.py`, 3-decimal est. cost). `runFrame()` gains an OPTIONAL trailing param, rendered right before the closing `└`, clipped to the 40-col budget — append-only, builder shape unchanged. Done AND failed frames carry it; zero-usage runs get no line. |
| #40 `/usage last` | index.ts `case "usage"` intercepts `last` before `renderUsage`: unfenced (like the rest of the /usage family) `[usage] last run  HH:MM:SS  | 1 turns | in … | est $0.00`. In-memory (`lastRunUsage` box object — biome `noExportLet`), set on `agent_end`; `[!] no completed run yet (run one first)` before the first completed run. `usageLine` label widened to `string`; scope validation now admits `last` (renderUsage itself treats it as session scope — the command layer owns it). |
| #44 `/jobs kill <id>` | `packages/bridge/channel/jobs.ts` — `jobsKill()`: ticket-id regex check, async `runPiBgScript("pi-bg-kill", [id])` (spawn, 20s SIGKILL timeout, 20k char cap, ENOENT → friendly "install.sh link missing"), `[ok] killed <id>` / `[!] <first output line>`, fenced via `jobWrapFence` (sized to the content's backtick runs). Owner-only. |
| #44 `/jobs tail <id> [--n N]` | `jobs.ts` — `jobsTail()`: same runner over `pi-bg-tail <id> <n>`; `formatTail()` keeps the LAST 40 lines, notes `[..] N earlier lines`, hard-wraps at 40 cols, fenced. `--n` parsed in the command layer (clamped [1,200], bad value = usage line). Owner-only (tail reads a dispatch-user file). Bare `/jobs [json]` view unchanged, still open to all. |
| #45 agent-say peer names | `bin/agent-say` — non-numeric `$1` resolved via `jq` against `~/.config/agent-fleet/peers.json`; unknown → `agent-say: unknown peer 'x' (add it to …)` exit 2 (before any curl); numeric targets pass through untouched. `dispatch/peers.json` (new) = repo default roster (monky/frank/jimmy). `install.sh` section 3b: one-time seed = repo default + own channel (name `$USER`, id read from settings.json via jq, file never written); existing file never clobbered; dry-run safe. |

## Tests (all new, all passing)

- `channel/ctxwatch.test.ts` — 7: baseline silence, fire-on-cross, once per
  boundary (jump 39.9→72 fires once at 72, not 4/5/6/7), step-edge fire,
  99.6→"100%", bad samples (NaN/0-window/negative tokens/negative pct)
  ignored without priming, downward silence + once-per-session semantics.
- `channel/worktree.test.ts` — 10: ticket shape (fixed Date), state
  load/missing/corrupted/stale, non-git cwd, create+state, second-new
  refused, stale-allowed, merge keep (commit lands on live branch, worktree
  + branch gone), squash (exactly 1 commit, branch force-deleted),
  uncommitted blocks removal only (merge kept, retry finishes), conflict
  (count + repo named, resolve + retry finalizes), empty-squash cleanup.
- `channel/jobs.test.ts` — 8 new: kill success/unknown-id/no-script/
  timeout, tail success/fence-sizing/backtick-run in output/line cap +
  drop note/40-col wrap.
- `channel/usage.test.ts` — 4 new `sumRunUsage` (mixed roles, non-assistant
  ignored, bad fields clamped, empty) + scope-validation string update.
- `bin/agent-say.test.ts` (new) — 8: numeric passthrough, peer resolve,
  unknown peer exit 2 (no curl), no peers file, non-numeric value, `-`
  stdin form, empty message, missing token.
- `channel/index.test.ts` — 10 new integration (full harness, owner +
  non-owner): matchCommand for all new commands, `runUsageLine` pricing,
  `runFrame` trailing placement/40-col, `message_end` ctx notice end-to-end
  (baseline silent / 41% fire / same-step silent / drop silent / 91% fire,
  fenced), `ctxBoundaryNotice` null-safety, `agent_end` done frame PATCH
  carries the trailing line, `/usage last` empty→populated (unfenced),
  `/jobs kill|tail` owner gating + stub-script round trip + `--n`,
  `/new-worktree`→commit→`/merge-worktree` full cycle (non-owner falls
  through, already-active refused, state file, branch deleted).

## Verification

- `bun x tsc --noEmit` (bridge): clean.
- `bunx biome check .` (repo root): 0 diagnostics (new/modified files only).
- Full monorepo suite (`bun test`: bridge + recall + dispatch + bin):
  731 pass / 0 fail / 7 skip (recall integration skips, unchanged).
  Final gate = 3 sequential full runs, all 731/0. Also ran 41+ full
  suites on this branch across stress loops; 3 sporadic single-test
  failures, every one coinciding with concurrent test load while this
  host's `/tmp` tmpfs sat at 98-100% inodes (tests `mkdtemp` under
  `os.tmpdir()`); 14 full runs on base `main` @ 5df82b02 clean.
  Environmental (inode pressure), not this batch's code — flagged for
  the reviewer: if a single full-suite CI job flakes, re-run it.
- `bash install.sh --dry-run` (fake HOME): clean; seed branch verified
  live against a fake checkout: own-channel override, default-roster
  fallback, no-clobber on re-run.
- `bin/agent-say` smoke-tested against a stub curl: peer name → resolved
  channel id on the wire, unknown peer exit 2, numeric passthrough.

## Notes / decisions

- `runFrame` trailing line: optional 5th param — every existing call site
  unchanged; the failed frame gets it too (spec: done/failed).
- Ctx notice format: `[ctx] 41% (108k/262k)` — rounded pct, lowercase k,
  no tag collision with the kimaki set (`[ctx]` is new, documented in
  COMMANDS.md output-tag table).
- Worktree ticket ids use a random 4-digit suffix (pi-bg uses pid there;
  in-session there is no run process, so pid would mislead).
- `lastRunUsage` + `ctxWatchers` exported as const containers (box pattern
  / Map) for test reset, per biome `noExportLet`.
- Docs: `docs/COMMANDS.md` updated (tag table, reference table, /usage
  last, frame trailing line + [ctx] section, /jobs kill/tail, new
  worktree section, agent-say peers). `HELP_TEXT` + `matchCommand` in
  sync. `docs/DISPATCH.md` untouched (agent-say is not a dispatch
  script; noted in COMMANDS.md instead).
- Do-not-touch list respected: no `bin/jarate` changes, no drift-guard
  sections, no live-box files, `bun.lock` only via `bun install`.
