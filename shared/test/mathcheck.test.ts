import { describe, it, expect } from 'vitest'
import type { Action } from '../src/protocol/actions'
import { MATH_FNS, evalTemplate, formatNum, verifyActions, deriv } from '../src/mathcheck'

describe('MATH_FNS', () => {
  it('exposes fact functions as plain number functions', () => {
    expect(MATH_FNS.root1!(1, 0, -4)).toBeCloseTo(-2)
    expect(MATH_FNS.root2!(1, 0, -4)).toBeCloseTo(2)
    expect(MATH_FNS.disc!(1, 0, -4)).toBe(16)
    expect(MATH_FNS.vertexX!(1, -4)).toBeCloseTo(2)
  })

  it('root1/root2 return NaN for no real roots or a=0', () => {
    expect(MATH_FNS.root1!(1, 0, 4)).toBeNaN() // disc < 0
    expect(MATH_FNS.root2!(0, 2, -4)).toBeNaN() // a = 0
  })

  it('computes projectile motion facts', () => {
    expect(MATH_FNS.projRange!(20, 45)).toBeCloseTo(40.82, 2)
    expect(MATH_FNS.projApex!(20, 45)).toBeCloseTo(10.2, 1)
    expect(MATH_FNS.projTime!(20, 45)).toBeCloseTo(2.885, 2)
  })

  it('computes pendulum period', () => {
    expect(MATH_FNS.pendPeriod!(2)).toBeCloseTo(2.838, 2)
  })

  // task-pd: JEE physics pack (orbit/spring/wave/ray) — hand-computed values.
  it('computes spring period: 2*pi*sqrt(m/k)', () => {
    expect(MATH_FNS.springPeriod!(1, 100)).toBeCloseTo(0.6283, 4) // 2*pi*sqrt(1/100)
    expect(MATH_FNS.springPeriod!(4, 100)).toBeCloseTo(1.2566, 4) // 2*pi*sqrt(4/100) = 2*pi*0.2
  })

  it('computes wave speed: f * wavelength', () => {
    expect(MATH_FNS.waveSpeed!(2, 3)).toBe(6)
    expect(MATH_FNS.waveSpeed!(0.5, 10)).toBe(5)
  })

  it('computes thin-lens/mirror image distance: 1/(1/f - 1/u)', () => {
    expect(MATH_FNS.lensImage!(10, 20)).toBeCloseTo(20, 5) // 1/(0.1-0.05) = 20
    expect(MATH_FNS.lensImage!(5, 15)).toBeCloseTo(7.5, 5) // 1/(0.2 - 1/15) = 7.5
  })

  it('lensImage returns NaN when u === f (object at the focal point)', () => {
    expect(MATH_FNS.lensImage!(10, 10)).toBeNaN()
  })

  it("computes Kepler's third law: t2 = t1 * (a2/a1)^1.5", () => {
    expect(MATH_FNS.kepler3!(1, 1, 4)).toBeCloseTo(8, 5) // 1*(4/1)^1.5 = 8
    expect(MATH_FNS.kepler3!(1, 365, 9)).toBeCloseTo(9855, 1) // 365*(9)^1.5 = 365*27
  })
})

describe('deriv', () => {
  it('evaluates the derivative of an expression at a point', () => {
    expect(deriv('x^2', 3)).toBe(6)
  })
})

describe('formatNum', () => {
  it('rounds to 3 decimals and strips trailing zeros', () => {
    expect(formatNum(40.816326)).toBe('40.816')
    expect(formatNum(2)).toBe('2')
    expect(formatNum(-2)).toBe('-2')
    expect(formatNum(2.5)).toBe('2.5')
  })

  it('maps NaN to ?', () => {
    expect(formatNum(NaN)).toBe('?')
  })
})

describe('evalTemplate', () => {
  it('replaces {{expr}} with computed, formatted numbers', () => {
    const { text, errors } = evalTemplate('roots are {{root1(1,0,-4)}} and {{root2(1,0,-4)}}')
    expect(text).toBe('roots are -2 and 2')
    expect(errors).toHaveLength(0)
  })

  it('formats projectile range to 2dp', () => {
    const { text } = evalTemplate('range is {{projRange(20,45)}}')
    expect(text).toBe('range is 40.816')
  })

  it('rejects unsafe expressions like import(...) and reports an error', () => {
    const { text, errors } = evalTemplate('bad: {{import("x")}}')
    expect(text).toBe('bad: ?')
    expect(errors).toHaveLength(1)
  })

  it('rejects other unsafe constructs: assignment, member access, blocks', () => {
    expect(evalTemplate('{{x=5}}').errors).toHaveLength(1)
    expect(evalTemplate('{{[1,2,3][0]}}').errors).toHaveLength(1)
    expect(evalTemplate('{{1;2}}').errors).toHaveLength(1)
  })

  it('rejects a broken expr (parse error) without throwing', () => {
    const { text, errors } = evalTemplate('oops {{root1(1,0,}}')
    expect(text).toBe('oops ?')
    expect(errors).toHaveLength(1)
  })

  it('leaves NaN math results (e.g. no real root) as ? without an error', () => {
    const { text, errors } = evalTemplate('{{root1(1,0,4)}}')
    expect(text).toBe('?')
    expect(errors).toHaveLength(0)
  })

  it('passes through text with no templates unchanged', () => {
    expect(evalTemplate('no math here').text).toBe('no math here')
  })

  it('makes deriv(expr, at) reachable from {{...}} templates', () => {
    const { text, errors } = evalTemplate('slope: {{deriv("x^2", 3)}}')
    expect(text).toBe('slope: 6')
    expect(errors).toHaveLength(0)
  })

  it('rejects an unsafe expression inside a deriv(...) string argument', () => {
    const { text, errors } = evalTemplate('{{deriv("import(\'fs\')", 1)}}')
    expect(text).toBe('?')
    expect(errors).toHaveLength(1)
  })

  it('rejects a bare string constant outside of deriv(...)', () => {
    const { text, errors } = evalTemplate('{{"hello"}}')
    expect(text).toBe('?')
    expect(errors).toHaveLength(1)
  })

  it('rejects an unknown symbol inside a deriv(...) string argument', () => {
    const { text, errors } = evalTemplate('{{deriv("x + y", 1)}}')
    expect(text).toBe('?')
    expect(errors).toHaveLength(1)
  })
})

describe('verifyActions', () => {
  it('rewrites say.text, label.tex, and ask.text/options and collects errors', () => {
    const actions: Action[] = [
      { op: 'say', text: 'The root is {{root1(1,0,-4)}}.' },
      { op: 'add', c: 'label', id: 'lb1', tex: 'x={{root2(1,0,-4)}}' },
      { op: 'add', c: 'label', id: 'lb2', tex: 'bad {{import("x")}}' },
      {
        op: 'ask',
        id: 'q1',
        kind: 'numeric',
        text: 'What is {{root1(1,0,-4)}}?',
        options: ['{{root1(1,0,-4)}}', '{{root2(1,0,-4)}}'],
      },
      { op: 'step', title: 'unaffected' },
    ]

    const { actions: out, errors } = verifyActions(actions)

    expect(out[0]).toMatchObject({ op: 'say', text: 'The root is -2.' })
    expect(out[1]).toMatchObject({ tex: 'x=2' })
    expect(out[2]).toMatchObject({ tex: 'bad ?' })
    expect(out[3]).toMatchObject({ text: 'What is -2?', options: ['-2', '2'] })
    expect(out[4]).toMatchObject({ op: 'step', title: 'unaffected' })
    expect(errors).toHaveLength(1)
  })

  it('rewrites ask.answer so a templated answer matches its rewritten options (finding #2)', () => {
    const actions: Action[] = [
      {
        op: 'ask',
        id: 'q1',
        kind: 'mcq',
        text: 'What is the smaller root of x^2 - 3x - 4?',
        options: ['{{root1(1,-3,-4)}}', '{{root2(1,-3,-4)}}'],
        answer: '{{root1(1,-3,-4)}}',
      },
    ]

    const { actions: out, errors } = verifyActions(actions)

    expect(out[0]).toMatchObject({ options: ['-1', '4'], answer: '-1' })
    // The rewritten answer is byte-identical to one of the rewritten options,
    // so downstream grading can actually match a correct pick.
    const ask = out[0] as Extract<Action, { op: 'ask' }>
    expect(ask.options).toContain(ask.answer)
    expect(errors).toHaveLength(0)
  })

  it('template-evaluates every steps.lines and steps.notes entry (task-pa: derivations get the same {{...}} discipline)', () => {
    const actions: Action[] = [
      {
        op: 'add', c: 'steps', id: 'st1',
        lines: ['2x + 3 = 11', '2x = {{11-3}}', 'x = {{root2(2,0,-8)}}'],
        notes: ['start', 'subtract 3: {{11-3}}'],
      },
    ]

    const { actions: out, errors } = verifyActions(actions)

    const steps = out[0] as Extract<Action, { op: 'add'; c: 'steps' }>
    expect(steps.lines).toEqual(['2x + 3 = 11', '2x = 8', 'x = 2'])
    expect(steps.notes).toEqual(['start', 'subtract 3: 8'])
    expect(errors).toHaveLength(0)
  })

  it('collects an error for a broken template inside a steps line without throwing', () => {
    const actions: Action[] = [
      { op: 'add', c: 'steps', id: 'st1', lines: ['x = {{import("fs")}}'] },
    ]

    const { actions: out, errors } = verifyActions(actions)

    const steps = out[0] as Extract<Action, { op: 'add'; c: 'steps' }>
    expect(steps.lines).toEqual(['x = ?'])
    expect(errors).toHaveLength(1)
  })

  it('leaves steps.notes undefined as undefined when omitted', () => {
    const actions: Action[] = [{ op: 'add', c: 'steps', id: 'st1', lines: ['x = {{2+2}}'] }]
    const { actions: out } = verifyActions(actions)
    const steps = out[0] as Extract<Action, { op: 'add'; c: 'steps' }>
    expect(steps.lines).toEqual(['x = 4'])
    expect(steps.notes).toBeUndefined()
  })

  it('template-evaluates a set targeting a tex/label key, but not other set keys (finding #9)', () => {
    const actions: Action[] = [
      { op: 'set', id: 'lb1', k: 'tex', v: 'x = {{root2(1,0,-4)}}' },
      { op: 'set', id: 'lb2', k: 'label', v: 'root: {{root1(1,0,-4)}}' },
      // A non-text key must be left untouched even if it looks templated.
      { op: 'set', id: 'p1', k: 'color', v: '{{root1(1,0,-4)}}' },
    ]

    const { actions: out, errors } = verifyActions(actions)

    expect(out[0]).toMatchObject({ op: 'set', k: 'tex', v: 'x = 2' })
    expect(out[1]).toMatchObject({ op: 'set', k: 'label', v: 'root: -2' })
    expect(out[2]).toMatchObject({ op: 'set', k: 'color', v: '{{root1(1,0,-4)}}' })
    expect(errors).toHaveLength(0)
  })
})
