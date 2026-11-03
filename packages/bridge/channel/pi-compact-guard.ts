// ─── Pi-initiated compact guard (2026-11-02 #franky TypeError class) ───
// A pi-initiated compaction (session_before_compact reason threshold|overflow - pi's own auto-compact, NOT the bridge's startCompact) does not open the channel op window, so while it is in flight the manual triggers (/compact /handover) and the token gate see no guard and their ctx.compact() collides with pi's in-flight compact (the #franky double-fire TypeError class). The guard is armed from session_before_compact (reason !== 'manual' - manual compacts are already owned by startCompact's op window), settled from the settle handlers (session_compact / session_compact_failed - an aborted pi compact settles through the failed event), and is BOUNDED: when no settle event arrives (a crash mid-compact), the stale timer clears the flag after PI_COMPACT_STALE_MS, so it can never leak and wedge the triggers.
let piCompactInFlight = false;
let piCompactStaleTimer: ReturnType<typeof setTimeout> | null = null;
/** Bounded stale window for the pi-compact guard: when no settle event arrives (a crash mid-compact), the arm self-clears after this, so the flag can never leak. */
export const PI_COMPACT_STALE_MS = 10 * 60 * 1000;

/** Arm the guard (idempotent; re-arming restarts the stale timer). */
export function armPiCompact(): void {
  if (piCompactStaleTimer) {
    clearTimeout(piCompactStaleTimer);
    piCompactStaleTimer = null;
  }
  piCompactInFlight = true;
  piCompactStaleTimer = setTimeout(() => {
    piCompactStaleTimer = null;
    if (piCompactInFlight) {
      piCompactInFlight = false;
      console.warn(
        `[channel] pi compact in flight for ${PI_COMPACT_STALE_MS / 60000} min without a settle event; clearing the guard (bounded stale window)`,
      );
    }
  }, PI_COMPACT_STALE_MS);
  (piCompactStaleTimer as any).unref?.();
}

/** Clear the guard (no-op when not set); called from the compact settle paths (session_compact / session_compact_failed). */
export function settlePiCompact(): void {
  piCompactInFlight = false;
  if (piCompactStaleTimer) {
    clearTimeout(piCompactStaleTimer);
    piCompactStaleTimer = null;
  }
}

/** True while a pi-initiated compaction is in flight (the manual triggers and the token gate yield to it). */
export function isPiCompactInFlight(): boolean {
  return piCompactInFlight;
}
