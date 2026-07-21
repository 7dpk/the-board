import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Action, applyAction, emptyScene, formatNum } from '@board/shared'
import Board from '../src/board/Board'
import { useBoard } from '../src/store'

// ---------------------------------------------------------------------------
// Mount harness — same pattern as test/math-render.test.tsx (no
// @testing-library/react in this workspace; drive react-dom/client directly,
// wrapping every render in `act` so effects flush before assertions run).
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

// Seeds the store and (re-)renders in a single `act` so a second call mid-test
// (re-rendering the same root with a different param, e.g. a new `t`) doesn't
// trigger a "state update not wrapped in act" warning — the store update and
// the render it triggers both need to be inside the same act() batch.
async function renderScene(actions: Action[]): Promise<void> {
  await act(async () => {
    const scene = actions.reduce(applyAction, emptyScene)
    useBoard.setState({ scene, liveOverrides: {}, selection: null })
    root.render(<Board />)
  })
}

// ---------------------------------------------------------------------------
// Independent re-derivation of the brief's formulas, used only to compute
// *expected* values in these tests — never imported from src/board/physics.tsx,
// so a bug that ships in both places at once wouldn't quietly cancel out.
// ---------------------------------------------------------------------------
function expectedProjectile(v0: number, deg: number, g: number, t: number) {
  const theta = (deg * Math.PI) / 180
  const T = (2 * v0 * Math.sin(theta)) / g
  const R = (v0 * v0 * Math.sin(2 * theta)) / g
  const H = (v0 * v0 * Math.sin(theta) * Math.sin(theta)) / (2 * g)
  const s = Math.min(520 / R, 220 / H)
  const tau = t * T
  const mx = v0 * Math.cos(theta) * tau
  const my = v0 * Math.sin(theta) * tau - 0.5 * g * tau * tau
  return { R, H, s, cx: 40 + mx * s, cy: 280 - my * s }
}

function expectedPendulumBob(length: number, deg0: number, t: number) {
  const k = Math.min(240 / Math.max(length, 1), 120)
  const omega = Math.sqrt(9.8 / length)
  const theta = ((deg0 * Math.PI) / 180) * Math.cos(omega * t)
  return { x: 200 + length * k * Math.sin(theta), y: 40 + length * k * Math.cos(theta) }
}

const PX_TOL = 0.5

describe('Board / physics render pack', () => {
  describe('projectile', () => {
    it('v0=20,deg=45,t=1: ball lands at the computed range R (cx ≈ 40 + R·s, cy ≈ ground)', async () => {
      await renderScene([{ op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45, t: 1 }])

      const ball = container.querySelector('.physics-projectile circle[data-role="ball"]')
      expect(ball).toBeTruthy()
      const exp = expectedProjectile(20, 45, 9.8, 1)
      expect(Number(ball!.getAttribute('cx'))).toBeCloseTo(exp.cx, 1)
      expect(Number(ball!.getAttribute('cy'))).toBeCloseTo(exp.cy, 1)
      expect(Math.abs(Number(ball!.getAttribute('cy')) - 280)).toBeLessThan(PX_TOL)
    })

    it('v0=20,deg=45,t=0.5: ball is at apex — cy is minimal vs t=0 and t=1', async () => {
      await renderScene([{ op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45, t: 0 }])
      const cyAtStart = Number(container.querySelector('.physics-projectile circle[data-role="ball"]')!.getAttribute('cy'))

      await renderScene([{ op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45, t: 0.5 }])
      const ballMid = container.querySelector('.physics-projectile circle[data-role="ball"]')!
      const cxAtApex = Number(ballMid.getAttribute('cx'))
      const cyAtApex = Number(ballMid.getAttribute('cy'))

      await renderScene([{ op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45, t: 1 }])
      const cyAtEnd = Number(container.querySelector('.physics-projectile circle[data-role="ball"]')!.getAttribute('cy'))

      const exp = expectedProjectile(20, 45, 9.8, 0.5)
      expect(cxAtApex).toBeCloseTo(exp.cx, 1)
      expect(cyAtApex).toBeCloseTo(exp.cy, 1)
      expect(cyAtApex).toBeLessThan(cyAtStart)
      expect(cyAtApex).toBeLessThan(cyAtEnd)
    })

    it('renders the R label using formatNum', async () => {
      await renderScene([{ op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45 }])
      const exp = expectedProjectile(20, 45, 9.8, 0)
      expect(container.querySelector('.physics-projectile')!.textContent).toContain(`R = ${formatNum(exp.R)} m`)
    })

    it('renders a 41-sample dashed trace path when trace is true (default), and skips it when false', async () => {
      await renderScene([{ op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45 }])
      const dashedPaths = Array.from(container.querySelectorAll('.physics-projectile path')).filter(
        (p) => p.getAttribute('stroke-dasharray'),
      )
      expect(dashedPaths.length).toBe(1)
      // 41 samples joined as "M x y L x y L x y ..." -> 1 M + 40 L commands.
      expect((dashedPaths[0]!.getAttribute('d') ?? '').match(/[ML]/g)?.length).toBe(41)

      await renderScene([{ op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45, trace: false }])
      const dashedAfter = Array.from(container.querySelectorAll('.physics-projectile path')).filter((p) =>
        p.getAttribute('stroke-dasharray'),
      )
      expect(dashedAfter.length).toBe(0)
    })

    it('does not crash on missing optional params', async () => {
      await expect(renderScene([{ op: 'add', c: 'projectile', id: 'p1', v0: 15, deg: 30 }])).resolves.not.toThrow()
      expect(container.querySelector('.physics-projectile circle[data-role="ball"]')).toBeTruthy()
    })
  })

  describe('pendulum', () => {
    it('length=2,deg0=30,t=0: bob at max displacement', async () => {
      await renderScene([{ op: 'add', c: 'pendulum', id: 'pd1', length: 2, deg0: 30, t: 0 }])
      const bob = container.querySelector('.physics-pendulum circle[data-role="bob"]')
      expect(bob).toBeTruthy()
      const exp = expectedPendulumBob(2, 30, 0)
      expect(Number(bob!.getAttribute('cx'))).toBeCloseTo(exp.x, 1)
      expect(Number(bob!.getAttribute('cy'))).toBeCloseTo(exp.y, 1)
    })

    it('at t=π/ω the bob is mirrored across the pivot (θ negated) vs t=0', async () => {
      await renderScene([{ op: 'add', c: 'pendulum', id: 'pd1', length: 2, deg0: 30, t: 0 }])
      const bobStart = container.querySelector('.physics-pendulum circle[data-role="bob"]')!
      const x0 = Number(bobStart.getAttribute('cx'))
      const y0 = Number(bobStart.getAttribute('cy'))

      const omega = Math.sqrt(9.8 / 2)
      const tMirror = Math.PI / omega
      await renderScene([{ op: 'add', c: 'pendulum', id: 'pd1', length: 2, deg0: 30, t: tMirror }])
      const bobMirror = container.querySelector('.physics-pendulum circle[data-role="bob"]')!
      const xM = Number(bobMirror.getAttribute('cx'))
      const yM = Number(bobMirror.getAttribute('cy'))

      const exp = expectedPendulumBob(2, 30, tMirror)
      expect(xM).toBeCloseTo(exp.x, 1)
      expect(yM).toBeCloseTo(exp.y, 1)
      // Mirrored across the pivot's x=200: same magnitude of horizontal
      // displacement, opposite sign; height (y) unchanged.
      expect(xM - 200).toBeCloseTo(-(x0 - 200), 1)
      expect(yM).toBeCloseTo(y0, 1)
    })

    it('renders the period label T = 2π√(L/9.8) using formatNum', async () => {
      await renderScene([{ op: 'add', c: 'pendulum', id: 'pd1', length: 2, deg0: 30 }])
      const period = 2 * Math.PI * Math.sqrt(2 / 9.8)
      expect(container.querySelector('.physics-pendulum')!.textContent).toContain(`T = ${formatNum(period)} s`)
    })

    it('renders mg + tension force arrows when showForces is true, none when false', async () => {
      await renderScene([{ op: 'add', c: 'pendulum', id: 'pd1', length: 1, deg0: 20, showForces: true }])
      expect(container.querySelectorAll('.physics-pendulum .force-arrow').length).toBe(2)

      await renderScene([{ op: 'add', c: 'pendulum', id: 'pd1', length: 1, deg0: 20, showForces: false }])
      expect(container.querySelectorAll('.physics-pendulum .force-arrow').length).toBe(0)
    })
  })

  describe('fbd', () => {
    it('renders exactly forces.length force arrows', async () => {
      await renderScene([
        {
          op: 'add',
          c: 'fbd',
          id: 'fb1',
          label: 'Block',
          forces: [
            { name: 'gravity', deg: 270, mag: 50 },
            { name: 'normal', deg: 90, mag: 50 },
            { name: 'applied', deg: 0, mag: 20 },
          ],
        },
      ])
      const arrows = container.querySelectorAll('.physics-fbd .force-arrow')
      expect(arrows.length).toBe(3)
      expect(container.querySelector('.physics-fbd')!.textContent).toContain('Block')
    })

    it('does not crash with zero forces', async () => {
      await expect(renderScene([{ op: 'add', c: 'fbd', id: 'fb1', label: 'Empty', forces: [] }])).resolves.not.toThrow()
      expect(container.querySelectorAll('.physics-fbd .force-arrow').length).toBe(0)
    })
  })

  describe('incline', () => {
    it('renders a block group rotated by -deg', async () => {
      await renderScene([{ op: 'add', c: 'incline', id: 'in1', deg: 30, mu: 0.2, mass: 5 }])
      const block = container.querySelector('.physics-incline .incline-block')
      expect(block).toBeTruthy()
      expect(block!.getAttribute('transform')).toContain('rotate(30 ')
    })

    it('caps the apex height at y=40 for steep angles by shrinking the base', async () => {
      await renderScene([{ op: 'add', c: 'incline', id: 'in1', deg: 45 }])
      const triangle = container.querySelector('.physics-incline .incline-triangle')!
      const d = triangle.getAttribute('d') ?? ''
      // apex is the third point in "M bx,by L rx,ry L ax,ay Z" — its y must
      // not go below the viewBox's y=40 floor.
      const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number)
      const apexY = nums[5]
      expect(apexY).toBeGreaterThanOrEqual(40 - PX_TOL)
    })

    it('renders mg/normal force arrows when showForces is true, plus friction when mu>0', async () => {
      await renderScene([{ op: 'add', c: 'incline', id: 'in1', deg: 30, mu: 0, showForces: true }])
      expect(container.querySelectorAll('.physics-incline .force-arrow').length).toBe(2)

      await renderScene([{ op: 'add', c: 'incline', id: 'in1', deg: 30, mu: 0.3, showForces: true }])
      expect(container.querySelectorAll('.physics-incline .force-arrow').length).toBe(3)

      await renderScene([{ op: 'add', c: 'incline', id: 'in1', deg: 30, mu: 0.3, showForces: false }])
      expect(container.querySelectorAll('.physics-incline .force-arrow').length).toBe(0)
    })
  })

  describe('marker id uniqueness', () => {
    it('ensures no duplicate marker ids when rendering multiple physics elements in one scene', async () => {
      // Render both incline and pendulum to test multiple physics renderers
      await renderScene([
        { op: 'add', c: 'incline', id: 'in1', deg: 30, mu: 0.2, mass: 5, showForces: true },
        { op: 'add', c: 'pendulum', id: 'pd1', length: 1.5, deg0: 25, showForces: true },
      ])

      // Collect all elements with id attributes
      const elementsWithIds = Array.from(container.querySelectorAll('[id]'))
      const ids = elementsWithIds.map((el) => el.getAttribute('id')!)

      // Verify no duplicate ids: Set of unique ids should equal array length
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)

      // Verify both physics renderers produced force arrows
      expect(container.querySelectorAll('.physics-incline .force-arrow').length).toBeGreaterThan(0)
      expect(container.querySelectorAll('.physics-pendulum .force-arrow').length).toBeGreaterThan(0)
    })
  })
})
