# Dispatch (orchestration pattern)

> **Retirement note (hall-monitor #35, 2026-10-20):** `jarate-bg`'s launch
> path is RETIRED (stub, rc 10). New dispatches go to hall-monitor
> fleetwork (`POST http://100.95.144.25:8001/api/fleet/dispatch`); in-flight
> tickets dispatched before retirement keep running under the old topology,
> and the watchdog/tail/kill completion side stays alive until they drain.
> See `dispatch/jarate-bg` for the full notice.

Dispatch lives in the fleet control plane: **hall-monitor fleetwork** —
`POST` [http://100.95.144.25:8001/api/fleet/dispatch](http://100.95.144.25:8001/api/fleet/dispatch)
(auth: `X-Agent-Key`), API reference (Swagger):
[http://100.95.144.25:8001/api/docs](http://100.95.144.25:8001/api/docs).
This page is the pointer (text-only trim, #281): the runbook that was here —
worker/reviewer topology, fleet caps, worktrees, callback protocol, retry
classes, tail/kill, `jarate-wait` internals, watchdog sweep internals — is
retired history; the last full revision is in this file's git history.

What `dispatch/` in this repo still holds:

- `jarate-bg` — launch stub (exit 10 retirement notice); the `signal`
  subcommand stays live until the fleet timer lands
- `jarate-bg-watchdog` — completion sweep; live until the split to
  hall-monitor (t180 audit action 3)
- `pi-postcheck.sh` — restart health check + heartbeat (live: pi-restart
  schedules it 90s after every restart)

Dead config the retired lane left behind (no in-tree consumer — obsolete):

- `PI_BG_KILL_WAIT` env — sole consumer was `jarate-bg-kill` (removed with
  the drain, #279)
- `~/.pi-dispatch/in-turn-consumed/` — marker dir; producer (`jarate-wait`)
  and consumer (the bridge's marker tracking) both removed (#279); stale
  files linger and are covered by the documented `~/.pi-dispatch` host
  cleanup (CHANGELOG 2026-10-23)
- `~/.config/pi-dispatch/webhook_author` — sole consumer was `jarate-wait`
  (removed, #279); `jarate setup` still writes it, nothing reads it.
  (`~/.config/pi-dispatch/webhook` is NOT dead: `pi-postcheck.sh`, the
  watchdog, and the bridge's restart-wake all read it.)
