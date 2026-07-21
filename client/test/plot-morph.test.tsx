// plot-morph.test.tsx — PlotRenderer's renderer-level expr morph (task-s2,
// "more ways to visualize... 3b1b feel"): timeline.ts's `set`+`dur` tweening
// only handles NUMERIC params, so an `expr` change used to swap the plotted
// function instantly at commit with no animation. math.tsx's PlotRenderer
// now keeps the previous compiled fn around for ~600ms and locally
// interpolates y = (1-p)*f_old(x) + p*f_new(x), p driven by a real rAF loop
// — this file drives that with REAL timers (not mocked/faked) since the
// animation is genuinely wall-clock-paced via requestAnimationFrame +
// performance.now(), both real implementations under jsdom (verified
// available in this workspace's test environment).
//
// Testing trick: both exprs used here ('0' and '10') are CONSTANT functions
// — every sampled point along Mafs's rendered <path> shares the same y
// pixel value for a constant fn, so reading the first "M x y" point off the
// path's `d` attribute is a complete, exact stand-in for "the plotted
// value" without needing to reproduce Mafs's own x<->pixel mapping.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Action, applyAction, emptyScene } from '@board/shared'
import Board from '../src/board/Board'
import { useBoard } from '../src/store'

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

const AXES: Action = { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 }

function seed(actions: Action[]): void {
  const scene = actions.reduce(applyAction, emptyScene)
  useBoard.setState({ scene, liveOverrides: {}, selection: null, history: actions })
}

async function renderBoard(): Promise<void> {
  await act(async () => {
    root.render(<Board />)
  })
}

function firstPathPointY(container: HTMLElement, elId: string): number {
  const d = container.querySelector(`[data-el-id="${elId}"] path`)?.getAttribute('d') ?? ''
  const m = /M\s*(-?[\d.]+)\s+(-?[\d.]+)/.exec(d)
  if (!m) throw new Error(`no sampled path point for ${elId}: d="${d}"`)
  return Number(m[2])
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('PlotRenderer expr morph (task-s2)', () => {
  it('mid-morph, the plotted value sits strictly between the old and new expr values; after settling, it matches the new expr exactly', async () => {
    // Reference: a plot mounted directly at expr='10' (no prior expr, so no
    // morph ever triggers) — the settled target value to compare against.
    const refContainer = document.createElement('div')
    document.body.appendChild(refContainer)
    const refRoot = createRoot(refContainer)
    seed([AXES, { op: 'add', c: 'plot', id: 'plRef', on: 'ax1', expr: '10' }])
    await act(async () => {
      refRoot.render(<Board />)
    })
    const yTen = firstPathPointY(refContainer, 'plRef')
    act(() => {
      refRoot.unmount()
    })
    refContainer.remove()

    // Subject: starts at expr='0', then changes (same element id, so the
    // same PlotRenderer instance persists and the morph engages) to expr='10'.
    seed([AXES, { op: 'add', c: 'plot', id: 'pl1', on: 'ax1', expr: '0' }])
    await renderBoard()
    const yZero = firstPathPointY(container, 'pl1')
    expect(yZero).not.toBeCloseTo(yTen, 0) // sanity: the two target values are actually visually distinct

    await act(async () => {
      seed([AXES, { op: 'add', c: 'plot', id: 'pl1', on: 'ax1', expr: '10' }])
    })
    // Immediately after the change (same tick, no wait): still at (or very
    // near) the OLD value, not instantly swapped.
    const yImmediate = firstPathPointY(container, 'pl1')
    expect(Math.abs(yImmediate - yZero)).toBeLessThan(Math.abs(yTen - yZero) * 0.25)

    // Partway through the 600ms morph: strictly between the two endpoints.
    await act(async () => {
      await wait(300)
    })
    const yMid = firstPathPointY(container, 'pl1')
    const lo = Math.min(yZero, yTen)
    const hi = Math.max(yZero, yTen)
    expect(yMid).toBeGreaterThan(lo)
    expect(yMid).toBeLessThan(hi)

    // Well past the 600ms morph duration: settled exactly on the new value.
    await act(async () => {
      await wait(500)
    })
    const yFinal = firstPathPointY(container, 'pl1')
    expect(Math.abs(yFinal - yTen)).toBeLessThan(0.5)
  }, 10000)

  // fix round 1: a second expr change mid-morph used to read the previous
  // morph's TARGET (prevFnRef) as the new fromFn, snapping the plot back to
  // that superseded target before re-morphing (0->10 interrupted at
  // blend~0.5 by a change to 20 would restart from 10, not from the ~5
  // actually on screen). math.tsx's `blendAt` now freezes the in-flight
  // blend at the instant of interruption instead, so the value at that exact
  // moment stays continuous.
  it('a second expr change mid-morph continues from the in-flight blend (no snap to the superseded target)', async () => {
    // Reference settled values (mounted directly at the target expr, so no
    // morph ever engages) to compare against.
    async function settledValue(expr: string): Promise<number> {
      const refContainer = document.createElement('div')
      document.body.appendChild(refContainer)
      const refRoot = createRoot(refContainer)
      seed([AXES, { op: 'add', c: 'plot', id: 'plRef', on: 'ax1', expr }])
      await act(async () => {
        refRoot.render(<Board />)
      })
      const y = firstPathPointY(refContainer, 'plRef')
      act(() => {
        refRoot.unmount()
      })
      refContainer.remove()
      return y
    }
    const yTen = await settledValue('10')
    const yTwenty = await settledValue('20')

    seed([AXES, { op: 'add', c: 'plot', id: 'pl1', on: 'ax1', expr: '0' }])
    await renderBoard()
    const yZero = firstPathPointY(container, 'pl1')

    // Start the 0 -> 10 morph.
    await act(async () => {
      seed([AXES, { op: 'add', c: 'plot', id: 'pl1', on: 'ax1', expr: '10' }])
    })

    // Advance to roughly the halfway point of the 600ms morph.
    await act(async () => {
      await wait(300)
    })

    // Interrupt with a second expr change before the first morph settles.
    await act(async () => {
      seed([AXES, { op: 'add', c: 'plot', id: 'pl1', on: 'ax1', expr: '20' }])
    })
    const yAtInterrupt = firstPathPointY(container, 'pl1')

    // Continuity: the value at the instant of interruption should sit near
    // the blended 0/10 midpoint (~5) — NOT snap back to the superseded
    // target (10), which is exactly what the bug did.
    const expectedMid = (yZero + yTen) / 2
    const span = Math.abs(yTen - yZero)
    expect(Math.abs(yAtInterrupt - expectedMid)).toBeLessThan(span * 0.35)
    expect(Math.abs(yAtInterrupt - yTen)).toBeGreaterThan(span * 0.35)

    // Well past the new (second) 600ms morph's duration: settled exactly on
    // the newest target, 20.
    await act(async () => {
      await wait(700)
    })
    const yFinal = firstPathPointY(container, 'pl1')
    expect(Math.abs(yFinal - yTwenty)).toBeLessThan(0.5)
  }, 10000)
})
