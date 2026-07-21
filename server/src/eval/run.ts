import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSystemPrompt,
  emptyScene,
  sanitizeAction,
  verifyActions,
  applyAction,
  type Action,
  type Scene,
} from '@board/shared'
import type { TurnCallbacks } from '../pipeline'
import { createProviderClient, getTurnFn, type TurnFn } from '../provider'
import { BOARD_MODEL, BOARD_PROVIDER } from '../models'
import { EVAL_CASES, type EvalCase, type CheckCtx } from './cases'

// ---------------------------------------------------------------------------
// Task 18 — semantic eval harness. Runs each of the 10 EVAL_CASES as a fresh,
// minimal session turn (emptyScene, a single opening user message) through
// `turnFn` (real `streamBoardTurn` by default), and reports the four metrics
// the small-model claim rests on: validity%, semantic pass%, avg output
// tokens/visual, and median time-to-first-action (TTFA).
//
// `turnFn` is injectable (see TurnFn below) so this file can run end-to-end,
// deterministically, with zero network/API dependency via `--dry` — see
// makeDryTurnFn(). The real path (`npm run eval`) needs a real ANTHROPIC_API_KEY
// in server/../.env; the live run + docs/eval-baseline.md write-up happens in
// a later task once that key exists.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Accounting — three DISTINCT counters, never conflated:
//   emitted        — cb.onAction fires once per action that survives
//                     sanitize+verify and actually lands on the board.
//   sanitizeDrops  — cb.onError fires with a sanitizeAction-shaped reason
//                     (shared/src/sanitize.ts, e.g. "unknown id: ...",
//                     "unsafe expr: ..."). The action is dropped entirely —
//                     it never reaches onAction, never lands on the board.
//   verifyErrors   — cb.onError fires with a mathcheck-shaped reason
//                     (shared/src/mathcheck.ts's evalTemplate, always
//                     literally `bad math expression "<expr>": <message>`).
//                     The action is NOT dropped — verifyActions still lets it
//                     through (with "?" standing in for the broken {{...}}
//                     expression), so it ALSO fires onAction. Counting it
//                     against `dropped` (the old behavior) double-counted it:
//                     the same action was in both `emitted` and `dropped`.
//
// validity% (per the brief: "sanitized-accepted / total-emitted actions") is
// now emitted / (emitted + sanitizeDrops) — purely a structural-acceptance
// rate. verifyErrors is a separate quality signal (content, not structure)
// reported in its own column/field, never folded into validity%.
// ---------------------------------------------------------------------------

export type CaseCounters = { emitted: number; sanitizeDrops: number; verifyErrors: number }

// The one stable, distinguishing substring streamBoardTurn's onError ever
// produces: verifyActions' failures always start with this literal phrase
// (see shared/src/mathcheck.ts's evalTemplate). sanitizeAction's failures are
// free-form structural messages with no shared prefix, and neither the
// generic catch-all nor the end-of-stream "trailing garbage" report ever
// produces this phrase — so anything that isn't a mathcheck error is treated
// as a sanitize-style drop (the action never reached onAction).
const VERIFY_ERROR_PREFIX = 'bad math expression'

export function classifyOnErrorReason(reason: string): 'verifyError' | 'sanitizeDrop' {
  return reason.startsWith(VERIFY_ERROR_PREFIX) ? 'verifyError' : 'sanitizeDrop'
}

type CaseMetrics = {
  validityPct: number
  checkResults: { desc: string; pass: boolean }[]
  checksPassed: number
  checksTotal: number
  visualCount: number
  tokensPerVisual: number
}

// Pure metrics computation, split out of runCase (which is I/O-bound — it
// calls turnFn) so the validity/checks/tokens-per-visual math is directly
// unit-testable without a fake client or an async round trip.
export function computeMetrics(
  evalCase: EvalCase,
  actions: Action[],
  counters: CaseCounters,
  outputTokens: number,
): CaseMetrics {
  const totalForValidity = counters.emitted + counters.sanitizeDrops
  const validityPct = totalForValidity === 0 ? 0 : (counters.emitted / totalForValidity) * 100

  const ctx: CheckCtx = { verifyErrors: counters.verifyErrors, sanitizeDrops: counters.sanitizeDrops }
  const checkResults = evalCase.checks.map((check) => ({ desc: check.desc, pass: check.pass(actions, ctx) }))
  const checksPassed = checkResults.filter((c) => c.pass).length

  const visualCount = actions.filter((a) => a.op === 'add').length
  const tokensPerVisual = visualCount === 0 ? outputTokens : outputTokens / visualCount

  return { validityPct, checkResults, checksPassed, checksTotal: evalCase.checks.length, visualCount, tokensPerVisual }
}

type CaseResult = {
  name: string
  emitted: number
  sanitizeDrops: number
  verifyErrors: number
  validityPct: number
  checkResults: { desc: string; pass: boolean }[]
  checksPassed: number
  checksTotal: number
  outputTokens: number
  visualCount: number
  tokensPerVisual: number
  ttfaMs: number | null
  dropReasons: string[]
  actions: Action[]
}

const SYSTEM_PROMPT = buildSystemPrompt()

async function runCase(evalCase: EvalCase, turnFn: TurnFn): Promise<CaseResult> {
  let emitted = 0
  let sanitizeDrops = 0
  let verifyErrors = 0
  let ttfaMs: number | null = null
  const dropReasons: string[] = []
  const start = performance.now()

  const cb: TurnCallbacks = {
    onAction: () => {
      emitted++
      if (ttfaMs === null) ttfaMs = performance.now() - start
    },
    onError: (reason) => {
      if (classifyOnErrorReason(reason) === 'verifyError') verifyErrors++
      else sanitizeDrops++
      dropReasons.push(reason)
    },
  }

  const result = await turnFn({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: evalCase.message }],
    scene: emptyScene,
    model: BOARD_MODEL,
    cb,
  })

  const counters: CaseCounters = { emitted, sanitizeDrops, verifyErrors }
  const metrics = computeMetrics(evalCase, result.actions, counters, result.usage.output)

  return {
    name: evalCase.name,
    emitted,
    sanitizeDrops,
    verifyErrors,
    ...metrics,
    dropReasons,
    outputTokens: result.usage.output,
    ttfaMs,
    actions: result.actions,
  }
}

// ---------------------------------------------------------------------------
// --dry scripted fake turn — exercises the EXACT same sanitize -> verify ->
// apply -> emit pipeline streamBoardTurn runs per action (so sanitize/verify
// bugs would still surface), but instead of calling the Anthropic API, reads
// a canned "model output" keyed by the case's message text. Lets the whole
// runner (case iteration, --case filter, metrics computation, table
// printing, eval-results.json) be proven end-to-end with zero API key.
// ---------------------------------------------------------------------------

// One canned raw action list per EVAL_CASES entry, in the same order — see
// cases.ts for the case definitions these scripts are designed to satisfy.
//
// Two scripts below (tangent-slope, area-under-curve) each append one
// deliberately-bad extra raw action so `--dry` proves the emitted /
// sanitizeDrops / verifyErrors counters actually separate: tangent-slope's
// extra `{{nope(...)}}` template can't be evaluated (mathcheck has no `nope`
// function) -> one verifyError, action still emitted with a "?" placeholder;
// area-under-curve's extra `set` targets an id that was never added ->
// sanitizeAction rejects it -> one sanitizeDrop, action never emitted.
// Neither extra action affects its case's own checks (added after the
// content those checks look for; the tangent-slope check doesn't test for
// "?", and the dropped area-under-curve action never reaches `actions`).
const DRY_SCRIPTS: unknown[][] = [
  // quadratic-intro
  [
    { op: 'step', title: 'Meet the parabola' },
    { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
    { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2' },
    { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 2, y: 4 },
    { op: 'say', text: 'This is the graph of y = x^2, a parabola.' },
    { op: 'ctl', id: 'pt1', k: 'x', kind: 'drag' },
    { op: 'say', text: 'Drag the point to see how y changes as x changes.' },
  ],
  // roots-explanation
  [
    { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
    { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2 - 3*x - 4' },
    { op: 'say', text: 'The roots are {{root1(1,-3,-4)}} and {{root2(1,-3,-4)}}.' },
  ],
  // projectile-45
  [
    { op: 'step', title: 'Projectile motion' },
    { op: 'add', c: 'projectile', id: 'pr1', v0: 20, deg: 45 },
    { op: 'say', text: 'Launched at 45 degrees, the projectile follows this arc.' },
    { op: 'anim', id: 'pr1', k: 't', to: 1, dur: 2 },
    { op: 'say', text: 'Its range is {{projRange(20,45)}} meters.' },
  ],
  // tangent-slope
  [
    { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -10, ymax: 10 },
    { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^3' },
    { op: 'add', c: 'tangent', id: 'tg1', on: 'ax1', expr: 'x^3', at: 2 },
    { op: 'say', text: 'The slope of the tangent at x=2 is {{deriv("x^3",2)}}.' },
    // Deliberately unresolvable -> exercises verifyErrors (see block comment above).
    { op: 'say', text: 'Debug note: {{nope(1,2)}}' },
  ],
  // area-under-curve
  [
    { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 10 },
    { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2' },
    { op: 'add', c: 'area', id: 'ar1', on: 'ax1', expr: 'x^2', from: 0, to: 2 },
    { op: 'say', text: 'The shaded area under the curve runs from x=0 to x=2.' },
    // Deliberately references a never-added id -> exercises sanitizeDrops (see block comment above).
    { op: 'set', id: 'ghost', k: 'color', v: 'red' },
  ],
  // pendulum-period
  [
    { op: 'add', c: 'pendulum', id: 'pd1', length: 2, deg0: 20 },
    { op: 'ctl', id: 'pd1', k: 'length', kind: 'slider' },
    { op: 'say', text: 'The period is {{pendPeriod(2)}} seconds.' },
  ],
  // incline-forces
  [
    { op: 'add', c: 'incline', id: 'in1', deg: 30, mu: 0, mass: 5, showForces: true },
    { op: 'say', text: 'The forces acting on the block are gravity, normal force, and friction.' },
  ],
  // numberline-fractions
  [
    { op: 'add', c: 'numberline', id: 'nl1', min: 0, max: 1, marks: [0.25, 0.5, 0.75] },
    { op: 'say', text: 'The fraction 3/4 lands here, between 0.5 and 1.' },
  ],
  // ask-mcq-format
  [
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
  // event-response
  [
    { op: 'say', text: 'Increasing the angle to 60 degrees raises the arc higher and shortens the range a bit.' },
  ],
]

function makeDryTurnFn(): TurnFn {
  const scriptByMessage = new Map(EVAL_CASES.map((c, i) => [c.message, DRY_SCRIPTS[i] ?? []]))

  return (async (opts: {
    system: string
    messages: { role: string; content: unknown }[]
    scene: Scene
    model?: string
    cb: TurnCallbacks
  }) => {
    const last = opts.messages[opts.messages.length - 1]
    const userText = typeof last?.content === 'string' ? last.content : ''
    const script = scriptByMessage.get(userText) ?? []

    const actions: Action[] = []
    let liveScene = opts.scene
    for (const raw of script) {
      const sanitized = sanitizeAction(raw, liveScene)
      if (!sanitized.ok) {
        opts.cb.onError(sanitized.reason)
        continue
      }
      const { actions: verified, errors } = verifyActions([sanitized.action])
      for (const reason of errors) opts.cb.onError(reason)
      const action = verified[0]
      if (!action) continue
      liveScene = applyAction(liveScene, action)
      actions.push(action)
      opts.cb.onAction(action)
    }

    // Deterministic-but-plausible fake usage, scaled with plan size, so
    // tokens/visual isn't a suspicious constant across every case.
    const outputTokens = 40 + actions.length * 25
    return { actions, usage: { input: 500, output: outputTokens, cacheRead: 0 } }
  }) as unknown as TurnFn
}

// ---------------------------------------------------------------------------
// CLI: --case <name> filters to a single case; --dry swaps in the scripted
// fake turn function above (no client, no network).
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { caseFilter?: string; dry: boolean } {
  let caseFilter: string | undefined
  let dry = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case') caseFilter = argv[++i]
    else if (argv[i] === '--dry') dry = true
  }
  return { caseFilter, dry }
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function printTable(results: CaseResult[]): void {
  const header = ['case', 'validity%', 'verify-err', 'checks', 'out-tok', 'visuals', 'tok/vis', 'ttfa(ms)']
  const rows = results.map((r) => [
    r.name,
    r.validityPct.toFixed(1),
    String(r.verifyErrors),
    `${r.checksPassed}/${r.checksTotal}`,
    String(r.outputTokens),
    String(r.visualCount),
    r.tokensPerVisual.toFixed(1),
    r.ttfaMs === null ? 'n/a' : r.ttfaMs.toFixed(0),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)))
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ')

  console.log(fmt(header))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const row of rows) console.log(fmt(row))
}

async function main(): Promise<void> {
  const { caseFilter, dry } = parseArgs(process.argv.slice(2))

  const cases = caseFilter ? EVAL_CASES.filter((c) => c.name === caseFilter) : EVAL_CASES
  if (cases.length === 0) {
    console.error(`no eval case named "${caseFilter}". Known cases: ${EVAL_CASES.map((c) => c.name).join(', ')}`)
    process.exitCode = 1
    return
  }

  // Constructed even in --dry mode (cheap, no network call at construction
  // time) but never touched by the dry turnFn — keeps the call site uniform.
  // getTurnFn(client) picks streamBoardTurn vs streamBoardTurnOpenAI per
  // BOARD_PROVIDER (models.ts) — same seam routes.ts uses.
  const turnFn: TurnFn = dry ? makeDryTurnFn() : getTurnFn(createProviderClient())

  const results: CaseResult[] = []
  for (const c of cases) {
    // Sequential by design: turns share nothing, but real API calls should
    // never run concurrently in an eval meant to measure per-turn latency.
    results.push(await runCase(c, turnFn))
  }

  console.log(`\n${dry ? '[dry run] ' : ''}eval results (${results.length} case${results.length === 1 ? '' : 's'}):\n`)
  printTable(results)

  for (const r of results) {
    const failed = r.checkResults.filter((c) => !c.pass)
    if (failed.length > 0) {
      console.log(`\n${r.name} — failed checks:`)
      for (const f of failed) console.log(`  - ${f.desc}`)
    }
  }

  const totalEmitted = results.reduce((s, r) => s + r.emitted, 0)
  const totalSanitizeDrops = results.reduce((s, r) => s + r.sanitizeDrops, 0)
  const totalVerifyErrors = results.reduce((s, r) => s + r.verifyErrors, 0)
  const overallValidity =
    totalEmitted + totalSanitizeDrops === 0 ? 0 : (totalEmitted / (totalEmitted + totalSanitizeDrops)) * 100

  const totalChecksPassed = results.reduce((s, r) => s + r.checksPassed, 0)
  const totalChecks = results.reduce((s, r) => s + r.checksTotal, 0)
  const overallSemantic = totalChecks === 0 ? 0 : (totalChecksPassed / totalChecks) * 100

  const totalOutputTokens = results.reduce((s, r) => s + r.outputTokens, 0)
  const totalVisuals = results.reduce((s, r) => s + r.visualCount, 0)
  const overallTokensPerVisual = totalVisuals === 0 ? totalOutputTokens : totalOutputTokens / totalVisuals

  const ttfaValues = results.map((r) => r.ttfaMs).filter((v): v is number => v !== null)
  const medianTtfa = median(ttfaValues)

  const targets = { validityPct: 95, semanticPassPct: 80, maxTokensPerVisual: 300, maxTtfaMs: 1500 }
  const verdict = (ok: boolean) => (ok ? 'PASS' : 'FAIL')

  console.log('\ntotals:')
  console.log(
    `  validity%         : ${overallValidity.toFixed(1)}  (target >=${targets.validityPct})  ${verdict(overallValidity >= targets.validityPct)}`,
  )
  console.log(
    `  semantic pass%     : ${overallSemantic.toFixed(1)}  (target >=${targets.semanticPassPct})  ${verdict(overallSemantic >= targets.semanticPassPct)}`,
  )
  console.log(
    `  avg tokens/visual  : ${overallTokensPerVisual.toFixed(1)}  (target <=${targets.maxTokensPerVisual})  ${verdict(overallTokensPerVisual <= targets.maxTokensPerVisual)}`,
  )
  console.log(
    `  median TTFA (ms)   : ${medianTtfa.toFixed(0)}  (target <${targets.maxTtfaMs})  ${verdict(medianTtfa < targets.maxTtfaMs)}`,
  )
  console.log(
    `  mathcheck-verify errors : ${totalVerifyErrors}  (content-quality signal, excluded from validity%)`,
  )

  const resultsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval-results.json')
  fs.writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dry,
        provider: BOARD_PROVIDER,
        model: BOARD_MODEL,
        cases: results.map(({ actions: _actions, ...rest }) => rest),
        totals: {
          validityPct: overallValidity,
          semanticPassPct: overallSemantic,
          avgTokensPerVisual: overallTokensPerVisual,
          medianTtfaMs: medianTtfa,
          sanitizeDrops: totalSanitizeDrops,
          verifyErrors: totalVerifyErrors,
        },
        targets,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`\nwrote ${resultsPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
