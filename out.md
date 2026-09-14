# out — live-frame unification

Branch: `pi-bg/20260914-075031-30907`. The in-run "working" status is now a
LIVE version of the end-of-run done frame: same builder, same fence. The
header flips working -> done/failed on the SAME Discord message
(edit-in-place).

## What changed

`packages/bridge/channel/index.ts`:

- `statusLine()` + `doneFrame()` replaced by ONE builder:
  `runFrame(state: "working" | "done" | "failed", calls, count, secs)`.
  Same body in every state (`│ ├` / `│ └` sub-steps, `└` close, overflow
  line); only the header differs: `┌ working · N calls · Ts` vs
  `┌ done · …` / `┤ failed · …`. `DONE_FRAME_MAX_STEPS` renamed to
  `RUN_FRAME_MAX_STEPS`.
- New closure `workingFrame(ch, secs)` in the extension scope: filters
  `toolCallsThisTurn` to essentials at level 1 (same filter the done
  frame applies at run end), returns `fence(runFrame("working", …))`.
- Live ticker (shared op tick, 5s cadence unchanged, elapsed stepped in
  5s) re-renders the FULL working frame from calls so far — was the
  one-line `┣ <action> · N calls · Ts`.
- `tool_call` handler: the existing send-or-edit path now carries the
  full working frame. NO new per-tool-call edits — same gate (level 0:
  nothing; level 1: essentials only; level 2: every call).
- Level-2 `turn_start` placeholder: `workingFrame(ch, 0)` — the
  0-call working frame — was `fence("┣ working…")`.
- `agent_end` morph unchanged in structure (edit the same message);
  payload is now `fence(runFrame(failed ? "failed" : "done", …))` — the
  hand-rolled ```` ```bash ```` fence is gone, one fence per machine
  message in every state.
- Dead locals removed: `lastToolAction`, `runToolCount`,
  `runEssentialCount`.

`packages/bridge/channel/index.test.ts`:

- All one-line `┣ working` / `statusLine` / `doneFrame` assertions
  rewritten to the frame shape (`┌ working`, `│ ├` / `│ └` sub-steps).
- New test: live tick re-renders the full working frame in place (same
  message id; 5s-step elapsed; tool call -> full frame; tick -> full
  frame).
- Done/failed morph assertions now prove it is a PATCH of the SAME
  messageId with no fresh done POST, and that the fence is bare ` ``` `.
- New column-budget tests: `runFrame(working)` at any count/elapsed,
  working/done/failed share the body (header-only flip), 0-call frame.
- Flake fixes (pre-existing, test-only): see "Judgment calls" 3.

Docs: `docs/COMMANDS.md` (output-tags paragraph),
`docs/secret-censor.md` (tick-frame example).

## Tests

- `bun test`: **574 pass / 0 fail** (main was 571; +3 net: 1 new
  live-tick test, 2 new frame budget tests, others rewritten in place).
- `bun x tsc --noEmit`: clean.
- `bunx biome check packages/bridge/channel/`: clean.
- `bash install.sh --dry-run`: clean.
- Stability: 25+ full-suite runs, several under box load 12–21
  (vLLM + postgres + 8 other workers): 0 failures.

## Behavior deltas (what the user sees)

- In-run message is now the full frame, edited in place:

  ```
  ┌ working · 2 calls · 10s
  │ ├ read /home/…/index.ts
  │ └ bash git push
  └
  ```

- Level 2: turn start posts the 0-call frame immediately (was the
  `┣ working…` one-liner); it morphs as calls fire.
- Run end: header flips to `┌ done` / `┤ failed` on that same message.
  No new post at run end (already true; now asserted).
- Fence normalized from ` ```bash ` to bare ` ``` ` for the done/failed
  morph — same fence as every other machine line.
- Level 1: live frame lists essentials only; header count = essential
  count (live count == done-frame count, as before).
- Level 0: nothing, unchanged.
- Todo board + agent prose: untouched.
- All frame lines fit the 40-col budget (guarded by tests).

## Judgment calls

1. `doneFrame` -> `runFrame` (exported; all test imports updated). The
   builder is no longer done-only; the name should say it covers all
   three states. `RunFrameState` type added for the state param.
2. The done/failed morph's ` ```bash ` fence normalized to `fence()`
   (bare). The mockup3 rule is "frames live in code fences only" — the
   bash label was never required and broke the one-fence-style
   invariant; content is box glyphs, not shell.
3. Two PRE-EXISTING load-sensitive test flakes fixed (test-only, no
   behavior change): the `#28 partial` watchdog test and the compaction
   "fallback timer drains" test. Root cause (caught with instrumentation):
   the drain chain's real `readFile` (memoryToc) is scheduled
   MID-`jest.advanceTimersByTime`; under load its completion can ride a
   0ms timer that only fires on a further clock advance or on
   `useRealTimers` in afterEach — the fixed flush/immediate budgets
   (2 setImmediates + microtasks / 1 tick) lost that race. Confirmed the
   same failures on main code under load before touching the tests.
   Replaced the fixed budgets with bounded polls (200x yield + 1ms
   clock nudge for the fake-timer test; 200x real tick for the other;
   the next armed timer is 5s away, so the nudges trip nothing).
4. The ticker keeps its 5s STEP for elapsed (existing spec), only the
   payload changed from one line to the full frame.

## Files

- `packages/bridge/channel/index.ts`
- `packages/bridge/channel/index.test.ts`
- `docs/COMMANDS.md`
- `docs/secret-censor.md`
- `out.md` (this file)
