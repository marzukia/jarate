// Pure core of the 3-consecutive-identical-finals drop guard (the
// channel/index.ts recordFinalRepeat repetition guard): given the streak
// of posted finals so far, decide whether a new candidate is dropped
// (third consecutive identical text = stuck loop) and return the streak
// to keep. index.ts holds the per-channel live state; the #315 last-sent
// extraction (last-sent.ts) replays the FULL transcript through this same
// predicate, so the doc's "Last sent message" field never carries a final
// the send pipeline dropped.
export interface FinalRepeatStep {
  /** true = third consecutive identical final — the send pipeline drops it. */
  drop: boolean;
  /** the streak after processing (reset to [] on a drop). */
  next: string[];
}

export function finalRepeatStep(
  streak: string[],
  text: string,
): FinalRepeatStep {
  const t = text.trim();
  const next =
    streak.length > 0 && streak[streak.length - 1] === t ? [...streak, t] : [t];
  if (next.length >= 3) return { drop: true, next: [] };
  return { drop: false, next };
}
