import { describe, it, expect } from 'vitest'
import type { Action } from '@board/shared'
import {
  EVAL_CASES,
  type CheckCtx,
  type EvalCase,
  noRawLongDigitsOutsideTemplates,
  verifiedMathDiscipline,
} from '../src/eval/cases'
import { classifyOnErrorReason, computeMetrics, type CaseCounters } from '../src/eval/run'

// ---------------------------------------------------------------------------
// TDD for the eval case predicates (task-18): each case gets a hand-written
// GOOD action list (satisfies every check for that case) and a hand-written
// BAD action list (a plausible-but-wrong turn — wrong topic, missing
// narration, or a hardcoded number — that fails every check for that case).
// Checks are pure `(Action[], CheckCtx) -> boolean` predicates (see
// src/eval/cases.ts), so these lists are literal, never run through
// sanitizeAction/verifyActions. The generic loop below calls every check with
// a "clean" ctx (zero verify errors) — that's correct for every case except
// roots-explanation's new check, which cares about ctx directly; that one
// gets its own dedicated describe block below with ctx-varying scenarios.
//
// Note on `roots-explanation`'s check: it now operates on POST-verify text
// (see verifiedMathDiscipline's doc comment in cases.ts) — its GOOD/BAD lists
// below deliberately show already-evaluated say text (no `{{...}}` left),
// exactly as the runner sees it after verifyActions has run.
// ---------------------------------------------------------------------------

const CLEAN_CTX: CheckCtx = { verifyErrors: 0, sanitizeDrops: 0 }

const FIXTURES: Record<string, { good: Action[]; bad: Action[] }> = {
  'quadratic-intro': {
    good: [
      { op: 'step', title: 'Meet the parabola' },
      { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
      { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2' },
      { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 2, y: 4 },
      { op: 'say', text: 'This is the graph of y = x^2, a parabola.' },
      { op: 'ctl', id: 'pt1', k: 'x', kind: 'drag' },
      { op: 'say', text: 'Drag the point to see how y changes as x changes.' },
    ],
    bad: [{ op: 'say', text: 'Hello!' }],
  },

  'roots-explanation': {
    good: [
      { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
      { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2 - 3*x - 4' },
      { op: 'say', text: 'The roots are -1 and 4.' },
    ],
    // Fails the "mentions root(s)" check (no mention of "root"). It no longer
    // fails the verified-math-discipline check — that one is ctx-only now and
    // is exercised in its own describe block below (the generic loop skips its
    // bad-list assertion). The "?" here is just ordinary punctuation.
    bad: [{ op: 'say', text: 'The solutions come out to ? and ?, trust me.' }],
  },

  'projectile-45': {
    good: [
      { op: 'step', title: 'Projectile motion' },
      { op: 'add', c: 'projectile', id: 'pr1', v0: 20, deg: 45 },
      { op: 'say', text: 'Launched at 45°, the projectile follows this arc.' },
      { op: 'anim', id: 'pr1', k: 't', to: 1, dur: 2 },
      { op: 'say', text: 'Its range is {{projRange(20,45)}} meters.' },
    ],
    bad: [
      { op: 'add', c: 'projectile', id: 'pr1', v0: 20, deg: 10 },
      { op: 'say', text: 'Watch it fly.' },
    ],
  },

  'tangent-slope': {
    good: [
      { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -10, ymax: 10 },
      { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^3' },
      { op: 'add', c: 'tangent', id: 'tg1', on: 'ax1', expr: 'x^3', at: 2 },
      { op: 'say', text: 'The slope of the tangent at x=2 is {{deriv("x^3",2)}}.' },
    ],
    bad: [
      { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^3' },
      { op: 'say', text: 'Here is the curve.' },
    ],
  },

  'area-under-curve': {
    good: [
      { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 10 },
      { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2' },
      { op: 'add', c: 'area', id: 'ar1', on: 'ax1', expr: 'x^2', from: 0, to: 2 },
      { op: 'say', text: 'The shaded area under the curve runs from x=0 to x=2.' },
    ],
    bad: [
      { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2' },
      { op: 'say', text: 'Here is the parabola.' },
    ],
  },

  'pendulum-period': {
    good: [
      { op: 'add', c: 'pendulum', id: 'pd1', length: 2, deg0: 20 },
      { op: 'ctl', id: 'pd1', k: 'length', kind: 'slider' },
      { op: 'say', text: 'The period is {{pendPeriod(2)}} seconds.' },
    ],
    bad: [
      { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
      { op: 'say', text: 'Here is a graph.' },
    ],
  },

  'incline-forces': {
    good: [
      { op: 'add', c: 'incline', id: 'in1', deg: 30, mu: 0, mass: 5, showForces: true },
      { op: 'say', text: 'The forces acting on the block are gravity, normal force, and friction.' },
    ],
    bad: [
      { op: 'add', c: 'incline', id: 'in1', deg: 30, mu: 0, mass: 5, showForces: false },
      { op: 'say', text: 'Here is a ramp.' },
    ],
  },

  'numberline-fractions': {
    good: [
      { op: 'add', c: 'numberline', id: 'nl1', min: 0, max: 1, marks: [0.25, 0.5, 0.75] },
      { op: 'say', text: 'The fraction 3/4 lands here, between 0.5 and 1.' },
    ],
    bad: [
      { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
      { op: 'say', text: 'Here is a graph.' },
    ],
  },

  'ask-mcq-format': {
    good: [
      { op: 'say', text: 'Quick check before we move on.' },
      {
        op: 'ask',
        id: 'q1',
        kind: 'mcq',
        text: 'Which factors correctly represent x^2 - 5x + 6?',
        options: ['(x-2)(x-3)', '(x+2)(x+3)', '(x-1)(x-6)'],
        answer: '(x-2)(x-3)',
      },
    ],
    bad: [{ op: 'ask', id: 'q1', kind: 'free', text: 'What are the factors?', answer: '(x-2)(x-3)' }],
  },

  'event-response': {
    good: [
      { op: 'say', text: 'Increasing the angle to 60° raises the arc higher and shortens the range a bit.' },
      { op: 'set', id: 'p1', k: 'color', v: 'blue' },
    ],
    bad: [
      { op: 'clear', keep: [] },
      { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
      { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2' },
      { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: 1 },
      { op: 'add', c: 'vector', id: 'v1', on: 'ax1', x2: 2, y2: 2 },
      { op: 'add', c: 'segment', id: 's1', on: 'ax1', x1: 0, y1: 0, x2: 3, y2: 3 },
    ],
  },
}

describe('EVAL_CASES', () => {
  it('has exactly the 10 named cases from task-18-brief.md, each with a fixture', () => {
    expect(EVAL_CASES).toHaveLength(10)
    for (const c of EVAL_CASES) {
      expect(FIXTURES[c.name], `missing fixture for case "${c.name}"`).toBeDefined()
    }
  })

  for (const evalCase of EVAL_CASES) {
    describe(evalCase.name, () => {
      const fixture = FIXTURES[evalCase.name]!

      it('message is a non-empty string', () => {
        expect(evalCase.message.length).toBeGreaterThan(0)
      })

      for (const check of evalCase.checks) {
        it(`check "${check.desc}" passes on the good list`, () => {
          expect(check.pass(fixture.good, CLEAN_CTX)).toBe(true)
        })

        // verifiedMathDiscipline now depends SOLELY on ctx.verifyErrors (it no
        // longer inspects action text at all), so it cannot fail under the
        // generic loop's clean ctx. Its bad-input behavior (verifyErrors > 0)
        // is exercised in its own describe block below instead. Comparing the
        // function reference keeps this robust to desc wording.
        if (check.pass !== verifiedMathDiscipline) {
          it(`check "${check.desc}" fails on the bad list`, () => {
            expect(check.pass(fixture.bad, CLEAN_CTX)).toBe(false)
          })
        }
      }
    })
  }

  it("event-response's message is a bracketed [event] line", () => {
    const c = EVAL_CASES.find((x) => x.name === 'event-response')!
    expect(c.message).toMatch(/^\[event\] /)
  })
})

// ---------------------------------------------------------------------------
// verifiedMathDiscipline — now depends solely on ctx.verifyErrors. The old
// "any '?' in say/label text is a broken template" half was dropped (finding
// #5): the prompt encourages prediction QUESTIONS, so a bare '?' is ordinary
// punctuation and false-failed legitimate narration.
// ---------------------------------------------------------------------------

describe('verifiedMathDiscipline (roots-explanation check 1)', () => {
  const cleanSay: Action[] = [{ op: 'say', text: 'The roots are -1 and 4.' }]

  it('passes on clean say text with zero verify errors', () => {
    expect(verifiedMathDiscipline(cleanSay, CLEAN_CTX)).toBe(true)
  })

  it('passes vacuously when there are no say/label actions at all', () => {
    const actions: Action[] = [{ op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 }]
    expect(verifiedMathDiscipline(actions, CLEAN_CTX)).toBe(true)
  })

  it('passes on a legitimate "?" prediction question when verifyErrors is 0 (the false-fail this fix removes)', () => {
    const actions: Action[] = [{ op: 'say', text: 'What do you predict the root is? Take a guess.' }]
    expect(verifiedMathDiscipline(actions, CLEAN_CTX)).toBe(true)
  })

  it('passes even with a label containing "?" as long as verifyErrors is 0', () => {
    const actions: Action[] = [{ op: 'add', c: 'label', id: 'lb1', tex: 'x = ?' }]
    expect(verifiedMathDiscipline(actions, CLEAN_CTX)).toBe(true)
  })

  it('fails when ctx reports any mathcheck-verify errors, even with clean text', () => {
    expect(verifiedMathDiscipline(cleanSay, { verifyErrors: 1, sanitizeDrops: 0 })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// noRawLongDigitsOutsideTemplates — NOT wired into any EvalCase (see its doc
// comment in cases.ts for why). Kept and unit-tested here only as a record of
// the pre-verify heuristic this replaced.
// ---------------------------------------------------------------------------

describe('noRawLongDigitsOutsideTemplates (unit-tested only, not in runner)', () => {
  it('passes on raw pre-verify text with {{...}} templates intact', () => {
    const actions: Action[] = [{ op: 'say', text: 'The roots are {{root1(1,-3,-4)}} and {{root2(1,-3,-4)}}.' }]
    expect(noRawLongDigitsOutsideTemplates(actions)).toBe(true)
  })

  it('fails on a hardcoded 3+ digit run outside any template', () => {
    const actions: Action[] = [{ op: 'say', text: 'The solutions come out to 4125 and -156, trust me.' }]
    expect(noRawLongDigitsOutsideTemplates(actions)).toBe(false)
  })

  it('demonstrates the false-positive bug this replaced: fails on legitimate post-verify formatNum output', () => {
    // formatNum (shared/src/mathcheck.ts) renders to 3 decimals, so a value
    // like -0.732 is entirely correct, already-verified output -- yet this
    // heuristic still flags it, because it doesn't know it's already past a
    // {{...}} boundary. This is exactly why it was removed from the live/dry
    // check path in favor of verifiedMathDiscipline.
    const actions: Action[] = [{ op: 'say', text: 'The slope there is -0.732.' }]
    expect(noRawLongDigitsOutsideTemplates(actions)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// run.ts's accounting split: classifyOnErrorReason + computeMetrics, pulled
// out of runCase specifically so this double-counting bug (mathcheck errors
// landing in both `emitted` and the old `dropped`) is directly assertable
// without spinning up a fake Anthropic client/stream.
// ---------------------------------------------------------------------------

describe('classifyOnErrorReason', () => {
  it('classifies a mathcheck/evalTemplate reason as a verifyError', () => {
    expect(classifyOnErrorReason('bad math expression "nope(1,2)": nope is not defined')).toBe('verifyError')
  })

  it('classifies a sanitizeAction reason as a sanitizeDrop', () => {
    expect(classifyOnErrorReason('unknown id: ghost')).toBe('sanitizeDrop')
    expect(classifyOnErrorReason('unsafe expr: import("fs")')).toBe('sanitizeDrop')
    expect(classifyOnErrorReason('invalid action: does not match ActionSchema')).toBe('sanitizeDrop')
  })

  it('classifies the generic catch-all / trailing-garbage reasons as sanitizeDrops (neither is a mathcheck error)', () => {
    expect(classifyOnErrorReason('render_plan stream ended mid-action')).toBe('sanitizeDrop')
  })
})

describe('computeMetrics', () => {
  const trivialCase: EvalCase = {
    name: 'trivial',
    message: 'hi',
    checks: [{ desc: 'always true', pass: () => true }],
  }

  it('validity% counts only emitted vs sanitizeDrops -- verifyErrors never enters the denominator or numerator', () => {
    // 4 actions emitted, 1 sanitize-dropped, 1 mathcheck-verify error (which,
    // per streamBoardTurn, still emits its action -- it is NOT a drop).
    // Old (buggy) accounting would have folded verifyErrors into "dropped"
    // and computed 4/(4+1+1) = 66.7%; correct accounting excludes it: 4/5 = 80%.
    const counters: CaseCounters = { emitted: 4, sanitizeDrops: 1, verifyErrors: 1 }
    const metrics = computeMetrics(trivialCase, [], counters, 100)
    expect(metrics.validityPct).toBeCloseTo(80, 5)
  })

  it('is 0% when nothing was ever emitted or sanitize-dropped (no divide-by-zero)', () => {
    const counters: CaseCounters = { emitted: 0, sanitizeDrops: 0, verifyErrors: 0 }
    expect(computeMetrics(trivialCase, [], counters, 0).validityPct).toBe(0)
  })

  it('is 100% when there are verifyErrors but zero sanitizeDrops', () => {
    const counters: CaseCounters = { emitted: 3, sanitizeDrops: 0, verifyErrors: 2 }
    expect(computeMetrics(trivialCase, [], counters, 90).validityPct).toBe(100)
  })

  it('threads counters.verifyErrors/sanitizeDrops into every check as CheckCtx', () => {
    const seenCtx: CheckCtx[] = []
    const ctxSpyCase: EvalCase = {
      name: 'ctx-spy',
      message: 'hi',
      checks: [
        {
          desc: 'records the ctx it was called with',
          pass: (_actions, ctx) => {
            seenCtx.push(ctx)
            return true
          },
        },
      ],
    }
    const counters: CaseCounters = { emitted: 1, sanitizeDrops: 2, verifyErrors: 3 }
    computeMetrics(ctxSpyCase, [], counters, 10)
    expect(seenCtx).toEqual([{ verifyErrors: 3, sanitizeDrops: 2 }])
  })

  it('computes visualCount/tokensPerVisual from the action list, independent of the error counters', () => {
    const actions: Action[] = [
      { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
      { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2' },
      { op: 'say', text: 'hi' },
    ]
    const counters: CaseCounters = { emitted: 3, sanitizeDrops: 0, verifyErrors: 0 }
    const metrics = computeMetrics(trivialCase, actions, counters, 200)
    expect(metrics.visualCount).toBe(2)
    expect(metrics.tokensPerVisual).toBe(100)
  })
})
