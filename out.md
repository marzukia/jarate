# PR2 — Handoff Compaction: mechanism B (size-gated restart) + seed-on-boot

Branch: pi-bg/20260923-044432-549447 (on PR1 47a131ea)

## What changed

### a) Mechanism B — size-gated restart, post-settle (F1/F2/F4/F5)
- `session_compact` handler now runs `settleCompacting(ctx)` THEN
  `handoffRestartForSize(pi, ctx)` (F1: gate decides after the window is
  closed, so the restart op it opens cannot be swept by its own settle).
- The gate is deferred one macrotask (setTimeout 0): pi's MANUAL compact
  path calls the ctx.compact wrapper's onComplete belt (clearCompacting)
  AFTER the emit; a synchronous window open would be wiped by that belt.
- `maybeHandoffRestart` (index.ts): enabled + live file
  (`ctx.sessionManager.getSessionFile()`) > `restartFileCap` (default
  64_000_000) → beginRestartOp(op "handoff", label "handing-off",
  finalText `[ok] context handoff -> new session (file was N.N MB)`,
  marker `{seeded:false}`) + scheduleOpShutdown with preShutdown
  `moveSessionFileAside(ctx, liveFile)` (F5, explicit file) then
  `archiveStaleSessions(liveFile)` (F2: every other `*.jsonl` in the
  session dir → `*.jsonl.stale-<ts>`, so the respawn's `pi -c` resume
  target is provably small). Reuses the /reset chain verbatim
  (op window + marker + cursor rewind + bounded shutdown + systemd
  restart + watchdog). `/stop` cancels it unmodified.
- Skips (no-op): handoff disabled, no discord channel, no session file,
  file <= cap, or a settle-flushed /compact re-opened the window (label
  "compacting") — that compaction's own settle re-runs the gate.

### b) Seed-on-boot (F4)
- `OpMarker` gains `seeded?: boolean`; `writeOpMarker`/`beginRestartOp`
  gain an optional marker param (existing call sites unchanged).
- `consumeOpMarker(pi, ctx)` (exported): ONLY a marker with
  `op === "handoff"` && `seeded !== true` seeds: plain
  `pi.sendUserMessage(buildSeedKickoff(doc, storeDir))` — preamble +
  parseKickoff 3-line digest + `Read <abs storeDir>/latest.md before
  continuing. Answer the last pending user question if any.` (F8) — then
  flips `seeded=true` (crash-safety: flip AFTER send; a crash re-seeds
  next boot, harmless; flip-before-send would lose the seed). Not a
  channel-inbound entry: no Discord echo, doesn't pollute the next
  handover's last-asks. Ordinary boots (incl. OOM respawns without a
  handoff marker) never seed.
- Fresh-window guard (F4): `shouldHandoff` gains `freshWindow` flag —
  true when latest.md's `updated` stamp is < 5 min old
  (`HANDOFF_FRESH_WINDOW_MS`), wired in the session_before_compact
  handler. A just-seeded session (the doc was written in the very
  compaction that triggered the restart) is not handoff-eligible for a
  short window.

### c) MINOR fixes (PR1 review)
- MINOR-2: buildHandover's catch skips the "handover gen failed" post
  when `args.signal.aborted` (operator /stop — pi's cancel notice covers
  it).
- MINOR-4: `handover` added to `allowedWhileCompacting`.
- MINOR-1: threshold math UNCHANGED; comment added — 80%-of-total-window
  is intentional (Andryo option a); pi's auto compaction fires at ~94% of
  a 262K window, so auto compactions always hand off.

### d) F7 watchdog death + enable path
- `armRestartWatchdog`: after posting `[!] restart failed - check unit
  X`, it now `process.exit(1)` 500ms later (injectable via
  `setProcessExitHookForTest`) — a live process leaves the unit
  "active", so systemd Restart=always would never respawn.
- `HANDOFF_ENABLED=1|0|true|false` env path added to
  resolveHandoffSettings (env beats settings beats default).

## Files changed
- packages/bridge/channel/handover.ts — HANDOFF_ENABLED env, freshWindow
  flag + MINOR-1 comment, MINOR-2 abort check, lastHandoffAt /
  isHandoffFreshWindow / buildSeedKickoff.
- packages/bridge/channel/index.ts — mechanism B gate + archiveStale-
  Sessions + handoffRestartForSize, seeded op marker, consumeOpMarker
  boot seed, watchdog F7 exit, handover allowedWhileCompacting,
  freshWindow wiring.
- packages/bridge/channel/handover.test.ts — +8 tests (env flag,
  fresh-window gate, lastHandoffAt/isHandoffFreshWindow,
  buildSeedKickoff, MINOR-2 abort vs control).
- packages/bridge/channel/index.test.ts — +8 tests (under-cap no-op,
  over-cap full chain, disabled, settle-flush skip-then-restart, /stop
  during op, boot seed, ordinary boot no-seed, already-seeded no
  re-seed) + F7 exit assertion in the #28 watchdog test.

## Verification
- `bun x tsc --noEmit` (packages/bridge): clean.
- `bun test` (packages/bridge): 848 pass, 0 fail, 3028 expect() calls.
- `bunx biome check .` (repo root): exit 0; my 4 files have 0
  diagnostics (only pre-existing bin/jarate.test.ts warning+info remain,
  present on baseline).
- `HOME=/tmp/fake-home-dry bash install.sh --dry-run`: exit 0.

## How to enable (live box)
`handoff.enabled` stays FALSE in code. On the live box (monky) it is
ALREADY true in `~/.pi/agent/settings.json` (PR1 path opted in ahead of
this PR — out-of-scope change, no action needed). Otherwise:
- `~/.pi/agent/settings.json`: `{"handoff": {"enabled": true}}`, or
- pi.service env: `HANDOFF_ENABLED=1` (then restart pi — operator move).
Mechanism B then restarts on any compaction that leaves the live session
file over `handoff.restartFileCap` (default 64 MB; env
`HANDOFF_RESTART_FILE_CAP`).

## Deviations
- The gate is registered as ONE combined session_compact handler
  (settle, then gate) rather than a second listener — the test pi stubs
  are last-wins, so a separate listener would have replaced the settle
  handler and broken existing tests.
- Watchdog F7 exit is delayed 500ms after the Discord post so the
  failure line lands before the process dies; both timers unref'd.
- Fresh window keys on latest.md's `updated` stamp (doc write) as a
  proxy for seed time — also suppresses a 2nd handoff within 5 min of
  any mechanism A doc write (intentional, cheap).
