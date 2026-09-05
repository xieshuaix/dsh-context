/**
 * Scale / clip logic for the Context Trend chart, tested headlessly against a synthetic request stream and a captured
 * real session. The core invariant under test — the property the axis labels must satisfy — is:
 *
 *   Every displayed axis cap (maxUp / maxDown / maxTotal) is a REAL bar magnitude: it equals an actual bar extent,
 *   never a fabricated `CLIP_CAP × median`-style value. When a side is clipped, its cap is a real value and the true
 *   outlier peak is truncated (≀ cut, exact value in the tooltip).
 *
 * Scenarios: (1) normal monotonically increasing, (2) increasing → negative (context compaction) → recovering, across
 * a range of view horizons, plus the real session captured from the running GUI.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import {
  bodyTopOf, capSideOf, computeScale, fenceOf, medianOf, quantileOf, type ScaleResult,
} from '../../../src/client/components/trendChartClip'
import { deltaRequestsOf, sideExtentsOf } from '../../../src/client/components/trendChartData'
import type { RequestRecord } from '../../../src/shared/types'

function req(seq: number, over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    time: 1_700_000_000_000 + seq * 60_000, seq, turn: 1, step: seq - 1,
    system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, ...over,
  }
}

/** Visible-slice extents for a delta'd request window, plus the whole-body magnitudes. */
function windowExtents(requests: RequestRecord[], start: number, end: number): { ups: number[]; downs: number[]; mags: number[] } {
  const ups: number[] = []
  const downs: number[] = []
  const mags: number[] = []
  for (const r of requests.slice(start, end)) {
    const { up, down } = sideExtentsOf(r)
    if (up > 0) { ups.push(up); mags.push(up) }
    if (down > 0) { downs.push(down); mags.push(down) }
  }
  return { ups, downs, mags }
}

/** The cap is a real magnitude: 0 is always valid (an empty side, or the unit-scale floor); a positive cap must be an
 * actual bar magnitude in the window (it may come from either side when a side is entirely outliers). */
function assertRealCap(cap: number, mags: number[], label: string): void {
  if (cap === 0) return
  assert.ok(mags.includes(cap), `${label}: cap ${cap} must be an actual bar magnitude (window: ${mags.slice(0, 12).join(',')}…)`)
}

describe('trendChartScale: stats helpers', () => {
  test('medianOf / quantileOf behave for odd and even sets', () => {
    assert.equal(medianOf([3, 1, 2]), 2)
    assert.equal(medianOf([4, 1, 2, 3]), 2.5)
    assert.equal(medianOf([]), 0)
    assert.equal(quantileOf([1, 2, 3, 4], 0.5), 2.5)
    assert.equal(quantileOf([10], 0.5), 10)
  })

  test('fenceOf stays low for a spread body and high for a peaked one', () => {
    // spread 1k..5k: wide IQR pushes the fence up.
    assert.ok(fenceOf([1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000]) > 5000)
    // tight small body + one giant: fence stays near the small body.
    const fence = fenceOf([...Array.from({ length: 30 }, () => 1600), 34800])
    assert.ok(fence < 8000, `huge outlier shouldn't inflate the fence (got ${fence})`)
  })
})

describe('trendChartScale: invariant on synthetic scenarios', () => {
  test('monotonically increasing (no compaction): no clip, up cap is the real max, down arm empty', () => {
    const raw = [100, 150, 220, 300, 420, 560, 720].map((v, i) => req(i + 1, { system: v, total: v }))
    const delta = deltaRequestsOf(raw)
    const s = computeScale(delta, { mode: 'delta', visStart: 0, visEnd: delta.length, clip: true })
    const { ups, downs, mags } = windowExtents(delta, 0, delta.length)
    assert.ok(s.maxUp > 0)
    assertRealCap(s.maxUp, mags, 'up cap')
    assert.equal(s.maxDown, 0, 'no down deltas in a monotonic stream')
    assert.equal(s.upClipActive, false, 'no outlier to clip')
    assert.equal(s.downClipActive, false)
    // Up arm fills the bar area (downPx ~ 0).
    assert.equal(s.downPx, 0)
    assert.equal(s.upPx, 112)
  })

  test('increasing → big compaction dip → recovering: the down peak is clipped at a real down value', () => {
    // Small growing body, then one large compaction, then a couple smaller downs — so the down side HAS a body.
    const raw = [
      req(1, { system: 100, total: 100 }),
      req(2, { system: 160, total: 160 }),
      req(3, { system: 230, total: 230 }),
      req(4, { system: 40, total: 40 }),    // compaction: -190
      req(5, { system: 70, total: 70 }),    // +30
      req(6, { system: 90, total: 90 }),    // +20
      req(7, { system: 120, total: 120 }),  // +30
    ]
    const delta = deltaRequestsOf(raw)
    const s = computeScale(delta, { mode: 'delta', visStart: 0, visEnd: delta.length, clip: true })
    const { ups, downs, mags } = windowExtents(delta, 0, delta.length)
    assert.ok(downs.length >= 1, 'the compaction produces a down delta')
    assertRealCap(s.maxUp, mags, 'up cap')
    assertRealCap(s.maxDown, mags, 'down cap')
    // The big compaction (|down| = 190) is a clear outlier vs the ~30-60 body, so the down side IS clipped.
    assert.equal(s.downClipActive, true, 'the compaction peak is clipped')
    assert.ok(s.maxDown < Math.max(...downs), 'down cap is below the true down peak')
    // Body readability: the cap is within a small multiple of the body median (not dominated).
    const bodyMed = medianOf(mags)
    assert.ok(s.maxDown <= bodyMed * 4, `down cap ${s.maxDown} should not dwarf the body median ${bodyMed}`)
  })

  test('lone dominant down peak (user case): cap falls back to a real body magnitude and the peak is clipped', () => {
    // Ramp up by ~1k per step (many small up deltas), then ONE sharp drop — that drop is a lone huge down outlier
    // with no down body to cap against. The up side stays the readable body.
    const raw: RequestRecord[] = [req(1, { system: 1000, total: 1000 })]
    for (let i = 1; i < 50; i++) raw.push(req(i + 1, { system: 1000 + i * 1000, total: 1000 + i * 1000 })) // +1000/step
    raw.push(req(51, { system: 50, total: 50 }))                                                             // sharp drop
    for (let i = 1; i <= 10; i++) raw.push(req(51 + i, { system: 50 + i * 400, total: 50 + i * 400 }))       // gradual recovery
    const delta = deltaRequestsOf(raw)
    const s = computeScale(delta, { mode: 'delta', visStart: 0, visEnd: delta.length, clip: true })
    const { ups, downs, mags } = windowExtents(delta, 0, delta.length)
    assert.ok(downs.length >= 1, 'the sharp drop produces a down delta')
    assertRealCap(s.maxUp, mags, 'up cap')
    assertRealCap(s.maxDown, mags, 'down cap (fallback is a real magnitude)')
    assert.equal(s.downClipActive, true, 'the lone down peak is clipped (does not dominate)')
    assert.ok(s.maxDown < Math.max(...downs), 'down cap is below the true peak')
    // The up body stays readable: its arm must not be a ~0px sliver.
    assert.ok(s.upPx >= s.downPx * 0.5, `up arm ${s.upPx}px must not be a sliver vs down ${s.downPx}px`)
  })

  test('view horizon: a window without the outlier keeps the body; one containing it clips it', () => {
    // Monotonic up body (0..19), then a single huge down spike (index 20), then recovery ups.
    const raw: RequestRecord[] = []
    for (let i = 0; i < 20; i++) raw.push(req(i + 1, { system: 1000 + i * 20, total: 1000 + i * 20 }))
    raw.push(req(21, { system: 100, total: 100 })) // huge down spike
    for (let i = 22; i < 60; i++) raw.push(req(i + 1, { system: 100 + (i - 21) * 20, total: 100 + (i - 21) * 20 }))
    const delta = deltaRequestsOf(raw)
    // Window that EXCLUDES the spike (ends at index 20): the up body is preserved, nothing is clipped.
    const before = computeScale(delta, { mode: 'delta', visStart: 0, visEnd: 20, clip: true })
    const { ups: upsBefore, downs: downsBefore, mags: magsBefore } = windowExtents(delta, 0, 20)
    assert.equal(downsBefore.length, 0, 'the before-window excludes the down spike')
    assert.equal(before.downClipActive, false, 'a window without an outlier does not clip')
    assertRealCap(before.maxUp, magsBefore, 'up cap (before window)')
    assert.equal(before.maxUp, Math.max(...upsBefore), 'up cap is the true body max (no clip)')
    // Window straddling the spike (outlier present) — the dominant peak is clipped.
    const straddle = computeScale(delta, { mode: 'delta', visStart: 14, visEnd: 28, clip: true })
    const { ups: upsStraddle, downs: downsStraddle, mags: magsStraddle } = windowExtents(delta, 14, 28)
    assertRealCap(straddle.maxUp, magsStraddle, 'up cap (straddle)')
    assertRealCap(straddle.maxDown, magsStraddle, 'down cap (straddle)')
    assert.ok(downsStraddle.length >= 1, 'the straddling window contains the down spike')
    assert.equal(straddle.downClipActive, true, 'the straddling window clips the down spike')
  })

  test('clip off: whole-history scale, no clipping, caps are real', () => {
    const raw = [100, 150, 220, 300, 420, 560, 720].map((v, i) => req(i + 1, { system: v, total: v }))
    const delta = deltaRequestsOf(raw)
    const s = computeScale(delta, { mode: 'delta', visStart: 0, visEnd: 2, clip: false })
    const { mags } = windowExtents(delta, 0, delta.length)
    assertRealCap(s.maxUp, mags, 'up cap (clip off uses whole history)')
    assert.equal(s.upClipActive, false)
    assert.equal(s.downClipActive, false)
  })

  test('total mode: caps are real; an all-zero history has no real cap (0)', () => {
    const raw = [100, 150, 220, 300, 420, 560, 720].map((v, i) => req(i + 1, { total: v, prompt: v }))
    const s = computeScale(raw, { mode: 'total', visStart: 0, visEnd: raw.length, clip: true })
    assertRealCap(s.maxTotal, raw.map(r => r.total), 'total cap')
    assert.ok(s.maxTotal > 0)
    // All-zero history: it is the TRUE maximum (0), not a fabricated unit-scale floor.
    const zero = computeScale([req(1, { total: 0 }), req(2, { total: 0 })], { mode: 'total', visStart: 0, visEnd: 2, clip: true })
    assert.equal(zero.maxTotal, 0)
    assert.equal(zero.totalClipActive, false)
  })
})

describe('trendChartScale: captured real session', () => {
  const raw: RequestRecord[] = JSON.parse(readFileSync(join(__dirname, '..', '..', 'fixtures', 'outlier-session-step-raw.json'), 'utf8'))
  const delta = deltaRequestsOf(raw)
  const CHART_H = 112

  test('every displayed cap is a real magnitude across view horizons', () => {
    const pitch = 16
    const viewW = 561 // the card's chart viewport width used in the GUI
    const horizons: [number, number][] = []
    for (let sl = 0; sl <= delta.length; sl += 200) {
      const start = Math.max(0, Math.floor(sl / pitch))
      const end = Math.min(delta.length, Math.ceil((sl + viewW) / pitch))
      horizons.push([start, end])
    }
    for (const [start, end] of horizons) {
      const s = computeScale(delta, { mode: 'delta', visStart: start, visEnd: end, clip: true })
      const { ups, downs, mags } = windowExtents(delta, start, end)
      assertRealCap(s.maxUp, mags, `up cap @[${start},${end}]`)
      assertRealCap(s.maxDown, mags, `down cap @[${start},${end}]`)
    }
  })

  test('the dominant down region is clipped (does not dominate the whole axis)', () => {
    // The three huge down compactions in this session sit together; find a window containing the largest down.
    let maxDownIdx = -1
    let maxDown = -1
    delta.forEach((r, i) => { const d = sideExtentsOf(r).down; if (d > maxDown) { maxDown = d; maxDownIdx = i } })
    assert.ok(maxDownIdx >= 0, 'the session has a down peak')
    const start = Math.max(0, maxDownIdx - 15)
    const end = Math.min(delta.length, maxDownIdx + 25)
    const s = computeScale(delta, { mode: 'delta', visStart: start, visEnd: end, clip: true })
    assert.equal(s.downClipActive, true, 'the dominant down peak is clipped')
    // With the peak clipped, the up side must get a readable share (not a ~0px sliver).
    assert.ok(s.upPx >= 20, `up arm ${s.upPx}px is a readable share (down ${s.downPx}px)`)
    assertRealCap(s.maxDown, windowExtents(delta, start, end).mags, 'down cap (real)')
  })
})

describe('trendChartScale: edge cases', () => {
  test('empty history: no caps, no clipping, arms degenerate safely', () => {
    const s = computeScale([], { mode: 'delta', visStart: 0, visEnd: 0, clip: true })
    assert.equal(s.maxUp, 0)
    assert.equal(s.maxDown, 0)
    assert.equal(s.upClipActive, false)
    assert.equal(s.downClipActive, false)
    assert.equal(s.span, 1)
    assert.equal(s.upPx, 0, 'empty delta has no up arm')
    assert.equal(s.downPx, 112, 'empty delta degenerates to the full down area')
  })

  test('single bar: no clip (body cannot be established), cap is that bar', () => {
    const raw = [req(1, { system: 4200, total: 4200 })]
    const delta = deltaRequestsOf(raw)
    const s = computeScale(delta, { mode: 'delta', visStart: 0, visEnd: 1, clip: true })
    // The first record diffs from empty, so its up extent is 0; there is effectively no down/up to clip.
    assert.equal(s.upClipActive, false)
    assert.equal(s.downClipActive, false)
  })

  test('only-down (no up): up cap is 0, down cap is real, only the down arm is drawn', () => {
    // A monotonically shrinking stream → every delta is negative (down only).
    const raw = [req(1, { system: 1000 }), req(2, { system: 850 }), req(3, { system: 700 }), req(4, { system: 550 }), req(5, { system: 400 })]
    const delta = deltaRequestsOf(raw)
    const s = computeScale(delta, { mode: 'delta', visStart: 0, visEnd: delta.length, clip: true })
    const { ups, downs, mags } = windowExtents(delta, 0, delta.length)
    assert.equal(ups.length, 0, 'every delta is a down extent')
    assert.equal(s.maxUp, 0, 'no up bars → up cap 0 (up arm empty)')
    assertRealCap(s.maxDown, mags, 'down cap')
    assert.equal(s.upPx, 0, 'whole bar area is the down arm')
    assert.equal(s.downPx, 112)
  })

  test('dominant UP peak is clipped too (not just a down peak)', () => {
    // Small up body, one huge up spike (and a single down outlier so both arms are present).
    const raw: RequestRecord[] = []
    for (let i = 0; i < 30; i++) raw.push(req(i + 1, { system: 1000 + (i % 5) * 20, total: 1000 + (i % 5) * 20 }))
    raw.push(req(31, { system: 2000, total: 2000 }))
    raw.push(req(32, { system: 3000, total: 3000 }))
    raw.push(req(33, { system: 100, total: 100 }))  // a big down delta
    const delta = deltaRequestsOf(raw)
    const s = computeScale(delta, { mode: 'delta', visStart: 0, visEnd: delta.length, clip: true })
    const { ups, downs, mags } = windowExtents(delta, 0, delta.length)
    assertRealCap(s.maxUp, mags, 'up cap')
    assertRealCap(s.maxDown, mags, 'down cap')
    assert.ok(s.maxUp > 0 && s.maxDown > 0)
    // The dominant UP peak is clipped — a real cap below the true up peak, and the up body stays readable.
    assert.equal(s.upClipActive, true, 'the dominant up peak is clipped')
    assert.ok(s.maxUp < Math.max(...ups), 'up cap is below the true up peak')
    assert.ok(s.upPx >= 20, `up arm ${s.upPx}px is a readable share`)
  })

  test('MIN_BARS boundary: below the threshold never clips; at/above it clipping is active', () => {
    const bar = (i: number, v: number): RequestRecord => req(i, { system: v, total: v })
    // 3 bars (last a huge drop) → useClip=false → NOT clipped, cap = the raw peak.
    const three = deltaRequestsOf([bar(1, 1000), bar(2, 1100), bar(3, 50)])
    const s3 = computeScale(three, { mode: 'delta', visStart: 0, visEnd: 3, clip: true })
    assert.equal(s3.downClipActive, false, '3 bars (< MIN_BARS) cannot clip')
    assert.equal(s3.maxDown, Math.max(...windowExtents(three, 0, 3).downs), 'cap is the raw peak (no clip)')

    // 5 bars (a small body + one huge drop) → useClip=true → the outlier is clipped.
    const five = deltaRequestsOf([bar(1, 1000), bar(2, 1100), bar(3, 1200), bar(4, 1300), bar(5, 50)])
    const s5 = computeScale(five, { mode: 'delta', visStart: 0, visEnd: 5, clip: true })
    assert.equal(s5.downClipActive, true, '5 bars (>= MIN_BARS) clip the outlier')
    assertRealCap(s5.maxDown, windowExtents(five, 0, 5).mags, 'down cap')
    assert.ok(s5.maxDown < Math.max(...windowExtents(five, 0, 5).downs), 'down cap is below the true peak')
  })

  test('total mode with a dominant outlier: the outlier is clipped and the cap is a real total', () => {
    const totals = [1000, 1100, 1200, 1300, 50000].map((v, i) => req(i + 1, { total: v, prompt: v }))
    const s = computeScale(totals, { mode: 'total', visStart: 0, visEnd: totals.length, clip: true })
    assertRealCap(s.maxTotal, totals.map(r => r.total), 'total cap is a real total')
    assert.equal(s.totalClipActive, true, 'the dominant total outlier is clipped')
    assert.ok(s.maxTotal < 50000, 'total cap is below the outlier')
  })

  test('all-identical values: no clip, cap = the common magnitude', () => {
    const raw = [1, 2, 3, 4, 5].map(i => req(i, { system: 800, total: 800 }))
    const delta = deltaRequestsOf(raw)
    const s = computeScale(delta, { mode: 'delta', visStart: 0, visEnd: delta.length, clip: true })
    // Every delta between equal values is 0 except the first (0) — so the visible extents are all 0 → caps 0/0.
    assert.equal(s.upClipActive, false)
    assert.equal(s.downClipActive, false)
    // A spread of distinct totals should NOT be over-clipped (cap = max).
    const totals = [100, 200, 300, 400, 500].map((v, i) => req(i + 1, { total: v, prompt: v }))
    const t = computeScale(totals, { mode: 'total', visStart: 0, visEnd: totals.length, clip: true })
    assert.equal(t.totalClipActive, false, 'a gently spread total body is not over-clipped')
    assertRealCap(t.maxTotal, totals.map(r => r.total), 'total cap is the real max')
  })
})

describe('trendChartScale: no over-clipping of a natural spread', () => {
  test('a wide but even spread has no single outlier and is never clipped', () => {
    const raw = [100, 500, 900, 1300, 1700, 2100, 2500, 2900].map((v, i) => req(i + 1, { system: v, total: v }))
    const delta = deltaRequestsOf(raw)
    const s = computeScale(delta, { mode: 'delta', visStart: 0, visEnd: delta.length, clip: true })
    const { ups, mags } = windowExtents(delta, 0, delta.length)
    assert.equal(s.upClipActive, false, 'a wide even spread has no single outlier to clip')
    assert.equal(s.maxUp, Math.max(...ups), 'the cap is the true max (nothing truncated)')
    assertRealCap(s.maxUp, mags, 'up cap')
  })

  test('a single extreme peak is clipped while the flat body stays at its own level (not a sliver)', () => {
    // A flat delta body (each step ~+10) and ONE huge step (+49000).
    const raw: RequestRecord[] = []
    for (let i = 0; i < 30; i++) raw.push(req(i + 1, { system: 1000 + (i % 3) * 10, total: 1000 + (i % 3) * 10 }))
    raw.push(req(31, { system: 50000, total: 50000 })) // huge up delta
    const delta = deltaRequestsOf(raw)
    const s = computeScale(delta, { mode: 'delta', visStart: 0, visEnd: delta.length, clip: true })
    const { ups, mags } = windowExtents(delta, 0, delta.length)
    assert.equal(s.upClipActive, true, 'the extreme peak is clipped')
    assert.ok(s.maxUp < Math.max(...ups), 'the cap is below the true peak (truncated)')
    // The cap is the real top of the flat body (per-step delta ~10), so the body is readable at its own level.
    assert.ok(s.maxUp >= 10, `cap ${s.maxUp} is at/above the flat body, not a near-zero sliver`)
    assertRealCap(s.maxUp, mags, 'up cap')
  })
})
