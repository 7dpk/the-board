// Drives one full lesson end-to-end against the LIVE provider through the real
// Hono app (createApp + app.request), logging every turn's action ops, says,
// and warns so prompt/fewshot rough edges surface. Usage:
//   tsx --env-file=../.env scripts/drive-lesson.ts "Quadratic Functions"
//
// task F-1: --continue-after-beat=<n> substitutes a `{kind:'continue'}` turn
// for the ONE resume turn the loop below would otherwise send as `{kind:
// 'start'}` once session.beatIndex first equals <n> with no ask pending --
// i.e. exactly the "resume teaching, nothing else pending" gap that occurs
// right after a checkless beat auto-advances (see
// server/test/session.test.ts's beat-skip-regression tests: that's the same
// moment a plain `start` turn resumes teaching). Verifies live that
// `continue` delivers the NEXT beat's content (a different step title) with
// no repetition of what was already taught, instead of re-animating it.
//   tsx --env-file=../.env scripts/drive-lesson.ts "Simple Harmonic Motion" --continue-after-beat=1
import type { Action } from '@board/shared'
import { createApp } from '../src/routes'
import { BOARD_MODEL, BOARD_PROVIDER } from '../src/models'
import { createProviderClient } from '../src/provider'

type Turn = { phase?: string; beatIndex?: number; actions: Action[]; warns: string[]; error?: string }

const rawArgs = process.argv.slice(2)
const continueFlagArg = rawArgs.find((a) => a.startsWith('--continue-after-beat='))
const continueAfterBeat = continueFlagArg ? Number(continueFlagArg.slice('--continue-after-beat='.length)) : undefined
const topic = rawArgs.filter((a) => !a.startsWith('--')).join(' ').trim() || 'Quadratic Functions'
const app = createApp({ client: createProviderClient() })

function parseSSE(body: string): Turn {
  const t: Turn = { actions: [], warns: [] }
  for (const block of body.split('\n\n')) {
    const ev = /event:\s*(.+)/.exec(block)?.[1]?.trim()
    const dataLine = block.split('\n').find((l) => l.startsWith('data:'))
    if (!ev || !dataLine) continue
    const data = JSON.parse(dataLine.slice(5).trim())
    if (ev === 'phase') { t.phase = data.phase; t.beatIndex = data.beatIndex }
    else if (ev === 'action') t.actions.push(data as Action)
    else if (ev === 'warn') t.warns.push(data.reason)
    else if (ev === 'error') t.error = data.message
  }
  return t
}

async function runTurn(id: string, input: unknown, n: number): Promise<Turn> {
  const res = await app.request(`/api/session/${id}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  })
  const turn = parseSSE(await res.text())
  const ops = turn.actions.map((a) => a.op).join(',')
  const says = turn.actions.filter((a): a is Extract<Action, { op: 'say' }> => a.op === 'say').map((a) => a.text)
  const steps = turn.actions.filter((a): a is Extract<Action, { op: 'step' }> => a.op === 'step').map((a) => a.title)
  console.log(`\n--- turn ${n} [${JSON.stringify(input).slice(0, 60)}] phase=${turn.phase} beat=${turn.beatIndex}`)
  console.log(`  ops(${turn.actions.length}): ${ops}`)
  for (const s of steps) console.log(`  STEP: ${s}`) // the on-board step title -- what the student actually sees change
  for (const s of says) console.log(`  say: ${s}`)
  if (turn.warns.length) console.log(`  WARNS(${turn.warns.length}): ${turn.warns.join(' | ')}`)
  if (turn.error) console.log(`  ERROR: ${turn.error}`)
  return turn
}

console.log(`=== LIVE lesson: "${topic}" (provider=${BOARD_PROVIDER} board=${BOARD_MODEL}) ===`)
const sres = await app.request('/api/session', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic }),
})
const session = await sres.json()
console.log(`session ${session.id} title="${session.title}" prereqs=${session.prereqCount} beats=${session.beatTitles.length}`)
if (session.warning) console.log(`session warning: ${session.warning}`)

const ctls: { id: string; k: string; min?: number; max?: number }[] = []
const captureCtl = (t: Turn) => {
  for (const a of t.actions) if (a.op === 'ctl') ctls.push({ id: a.id, k: a.k, min: a.min, max: a.max })
}

let n = 1
let last = await runTurn(session.id, { kind: 'start' }, n++)
captureCtl(last)
const teachBeats = new Set<number>()
let guard = 0
let continueFired = false
while (guard++ < 12 && last.phase !== 'done') {
  const ask = last.actions.find((a): a is Extract<Action, { op: 'ask' }> => a.op === 'ask')
  if (last.phase === 'teach' && last.beatIndex !== undefined) teachBeats.add(last.beatIndex)
  if (teachBeats.size >= 2 && !ask) break
  if (ask) {
    last = await runTurn(session.id, { kind: 'answer', askId: ask.id, value: ask.answer ?? '' }, n++)
  } else if (continueAfterBeat !== undefined && !continueFired && last.beatIndex === continueAfterBeat) {
    // task F-1: exactly the "resume teaching, nothing pending" gap the loop's
    // plain `start` resume call above would otherwise fill (see the
    // beat-skip-regression tests in server/test/session.test.ts) --
    // substitute `continue` here once, so its output is directly comparable
    // to what `start` would have produced at this same spot.
    continueFired = true
    console.log(`\n>>> CONTINUE turn substituted for the resume call at beatIndex ${last.beatIndex} <<<`)
    last = await runTurn(session.id, { kind: 'continue' }, n++)
  } else {
    last = await runTurn(session.id, { kind: 'start' }, n++)
  }
  captureCtl(last)
}

// 1 chat question
await runTurn(session.id, { kind: 'chat', text: 'Wait, can you explain why that shape appears?' }, n++)

// 1 param event (drag the last captured control)
const ctl = ctls.at(-1)
if (ctl) {
  const to = ctl.max !== undefined && ctl.min !== undefined ? (ctl.min + ctl.max) / 2 : 1
  const from = ctl.min ?? 0
  await runTurn(session.id, { kind: 'event', event: { ev: 'param', id: ctl.id, k: ctl.k, from, to } }, n++)
} else {
  console.log('\n(no ctl captured — skipping param event)')
}
console.log('\n=== done ===')
