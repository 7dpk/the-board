import type { Action } from '@board/shared'

// ---------------------------------------------------------------------------
// EVAL_CASES — the 10 named cases from task-18-brief.md. Each case is a
// single opening user turn (or, for `event-response`, a `[event] ...` line)
// plus a set of pure structural/content predicates over the FINAL action
// list a turn produces. Checks never touch the network or a Scene — they are
// plain functions over `Action[]`, unit-tested directly in
// server/test/eval-cases.test.ts against hand-written good/bad lists.
// ---------------------------------------------------------------------------

// Per-case context threaded into every Check alongside the final action list.
// Sourced from the runner's onError accounting (see run.ts's classifyOnErrorReason
// / computeMetrics) — the two counts a Check can honestly ask about without
// touching raw pre-verify model output (which the runner never retains).
export type CheckCtx = { verifyErrors: number; sanitizeDrops: number }
export type Check = { desc: string; pass(actions: Action[], ctx: CheckCtx): boolean }
export type EvalCase = { name: string; message: string; checks: Check[] }

// ---------------------------------------------------------------------------
// Shared predicate helpers
// ---------------------------------------------------------------------------

type Say = Extract<Action, { op: 'say' }>
type Add = Extract<Action, { op: 'add' }>

function sayActions(actions: Action[]): Say[] {
  return actions.filter((a): a is Say => a.op === 'say')
}

function addOf<C extends Add['c']>(actions: Action[], c: C): Extract<Add, { c: C }>[] {
  return actions.filter((a): a is Extract<Add, { c: C }> => a.op === 'add' && a.c === c)
}

function countOp(actions: Action[], op: Action['op']): number {
  return actions.filter((a) => a.op === op).length
}

function anySay(actions: Action[], re: RegExp): boolean {
  return sayActions(actions).some((a) => re.test(a.text))
}

// NOT WIRED INTO ANY EvalCase — kept only as a unit-tested helper documenting
// the heuristic this replaced. Strips {{...}} template spans, then checks the
// remainder for any run of 3+ digit characters — a proxy for "the model
// hardcoded a computed number instead of writing a {{...}} template
// expression."
//
// Why it was removed from the live/dry check path: it is only meaningful
// against RAW (pre-verifyActions) action text, where {{...}} markers are
// still literal substrings. streamBoardTurn's real pipeline runs
// verifyActions before an action ever reaches `onAction`/the returned action
// list — by then every {{...}} span has already been replaced by its computed
// value (see shared/src/mathcheck.ts's verifyActions/formatNum), so
// post-verify text no longer distinguishes "templated" from "hardcoded"
// digits. Worse, formatNum's own 3-decimal output (e.g. "-0.732") contains a
// 3+ digit run and would false-fail this check on entirely correct,
// already-verified narration — that false failure is exactly the bug this
// task fixes. See `verifiedMathDiscipline` below for the check actually wired
// into roots-explanation.
export function noRawLongDigitsOutsideTemplates(actions: Action[]): boolean {
  return sayActions(actions).every((a) => !/\d{3,}/.test(a.text.replace(/\{\{.*?\}\}/g, '')))
}

// The check actually wired into roots-explanation. Honestly live-measurable:
// zero mathcheck-verify errors were reported for this case by the runner (see
// run.ts's classifyOnErrorReason). This is a stand-in for "every {{...}}
// template the model wrote actually evaluated" — verifiable without ever
// looking at pre-verify text.
//
// Why NOT also flag a literal "?" in say/label text (the old second half of
// this check): evalTemplate substitutes "?" for an unevaluable template, but a
// bare "?" is ALSO just ordinary punctuation. The prompt actively encourages
// prediction QUESTIONS ("what do you think the root is?"), so a "?" is not
// on-the-record evidence of anything — flagging it false-failed legitimate
// tutoring narration. A genuinely broken template already shows up as a
// ctx.verifyErrors bump, which is what this check keys on.
export function verifiedMathDiscipline(_actions: Action[], ctx: CheckCtx): boolean {
  return ctx.verifyErrors === 0
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const EVAL_CASES: EvalCase[] = [
  {
    name: 'quadratic-intro',
    message: 'Introduce me to the parabola y = x^2 — graph it and let me explore how it changes.',
    checks: [
      { desc: 'has an axes element', pass: (a) => addOf(a, 'axes').length >= 1 },
      {
        desc: 'has a plot whose expr matches x^2',
        pass: (a) => addOf(a, 'plot').some((p) => /x\s*\^\s*2/.test(p.expr)),
      },
      { desc: 'has at least one ctl action', pass: (a) => countOp(a, 'ctl') >= 1 },
      { desc: 'has at least two say actions', pass: (a) => countOp(a, 'say') >= 2 },
    ],
  },

  {
    name: 'roots-explanation',
    message: 'Explain how to find the roots of x^2 - 3x - 4 = 0.',
    checks: [
      {
        desc: 'verified-math discipline: zero mathcheck-verify errors reported for the turn',
        pass: verifiedMathDiscipline,
      },
      { desc: 'at least one say mentions "root(s)"', pass: (a) => anySay(a, /root/i) },
    ],
  },

  {
    name: 'projectile-45',
    message: 'Show me a projectile launched at 45 degrees and explain its range.',
    checks: [
      {
        desc: 'has a projectile with deg between 40 and 50',
        pass: (a) => addOf(a, 'projectile').some((p) => p.deg >= 40 && p.deg <= 50),
      },
      { desc: 'has an anim action on t', pass: (a) => a.some((x) => x.op === 'anim' && x.k === 't') },
      { desc: 'has a say mentioning range', pass: (a) => anySay(a, /range/i) },
    ],
  },

  {
    name: 'tangent-slope',
    message: 'Draw the tangent line to y = x^3 at x = 2 and tell me the slope there.',
    checks: [
      { desc: 'has an axes element', pass: (a) => addOf(a, 'axes').length >= 1 },
      { desc: 'has a tangent add action', pass: (a) => addOf(a, 'tangent').length >= 1 },
      { desc: 'has a say mentioning slope', pass: (a) => anySay(a, /slope/i) },
    ],
  },

  {
    name: 'area-under-curve',
    message: 'Show me the area under y = x^2 between x=0 and x=2.',
    checks: [
      { desc: 'has an axes element', pass: (a) => addOf(a, 'axes').length >= 1 },
      {
        desc: 'has an area add action with from < to',
        pass: (a) => addOf(a, 'area').some((ar) => ar.from < ar.to),
      },
      { desc: 'has a say mentioning area', pass: (a) => anySay(a, /area/i) },
    ],
  },

  {
    name: 'pendulum-period',
    message: 'Explain the period of a pendulum with length 2 meters.',
    checks: [
      { desc: 'has a pendulum add action', pass: (a) => addOf(a, 'pendulum').length >= 1 },
      {
        desc: 'has an anim or ctl on t/length/deg0',
        pass: (a) =>
          a.some((x) => (x.op === 'anim' || x.op === 'ctl') && ['t', 'length', 'deg0'].includes(x.k)),
      },
      { desc: 'has a say mentioning period', pass: (a) => anySay(a, /period/i) },
    ],
  },

  {
    name: 'incline-forces',
    message: 'Show the forces on a block on a 30 degree frictionless incline.',
    checks: [
      {
        desc: 'has an fbd, or an incline with showForces',
        pass: (a) => addOf(a, 'fbd').length >= 1 || addOf(a, 'incline').some((i) => i.showForces === true),
      },
      { desc: 'has a say mentioning force', pass: (a) => anySay(a, /force/i) },
    ],
  },

  {
    name: 'numberline-fractions',
    message: 'Show me where 3/4 sits on a number line between 0 and 1.',
    checks: [
      { desc: 'has a numberline add action', pass: (a) => addOf(a, 'numberline').length >= 1 },
      {
        desc: 'the numberline has at least one mark',
        pass: (a) => addOf(a, 'numberline').some((nl) => (nl.marks?.length ?? 0) >= 1),
      },
      { desc: 'has a say mentioning fraction', pass: (a) => anySay(a, /fraction/i) },
    ],
  },

  {
    name: 'ask-mcq-format',
    message: 'Quiz me with a multiple-choice question about factoring quadratics.',
    checks: [
      {
        desc: 'has an ask action with kind mcq',
        pass: (a) => a.some((x) => x.op === 'ask' && x.kind === 'mcq'),
      },
      {
        desc: 'the mcq has at least 2 options',
        pass: (a) => a.some((x) => x.op === 'ask' && x.kind === 'mcq' && (x.options?.length ?? 0) >= 2),
      },
      {
        desc: 'the mcq answer matches one of its options verbatim',
        pass: (a) =>
          a.some(
            (x) => x.op === 'ask' && x.kind === 'mcq' && x.answer !== undefined && x.options?.includes(x.answer),
          ),
      },
    ],
  },

  {
    name: 'event-response',
    // Bracketed [event] line, matching session.ts's summarizeEvent() output
    // format exactly (`student dragged <id>.<k> <from>→<to>`).
    message: '[event] student dragged p1.deg 45→60',
    checks: [
      { desc: 'at most 5 actions', pass: (a) => a.length <= 5 },
      { desc: 'at least one say action', pass: (a) => countOp(a, 'say') >= 1 },
      { desc: 'no clear action', pass: (a) => countOp(a, 'clear') === 0 },
    ],
  },
]
