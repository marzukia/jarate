# CLAUDE.md — {{PROJECT}}

Thin pointer. The prescriptive rules live in [`AGENTS.md`](AGENTS.md) —
read and follow it. This file holds only model-specific deltas.

- Claude is assumed to infer; where `AGENTS.md` spells a step out, you
  may compress it, but the *outcomes* are identical: issue first,
  preflight clean, red-then-green test for fixes, adversarial review
  verdict before merge, CI green, squash-merge.
- Project lead: {{LEAD}}. Their direction overrides everything else in
  the repo.
- Commit as {{COMMIT_IDENTITY}}.
- If you change a rule in this file, change `AGENTS.md` in the same PR
  or the two files drift.
