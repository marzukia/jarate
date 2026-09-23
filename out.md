# issue #57 - pi-bg "silent exit=1 mid-turn" - investigation + fix

## Verdict
Today's "garbled" ticket (20260923-032230-1930679) is NOT the class A silent
death that retry1 handles. It is class B: rc=0, pi finished clean, and the
MODEL degenerated into a repetition loop. pi-bg shipped it as status=OK.
Fixed: degenerate rc=0 completions are now detected, relaunched once, and
reported with the actual signature when they recur. PR:
https://github.com/marzukia/jarate/pull/76

## Evidence (root cause)
Ticket artifacts, all read before changing anything:

- rc file = 0. run record state=done (03:22:30 -> 03:24:47, 137s).
  Webhook status was 204 (OK), NOT a silent death.
- Session jsonl (~/.pi/agent-reviewer/sessions/...1930679...): 3 clean
  toolUse turns; final assistant message stopReason=stop, output=4242
  tokens, text 8827 chars, NO errorMessage. raw.out (8831 B) matches.
- Final text starts mid-HTML (`</div>`) and loops shuffled fragments
  ("handover / unit / testsuite / pi-86") - vocabulary collapse, not
  stdout corruption. Context only ~29.5K/131K, maxTokens=32768: not a
  context-overflow stop. Trigger: reviewer prompt forced a full read of a
  ~17K-token HTML design doc right before the long-form write.
- The follow-up resume run (20260923-032513-2085840) passed clean
  (VERDICT: PASS) - degeneration was transient; a fresh session recovers.
- Class A (issue #57 original, ECONNRESET mid-LLM-call, rc=1 + empty
  output) is still covered by the existing retry1 logic - untouched.

Detector baseline (measured on this box, 2026-09-23):
- garbled out.md: top15 word coverage 0.860, distinct ratio 0.084
- 12 healthy out.md from prior 2 days: top15 <= 0.205, distinct >= 0.706
- word 8-gram ratio is useless here (0.060) - the loop shuffles, so the
  signal is vocabulary collapse, not n-gram repetition. 3x margin both ways.

## Fix (dispatch/pi-bg only; watchdog unchanged)
1. bg_degenerate: top15 coverage >= 0.60 AND distinct ratio <= 0.30,
   min 200 tokens, thresholds overridable (PI_BG_DEGEN_*), failure-
   tolerant (any error -> 0, never blocks the run).
2. Retry loop: degenerate rc=0 -> relaunch ONCE (fresh session =
   unpolluted context) behind a <ticket>.degr1 marker, logged as
   retry reason "degenerate". Second degenerate -> degen_final -> FAIL
   "degenerate output x2 (rc=0, repetition loop; relaunch did not
   recover - issue #57)". No third launch.
3. Reviewer verdict gate: rc=0 non-empty without a trailing
   "VERDICT: PASS|FAIL" line -> FAIL "no VERDICT line - review
   incomplete or degenerate (issue #57)". A reviewer run that loops
   for 30 minutes without a verdict can no longer masquerade as OK.
4. bg_death_reason: for empty-output deaths (silent-x2 / DIED / EMPTY)
   the brief now carries the actual reason: last assistant errorMessage
   from the session file, else the stderr tail (<= 200 chars). err.log
   is kept when out.md is blank (previously always removed) so the
   reason is reproducible from artifacts.
5. The -degr1 marker does NOT match the watchdog SILENT classification
   (rc=1 + -retry1 + empty out.md) - watchdog behavior unchanged.
   Webhook callback shape (embed fields, titles) and the concurrency
   cap are unchanged.

## Tests
dispatch/pi-bg.test.ts, 5 new tests in the #57 describe (fake pi stubs,
capture webhook):
- class B: degenerate rc=0 relaunched once, healthy retry -> OK
  (2 launches, degr1 consumed, retry logged, OK callback)
- class B: degenerate x2 -> FAIL (rc=0), no 3rd launch, marker kept
- class B: reviewer rc=0 non-empty without VERDICT -> FAIL
- class B: reviewer rc=0 with trailing VERDICT: PASS -> PASS
- class A: silent x2 brief carries "ECONNRESET" from stderr; err.log
  kept, rc recorded, out.md blank

Results (worktree):
- bun test pi-bg.test.ts: 66 pass, 1 skip (root-only), 0 fail
- bun test pi-bg-kill.test.ts pi-bg-watchdog.test.ts: 18 pass, 0 fail
- detector verified against real artifacts: garbled out.md -> 1;
  resume out.md + 3 healthy out.md -> 0
- bunx biome check .: exit 0; bash -n pi-bg: clean;
  HOME=/tmp/fake bash install.sh --dry-run: exit 0

Known pre-existing flake (NOT caused by this change): #41 "at cap:
next dispatch refused" fails on unmodified HEAD on this box - it is
sensitive to live fleet traffic (10 concurrent pi-bg wrappers at test
time). Fails identically before and after the change.

## Deployment note
Live ~/scripts/pi-bg == repo main before this PR (verified by diff).
After merge: rsync dispatch/ to live boxes (or the existing deploy
path); the degr1 marker is additive - old in-flight tickets are
unaffected. No pi.service restart required for the dispatcher itself.

## Confidence
HIGH on the diagnosis (rc/session/raw.out artifacts are unambiguous:
rc=0, stop, no error, vocabulary-collapsed text, recovery on resume).
HIGH on the detector not false-positiving on this box's recent healthy
outputs (3x margin, 200-token floor, failure-tolerant). MEDIUM on
generalization to other models/boxes - thresholds are env-overridable
(PI_BG_DEGEN_TOP15/DISTINCT/MIN_TOKENS) exactly for that.
