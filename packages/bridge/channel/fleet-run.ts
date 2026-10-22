/**
 * Fleet dispatch run detection (hall-monitor fleetwork, 2026-10-20): the
 * run wrapper pins PI_SESSION_ID=fleetwork-<ticket> (pi sets its own UUID
 * for interactive sessions; the wrapper export is the discriminator) and
 * runs pi with CWD /srv/fleetwork/work/<ticket>.
 *
 * The channel extension is the agent-interactive bg runtime — a dispatch
 * run must not connect the channel, drain/scan the re-wake queue, or
 * register channel tools. Run events flow through the fleetwork wrapper
 * ([bg: fleetwork] <ticket> lines -> `pi-bg fleetwork` machine-wake
 * cards; the visible [bg: prefix was dropped 2026-10-21), not this bridge. (Pilot 2026-10-20:
 * dispatch runs 3/5/6 each posted an "unplanned restart" wake card to the
 * agent's own channel on start, re-waking the interactive agent with a
 * ticket event about a different process.)
 *
 * Lives in a sibling module (not index.ts) because index.ts is past the
 * 2,000-line export gate (harden-repo size rule: new code goes to a
 * sibling module).
 */
export function isFleetRun(): boolean {
  return (process.env.PI_SESSION_ID ?? "").startsWith("fleetwork-");
}
