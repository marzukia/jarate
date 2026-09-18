# out.md — review fix round (5 LOWs) + 16k-runout RCA

Branch: `pi-bg/20260918-140425-2653975`, base commit `e228bdf5`
(project-tags). All five LOW findings from `review-out.md` fixed, one
hermetic test each, RCA doc included.

## LOW-1 — `bg_capture_cost` must not clobber a corrupt run record

- Fix: `dispatch/pi-bg` (`bg_capture_cost` python). `load()` now returns
  `None` (was `{}`) on decode failure or non-dict JSON, and the capture
  does `raise SystemExit(0)` when `rec is None` — the whole capture is
  skipped, so a corrupt record is never rewritten as a cost-only dict.
  Same skip-on-corrupt discipline as `bg_mark_record` / `bg_log_retry`.
- Test: `dispatch/pi-bg.test.ts` — "corrupt run record: capture skips,
  never overwrites with a cost-only dict (LOW-1)". pi stub truncates the
  record mid-run to `{"run": "20260918`; asserts the file is byte-identical
  after the run (both the main-flow capture and the terminal-trap capture
  ran against it).

## LOW-2 — stale `price_error` must clear when a later capture succeeds

- Fix: `dispatch/pi-bg` (`finish()`). `rec["price_error"] = price_error`
  is now set unconditionally (null on success) instead of only when the
  arg is truthy.
- Test: `dispatch/pi-bg.test.ts` — "transient price failure then success:
  later capture clears price_error (LOW-2)". Stateful curl stub: first
  pricing fetch exits 7 (marker file proves it), second (terminal trap)
  serves the canned price. Asserts final record has `cost_usd ≈ 0.00022`,
  `price_error` null, tokens kept.

## LOW-3 — misleading error label for a malformed model list

- Fix: `dispatch/pi-bg` (fuzzy fallback). New `mid(m)` helper
  (`str(m.get("id") or "") if isinstance(m, dict) else ""`) replaces the
  bare `m.get(...)` derefs in the exact scan + both fuzzy
  comprehensions, so non-dict/None entries degrade to an id miss instead
  of raising into the outer `except` and masking the label as
  "fetch failed". Also guarded the per-rate `float(v)` conversion
  (same failure class: a non-numeric pricing value no longer escapes to
  the outer except; it degrades to `None` -> "parse failed").
- Test: `dispatch/pi-bg.test.ts` — "malformed model list: label is
  model-not-found, not masked fetch/parse (LOW-3)". `curlStub` gained a
  `malformed` mode: well-formed fetch, `data` = `[null, 42, {"id": null},
  "qwen/qwen3.8-27b", {"pricing": {"prompt": "1"}}]`. Asserts
  `price_error == "model not found"` (pre-fix: "fetch failed"),
  `cost_usd` null, tokens kept.

## LOW-4 — boolean `cost_usd` counted as priced in the rollup

- Fix: `bin/jarate` (rollup heredoc). Cost collection now uses the
  bool-excluding guard the token sums already use:
  `isinstance(c, (int, float)) and not isinstance(c, bool)` else `None`.
- Test: `bin/jarate.test.ts` (projects) — "boolean cost_usd is not priced:
  rollup rejects it (LOW-4)". Bucket with one numeric record (0.01) and
  one `"cost_usd": true`. Pre-fix the bucket would report
  `cost_usd: 1.01, cost_covered: 2`; asserts `cost_usd: null,
  cost_covered: 1, runs: 2`.

## LOW-5 — backfill `scanned` must not count non-dict record files

- Fix: none needed — verified `git show e228bdf5:bin/jarate` (lines
  475-477): the isinstance guard + `continue` already sit ABOVE
  `scanned += 1` in BACKFILL_SCAN (the review's description has the
  order reversed; PROJ_SCAN likewise skips non-dicts before building a
  row). The requested end state was already met at the reviewed commit.
- Test: `bin/jarate.test.ts` (projects-backfill) — "non-dict record files
  are not scanned: totals reconcile (LOW-5)". Plants a JSON-array record
  file + a corrupt file alongside the 4 dict seeds; asserts backfill
  totals `{scanned: 4, tagged: 3, skipped: 1}` and that `projects`
  (PROJ_SCAN) reports the same local `scanned: 4` — the two scanners
  agree on the same input.

## Discrimination check

The 5 new tests run against the pre-fix scripts (`e228bdf5` versions of
`dispatch/pi-bg` + `bin/jarate`): LOW-1, LOW-2, LOW-3, LOW-4 FAIL
(LOW-3 reproduced as "fetch failed" vs expected "model not found");
LOW-5 PASSES (code already correct, test pins the invariant). Against
the fixed scripts all 5 PASS.

## Final verification (worktree, post-biome-fix)

```
$ bun test
 928 pass
 7 skip
 0 fail
 3733 expect() calls
Ran 935 tests across 34 files. [135.99s]
```

```
$ bunx biome check .
Checked 78 files in 203ms. No fixes applied.
Found 1 warning.
Found 1 info.
```
rc 0 — exactly the 2 pre-existing main-baseline findings
(`bin/jarate.test.ts:910` useTemplate info, `bin/jarate.test.ts:938`
noTemplateCurlyInString warning), none in this change's files.

```
$ bash -n dispatch/pi-bg && bash -n bin/jarate
pi-bg: bash -n OK (rc 0)
jarate: bash -n OK (rc 0)
```

## Commit contents

- `dispatch/pi-bg` — LOW-1/2/3 fixes
- `bin/jarate` — LOW-4 fix
- `dispatch/pi-bg.test.ts` — 3 new tests + `curlStub` malformed mode
- `bin/jarate.test.ts` — 2 new tests
- `issues/rca-16k-thinking-runout.md` — new (16k thinking-runout RCA,
  ticket 20260918-133528-1639646)
- `out.md` — this file (replaces the round-1 out.md)
