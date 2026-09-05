/**
 * Adaptive-viewport window computation for the Context Trend chart. Pure — no DOM — so it is tested with a synthetic
 * scroll position + view width + bar count.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { visibleWindowOf } from '../../../src/client/components/trendChartAdaptive'

describe('visibleWindowOf', () => {
  test('no laid-out width falls back to the whole history', () => {
    assert.deepEqual(visibleWindowOf(0, 0, 100), { start: 0, end: 100 })
  })

  test('a viewport at the left edge covers the first columns (with a VIS_PAD buffer)', () => {
    const { start, end } = visibleWindowOf(0, 16 * 20, 100) // 20 bars visible
    assert.equal(start, 0)
    assert.ok(end >= 20, `left edge should include ~20 bars + buffer, got end ${end}`)
  })

  test('a viewport at the right edge clamps to the bar count', () => {
    const { end } = visibleWindowOf(16 * 90, 16 * 20, 100) // scroll to the last bars
    assert.equal(end, 100)
    assert.ok(end > 90)
  })

  test('the window tracks the scroll position (moves right as scrollLeft grows)', () => {
    const a = visibleWindowOf(0, 16 * 20, 1000)
    const b = visibleWindowOf(16 * 500, 16 * 20, 1000)
    assert.ok(b.start > a.start, 'window moves with scroll')
    // The window starts at the first visible column minus the VIS_PAD buffer (2 bars).
    assert.ok(b.start >= 500 - 2, `right-scrolled window should start near ${500}, got ${b.start}`)
  })

  test('a very narrow window at the left edge is widened to exactly MIN_BARS', () => {
    // 1 visible column (+VIS_PAD both sides) is < MIN_BARS at the left edge → widened symmetrically to exactly 4.
    const w = visibleWindowOf(0, 16, 1000)
    assert.equal(w.end - w.start, 4, `window widened to exactly MIN_BARS, got ${w.end - w.start}`)
  })

  test('a short history still returns a valid, in-range window', () => {
    const w = visibleWindowOf(0, 16 * 20, 3)
    assert.ok(w.start >= 0 && w.end <= 3)
    assert.ok(w.start < w.end || w.end === 3)
  })
})
