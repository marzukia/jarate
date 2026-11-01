# REPORT — #315 PIR guards: full branch (scopes A + B + C)

Worker run 2026-11-01; this report commit is the 2026-11-01 no-exemption line-wrap re-flow (every prose line rejoined to one flowing line per paragraph; machine-output blocks stay as-is) plus the update to the full branch (the prior version documented only scopes A + B and predates the scope-C commit). Base: main `1eed27ed`. Branch: `feature/315-pir-guards`, head = the commit containing this report (its parent is `e34e8be4`); PR #318 tracks the branch and its head moves with this push. Three scope commits, one per verified scope:

- `9f9cac63` — scope A (P0 deterministic guard): `packages/bridge/channel/restart-ops.{ts,test.ts}` (+427).
- `5f2af44b` — scope B (P1 amnesia checks): `packages/bridge/channel/handover.{ts,test.ts}`, `packages/bridge/channel/index.ts` (+556 / -1).
- `174b941c` — scope C (P0 root fix): `packages/bridge/channel/index.ts`, `packages/bridge/channel/restart-ops.{ts,test.ts}`, `packages/bridge/channel/rotation-stale.ts` (new), `packages/bridge/channel/rotation-stuck.test.ts` (new).

## Scope A — P0: rotation-stale + live-size watch (deterministic)

`channel/restart-ops.ts` (all new code appended; the file lands at exactly 800 non-blank lines — the 800 gate; the file is < 2000 lines, so it stays in-gate and is NOT ratcheted, per the size rule):

- `checkRotationStale(input)` — pure function, the EXACT #315 conditions, nothing else: ROTATION-STALE = a handoff doc written in the last 2 h (`now - newestDocMtimeMs < 2 h`, strict) AND the live session file mtime STRICTLY older than the newest doc mtime (numeric compare, no inference); size flag = the live session file above 1.5 MB (independent of the mtime compare).
- `newestHandoffDocMtime(storeDir)` — max mtime over the store's *.md doc files (`latest.md` is the pointer, not a doc); null when the store is missing/empty.
- `armRotationStaleWatch(ctx)` / `clearRotationStaleWatch()` — a 5-min per-agent tick (armed at session_start, cleared at session_shutdown; unref'd; one process = one agent). The check also runs immediately on arm (a stalled rotation is deep into its 2 h window by boot time). On a hit: log line every tick + ONE say to the responsible lane (default channel, the existing `machine()` one-line say path), latched once per episode (resets when the condition clears) so the tick does not re-post.

## Scope B — P1: handoff amnesia checks (doc write + session start)

`channel/handover.ts` + `channel/index.ts` wiring; two positional checks, no inference:

- **doc write** (`buildHandover`, before `writeHandover`): when the branch carries a pending human-inbound ask, count UNANSWERED operator asks in `[write_ts - 30 min, write_ts]` (the same "no assistant entry after it" rule the extraction uses; the doc caps at 2, so the expected count is capped at 2) vs the count listed under the doc's "Last user asks". Mismatch = `console.warn` + the doc is tagged `INCOMPLETE-ASKS` in the protected "Last user asks" section body (sizeGuard never condenses it; parseKickoff's lastAsk only reads numbered lines, so the tag stays inert for the boot seed). The check runs only when the branch has a pending ask: when it does not, the list is the span fallback (older summarized span content, never in-window) or (none), and the window does not apply.
- **session start** (`runSessionStartAskCheck`, wired fire-and-forget in the session_start handler): when the latest handoff doc exists and says (none), ONE bounded history fetch per enabled Discord channel (the #180 lookback, `REWAKE_LOOKBACK_DEFAULT`) flags any UNANSWERED operator message < 30 min old — "unanswered" = no bot post after it (author.id === botUserId; unknown bot id = any non-webhook bot post counts; a machine-wake card never counts as an answer). Log line + say to that channel via the existing `machine()` say path. A dead network at boot is a silent no-op, never a startup failure. `ASK_SELF_CHECK_WINDOW_MS` (30 min), `docAsksIsNone`, `sessionStartAskFlag`, `ChannelHistoryMessage` exported for tests.
- `index.ts`: +11 lines (2 imports, `armRotationStaleWatch(ctx)` + `void runSessionStartAskCheck(ctx.cwd, enabled)` in session_start, `clearRotationStaleWatch()` in session_shutdown) — the ratcheted budget (3815) is untouched.

## Scope C — P0 root fix: stuck-label gate re-run + arm-at-doc-write

### Root cause (confirmed)

`beginCompacting` (index.ts) arms a 10-min fallback timer (`COMPACT_FALLBACK_MS`). When the `session_compact`/`session_compact_failed` completion event never arrives, that timer closes the op window (`clearCompacting`) and drains — but it never re-runs `handoffRestartForSize`. The arm set at doc write (`session_before_compact` → `setHandoffRestartArmed(true)`) is only consumed by the settle's gate re-run, so it stays pending: the handoff restart op never opens and the rotation stalls (the P0 stall), and the stuck `compacting` label also makes every later restart gate return early.

### H1 — arm at doc write

Already in code, verified: `session_before_compact` calls `setHandoffRestartArmed(true)` immediately after the doc write (index.ts:~2816), independent of any settle. Verified by the hermetic test (c). No code change.

### H2 — stuck-label timeout re-runs the gate

`beginCompacting`'s fallback timer now calls `compactWindowStuckRecover(pi, ch, ctx, label)` (new helper in restart-ops.ts, next to the mechanism-B code): (1) #84 behavior preserved — settle the placeholder to a terminal line (`settleCompactTick` "compact stalled"), clear the window, drain the queue; (2) for `label === "compacting"` only — a loud distinct `[op:compacting] STUCK` line (`[op:compacting] STUCK: <id> window open 10 min with no completion event; closing and re-running the restart gate (settle never arrived)`, console.error, distinct from the #84 path), then `handoffRestartForSize(pi, ctx)`, mirroring the session_compact handler exactly: the armed handoff restart opens even when the settle event never arrived (the P0 stall), and the gate itself decides (arm / fresh window / settings). Idempotency: the arm is a boolean consumed by the gate; the timer only fires while the window is still open (any settle/close clears the entry and cancels the timer), so a second doc write in the same episode (re-opens the window with a fresh timer) cannot double-fire or re-open a closed window — test (d).

### Files

- `packages/bridge/channel/index.ts` — timer calls the helper; `COMPACT_FALLBACK_MS` exported (stuck-label comment).
- `packages/bridge/channel/restart-ops.ts` — `compactWindowStuckRecover` added; the #315 rotation-stale section **moved out** to `rotation-stale.ts` (size-gate split: restart-ops.ts would have crossed the 800-line gate; split, not ratcheted), no behavior change in the move (tests + import sources updated).
- `packages/bridge/channel/rotation-stale.ts` — new sibling module, verbatim move of the #315 P0 guard section.
- `packages/bridge/channel/rotation-stuck.test.ts` — 4 new hermetic tests (fake timers + fake ctx): (a) window closes on settle (success + failed), (b) stuck timeout closes + loud line + gate re-run opens the op, (c) arm on doc write, (d) idempotency.

## Gate outputs (per head, repo root)

- Scope A + B (head `5f2af44b`): `bun x tsc --noEmit` clean (run at both commits and at the final head); `bun x bun test` **1169 pass, 0 fail** (32 files, ~28 s — the 1140 baseline + 29 new tests, across restart-ops.test.ts and handover.test.ts (count correction: the base is 1140 — verified by a full suite run at main `1eed27ed` — not the stale 1087 in AGENTS.md; the 1169 total is unchanged)); `bunx biome check .` 0 diagnostics (the 3 infos pre-existing, not errors, rc 0); `bun run size` — SIZE GATE: OK (9 ratcheted; restart-ops.ts at exactly 800 non-blank lines, in-gate, not ratcheted).
- Scope C (head `174b941c`): `bun x tsc --noEmit` clean; `bun x bun test` **1173 pass, 0 fail** (1169 baseline + 4 new); `bunx biome check .` clean (0 errors/warnings; the 3 pre-existing infos unchanged from the branch baseline); `bun run size` — OK (index.ts stays inside its ratcheted budget: 3807 ≤ 3815; restart-ops.ts back under 800 after the split).
- Fail-without-fix (scope C): scratch revert of the fix hunks (helper without the STUCK close + gate re-run): (b) and (d) FAIL, (a) and (c) still pass; restore: all 4 pass.
- Fix round (head = the commit containing this report): export-gate fix — moved the +1 top-level export (`COMPACT_FALLBACK_MS`) out of `channel/index.ts` (definition now in `channel/restart-ops.ts`, imported at the usage site; pure wiring, behavior identical) so `bun run size -- --base origin/main` passes (line-count AND export gates); plus this report's count corrections (1140 baseline + 29 new) and the rotation-stuck (d) comment fix.

## Notes

- No CHANGELOG entry: recent bridge fixes on this line (#311/#312/#313) did not update it; the top entry is 2026-10-24 (#280).
- No fleet identifiers in the diff (checked).
- PR #318 tracks this branch; the head moves with this push. Adversarial review (VERDICT: PASS) + green CI gate the merge per the PR flow.
