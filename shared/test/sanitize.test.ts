import { describe, it, expect } from 'vitest'
import { sanitizeAction, sanitizeId } from '../src/sanitize'
import { applyAction, emptyScene, type Scene } from '../src/scene'
import { ActionSchema, addVariants, COMPONENT_SPECS, COMPONENT_TYPES } from '../src/index'
import type { Action } from '../src/protocol/actions'

function buildScene(): Scene {
  const actions: Action[] = [
    { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
    { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: 2 },
    { op: 'add', c: 'plot', id: 'pl1', on: 'ax1', expr: 'x^2' },
    { op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45 },
  ]
  return actions.reduce(applyAction, emptyScene)
}

describe('sanitizeId', () => {
  it('lowercases, strips disallowed chars, and truncates to 24 chars', () => {
    expect(sanitizeId('My Point!!')).toBe('mypoint')
    expect(sanitizeId('Already_ok-123')).toBe('already_ok-123')
    expect(sanitizeId('x'.repeat(30))).toBe('x'.repeat(24))
  })
})

describe('sanitizeAction', () => {
  it('passes a valid action through unchanged', () => {
    const scene = buildScene()
    const raw = { op: 'set', id: 'pt1', k: 'x', v: 5 }
    const result = sanitizeAction(raw, scene)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.action).toEqual(raw)
  })

  it('never mutates the raw input it is given', () => {
    const scene = buildScene()
    const raw = { op: 'add', c: 'point', id: 'My Point!!', on: 'ax1', x: 1, y: 2 }
    const before = JSON.stringify(raw)
    sanitizeAction(raw, scene)
    expect(JSON.stringify(raw)).toBe(before)
  })

  // (1) schema parse
  it('fails an object with an extra/unknown key (strict schema)', () => {
    const scene = buildScene()
    const result = sanitizeAction({ op: 'set', id: 'pt1', k: 'x', v: 5, hax: 1 }, scene)
    expect(result.ok).toBe(false)
  })

  it('fails an unknown op', () => {
    const scene = buildScene()
    const result = sanitizeAction({ op: 'zap', id: 'pt1' }, scene)
    expect(result.ok).toBe(false)
  })

  // (2) id normalization
  it('normalizes a messy id on add', () => {
    const scene = buildScene()
    const result = sanitizeAction(
      { op: 'add', c: 'point', id: 'My Point!!', on: 'ax1', x: 1, y: 2 },
      scene,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.action as { id: string }).id).toBe('mypoint')
  })

  it("fails an action whose id sanitizes down to '' (e.g. '!!!')", () => {
    const scene = buildScene()
    const result = sanitizeAction({ op: 'add', c: 'point', id: '!!!', on: 'ax1', x: 1, y: 2 }, scene)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/invalid id/i)
  })

  // (3) reference checks
  it('fails set on an unknown id', () => {
    const scene = buildScene()
    const result = sanitizeAction({ op: 'set', id: 'ghost', k: 'x', v: 5 }, scene)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/unknown id/i)
  })

  it('fails anim/del/ctl on an unknown id', () => {
    const scene = buildScene()
    expect(sanitizeAction({ op: 'anim', id: 'ghost', k: 'x', to: 1, dur: 1 }, scene).ok).toBe(false)
    expect(sanitizeAction({ op: 'del', id: 'ghost' }, scene).ok).toBe(false)
    expect(sanitizeAction({ op: 'ctl', id: 'ghost', k: 'x', kind: 'slider' }, scene).ok).toBe(false)
  })

  it('fails add with on pointing at a nonexistent id', () => {
    const scene = buildScene()
    const result = sanitizeAction(
      { op: 'add', c: 'point', id: 'pt9', on: 'ghost', x: 1, y: 1 },
      scene,
    )
    expect(result.ok).toBe(false)
  })

  it('fails add with on pointing at an id that is not an axes', () => {
    const scene = buildScene()
    const result = sanitizeAction(
      { op: 'add', c: 'point', id: 'pt9', on: 'pl1', x: 1, y: 1 },
      scene,
    )
    expect(result.ok).toBe(false)
  })

  it('silently filters unknown ids out of focus.ids, failing only if the whole list empties (non-none style)', () => {
    const scene = buildScene()
    const ok = sanitizeAction({ op: 'focus', ids: ['pt1', 'ghost'], style: 'highlight' }, scene)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect((ok.action as { ids: string[] }).ids).toEqual(['pt1'])

    const empty = sanitizeAction({ op: 'focus', ids: ['ghost'], style: 'highlight' }, scene)
    expect(empty.ok).toBe(false)
  })

  it('silently filters unknown ids out of clear.keep without failing', () => {
    const scene = buildScene()
    const result = sanitizeAction({ op: 'clear', keep: ['pt1', 'ghost'] }, scene)
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.action as { keep: string[] }).keep).toEqual(['pt1'])
  })

  it('silently drops an unknown say.sync id', () => {
    const scene = buildScene()
    const result = sanitizeAction({ op: 'say', text: 'hi', sync: 'ghost' }, scene)
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.action as { sync?: string }).sync).toBeUndefined()
  })

  // (4) key checks
  it('fails anim on a non-animatable key', () => {
    const scene = buildScene()
    // projectile.animatable = ['t','deg','v0']; 'g' is a param but not animatable
    const result = sanitizeAction({ op: 'anim', id: 'p1', k: 'g', to: 5, dur: 1 }, scene)
    expect(result.ok).toBe(false)
  })

  it('fails ctl on a non-controllable key', () => {
    const scene = buildScene()
    // point.controllable = ['x','y']; 'color' is not controllable
    const result = sanitizeAction({ op: 'ctl', id: 'pt1', k: 'color', kind: 'input' }, scene)
    expect(result.ok).toBe(false)
  })

  it('allows set to target animatable/controllable keys plus expr/label/tex/color', () => {
    const scene = buildScene()
    expect(sanitizeAction({ op: 'set', id: 'pt1', k: 'x', v: 5 }, scene).ok).toBe(true)
    expect(sanitizeAction({ op: 'set', id: 'pt1', k: 'color', v: 'blue' }, scene).ok).toBe(true)
    expect(sanitizeAction({ op: 'set', id: 'pl1', k: 'expr', v: 'x^3' }, scene).ok).toBe(true)
  })

  it('fails set on a key not in animatable/controllable/extras', () => {
    const scene = buildScene()
    const result = sanitizeAction({ op: 'set', id: 'pt1', k: 'bogusKey', v: 5 }, scene)
    expect(result.ok).toBe(false)
  })

  // task-19 nit (c): `set k='color'` is tightened to require both an
  // eligible target component type and a real ColorEnum value.
  describe('set color: component-type eligibility + ColorEnum value validation', () => {
    it('fails set color on axes (not a color-eligible component)', () => {
      const scene = buildScene()
      const result = sanitizeAction({ op: 'set', id: 'ax1', k: 'color', v: 'blue' }, scene)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/color not settable/i)
    })

    it('fails set color with a value that is not a ColorEnum member', () => {
      const scene = buildScene()
      const result = sanitizeAction({ op: 'set', id: 'pt1', k: 'color', v: 'chartreuse' }, scene)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/invalid color/i)
    })

    it('accepts set color on a segment (color-eligible) with a valid ColorEnum value', () => {
      const scene = buildScene()
      const addSeg = sanitizeAction(
        { op: 'add', c: 'segment', id: 'sg1', on: 'ax1', x1: 0, y1: 0, x2: 1, y2: 1 },
        scene,
      )
      expect(addSeg.ok).toBe(true)
      const sceneWithSeg = addSeg.ok ? applyAction(scene, addSeg.action) : scene

      const result = sanitizeAction({ op: 'set', id: 'sg1', k: 'color', v: 'red' }, sceneWithSeg)
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { v: string }).v).toBe('red')
    })
  })

  // task-19 nit (d): a cheap KaTeX-DoS guard — label.tex / say.text / a set
  // of k=tex|label truncate to 2000 chars rather than fail.
  describe('string length clamp: label.tex / say.text / set(k=tex|label).v', () => {
    it('truncates an add label.tex longer than 2000 chars', () => {
      const scene = buildScene()
      const longTex = 'x'.repeat(2500)
      const result = sanitizeAction({ op: 'add', c: 'label', id: 'lb1', tex: longTex }, scene)
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { tex: string }).tex).toHaveLength(2000)
    })

    it('truncates a say.text longer than 2000 chars', () => {
      const scene = buildScene()
      const longText = 'a'.repeat(2500)
      const result = sanitizeAction({ op: 'say', text: longText }, scene)
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { text: string }).text).toHaveLength(2000)
    })

    it('truncates a set k=tex value longer than 2000 chars', () => {
      const scene = buildScene()
      const addLabel = sanitizeAction({ op: 'add', c: 'label', id: 'lb1', tex: 'short' }, scene)
      expect(addLabel.ok).toBe(true)
      const sceneWithLabel = addLabel.ok ? applyAction(scene, addLabel.action) : scene

      const longTex = 'b'.repeat(2500)
      const result = sanitizeAction({ op: 'set', id: 'lb1', k: 'tex', v: longTex }, sceneWithLabel)
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { v: string }).v).toHaveLength(2000)
    })

    it('leaves a short say.text unchanged (no over-truncation)', () => {
      const scene = buildScene()
      const result = sanitizeAction({ op: 'say', text: 'short and fine' }, scene)
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { text: string }).text).toBe('short and fine')
    })
  })

  // (5) clamps
  it('clamps projectile v0 above range down to 100', () => {
    const scene = buildScene()
    const result = sanitizeAction({ op: 'add', c: 'projectile', id: 'p2', v0: 9999, deg: 45 }, scene)
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.action as { v0: number }).v0).toBe(100)
  })

  it('clamps set.v and anim.to to the target parameter clamp range', () => {
    const scene = buildScene()
    const setResult = sanitizeAction({ op: 'set', id: 'p1', k: 'deg', v: 999 }, scene)
    expect(setResult.ok).toBe(true)
    if (setResult.ok) expect((setResult.action as { v: number }).v).toBe(85)

    const animResult = sanitizeAction({ op: 'anim', id: 'p1', k: 'deg', to: -50, dur: 1 }, scene)
    expect(animResult.ok).toBe(true)
    if (animResult.ok) expect((animResult.action as { to: number }).to).toBe(5)
  })

  it('clamps ctl.min/max to the target parameter clamp range', () => {
    const scene = buildScene()
    // projectile.deg clamp is [5,85]
    const result = sanitizeAction({ op: 'ctl', id: 'p1', k: 'deg', kind: 'slider', min: -100, max: 9999 }, scene)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const action = result.action as { min?: number; max?: number }
      expect(action.min).toBe(5)
      expect(action.max).toBe(85)
    }
  })

  it('swaps xmin/xmax (and ymin/ymax) when given inverted', () => {
    const scene = buildScene()
    const result = sanitizeAction(
      { op: 'add', c: 'axes', id: 'ax2', xmin: 10, xmax: -10, ymin: 5, ymax: -5 },
      scene,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      const action = result.action as { xmin: number; xmax: number; ymin: number; ymax: number }
      expect(action.xmin).toBe(-10)
      expect(action.xmax).toBe(10)
      expect(action.ymin).toBe(-5)
      expect(action.ymax).toBe(5)
    }
  })

  it('clamps anim/set dur to [0.1, 10]', () => {
    const scene = buildScene()
    const tooLong = sanitizeAction({ op: 'anim', id: 'p1', k: 'deg', to: 60, dur: 50 }, scene)
    expect(tooLong.ok).toBe(true)
    if (tooLong.ok) expect((tooLong.action as { dur: number }).dur).toBe(10)

    const tooShort = sanitizeAction({ op: 'anim', id: 'p1', k: 'deg', to: 60, dur: 0.001 }, scene)
    expect(tooShort.ok).toBe(true)
    if (tooShort.ok) expect((tooShort.action as { dur: number }).dur).toBe(0.1)
  })

  it('truncates fbd.forces to 6 entries and clamps each mag/deg', () => {
    const scene = buildScene()
    const forces = Array.from({ length: 8 }, (_, i) => ({ name: `f${i}`, deg: 9999, mag: -50 }))
    const result = sanitizeAction({ op: 'add', c: 'fbd', id: 'fb1', label: 'Block', forces }, scene)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const action = result.action as { forces: { deg: number; mag: number }[] }
      expect(action.forces).toHaveLength(6)
      for (const f of action.forces) {
        expect(f.mag).toBeGreaterThanOrEqual(0)
        expect(f.deg).toBeLessThanOrEqual(360)
      }
    }
  })

  // (6) expr safety
  it('fails an add whose expr attempts a sandbox escape', () => {
    const scene = buildScene()
    const result = sanitizeAction(
      { op: 'add', c: 'plot', id: 'pl2', on: 'ax1', expr: "import('fs')" },
      scene,
    )
    expect(result.ok).toBe(false)
  })

  it('fails a set of k===\'expr\' whose v attempts a sandbox escape', () => {
    const scene = buildScene()
    const result = sanitizeAction({ op: 'set', id: 'pl1', k: 'expr', v: "system('rm')" }, scene)
    expect(result.ok).toBe(false)
  })

  it('accepts a safe expr', () => {
    const scene = buildScene()
    const result = sanitizeAction(
      { op: 'add', c: 'plot', id: 'pl3', on: 'ax1', expr: 'sin(x)*x^2' },
      scene,
    )
    expect(result.ok).toBe(true)
  })

  it('fails set of k===\'expr\' when v is not a string', () => {
    const scene = buildScene()
    const result = sanitizeAction({ op: 'set', id: 'pl1', k: 'expr', v: true }, scene)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/expr value must be a string/i)
  })

  it('clamps area from to sibling to when inverted on set', () => {
    const scene = buildScene()
    // Add an area with from=0, to=2
    const addArea = sanitizeAction(
      { op: 'add', c: 'area', id: 'ar1', on: 'ax1', expr: 'x^2', from: 0, to: 2 },
      scene,
    )
    expect(addArea.ok).toBe(true)
    const sceneWithArea = addArea.ok ? applyAction(scene, addArea.action) : scene

    // Try to set from=500 (inverted), should clamp to sibling to value (2)
    const result = sanitizeAction({ op: 'set', id: 'ar1', k: 'from', v: 500 }, sceneWithArea)
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.action as { v: number }).v).toBe(2)
  })

  it('clamps area to to sibling from when inverted on anim', () => {
    const scene = buildScene()
    // Add an area with from=0, to=2
    const addArea = sanitizeAction(
      { op: 'add', c: 'area', id: 'ar1', on: 'ax1', expr: 'x^2', from: 0, to: 2 },
      scene,
    )
    expect(addArea.ok).toBe(true)
    const sceneWithArea = addArea.ok ? applyAction(scene, addArea.action) : scene

    // Try to anim to=-5 (inverted), should clamp to sibling from value (0)
    const result = sanitizeAction({ op: 'anim', id: 'ar1', k: 'to', to: -5, dur: 1 }, sceneWithArea)
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.action as { to: number }).to).toBe(0)
  })

  it('accepts normal in-range set on area from unchanged', () => {
    const scene = buildScene()
    // Add an area with from=0, to=2
    const addArea = sanitizeAction(
      { op: 'add', c: 'area', id: 'ar1', on: 'ax1', expr: 'x^2', from: 0, to: 2 },
      scene,
    )
    expect(addArea.ok).toBe(true)
    const sceneWithArea = addArea.ok ? applyAction(scene, addArea.action) : scene

    // Set from=1 (in-range), should pass unchanged
    const result = sanitizeAction({ op: 'set', id: 'ar1', k: 'from', v: 1 }, sceneWithArea)
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.action as { v: number }).v).toBe(1)
  })

  // task-pa (1): steps — lines/notes truncation + shown clamp to lines.length
  describe('steps sanitization', () => {
    it('truncates lines to 20 entries and drops the rest', () => {
      const scene = buildScene()
      const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`)
      const result = sanitizeAction({ op: 'add', c: 'steps', id: 'st1', lines }, scene)
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { lines: string[] }).lines).toHaveLength(20)
    })

    it('truncates each line/note to 500 chars', () => {
      const scene = buildScene()
      const longLine = 'x'.repeat(600)
      const result = sanitizeAction(
        { op: 'add', c: 'steps', id: 'st1', lines: [longLine], notes: [longLine] },
        scene,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        const action = result.action as { lines: string[]; notes: string[] }
        expect(action.lines[0]).toHaveLength(500)
        expect(action.notes[0]).toHaveLength(500)
      }
    })

    it('truncates notes longer than lines down to lines.length', () => {
      const scene = buildScene()
      const result = sanitizeAction(
        {
          op: 'add', c: 'steps', id: 'st1',
          lines: ['a', 'b'],
          notes: ['note a', 'note b', 'note c', 'note d'],
        },
        scene,
      )
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { notes: string[] }).notes).toEqual(['note a', 'note b'])
    })

    it('clamps shown into [0, lines.length] at add time', () => {
      const scene = buildScene()
      const tooHigh = sanitizeAction(
        { op: 'add', c: 'steps', id: 'st1', lines: ['a', 'b', 'c'], shown: 39 },
        scene,
      )
      expect(tooHigh.ok).toBe(true)
      if (tooHigh.ok) expect((tooHigh.action as { shown: number }).shown).toBe(3)

      const negative = sanitizeAction(
        { op: 'add', c: 'steps', id: 'st2', lines: ['a', 'b', 'c'], shown: -5 },
        scene,
      )
      expect(negative.ok).toBe(true)
      if (negative.ok) expect((negative.action as { shown: number }).shown).toBe(0)
    })

    it('leaves short, in-bounds lines/notes/shown unchanged', () => {
      const scene = buildScene()
      const result = sanitizeAction(
        { op: 'add', c: 'steps', id: 'st1', lines: ['a', 'b'], notes: ['n1'], shown: 1 },
        scene,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        const action = result.action as { lines: string[]; notes: string[]; shown: number }
        expect(action.lines).toEqual(['a', 'b'])
        expect(action.notes).toEqual(['n1'])
        expect(action.shown).toBe(1)
      }
    })

    // task-pa (3): set/anim/ctl shown clamping against lines.length, not spec range
    it('clamps set shown=39 on a 3-line steps element to 3', () => {
      let scene = buildScene()
      const addSteps = sanitizeAction(
        { op: 'add', c: 'steps', id: 'st1', lines: ['a', 'b', 'c'] },
        scene,
      )
      expect(addSteps.ok).toBe(true)
      scene = addSteps.ok ? applyAction(scene, addSteps.action) : scene

      const result = sanitizeAction({ op: 'set', id: 'st1', k: 'shown', v: 39 }, scene)
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { v: number }).v).toBe(3)
    })

    it('clamps anim to=-5 on a steps element to 0', () => {
      let scene = buildScene()
      const addSteps = sanitizeAction(
        { op: 'add', c: 'steps', id: 'st1', lines: ['a', 'b', 'c'] },
        scene,
      )
      expect(addSteps.ok).toBe(true)
      scene = addSteps.ok ? applyAction(scene, addSteps.action) : scene

      const result = sanitizeAction({ op: 'anim', id: 'st1', k: 'shown', to: -5, dur: 1 }, scene)
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { to: number }).to).toBe(0)
    })

    it('clamps ctl max to lines.length on a steps element', () => {
      let scene = buildScene()
      const addSteps = sanitizeAction(
        { op: 'add', c: 'steps', id: 'st1', lines: ['a', 'b', 'c'] },
        scene,
      )
      expect(addSteps.ok).toBe(true)
      scene = addSteps.ok ? applyAction(scene, addSteps.action) : scene

      const result = sanitizeAction(
        { op: 'ctl', id: 'st1', k: 'shown', kind: 'slider', min: 0, max: 39 },
        scene,
      )
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { max: number }).max).toBe(3)
    })
  })

  // task-pa (2): on-axes coordinate clamping — user feedback (d), drawing
  // out of the board. Global +-1000 clamps still apply first; this narrows
  // further into the parent axes' own viewport.
  describe('on-axes coordinate clamping', () => {
    it('clamps a point add whose x is beyond the parent axes range', () => {
      const scene = buildScene() // ax1: xmin -10..10, ymin -10..10
      const result = sanitizeAction({ op: 'add', c: 'point', id: 'pt9', on: 'ax1', x: 999, y: 0 }, scene)
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { x: number }).x).toBe(10)
    })

    it('clamps a point add against a tighter axes range than the global +-1000 clamp', () => {
      let scene = buildScene()
      const addAxes = sanitizeAction(
        { op: 'add', c: 'axes', id: 'ax2', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
        scene,
      )
      expect(addAxes.ok).toBe(true)
      scene = addAxes.ok ? applyAction(scene, addAxes.action) : scene

      const result = sanitizeAction({ op: 'add', c: 'point', id: 'pt9', on: 'ax2', x: 999, y: 0 }, scene)
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { x: number }).x).toBe(5)
    })

    it('clamps set.v to the parent axes range using the target element\'s recorded `on`', () => {
      let scene = buildScene()
      const addAxes = sanitizeAction(
        { op: 'add', c: 'axes', id: 'ax2', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
        scene,
      )
      scene = addAxes.ok ? applyAction(scene, addAxes.action) : scene
      const addPt = sanitizeAction({ op: 'add', c: 'point', id: 'pt9', on: 'ax2', x: 0, y: 0 }, scene)
      scene = addPt.ok ? applyAction(scene, addPt.action) : scene

      const result = sanitizeAction({ op: 'set', id: 'pt9', k: 'y', v: -999 }, scene)
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { v: number }).v).toBe(-5)
    })

    it('clamps anim.to to the parent axes range', () => {
      let scene = buildScene()
      const addAxes = sanitizeAction(
        { op: 'add', c: 'axes', id: 'ax2', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
        scene,
      )
      scene = addAxes.ok ? applyAction(scene, addAxes.action) : scene
      const addPt = sanitizeAction({ op: 'add', c: 'point', id: 'pt9', on: 'ax2', x: 0, y: 0 }, scene)
      scene = addPt.ok ? applyAction(scene, addPt.action) : scene

      const result = sanitizeAction({ op: 'anim', id: 'pt9', k: 'x', to: 500, dur: 1 }, scene)
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { to: number }).to).toBe(5)
    })

    it('leaves standalone (non-axes) components unaffected: projectile params are never axis-clamped', () => {
      const scene = buildScene() // p1: projectile v0=20 deg=45 (no `on`)
      const result = sanitizeAction({ op: 'set', id: 'p1', k: 'deg', v: 80 }, scene)
      expect(result.ok).toBe(true)
      if (result.ok) expect((result.action as { v: number }).v).toBe(80)
    })

    it('leaves a free label (no `on`) unaffected even though x/y are present', () => {
      const scene = buildScene()
      const result = sanitizeAction({ op: 'add', c: 'label', id: 'lb1', tex: 'x=1', x: 999, y: 999 }, scene)
      expect(result.ok).toBe(true)
      if (result.ok) {
        const action = result.action as { x: number; y: number }
        expect(action.x).toBe(999)
        expect(action.y).toBe(999)
      }
    })
  })

  // task-pd: JEE physics pack clamps — orbit/spring/wave/ray are all
  // standalone (no `on`), so only the generic spec.clamps loop applies.
  describe('JEE physics pack clamps', () => {
    it('clamps orbit a/e/t to their spec ranges', () => {
      const scene = buildScene()
      const result = sanitizeAction(
        { op: 'add', c: 'orbit', id: 'orb1', a: 9999, e: 5, t: -1 },
        scene,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        const action = result.action as { a: number; e: number; t: number }
        expect(action.a).toBe(100)
        expect(action.e).toBe(0.9)
        expect(action.t).toBe(0)
      }
    })

    it('clamps spring amp/k/mass/t to their spec ranges', () => {
      const scene = buildScene()
      const result = sanitizeAction(
        { op: 'add', c: 'spring', id: 'sp1', amp: 9999, k: -5, mass: 9999, t: -5 },
        scene,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        const action = result.action as { amp: number; k: number; mass: number; t: number }
        expect(action.amp).toBe(10)
        expect(action.k).toBe(1)
        expect(action.mass).toBe(100)
        expect(action.t).toBe(0)
      }
    })

    it('clamps wave amp/wavelength/freq/t to their spec ranges', () => {
      const scene = buildScene()
      const result = sanitizeAction(
        { op: 'add', c: 'wave', id: 'w1', amp: 0.01, wavelength: 9999, freq: 9999, t: 9999 },
        scene,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        const action = result.action as { amp: number; wavelength: number; freq: number; t: number }
        expect(action.amp).toBe(0.1)
        expect(action.wavelength).toBe(50)
        expect(action.freq).toBe(20)
        expect(action.t).toBe(120)
      }
    })

    it('clamps ray objectDist/focalLength to their spec ranges', () => {
      const scene = buildScene()
      const result = sanitizeAction(
        { op: 'add', c: 'ray', id: 'ry1', kind: 'convex-lens', objectDist: 9999, focalLength: 9999 },
        scene,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        const action = result.action as { objectDist: number; focalLength: number }
        expect(action.objectDist).toBe(100)
        expect(action.focalLength).toBe(50)
      }
    })

    it('leaves in-range JEE physics pack values unchanged', () => {
      const scene = buildScene()
      const result = sanitizeAction(
        { op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4, t: 0.5 },
        scene,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        const action = result.action as { a: number; e: number; t: number }
        expect(action.a).toBe(40)
        expect(action.e).toBe(0.4)
        expect(action.t).toBe(0.5)
      }
    })
  })

  // task-pd: wish op — truncates component/why, always succeeds (no
  // reference/key/expr checks apply — it isn't tied to any scene element).
  describe('wish op sanitization', () => {
    it('passes a short wish action through unchanged', () => {
      const scene = buildScene()
      const result = sanitizeAction({ op: 'wish', component: 'field-lines', why: 'need vector fields' }, scene)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.action).toEqual({ op: 'wish', component: 'field-lines', why: 'need vector fields' })
      }
    })

    it('truncates component to 60 chars and why to 300 chars', () => {
      const scene = buildScene()
      const longComponent = 'c'.repeat(100)
      const longWhy = 'w'.repeat(400)
      const result = sanitizeAction({ op: 'wish', component: longComponent, why: longWhy }, scene)
      expect(result.ok).toBe(true)
      if (result.ok) {
        const action = result.action as { component: string; why: string }
        expect(action.component).toHaveLength(60)
        expect(action.why).toHaveLength(300)
      }
    })

    it('never fails regardless of scene state (empty scene, no reference checks)', () => {
      const result = sanitizeAction({ op: 'wish', component: 'x', why: 'y' }, emptyScene)
      expect(result.ok).toBe(true)
    })
  })

  // (7) ask arity
  it('fails an mcq ask with fewer than 2 options', () => {
    const scene = buildScene()
    const result = sanitizeAction(
      { op: 'ask', id: 'q1', kind: 'mcq', text: 'Pick one', options: ['A'] },
      scene,
    )
    expect(result.ok).toBe(false)
  })

  it('accepts an mcq ask with 2+ options', () => {
    const scene = buildScene()
    const result = sanitizeAction(
      { op: 'ask', id: 'q1', kind: 'mcq', text: 'Pick one', options: ['A', 'B'] },
      scene,
    )
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cross-check flagged in Task 2 review: COMPONENT_SPECS.clamps is a hand-written
// table keyed by param-name strings. If a clamps key doesn't match an actual
// param name on that component's add-variant, sanitizeAction's clamp step
// silently no-ops. This guards against that drift.
// ---------------------------------------------------------------------------
describe('COMPONENT_SPECS clamp-key integrity', () => {
  it('spec.example is itself a valid add action for every component', () => {
    for (const c of COMPONENT_TYPES) {
      const parsed = ActionSchema.safeParse(JSON.parse(COMPONENT_SPECS[c].example))
      expect(parsed.success, `spec.example for "${c}" must parse as a valid add action`).toBe(true)
    }
  })

  it('every clamps key is a real param name on that component add-variant schema (top-level -- including optional fields not present in the minimal example -- or nested in an object-array field like fbd.forces)', () => {
    for (const c of COMPONENT_TYPES) {
      const spec = COMPONENT_SPECS[c]

      // Use the zod schema's full field shape (not just the minimal example's
      // literal keys) so optional params omitted from the example -- e.g.
      // vector's x1/y1 -- don't produce a false-positive mismatch.
      const variant = addVariants.options.find((o) => o.shape.c.value === c)
      expect(variant, `no add-variant schema found for component "${c}"`).toBeDefined()
      if (!variant) continue
      const keys = new Set(Object.keys(variant.shape))

      // Nested object-array params (e.g. fbd.forces: {name,deg,mag}[]) contribute
      // their own keys too, since clamps for those apply per-entry, not top-level.
      const example = JSON.parse(spec.example) as Record<string, unknown>
      for (const value of Object.values(example)) {
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
          for (const k of Object.keys(value[0] as Record<string, unknown>)) keys.add(k)
        }
      }

      for (const clampKey of Object.keys(spec.clamps)) {
        expect(
          keys.has(clampKey),
          `${c}.clamps has key "${clampKey}" not found among its add-variant schema fields (${[...keys].join(', ')})`,
        ).toBe(true)
      }
    }
  })
})
