// #328: one post per restart — the shared once-per-process flag.
//
// A process start that is a restart gets exactly ONE post in the agent
// channel:
//   - planned class (fresh clean-stop marker): the startup message is
//     the post; the restart-wake card is NOT sent (no hall-monitor
//     card). The flag stays unset, so the startupMessage post path
//     posts as usual.
//   - unplanned/unclean class: the restart-wake card is the post.
//     runRestartWake sets this flag at classification (before the claim
//     and the post), and every startupMessage post site in discord.ts
//     reads it and skips the post for this start. A deduped
//     crash-flap start (second unplanned start) also sets it: the
//     first start owns the card, and the second start must not add a
//     second post.
//   - non-restart start (reason != "startup"): runRestartWake returns
//     "not-startup" before classification, the flag stays unset, and
//     the startup message posts as today (behavior unchanged).
//
// The #322 G3 dedup (crash-flap, 5m posted-claim window) remains the
// backstop for unplanned double-starts; this flag only governs the
// startupMessage post path.
//
// Pattern: the version-drift checkedOnce flag (once per process, safe
// under the fire-and-forget wake, test-hook reset for unit tests).

let startupMessageSuppressed = false;

/** Set by the restart-wake path on an unplanned (unclean) start: the
 *  restart-wake card is the one post for this start. Idempotent; once
 *  set for the process, the startupMessage post is skipped everywhere. */
export function suppressStartupMessageForThisStart(): void {
  startupMessageSuppressed = true;
}

/** Read by every startupMessage post site: true = skip the post for
 *  this start (the restart-wake card owns the one post). */
export function isStartupMessageSuppressedForThisStart(): boolean {
  return startupMessageSuppressed;
}

/** Test hook: re-arm the once-per-process flag between unit tests. */
export function resetStartupMessageSuppressionForTests(): void {
  startupMessageSuppressed = false;
}
