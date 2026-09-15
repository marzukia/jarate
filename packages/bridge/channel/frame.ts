/**
 * v3 frame width law (STYLE.md 2.3, 2026-09-15): every rendered frame
 * line — run frames, todo boards, /context, /jobs tail, webhook embed
 * frames — fits the mobile budget. ONE constant; every fit budget
 * derives from it. Measured on Andryo's phone 2026-09-15 (labeled-line
 * test, normal chat view): 40 holds, 42 wraps; the zoomed code view
 * fits ~31 (acceptable). Earlier "40 wraps" reports were 42-43-col
 * lines and/or the zoomed view.
 */

/** Hard mobile budget: no rendered frame line may exceed this many code points. */
export const FRAME_COL_MAX = 40;
