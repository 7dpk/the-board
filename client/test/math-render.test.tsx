import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Action, applyAction, emptyScene } from '@board/shared'
import Board from '../src/board/Board'
import { useBoard } from '../src/store'

// ---------------------------------------------------------------------------
// Mount harness. This workspace has no @testing-library/react (not a
// declared dep — see client/package.json), so we drive react-dom/client
// directly: createRoot into a detached container, wrapping every
// render/event in `act` so effects (Mafs's pane-measurement effects,
// KaTeX's render-into-ref effect, etc.) flush before assertions run.
// ---------------------------------------------------------------------------
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function seedScene(actions: Action[]): void {
  const scene = actions.reduce(applyAction, emptyScene)
  useBoard.setState({ scene, liveOverrides: {}, selection: null })
}

async function renderBoard(): Promise<void> {
  await act(async () => {
    root.render(<Board />)
  })
}

const SEED: Action[] = [
  { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
  { op: 'add', c: 'plot', id: 'pl1', on: 'ax1', expr: 'x^2 - 4' },
  { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 2, y: 3, label: 'P' },
  { op: 'add', c: 'area', id: 'ar1', on: 'ax1', expr: 'x^2', from: 0, to: 2 },
  { op: 'add', c: 'label', id: 'lb1', tex: 'E=mc^2' },
  { op: 'add', c: 'numberline', id: 'nl1', min: 0, max: 10, marks: [2, 4, 6] },
  {
    op: 'add',
    c: 'table',
    id: 'tb1',
    cols: ['x', 'y'],
    rows: [
      ['1', '2'],
      ['3', '4'],
    ],
  },
]

describe('Board / math render pack', () => {
  beforeEach(() => {
    seedScene(SEED)
  })

  it('renders an SVG path with real coordinate data for the plot component', async () => {
    await renderBoard()
    const paths = Array.from(container.querySelectorAll('svg path'))
    const hasSampledPath = paths.some((p) => (p.getAttribute('d') ?? '').trim().split(/\s+/).length > 3)
    expect(hasSampledPath).toBe(true)
  })

  it('does not crash on an invalid expr, and that plot samples to an empty path', async () => {
    seedScene([...SEED, { op: 'add', c: 'plot', id: 'plBad', on: 'ax1', expr: 'not_a_real_fn(x)' }])

    await expect(renderBoard()).resolves.not.toThrow()

    // Mafs always mounts a <path> for Plot.OfX (see sampleParametric in
    // node_modules/mafs/build/index.js): it builds `"M " + "x y L "*n` and
    // trims the trailing " L "/" " — with zero finite sampled points (our
    // NaN-producing fallback for an uncompilable expr), that trim leaves an
    // empty string, i.e. a <path> that renders nothing visible.
    const paths = Array.from(container.querySelectorAll('svg path'))
    expect(paths.some((p) => (p.getAttribute('d') ?? '').trim() === '')).toBe(true)
  })

  it('renders the seeded table with the right row count', async () => {
    await renderBoard()
    const rows = container.querySelectorAll('.board-table tbody tr')
    expect(rows).toHaveLength(2)
  })

  it('clicking a point wrapper sets store selection (stopping propagation)', async () => {
    await renderBoard()
    const pointWrapper = container.querySelector('[data-el-id="pt1"]')
    expect(pointWrapper).toBeTruthy()

    await act(async () => {
      pointWrapper!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useBoard.getState().selection).toBe('pt1')
  })

  it('clicking the board background clears selection', async () => {
    useBoard.getState().setSelection('pt1')
    await renderBoard()

    await act(async () => {
      container.querySelector('.board-canvas')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useBoard.getState().selection).toBeNull()
  })

  it('falls back to an "unknown component" placeholder for a type with no registry entry', async () => {
    // As of T13 every real ComponentType (including the physics pack —
    // projectile/incline/pendulum/fbd) has a registry entry, so this can no
    // longer be exercised with a schema-known type (that was the pre-T13
    // version of this test, using `c: 'projectile'`). The fallback path
    // itself is still real defensive code (see Board.tsx's StandaloneBlock)
    // guarding against a future/unrecognized `c` an LLM might emit, so we
    // exercise it directly with a synthetic component name — `as unknown as
    // Action` bypasses the (correctly) closed `AddAction` union, mirroring
    // how `applyAdd` itself never actually validates `c` at runtime.
    seedScene([
      { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
      { op: 'add', c: 'antigravity-field', id: 'proj1' } as unknown as Action,
    ])

    await expect(renderBoard()).resolves.not.toThrow()
    expect(container.querySelector('.board-unknown')).toBeTruthy()
  })

  it('renders a draggable MovablePoint without crashing when a drag control targets a point', async () => {
    seedScene([
      ...SEED,
      { op: 'ctl', id: 'pt1', k: 'x', kind: 'drag' },
    ])

    await expect(renderBoard()).resolves.not.toThrow()
    // MovablePointDisplay renders its own <g>/<circle>; just assert the
    // point's wrapper still mounted something.
    expect(container.querySelector('[data-el-id="pt1"] circle')).toBeTruthy()
  })

  it('renders a placeholder (not a crash) for a point orphaned by its axes being deleted', async () => {
    // Regression for task-12 review round 1: add axes ax1 -> add point pt1
    // on:ax1 -> del ax1 used to leave pt1 in scene.order with a dangling
    // `params.on`, which groupBlocks routed to StandaloneBlock, which then
    // called PointRenderer (registry['point']) directly in a plain flow
    // <div> with no ancestor <Mafs> — PointRenderer calls Mafs hooks
    // (useTransformContext) that throw a TransformContext invariant outside
    // a <Mafs> tree. It must instead render the orphaned placeholder.
    seedScene([
      { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
      { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 2, y: 3, label: 'P' },
      { op: 'del', id: 'ax1' },
    ])

    await expect(renderBoard()).resolves.not.toThrow()

    // ax1 itself is gone; pt1 survives as a standalone block with a
    // placeholder in place of its real (Mafs-dependent) renderer.
    expect(container.querySelector('[data-el-id="ax1"]')).toBeNull()
    const ptBlock = container.querySelector('[data-el-id="pt1"]')
    expect(ptBlock).toBeTruthy()
    expect(ptBlock?.querySelector('.board-orphaned')).toBeTruthy()
    expect(ptBlock?.querySelector('circle')).toBeNull()
  })

  it('applies focus-dim to non-focused elements under a dim-others focus', async () => {
    seedScene([...SEED, { op: 'focus', ids: ['pt1'], style: 'dim-others' }])
    await renderBoard()

    const plotBlock = container.querySelector('[data-el-id="pl1"]')
    const pointBlock = container.querySelector('[data-el-id="pt1"]')
    expect(plotBlock?.classList.contains('focus-dim')).toBe(true)
    expect(pointBlock?.classList.contains('focus-dim')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Plot draw-in (task-s2, "more ways to visualize, like manim/3b1b"): new
// plot/segment/vector adds get a 3b1b-style stroke reveal on mount (CSS
// keyframe, styles.css's `.board-draw-in` — jsdom doesn't run real CSS
// animation, so this pins the one thing assertable in this environment: the
// class is present on exactly the types the brief calls for, and absent
// elsewhere).
// ---------------------------------------------------------------------------
describe('Board / plot draw-in (task-s2)', () => {
  it('applies board-draw-in to a newly-added plot/segment/vector, not to point/area', async () => {
    seedScene([
      { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
      { op: 'add', c: 'plot', id: 'pl1', on: 'ax1', expr: 'x' },
      { op: 'add', c: 'segment', id: 'sg1', on: 'ax1', x1: 0, y1: 0, x2: 4, y2: 4 },
      { op: 'add', c: 'vector', id: 'vc1', on: 'ax1', x2: 3, y2: 4 },
      { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 2, y: 3 },
      { op: 'add', c: 'area', id: 'ar1', on: 'ax1', expr: 'x^2', from: 0, to: 2 },
    ])
    await renderBoard()

    expect(container.querySelector('[data-el-id="pl1"]')?.classList.contains('board-draw-in')).toBe(true)
    expect(container.querySelector('[data-el-id="sg1"]')?.classList.contains('board-draw-in')).toBe(true)
    expect(container.querySelector('[data-el-id="vc1"]')?.classList.contains('board-draw-in')).toBe(true)
    expect(container.querySelector('[data-el-id="pt1"]')?.classList.contains('board-draw-in')).toBe(false)
    expect(container.querySelector('[data-el-id="ar1"]')?.classList.contains('board-draw-in')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// task-21: axes label density scales to range, on-axes labels anchor+clamp
// ---------------------------------------------------------------------------
function svgViewBox(svg: Element): [number, number, number, number] {
  const parts = (svg.getAttribute('viewBox') ?? '0 0 0 0').split(/\s+/).map(Number)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0]
}

describe('Board / axes label density (task-21 fix 1)', () => {
  // Mafs's XLabels fixes `y=5` on every x-axis label <text> (its x varies
  // with the label's math-space position); YLabels does the mirror image
  // (fixed `x=5`, varying `y`) — see XLabels/YLabels in
  // node_modules/mafs/build/index.js. Both groups share the same
  // "mafs-axis" class with no other distinguishing marker, so `y=5` is the
  // only DOM-visible way to isolate x-axis labels from y-axis ones.
  //
  // A raw count of *all* matching <text> nodes is NOT the same as what a
  // viewer actually sees: Mafs's PaneManager (same file) pre-renders
  // gridlines/labels across a power-of-2-quantized "pane" range well beyond
  // the axes' own viewBox (verified empirically — e.g. a nominal 0..50 axes
  // block gets an internal pane of roughly [-32, 64], to support smooth
  // pan/zoom even though this board's axes never pan or zoom). Most of that
  // is clipped by the outer <svg>'s own viewBox and never visible, but it's
  // still in the DOM, so counting every node would count invisible noise
  // and fail to reflect the actual overlap bug. We instead filter to labels
  // whose pixel `x` falls inside the rendered <svg>'s own viewBox — the
  // labels a viewer can actually see.
  function visibleXAxisLabels(container: HTMLElement, axesId: string): Element[] {
    const svg = container.querySelector(`[data-el-id="${axesId}"] svg`)
    if (!svg) return []
    const [vbX, , vbW] = svgViewBox(svg)
    return Array.from(svg.querySelectorAll('.mafs-axis text')).filter((t) => {
      if (t.getAttribute('y') !== '5') return false
      const x = Number(t.getAttribute('x'))
      return x >= vbX && x <= vbX + vbW
    })
  }

  it('renders fewer than 15 visible x-axis labels for a 0..50 axes range (was one per integer, i.e. 51)', async () => {
    seedScene([{ op: 'add', c: 'axes', id: 'ax1', xmin: 0, xmax: 50, ymin: -5, ymax: 5 }])
    await renderBoard()

    const labels = visibleXAxisLabels(container, 'ax1')
    expect(labels.length).toBeLessThan(15)
    expect(labels.length).toBeGreaterThan(3) // scaled, not collapsed to unreadably sparse
  })

  it('does not thin out an already-small -5..5 axes range (stays labeled every integer)', async () => {
    seedScene([{ op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 }])
    await renderBoard()

    const values = visibleXAxisLabels(container, 'ax1').map((t) => Number(t.textContent))
    // A small range's "nice" pitch is 1 (unchanged from Mafs's own default),
    // so consecutive integers must both still be present — proving this
    // range wasn't over-thinned by the same fix that thins a 0..50 range.
    expect(values).toContain(2)
    expect(values).toContain(3)
  })
})

describe('Board / on-axes label anchoring + clamping (task-21 fix 2)', () => {
  it('anchors on-axes label content to grow right+up (attach="ne"-equivalent), not centered', async () => {
    seedScene([
      { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
      { op: 'add', c: 'label', id: 'lbl1', on: 'ax1', x: 0, y: 0, tex: 'x^2 + y^2 = r^2' },
    ])
    await renderBoard()

    const box = container.querySelector('[data-el-id="lbl1"] foreignObject > div') as HTMLDivElement | null
    expect(box).toBeTruthy()
    // Centered anchoring (the task-21 bug) uses alignItems/justifyContent:
    // 'center'; growing right+up from the anchor uses 'flex-end'/'flex-start'
    // instead (mirrors Mafs's own <Text attach="ne"> semantics — see
    // `function Text` in node_modules/mafs/build/index.js).
    expect(box!.style.alignItems).toBe('flex-end')
    expect(box!.style.justifyContent).toBe('flex-start')
  })

  it('clamps an anchor placed off-canvas to the same on-canvas point as one placed at the edge', async () => {
    seedScene([
      { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
      { op: 'add', c: 'label', id: 'lblAtEdge', on: 'ax1', x: -10, y: 0, tex: 'a' },
      { op: 'add', c: 'label', id: 'lblOffCanvas', on: 'ax1', x: -500, y: 0, tex: 'b' },
    ])
    await renderBoard()

    const foAtEdge = container.querySelector('[data-el-id="lblAtEdge"] foreignObject')
    const foOffCanvas = container.querySelector('[data-el-id="lblOffCanvas"] foreignObject')
    expect(foAtEdge).toBeTruthy()
    expect(foOffCanvas).toBeTruthy()
    // Both anchors clamp into the same 5%-inside-xmin point, so they land at
    // the same pixel x — proving the far-off-canvas anchor got pulled back
    // onto the canvas instead of rendering (clipped) far to the left of it.
    expect(foOffCanvas!.getAttribute('x')).toBe(foAtEdge!.getAttribute('x'))
  })

  // task-19 nit (a): clampIntoRange (math.tsx) is symmetric — `Math.min(Math.max(v,
  // lo+margin), hi-margin)` clamps both ends of both axes identically. The
  // test above only pinned the low/xmin side; pin the high/xmax side and both
  // ends of the y axis too, rather than assuming symmetry untested.
  it('clamps a high-edge (x > xmax) anchor to the same on-canvas point as one at the high edge', async () => {
    seedScene([
      { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
      { op: 'add', c: 'label', id: 'lblAtHighEdge', on: 'ax1', x: 10, y: 0, tex: 'a' },
      { op: 'add', c: 'label', id: 'lblOffCanvasHigh', on: 'ax1', x: 500, y: 0, tex: 'b' },
    ])
    await renderBoard()

    const foAtEdge = container.querySelector('[data-el-id="lblAtHighEdge"] foreignObject')
    const foOffCanvas = container.querySelector('[data-el-id="lblOffCanvasHigh"] foreignObject')
    expect(foAtEdge).toBeTruthy()
    expect(foOffCanvas).toBeTruthy()
    expect(foOffCanvas!.getAttribute('x')).toBe(foAtEdge!.getAttribute('x'))
  })

  it('clamps y anchors (above ymax and below ymin) the same way x anchors are clamped', async () => {
    seedScene([
      { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
      { op: 'add', c: 'label', id: 'lblAtTopEdge', on: 'ax1', x: 0, y: 10, tex: 'a' },
      { op: 'add', c: 'label', id: 'lblAboveCanvas', on: 'ax1', x: 0, y: 500, tex: 'b' },
      { op: 'add', c: 'label', id: 'lblAtBottomEdge', on: 'ax1', x: 0, y: -10, tex: 'c' },
      { op: 'add', c: 'label', id: 'lblBelowCanvas', on: 'ax1', x: 0, y: -500, tex: 'd' },
    ])
    await renderBoard()

    const foTopEdge = container.querySelector('[data-el-id="lblAtTopEdge"] foreignObject')
    const foAbove = container.querySelector('[data-el-id="lblAboveCanvas"] foreignObject')
    const foBottomEdge = container.querySelector('[data-el-id="lblAtBottomEdge"] foreignObject')
    const foBelow = container.querySelector('[data-el-id="lblBelowCanvas"] foreignObject')
    expect(foTopEdge).toBeTruthy()
    expect(foAbove).toBeTruthy()
    expect(foBottomEdge).toBeTruthy()
    expect(foBelow).toBeTruthy()
    // Same pixel-equality pattern as the x-axis clamp tests, mirrored onto y.
    expect(foAbove!.getAttribute('y')).toBe(foTopEdge!.getAttribute('y'))
    expect(foBelow!.getAttribute('y')).toBe(foBottomEdge!.getAttribute('y'))
  })

  it('renders an on-axes label anchored inside the rendered svg viewBox, not at a wildly off-canvas pixel position', async () => {
    seedScene([
      { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
      { op: 'add', c: 'label', id: 'lblFar', on: 'ax1', x: -1000, y: 0, tex: 'F = ma' },
    ])
    await renderBoard()

    const svg = container.querySelector('[data-el-id="ax1"] svg')
    const fo = container.querySelector('[data-el-id="lblFar"] foreignObject')
    expect(svg).toBeTruthy()
    expect(fo).toBeTruthy()
    // Compare against the svg's own rendered viewBox (its true visible pixel
    // bounds) rather than a hardcoded pixel guess — Mafs's pixel coordinates
    // aren't offset to start at 0 (a <text>'s own `x`/`y` attrs are
    // `value * scale`; the *pane offset* lives entirely in the outer <svg
    // viewBox="...">), so "on-canvas" only means "inside that viewBox", not
    // "positive" or "less than the raw pixel width". An unclamped anchor at
    // x=-1000 against a -10..10 axes would land many thousands of pixels to
    // the left of this viewBox; a clamped one lands inside it.
    const [vbX, , vbW] = svgViewBox(svg!)
    const px = Number(fo!.getAttribute('x'))
    expect(px).toBeGreaterThanOrEqual(vbX)
    expect(px).toBeLessThanOrEqual(vbX + vbW)
  })
})

// ---------------------------------------------------------------------------
// task-pe: axes.grid:false ("clean diagrams") — Mafs couples gridline
// visibility and tick-label spacing onto the same `lines` field (see
// AxesCoordinates' comment in math.tsx), so grid:false drops both rather
// than ship back the task-21 label-density bug; the axis line itself
// (Coordinates.Cartesian's own `xAxis.axis`/`yAxis.axis`, unaffected by this
// change) still renders regardless.
// ---------------------------------------------------------------------------
describe('Board / axes grid:false (task-pe)', () => {
  it('renders numeric axis-tick labels by default (grid unset/true)', async () => {
    seedScene([{ op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 }])
    await renderBoard()
    const svg = container.querySelector('[data-el-id="ax1"] svg')!
    expect(svg.querySelectorAll('.mafs-axis text').length).toBeGreaterThan(0)
  })

  it('hides tick labels (and the gridline pattern that shares their spacing) when grid:false', async () => {
    seedScene([{ op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10, grid: false }])
    await renderBoard()
    const svg = container.querySelector('[data-el-id="ax1"] svg')!
    expect(svg.querySelectorAll('.mafs-axis text').length).toBe(0)
  })

  it('still renders child components (e.g. a plot) normally when grid is off', async () => {
    seedScene([
      { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10, grid: false },
      { op: 'add', c: 'plot', id: 'pl1', on: 'ax1', expr: 'x^2' },
    ])
    await expect(renderBoard()).resolves.not.toThrow()
    expect(container.querySelector('[data-el-id="pl1"]')).toBeTruthy()
  })
})
