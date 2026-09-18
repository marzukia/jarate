# RCA: empty-completion thinking runout (2026-09-18)

Ticket 20260918-133528-1639646 (worker, jarate project-tags task): 3/3
attempts died with 0-byte raw.out + err.log.

## Signature
Final turn of each attempt = ONE content block, type `thinking`,
57,350 chars (~16,384 output tokens), no text, no toolCall.
`usage.output` == 16384 exactly.

## Cause
Qwen3-style thinking consumed the entire per-completion output budget.
`maxTokens: 16384` in the profile models.json is the hard cap pi sends as
max_tokens; when thinking alone exceeds it, the completion is truncated
with an empty assistant message -> "empty completion" retry loop (x3) ->
EMPTY callback.

Preceding turns were normal (11-14 turns, reads/bashes, cache growing);
the runout hit on a low-input turn (2.9K-4.4K) — a long planning thought.

## Fix (2026-09-18)
- `~/.pi/agent-{worker,reviewer}/models.json` maxTokens 16384 -> 32768
  (pi-side; vLLM untouched, max-model-len 524288 has headroom).
- Task re-dispatched: 20260918-140425-2653975.

## Follow-up
Profile seeding copies models.json from the main agent home. New machines
inherit 16384. Make the 32K cap part of the seed (dispatch/profiles or
setup) so the trap doesn't recur fleet-wide. Main profile (monky) still
carries 16384 — works today, latent risk on long thinking turns.
