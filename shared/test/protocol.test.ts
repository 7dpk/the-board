import { describe, it, expect } from 'vitest'
import { ActionSchema, RenderPlanSchema, renderPlanJsonSchema, COMPONENT_SPECS } from '../src/index'

describe('action schemas', () => {
  it('accepts a canonical projectile beat', () => {
    const plan = { actions: [
      { op: 'step', title: 'Launch' },
      { op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45 },
      { op: 'say', text: 'Watch the ball fly.', sync: 'p1' },
      { op: 'anim', id: 'p1', k: 't', to: 1, dur: 3 },
      { op: 'ctl', id: 'p1', k: 'deg', kind: 'slider', min: 15, max: 75 },
    ]}
    expect(RenderPlanSchema.safeParse(plan).success).toBe(true)
  })
  it('rejects unknown op / unknown component / extra keys', () => {
    expect(ActionSchema.safeParse({ op: 'zap', id: 'x' }).success).toBe(false)
    expect(ActionSchema.safeParse({ op: 'add', c: 'widget', id: 'x' }).success).toBe(false)
    expect(ActionSchema.safeParse({ op: 'del', id: 'x', hax: 1 }).success).toBe(false)
  })
  it('emits strict JSON schema (every object node: additionalProperties=false + required)', () => {
    const walk = (node: any): void => {
      if (node && typeof node === 'object') {
        if (node.type === 'object') {
          expect(node.additionalProperties).toBe(false)
          expect(Array.isArray(node.required)).toBe(true)
        }
        Object.values(node).forEach(walk)
      }
    }
    walk(renderPlanJsonSchema)
    const s = JSON.stringify(renderPlanJsonSchema)
    expect(s).not.toMatch(/"minimum"|"maximum"|"minLength"|"maxLength"|"minItems"|"maxItems"/)
  })
  it('every component has spec doc/example/clamps', () => {
    for (const spec of Object.values(COMPONENT_SPECS)) {
      expect(spec.doc.length).toBeGreaterThan(10)
      expect(() => JSON.parse(spec.example)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// steps component (task-pa): worked-derivation card. Add-variant strictness
// and COMPONENT_SPECS wiring only — sanitize/reducer/mathcheck behavior is
// covered in sanitize.test.ts / scene.test.ts / mathcheck.test.ts.
// ---------------------------------------------------------------------------
describe('steps component', () => {
  it('accepts a minimal steps add (lines only)', () => {
    const action = { op: 'add', c: 'steps', id: 'st1', lines: ['2x = 8', 'x = 4'] }
    expect(ActionSchema.safeParse(action).success).toBe(true)
  })

  it('accepts a full steps add with title/notes/shown', () => {
    const action = {
      op: 'add', c: 'steps', id: 'st1', title: 'Solve for x',
      lines: ['2x + 3 = 11', '2x = 8', 'x = 4'],
      notes: ['subtract 3 from both sides', 'divide both sides by 2'],
      shown: 1,
    }
    expect(ActionSchema.safeParse(action).success).toBe(true)
  })

  it('rejects a steps add with an extra/unknown key (strict schema)', () => {
    const action = { op: 'add', c: 'steps', id: 'st1', lines: ['x = 4'], hax: true }
    expect(ActionSchema.safeParse(action).success).toBe(false)
  })

  it('rejects a steps add missing the required lines field', () => {
    const action = { op: 'add', c: 'steps', id: 'st1', title: 'oops' }
    expect(ActionSchema.safeParse(action).success).toBe(false)
  })

  it('COMPONENT_SPECS.steps declares shown as clamped, animatable, and controllable', () => {
    const spec = COMPONENT_SPECS.steps
    expect(spec.clamps.shown).toEqual({ min: 0, max: 40 })
    expect(spec.animatable).toContain('shown')
    expect(spec.controllable).toContain('shown')
  })
})

// ---------------------------------------------------------------------------
// JEE physics pack (task-pd): orbit/spring/wave/ray. Add-variant strictness
// and COMPONENT_SPECS wiring only — sanitize/reducer/mathcheck behavior is
// covered in sanitize.test.ts / scene.test.ts / mathcheck.test.ts.
// ---------------------------------------------------------------------------
describe('JEE physics pack: orbit/spring/wave/ray', () => {
  it('accepts a minimal orbit add (a, e only)', () => {
    const action = { op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4 }
    expect(ActionSchema.safeParse(action).success).toBe(true)
  })

  it('accepts a full orbit add', () => {
    const action = {
      op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4, t: 0.25,
      showVectors: true, centerLabel: 'Sun', bodyLabel: 'Earth',
    }
    expect(ActionSchema.safeParse(action).success).toBe(true)
  })

  it('rejects an orbit add missing required a/e', () => {
    expect(ActionSchema.safeParse({ op: 'add', c: 'orbit', id: 'orb1', a: 40 }).success).toBe(false)
    expect(ActionSchema.safeParse({ op: 'add', c: 'orbit', id: 'orb1', e: 0.4 }).success).toBe(false)
  })

  it('rejects an orbit add with an extra key (strict schema)', () => {
    const action = { op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4, hax: true }
    expect(ActionSchema.safeParse(action).success).toBe(false)
  })

  // task-s2 (feedback: "kepler laws didn't shade the area")
  it('accepts an orbit add with showSweep (plain optional boolean, no new clamp)', () => {
    expect(ActionSchema.safeParse({ op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4, showSweep: true }).success).toBe(true)
    expect(ActionSchema.safeParse({ op: 'add', c: 'orbit', id: 'orb1', a: 40, e: 0.4, showSweep: false }).success).toBe(true)
    expect(COMPONENT_SPECS.orbit.clamps.showSweep).toBeUndefined()
  })

  it("mentions Kepler's equal-areas law in orbit's spec doc", () => {
    expect(COMPONENT_SPECS.orbit.doc).toMatch(/equal areas/i)
  })

  it('accepts a minimal spring add (amp only)', () => {
    const action = { op: 'add', c: 'spring', id: 'sp1', amp: 2 }
    expect(ActionSchema.safeParse(action).success).toBe(true)
  })

  it('accepts a full spring add', () => {
    const action = { op: 'add', c: 'spring', id: 'sp1', amp: 2, k: 50, mass: 2, t: 3, showForces: true }
    expect(ActionSchema.safeParse(action).success).toBe(true)
  })

  it('rejects a spring add missing required amp', () => {
    expect(ActionSchema.safeParse({ op: 'add', c: 'spring', id: 'sp1', k: 50 }).success).toBe(false)
  })

  it('accepts a minimal wave add (amp, wavelength, freq)', () => {
    const action = { op: 'add', c: 'wave', id: 'w1', amp: 2, wavelength: 4, freq: 1 }
    expect(ActionSchema.safeParse(action).success).toBe(true)
  })

  it('accepts a full wave add', () => {
    const action = { op: 'add', c: 'wave', id: 'w1', amp: 2, wavelength: 4, freq: 1, t: 5, standing: true }
    expect(ActionSchema.safeParse(action).success).toBe(true)
  })

  it('rejects a wave add missing required fields', () => {
    expect(ActionSchema.safeParse({ op: 'add', c: 'wave', id: 'w1', amp: 2, wavelength: 4 }).success).toBe(false)
  })

  it('accepts a minimal ray add', () => {
    const action = { op: 'add', c: 'ray', id: 'ry1', kind: 'convex-lens', objectDist: 20, focalLength: 10 }
    expect(ActionSchema.safeParse(action).success).toBe(true)
  })

  it('accepts every ray kind enum value', () => {
    for (const kind of ['convex-lens', 'concave-lens', 'concave-mirror', 'convex-mirror']) {
      const action = { op: 'add', c: 'ray', id: 'ry1', kind, objectDist: 20, focalLength: 10 }
      expect(ActionSchema.safeParse(action).success).toBe(true)
    }
  })

  it('rejects a ray add with an invalid kind', () => {
    const action = { op: 'add', c: 'ray', id: 'ry1', kind: 'convex-thing', objectDist: 20, focalLength: 10 }
    expect(ActionSchema.safeParse(action).success).toBe(false)
  })

  it('COMPONENT_SPECS declares clamps/animatable/controllable for all four', () => {
    expect(COMPONENT_SPECS.orbit.clamps).toEqual({ a: { min: 1, max: 100 }, e: { min: 0, max: 0.9 }, t: { min: 0, max: 1 } })
    expect(COMPONENT_SPECS.spring.clamps.amp).toEqual({ min: 0.1, max: 10 })
    expect(COMPONENT_SPECS.wave.clamps.freq).toEqual({ min: 0.05, max: 20 })
    expect(COMPONENT_SPECS.ray.clamps).toEqual({ objectDist: { min: 1, max: 100 }, focalLength: { min: 1, max: 50 } })
  })
})

describe('axes grid toggle', () => {
  it('accepts an axes add with grid:false', () => {
    const action = { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10, grid: false }
    expect(ActionSchema.safeParse(action).success).toBe(true)
  })

  it("mentions grid in axes' spec doc", () => {
    expect(COMPONENT_SPECS.axes.doc).toMatch(/grid/i)
  })
})

describe('wish op', () => {
  it('accepts a wish action', () => {
    const action = { op: 'wish', component: 'field-lines', why: 'electrostatics needs vector field viz' }
    expect(ActionSchema.safeParse(action).success).toBe(true)
  })

  it('rejects a wish action missing component/why or with an extra key (strict schema)', () => {
    expect(ActionSchema.safeParse({ op: 'wish', why: 'x' }).success).toBe(false)
    expect(ActionSchema.safeParse({ op: 'wish', component: 'x' }).success).toBe(false)
    expect(ActionSchema.safeParse({ op: 'wish', component: 'x', why: 'y', hax: 1 }).success).toBe(false)
  })
})
