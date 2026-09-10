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

So conversation revert = **truncate the JSONL + respawn**:

- Walk the active path leaf→root (`parentId` chain), find the last
  assistant message, then the closest **trigger** before it (a `role:user`
  message or the `custom_message` entries piscord queues — channel inbound
  arrives as the latter, so both must count).
- Atomically rewrite the file keeping everything through that trigger
  (the trigger itself stays, so pi re-processes the prompt; any in-flight
  trailing trigger from an aborted run is removed with the turn).
- `ctx.shutdown()` 800ms later — identical mechanism to `/reset`
  (systemd `Restart=always` re-runs `pi -c`). `restarted=true` in the
  result lets the test prove a restart is required.

The removed lines are parked for `/redo`.

### 2. File changes — (a) vs (b), chosen per cwd

- **(a) git** (when cwd is a worktree): capture `HEAD` +
  `git diff HEAD` (worktree incl. staged) + untracked file copies at run
  start (pre) and run end (post). Restore = `reset --hard <head>` +
  `git apply <patch>` + untracked copy-back + delete untracked files that
  appeared after the snapshot. Because restore moves the branch pointer,
  **commits made during the run are undone too** (verified by test).
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
  `bash`-modified files are NOT tracked (best-effort, same gap as kimaki).

Storage: `~/.pi/agent/undo/runs/<seq>_<ts>/{pre,post}/` + `meta.json`,
pruned to the last 10, 20MB per-file cap. Store root reads
`process.env.HOME` at call time (Bun caches `os.homedir()`, so tests can
redirect HOME).

### 3. /redo semantics

**One level deep.** `/undo` writes `~/.pi/agent/undo/redo.json`
(run dir + removed session lines); `/redo` applies the run's **post**
snapshot and re-appends the removed lines, then consumes the record.
A second `/redo` says `[!] nothing to redo`. No stack — Andryo's spec.

### 4. Permissions / ack format

- Owner-only via the existing `runChannelCommand` pattern
  (`isOwner` check + shared `ownerOnly` message); non-owners see
  "Owner only: /<cmd>".
- Acks (no emoji, `[ok]`/`[!]` style):
  - `[ok] undone: 2 files + conversation`
  - `[ok] undone: 1 file` (files-only run)
  - `[ok] undone: conversation` (no matching store entry)
  - `[!] nothing to undo`
  - `[ok] redone: ...` / `[!] nothing to redo`

## Busy-agent handling

`/undo` while the agent is mid-run: `ctx.abort()` (sets `userStoppedRun`
so the aborted tail is not posted as a failure), wait 900ms for
`agent_end` (which finalizes the in-flight run's snapshot), then revert.
Race is best-effort — same tolerance as `/stop`.

## What stays in context after /undo

The trigger message is kept, so the next pi step re-runs the prompt from
the pre-run state. KV of the assistant turn (and its file changes) is
gone. `/redo` brings both back exactly (post-snapshot), not as a fresh
re-derivation.

## Verification

`piscord/channel/undo.test.ts` (15 tests): encPath round-trip; non-git
modify+create undo/redo; deletion undo; git worktree+staged+commit
undo/redo; untracked keep/drop; session truncation (incl. in-flight
trigger, user-role triggers, assistant-less); redo re-append;
latestRun session alignment; prune to 10; e2e conversation-only;
findSessionFile fallback. Full suite 226 pass / 0 fail, tsc clean,
biome clean. Not deployed (worktree only).
