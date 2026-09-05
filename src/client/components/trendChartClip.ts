/**
 * Pure outlier-clip + scale resolution for the Context Trend chart y-axis. No DOM, no React.
 *
 * The whole-body Tukey fence decides WHAT is an outlier, but every displayed axis value is REAL: the caps
 * (maxUp/maxDown/maxTotal) are actual bar magnitudes, and the only other label is the true zero line. The cap for a
 * side is the largest real value on that side inside the fence, or — when a whole side is outliers — the whole-body's
 * top real magnitude, so a dominant peak is truncated at a real data level instead of dominating. `computeScale` turns
 * a (delta-transformed) request list + a view horizon into the exact numbers the chart draws (caps, clip flags,
 * zero-line geometry), so it can be tested headlessly.
 */

import type { RequestRecord } from '../../shared/types'
import { barTotalOf, sideExtentsOf } from './trendChartData'
import { CHART_H, CLIP_CAP, MIN_BARS } from './trendChartGeometry'

export interface ScaleParams {
  mode: 'delta' | 'total'
  /** Half-open visible bar index range (the view horizon); clamped to the request list. */
  visStart: number
  visEnd: number
  /** Whether the ≀ axis-clip is enabled (plugin setting). */
  clip: boolean
}

export interface ScaleResult {
  mode: 'delta' | 'total'
  // Delta side caps (0 when the side is empty; total mode leaves these 0).
  maxUp: number
  maxDown: number
  // Total anchor cap.
  maxTotal: number
  upClipActive: boolean
  downClipActive: boolean
  totalClipActive: boolean
  // Delta zero-line geometry.
  span: number
  deltaScale: number
  upPx: number
  downPx: number
  // The whole-body fence used (observability + tests).
  fence: number
}

/** Median of a set, or 0 for an empty set; the clip's robust "body" reference. */
export const medianOf = (xs: number[]): number => {
  const n = xs.length
  if (n === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(n / 2)
  return n % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Linear-interpolated quantile of an ASCENDING-sorted array; p ∈ [0,1]. */
export const quantileOf = (sorted: number[], p: number): number => {
  const n = sorted.length
  if (n === 1) return sorted[0]
  const idx = (n - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/**
 * Robust Tukey outlier fence over a set of magnitudes (Q3 + 1.5 × IQR, floored at CLIP_CAP × the median): a single
 * dominant peak is flagged as outside the body while a genuinely spread body raises the fence and stays uncapped.
 * Infinity when there are no positive magnitudes.
 */
export const fenceOf = (mags: number[]): number => {
  const vals = mags.filter(v => v > 0)
  if (vals.length === 0) return Infinity
  const sorted = [...vals].sort((a, b) => a - b)
  const q1 = quantileOf(sorted, 0.25)
  const q3 = quantileOf(sorted, 0.75)
  const median = medianOf(sorted)
  const iqr = q3 - q1
  // A conservative Tukey fence (2.5×IQR, not the classic 1.5×) so only EXTREME peaks are flagged as outliers — a
  // natural spread's upper tail stays visible instead of being cut and ≀-marked on every peak.
  return Math.max(q3 + 2.5 * iqr, median * CLIP_CAP)
}

/**
 * The body's top REAL magnitude — the largest value at or under the fence. This is the value used to cap a side that
 * is ENTIRELY outliers (no in-fence value on it, e.g. a side holding only one giant compaction among a small body):
 * it is a genuine bar magnitude (so the axis label is real), it keeps the opposite side's body readable, and the true
 * outlier peak is drawn truncated with a ≀ cut.
 */
export const bodyTopOf = (mags: number[], fence: number): number => {
  const within = mags.filter(v => v > 0 && v <= fence)
  // The fence is always ≥ the smallest positive magnitude (fence ≥ CLIP_CAP × median ≥ min), so `within` is only
  // empty when no positive magnitude exists (an empty/all-zero body) — then there is no body to cap at, so 0.
  return within.length > 0 ? Math.max(...within) : 0
}

/**
 * Cap one axis side (delta up/down, or the total anchor) with a REAL value: the largest value on that side still
 * inside the fence. If the WHOLE side is outliers (no in-fence value — a side holding only one giant bar), the cap
 * falls back to `bodyTop`, the whole-body's largest real magnitude, so the peak is still truncated at a real data
 * level instead of dominating the axis. `want=false` (toggle off / too sparse) returns the raw peak. An empty side
 * returns cap 0.
 */
export const capSideOf = (sideVals: number[], fence: number, bodyTop: number, want: boolean): { cap: number; clipped: boolean } => {
  const vals = sideVals.filter(v => v > 0)
  if (vals.length === 0) return { cap: 0, clipped: false }
  const peak = Math.max(...vals)
  if (!want) return { cap: peak, clipped: false }
  const inFence = vals.filter(v => v <= fence)
  const cap = inFence.length > 0 ? Math.max(...inFence) : bodyTop
  return { cap, clipped: cap < peak }
}

/**
 * Resolve the y-axis scale for a view horizon. `requests` must already be delta-transformed in delta mode (raw
 * otherwise) — the same array the component renders. `visStart`/`visEnd` define the horizontal view; when `clip` is
 * off, the scale is computed over the WHOLE list for a stable, non-adaptive reference.
 */
export const computeScale = (requests: RequestRecord[], p: ScaleParams): ScaleResult => {
  const { mode, visStart, visEnd, clip } = p
  const useClip = clip && requests.length >= MIN_BARS
  const source = useClip ? requests.slice(visStart, visEnd) : requests
  const empty: ScaleResult = {
    mode, maxUp: 0, maxDown: 0, maxTotal: 0, upClipActive: false, downClipActive: false, totalClipActive: false,
    span: 1, deltaScale: 0, upPx: 0, downPx: CHART_H, fence: 0,
  }
  if (mode === 'delta') {
    const ups: number[] = []
    const downs: number[] = []
    const mags: number[] = []
    for (const req of source) {
      const { up, down } = sideExtentsOf(req)
      if (up > 0) { ups.push(up); mags.push(up) }
      if (down > 0) { downs.push(down); mags.push(down) }
    }
    const fence = fenceOf(mags)
    const bodyTop = bodyTopOf(mags, fence)
    const upClip = capSideOf(ups, fence, bodyTop, useClip)
    const downClip = capSideOf(downs, fence, bodyTop, useClip)
    const maxUp = upClip.cap
    const maxDown = downClip.cap
    const span = Math.max(1, maxUp + maxDown)
    const deltaScale = CHART_H / span
    const upPx = Math.round(maxUp * deltaScale)
    const downPx = CHART_H - upPx
    return {
      mode, maxUp, maxDown, maxTotal: 1, upClipActive: upClip.clipped, downClipActive: downClip.clipped,
      totalClipActive: false, span, deltaScale, upPx, downPx, fence,
    }
  }
  const totals = source.map(barTotalOf)
  const fence = fenceOf(totals)
  const bodyTop = bodyTopOf(totals, fence)
  const totalClip = capSideOf(totals, fence, bodyTop, useClip)
  // maxTotal is the REAL total cap (0 for an empty/all-zero history). The bar-height division guards against a
  // zero divisor by skipping 0-value segments, so an empty history keeps a unit scale internally without the axis
  // emitting a fabricated value — the caller only labels a cap when it is > 0.
  return {
    ...empty, mode, maxTotal: totalClip.cap, totalClipActive: totalClip.clipped, fence,
  }
}
