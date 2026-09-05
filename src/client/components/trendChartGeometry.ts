/**
 * Shared geometry / tuning constants for the Context Trend chart, split out of the component so the pure scale,
 * clip and adaptive-viewport logic can be tested without a DOM. Kept deliberately as literal numbers (not CSS
 * custom properties) because they are used in the px math (bar pitch, axis label offsets) and in tests.
 */

// Bar-area height (px) — the zero line and the arms divide this.
export const CHART_H = 112

// Constant bar width: sparse histories don't stretch bars, dense ones scroll instead of compressing.
export const BAR_W = 14
export const BAR_GAP = 2
// Adaptive-viewport clip: bars buffered on each side of the visible range so the axis cap does not flicker as a
// single bar slides over the viewport edge (the eye compares the visible bars anyway).
export const VIS_PAD = 2

// Outlier clip tuning: a side's cap uses a whole-body Tukey fence (Q3 + 2.5×IQR, floored at CLIP_CAP×median) so only
// EXTREME peaks are flagged — a natural spread's upper tail stays visible instead of being cut on every peak. A side is
// never clipped when the chart is too sparse to establish a body (MIN_BARS).
export const CLIP_CAP = 2.5
export const MIN_BARS = 4

// Turn strip fills (deliberately DISJOINT from the category palette — the partition layer must not read as data).
export const TURN_FILLS = ['rgba(128,128,128,0.12)', 'rgba(128,128,128,0.26)']
// Turn labels overflow their block; OVERHANG bounds how far a label can reach toward the viewport, GAP the breathing
// room between kept labels.
export const LABEL_OVERHANG = 48
export const LABEL_GAP = 4
