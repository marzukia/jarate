# REPORT — jarate post-drain stale-string bundle (#279 follow-up)

Worker run 2026-10-28 (reactivated by operator order "Get on the jarate waves
now"; bundle defined 2026-10-24: N1 watchdog cancel hint + t242 DISPATCH.md
banner). Base: main `e517c322`. Branch: `ja-stale-strings-bundle`.

## Named items (both verified ALREADY FIXED on main)

### N1 — watchdog STALLED digest cancel hint

- **Fixing commit: `5dfbe629`** ("split #280/N1a: STALLED digest points at the
  live cancel path", 2026-10-24, monkytheluffy). Merged via `d1895d36`
  ("split #280: retire the jarate-bg-watchdog (3-slice centralise +
  N1a/N1b) (#290)").
- Evidence: `git show 5dfbe629` — `dispatch/jarate-bg-watchdog`
  `-lines.append("jarate-bg-kill <t> to cancel")` →
  `+lines.append("jarate-bg signal KILL <t> to cancel")`; the pinned test
  (`dispatch/jarate-bg-watchdog.test.ts`) now expects
  `jarate-bg signal KILL`. Commit message: "Banked N1 (issue #280): the
  STALLED digest line still posted 'jarate-bg-kill <t> to cancel' —
  jarate-bg-kill was removed in #283/#286 (drain)… The live cancel path is
  the retained signal subcommand of the jarate-bg stub: jarate-bg signal
  KILL <t>."
- Corroboration: CHANGELOG.md 2026-10-24 entry "N1a — banked STALLED digest
  fix" (line 35) records the same fix "before the section left" (the
  watchdog file itself left with `274801fc` / `d1895d36`, #280/3c).
- Residual check: `git log -S 'jarate-bg-kill <t> to cancel'` → the string
  no longer exists in any live file on main (only history + CHANGELOG).

### t242 nit1 — stale docs/DISPATCH.md:4-7 banner

- **Fixing commits: `293c0722`** ("refactor(dispatch): gut pi-bg dispatch
  path - fleet is the dispatch (hall-monitor #35) (#272)", 2026-10-20)
  introduced the retirement note and replaced the stale banner;
  **`d1895d36`** (#290) completed the wording with "drain declared
  2026-10-23, #279".
- Evidence: before `293c0722`, docs/DISPATCH.md lines 3-7 listed
  `dispatch/jarate-bg` / `jarate-wait` / `jarate-bg-tail` /
  `jarate-bg-kill` as live components ("Components (all in this repo)").
  On main, lines 2-8 carry the retirement note: "Retirement note
  (hall-monitor #35, 2026-10-20; drain declared 2026-10-23, #279):
  `jarate-bg`'s launch path is RETIRED (stub, rc 10). New dispatches go to
  hall-monitor fleetwork…". `git log -S 'Retirement note' -- docs/DISPATCH.md`
  → `293c0722`; `git log -S 'drain declared' -- docs/DISPATCH.md` →
  `d1895d36`.

## Residual sweep (live docs; CHANGELOG.md, issues/*, dispatch/jarate-bg
internal comments untouched per bundle scope)

### FIXED

1. **packages/bridge/README.md:147** — `/jobs` (recent pi-bg run history) →
   now mirrors docs/COMMANDS.md:79: "history-only scan of the
   `~/.pi-bg-art` artifacts; post-#279 drain: the `jarate-bg` launcher is a
   stub, rc 10; new work goes to hall-monitor dispatch". Verified stale:
   `packages/bridge/channel/jobs.ts:1` — "history-only since the drain,
   #279"; the in-flight ps view + kill/tail wrappers were removed with the
   completion side.
2. **packages/bridge/README.md:174** (file tree) — `jobs.ts /jobs dispatch
   scan + history` → `jobs.ts /jobs history-only artifact scan` (the
   "dispatch scan" = the removed in-flight ps view).
3. **packages/bridge/skills/channel/SKILL.md:32** — same stale `/jobs`
   (recent pi-bg run history) wording as #1; fixed identically.

### KEPT (verified live)

4. **README.md:117-118** — architecture diagram "terminal callback (embed
   author `pi-bg fleetwork` · <state>)". Grep `packages/bridge` +
   `dispatch/` for `pi-bg fleetwork`:
   - `packages/bridge/channel/fleet-run.ts:10` (live bridge module): "Run
     events flow through the fleetwork wrapper ([bg: fleetwork] <ticket>
     lines -> `pi-bg fleetwork` machine-wake cards…)" — the wrapper still
     emits the card.
   - `dispatch/jarate-bg:12,282` (live stub, stderr notice): "terminal:
     state returns as a `pi-bg fleetwork` machine-wake card (… the wake
     rides webhook_id + the Author: pi-bg marker)".
   - `dispatch/jarate-bg.test.ts:113` pins the string in the stub notice.
   - The `Author: pi-bg <name> · <state>` embed shape is live across the
     bridge test suite (e.g. `Author: pi-bg worker · r44`,
     `Author: pi-bg restart-wake · planned`).
   Producer still emits the author string → line kept.

### Not stale (checked, no change)

- `packages/bridge/channel/commands.ts:292` /help string "/jobs - recent
  pi-bg run history (json for JSON)" — code, not docs; still an accurate
  description of the view (history of recent pi-bg runs); the section
  comment (commands.ts:149-152) already carries "History-only since the
  drain (#279)". Left untouched (docs-only change).
- `jarate-bg-kill` / `jarate-bg-tail` / `jarate-wait` mentions in
  docs/COMMANDS.md:356, docs/DEPLOY.md:40-41, docs/DISPATCH.md:17,35,37,41,
  docs/SETUP.md:118 — all accurate "removed/retired" references, not live
  descriptions.
- Branch naming `pi-bg/<id>` (README.md:143, AGENTS.md:40,74,
  CONTRIBUTING.md:11, templates/newrepo/*) — LIVE convention (PRs #271/#273
  used `pi-bg/<ticket>` branches); left untouched per bundle scope.

## Gates (repo root, 2026-10-28)

- `bun run test:all` (bun test, bridge + dispatch + bin + deploy): **bridge
  1096 pass / 0 fail** (30 files, 26.85s); dispatch 26 pass / 0 fail; bin
  30 pass / 0 fail; deploy 6 pass / 0 fail. No `(fail)` lines.
- `bun run typecheck` (= `cd packages/bridge && bun x tsc --noEmit`, the
  script CONTRIBUTING names): clean, rc 0.
- `bunx biome check .`: "Checked 80 files in 1041ms. No fixes applied." —
  0 diagnostics.
- `bun scripts/size-ratchet.ts --base origin/main`: "SIZE GATE: OK
  (9 ratcheted)", rc 0.
- `bun install` (packages/bridge) needed for tsc; `bun.lock` unchanged
  (git status clean after install).

## PR

- Branch `ja-stale-strings-bundle` pushed to origin (bare mirror
  /srv/fleetwork/jarate.git) and github (marzukia/jarate).
- PR URL: https://github.com/marzukia/jarate/pull/301

---

# REPORT — issue #258: factor durableStore + shared atomic write

## Change summary

The durable-store extraction (scope 1) had already landed in main via #276
(commit 42851c77): `channel/durable-store.ts` holds the shared
load/save/orphan-sweep/id-gen/lifecycle, and `channel/sleep.ts` +
`channel/tasks.ts` are thin domain layers on top. This run closes the
atomic-write half (scope 2) of the issue:

- **`channel/durable-store.ts`** — new shared primitives, stdlib-only:
  - `atomicTmpName(target)` — the ONE tmp naming scheme:
    `<target>.<pid>.<ts>.tmp`;
  - `atomicWriteJson(target, value)` — mkdir + tmp + rename (2-space JSON,
    throws on I/O failure, tmp left for the sweep);
  - `sweepOrphanTmpFiles(dir, target)` — best-effort orphan sweep (never
    throws, only touches the target's tmp shape).
  The store's `save`/`collectOrphans` now delegate to these, so the
  sleep/tasks path uses the same primitive as everything else.
- **The 6 named sites** all go through the shared primitive:
  1. `sleep.ts` / 2. `tasks.ts` — via the store (already #276);
  3. `todos.ts` `saveBoard` — inline tmp+rename → `atomicWriteJson`
     (same pid+ts scheme as before, code de-duplicated);
  4. `restart-queue.ts` `saveRewakeQueue` — `${p}.tmp` (non-pid, no
     orphan sweep) → `atomicWriteJson`; new `collectRewakeOrphans`
     (best-effort), swept once per real process start inside
     `drainRewakeSurvival` (`queue.ts` — the startup path at
     index.ts:1628; index.ts itself untouched);
  5. `worktree.ts` `saveWorktreeState` — plain `writeFileSync` (non-atomic)
     → `atomicWriteJson` (atomic; drops a cosmetic trailing newline,
     JSON.parse roundtrip unchanged);
  6. `undo.ts` `truncateSession` — raw JSONL write keeps its content,
     tmp name converges from `${sessionFile}.undo-tmp` to the shared
     `atomicTmpName` scheme.
- Comment-only: the `*.jsonl` skip-filter comments in `undo.ts` /
  `usage.ts` updated to the new tmp shape (the filter skips both shapes —
  neither ends in `.jsonl`).
- `undo.ts` size-ratchet compliance: the new import kept the file at its
  1090 non-blank budget by condensing one two-line comment (ratcheted
  files may only shrink; no budget change).

Behavior-preserving: throw semantics per site unchanged (durable-store
save / todos / worktree / undo throw; restart-queue keeps its
try/catch→boolean). All existing pins pass unchanged; new tests added for
the shared contract (naming shape, atomic write + no residue, failure
leaves the tmp for the sweep, sweep scope/idempotency), the rewake
orphan sweep (incl. null stateDir + empty dir), the worktree atomic
save, and the undo tmp-scheme rewrite.

## Gate outputs (repo root, base main e517c322)

- `bun test` (root: bridge + bin + deploy): **1168 pass, 0 fail**
  (bridge alone: 1106 pass, 0 fail — 1096 baseline + 10 new tests)
- `bun run typecheck` (`cd packages/bridge && bun x tsc --noEmit`): clean
- `bunx biome check .`: 80 files, 0 diagnostics
- `bun scripts/size-ratchet.ts --base origin/main`: SIZE GATE: OK (9
  ratcheted)

## Files

- packages/bridge/channel/durable-store.ts (+ shared primitives)
- packages/bridge/channel/durable-store.test.ts (+ contract tests)
- packages/bridge/channel/todos.ts
- packages/bridge/channel/restart-queue.ts (+ collectRewakeOrphans)
- packages/bridge/channel/restart-queue.test.ts
- packages/bridge/channel/queue.ts (sweep in the startup drain)
- packages/bridge/channel/worktree.ts
- packages/bridge/channel/worktree.test.ts
- packages/bridge/channel/undo.ts
- packages/bridge/channel/undo.test.ts
- packages/bridge/channel/usage.ts (comment only)

No changes to `channel/index.ts` (ja-style-v4-nits owns it), no new deps,
no bun.lock churn.
