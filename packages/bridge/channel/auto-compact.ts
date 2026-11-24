// Shared error handling for the handoff token-% auto-compact gate
// (extracted from index.ts for the #381 timer-leg guard — index.ts is
// size-ratcheted, the new logic cannot land in the god file).
// Invariant (2026-10-19 #244; 2026-11-24 T3445, #381): a stale-ctx
// assert (pi's ExtensionRunner.assertActive, thrown by any ctx access
// after a session replacement or reload) must never escape the timer
// callback — it logs one leg-named line and the gate skips for this
// firing (the replacement session's own settle re-runs it).
import { sanitizeUnknownValue } from "./sanitize";

/** The pi-coding-agent stale-ctx assert message prefix (stable across
 *  pi versions); matched by prefix so the gate can name the class
 *  without pattern-matching a stack. */
const STALE_CTX_MSG =
  "This extension ctx is stale after session replacement or reload";

/** Error-class check for the pi stale-ctx assert (#381). */
export function isStaleCtxError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith(STALE_CTX_MSG);
}

/** Leg-named stale-skip log prefix. "gate" = the handoff leg's message
 *  (unchanged, #244); "timer" = the autoCompactByToken timer leg
 *  (distinguishable in the logs, #381). */
export function staleSkipPrefix(leg: "gate" | "timer"): string {
  return leg === "timer"
    ? "[handoff] auto-compact timer: stale ctx, skipping:"
    : "[handoff] auto-compact gate: stale ctx, skipping:";
}

/** The timer leg's error outlet (#381): a stale-ctx assert gets the
 *  leg-named skip line; any other failure gets the leg-named failure
 *  line. Neither escapes the Timeout callback. */
export function logTimerGateFailure(e: unknown): void {
  console.error(
    isStaleCtxError(e)
      ? staleSkipPrefix("timer")
      : "[handoff] auto-compact timer failed:",
    sanitizeUnknownValue(e),
  );
}
