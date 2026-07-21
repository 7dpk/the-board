import { describe, it, expect } from 'vitest'
import { applyAction, emptyScene, niceStep } from '../src/scene'
import type { Action } from '../src/protocol/actions'

describe('scene reducer', () => {
  it('add creates an element with defaults filled from DEFAULTS', () => {
    const scene = applyAction(emptyScene, { op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45 })
    expect(scene.elements.p1).toEqual({
      id: 'p1',
      c: 'projectile',
      params: { v0: 20, deg: 45, g: 9.8, t: 0, trace: true },
    })
    expect(scene.order).toEqual(['p1'])
  })

  it('add is idempotent: re-applying the same add does not duplicate order', () => {
    const a1: Action = { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: 2 }
    const s1 = applyAction(emptyScene, a1)
    const s2 = applyAction(s1, a1)
    expect(s2.order).toEqual(['pt1'])
    expect(s2.elements.pt1).toEqual(s1.elements.pt1)
  })

  it('add replaces (not merges) params when id already exists', () => {
    const s1 = applyAction(emptyScene, {
      op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: 2, color: 'blue',
    })
    const s2 = applyAction(s1, { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 5, y: 5 })
    expect(s2.order).toEqual(['pt1'])
    expect(s2.elements.pt1?.params).toEqual({ on: 'ax1', x: 5, y: 5, color: 'red' })
  })

  it('add fills per-type default color', () => {
    const scene = applyAction(emptyScene, { op: 'add', c: 'plot', id: 'pl1', on: 'ax1', expr: 'x^2' })
    expect(scene.elements.pl1?.params.color).toBe('blue')
  })

  it('add fills vector x1/y1 defaults to origin', () => {
    const scene = applyAction(emptyScene, { op: 'add', c: 'vector', id: 'v1', on: 'ax1', x2: 3, y2: 4 })
    expect(scene.elements.v1?.params.x1).toBe(0)
    expect(scene.elements.v1?.params.y1).toBe(0)
  })

  it('add fills incline defaults', () => {
    const scene = applyAction(emptyScene, { op: 'add', c: 'incline', id: 'in1', deg: 30 })
    expect(scene.elements.in1?.params).toMatchObject({ mu: 0, mass: 1, showForces: true })
  })

  it('add fills pendulum defaults', () => {
    const scene = applyAction(emptyScene, { op: 'add', c: 'pendulum', id: 'pd1', length: 2, deg0: 30 })
    expect(scene.elements.pd1?.params).toMatchObject({ t: 0, showForces: true })
  })

  it('add fills axes grid default to true', () => {
    const scene = applyAction(emptyScene, { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 })
    expect(scene.elements.ax1?.params.grid).toBe(true)
  })

  it('add axes with grid:false overrides the true default', () => {
    const scene = applyAction(emptyScene, { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10, grid: false })
    expect(scene.elements.ax1?.params.grid).toBe(false)
  })

  it('add fills orbit defaults', () => {
    const scene = applyAction(emptyScene, { op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.6 })
    expect(scene.elements.orb1?.params).toMatchObject({ t: 0, showVectors: true, e: 0.6 })
  })

  it('add fills spring defaults', () => {
    const scene = applyAction(emptyScene, { op: 'add', c: 'spring', id: 'sp1', amp: 2 })
    expect(scene.elements.sp1?.params).toMatchObject({ k: 100, mass: 1, t: 0, showForces: false })
  })

  it('add fills wave defaults', () => {
    const scene = applyAction(emptyScene, { op: 'add', c: 'wave', id: 'w1', amp: 2, wavelength: 4, freq: 1 })
    expect(scene.elements.w1?.params).toMatchObject({ t: 0, standing: false })
  })

  it('add fills ray defaults', () => {
    const scene = applyAction(emptyScene, {
      op: 'add', c: 'ray', id: 'ry1', kind: 'convex-lens', objectDist: 20, focalLength: 10,
    })
    expect(scene.elements.ry1?.params).toMatchObject({ showLabels: true })
  })

  it('add fills steps.shown to lines.length when omitted (dynamic default, not a static DEFAULTS entry)', () => {
    const scene = applyAction(emptyScene, {
      op: 'add', c: 'steps', id: 'st1', lines: ['2x = 8', 'x = 4', 'done'],
    })
    expect(scene.elements.st1?.params.shown).toBe(3)
  })

  it('add leaves an explicit steps.shown untouched rather than overriding it with lines.length', () => {
    const scene = applyAction(emptyScene, {
      op: 'add', c: 'steps', id: 'st1', lines: ['2x = 8', 'x = 4'], shown: 1,
    })
    expect(scene.elements.st1?.params.shown).toBe(1)
  })

  it('set shallow-merges {[k]: v} into params of an existing element', () => {
    const s1 = applyAction(emptyScene, { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: 2 })
    const s2 = applyAction(s1, { op: 'set', id: 'pt1', k: 'x', v: 9 })
    expect(s2.elements.pt1?.params.x).toBe(9)
    expect(s2.elements.pt1?.params.y).toBe(2)
  })

  it('set on an unknown id is a no-op', () => {
    const s2 = applyAction(emptyScene, { op: 'set', id: 'ghost', k: 'x', v: 9 })
    expect(s2).toEqual(emptyScene)
  })

  it('anim applies the final value (to) the same way set applies v', () => {
    const s1 = applyAction(emptyScene, { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: 2 })
    const s2 = applyAction(s1, { op: 'anim', id: 'pt1', k: 'x', to: 42, dur: 2 })
    expect(s2.elements.pt1?.params.x).toBe(42)
  })

  it('anim on an unknown id is a no-op', () => {
    const s2 = applyAction(emptyScene, { op: 'anim', id: 'ghost', k: 'x', to: 42, dur: 2 })
    expect(s2).toEqual(emptyScene)
  })

  it('del removes the element, its controls, and its id from order/focus', () => {
    let scene = applyAction(emptyScene, { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: 2 })
    scene = applyAction(scene, { op: 'ctl', id: 'pt1', k: 'x', kind: 'slider' })
    scene = applyAction(scene, { op: 'focus', ids: ['pt1'], style: 'highlight' })
    scene = applyAction(scene, { op: 'del', id: 'pt1' })
    expect(scene.elements.pt1).toBeUndefined()
    expect(scene.order).toEqual([])
    expect(scene.controls).toEqual([])
    expect(scene.focus).toBeNull()
  })

  it('del of an unknown id is a no-op', () => {
    const s2 = applyAction(emptyScene, { op: 'del', id: 'ghost' })
    expect(s2).toEqual(emptyScene)
  })

  it('clear keeps only the given ids, clearing controls/focus of removed ones, without touching steps', () => {
    let scene = applyAction(emptyScene, { op: 'step', title: 'Intro' })
    scene = applyAction(scene, { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: 2 })
    scene = applyAction(scene, { op: 'add', c: 'point', id: 'pt2', on: 'ax1', x: 3, y: 4 })
    scene = applyAction(scene, { op: 'ctl', id: 'pt1', k: 'x', kind: 'slider' })
    scene = applyAction(scene, { op: 'ctl', id: 'pt2', k: 'x', kind: 'slider' })
    scene = applyAction(scene, { op: 'focus', ids: ['pt1', 'pt2'], style: 'highlight' })
    scene = applyAction(scene, { op: 'clear', keep: ['pt1'] })
    expect(Object.keys(scene.elements)).toEqual(['pt1'])
    expect(scene.order).toEqual(['pt1'])
    expect(scene.controls.map((c) => c.id)).toEqual(['pt1'])
    expect(scene.focus?.ids).toEqual(['pt1'])
    expect(scene.steps).toEqual(['Intro'])
  })

  it('clear with no keep list removes everything', () => {
    let scene = applyAction(emptyScene, { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: 2 })
    scene = applyAction(scene, { op: 'clear' })
    expect(scene.elements).toEqual({})
    expect(scene.order).toEqual([])
  })

  it('ctl upserts a control keyed by (id,k), defaulting min/max from COMPONENT_SPECS clamps and step via niceStep', () => {
    let scene = applyAction(emptyScene, { op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45 })
    scene = applyAction(scene, { op: 'ctl', id: 'p1', k: 'deg', kind: 'slider' })
    expect(scene.controls).toHaveLength(1)
    expect(scene.controls[0]).toMatchObject({ id: 'p1', k: 'deg', kind: 'slider', min: 5, max: 85 })
    expect(scene.controls[0]?.step).toBe(niceStep(85 - 5))

    // upsert: same (id,k) replaces in place rather than duplicating
    scene = applyAction(scene, { op: 'ctl', id: 'p1', k: 'deg', kind: 'input', min: 0, max: 90 })
    expect(scene.controls).toHaveLength(1)
    expect(scene.controls[0]).toMatchObject({ kind: 'input', min: 0, max: 90 })
  })

  it('ctl falls back to +-10 default clamps when there is no spec/clamp for the key', () => {
    let scene = applyAction(emptyScene, { op: 'add', c: 'table', id: 't1', cols: ['x'], rows: [] })
    scene = applyAction(scene, { op: 'ctl', id: 't1', k: 'unknownKey', kind: 'input' })
    expect(scene.controls[0]).toMatchObject({ min: -10, max: 10 })
  })

  it('focus with style "none" clears focus', () => {
    let scene = applyAction(emptyScene, { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: 2 })
    scene = applyAction(scene, { op: 'focus', ids: ['pt1'], style: 'highlight' })
    scene = applyAction(scene, { op: 'focus', ids: [], style: 'none' })
    expect(scene.focus).toBeNull()
  })

  it('focus filters ids down to elements that currently exist', () => {
    let scene = applyAction(emptyScene, { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: 2 })
    scene = applyAction(scene, { op: 'focus', ids: ['pt1', 'ghost'], style: 'pulse' })
    expect(scene.focus).toEqual({ ids: ['pt1'], style: 'pulse' })
  })

  it('step appends the title to steps', () => {
    let scene = applyAction(emptyScene, { op: 'step', title: 'One' })
    scene = applyAction(scene, { op: 'step', title: 'Two' })
    expect(scene.steps).toEqual(['One', 'Two'])
  })

  it('say is a no-op', () => {
    const s = applyAction(emptyScene, { op: 'say', text: 'hi' })
    expect(s).toEqual(emptyScene)
  })

  it('ask is a no-op', () => {
    const s = applyAction(emptyScene, { op: 'ask', id: 'q1', kind: 'free', text: 'why?' })
    expect(s).toEqual(emptyScene)
  })

  it('wish is a no-op (task-pd)', () => {
    const s = applyAction(emptyScene, { op: 'wish', component: 'field-lines', why: 'electrostatics' })
    expect(s).toEqual(emptyScene)
  })

  it('niceStep snaps rough step to 1/2/5 x 10^k', () => {
    expect(niceStep(100)).toBe(1)
    expect(niceStep(1000)).toBe(10)
    expect(niceStep(20)).toBeCloseTo(0.2)
    expect(niceStep(1)).toBeCloseTo(0.01)
  })

  it('replay determinism: reducing the same action history twice yields identical JSON', () => {
    const actions: Action[] = [
      { op: 'step', title: 'Launch' },
      { op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45 },
      { op: 'ctl', id: 'p1', k: 'deg', kind: 'slider' },
      { op: 'anim', id: 'p1', k: 't', to: 1, dur: 3 },
      { op: 'focus', ids: ['p1'], style: 'highlight' },
      { op: 'set', id: 'p1', k: 'trace', v: false },
      { op: 'step', title: 'Result' },
      { op: 'del', id: 'p1' },
      { op: 'clear' },
    ]
    const s1 = actions.reduce(applyAction, emptyScene)
    const s2 = actions.reduce(applyAction, emptyScene)
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2))
  })
})
