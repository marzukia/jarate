# Changelog

Notable changes to the jarate stack (pi + piscord bridge). Newest first.

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
