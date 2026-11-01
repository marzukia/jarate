# REPORT — #315 scope C: P0 root fix (stuck-label gate re-run + arm-at-doc-write)

Branch: `feature/315-pir-guards` (off 9d48bd25). No PR (task instruction).

## Root cause (confirmed)

`beginCompacting` (index.ts) arms a 10-min fallback timer
(`COMPACT_FALLBACK_MS`). When the `session_compact`/`session_compact_failed`
completion event never arrives, that timer closes the op window
(`clearCompacting`) and drains — but it never re-runs
`handoffRestartForSize`. The arm set at doc write
(`session_before_compact` → `setHandoffRestartArmed(true)`) is only
consumed by the settle's gate re-run, so it stays pending: the handoff
restart op never opens and the rotation stalls. The stuck `compacting`
label also makes every later restart gate return early.

## H1 — arm at doc write

Already in code: `session_before_compact` calls
`setHandoffRestartArmed(true)` immediately after the doc write
(index.ts:~2816), independent of any settle. Verified by hermetic test
(c). No code change.

## H2 — stuck-label timeout re-runs the gate

`beginCompacting`'s fallback timer now calls
`compactWindowStuckRecover(pi, ch, ctx, label)` (new helper in
restart-ops.ts, next to the mechanism-B code):

1. #84 behavior preserved: settle the placeholder to a terminal line
   (`settleCompactTick` "compact stalled"), clear the window, drain the
   queue.
2. For `label === "compacting"` only: a loud distinct line —
   `[op:compacting] STUCK: <id> window open 10 min with no completion
   event; closing and re-running the restart gate (settle never arrived)`
   (console.error, distinct from the #84 path) — then
   `handoffRestartForSize(pi, ctx)`, mirroring the session_compact
   handler exactly: the gate itself decides (arm / fresh window /
   settings).

Idempotency: the arm is a boolean consumed by the gate; the timer only
fires while the window is still open (any settle/close clears the entry
and cancels the timer), so a second doc write in the same episode
(re-opens the window with a fresh timer) cannot double-fire or re-open a
closed window — test (d).

## Files

- `packages/bridge/channel/index.ts` — timer calls the helper;
  `COMPACT_FALLBACK_MS` exported (stuck-label comment).
- `packages/bridge/channel/restart-ops.ts` — `compactWindowStuckRecover`
  added; the #315 rotation-stale section **moved out** to
  `rotation-stale.ts` (size gate: restart-ops.ts would have crossed the
  800-line non-bloat line; split, not ratcheted). No behavior change in
  the move (tests + import sources updated).
- `packages/bridge/channel/rotation-stale.ts` — new sibling module,
  verbatim move of the #315 P0 guard section.
- `packages/bridge/channel/rotation-stuck.test.ts` — 4 new hermetic
  tests (fake timers + fake ctx):
  (a) window closes on settle (success + failed), (b) stuck timeout
  closes + loud line + gate re-run opens the op, (c) arm on doc write,
  (d) idempotency.

## Verification

- Scratch revert of the fix hunks (helper without the STUCK close +
  gate re-run): (b) and (d) FAIL, (a) and (c) still pass. Restore: all
  4 pass.
- `bun x tsc --noEmit` — clean.
- `bun x bun test` — **1173 pass, 0 fail** (1169 baseline + 4 new).
- `bunx biome check .` — clean (0 errors/warnings; 3 pre-existing infos
  unchanged from branch baseline).
- `bun scripts/size-ratchet.ts` — OK (index.ts stays inside its
  ratchet budget: 3807 ≤ 3815; restart-ops.ts back under 800).

## Notes

- No CHANGELOG entry: recent bridge fixes on this line (#311/#312/#313)
  did not update it; the top entry is 2026-10-24 (#280).
- No fleet identifiers in the diff.
- No PR (per task instruction).
