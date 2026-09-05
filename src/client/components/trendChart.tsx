/**
 * Bespoke per-request history chart — no shared data-viz primitive — styled through the shared `--dsw-alias-*` tokens; helpers
 * aggregateByTurn/attachMarkers are shared with ContextView.
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord } from '../../shared/types'
import { CATS } from '../categories'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

import { computeScale } from './trendChartClip'
import { anchorOf, barTotalOf, deltaRequestsOf } from './trendChartData'
import { visibleWindowOf } from './trendChartAdaptive'
import { BAR_W, BAR_GAP, CHART_H, LABEL_GAP, LABEL_OVERHANG, TURN_FILLS } from './trendChartGeometry'

export interface TrendChartProps {
  requests: RequestRecord[]
  markers: (ContextEventRecord | undefined)[]
  selectedSeq: number | null
  hoveredSeq: number | null
  activeTurn: number | null
  granularity: 'step' | 'turn'
  mode: 'total' | 'delta'
  /** Whether the adaptive ≀ y-axis clip is enabled (plugin settings toggle). Defaults to on. */
  clip?: boolean
  focusTurn: number | null
  /** Mirrored category hover (shared with the overview and the browser): lights that category's segment in every bar. */
  hoverCat: string | null
  onSelect: (seq: number | null) => void
  onHover: (seq: number | null) => void
  onHoverTurn: (turn: number | null) => void
  onPickTurn: (turn: number) => void
  onFocusTurnHandled: () => void
}

/**
 * Collapse per-step requests into one bar per turn — each turn is represented by its LAST step's record, tagged `stepCount` for the bar's
 * column width; the log keeps one turn's requests consecutive, so a run of equal turns collapses to its final record.
 */
export function aggregateByTurn(requests: RequestRecord[]): RequestRecord[] {
  const out: RequestRecord[] = []
  let runSteps = 0
  for (const req of requests) {
    const last = out.length > 0 ? out[out.length - 1] : null
    if (last !== null && (last.turn ?? 0) === (req.turn ?? 0)) {
      runSteps++
      out[out.length - 1] = { ...req, stepCount: runSteps }
    } else {
      runSteps = 1
      out.push({ ...req, stepCount: 1 })
    }
  }
  return out
}

/**
 * Attach each boundary event (compaction/prune) to the first request logged after it — one entry per index, for the ✂ marker and the detail
 * chip; shared with the detail panel so both show the SAME event.
 */
export function attachMarkers(requests: RequestRecord[], events: ContextEventRecord[]): (ContextEventRecord | undefined)[] {
  const markers: (ContextEventRecord | undefined)[] = new Array<ContextEventRecord | undefined>(requests.length)
  for (const ev of events) {
    if (ev.kind !== 'compaction' && ev.kind !== 'prune') continue
    for (let r = 0; r < requests.length; r++) {
      if (requests[r].seq >= ev.seq) {
        if (markers[r] === undefined) markers[r] = ev
        break
      }
    }
  }
  return markers
}

/**
 * The chat→Context jump's target: the turn bar whose closing reply the user clicked — the relayed seq is a turn's LAST step, exactly the
 * aggregate's record — or, when that turn has aged out of the host's retained window, the oldest retained bar. Resolved against turn
 * aggregates, since the jump pins in turn granularity. Null only on an empty history.
 */
export function jumpTargetOf(requests: RequestRecord[], seq: number): RequestRecord | null {
  for (const req of requests) if (req.seq === seq) return req
  return requests.length > 0 ? requests[0] : null
}

/**
 * Compute the CSS `top` (relative to the axis box) that places a ≀ break glyph so its INK is vertically centred
 * on `mid` — the midpoint of two adjacent axis value labels. This is self-contained coordinate math: it reads
 * only the glyph element, its target position, and the axis box top; everything else is derived from the
 * glyph's own box and the font's metrics. Kept apart from the chart/scroll/aggregation logic on purpose.
 *
 * Step by step:
 *
 *  1. Pin the glyph at a reference offset (`top:0`, no transform) so the browser lays out its real line box.
 *  2. Measure the glyph's ACTUAL line box (a text `Range` over its node). The span's CSS box (`line-height:1`)
 *     is shorter than the font's line box, so the glyph overflows it — the line box is the box the eye reads.
 *     Take `lineCenterFromSpanTop`, the line-box centre's offset from the span's own top (independent of where
 *     the span sits in the axis).
 *  3. Measure the ink's offset from that line-box centre from the font's own metrics:
 *       `inkFromLineCenter = (fontAscent − inkRelBaseline) − lineBoxHeight/2`
 *       - `fontAscent`     = how far the baseline sits BELOW the line-box top (`fontBoundingBoxAscent`).
 *       - `inkRelBaseline` = how far the ink centre sits ABOVE the baseline (`(ascent − descent)/2`).
 *       - So the ink centre is `fontAscent − inkRelBaseline` below the line-box top; subtract half the box
 *         height → how far the ink centre lies below the line-box CENTRE. Positive = below, which is the ~3px
 *         the wavy mark normally sits low (why centring the box alone leaves it visibly off).
 *  4. Solve for the span's `top` so the ink centre equals the midpoint:
 *       inkCentre = spanTop + lineCenterFromSpanTop + inkFromLineCenter = mid
 *       ⇒ spanTop = mid − lineCenterFromSpanTop − inkFromLineCenter.
 *
 * Returns the `top` in px relative to the axis box (no transform is needed).
 */
export function clipMarkTop(mark: HTMLElement, mid: number, axisTop: number): number {
  // 1 — reference layout so the glyph's line box is measurable.
  mark.style.top = '0px'
  mark.style.transform = ''
  // 2 — the glyph's real line box vs the span's own box. jsdom's Range has no getBoundingClientRect, so guard it
  //     and fall back to centring the span box on `mid`.
  const range = document.createRange()
  range.selectNodeContents(mark)
  const glyphBox = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null
  const spanBox = mark.getBoundingClientRect()
  const lineCenterFromSpanTop = glyphBox !== null ? glyphBox.top + glyphBox.height / 2 - spanBox.top : 0
  // 3 — the ink's offset below the line-box centre, from the font metrics. A canvas measure is the accurate way;
  //     when no 2D context is available (jsdom, a subtle build) fall back to centring the line box on `mid`.
  const cs = getComputedStyle(mark)
  const inkCtx = document.createElement('canvas').getContext('2d')
  if (inkCtx === null) return Math.max(0, mid - lineCenterFromSpanTop)
  inkCtx.font = `${cs.fontSize} ${cs.fontFamily}`
  const ink = inkCtx.measureText('≀')
  const fontAscent = ink.fontBoundingBoxAscent != null ? ink.fontBoundingBoxAscent : 0
  const inkRelBaseline = (ink.actualBoundingBoxAscent - ink.actualBoundingBoxDescent) / 2
  const inkFromLineCenter = (fontAscent - inkRelBaseline) - (glyphBox !== null ? glyphBox.height : 0) / 2
  // 4 — the span top (relative to the axis) that lands the ink centre on `mid`.
  return Math.max(0, mid - lineCenterFromSpanTop - inkFromLineCenter)
}

export function makeTrendChart(kit: ViewKit): (props: TrendChartProps) => ReactNS.ReactElement {
  const { t, fmt, eventLabel, eventAt } = kit

  // Delta axis ticks are signed: '+' only on positives — fmt already carries the minus for negatives.
  const fmtSigned = (v: number): string => (v > 0 ? '+' : '') + fmt(v)

  interface ChartBarProps {
    req: RequestRecord
    marker: ContextEventRecord | undefined
    selected: boolean
    hovered: boolean
    inTurn: boolean
    maxTotal: number
    /**
     * Delta mode geometry: zero-line offsets in px (up from the top / down from the bottom of the bar area)
     * and the uniform px-per-token scale — identical above and below the zero line, so a +n segment and a
     * −n segment always draw the same height. All three absent in total mode; passed as PRIMITIVES so the
     * memoized bar keeps its shallow-compare bailout.
     */
    upPx?: number
    downPx?: number
    deltaScale?: number
    onSelect: (seq: number | null) => void
    onHover: (seq: number | null) => void
  }

  // Memoized so a hover/selection change re-renders only the bars whose flags flipped — the retained log renders in full (thousands of
  // nodes on long sessions); `req`/`marker` keep stable identities because the parent memoizes its aggregation, so the default shallow
  // compare suffices.
  const ChartBar = React.memo(function ChartBar(props: ChartBarProps): ReactNS.ReactElement {
    const { req, marker } = props
    const markerAt = marker !== undefined ? eventAt(marker) : null
    // Delta mode: diverging stacks — positive category deltas pile UP from the zero line, negative ones
    // hang DOWN from it, both in category colors (direction carries the sign, color the category).
    const diverge = props.upPx !== undefined && props.downPx !== undefined && props.deltaScale !== undefined
    return (
      <div
        className={'lc-bar'
          + (props.selected ? ' lc-bar-selected' : '')
          + (props.hovered ? ' lc-bar-hovered' : '')
          + (props.inTurn ? ' lc-bar-in-turn' : '')}
        data-seq={req.seq}
        style={{ width: `${BAR_W}px` }}
        onClick={() => { props.onSelect(props.selected ? null : req.seq) }}
        onMouseEnter={() => { props.onHover(req.seq) }}
      >
        {marker !== undefined ? (
          <span
            className="lc-bar-marker"
            title={'✂ ' + (markerAt !== null ? markerAt + ' — ' : '') + eventLabel(marker)}
          >{'✂'}</span>
        ) : null}
        {diverge ? (
          <>
            {/* max-height + overflow:hidden cap a clipped side's stack at the axis, so an outlier bar reads as a
                full-height column instead of spilling past the plot. Inert when no clip. */}
            <div className="lc-bar-up" style={{ bottom: `${props.downPx}px`, maxHeight: `${props.upPx}px`, overflow: 'hidden' }}>
              {CATS.map((c) => {
                const d = req[c.key] || 0
                if (d <= 0) return null
                return <div key={c.key} data-cat={c.key} className="lc-cat-seg" style={{ height: `${Math.max(1, Math.round(d * (props.deltaScale as number)))}px`, background: c.color }} />
              })}
            </div>
            <div className="lc-bar-down" style={{ top: `${props.upPx}px`, maxHeight: `${props.downPx}px`, overflow: 'hidden' }}>
              {CATS.map((c) => {
                const d = req[c.key] || 0
                if (d >= 0) return null
                return <div key={c.key} data-cat={c.key} className="lc-cat-seg" style={{ height: `${Math.max(1, Math.round(-d * (props.deltaScale as number)))}px`, background: c.color }} />
              })}
            </div>
          </>
        ) : (
          <div className="lc-bar-stack" style={{ maxHeight: `${CHART_H}px`, overflow: 'hidden' }}>
            {CATS.map((c) => {
              const v = (req[c.key] || 0) * anchorOf(req)
              if (!v) return null
              // px (not %) heights: the stack is content-driven, so percentage heights would collapse against an indefinite base.
              return <div key={c.key} data-cat={c.key} className="lc-cat-seg" style={{ height: `${Math.max(1, Math.round(v / props.maxTotal * CHART_H))}px`, background: c.color }} />
            })}
          </div>
        )}
      </div>
    )
  })

  return function TrendChart(props: TrendChartProps): ReactNS.ReactElement {
    const delta = props.mode === 'delta'
    const requests = React.useMemo(
      () => (delta ? deltaRequestsOf(props.requests) : props.requests),
      [props.requests, delta],
    )
    const markers = props.markers
    // ADAPTIVE-VIEWPORT CLIP: the y-axis is scaled to only the bars currently in the horizontal viewport (plus a
    // small VIS_PAD buffer each side), so scrolling past a dominant outlier re-caps the axis to what the eye is
    // actually reading rather than to the whole history's global peak. `visRange` is recomputed on scroll and after
    // the auto-anchor repositions the right edge (see updateVisRange below); computeScale reads the window from it
    // while ALL bars still render so the plot is dense and correct.
    const [visRange, setVisRange] = React.useState<{ start: number; end: number }>(() => ({ start: 0, end: props.requests.length }))
    // Resolve the y-axis scale (caps, clip flags, zero-line geometry) for the view horizon. `computeScale` runs the
    // whole-body outlier fence and the per-side REAL-value caps; when `clip` is off it scales to the WHOLE list for
    // a stable, non-adaptive reference.
    const scale = computeScale(requests, { mode: props.mode, visStart: visRange.start, visEnd: visRange.end, clip: props.clip ?? true })
    const { maxUp, maxDown, maxTotal, upClipActive, downClipActive, totalClipActive, deltaScale, upPx, downPx } = scale


    // Consecutive same-turn requests collapse into one labeled range; `span` counts the STEP columns the group covers (step records count
    // one each), so strip blocks align with the bars in both granularities.
    const groups: { turn: number; count: number; span: number; agg: boolean }[] = []
    for (const req of requests) {
      let grp = groups.length > 0 ? groups[groups.length - 1] : null
      if (grp === null || grp.turn !== (req.turn ?? 0)) {
        grp = { turn: req.turn ?? 0, count: 0, span: 0, agg: req.stepCount !== undefined }
        groups.push(grp)
      }
      grp.count++
      grp.span += req.stepCount ?? 1
    }

    // Strip offsets/widths are computed in content px so the scroll handler can re-center labels analytically and measures only the handful
    // of labels on screen.
    const turnOffsets: number[] = []
    const turnWidths: number[] = []
    {
      let x = 0
      for (const grp of groups) {
        const w = grp.agg ? BAR_W : grp.span * (BAR_W + BAR_GAP) - BAR_GAP
        turnOffsets.push(x)
        turnWidths.push(w)
        x += w + BAR_GAP
      }
    }

    // Default anchor: newest bars at the RIGHT edge; the first layout after mount scrolls unconditionally, a GRANULARITY SWITCH re-anchors
    // the same way (step mode must not inherit the turn chart's stale left edge), otherwise stick to the end only while already near it;
    // useLayoutEffect avoids a first-paint flash.
    const scrollRef = React.useRef<HTMLDivElement | null>(null)
    // The axis box, measured to place the ≀ break markers exactly between the two adjacent value labels.
    const axisRef = React.useRef<HTMLDivElement | null>(null)
    const scrolledOnce = React.useRef(false)
    const lastGranRef = React.useRef(props.granularity)
    // The newest bar's seq (or 0 when the log is empty): the layout effect only re-runs when the right edge genuinely
    // moves (new bar appended, granularity switched, focus turn set) — hover/select changes keep their scroll position
    // so the chart does not flash with every keystroke.
    const lastSeqRef = React.useRef(0)
    // The scrollWidth measured during the PREVIOUS effect pass. The "was the reader near the right edge?" check
    // has to compare against the width as it was BEFORE the new bar landed — by the time the layout effect runs,
    // `el.scrollWidth` is already the new (wider) value, so a near-edge check against it would miss the auto-follow.
    const prevScrollWidthRef = React.useRef(0)
    /** Recompute the adaptive-clip window from the scroller's geometry (see `visibleWindowOf`); only sets state when
     * the range actually moves, so scrolling within a stable body keeps the bars' memoized scale props. */
    const updateVisRange = (el: HTMLDivElement): void => {
      const next = visibleWindowOf(el.scrollLeft, el.clientWidth, requests.length)
      setVisRange(prev => (prev.start === next.start && prev.end === next.end ? prev : next))
    }
    /**
     * Keep each turn label centered within its block's VISIBLE slice, then thin colliding labels: a label wider
     * than its block overflows it, so consecutive narrow turns (14px bars, 2-digit "T12"s) would smear into each
     * other — walking left→right in content coordinates, a label whose box reaches the previous KEPT one drops to
     * visibility:hidden. Blocks that cannot reach the viewport even overhung by a label skip their reads/writes
     * entirely (their transform/visibility just reset); reads (offsetWidth) batch before the writes to avoid layout
     * thrash, and unchanged styles write nothing.
     */
    const updateTurnLabels = (el: HTMLDivElement): void => {
      const labels = el.querySelectorAll<HTMLElement>('.lc-turn-label')
      const n = Math.min(labels.length, turnOffsets.length)
      const sl = el.scrollLeft
      const vr = sl + el.clientWidth
      const writes: [HTMLElement, string, string][] = []
      // Right edge (content px) of the last kept label's box plus the gap; -Infinity opens the chain.
      let chainR = -Infinity
      for (let i = 0; i < n; i++) {
        const off = turnOffsets[i]
        const w = turnWidths[i]
        let dx = 0
        let vis = ''
        if (off + w + LABEL_OVERHANG > sl && off - LABEL_OVERHANG < vr) {
          const lw = labels[i].offsetWidth
          const visL = Math.max(off, sl)
          const visR = Math.min(off + w, vr)
          if (visR > visL && lw < w) {
            const center = (visL + visR) / 2 - off
            dx = Math.min(Math.max(center, lw / 2), w - lw / 2) - w / 2
          }
          const left = off + w / 2 + dx - lw / 2
          if (left < chainR) vis = 'hidden'
          else chainR = left + lw + LABEL_GAP
        }
        const next = dx !== 0 ? `translateX(${dx}px)` : ''
        if (labels[i].style.transform !== next || labels[i].style.visibility !== vis) writes.push([labels[i], next, vis])
      }
      for (const [label, next, vis] of writes) {
        label.style.transform = next
        label.style.visibility = vis
      }
    }
    React.useLayoutEffect(() => {
      const el = scrollRef.current
      /* v8 ignore next 1 -- the scroll div renders unconditionally and React
         attaches refs before layout effects run; el is never null here. */
      if (el === null) return
      const newestSeq = requests.length === 0 ? 0 : requests[requests.length - 1].seq
      const grew = newestSeq !== lastSeqRef.current
      const widthBeforeAppend = prevScrollWidthRef.current
      if (props.granularity !== lastGranRef.current) {
        lastGranRef.current = props.granularity
        scrolledOnce.current = false
      }
      // A strip-clicked focus turn centers its bar instead of the newest anchor, consumed once via onFocusTurnHandled — also when
      // granularity was already 'turn' (no re-anchor happens that render).
      if (props.focusTurn !== null) {
        const gi = groups.findIndex(g => g.turn === props.focusTurn)
        if (gi >= 0) {
          scrolledOnce.current = true
          el.scrollLeft = Math.max(0, gi * (BAR_W + BAR_GAP) + BAR_W / 2 - el.clientWidth / 2)
        }
        props.onFocusTurnHandled()
      } else if (!scrolledOnce.current) {
        scrolledOnce.current = true
        el.scrollLeft = el.scrollWidth
      } else if (grew && el.scrollLeft + el.clientWidth >= widthBeforeAppend - 24) {
        // Only follow the latest bar when the right edge actually moved AND the reader was already near it
        // BEFORE the new bar landed — comparing against the new scrollWidth would silently drop the stick for a
        // mid-chart reader whose viewport just slid past the near-end threshold.
        el.scrollLeft = el.scrollWidth
      }
      lastSeqRef.current = newestSeq
      prevScrollWidthRef.current = el.scrollWidth
      updateTurnLabels(el)
      syncTip(el)
      updateVisRange(el)
    }, [props.granularity, props.focusTurn, requests])

    // Compact 2-row hover tooltip, shown instantly by the custom `.lc-chart-tip` (the native title is delayed):
    // identity and the bar's anchor total — the SAME actual value the bar height and axis are scaled against
    // (provider prompt when reported, heuristic total otherwise). Identity phrasing follows the granularity —
    // turn bars always speak TURN (the aggregate's step count, singular for a 1-step turn; a record missing
    // stepCount degrades to that too), step bars carry the step index. Delta swaps the metric row for the net.
    const tipRowsOf = (req: RequestRecord): [string, string] => {
      const n = req.stepCount ?? 1
      const head = props.granularity === 'turn'
        ? (n > 1 ? t('tip.turn', { t: req.turn ?? 0, n }) : t('tip.turn1', { t: req.turn ?? 0 }))
        : t('tip.step', { t: req.turn ?? 0, s: req.step ?? 0 })
      if (delta) {
        /* v8 ignore next 1 -- delta mode only receives records from
           deltaOf, which always assigns net; the fallback is defensive. */
        const n = req.net ?? 0
        return [head, t('tip.delta', { n: (n > 0 ? '+' : '') + fmt(n) })]
      }
      return [head, t('tip.total', { n: fmt(barTotalOf(req)) })]
    }
    const hoveredIdx = props.hoveredSeq !== null ? requests.findIndex(r => r.seq === props.hoveredSeq) : -1
    const hoveredReq = hoveredIdx >= 0 ? requests[hoveredIdx] : null

    // Column center (content px) of the currently hovered bar, for syncTip reads outside the render pass.
    const tipColRef = React.useRef(0)

    /**
     * Glue the hover tip to its bar's VISIBLE slice. The tip deliberately does NOT live inside the scrolling
     * content: an absolutely-positioned child of a scroller contributes to its scrollable overflow, so a wide
     * reply preview on a right-edge bar used to inflate scrollWidth on every hover and flap the horizontal
     * scrollbar open/closed — jumping the whole card. Reads (offsetWidth/clientWidth) batch before the single
     * style write; unchanged transforms write nothing.
     */
    const syncTip = (el: HTMLDivElement): void => {
      /* v8 ignore next 1 -- the scroll div renders unconditionally while mounted, so its parent exists. */
      const tip = (el.parentElement ?? document.body).querySelector<HTMLElement>('.lc-chart-tip')
      // No hover, nothing to place.
      if (tip === null) return
      const lw = tip.offsetWidth
      const cw = el.clientWidth
      // Center over the bar's visible slice, clamped so the tip never hangs past either edge nor gets cut off; a tip
      // wider than the viewport centers over it instead of picking a bogus side on an inverted clamp window.
      const half = Math.min(lw / 2, cw / 2)
      const cx = Math.min(Math.max(tipColRef.current - el.scrollLeft, half), cw - half)
      const next = `translate(${Math.round(cx - lw / 2)}px, 0)`
      if (tip.style.transform !== next) tip.style.transform = next
    }

    // Position (and re-position after EVERY commit — the tip mounts on hover changes, which touch no other
    // effect dependency here) from the committed hovered column before paint.
    React.useLayoutEffect(() => {
      /* v8 ignore next 1 -- the scroll div renders unconditionally and React attaches refs before
         layout effects run; el is never null here. */
      if (scrollRef.current === null) return
      tipColRef.current = hoveredIdx >= 0 ? hoveredIdx * (BAR_W + BAR_GAP) + BAR_W / 2 : 0
      syncTip(scrollRef.current)
    })

    // Place each ≀ break marker just inside the plot from its clipped edge (below the up extreme, above the down
    // extreme), so "the axis is cut here" reads at the frontier regardless of where the neighbouring labels sit. The
    // ink-centring math lives in the standalone `clipMarkTop`.
    React.useLayoutEffect(() => {
      const axis = axisRef.current
      /* v8 ignore next 1 -- the axis div renders unconditionally while mounted, so its ref is set. */
      if (axis === null) return
      const axisR = axis.getBoundingClientRect()
      // The zero label is the inner reference for the clip marker: for delta it is the moving 0 (upPx), for total the
      // fixed 0 baseline. It is rendered unconditionally in both modes, so it is always present. The marker must stay
      // INSIDE the clipped arm — never on the far side of the zero line.
      const zero = axis.querySelector<HTMLElement>(delta ? '.lc-axis-mid' : '.lc-axis-bot')!
      const zr = zero.getBoundingClientRect()
      axis.querySelectorAll<HTMLElement>('.lc-axis-clip').forEach((mark) => {
        const side = mark.dataset.clip
        // The clip markers are only ever emitted for the up or down side, so the extreme label is whichever exists.
        const extreme = side === 'up' ? axis.querySelector<HTMLElement>('.lc-axis-top') : axis.querySelector<HTMLElement>('.lc-axis-bot')
        /* v8 ignore next 1 -- the marker's side label (top/bot) renders whenever that side has bars, so it is never null. */
        if (extreme === null) return
        const r = extreme.getBoundingClientRect()
        // Place the ≀ just inside the plot from the clipped CAP label (below the up cap, above the down cap), clear
        // of both the cap label and the zero line, so it reads as "the axis is cut here" at the truncation frontier.
        const capEdge = side === 'up' ? r.bottom : r.top
        const zeroEdge = side === 'up' ? zr.top : zr.bottom
        const armLen = Math.abs(zeroEdge - capEdge)
        /* v8 ignore next 1 -- the fence caps both sides to ~bodyTop (balanced arms ≥ ~45px), so a clipped arm is
           never this short; this guard is defensive. */
        if (armLen < 26) return
        const toward = side === 'up' ? 1 : -1
        let inside = capEdge + toward * 14
        // Clamp so the marker stays a glyph-height clear of the zero label (it must stay inside the clipped arm).
        const zeroGap = side === 'up' ? zeroEdge - 14 : zeroEdge + 14
        inside = side === 'up' ? Math.min(inside, zeroGap) : Math.max(inside, zeroGap)
        const mid = inside - axisR.top
        mark.style.top = `${clipMarkTop(mark, mid, axisR.top)}px`
        mark.style.transform = ''
      })
    }, [delta, upClipActive, downClipActive, totalClipActive, requests, maxUp, maxDown, maxTotal, upPx])

    return (
      <div className="lc-chartrow">
        <div className="lc-axis" ref={axisRef}>
          {delta ? (
            <>
              {/* Only REAL values are labelled: the two caps and the zero line. A clipped side is BROKEN — the ≀
                  marker sits just inside the plot from the clipped edge (see the layout effect above), so "the axis
                  is cut here" reads at the frontier and the true outlier stays in the tooltip. */}
              {maxUp > 0 ? <span className="lc-axis-top">{fmtSigned(maxUp)}</span> : null}
              {upClipActive ? <span className="lc-axis-clip" data-clip="up">{'≀'}</span> : null}
              <span className="lc-axis-mid" style={{ top: `${13 + upPx}px` }}>{'0'}</span>
              {downClipActive ? <span className="lc-axis-clip" data-clip="down">{'≀'}</span> : null}
              {maxDown > 0 ? <span className="lc-axis-bot">{fmtSigned(-maxDown)}</span> : null}
            </>
          ) : (
            <>
              {/* Only label a real cap; an empty/all-zero history omits it (keeps just the true 0 baseline). */}
              {maxTotal > 0 ? <span className="lc-axis-top">{fmt(maxTotal)}</span> : null}
              {totalClipActive ? <span className="lc-axis-clip" data-clip="up">{'≀'}</span> : null}
              <span className="lc-axis-bot">{'0'}</span>
            </>
          )}
        </div>
        {/* Only the scrolling CONTENT lives under .lc-chart-scroll; the hover tip sits beside it inside the
            positioned wrapper instead of inside the scroller — absolutely-positioned children of a scroller
            contribute to its scrollable overflow AND translate away with the content on scroll. */}
        <div className="lc-chart-wrap">
          <div
            className={'lc-chart-scroll' + (props.activeTurn !== null ? ' lc-chart-dim' : '')}
            ref={scrollRef}
            onScroll={(e: ReactNS.UIEvent<HTMLDivElement>) => {
              updateTurnLabels(e.currentTarget)
              syncTip(e.currentTarget)
              updateVisRange(e.currentTarget)
            }}
          >
            <div
              className="lc-chart"
              // The shared category hover rides a plain attribute: the CSS lights that key's segment in EVERY bar
              // and recedes the rest, so the memoized bars never re-render on a cross-card hover change.
              data-catdim={props.hoverCat ?? undefined}
              onMouseLeave={() => { props.onHover(null) }}
            >
              <div className="lc-grid lc-grid-top" />
              {/* The SOLID zero baseline — the reading reference in both modes: inline-positioned off the up-arm
                  in delta mode, the chart floor (CSS default) under the '0' label in total mode. */}
              <div className="lc-grid lc-grid-zero" style={delta ? { top: `${18 + upPx}px` } : undefined} />
              {requests.map((req, i) => (
                <ChartBar
                  key={req.seq}
                  req={req}
                  marker={markers[i]}
                  selected={props.selectedSeq === req.seq}
                  hovered={props.hoveredSeq === req.seq}
                  inTurn={props.activeTurn !== null && (req.turn ?? 0) === props.activeTurn}
                  maxTotal={maxTotal}
                  upPx={delta ? upPx : undefined}
                  downPx={delta ? downPx : undefined}
                  deltaScale={delta ? deltaScale : undefined}
                  onSelect={props.onSelect}
                  onHover={props.onHover}
                />
              ))}
            </div>
            {/* Turn strip: one COLOR BLOCK per turn spanning exactly its bars' columns, so the partition reads at a glance and lines
                up with the steps; hovering a block highlights that turn's bars and vice versa — one shared hover-only state.
                */}
            <div className="lc-turns" onMouseLeave={() => { props.onHoverTurn(null) }}>
              {groups.map((grp, gi) => {
                const on = props.activeTurn === grp.turn
                return (
                  <span
                    key={`turn-${gi}`}
                    className={'lc-turn' + (on ? ' lc-turn-on' : '')}
                    style={{
                      width: `${turnWidths[gi]}px`,
                      background: TURN_FILLS[gi % TURN_FILLS.length],
                    }}
                    title={`T${grp.turn}`}
                    onMouseEnter={() => { props.onHoverTurn(grp.turn) }}
                    onClick={() => { props.onPickTurn(grp.turn) }}
                  ><span className="lc-turn-label">{`T${grp.turn}`}</span></span>
                )
              })}
            </div>
          </div>
          {/* Compact 2-row hover tooltip (identity / anchor total), shown instantly by the custom `.lc-chart-tip`
              (the native title is delayed); the per-category breakdown lives in the detail panel below. It floats
              ABOVE the plot (CSS bottom anchoring) so it never covers the bars, is capped at the wrapper's width
              and wrapped, and is positioned imperatively over its bar's visible slice (syncTip) so scrolling keeps
              it glued without ever widening the scrollable area. */}
          {hoveredReq !== null ? (
            <div className="lc-chart-tip">{tipRowsOf(hoveredReq).map((row, i) => <span key={i}>{row}</span>)}</div>
          ) : null}
        </div>
      </div>
    )
  }
}
