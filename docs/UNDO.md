# /undo [N] + /redo — design

Commands implemented in `piscord/channel/undo.ts` (store + revert logic),
hooked into `piscord/channel/index.ts` (lifecycle + command dispatch).
Owner-only, like `/reset`.

`/undo` reverts the last assistant turn; `/undo N` reverts the last **N**
turns (issue #46) in ONE restart-class op, instead of N restarts with the
re-wake queue dropped between them. N default 1 = the original behavior,
byte-identical. Args: bare `/undo` = 1; `/undo 0`, negative, or
non-numeric = one `[!] usage: /undo [N] (N is 1 or more)` line, no action;
N > chain length = one `[!]` line, no action (validated before any state
changes). Redo stays one level (§3).

## Design questions

### 1. Conversation revert

pi has no session-branch API (extensions get `ReadonlySessionManager`; the
session file is the source of truth). A pi session is JSONL, and on resume
(`pi -c`, what systemd runs) **the leaf is the last line of the file** —
that is exactly why `/reset` works by renaming the file: a new leaf gives a
fresh session.

So conversation revert = **truncate the JSONL + respawn + re-run**:

- Walk the active path leaf→root (`parentId` chain) to the **Nth
  trigger** (N default 1): each complete turn = one assistant message
  plus the closest **trigger** root-ward of it (a `role:user` message or
  the `custom_message` entries piscord queues — channel inbound arrives as
  the latter, so both must count). Keep the file through that trigger.
  N=1 lands on exactly the original cut point (last assistant's trigger).
  If the path holds fewer than N complete turns — no assistant left, or
  no trigger root-ward of one — the revert ABORTS (`[!]`-class, file
  unchanged) instead of cutting to the header. `countTurns` counts the
  same walk, so `countTurns >= N` iff the cut exists.
- Back up the full session to `<file>.undo-<ts>` (kept, 5 most recent),
  then atomically rewrite the file keeping everything through that trigger
  (any in-flight trailing trigger from an aborted run is removed with the
  turn).
- **Re-run (F1).** The deployment runs `pi` in RPC mode, which never
  auto-prompts at startup — "keep the trigger in the file" alone would NOT
  re-run the prompt. So `performUndo` also parks a durable re-run record
  `~/.pi/agent/undo/rerun.json` (trigger text + session file). After the
  restart, the bridge's `session_start` consumes it and re-sends the
  trigger text through the normal inbound path (`pi.sendMessage`,
  `triggerTurn`). For `/undo N` the parked trigger is the Nth one (the
  kept last line) — the agent re-derives that turn, and the later turns
  the user actually wanted are parked in `redo.json` until `/redo`.
  Guards: 10-minute TTL (an unrelated restart must not re-fire a stale
  prompt) and session-file match (the record only fires on the session it
  was written for). The ack says `(re-running)` when a re-run was parked.
- `ctx.shutdown()` 300ms later — identical mechanism to `/reset`
  (systemd `Restart=always` re-runs `pi -c`). `restarted=true` in the
  result lets the test prove a restart is required. `/undo N` reuses the
  SAME op window + cursor-rewind + op-marker dance — only the snapshot
  target and cut point move up the chain; the restart is one, not N.

The removed lines are parked for `/redo`.

### 2. File changes — (a) vs (b), chosen per cwd

- **(a) git** (when cwd is a worktree): capture `HEAD` +
  `git diff HEAD --binary` (worktree incl. staged, raw buffer — a
  text-only diff cannot carry binary file changes, so one binary file
  used to fail `git apply` and drop the ENTIRE patch) + untracked file
  copies at run start (pre) and run end (post). Restore =
  `reset --hard <head>` + `git apply --binary <patch>` + untracked
  copy-back + delete untracked files that appeared after the snapshot.
  The session file (and the sessions dir, plus its `.undo-<ts>` backups)
  is EXCLUDED from the untracked copy-back/cleanup when it lives inside
  the repo, so the copy-back cannot overwrite the truncation. Because
  restore moves the branch pointer, **commits made during the run are
  undone too** (verified by test).
- **(b) file preimages** (non-git cwd): capture the pre-run content of
  every file the run touches via `write`/`edit` — hooked on
  `tool_execution_start`, which the pi agent loop emits in the preflight
  phase BEFORE execution (verified in `pi-agent-core/agent-loop.js`), the
  only window to see pre-write content. First touch per path wins; an
  absent file is recorded as `pre: null` and restores as absent. Run end
  captures postimages of every touched file for `/redo`.

  (b) alone is the fallback kimaki needed because OpenCode's
  `session.revert` is conversation-only; here (a) covers git repos, which
  is where the code agents actually live, and (b) covers everything else.
  `bash`-modified files are NOT tracked (best-effort, same gap as kimaki)
  — the ack does not hint at this when a run used bash heavily, so read
  the file state yourself after undoing a bash-heavy run.
  A pre-existing file over the 20MB cap is recorded as `pre: "cap"` and
  /undo KEEPS it (does not delete it) — its content is not restorable;
  the ack says `kept N >20MB file(s), not restored`.

Storage: `~/.pi/agent/undo/runs/<seq>_<ts>/{pre,post}/` + `meta.json`,
pruned to the last 10 (the run referenced by a live `redo.json` is pinned
and never pruned), 20MB per-file cap. Store root reads
`process.env.HOME` at call time (Bun caches `os.homedir()`, so tests can
redirect HOME).

**N>1 file-state targeting + limit.** Each run's pre-snapshot is captured
at ITS OWN start (`startRun`, called on `turn_start` in `index.ts`), so
the Nth-from-last run's "pre" snapshot IS the pre-Nth-run state — no new
capture mechanism is needed, only rank selection (`runAtRank`, same F3
skip semantics as `latestRun`). What N>1 restore does and does not do:

- **git cwd: the whole tree** goes back to the pre-Nth-run state
  (`applyGitSnap`: `reset --hard` + patch + untracked copy-back), including
  changes made by the later (also undone) runs.
- **non-git cwd: only the files the selected run touched.** `stageFileTouch`
  is first-touch and `finishRun` stores `run.preFiles` only — a later
  run's change to a file the selected run never touched stays as-is.
  (Turns BEFORE the cut keep their changes in both modes: the restored
  state is the one the Nth run found, which includes earlier turns' work.)
- **If the Nth-from-last run dir is gone** (pruned past `MAX_RUNS = 10`,
  or recorded for a different session file), `runAtRank` returns null and
  `/undo N` is **conversation-only** — the transcript rollback is the core
  win, N>1 file restore is best-effort as bounded here.

### 3. /redo semantics

**One level deep.** `/undo` writes `~/.pi/agent/undo/redo.json`
(run dir + removed session lines); `/redo` applies the run's **post**
snapshot and re-appends the removed lines, then consumes the record.
A second `/redo` says `[!] nothing to redo`. No stack — Andryo's spec.
For `/undo N` the record's `run` is the Nth-from-last run: `/redo` lands
on the state AFTER that run (i.e. just before the next one started) and
re-appends every removed line of all N turns. It stays one level — a
`/redo` after `/undo 2` is not followed by a second `/redo` that restores
the rest.

**Stale guard:** if a NEWER run completed after the `/undo` (its lines
were appended past the cut point), re-appending the removed tail would
strand the new turn off-path, so `/redo` refuses with
`[!] redo stale: newer run completed` and keeps the record. Also: a
`/redo` after `/reset` re-applies files only (the session file is gone);
the ack then says `redone: N files`.

For `/undo N>1` the record stores `coveredSeq` — the seq of the NEWEST
run the undo already covered (the undo spans ranks 1..N). The stale guard
compares against `coveredSeq`, not `rec.run`'s seq, or an immediate
`/redo` after `/undo 2` would be "stale" because of run 3 — the very run
it is restoring. Legacy records (no `coveredSeq`) fall back to `rec.run`'s
seq, which for `/undo 1` is the same value.

### 4. Permissions / ack format

- Owner-only via the existing `runChannelCommand` pattern
  (`isOwner` check + shared `ownerOnly` message); non-owners see
  "Owner only: /<cmd>".
- Acks (no emoji, `[ok]`/`[!]` style):
  - `[ok] undone: 2 files + conversation (re-running)`
  - `[ok] undone: 1 file` (files-only run)
  - `[ok] undone: conversation (re-running)` (no matching store entry)
  - `[ok] undone: kept 1 >20MB file (not restored)` (cap-skipped preimage only)
  - `[!] nothing to undo`
  - `[!] usage: /undo [N] (N is 1 or more)` (N = 0 / non-numeric; no action)
  - `[!] nothing to undo: only M turns back` (N > chain length; no action)
  - `[ok] redone: ...` / `[!] nothing to redo` / `[!] redo stale: newer run completed`
  - `(re-running)` is present only when a re-run trigger was parked (F1)

## Busy-agent handling

`/undo` AND `/redo` while the agent is mid-run: `ctx.abort()` (sets
`userStoppedRun` so the aborted tail is not posted as a failure), drain
the mid-turn re-wake queue (so `agent_end` does not start a fresh run
that the revert would then truncate or kill mid-flight), then wait for
idle (bounded, 3s) before reverting. Race is best-effort — same
tolerance as `/stop`.

## Known gaps (accepted)

- **bash files (F12):** in non-git dirs only `write`/`edit`-touched files
  are tracked; files a run made/changed/deleted via `bash` are not. The
  ack does not hint at this — check file state after undoing a
  bash-heavy run.
- **truncate-vs-append race (F9):** an inbound that starts a run between
  the idle check and the truncation rewrite appends lines the walk never
  saw (orphaned `parentId`). Best-effort, same class as `/reset`;
  mitigated by the pre-truncation `<file>.undo-<ts>` backup (F8), which
  holds the full pre-undo session.
- **>20MB files:** kept but not restored (F7) — see §2(b).
- **re-run TTL:** a parked re-run older than 10 minutes at session_start
  is dropped (unrelated restart), leaving the reverted session idle.

## What stays in context after /undo

The kept trigger (the last one for `/undo`, the Nth for `/undo N`) is kept
AND re-sent by the bridge on `session_start` after the restart (the
durable `rerun.json`, F1) — RPC-mode pi never auto-prompts at startup, so
without the re-send the prompt would sit in context unanswered. KV of the
undone assistant turn(s) (and their file changes, as bounded in §2) is
gone. `/redo` brings both back exactly (post-snapshot), not as a fresh
re-derivation.

## Verification

`piscord/channel/undo.test.ts` + `index.test.ts` F1 bridge
tests: encPath round-trip; non-git modify+create undo/redo; deletion
undo; git worktree+staged+commit undo/redo; **binary file undo/redo
(F2)**; untracked keep/drop; session truncation (incl. in-flight trigger,
user-role triggers, assistant-less, **pre-truncation backup F8, no-trigger
abort F8**); **rerun park/consume + stale/mismatch drop (F1)**;
**empty-run skip (F3), redo stale guard (F4), prune pin (F5)**;
redo re-append; latestRun session alignment; prune to 10; e2e
conversation-only (with rerun consume); findSessionFile fallback;
**>20MB keep-not-delete (F7), session-file exclusion from untracked
copy-back (F10)**. **#46 /undo N**: N=2/N=3/N>chain truncation walk;
N=1 byte-identical; countTurns; runAtRank (ranks + null); git `/undo 2`
e2e (one restart, pre-Nth-run tree state, re-run parked at T2, redo one
level to the post-run-2 state); non-git N>1 limit (selected run's files
only); N > chain length = one `[!]` line, no state change; legacy
files-only `/undo 1` kept; redo after `/undo 2` not stale (`coveredSeq`)
but a genuinely newer run is. Bridge level: `parseUndoCount` units;
`/undo 0`/`/undo abc` usage line (no op window, no shutdown);
`/undo 99` no-action line; `/undo 2` ONE restart-class op (op window,
session cut pre-shutdown, marker finalText, exactly one shutdown).
F1 end-to-end at the bridge level: performUndo → `session_start` →
`pi.sendMessage` with the kept trigger text (`index.test.ts`).
