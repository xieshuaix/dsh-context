/**
 * Shared headless helpers for the Context Trend chart tests. The pure clip/scale logic (`trendChartClip.ts`) and the
 * adaptive viewport (`trendChartAdaptive.ts`) are exercised by `computeScale`, so the cases that build a synthetic
 * delta stream, slice a VISIBLE window and assert the "real-value cap" invariant all want the same small toolkit —
 * kept here so the specs stay focused on their scenarios instead of repeating the boilerplate.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { computeScale } from '../../../src/client/components/trendChartClip'
import { sideExtentsOf } from '../../../src/client/components/trendChartData'
import type { RequestRecord } from '../../../src/shared/types'

/** Bar-area height (px) — must match CHART_H in trendChartGeometry.ts. */
export const CHART_H = 112
/** Bar column pitch (BAR_W 14 + BAR_GAP 2) — must match trendChartGeometry.ts. */
export const BAR_CELL = 16

/** A request record for delta/scale tests (all category counts 0, so the delta transform is fully controlled by the
 * `override`s; the `time`/`seq`/`turn`/`step` are a fixed but valid shape). */
export function deltaReq(seq: number, over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    time: 1_700_000_000_000 + seq * 60_000, seq, turn: 1, step: seq - 1,
    system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, ...over,
  }
}

/** The delta-transformed up/down extents of a request WINDOW, plus all positive magnitudes (for the real-cap check). */
export function windowExtents(requests: RequestRecord[], start: number, end: number): { ups: number[]; downs: number[]; mags: number[] } {
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

/** The axis cap must be a real magnitude. 0 is always valid (an empty side, or a zero cap); a positive cap must be an
 * actual bar magnitude in the window (it may come from either side when a side is entirely outliers). */
export function assertRealCap(cap: number, mags: number[], label: string): void {
  if (cap === 0) return
  assert.ok(mags.includes(cap), `${label}: cap ${cap} must be an actual bar magnitude (window: ${mags.slice(0, 12).join(',')}…)`)
}

/** `computeScale` wrapper: `scaleOf(requests, { mode, start, end, clip })`. */
export function scaleOf(
  requests: RequestRecord[],
  opts: { mode: 'delta' | 'total'; start: number; end: number; clip: boolean },
): ReturnType<typeof computeScale> {
  return computeScale(requests, { mode: opts.mode, visStart: opts.start, visEnd: opts.end, clip: opts.clip })
}

/** The captured real session (1500 records) used as an end-to-end fixture. */
export function loadSessionFixture(): RequestRecord[] {
  return JSON.parse(readFileSync(join(__dirname, '..', '..', 'fixtures', 'outlier-session-step-raw.json'), 'utf8')) as RequestRecord[]
}
