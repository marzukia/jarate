# Changelog

Notable changes to the jarate stack (pi + piscord bridge). Newest first.

## 2026-10-23 — bg drain declared: the completion side is removed (#279)

The pi-bg/jarate-bg lane is drained (t180-verified: zero `state=running`
records fleet-wide; newest real bg run 2026-10-20). This is the completion
side of the drain per the remove-centralise audit (top-5 action 2); #283
already removed the retired pi-bg shims, this is the rest. Kept:
`dispatch/jarate-bg` (launch stub, exit 10 retirement notice; the `signal`
subcommand stays live until the fleet timer lands) and
`dispatch/pi-postcheck.sh` (live: pi-restart schedules it 90s after every
restart). Everything else in the completion side is gone:

- **Removed dispatch scripts:** `jarate-wait` (in-turn wait; the only
  producer of the `~/.pi-dispatch/in-turn-consumed` markers),
  `jarate-bg-tail`, `jarate-bg-kill`, and the last pi-* shim (`pi-wait`;
  the other four pi-bg* shims left in #283).
- **`/jobs` is history-only:** the in-flight ps view and the `kill`/`tail`
  subcommands (which spawned the removed scripts) are gone; the command
  renders the recent `~/.pi-bg-art` history (`/jobs json` for the machine
  object). The bridge's in-turn-consumed marker tracking
  (`hasInTurnConsumedMarker` + the re-wake drop) is removed with its only
  producer — queued machine-wakes now always re-wake.
- **install.sh pointer list 11 -> 2:** only `jarate-bg` + `pi-postcheck.sh`
  are owned/linked now; the nine retired names (pi-bg* x4, jarate-wait,
  jarate-bg-tail/-kill, pi-wait, jarate-bg-watchdog) get dangling-symlink
  cleanup on install.
- Docs: COMMANDS `/jobs` rows + section, SETUP/NEW-AGENT/DEPLOY symlink
  lists, DISPATCH component list, `deploy/pi.service` comment, bridge
  README + channel SKILL command lists.

Host cleanup is piboy's lane (listed for the record, not done here):
clean `~/.pi-bg-wt/*` + `~/.pi-bg-art` leftovers (they generate the daily
false-DEAD watchdog posts), stop nfsnap from backing up `~/.pi-dispatch`.

## 2026-10-21 — de-prefix: the visible `[bg:` line is gone (Andryo)

Operator decision (Andryo via warden): no visible `[bg:` lines in agent
channels. Every jarate machine-wake producer now ships EMPTY content +
ONE embed; the machine-wake marker is the EMBED AUTHOR:
`pi-bg <producer> · <STATUS>`.

- **Wake mechanics unchanged.** The delivery gate is `webhook_id != null`
  (`isBgWebhook`, since #270) — it was never the `[bg:` content prefix.
  `isBgCallbackBody` (queue-only semantics, silent queue, in-turn drop)
  now classifies the serialized embed body (`Author: pi-bg …`); the
  legacy `startsWith("[bg:")` arm stays ONE release for in-flight channel
  history, dead-letter re-posts (kept verbatim), and not-yet-restyled
  cross-repo producers (hall-monitor webhooks).
- **Producers restyled:**
  - restart-wake (`pi-bg restart-wake · planned|unplanned`)
  - pi-postcheck heartbeat (`pi-bg pi-restart · ok|fail`) — the visible
    healthy bot line is kept (bot API, no wake)
  - agent-watch OOM / SILENT / AGENT-DEAD cards
    (`pi-bg agent-watch · OOM|SILENT|AGENT-DEAD`) — SILENT/AGENT-DEAD
    gain a `user-<uid>:` description prefix (fleet roster: the peer's
    card lands in the operator channel and must say which agent)
  - fleetwork terminal (cross-repo: hall-monitor ships
    `pi-bg fleetwork · <state>`)
- **Unchanged:** the marker name `pi-bg`, restart-wake (restyled, not
  retired), dead-letter re-posts stay VERBATIM, SILENT near-misses stay
  yellow cards.
- Docs synced: `docs/DISPATCH.md` (card family, fallback, inbound
  exemption, dead letter, OOM, liveness), producer headers, test pins
  re-pinned to the new shape with legacy-shape pins kept where they
  document the migration window.
