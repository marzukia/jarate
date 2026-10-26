# Adversarial review — marzukia/jarate PR #294 (feature/deterministic-piping)

Fresh session, no authoring context. Head re-verified at start:
`gh pr view 294 -R marzukia/jarate --json headRefOid` →
`002818f202d16de5d13d70abc689f46c4849ec62`, state OPEN (matches dispatch).
Single commit on top of main (parent `ce3a3c19`); PR base `main`,
mergeable. Diff: 8 files, +2257, all additions
(`docs/DETERMINISTIC-PIPING.md`, `dispatch/detpipe/{detpipe.py,
pyproject.toml, uv.lock, README.md, tests/test_detpipe.py,
demo/handoff-555.md, demo/handoff-555.json}`). No existing file touched;
`packages/bridge/` untouched (bridge tsc/suite not load-bearing for this
diff; biome + size gate run anyway — clean).

## Check 1 — ANCHOR TRUTH: PASS

Every code path named in the doc exists and matches the claim.

hall-monitor (bare mirror `/srv/fleetwork/hall-monitor.git` @ 51206af):

- `deploy/fleetwork/run-wrapper.sh` — G6 block (issue #115) at lines
  140–205: on rc 0 with empty final text and no written artifact
  (git porcelain excluding `.fleetwork`, or find for non-git worktrees)
  → `G6_REASON=empty-final` → `$ART/terminal` marker (line 204). Salvage
  block (lines 208–262) tars worktree + session + `salvage-manifest.txt`
  — exactly 5 lines: `ticket/ts/rc/stop_signal/g6_reason` — and points
  `refs/heads/fleetwork-salvage/<ticket>` at the tar blob. The REAL
  555 manifest (`/srv/fleetwork/work/555/.fleetwork/salvage-manifest.txt`)
  is exactly 5 lines: `rc: 0 / g6_reason: empty-final` — the doc's
  "manifest that carries no state at all (555's manifest is 5 lines)"
  is verified against the real artifact, not just the code.
- `deploy/fleetwork/executor.py` — `read_live()` (line 707, reads
  `.fleetwork/live.json`), `map_state()` (line 837; G6 marker →
  `return "failed", marker` — downgrade-only, real failure classes win
  first), `parse_session()` (line 924; the section-1 parser aggregate:
  turns, five token dims, tool_calls by name, compactions —
  `deploy/fleetwork/parse_session.py` docstring line 5), `git_state()`
  (line 945; branch/head/dirty/files_changed), `finish()` (line 1008;
  captures git_state + parse_session, POSTs the record to
  `/api/fleet/runs`). All match.
- `fleet/runs.py` — `terminal_actions()` (line 437, exactly-once via the
  caller's BEGIN IMMEDIATE write lock + record_token minted once) →
  `post_run_message(run)` + `post_wake(run)`. `post_wake` (fleet/wake.py
  line 80, via `ORCHESTRATOR_WAKE_WEBHOOK`) payload =
  ticket/agent_name/side/state/kill_reason/rc/worktree_path/record_token/
  pushed/head/base_commit/dirty_at_end — **no brief, no summary**. Exact
  match to the doc's field list.
- `deploy/fleetwork/wake-receiver.py` — formats the one-line orchestrator
  wake; `work_signal()` (line 99) exists — the doc's "mirroring
  work_signal" for the new `handoff` field is a real, minimal change
  point.

jarate (`packages/bridge/channel/handover.ts` at PR base = main
ce3a3c19):

- `HANDOFF_DEFAULTS.threshold = 0.8`, `sizeGuardTokens = 12_000`,
  `storeDir = ~/.jarate/handovers` (lines 96–100). `shouldHandoff()`
  (line 215): manual → true; threshold → `percent >= threshold * 100`,
  with the MINOR-1 comment confirming the threshold is a fraction of the
  TOTAL context window — matches the doc exactly.
- `extractDeterministic()` (line 321): pure, no LLM; file tags prior-doc
  ∪ current span, NEWEST FIRST, `FILE_TAG_CAP = 10` (line 316),
  read=read-only invariant (a file modified later leaves the read list);
  refs/links from the last ~50% of the span, worktree paths from the
  last ~20 messages; last user asks, todo board (`defaultTodoText`),
  dispatch state (`safeJobsView`) — all as claimed.
- `serializeTranscript()` (line 530): current-state-first,
  `MSG_CAP = 4_000` (line 509), `TRANSCRIPT_CAP = 60_000` (line 510).
- `renderDeterministic()` (line 1228) / `buildHandover()`: "NO LLM
  call"; the `KickoffLiveState` docstring states the LLM pass was
  retired (scraping its sections "always yielded (none)").
- `writeHandover()` (line 1003): writes `<stamp>-<slug>.md` +
  `latest.md` pointer (path + fingerprint + updated stamp).
- `buildSeedKickoff()` (line 1324): digest (`parseKickoff`) + forced
  "Read `latest.md` before continuing".

No doc claim contradicts the code. PASS.

## Check 2 — ZERO-LLM: PASS

- `detpipe.py` imports: `argparse, hashlib, json, re, subprocess, sys,
  dataclasses, datetime, pathlib` — all stdlib.
- `subprocess` is used exactly once (line 320): local `git -C <wt>`
  commands with a 30s timeout — a local process, not network, not LLM.
- Grep for `urllib|http|socket|requests|urlopen|openai|anthropic|
  api_key|curl|wget` over `detpipe.py` + tests: no hits (only the
  module docstring's "no LLM calls, no network" line).
- `pyproject.toml`: zero runtime deps; dev group = `pytest>=8,
  ruff>=0.5` only. `uv.lock`: detpipe + pytest/ruff transitive closure
  (colorama, exceptiongroup, typing-extensions, iniconfig, packaging,
  pluggy, pygments, tomli) — nothing else.

PASS.

## Check 3 — DETERMINISM: PASS (verified against the REAL 555 session)

`/srv/fleetwork/work/555/.fleetwork/session.jsonl` is readable from this
host (mode 664, group fleetwork — not the piboy-only fallback case), so
all determinism evidence below is against the real session, not just the
committed fixture:

- Generator run 1 and run 2 (identical input, fixed `--at` stamp) →
  byte-identical outputs:
  - `handoff.md`: `47268cd6963530953dd9712c22181f0f42881f7031498049a2778301dc33a69a`
    (both runs)
  - `handoff.json`: `a2bbd7dfff8822dc9d01be29773b5c158983186b4e5e9e7790f6e58840a29e4b`
    (both runs)
  - `diff` of both: empty.
- The committed `demo/handoff-555.{md,json}` reproduces **byte-exact**
  from the real session (`diff` clean, both files).
- `test_determinism` green.
- Sidecar sha256 re-derives: each section body in the md, hashed, equals
  the sidecar hash — verified for the committed demo AND a fresh run
  (9/9 sections, ALL-OK). `extracted_at` is a separate key, not part of
  the section hashes — the doc's determinism claim holds.

PASS.

## Check 4 — CASE-STUDY FIDELITY: PASS

Verified against the REAL 555 session (`/srv/fleetwork/work/555/
.fleetwork/session.jsonl`, 881,580 bytes) and the real salvage manifest:

| Claim | Real session | Demo | Match |
|---|---|---|---|
| 161 assistant turns | 161 | `turns: 161` | ✓ |
| 58,946-char thinking block | 58,946 (last turn, `thinking` key) | `thinking 58946 chars` | ✓ |
| usage 107,538 / 16,384 / 123,922 | input=107538 output=16384 totalTokens=123922 | `input=107538 output=16384 total=123922` | ✓ |
| 9x near-duplicate shingle | top shingle repeats in fatal block = 9, 9, 8 (detpipe `_shingle_counts`) | `t160(58946ch,9x)` | ✓ |
| the ONLY stopReason=length | exactly 1 in the session | — | ✓ |
| escalation 8.7k→19k→12k→23k→11.4k→58.9k | t10=8582, t140=19006, t146=11989, t154=23029, t159=11400, t160=58946 | — | ✓ (all six sizes present) |
| model Qwen3.8/helium | provider=helium modelId=Qwen3.8 | `model: helium/Qwen3.8` | ✓ |
| compactions | 2 | `compactions: 2` | ✓ |
| 5-line manifest, rc 0, empty-final | real manifest: 5 lines, `rc: 0`, `g6_reason: empty-final` | — | ✓ |

`test_real_555_session` ran against the real file (not skipped) and is
green. PASS.

## Check 5 — TESTS + LINT: PASS

Fresh clone of `feature/deterministic-piping` from the bare mirror at
head 002818f2:

- `uv sync` — clean (detpipe + pytest 9.1.1 + ruff 0.17.2 + transitive).
- `uv run ruff check .` — "All checks passed!" (select E,F,W,I,UP,B;
  line-length 90; py310).
- `uv run pytest -q` — **9 passed in 0.06s, 0 fail** (the 9:
  stop_length+caps, empty_final, context_threshold, rumination_escalation,
  files_touched_newest_first_and_invariant, brief_fallback,
  tool_call_results_truncated, real_555_session, determinism). Tests are
  substantive: they pin trigger semantics, the 4000/2000 caps, the
  read=read-only invariant, verbatim brief fallback, hash re-derivation,
  and the real-555 facts.
- Repo root: `bunx biome check .` → rc 0; `bun run size` → "SIZE GATE: OK
  (8 ratcheted)" (detpipe.py = 562 non-blank lines, under the 800
  ratchet threshold; test file 317, within x3 budget).

PASS.

## Check 6 — SCHEMA + TRIGGERS: PASS (minor notes m1–m3)

- **Schema soundness**: `detpipe/1` + per-section sha256 sidecar.
  Re-derivation verified (Check 3): a verifier (next run or warden) can
  re-run the pure generator over the session record and byte-compare, or
  hash the md section bodies directly — both paths check out on the
  committed demo. The re-dispatch contract is implementable: the
  handoff files in `$ART` ride the existing salvage tar
  (run-wrapper.sh lines 208–262), so they are durable on
  `refs/heads/fleetwork-salvage/<ticket>` even when the worktree is
  gc'd — exactly as §3.4 claims.
- **The four §3.6 change points are real and minimal**:
  1. `run-wrapper.sh`: the insertion point "after the G6 block (before
     the salvage tar)" exists — between the G6 marker write (line 205)
     and the salvage block (line 208). One warn-only command; a missing
     handoff cannot block the salvage.
  2. `executor.py`: `finish()` builds the terminal record dict — adding
     a `handoff_file` key is minimal. The in-run trigger's plumbing
     exists: `read_live()` already reads `live.json`, and the F62
     wire-only field pattern (`kind`/`elapsed`/`wall` in
     `RunUpsertSchema`, rendered by the api without persistence) is a
     working precedent for a `kind=handoff` wake.
  3. `wake-receiver.py`: `work_signal()` (line 99) is the exact pattern
     to mirror; adding one validated field to the one-line wake is
     minimal (the line-shape constraints — single line, C0 rejection —
     are already enforced).
  4. `fleet/runs.py`: no change — holds at the named-file level (the
     pydantic upsert ignores extra fields; `terminal_actions()` is
     untouched). See m1 for the sender-side caveat.
- **Triggers** (3.1): all four are implementable against the named
  paths — `context-threshold` from `live.json`/`executor.read_live()` or
  the last assistant `usage` (implemented; verified firing on the real
  555 session: 123,922 ≥ 80% of 131,072); `empty-final` from the G6
  marker (wrapper-side) / last-message zero-text (tailer-side);
  `stop-length` from the last `session.jsonl` message (fired on 555);
  `rumination` as the pure shingle/escalation function (fired on 555:
  t157 5x, t160 9x).

PASS.

## Findings

**Blockers (B): 0**

**Major (M): 0**

**Minor (m): 4**

- **m1 — §3.6 "no change to fleet/runs.py" undersells the sender side.**
  For the #30 wake line to carry `handoff=`, the SENDER must include it:
  `post_wake()` in `fleet/wake.py` builds the payload from the Run row,
  and the record field needs a wire-only slot in `RunUpsertSchema`
  (the F62 `kind`/`elapsed`/`wall` pattern). The doc names the receiver
  (`wake-receiver.py`) but not `fleet/wake.py` + `fleet/schemas.py`.
  `fleet/runs.py` itself is indeed unchanged (the upsert tolerates extra
  fields, `terminal_actions()` untouched), so the claim holds at the
  named-file level — but the full change set is one file wider than
  written.
- **m2 — §3.3 sidecar sketch ≠ implementation.** The sketch shows
  `"ticket": 555`, `source: {session_file, brief, worktree}` and 8
  section hashes; the implemented sidecar has `session` (the session id,
  e.g. `fleetwork-555`), `source: {cwd}` and 9 hashes (adds `trigger`,
  omits none of the sketch's eight). The committed sidecar is
  self-consistent and re-derives; the sketch is illustrative but a
  reader diffing them will find the mismatch.
- **m3 — rumination escalation criterion vs the 555 episode.** The spec
  says "3+ consecutive turns with thinking ≥ 8,000 chars (the 555
  escalation: 8.7k→19k→12k→23k→11.4k→58.9k)", implying the 555
  episode satisfies it. It does not: the episodes are non-consecutive
  (t10/t140/t146/t154/t159/t160 — t158 is 67 chars), so the
  implementation's escalation branch is `False` on 555 (the committed
  demo shows `escalation=False`). The trigger still fires via the
  shingle-episode criterion (t157 5x, t160 9x), so behavior is correct;
  the doc's parenthetical overstates which criterion the 555 case
  exercises.
- **m4 — no CI gate for the reference implementation.**
  `.github/workflows/ci.yml` (biome / bridge tsc+test / size gate / bin
  tests) has no detpipe job; the 9 tests + ruff run only locally. For a
  design + reference-implementation PR this is acceptable, but a
  regression in `detpipe.py` (or its caps) will not fail CI. A one-job
  addition (uv sync + ruff + pytest, path-filtered on `dispatch/detpipe/`)
  would close it.

**Nit (n): 2**

- **n1 — §5 verification command omits `--at`.** The committed demo's
  `extracted_at` is `2026-10-27T00:00:00Z`, which requires
  `--at 2026-10-27T00:00:00Z` (the README documents the flag; the demo
  reproduces byte-exact with it). The §5 command as written would
  produce a fresh timestamp and not byte-match the committed output.
- **n2 — `empty-final` trigger source column.** The 3.1 table cites the
  G6 marker as the source, but the implementation's session-level check
  (last assistant message has zero text blocks) does not test "no
  written artifact" — that half lives wrapper-side in the G6 block.
  Consistent with the doc's "evaluated by the tailer/executor
  (in-run) and by the wrapper (terminal)", but the table's single
  source column blurs the two.

## Verdict

All six checks pass with evidence. The anchors are real (both repos,
verified line-by-line against the bare mirrors), the implementation is
stdlib-only with zero LLM/network paths, determinism is byte-exact
against the real 555 session, every case-study number reproduces from
the real session record, the suite is 9/9 green with ruff/biome/size
clean, and the schema + trigger spec are implementable at real, minimal
change points. The four minors are doc-precision and CI-wiring items,
none of which corrupt the piping contract or the committed audit trail.

B=0, M=0, m=4, n=2.

VERDICT: PASS
