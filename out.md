# out — AGENTS.md change guard (alert-only tripwire)

Branch: `pi-bg/20260914-075236-522`. Andryo rule 2026-09-14: AGENTS.md changes
require his explicit approval — now mechanical. Alert-only: never revert,
never block.

## Where each piece landed

| Piece | Location |
| --- | --- |
| Manifest format | `~/.pi/agent/.agents-md-hash` (fixed path), one line: `<sha256>  <UTC ts>  <note>` (note `-` when empty) |
| Target resolution | `JARATE_AGENTS_MD` if set, else `~/.pi/agent/AGENTS.md` if present, else `~/AGENTS.md`. Live boxes keep the main profile's law in `~/AGENTS.md` (verified on this host: `~/.pi/agent/AGENTS.md` does not exist) — the fallback arms the tripwire there; the manifest stays at the fixed design path. |
| `jarate agents-check` | `bin/jarate` (bash entrypoint, next to ctx-report/journal-errors/memory-grep/rag). Output: `{"ok":true,"ts","error":null,"hash","expected","drift"}`. `drift:true` = manifest missing OR hash mismatch. `ok:true` even on drift; `ok:false` rc 1 only when AGENTS.md is unreadable/missing. |
| `jarate agents-bless [note]` | `bin/jarate`. Rewrites the manifest with the current hash + ts + note (atomic tmp+mv). `ok:false` rc 1 if AGENTS.md missing (nothing written). |
| Watchdog tripwire | `dispatch/pi-bg-watchdog`, new section after the DEAD-sweep posts, reuses the existing channel path (`wd_post` + python embed builder via new `wd_build_drift`). |
| CLI tests | `bin/jarate.test.ts` — new `agents-check / agents-bless` describe (fake HOME, temp AGENTS.md): no-manifest drift, bless+check in-sync, edit->drift->re-bless, no-note `-`, missing file rc 1 for both, `JARATE_AGENTS_MD` override, `~/AGENTS.md` fallback (manifest stays in `~/.pi/agent`). |
| Watchdog tests | `dispatch/pi-bg-watchdog.test.ts` (new) — real watchdog + real jarate against fake HOME, webhook captured via Bun.serve: warn-once, no re-post, re-bless clears, new hash re-warns, mtime-ts fallback (never blessed), `~/AGENTS.md` fallback layout, jarate-missing silent skip, no-webhook no-state, `--quiet`/`--dry-run`, check-fail silent. |
| Docs | `docs/JARATE.md` (both commands + `JARATE_AGENTS_MD` env + consumer note), `docs/DISPATCH.md` (tripwire section). |

No new files to deploy: install.sh already symlinks `~/bin/jarate` and
`~/scripts/pi-bg-watchdog` into the checkout — a `git pull` on a live box is
the whole deployment. `install.sh --dry-run` re-verified clean (fake HOME).

## Watchdog diff summary (short)

- `wd_build_drift <bodyfile> <hash8> <ts>`: orange embed (same color/format
  family as the DEAD sweep), title `AGENTS.md drift`, description exactly
  `AGENTS.md drift: <hash8> since <ts> — review + re-bless: jarate agents-bless "note"`.
- New section (after DEAD posts, before auto-prune): runs
  `timeout 30 $HOME/bin/jarate agents-check`; on `ok:true && drift:true` with
  a hash, compares the full hash against `~/.pi/agent/.agents-md-drift-warned`;
  if different: `<ts>` = manifest blessing ts (fallback: AGENTS.md mtime,
  fallback: `unknown`); `--dry-run` prints would-post; otherwise posts via
  `wd_post` (3 retries). State file written ONLY after a successful post, so a
  dead webhook retries next sweep.
- Backward compatible: jarate missing/unreadable, jq/python missing, no
  webhook, `--quiet`, non-drift result — all skip silently; sweep still exits 0.
  Existing `--quiet`/`--dry-run` semantics apply to the drift post too.

## Re-bless procedure (after Andryo approves an AGENTS.md change)

1. Verify the diff is what was approved: `jarate-diff` or plain `git diff`.
2. `jarate agents-bless "<who approved, what changed>"` — e.g.
   `jarate agents-bless "andryo ok, fleet section"`
3. Confirm: `jarate agents-check` -> `"drift":false`.
4. The next watchdog sweep is quiet (no warning). If the file changes again
   without blessing, the new hash differs from the state file -> one fresh
   warning within 15 min.
5. First-ever blessing on a box (no manifest): same command; until then the
   watchdog warns once for the live hash (never-blessed = drift).

## Verification

- `cd bin && bun test`: 38 pass, 0 fail (incl. 7 new).
- `cd dispatch && bun test`: 34 pass, 1 skip, 1 fail — the fail is the
  PRE-EXISTING `#41 at cap` test, reproduced on clean main in this same env
  (ambient live pi-bg workers on this host are counted by the /proc cap scan);
  green in CI where no ambient workers exist. All 10 new watchdog tests pass.
- `cd packages/bridge && bun x tsc --noEmit` clean, `bun test` 571 pass 0 fail
  (untouched, run for gate completeness). `packages/recall` tsc clean.
- `bunx biome check .` at repo root: 0 diagnostics.
- Manual smoke (fake HOME + live HTTP server): warn-once per hash, message
  format byte-exact vs spec, state gating, silent skip with jarate removed,
  no-state without webhook, dry-run/quiet honored. Real-HOME dry-run sweep:
  quiet (drift=false after arming).

## Armed on monky (this box)

- Blessed the live law file with the branch's jarate:
  `~/.pi/agent/.agents-md-hash` =
  `c7589777...  2026-09-14T08:20:03Z  initial bless 2026-09-14 (tripwire arm,
  pi-bg/20260914-075236-522)` — resolved via the `~/AGENTS.md` fallback
  (no `~/.pi/agent/AGENTS.md` on this host). `agents-check` -> `drift:false`.
- frank/jimmy: not blessed (monky has no read access to their homes). After
  the merge + their next `git pull`, the first watchdog sweep will warn once
  (never-blessed = drift) — bless on each box when Andryo confirms, or accept
  the single startup warning as the arm signal.

## Follow-ups (out of scope, not touched)

- `packages/bridge/channel/jarate.ts` (owned by another worker): the LLM tool
  enum `JARATE_COMMANDS` should gain `agents-check`/`agents-bless` + a doc
  line so the agent can self-check/re-bless from the tool. The tripwire
  itself does not depend on this (watchdog calls `~/bin/jarate` directly).
- Pre-existing: `bin` CI job red on main — ubuntu-latest runners no longer
  ship `rg` (all memory-grep tests fail there; local hosts fine). Needs a CI
  fix (e.g. install ripgrep in the job) separate from this change.
- First deployment per agent: bless the current AGENTS.md once
  (`jarate agents-bless "initial bless 2026-09-14"`) so the tripwire starts
  armed from a known-blessed state.
