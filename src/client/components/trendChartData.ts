/**
 * Pure data transforms for the Context Trend chart: the anchor heuristic, the bar total, the delta transform and
 * the per-request up/down side extents. No DOM, no React — importable by the component and by tests.
 */

import type { RequestRecord } from '../../shared/types'
import { CATS } from '../categories'

/** Anchor bar HEIGHT to the provider-reported prompt when the request carried usage (matches the overview card and
 * the official chat ring), not the underpriced heuristic estimate. */
export const anchorOf = (req: RequestRecord): number =>
  typeof req.prompt === 'number' && req.prompt > 0 && req.total > 0 ? req.prompt / req.total : 1

/** The bar's anchor total: the provider-reported prompt, else the total. Same value the height and axis use. */
export const barTotalOf = (req: RequestRecord): number =>
  typeof req.prompt === 'number' && req.prompt > 0 ? req.prompt : req.total

/**
 * Delta mode: each category keeps the SIGNED change vs the previous record so bars can diverge above/below the zero
 * line; `total` is the churn (summed magnitude) and `net` the signed change for the tooltip. The first request
 * starts from zero, and per-request provider prompt/output are dropped (they are not deltas).
 */
export const deltaOf = (req: RequestRecord, prev: RequestRecord | null): RequestRecord => {
  const { prompt: _prompt, output: _output, ...out } = req
  let churn = 0
  let net = 0
  for (const c of CATS) {
    const d = prev !== null ? (req[c.key] || 0) - (prev[c.key] || 0) : 0
    out[c.key] = d
    churn += Math.abs(d)
    net += d
  }
  out.total = churn
  out.net = net
  return out
}

/** Map a raw request list to its delta-transformed list (the first record diffs from empty). */
export const deltaRequestsOf = (requests: RequestRecord[]): RequestRecord[] =>
  requests.map((req, i) => deltaOf(req, i > 0 ? requests[i - 1] : null))

/** The signed up/down extent of a delta record: sum of positive / negative category deltas. */
export const sideExtentsOf = (req: RequestRecord): { up: number; down: number } => {
  let up = 0
  let down = 0
  for (const c of CATS) {
    const d = req[c.key] || 0
    if (d > 0) up += d
    else down -= d
  }
  return { up, down }
}
