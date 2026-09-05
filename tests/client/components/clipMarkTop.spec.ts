/**
 * Unit tests for `clipMarkTop` — the pure ink-centring math that places the ≀ break marker on the axis. It reads the
 * glyph's line box (via Range), the span's own box, and the font's ink metrics (via a canvas measure), so the test
 * stubs those three inputs and asserts the returned span `top` puts the ink centre on the target.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { clipMarkTop } from '../../../src/client/components/trendChart'

function fakeRect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top } as DOMRect
}

function stubInputs(opts: {
  lineTop: number
  lineHeight: number
  spanTop: number
  spanHeight: number
  fontAscent?: number
  inkAscent?: number
  inkDescent?: number
}): { canvasCtx: unknown } {
  const mark = document.createElement('span')
  mark.textContent = '≀'
  mark.style.top = '0px'
  document.body.appendChild(mark)
  vi.spyOn(mark, 'getBoundingClientRect').mockReturnValue(fakeRect(opts.spanTop, opts.spanHeight))
  vi.spyOn(document, 'createRange').mockReturnValue({
    selectNodeContents: () => {},
    getBoundingClientRect: () => fakeRect(opts.lineTop, opts.lineHeight),
  } as unknown as Range)
  vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue({ fontSize: '11px', fontFamily: 'sans-serif' } as CSSStyleDeclaration)
  const canvasCtx = {
    font: '',
    measureText: () => ({
      width: 10,
      fontBoundingBoxAscent: opts.fontAscent,
      actualBoundingBoxAscent: opts.inkAscent,
      actualBoundingBoxDescent: opts.inkDescent,
    } as unknown as TextMetrics),
  }
  vi.spyOn(document, 'createElement').mockReturnValue({ getContext: () => canvasCtx } as unknown as HTMLCanvasElement)
  return { canvasCtx }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('clipMarkTop', () => {
  test('uses the font ink metrics to centre the glyph ink on mid', () => {
    const { canvasCtx } = stubInputs({ lineTop: 5, lineHeight: 20, spanTop: 0, spanHeight: 15, fontAscent: 10, inkAscent: 8, inkDescent: 2 })
    // lineCenterFromSpanTop = (5 + 10) - 0 = 15. inkRelBaseline = (8-2)/2 = 3. fontAscent = 10.
    // inkFromLineCenter = (10 - 3) - 10 = -3. top = mid - 15 - (-3) = mid - 12.
    const top = clipMarkTop(document.body.lastElementChild as HTMLElement, 50, 0)
    assert.equal(top, 50 - 15 - -3)
    assert.ok(top >= 0)
    // The canvas font was set from the computed style before measuring.
    assert.equal((canvasCtx as { font: string }).font, '11px sans-serif')
  })

  test('falls back to a 0 fontAscent when the canvas does not report a font bounding box', () => {
    const { canvasCtx } = stubInputs({ lineTop: 0, lineHeight: 20, spanTop: 0, spanHeight: 15, fontAscent: undefined, inkAscent: 8, inkDescent: 2 })
    const top = clipMarkTop(document.body.lastElementChild as HTMLElement, 40, 0)
    // fontAscent 0, inkRelBaseline 3 → inkFromLineCenter = -3 - 10 = -13; lineCenterFromSpanTop = 10.
    assert.equal(top, 40 - 10 - -13)
  })

  test('falls back to box centring when there is no 2D canvas context (jsdom)', () => {
    // Do NOT stub createElement's getContext → returns null (jsdom), so clipMarkTop uses the line-box fallback.
    const mark = document.createElement('span')
    mark.textContent = '≀'
    document.body.appendChild(mark)
    vi.spyOn(mark, 'getBoundingClientRect').mockReturnValue(fakeRect(0, 15))
    vi.spyOn(document, 'createRange').mockReturnValue({
      selectNodeContents: () => {},
      getBoundingClientRect: () => fakeRect(5, 20),
    } as unknown as Range)
    const top = clipMarkTop(mark, 30, 0)
    // lineCenterFromSpanTop = (5 + 10) - 0 = 15 → top = 30 - 15 = 15.
    assert.equal(top, 15)
  })

  test('treats a Range without a measurable line box as height 0 when a canvas measure is possible', () => {
    // jsdom's Range has no getBoundingClientRect → glyphBox is null (height 0), but the canvas IS available, so the
    // ink-centring still runs against a zero-height line box.
    const mark = document.createElement('span')
    mark.textContent = '≀'
    document.body.appendChild(mark)
    vi.spyOn(mark, 'getBoundingClientRect').mockReturnValue(fakeRect(0, 15))
    // Use the real Range (no getBoundingClientRect in jsdom) → glyphBox null.
    vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue({ fontSize: '11px', fontFamily: 'sans-serif' } as CSSStyleDeclaration)
    const canvasCtx = {
      font: '',
      measureText: () => ({ width: 10, fontBoundingBoxAscent: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 } as unknown as TextMetrics),
    }
    vi.spyOn(document, 'createElement').mockReturnValue({ getContext: () => canvasCtx } as unknown as HTMLCanvasElement)
    const top = clipMarkTop(mark, 30, 0)
    // lineCenterFromSpanTop = 0 (glyphBox null); inkFromLineCenter = (10 - 3) - 0 = 7 → top = 30 - 0 - 7 = 23.
    assert.equal(top, 23)
  })
})
