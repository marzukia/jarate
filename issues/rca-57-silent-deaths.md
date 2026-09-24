# RCA: silent pi-bg deaths (jarate #57)

Window: 2026-09-13 21:57 → 2026-09-14 ~08:00 AEST, the agent host.
Symptom: pi-bg worker/reviewer runs exit 1 with zero captured output, mid-run.
7 confirmed deaths. Constraint from the operator: no blame without evidence — vLLM
had been the suspect and had to be proven or exonerated with data.

## Verdict

**vLLM is NOT the cause.** Root cause: **pi's 600 s (10 min)
`LLM_IDLE_TIMEOUT`** — a pi-internal watchdog kills the process
(SIGTERM → exit 1) when a model stream produces zero response bytes for 10
consecutive minutes. All 7 confirmed deaths show exactly that signature.

## Evidence

1. **Journal** — `LLM idle timeout (no response bytes for 600s)` logged at
   every one of the 7 death timestamps. 7/7.
2. **vLLM server logs** — serving all requests in the window fine:
   1.6–17 s per completion, zero 4xx/5xx. The only 2 request timeouts in the
   vLLM log belong to other tools on the host, not pi-bg.
3. **Survivor comparison** — the 4 runs that survived the same window had
   max inter-byte gaps ≤ 7 min (under the 10 min watchdog).
4. **Correlation** — deaths line up with my own 3-ticket concurrent
   dispatches: more parallel pi-bg runs = longer gaps between streamed bytes
   on each run = more watchdog trips. The thing that was killing the workers
   was dispatching too many of them at once.
5. Non-death: ticket #8 (hugo) was a clean exit with a lost webhook callback —
   a #53 dead-letter family issue, not a silent death.

Note: the RCA worker itself (ticket 20260914-041132-27376) died after
241 m 19 s with no output — an instance of the same phenomenon. The analysis
above was completed inline; this file is the writeup it never produced.

## Recommended fixes (filed, not applied — operator's call)

1. Bump pi `LLM_IDLE_TIMEOUT` 600 s → 900 s. The observed gap distribution
   (survivors ≤ 7 min) plus queue contention means 10 min is under the real
   tail; 15 min covers it without masking a genuinely hung stream.
2. Cap monky's concurrent pi-bg dispatches at 2 (down from 3). Fewer parallel
   streams = shorter per-stream byte gaps = fewer watchdog trips.
3. vLLM `max_num_seqs` tune — possible, but no evidence it's needed; left as
   an option. (Cardinal rule: never touch vLLM without explicit instruction.)

## Status

- [x] root cause identified + evidenced (this doc)
- [ ] fix 1 applied (pi config)
- [ ] fix 2 applied (fleet dispatch config)
- [ ] #57 closed
