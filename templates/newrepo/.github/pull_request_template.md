## What

<!-- One line + short list of changed paths. -->
<!-- End with `Closes #N` so the issue auto-closes on squash-merge. -->

Closes #

## Why

<!-- The problem, the decision, links to threads/issues. -->

## Verification

<!-- Proof, with run output pasted in. A fix without red-then-green
     test output is unverified. Deployed-state claims need probe
     output (curl / gh api / docker exec). -->

- [ ] `make preflight` clean
- [ ] Regression test fails before the fix and passes after (fixes only)
- [ ] Review dispatched: `VERDICT: PASS` — or FAIL + one fix round,
      dispositions recorded here
- [ ] CI green (`gh pr checks <N>`; skipped jobs fine, red is not)

```
<paste output / drop screenshot>
```
