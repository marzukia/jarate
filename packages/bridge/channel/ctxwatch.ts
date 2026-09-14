// #13 — automatic context-boundary notice.
//
// One fenced line per 10% boundary crossed per pi session, edge-triggered
// on UPWARD crossings only. The first observation after process start,
// /reset, or /compact is the baseline (silent). /compact needs no special
// handling: it drops the pct, and a downward move never fires — the next
// upward crossing re-arms from the new level. /reset produces a new
// session file, which is a new tracker key (see ctxWatchers in index.ts).
//
// Line shape (ASCII tag, no emoji; fenced by the caller):
//   [ctx] 40% (104k/262k)
//
// The pct shown is the CURRENT usage at the crossing (the boundary is
// implicit); tokens/window are the raw figures, lowercase k/m. A single
// observation can only fire one line (a multi-boundary jump reports the
// current level; earlier steps stay silently passed — each boundary is
// still announced at most once per session).

export interface CtxWatchState {
  /** false until the first observation (the baseline, silent) */
  primed: boolean;
  /** highest 10% step already announced (0..10); -1 = none */
  lastStep: number;
}

export function newCtxWatch(): CtxWatchState {
  return { primed: false, lastStep: -1 };
}

/**
 * Lowercase compact token count: 999 -> "999", 104480 -> "104k",
 * 2_621_440 -> "2.6m". Non-finite/negative -> "?".
 */
export function fmtTokensLC(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const m = n / 1_000_000;
  return `${m >= 10 ? String(Math.round(m)) : m.toFixed(1)}m`;
}

/**
 * Observe one context sample. Returns the notice line when this
 * observation crosses an upward 10% boundary that has not been announced
 * yet, null otherwise — including the first (baseline) observation.
 * Mutates st.
 */
export function observeCtx(
  st: CtxWatchState,
  pct: number,
  tokens: number,
  window: number,
): string | null {
  if (
    !Number.isFinite(pct) ||
    !Number.isFinite(tokens) ||
    !Number.isFinite(window) ||
    window <= 0 ||
    tokens < 0 ||
    pct < 0
  )
    return null;
  const step = Math.min(10, Math.max(0, Math.floor(pct / 10)));
  if (!st.primed) {
    st.primed = true;
    st.lastStep = step;
    return null; // baseline: no notice on the first sample
  }
  if (step <= st.lastStep) return null;
  st.lastStep = step;
  const pctShown = Math.min(100, Math.round(pct));
  return `[ctx] ${pctShown}% (${fmtTokensLC(tokens)}/${fmtTokensLC(window)})`;
}
