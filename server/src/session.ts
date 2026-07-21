import crypto from 'node:crypto'
import {
  type Scene,
  emptyScene,
  formatNum,
  sanitizeAction,
  applyAction,
  type BoardEvent,
  type Action,
} from '@board/shared'
import type { Blueprint, Prerequisite, Beat } from './blueprint'
import type { TurnMessage } from './pipeline'

// Blueprint/Prerequisite/Beat are the zod-inferred types from
// server/src/blueprint.ts's BlueprintSchema — imported (not redefined) here
// so the session state machine and the planner can never drift apart.
export type { Blueprint, Prerequisite, Beat }

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type Phase = 'plan' | 'probe' | 'teach' | 'qa' | 'check' | 'done'

export type Session = {
  id: string
  topic: string
  phase: Phase
  beatIndex: number
  probeIndex: number
  failedChecks: number // hint-ladder counter, reset per beat
  failedProbes: number // per-probe attempt counter, reset per probe
  blueprint: Blueprint | null
  scene: Scene
  transcript: TurnMessage[]
  asks: Record<string, { answer?: string }>
  turnInFlight: boolean
}

export const sessions: Map<string, Session> = new Map()

export function createSession(topic: string): Session {
  const session: Session = {
    id: crypto.randomUUID(),
    topic,
    phase: 'plan',
    beatIndex: 0,
    probeIndex: 0,
    failedChecks: 0,
    failedProbes: 0,
    blueprint: null,
    scene: emptyScene,
    transcript: [],
    asks: {},
    turnInFlight: false,
  }
  sessions.set(session.id, session)
  return session
}

// ---------------------------------------------------------------------------
// TurnInput
// ---------------------------------------------------------------------------

export type TurnInput =
  | { kind: 'start' }
  | { kind: 'chat'; text: string }
  | { kind: 'event'; event: BoardEvent }
  | { kind: 'answer'; askId: string; value: string }
  | { kind: 'warmup' }
  | { kind: 'continue' }

// ---------------------------------------------------------------------------
// sceneSummary — one line per element `id=c(param=val,...)`, numbers via
// formatNum; controls appended as a trailing line.
// ---------------------------------------------------------------------------

export function sceneSummary(scene: Scene): string {
  if (scene.order.length === 0) return '(empty board)'
  const lines = scene.order.map((id) => {
    const el = scene.elements[id]
    if (!el) return `${id}=?()`
    const params = Object.entries(el.params)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? formatNum(v) : String(v)}`)
      .join(',')
    return `${id}=${el.c}(${params})`
  })
  if (scene.controls.length) {
    const ctls = scene.controls
      .map((ctl) => `${ctl.id}.${ctl.k}(${ctl.kind} ${formatNum(ctl.min)}..${formatNum(ctl.max)})`)
      .join(', ')
    lines.push(`controls: ${ctls}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// summarizeEvent — renders a BoardEvent as the one-line `[event] ...` body.
// ---------------------------------------------------------------------------

export function summarizeEvent(event: BoardEvent, scene: Scene): string {
  switch (event.ev) {
    case 'param':
      return `student dragged ${event.id}.${event.k} ${formatNum(event.from)}→${formatNum(event.to)}`
    case 'select': {
      const type = scene.elements[event.id]?.c ?? 'element'
      return `student selected ${type} ${event.id}`
    }
    case 'answer': {
      const verdict = event.correct === true ? 'correct' : event.correct === false ? 'incorrect' : 'ungraded'
      return `student answered ask ${event.askId}: "${event.value}" (${verdict})`
    }
    case 'nav':
      return `student navigated ${event.action} to step ${event.step}`
  }
}

// ---------------------------------------------------------------------------
// applyParamEvent — when the student drags a control, the resulting param
// event ({ev:'param', id, k, from, to}) is a real board mutation, not just
// narration. Fold it into session.scene (as a sanitized `set`) so the board
// summary the tutor sees on this and later turns reflects the manipulation. A
// set that fails sanitization (unknown id, non-settable key, ...) is skipped
// silently — the event still gets narrated, the scene just isn't touched.
// ---------------------------------------------------------------------------

export function applyParamEvent(s: Session, event: BoardEvent): void {
  if (event.ev !== 'param') return
  const result = sanitizeAction({ op: 'set', id: event.id, k: event.k, v: event.to }, s.scene)
  if (result.ok) s.scene = applyAction(s.scene, result.action)
}

// ---------------------------------------------------------------------------
// nextUserMessage — the state machine. Composes the user turn text AND
// advances phase/beatIndex/probeIndex/failedChecks as a side effect, per
// task-9-brief's state table. `chat` is deliberately the one input kind that
// never mutates s.phase: the qa aside is reported to the SSE layer by the
// caller (routes.ts) inspecting input.kind directly, so there is nothing to
// "restore" afterward — the session's real phase was never touched.
//
// task D-2 (story-first start, feedback: "clicking on a topic asks me some
// questions, ideally it should display already created story"): `start` now
// goes straight to composeProgress -- teach beat 0 immediately, never a
// probe. The probe machinery isn't gone, just opt-in: a `warmup` turn (fired
// by the client's "Warm-up questions" chip, any time prereqCount > 0) runs
// the exact same probe -> remediation -> next-probe sequence through
// composeWarmupProgress, then resumes teaching at whatever beatIndex the
// student was already on (probes never touch beatIndex).
// ---------------------------------------------------------------------------

const DONE_MESSAGE =
  'Lesson complete. Give a short congratulatory wrap-up say summarizing what was covered. No further asks.'

function normalize(v: string): string {
  return v.trim().toLowerCase()
}

function composeTeachMessage(s: Session, beat: Beat): string {
  let msg =
    `Teach beat ${s.beatIndex}: "${beat.title}". Goal: ${beat.goal}. ` +
    `Scene skeleton (adapt, keep ids, do not contradict values): ${JSON.stringify(beat.skeleton)}. ` +
    `Current board: ${sceneSummary(s.scene)}.`
  if (beat.check) {
    const kind = beat.check.options ? 'mcq' : 'free'
    const optionsPart = beat.check.options ? ` options ${beat.check.options}` : ''
    msg += ` End this beat with an ask action (kind ${kind}): ${beat.check.text}${optionsPart} answer ${beat.check.answer}.`
  }
  return msg
}

// Composes whatever the session should do next given its current beatIndex,
// mutating s.phase to match. Shared by `start` (story-first: always lands
// here directly, never on a probe) and by every transition that moves
// beatIndex forward (check-correct, worked-step-advance) as well as by
// composeWarmupProgress once its probe detour is exhausted. Deliberately
// ignorant of probeIndex/prerequisites entirely -- probes are ONLY ever
// entered via the dedicated `warmup` turn kind below (task D-2: prerequisite
// probing used to gate the very first turn; feedback was "clicking on a
// topic asks me some questions, ideally it should display already created
// story", so `start` now composes this directly and probes became opt-in).
function composeProgress(s: Session): string {
  if (!s.blueprint) {
    s.phase = 'teach'
    return `Teach the next idea about ${s.topic}.`
  }
  const beats = s.blueprint.beats
  if (s.beatIndex >= beats.length) {
    s.phase = 'done'
    return DONE_MESSAGE
  }
  s.phase = 'teach'
  return composeTeachMessage(s, beats[s.beatIndex]!)
}

// composeWarmupProgress -- the `warmup` turn kind's state machine. Runs the
// exact same probe sequence `start` used to run (probe -> wrong ->
// remediation -> probe again -> ... -> next probe), driven by s.probeIndex,
// which is a separate counter from s.beatIndex. Once every prerequisite has
// been probed (or there were none to begin with), it falls through to
// composeProgress(s) -- since beatIndex was never touched by any of the
// probe machinery, this reproduces the teach message for exactly the beat
// the student was on before warmup started ("resumes teaching where it left
// off"), without needing to separately track/restore a prior phase.
function composeWarmupProgress(s: Session): string {
  const prereqs = s.blueprint?.prerequisites ?? []
  if (s.probeIndex < prereqs.length) {
    s.phase = 'probe'
    const q = prereqs[s.probeIndex]!
    return `Probe prerequisite ${s.probeIndex + 1}: ask this with an ask action (kind mcq): ${q.question} options ${q.options} answer ${q.answer}. One short say first.`
  }
  return composeProgress(s)
}

// composeContinue -- the `continue` turn kind's state machine (task F-1, bug:
// saying "ok"/"what's next" in chat used to re-run the same `chat` turn with
// nothing advanced, so the model just re-narrated/re-animated whatever was
// already on the board). Two cases:
//   - phase === 'check': a check is pending an answer. Continuing must NOT
//     advance the lesson (that would let the student skip the check) — just
//     ask the model to gently point back at it, with an explicit
//     no-re-render instruction, and leave phase/beatIndex untouched.
//   - otherwise: beatIndex is ALREADY positioned at whatever should be taught
//     next -- either because advanceAfterTeach auto-advanced past a checkless
//     beat (phase left at 'teach', beatIndex bumped, no forcing turn ever
//     sent that beat's content -- see the beat-skip-regression test in
//     session.test.ts, where a fresh `start` turn is what finally teaches
//     beat 1), or because a correct check-answer already advanced it via
//     handleAnswer below. So this is just composeProgress(s) -- delegating to
//     it (not a second beatIndex++) is what avoids double-advancing past a
//     beat whose content was never actually delivered.
function composeContinue(s: Session): string {
  if (s.phase === 'check') {
    const beat = s.blueprint?.beats[s.beatIndex]
    const checkText = beat?.check?.text
    return (
      `The student said something like "continue" or "what's next", but there is a pending question to answer first` +
      `${checkText ? `: "${checkText}"` : ''}. Give ONE short \`say\` gently pointing them back to it. ` +
      `Do NOT re-render, re-add, or re-animate anything already on the board — no actions besides that one say.`
    )
  }
  return composeProgress(s)
}

function handleAnswer(s: Session, input: Extract<TurnInput, { kind: 'answer' }>): string {
  if (s.phase === 'probe' && s.blueprint) {
    const q = s.blueprint.prerequisites[s.probeIndex]
    if (!q) return composeWarmupProgress(s)
    if (normalize(input.value) === normalize(q.answer)) {
      s.failedProbes = 0
      s.probeIndex++
      return composeWarmupProgress(s)
    }
    s.failedProbes++
    // Attempt cap: after 2 wrong tries on the SAME probe, deliver the
    // remediation one final time and advance regardless — never loop forever
    // on a probe the student can't answer.
    if (s.failedProbes >= 2) {
      s.failedProbes = 0
      s.probeIndex++
      const next = composeWarmupProgress(s)
      return `Prerequisite still missed after 2 attempts. Give a brief mini-lesson on: ${q.remediation}, then move on. ${next}`
    }
    s.phase = 'probe'
    return `Prerequisite check missed. Teach a 3-6 action mini-lesson on: ${q.remediation}. Then continue probing prerequisites.`
  }

  if (s.phase === 'check' && s.blueprint) {
    const beat = s.blueprint.beats[s.beatIndex]
    const expected = s.asks[input.askId]?.answer
    const correct = expected !== undefined && normalize(input.value) === normalize(expected)
    if (correct) {
      s.failedChecks = 0
      s.beatIndex++
      return composeProgress(s)
    }
    s.failedChecks++
    if (s.failedChecks <= 2) {
      s.phase = 'check'
      return `Incorrect answer (hint ${s.failedChecks}/2). Give a hint for "${beat?.check?.text ?? 'the check'}" without revealing the answer, then re-ask the same check.`
    }
    s.failedChecks = 0
    s.beatIndex++
    const next = composeProgress(s)
    return `Show the worked step for "${beat?.check?.text ?? 'the check'}" using focus+say, revealing the reasoning. ${next}`
  }

  // Defensive fallback: an `answer` arriving in a phase with nothing to
  // grade against (e.g. freeform session, or a stale/duplicate client
  // request) just continues the lesson rather than throwing.
  return composeProgress(s)
}

export function nextUserMessage(s: Session, input: TurnInput): string {
  switch (input.kind) {
    case 'start':
      return composeProgress(s)
    case 'chat':
      return `${input.text} Answer briefly on the board; keep existing elements; return to the lesson after.`
    case 'event':
      return `[event] ${summarizeEvent(input.event, s.scene)}`
    case 'answer':
      return handleAnswer(s, input)
    case 'warmup':
      return composeWarmupProgress(s)
    case 'continue':
      return composeContinue(s)
  }
}

// ---------------------------------------------------------------------------
// advanceAfterTeach — called by routes.ts after a *successful* teach-phase
// turn finishes streaming. Per brief: phase -> 'check' iff the current beat
// has a check. A beat with no check has no other trigger to move past it
// (TurnInput has no "continue" kind), so it auto-advances beatIndex here.
// No-op for freeform sessions (blueprint === null): nothing to advance.
// ---------------------------------------------------------------------------

export function advanceAfterTeach(s: Session): void {
  if (!s.blueprint) return
  const beat = s.blueprint.beats[s.beatIndex]
  if (!beat) return
  if (beat.check) {
    s.phase = 'check'
  } else {
    s.beatIndex++
    s.phase = s.beatIndex < s.blueprint.beats.length ? 'teach' : 'done'
  }
}

// ---------------------------------------------------------------------------
// recordTurn — transcript hygiene. Push the user message and a compact
// plain-text assistant summary (never the raw tool-use blocks — keeps the
// transcript small and cache-friendly). Cap at the last 30 messages.
// ---------------------------------------------------------------------------

export function recordTurn(s: Session, userMsg: string, actions: Action[]): void {
  const said = actions
    .filter((a): a is Extract<Action, { op: 'say' }> => a.op === 'say')
    .map((a) => a.text)
    .join(' ')
  s.transcript.push({ role: 'user', content: userMsg })
  s.transcript.push({ role: 'assistant', content: `actions: ${actions.length}; said: ${said.slice(0, 200)}` })
  if (s.transcript.length > 30) {
    s.transcript = s.transcript.slice(-30)
  }
}
