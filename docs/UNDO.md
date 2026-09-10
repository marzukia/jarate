# /undo + /redo — design

Commands implemented in `piscord/channel/undo.ts` (store + revert logic),
hooked into `piscord/channel/index.ts` (lifecycle + command dispatch).
Owner-only, like `/reset`.

## Design questions

### 1. Conversation revert

pi has no session-branch API (extensions get `ReadonlySessionManager`; the
session file is the source of truth). A pi session is JSONL, and on resume
(`pi -c`, what systemd runs) **the leaf is the last line of the file** —
that is exactly why `/reset` works by renaming the file: a new leaf gives a
fresh session.

So conversation revert = **truncate the JSONL + respawn + re-run**:

- Walk the active path leaf→root (`parentId` chain), find the last
  assistant message, then the closest **trigger** before it (a `role:user`
  message or the `custom_message` entries piscord queues — channel inbound
  arrives as the latter, so both must count). If no trigger is found
  root-ward of the last assistant, the revert ABORTS (`[!]`-class, file
  unchanged) instead of cutting to the header.
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
  `triggerTurn`). Guards: 10-minute TTL (an unrelated restart must not
  re-fire a stale prompt) and session-file match (the record only fires
  on the session it was written for). The ack says `(re-running)` when a
  re-run was parked.
- `ctx.shutdown()` 800ms later — identical mechanism to `/reset`
  (systemd `Restart=always` re-runs `pi -c`). `restarted=true` in the
  result lets the test prove a restart is required.

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

### 3. /redo semantics

**One level deep.** `/undo` writes `~/.pi/agent/undo/redo.json`
(run dir + removed session lines); `/redo` applies the run's **post**
snapshot and re-appends the removed lines, then consumes the record.
A second `/redo` says `[!] nothing to redo`. No stack — Andryo's spec.

**Stale guard:** if a NEWER run completed after the `/undo` (its lines
were appended past the cut point), re-appending the removed tail would
strand the new turn off-path, so `/redo` refuses with
`[!] redo stale: newer run completed` and keeps the record. Also: a
`/redo` after `/reset` re-applies files only (the session file is gone);
the ack then says `redone: N files`.

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

The trigger message is kept AND re-sent by the bridge on `session_start`
after the restart (the durable `rerun.json`, F1) — RPC-mode pi never
auto-prompts at startup, so without the re-send the prompt would sit in
context unanswered. KV of the assistant turn (and its file changes) is
gone. `/redo` brings both back exactly (post-snapshot), not as a fresh
re-derivation.

## Verification

`piscord/channel/undo.test.ts` (24 tests) + `index.test.ts` F1 bridge
tests: encPath round-trip; non-git modify+create undo/redo; deletion
undo; git worktree+staged+commit undo/redo; **binary file undo/redo
(F2)**; untracked keep/drop; session truncation (incl. in-flight trigger,
user-role triggers, assistant-less, **pre-truncation backup F8, no-trigger
abort F8**); **rerun park/consume + stale/mismatch drop (F1)**;
**empty-run skip (F3), redo stale guard (F4), prune pin (F5)**;
redo re-append; latestRun session alignment; prune to 10; e2e
conversation-only (with rerun consume); findSessionFile fallback;
**>20MB keep-not-delete (F7), session-file exclusion from untracked
copy-back (F10)**. F1 end-to-end at the bridge level: performUndo →
`session_start` → `pi.sendMessage` with the kept trigger text
(`index.test.ts`). Not deployed (worktree only).
