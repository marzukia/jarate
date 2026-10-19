/**
 * Column budget for IN-TURN tool-call frames only (the "bash …" live run
 * frames posted while a turn executes).
 *
 * 40 cols = the width a labeled line holds on the operator's phone:
 * measured 2026-09-15 with a labeled-line test, normal chat view (40
 * holds, 42 wraps; the zoomed code view fits ~31 - acceptable).
 *
 * The v3 width law (STYLE.md 2.3, 2026-09-16) once covered ALL framed
 * output (run frames, todo boards, /context, /jobs tail, webhook embed
 * frames). Andryo 2026-10-18 scoped it down: only in-turn tool-call
 * summaries stay framed and width-budgeted. Every other summary (todo
 * board, /jobs, /usage, /context, /tasks list, restart wake, handover
 * state) is normal Discord markdown that wraps natively - no column
 * limit. See docs/STYLE.md §2.
 */

/** Hard mobile budget: no in-turn frame line may exceed this many code points. */
export const FRAME_COL_MAX = 40;
