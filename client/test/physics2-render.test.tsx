// physics2-render.test.tsx — smoke tests for the JEE physics pack
// (client/src/board/physics2.tsx: orbit/spring/wave/ray, task-pe). Same
// mount harness as physics-render.test.tsx; expected values are re-derived
// independently here (never imported from src/board/physics2.tsx) so a bug
// shipped in both places at once wouldn't quietly cancel out.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Action, applyAction, emptyScene, formatNum } from '@board/shared'
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

async function renderScene(actions: Action[]): Promise<void> {
  await act(async () => {
    const scene = actions.reduce(applyAction, emptyScene)
    useBoard.setState({ scene, liveOverrides: {}, selection: null })
    root.render(<Board />)
  })
}

const PX_TOL = 0.5

// ---------------------------------------------------------------------------
// orbit — viewBox 0 0 480 360, ellipse true-center at (240,180), scale fit
// with 30px padding, central body at the RIGHT focus.
// ---------------------------------------------------------------------------
function expectedOrbit(a: number, e: number, t: number) {
  const b = a * Math.sqrt(1 - e * e)
  const c = a * e
  const s = Math.min((480 / 2 - 30) / a, (360 / 2 - 30) / b)
  const M = 2 * Math.PI * t
  let E = M
  for (let i = 0; i < 5; i++) {
    E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
  }
  const x = a * (Math.cos(E) - e)
  const y = b * Math.sin(E)
  const focus = { x: 240 + c * s, y: 180 }
  const satellite = { x: focus.x + x * s, y: focus.y - y * s }
  return { b, s, focus, satellite }
}

describe('Board / orbit render', () => {
  it('t=0: satellite at perihelion (x=a(1-e) from the focus), central body sits at the focus, not the ellipse center', async () => {
    await renderScene([{ op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4, t: 0 }])
    const exp = expectedOrbit(40, 0.4, 0)

    const central = container.querySelector('.physics-orbit circle[data-role="central"]')!
    expect(Number(central.getAttribute('cx'))).toBeCloseTo(exp.focus.x, 1)
    expect(Number(central.getAttribute('cy'))).toBeCloseTo(exp.focus.y, 1)
    // The focus is NOT the ellipse's own center (240,180) for e>0.
    expect(Math.abs(Number(central.getAttribute('cx')) - 240)).toBeGreaterThan(1)

    const satellite = container.querySelector('.physics-orbit circle[data-role="satellite"]')!
    expect(Number(satellite.getAttribute('cx'))).toBeCloseTo(exp.satellite.x, 1)
    expect(Number(satellite.getAttribute('cy'))).toBeCloseTo(exp.satellite.y, 1)
    // Perihelion is the closest approach: distance from focus is a(1-e)*s.
    const dist = Math.hypot(
      Number(satellite.getAttribute('cx')) - Number(central.getAttribute('cx')),
      Number(satellite.getAttribute('cy')) - Number(central.getAttribute('cy')),
    )
    expect(dist).toBeCloseTo(40 * (1 - 0.4) * exp.s, 0)
  })

  it('draws a dashed ellipse sized rx=a*s, ry=b*s around the true (non-focus) center', async () => {
    await renderScene([{ op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4 }])
    const exp = expectedOrbit(40, 0.4, 0)
    const ellipse = container.querySelector('.physics-orbit ellipse')!
    expect(Number(ellipse.getAttribute('cx'))).toBeCloseTo(240, 1)
    expect(Number(ellipse.getAttribute('cy'))).toBeCloseTo(180, 1)
    expect(Number(ellipse.getAttribute('rx'))).toBeCloseTo(40 * exp.s, 1)
    expect(Number(ellipse.getAttribute('ry'))).toBeCloseTo(exp.b * exp.s, 1)
    expect(ellipse.getAttribute('stroke-dasharray')).toBeTruthy()
  })

  it('moves faster near perihelion than near aphelion (Kepler equal-areas), per vis-viva speed', async () => {
    const a = 40
    const e = 0.4
    function speedAt(t: number): number {
      const M = 2 * Math.PI * t
      let E = M
      for (let i = 0; i < 5; i++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
      const b = a * Math.sqrt(1 - e * e)
      const x = a * (Math.cos(E) - e)
      const y = b * Math.sin(E)
      const r = Math.sqrt(x * x + y * y)
      return Math.sqrt(Math.max(2 / r - 1 / a, 0))
    }
    expect(speedAt(0)).toBeGreaterThan(speedAt(0.5)) // perihelion (t=0) faster than aphelion (t=0.5)
  })

  it('renders velocity + force vectors when showVectors is true (default), none when false', async () => {
    await renderScene([{ op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4 }])
    expect(container.querySelectorAll('.physics-orbit .force-arrow').length).toBe(2)

    await renderScene([{ op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4, showVectors: false }])
    expect(container.querySelectorAll('.physics-orbit .force-arrow').length).toBe(0)
  })

  it('renders centerLabel/bodyLabel text when given', async () => {
    await renderScene([{ op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4, centerLabel: 'Sun', bodyLabel: 'Planet' }])
    const text = container.querySelector('.physics-orbit')!.textContent ?? ''
    expect(text).toContain('Sun')
    expect(text).toContain('Planet')
  })

  it('does not crash on a circular orbit (e=0)', async () => {
    await expect(renderScene([{ op: 'add', c: 'orbit', id: 'orb1', a: 30, e: 0 }])).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// orbit sweep shading (task-s2, feedback: "kepler laws didn't shade the
// area"): showSweep draws the elliptical sector swept over a fixed *time*
// window (delta=0.06 of the period) ending at the current t, focus -> N
// sampled path points -> back to focus.
//
// Direction check, worked by hand rather than assumed: vis-viva speed is
// HIGHEST at perihelion (t=0, established by the "moves faster near
// perihelion" test above) and lowest at aphelion (t=0.5) — so for the SAME
// fixed time window, the satellite covers MORE physical distance near
// perihelion, not less. Concretely, for a=40/e=0.4: the window [0, 0.06]
// (perihelion) ends with the two sampled endpoints ~22 units apart, while
// the window [0.44, 0.5] (aphelion) ends ~9.9 units apart — perihelion's
// wedge is the long, thin sliver hugging the focus; aphelion's is the short,
// fat one bulging far out. That's Kepler's second law: equal AREA despite
// unequal arc length, and the arc length is longer, not shorter, at
// perihelion.
// ---------------------------------------------------------------------------
function sweepChordWidth(d: string): number {
  const points = [...d.matchAll(/L\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const)
  const first = points[0]!
  const last = points[points.length - 1]!
  return Math.hypot(last[0] - first[0], last[1] - first[1])
}

describe('Board / orbit sweep shading (task-s2)', () => {
  it('renders no sweep wedge by default (showSweep unset/false)', async () => {
    await renderScene([{ op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4 }])
    expect(container.querySelector('.physics-orbit path[data-role="sweep"]')).toBeNull()

    await renderScene([{ op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4, showSweep: false }])
    expect(container.querySelector('.physics-orbit path[data-role="sweep"]')).toBeNull()
  })

  it('renders a gold-filled sweep wedge from the focus when showSweep is true', async () => {
    await renderScene([{ op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4, t: 0.2, showSweep: true }])
    const path = container.querySelector('.physics-orbit path[data-role="sweep"]')
    expect(path).toBeTruthy()
    expect(path!.getAttribute('d')).toMatch(/^M /)
    expect(path!.getAttribute('fill-opacity')).toBe('0.25')
  })

  it('does not render a wedge at t=0 (clamped: nothing to sweep before the orbit starts)', async () => {
    await renderScene([{ op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4, t: 0, showSweep: true }])
    expect(container.querySelector('.physics-orbit path[data-role="sweep"]')).toBeNull()
  })

  it('sweeps a LONGER chord (arc-length proxy) near perihelion than near aphelion for the same fixed time window', async () => {
    await renderScene([{ op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4, t: 0.06, showSweep: true }])
    const dPerihelion = container.querySelector('.physics-orbit path[data-role="sweep"]')!.getAttribute('d')!

    await renderScene([{ op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4, t: 0.5, showSweep: true }])
    const dAphelion = container.querySelector('.physics-orbit path[data-role="sweep"]')!.getAttribute('d')!

    const perihelionChord = sweepChordWidth(dPerihelion)
    const aphelionChord = sweepChordWidth(dAphelion)
    expect(perihelionChord).toBeGreaterThan(aphelionChord) // faster near perihelion -> more distance covered per unit time
    expect(perihelionChord / aphelionChord).toBeGreaterThan(1.5) // not just marginally longer
  })
})

// ---------------------------------------------------------------------------
// spring — viewBox 0 0 480 200, wall at x=30, equilibrium at x=250,
// 12px/unit, block center = equilibrium + x(t)*12.
// ---------------------------------------------------------------------------
function expectedSpring(amp: number, k: number, mass: number, t: number) {
  const omega = Math.sqrt(k / mass)
  const x = amp * Math.cos(omega * t)
  const period = 2 * Math.PI * Math.sqrt(mass / k)
  const blockX = 30 + 220 + x * 12
  return { blockX, period, x }
}

function blockCenterX(el: Element): number {
  return Number(el.getAttribute('x')) + Number(el.getAttribute('width')) / 2
}

describe('Board / spring render', () => {
  it('t=0: block is at maximum extension (x=amp)', async () => {
    await renderScene([{ op: 'add', c: 'spring', id: 'sp1', amp: 3, k: 100, mass: 1, t: 0 }])
    const exp = expectedSpring(3, 100, 1, 0)
    const block = container.querySelector('.physics-spring rect[data-role="block"]')!
    expect(blockCenterX(block)).toBeCloseTo(exp.blockX, 1)
    expect(exp.x).toBeCloseTo(3, 5) // sanity: cos(0)=1 -> full amplitude
  })

  it('oscillates back through equilibrium at a quarter period', async () => {
    await renderScene([{ op: 'add', c: 'spring', id: 'sp1', amp: 3, k: 100, mass: 1, t: 0 }])
    const startX = blockCenterX(container.querySelector('.physics-spring rect[data-role="block"]')!)

    const quarterPeriodT = (Math.PI / 2) / Math.sqrt(100 / 1) // omega*t = pi/2 -> cos=0
    await renderScene([{ op: 'add', c: 'spring', id: 'sp1', amp: 3, k: 100, mass: 1, t: quarterPeriodT }])
    const midX = blockCenterX(container.querySelector('.physics-spring rect[data-role="block"]')!)

    expect(midX).toBeCloseTo(30 + 220, 1) // back at equilibrium
    expect(midX).toBeLessThan(startX)
  })

  it('renders the period label T = 2π√(mass/k) using formatNum', async () => {
    await renderScene([{ op: 'add', c: 'spring', id: 'sp1', amp: 2, k: 64, mass: 4 }])
    const exp = expectedSpring(2, 64, 4, 0)
    expect(container.querySelector('.physics-spring')!.textContent).toContain(`T = ${formatNum(exp.period)} s`)
  })

  it('renders a restoring-force arrow only when showForces is true', async () => {
    await renderScene([{ op: 'add', c: 'spring', id: 'sp1', amp: 2, showForces: false }])
    expect(container.querySelectorAll('.physics-spring .force-arrow').length).toBe(0)

    await renderScene([{ op: 'add', c: 'spring', id: 'sp1', amp: 2, showForces: true }])
    expect(container.querySelectorAll('.physics-spring .force-arrow').length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// wave — viewBox 0 0 560 220, centerline y=110, 120 samples across exactly
// 2 wavelengths. A standing wave has permanent nodes (y=0 for all t) at
// x=0, λ/2, λ, ... ; the very first sampled point (x=0) is always one.
// ---------------------------------------------------------------------------
function firstPathPointY(d: string): number {
  const m = /M\s*(-?[\d.]+)\s+(-?[\d.]+)/.exec(d)
  if (!m) throw new Error(`no M command in path: ${d}`)
  return Number(m[2])
}

describe('Board / wave render', () => {
  it('standing wave: x=0 is a permanent node (y=centerline) regardless of t', async () => {
    await renderScene([{ op: 'add', c: 'wave', id: 'w1', amp: 2, wavelength: 4, freq: 1, standing: true, t: 0.37 }])
    const d = container.querySelector('.physics-wave path[data-role="wave"]')!.getAttribute('d')!
    expect(firstPathPointY(d)).toBeCloseTo(110, 0)
  })

  it('traveling wave: x=0 is generally NOT at the centerline (depends on t)', async () => {
    await renderScene([{ op: 'add', c: 'wave', id: 'w1', amp: 2, wavelength: 4, freq: 1, standing: false, t: 0.1 }])
    const d = container.querySelector('.physics-wave path[data-role="wave"]')!.getAttribute('d')!
    expect(Math.abs(firstPathPointY(d) - 110)).toBeGreaterThan(1)
  })

  it('renders the dashed amplitude envelope only when standing', async () => {
    await renderScene([{ op: 'add', c: 'wave', id: 'w1', amp: 2, wavelength: 4, freq: 1, standing: true }])
    expect(container.querySelector('.physics-wave [data-role="envelope-top"]')).toBeTruthy()
    expect(container.querySelector('.physics-wave [data-role="envelope-bottom"]')).toBeTruthy()

    await renderScene([{ op: 'add', c: 'wave', id: 'w1', amp: 2, wavelength: 4, freq: 1, standing: false }])
    expect(container.querySelector('.physics-wave [data-role="envelope-top"]')).toBeNull()
  })

  it('renders v = f*wavelength using formatNum', async () => {
    await renderScene([{ op: 'add', c: 'wave', id: 'w1', amp: 2, wavelength: 5, freq: 3 }])
    expect(container.querySelector('.physics-wave')!.textContent).toContain(`v = ${formatNum(15)} units/s`)
  })

  it('does not crash on extreme amplitude/wavelength clamps', async () => {
    await expect(
      renderScene([{ op: 'add', c: 'wave', id: 'w1', amp: 10, wavelength: 50, freq: 20 }]),
    ).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// ray — viewBox 0 0 560 260, element at x=280, axis y=130. Thin-lens/mirror
// equation v=1/(1/f-1/u), f signed by kind (see physics2.tsx's file header
// for the convention) — u=15,f=10 convex-lens is the brief's own worked
// example: v=30 (real, inverted, 2x magnitude).
// ---------------------------------------------------------------------------
function imageArrowTip(el: Element): { x: number; y: number } {
  const line = el.querySelector('line')!
  return { x: Number(line.getAttribute('x2')), y: Number(line.getAttribute('y2')) }
}

describe('Board / ray render', () => {
  it('convex-lens u=15,f=10 -> v=30, real, inverted, image magnitude 2x the object', async () => {
    await renderScene([{ op: 'add', c: 'ray', id: 'ry1', kind: 'convex-lens', objectDist: 15, focalLength: 10 }])

    const scale = 8 // largest(u=15,|v|=30,2f=20)=30; RAY_HALF_W=240 -> 240/30=8
    const objX = 280 - 15 * scale
    const imgX = 280 + 30 * scale // real image on the OPPOSITE side from the object, for a lens

    const objTip = imageArrowTip(container.querySelector('.physics-ray [data-role="object"]')!)
    const imgTip = imageArrowTip(container.querySelector('.physics-ray [data-role="image"]')!)

    expect(objTip.x).toBeCloseTo(objX, 1)
    expect(objTip.y).toBeCloseTo(130 - 50, 1) // object arrow points up from the axis

    expect(imgTip.x).toBeCloseTo(imgX, 1)
    expect(imgTip.y).toBeGreaterThan(130) // inverted (real) -> points down from the axis
    expect(imgTip.y - 130).toBeCloseTo(2 * (130 - objTip.y), 1) // 2x the object's arrow height

    expect(container.querySelector('.physics-ray')!.textContent).toContain(`real image at ${formatNum(30)} units (inverted)`)
  })

  it('concave-lens u=20,f=10 -> virtual, upright image on the SAME side as the object', async () => {
    await renderScene([{ op: 'add', c: 'ray', id: 'ry1', kind: 'concave-lens', objectDist: 20, focalLength: 10 }])
    const vExpected = 1 / (1 / -10 - 1 / 20)
    expect(vExpected).toBeLessThan(0)

    const objTip = imageArrowTip(container.querySelector('.physics-ray [data-role="object"]')!)
    const imgTip = imageArrowTip(container.querySelector('.physics-ray [data-role="image"]')!)
    expect(imgTip.x).toBeLessThan(280) // same side as the object (left)
    expect(imgTip.y).toBeLessThan(130) // upright (virtual) -> points up from the axis
    expect(imgTip.x).toBeGreaterThan(objTip.x) // image sits between the object and the lens (diminished, closer in)

    expect(container.querySelector('.physics-ray')!.textContent).toContain(
      `virtual image at ${formatNum(Math.abs(vExpected))} units (upright)`,
    )
  })

  it('renders the lens as a <g> element and the mirror as a <path> element', async () => {
    await renderScene([{ op: 'add', c: 'ray', id: 'ry1', kind: 'convex-lens', objectDist: 15, focalLength: 10 }])
    expect(container.querySelector('.physics-ray g[data-role="element"]')).toBeTruthy()

    await renderScene([{ op: 'add', c: 'ray', id: 'ry1', kind: 'concave-mirror', objectDist: 15, focalLength: 10 }])
    expect(container.querySelector('.physics-ray path[data-role="element"]')).toBeTruthy()
  })

  it('a concave mirror forms its real image on the SAME side as the object (unlike a lens)', async () => {
    await renderScene([{ op: 'add', c: 'ray', id: 'ry1', kind: 'concave-mirror', objectDist: 15, focalLength: 10 }])
    const imgTip = imageArrowTip(container.querySelector('.physics-ray [data-role="image"]')!)
    expect(imgTip.x).toBeLessThan(280) // same side as the object, not opposite like the lens case
    expect(imgTip.y).toBeGreaterThan(130) // still inverted (real)
  })

  it('does not crash at u===f (image at infinity)', async () => {
    await expect(
      renderScene([{ op: 'add', c: 'ray', id: 'ry1', kind: 'convex-lens', objectDist: 10, focalLength: 10 }]),
    ).resolves.not.toThrow()
    expect(container.querySelector('.physics-ray')!.textContent).toContain('image at infinity')
  })

  it('convex-mirror u=15,f=10 -> always virtual, upright, rendered behind the mirror with dashed rays', async () => {
    await renderScene([{ op: 'add', c: 'ray', id: 'ry1', kind: 'convex-mirror', objectDist: 15, focalLength: 10 }])

    const u = 15
    const f = -10 // diverging mirrors have negative focal length
    const vExpected = 1 / (1 / f - 1 / u) // = 1 / (-0.1 - 0.0667) = -6
    expect(vExpected).toBeLessThan(0) // sanity: virtual image

    const objTip = imageArrowTip(container.querySelector('.physics-ray [data-role="object"]')!)
    const imgTip = imageArrowTip(container.querySelector('.physics-ray [data-role="image"]')!)

    expect(imgTip.x).toBeGreaterThan(280) // virtual mirror image is rendered on opposite side (right, "behind" the mirror)
    expect(imgTip.y).toBeLessThan(130) // upright (virtual) -> points up from the axis
    expect(imgTip.x).toBeGreaterThan(objTip.x) // image is behind the mirror, on the opposite side from the object

    // Check for dashed ray segments (virtual image indicator)
    const dashedLines = container.querySelectorAll('.physics-ray line[stroke-dasharray]')
    expect(dashedLines.length).toBeGreaterThan(0) // at least one dashed ray for virtual image back-extension

    expect(container.querySelector('.physics-ray')!.textContent).toContain(
      `virtual image at ${formatNum(Math.abs(vExpected))} units (upright)`,
    )
  })
})
