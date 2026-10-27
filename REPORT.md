# REPORT — run 597 (fix #291 handover amnesia)

## Outcome

PR open: https://github.com/marzukia/jarate/pull/298
- base `marzukia/jarate:main` ← head `worrywarden/jarate:fix/handoff-291-amnesia`
- branch also in the bare mirror `/srv/fleetwork/jarate.git` @ `c454748a`
- body: `worker: warden, reviewer pass to follow`

## Verification (pre-PR)

- `bun x tsc --noEmit` — clean
- `bun test` — 1096 pass, 0 fail (1087 baseline + 9 new #291 tests)
- `bunx biome check .` — 0 diagnostics
- `bun run size` — OK (8 ratcheted)
- `HOME=/tmp/fake bash install.sh --dry-run` — clean

## Wall hit (flagged per task rule)

`git push github fix/handoff-291-amnesia` → **403**: the machine's gh
account (`worrywarden`, the "warden" identity here) has pull-only on
`marzukia/jarate` (`push: false`), and the hall-monitor vault's `gh_pat`
claim flow needs the running Django app (Python ≥3.14; box has 3.13), so
it was not reachable in-run. Same command retried 3× (credential-helper
push, permission check, vault lookup) before moving on.

Resolution: created fork `worrywarden/jarate` (POST
`repos/marzukia/jarate/forks`), pushed the branch to the fork, opened
PR #298 from the fork. The fork is the worker's own account, per the
task's "own gh account" rule.

## Change summary (surgical, generator not rewritten)

- `channel/handover.ts`
  - `extractDeterministic`: an ask is pending only when no assistant
    answer landed after it in the captured range (channel inbounds +
    span fallback; a kept-tail assistant answers every span ask).
  - transcript capture split out to `channel/transcript.ts` (size gate:
    ratcheted files may only shrink; handover.ts budget 1409).
    Re-exports keep all importers working — the move is verbatim.
- `channel/transcript.ts` (new)
  - `serializeTranscript`: the last completed turn (newest user line +
    everything after it) always survives the 60k cap; on overflow keep
    the anchor + newest lines, drop the middle with a marker. A mid-turn
    capture boundary (`isSplitTurn`) gets an explicit marker instead of
    silent truncation.
- `RCA.md`: 3 code paths + planned fix + implementation note.
