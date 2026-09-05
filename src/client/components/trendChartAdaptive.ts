/**
 * Adaptive-viewport window: derive the visible bar index range from the scroller's geometry. Pure (no DOM) so it can
 * be tested with a synthetic scroll position + view width + bar count, and reused by the chart's scroll handler.
 * Bars occupy a uniform BAR_W + BAR_GAP column pitch.
 */

import { BAR_W, BAR_GAP, MIN_BARS, VIS_PAD } from './trendChartGeometry'

export interface VisibleWindow {
  start: number
  end: number
}

/**
 * Compute the visible bar-index window `[start, end)` from a scroll position and viewport width. A container with no
 * laid-out width (jsdom, a hidden/handoff render) cannot define a viewport, so the WHOLE history is returned — the
 * same as when the clip is off. A window narrower than MIN_BARS is widened symmetrically so the body scale is always
 * established.
 */
export const visibleWindowOf = (scrollLeft: number, clientWidth: number, barCount: number): VisibleWindow => {
  if (clientWidth <= 0) return { start: 0, end: barCount }
  const pitch = BAR_W + BAR_GAP
  const right = scrollLeft + clientWidth
  let start = Math.max(0, Math.floor(scrollLeft / pitch) - VIS_PAD)
  let end = Math.min(barCount, Math.ceil(right / pitch) + VIS_PAD)
  if (end - start < MIN_BARS) {
    const want = Math.min(barCount, MIN_BARS)
    start = Math.max(0, Math.min(Math.round((start + end) / 2 - want / 2), barCount - want))
    end = start + want
  }
  return { start, end }
}
