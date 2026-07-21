import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../src/prompt'
import { FEWSHOTS } from '../src/fewshots'
import { COMPONENT_TYPES } from '../src/protocol/components'
import { MATH_FNS } from '../src/mathcheck'
import { RenderPlanSchema } from '../src/protocol/actions'
import { sanitizeAction } from '../src/sanitize'
import { applyAction, emptyScene } from '../src/scene'

describe('buildSystemPrompt', () => {
  it('is byte-identical across calls (prompt-cache safety)', () => {
    expect(buildSystemPrompt()).toBe(buildSystemPrompt())
  })

  it('mentions every component name', () => {
    const prompt = buildSystemPrompt()
    for (const c of COMPONENT_TYPES) {
      expect(prompt).toContain(c)
    }
  })

  it('mentions every MATH_FNS name', () => {
    const prompt = buildSystemPrompt()
    for (const name of Object.keys(MATH_FNS)) {
      expect(prompt).toContain(name)
    }
  })

  it('mentions deriv as a template-only helper', () => {
    expect(buildSystemPrompt()).toContain('deriv(')
  })

  it('contains no ISO dates/timestamps (would break prompt-cache determinism)', () => {
    expect(buildSystemPrompt()).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('mentions the render_plan tool call contract', () => {
    expect(buildSystemPrompt()).toContain('render_plan')
  })

  it('includes both few-shot names', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('quadratic-intro')
    expect(prompt).toContain('projectile-intro')
  })

  it('stays compact (well under ~2500 words)', () => {
    const words = buildSystemPrompt().trim().split(/\s+/).length
    expect(words).toBeLessThan(2500)
  })

  // task-pa: the board-polish rules (steps/systematic-solving, anti-clutter
  // new-axes, board-first, out-of-board sizing) were folded in tersely to a
  // specific budget, tighter than the general 2500 regression ceiling above.
  // task-pd bumped the ceiling from ~1300 to ~1500: 4 new component-reference
  // entries (orbit/spring/wave/ray, each with a doc/example/animatable/
  // controllable line) plus the wish-op rule are genuine new teachable
  // surface, trimmed as tersely as the existing rules already were.
  it('stays under the task-pd ~1500 word budget', () => {
    const words = buildSystemPrompt().trim().split(/\s+/).length
    expect(words).toBeLessThan(1500)
  })

  it('teaches systematic equation-solving via the steps component', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toMatch(/steps.*component/i)
    expect(prompt).toContain('shown:1')
  })

  it('teaches adding a new axes below instead of erasing the previous concept', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toMatch(/new `axes` below/i)
  })

  it('teaches board-first explanation over chat prose', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toMatch(/Explain ON the board/)
  })

  it('teaches sizing axes to fit content before adding children (out-of-board fix)', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toMatch(/fit inside their axes/i)
  })

  // task-pd: JEE physics pack + wish op (self-improvement loop)
  it('lists orbit/spring/wave/ray as standalone (never `on`) alongside the other physics components', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toMatch(/`orbit`, `spring`, `wave`, `ray`/)
  })

  it('teaches the wish op: emit one wish action when no component fits, never apologize in say', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('`wish` action')
    expect(prompt).toMatch(/Never apologize about missing tools in `say`/)
  })

  it('mentions grid:false for clean diagrams like orbits/ray optics', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toMatch(/grid:false/)
  })

  // F-1 (screenshot: "ok"/"what's next" repeated the same animation instead
  // of advancing): the model must never treat answering/reacting as a cue to
  // re-add or re-animate elements that are already on the board.
  it('teaches the no-re-render QA rule: never re-add/re-animate existing elements when answering or reacting', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toMatch(/NEVER re-add or re-animate elements already on the board/)
    expect(prompt).toMatch(/focus`\/`say`/)
  })
})

describe('FEWSHOTS', () => {
  it('has exactly 2 entries named quadratic-intro and projectile-intro', () => {
    expect(FEWSHOTS.map((f) => f.name)).toEqual(['quadratic-intro', 'projectile-intro'])
  })

  it('every fewshot action list parses via RenderPlanSchema', () => {
    for (const fs of FEWSHOTS) {
      const result = RenderPlanSchema.safeParse({ actions: fs.actions })
      expect(result.success).toBe(true)
    }
  })

  it('every fewshot action sanitizes cleanly against the progressively-reduced scene', () => {
    for (const fs of FEWSHOTS) {
      let scene = emptyScene
      for (const action of fs.actions) {
        const result = sanitizeAction(action, scene)
        expect(result.ok).toBe(true)
        if (result.ok) scene = applyAction(scene, result.action)
      }
    }
  })

  it('quadratic-intro includes a say with {{vertexX(1,-2)}}', () => {
    const fs = FEWSHOTS.find((f) => f.name === 'quadratic-intro')
    expect(fs).toBeDefined()
    const hasIt = fs!.actions.some(
      (a) => a.op === 'say' && a.text.includes('{{vertexX(1,-2)}}'),
    )
    expect(hasIt).toBe(true)
  })

  it('projectile-intro includes a say with {{projRange(20,45)}}', () => {
    const fs = FEWSHOTS.find((f) => f.name === 'projectile-intro')
    expect(fs).toBeDefined()
    const hasIt = fs!.actions.some(
      (a) => a.op === 'say' && a.text.includes('{{projRange(20,45)}}'),
    )
    expect(hasIt).toBe(true)
  })
})
