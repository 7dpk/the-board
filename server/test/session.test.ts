import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  emptyScene,
  applyAction,
  sanitizeAction,
  verifyActions,
  type Scene,
  type Action,
  type BoardEvent,
} from '@board/shared'
import {
  createSession,
  sessions,
  nextUserMessage,
  advanceAfterTeach,
  recordTurn,
  sceneSummary,
  summarizeEvent,
  applyParamEvent,
  type Blueprint,
  type Session,
} from '../src/session'
import { BoardTurnError } from '../src/anthropic'
import { BOARD_MODEL, PLANNER_MODEL } from '../src/models'
import { createApp, type RouteDeps } from '../src/routes'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const blueprint: Blueprint = {
  title: 'Parabolas',
  prerequisites: [
    {
      id: 'q1',
      question: 'What is a variable?',
      options: ['a symbol', 'a number'],
      answer: 'a symbol',
      remediation: 'variables represent unknown values',
    },
    {
      id: 'q2',
      question: 'What is squaring?',
      options: ['multiply by itself', 'add to itself'],
      answer: 'multiply by itself',
      remediation: 'squaring means x times x',
    },
  ],
  beats: [
    {
      title: 'Intro to parabolas',
      goal: 'see the shape',
      skeleton: [{ op: 'say', text: 'hi' }] as Action[],
      check: { text: 'What shape is x^2?', options: ['U shape', 'line'], answer: 'U shape' },
    },
    {
      title: 'Vertex',
      goal: 'find the vertex',
      skeleton: [{ op: 'say', text: 'vertex' }] as Action[],
      // no check -> should auto-advance once taught
    },
  ],
}

const singleBeatBlueprint: Blueprint = {
  title: 'One Beat',
  prerequisites: [],
  beats: [
    {
      title: 'Only beat',
      goal: 'the only goal',
      skeleton: [] as Action[],
      check: { text: 'Done?', answer: 'yes' },
    },
  ],
}

// Checkless beat 0 (auto-advances once taught) followed by a checked beat 1
// -- used to reproduce the beat-skip regression: an `event` turn interleaved
// right after the checkless auto-advance must not be mistaken for having
// taught beat 1.
const checklessThenCheckedBlueprint: Blueprint = {
  title: 'Checkless Then Checked',
  prerequisites: [],
  beats: [
    {
      title: 'Beat zero (checkless)',
      goal: 'checkless goal',
      skeleton: [] as Action[],
      // no check -> auto-advances once taught
    },
    {
      title: 'Beat one (checked)',
      goal: 'checked goal',
      skeleton: [] as Action[],
      check: { text: 'Beat one check?', answer: 'yes' },
    },
  ],
}

// Two beats, both WITH checks -- used so a `chat` (qa) interleave's effect on
// beat progression is observable end-to-end (probe/teach/check all visible).
const twoCheckedBeatsBlueprint: Blueprint = {
  title: 'Two Checked Beats',
  prerequisites: [],
  beats: [
    {
      title: 'Beat A',
      goal: 'goal a',
      skeleton: [] as Action[],
      check: { text: 'A check?', answer: 'yes' },
    },
    {
      title: 'Beat B',
      goal: 'goal b',
      skeleton: [] as Action[],
      check: { text: 'B check?', answer: 'sure' },
    },
  ],
}

function freshBlueprintSession(bp: Blueprint | null): Session {
  const s = createSession('parabolas')
  s.blueprint = bp
  return s
}

// ===========================================================================
// Pure state machine tests (no HTTP)
// ===========================================================================

describe('createSession', () => {
  it('creates a fresh session with expected defaults and registers it in `sessions`', () => {
    const s = createSession('parabolas')
    expect(s.topic).toBe('parabolas')
    expect(s.phase).toBe('plan')
    expect(s.beatIndex).toBe(0)
    expect(s.probeIndex).toBe(0)
    expect(s.failedChecks).toBe(0)
    expect(s.blueprint).toBeNull()
    expect(s.transcript).toEqual([])
    expect(s.asks).toEqual({})
    expect(sessions.get(s.id)).toBe(s)
  })
})

describe('nextUserMessage: start', () => {
  // task D-2 (story-first start, feedback: "clicking on a topic asks me some
  // questions, ideally it should display already created story"): `start`
  // goes DIRECTLY to teaching beat 0, even when the blueprint has
  // prerequisites -- probing them is no longer part of the start path at
  // all (see the 'warmup' describe blocks below for where that machinery
  // moved).
  it('goes directly to teach beat 0 even with prerequisites present -- never probes', () => {
    const s = freshBlueprintSession(blueprint) // has 2 prerequisites
    const msg = nextUserMessage(s, { kind: 'start' })
    expect(s.phase).toBe('teach')
    expect(s.beatIndex).toBe(0)
    expect(s.probeIndex).toBe(0) // untouched -- start never enters probe
    expect(msg).toContain('Teach beat 0')
    expect(msg).toContain('Intro to parabolas')
    expect(msg).toContain('End this beat with an ask action (kind mcq): What shape is x^2? options U shape,line answer U shape.')
  })

  it('with no prerequisites -> phase teach, beat 0, includes check-ask instruction', () => {
    const s = freshBlueprintSession({ ...blueprint, prerequisites: [] })
    const msg = nextUserMessage(s, { kind: 'start' })
    expect(s.phase).toBe('teach')
    expect(msg).toContain('Teach beat 0')
    expect(msg).toContain('Intro to parabolas')
    expect(msg).toContain('End this beat with an ask action (kind mcq): What shape is x^2? options U shape,line answer U shape.')
  })

  it('freeform (blueprint null) -> fixed freeform teach message, phase teach', () => {
    const s = createSession('projectile motion')
    const msg = nextUserMessage(s, { kind: 'start' })
    expect(s.phase).toBe('teach')
    expect(msg).toBe('Teach the next idea about projectile motion.')
  })
})

describe('nextUserMessage: warmup (opt-in prerequisite probing, re-targeted from start)', () => {
  it('with prerequisites remaining -> phase probe, composes probe 1 message', () => {
    const s = freshBlueprintSession(blueprint)
    const msg = nextUserMessage(s, { kind: 'warmup' })
    expect(s.phase).toBe('probe')
    expect(msg).toContain('Probe prerequisite 1')
    expect(msg).toContain('What is a variable?')
    expect(msg).toContain('a symbol')
  })

  it('with no prerequisites -> resumes straight into teach beat 0 (nothing to probe)', () => {
    const s = freshBlueprintSession({ ...blueprint, prerequisites: [] })
    const msg = nextUserMessage(s, { kind: 'warmup' })
    expect(s.phase).toBe('teach')
    expect(msg).toContain('Teach beat 0')
  })
})

describe('nextUserMessage: answer during probe (probe entry re-targeted to warmup)', () => {
  it('wrong -> stays on same probe, message carries the remediation', () => {
    const s = freshBlueprintSession(blueprint)
    nextUserMessage(s, { kind: 'warmup' }) // enters probe phase, probeIndex 0
    const msg = nextUserMessage(s, { kind: 'answer', askId: 'q1', value: 'a number' })
    expect(s.phase).toBe('probe')
    expect(s.probeIndex).toBe(0)
    expect(msg).toContain('variables represent unknown values')
  })

  it('correct -> advances to next probe', () => {
    const s = freshBlueprintSession(blueprint)
    nextUserMessage(s, { kind: 'warmup' })
    const msg = nextUserMessage(s, { kind: 'answer', askId: 'q1', value: 'a symbol' })
    expect(s.phase).toBe('probe')
    expect(s.probeIndex).toBe(1)
    expect(msg).toContain('Probe prerequisite 2')
  })

  it('correct on last probe -> resumes straight into teach beat 0', () => {
    const s = freshBlueprintSession(blueprint)
    nextUserMessage(s, { kind: 'warmup' })
    nextUserMessage(s, { kind: 'answer', askId: 'q1', value: 'a symbol' })
    const msg = nextUserMessage(s, { kind: 'answer', askId: 'q2', value: 'multiply by itself' })
    expect(s.phase).toBe('teach')
    expect(s.beatIndex).toBe(0)
    expect(msg).toContain('Teach beat 0')
  })
})

// ---------------------------------------------------------------------------
// task D-2: warmup must be safe to fire at ANY point in the lesson (the
// client's chip stays visible until taken) and must resume teaching at
// whatever beat the student was already on -- never rewinding or advancing
// beatIndex, since probeIndex is an entirely separate counter.
// ---------------------------------------------------------------------------
describe('nextUserMessage: warmup mid-lesson resumes the CURRENT beat, never advances it', () => {
  it('probes never touch beatIndex, and the resume message reflects the beat the student was already on', () => {
    const s = freshBlueprintSession(blueprint)
    s.phase = 'teach'
    s.beatIndex = 1 // pretend the student is already partway through beat 1

    const probe1 = nextUserMessage(s, { kind: 'warmup' })
    expect(s.beatIndex).toBe(1)
    expect(probe1).toContain('Probe prerequisite 1')

    const probe2 = nextUserMessage(s, { kind: 'answer', askId: 'q1', value: 'a symbol' })
    expect(s.beatIndex).toBe(1) // still untouched after a correct probe answer
    expect(probe2).toContain('Probe prerequisite 2')

    const resumed = nextUserMessage(s, { kind: 'answer', askId: 'q2', value: 'multiply by itself' })
    expect(s.beatIndex).toBe(1) // never advanced by the warmup detour
    expect(s.phase).toBe('teach')
    expect(resumed).toContain('Teach beat 1') // resumed exactly where it left off, not beat 0
  })

  it('the attempt-cap path (2 wrong answers) also resumes the current beat without advancing it', () => {
    const s = freshBlueprintSession(blueprint)
    s.beatIndex = 1
    nextUserMessage(s, { kind: 'warmup' })
    nextUserMessage(s, { kind: 'answer', askId: 'q1', value: 'wrong' })
    const msg = nextUserMessage(s, { kind: 'answer', askId: 'q1', value: 'still wrong' }) // 2nd miss -> advances to probe 2
    expect(s.beatIndex).toBe(1)
    expect(msg).toContain('Probe prerequisite 2')
  })
})

describe('nextUserMessage: check hint ladder (2 hints then advance)', () => {
  function checkSession(): Session {
    const s = freshBlueprintSession(blueprint)
    s.phase = 'check'
    s.probeIndex = blueprint.prerequisites.length // probes already completed
    s.asks['chk1'] = { answer: 'U shape' }
    return s
  }

  it('1st wrong answer -> hint, failedChecks=1, stays in check', () => {
    const s = checkSession()
    const msg = nextUserMessage(s, { kind: 'answer', askId: 'chk1', value: 'line' })
    expect(s.failedChecks).toBe(1)
    expect(s.phase).toBe('check')
    expect(msg).toContain('hint 1/2')
  })

  it('2nd wrong answer -> stronger hint, failedChecks=2, stays in check', () => {
    const s = checkSession()
    nextUserMessage(s, { kind: 'answer', askId: 'chk1', value: 'line' })
    const msg = nextUserMessage(s, { kind: 'answer', askId: 'chk1', value: 'line' })
    expect(s.failedChecks).toBe(2)
    expect(s.phase).toBe('check')
    expect(msg).toContain('hint 2/2')
  })

  it('3rd wrong answer -> worked step, resets failedChecks, advances beat', () => {
    const s = checkSession()
    nextUserMessage(s, { kind: 'answer', askId: 'chk1', value: 'line' })
    nextUserMessage(s, { kind: 'answer', askId: 'chk1', value: 'line' })
    const msg = nextUserMessage(s, { kind: 'answer', askId: 'chk1', value: 'line' })
    expect(s.failedChecks).toBe(0)
    expect(s.beatIndex).toBe(1)
    expect(s.phase).toBe('teach')
    expect(msg).toContain('Show the worked step')
    expect(msg).toContain('Teach beat 1')
  })

  it('correct answer (case-insensitive, trimmed) -> advances beat immediately', () => {
    const s = checkSession()
    const msg = nextUserMessage(s, { kind: 'answer', askId: 'chk1', value: '  u SHAPE  ' })
    expect(s.failedChecks).toBe(0)
    expect(s.beatIndex).toBe(1)
    expect(s.phase).toBe('teach')
    expect(msg).toContain('Teach beat 1')
  })

  it('correct answer past the last beat -> phase done', () => {
    const s = freshBlueprintSession(singleBeatBlueprint)
    s.phase = 'check'
    s.asks['chk1'] = { answer: 'yes' }
    const msg = nextUserMessage(s, { kind: 'answer', askId: 'chk1', value: 'Yes' })
    expect(s.phase).toBe('done')
    expect(s.beatIndex).toBe(1)
    expect(msg).toMatch(/complete/i)
  })
})

// ---------------------------------------------------------------------------
// task F-1: `continue` turn kind. Bug it fixes: saying "ok"/"what's next" in
// chat used to route through `chat`, which never advances anything and asks
// the model to "return to the lesson after" -- with nothing to advance, the
// model just re-narrated/re-animated whatever was already on the board.
// `continue` explicitly advances state instead (or, if a check is pending,
// explicitly refuses to advance and says so).
// ---------------------------------------------------------------------------
describe('nextUserMessage: continue', () => {
  it('during a pending check: refuses to advance, message points back at the check, no state change', () => {
    const s = freshBlueprintSession(blueprint)
    s.phase = 'check'
    s.beatIndex = 0
    s.asks['chk1'] = { answer: 'U shape' }
    const msg = nextUserMessage(s, { kind: 'continue' })
    expect(s.phase).toBe('check') // untouched
    expect(s.beatIndex).toBe(0) // untouched
    expect(msg).toContain('What shape is x^2?') // names the pending check
    expect(msg).toMatch(/do not re-render|not re-render/i)
  })

  it('during a pending check with no check text available: still refuses generically, no throw', () => {
    const s = freshBlueprintSession(null)
    s.phase = 'check'
    const msg = nextUserMessage(s, { kind: 'continue' })
    expect(s.phase).toBe('check')
    expect(msg).toMatch(/pending question/i)
  })

  it('not in check phase: advances to the CURRENT beatIndex\'s teach content (composeProgress), never double-skips', () => {
    // Regression guard: beatIndex here is ALREADY positioned at the next
    // untaught beat (as it would be right after advanceAfterTeach's checkless
    // auto-advance -- see the route-level regression test below). `continue`
    // must deliver THIS beat's content, not beatIndex+1's -- a naive
    // `beatIndex++` here would silently skip a beat's teaching entirely.
    const s = freshBlueprintSession(checklessThenCheckedBlueprint)
    s.phase = 'teach'
    s.beatIndex = 1
    const msg = nextUserMessage(s, { kind: 'continue' })
    expect(s.beatIndex).toBe(1) // NOT incremented again
    expect(s.phase).toBe('teach')
    expect(msg).toContain('Teach beat 1')
    expect(msg).toContain('Beat one (checked)')
  })

  it('at the very start of a fresh session (phase plan): behaves like start, teaches beat 0', () => {
    const s = freshBlueprintSession(blueprint)
    const msg = nextUserMessage(s, { kind: 'continue' })
    expect(s.phase).toBe('teach')
    expect(s.beatIndex).toBe(0)
    expect(msg).toContain('Teach beat 0')
  })

  it('past the last beat -> phase done, DONE_MESSAGE', () => {
    const s = freshBlueprintSession(singleBeatBlueprint)
    s.phase = 'teach'
    s.beatIndex = 1 // past the only beat
    const msg = nextUserMessage(s, { kind: 'continue' })
    expect(s.phase).toBe('done')
    expect(msg).toMatch(/complete/i)
  })

  it('freeform session (no blueprint): same fixed teach message as start', () => {
    const s = createSession('projectile motion')
    const msg = nextUserMessage(s, { kind: 'continue' })
    expect(s.phase).toBe('teach')
    expect(msg).toBe('Teach the next idea about projectile motion.')
  })
})

describe('nextUserMessage: chat sets qa for the turn but never mutates phase', () => {
  it('leaves s.phase untouched regardless of current phase', () => {
    const s = freshBlueprintSession(blueprint)
    s.phase = 'teach'
    s.beatIndex = 0
    const msg = nextUserMessage(s, { kind: 'chat', text: 'why is it called a parabola?' })
    expect(s.phase).toBe('teach') // unchanged -- nothing to "restore"
    expect(msg).toContain('why is it called a parabola?')
    expect(msg).toContain('return to the lesson after')
  })
})

describe('nextUserMessage: event formatting', () => {
  const scene: Scene = {
    elements: { a1: { id: 'a1', c: 'area', params: {} } },
    order: ['a1'],
    controls: [],
    focus: null,
    steps: [],
  }

  it('param event', () => {
    const s = freshBlueprintSession(null)
    const ev: BoardEvent = { ev: 'param', id: 'p1', k: 'deg', from: 45, to: 60 }
    expect(nextUserMessage(s, { kind: 'event', event: ev })).toBe('[event] student dragged p1.deg 45→60')
  })

  it('select event resolves the element type from the scene', () => {
    const s = freshBlueprintSession(null)
    s.scene = scene
    const ev: BoardEvent = { ev: 'select', id: 'a1' }
    expect(nextUserMessage(s, { kind: 'event', event: ev })).toBe('[event] student selected area a1')
  })

  it('answer event includes the correctness verdict', () => {
    const s = freshBlueprintSession(null)
    const ev: BoardEvent = { ev: 'answer', askId: 'q1', value: '17', correct: false }
    expect(nextUserMessage(s, { kind: 'event', event: ev })).toBe(
      '[event] student answered ask q1: "17" (incorrect)',
    )
  })

  it('event input never mutates phase', () => {
    const s = freshBlueprintSession(blueprint)
    s.phase = 'teach'
    nextUserMessage(s, { kind: 'event', event: { ev: 'nav', action: 'back', step: 1 } })
    expect(s.phase).toBe('teach')
  })
})

describe('sceneSummary', () => {
  it('empty scene', () => {
    const s = createSession('x')
    expect(sceneSummary(s.scene)).toBe('(empty board)')
  })

  it('one line per element (numbers via formatNum), controls appended', () => {
    const scene: Scene = {
      elements: {
        ax1: { id: 'ax1', c: 'axes', params: { xmin: -5, xmax: 5, ymin: -5, ymax: 5 } },
        p1: { id: 'p1', c: 'plot', params: { on: 'ax1', expr: 'x^2', color: 'blue' } },
      },
      order: ['ax1', 'p1'],
      controls: [{ id: 'p1', k: 'deg', kind: 'slider', min: 0, max: 90, step: 5 }],
      focus: null,
      steps: [],
    }
    const summary = sceneSummary(scene)
    expect(summary).toBe(
      'ax1=axes(xmin=-5,xmax=5,ymin=-5,ymax=5)\np1=plot(on=ax1,expr=x^2,color=blue)\ncontrols: p1.deg(slider 0..90)',
    )
  })
})

describe('advanceAfterTeach', () => {
  it('no-ops for freeform sessions', () => {
    const s = createSession('x')
    s.phase = 'teach'
    advanceAfterTeach(s)
    expect(s.phase).toBe('teach')
    expect(s.beatIndex).toBe(0)
  })

  it('moves to check when the current beat has a check', () => {
    const s = freshBlueprintSession(blueprint)
    s.phase = 'teach'
    s.beatIndex = 0
    advanceAfterTeach(s)
    expect(s.phase).toBe('check')
    expect(s.beatIndex).toBe(0)
  })

  it('auto-advances (no check) and reaches done past the last beat', () => {
    const s = freshBlueprintSession(blueprint)
    s.phase = 'teach'
    s.beatIndex = 1 // beat 1 has no check, and is the last beat
    advanceAfterTeach(s)
    expect(s.beatIndex).toBe(2)
    expect(s.phase).toBe('done')
  })
})

describe('recordTurn: transcript hygiene', () => {
  it('caps transcript at the last 30 messages', () => {
    const s = createSession('x')
    for (let i = 0; i < 20; i++) {
      recordTurn(s, `u${i}`, [{ op: 'say', text: `hi ${i}` }] as Action[])
    }
    expect(s.transcript).toHaveLength(30)
    expect(s.transcript[0]).toEqual({ role: 'user', content: 'u5' })
    const last = s.transcript[29]
    expect(last?.role).toBe('assistant')
    expect(last?.content).toContain('actions: 1')
    expect(last?.content).toContain('hi 19')
  })
})

// ===========================================================================
// Route tests (HTTP + SSE) via app.request()
// ===========================================================================

function fakeClient() {
  return {} as unknown as RouteDeps['client']
}

describe('routes: POST /api/session', () => {
  it('freeform (no blueprintProvider) -> title=topic, no beats/prereqs', async () => {
    // Isolate from the real server/data/blueprints cache: point BLUEPRINT_DIR at
    // a path with no cached blueprint so the default getBlueprint provider misses
    // and the session genuinely degrades to freeform. Without this, a committed
    // flagship blueprint (e.g. projectile-motion.json) would be picked up here.
    const prev = process.env.BLUEPRINT_DIR
    process.env.BLUEPRINT_DIR = '/tmp/board-no-blueprints-does-not-exist'
    try {
      const app = createApp({ client: fakeClient() })
      const res = await app.request('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'projectile motion' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.title).toBe('projectile motion')
      expect(body.beatTitles).toEqual([])
      expect(body.prereqCount).toBe(0)
      expect(sessions.get(body.id)).toBeDefined()
    } finally {
      if (prev === undefined) delete process.env.BLUEPRINT_DIR
      else process.env.BLUEPRINT_DIR = prev
    }
  })

  it('degrades to freeform when blueprintProvider throws', async () => {
    const app = createApp({
      client: fakeClient(),
      blueprintProvider: async () => {
        throw new Error('planner unavailable')
      },
    })
    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'projectile motion' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.title).toBe('projectile motion')
    expect(body.prereqCount).toBe(0)
    expect(sessions.get(body.id)?.blueprint).toBeNull()
  })

  it('wires a provided blueprintProvider', async () => {
    const app = createApp({ client: fakeClient(), blueprintProvider: async () => blueprint })
    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'parabolas' }),
    })
    const body = await res.json()
    expect(body.title).toBe('Parabolas')
    expect(body.beatTitles).toEqual(['Intro to parabolas', 'Vertex'])
    expect(body.prereqCount).toBe(2)
  })
})

describe('routes: POST /api/session/:id/turn', () => {
  it('404s for an unknown session', async () => {
    const app = createApp({ client: fakeClient() })
    const res = await app.request('/api/session/does-not-exist/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'start' }),
    })
    expect(res.status).toBe(404)
  })

  it('happy path: 2 actions streamed -> SSE has phase, 2x action, done', async () => {
    const turnFn: RouteDeps['turnFn'] = async ({ cb }) => {
      cb.onAction({ op: 'say', text: 'one' } as Action)
      cb.onAction({ op: 'say', text: 'two' } as Action)
      return { actions: [{ op: 'say', text: 'one' }, { op: 'say', text: 'two' }] as Action[], scene: emptyScene, usage: { input: 1, output: 1, cacheRead: 0 } }
    }
    const app = createApp({ client: fakeClient(), turnFn })
    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'x' }),
    })
    const { id } = await sessionRes.json()

    const res = await app.request(`/api/session/${id}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'start' }),
    })
    const body = await res.text()
    expect((body.match(/event: action/g) ?? []).length).toBe(2)
    expect((body.match(/event: done/g) ?? []).length).toBe(1)
    expect((body.match(/event: phase/g) ?? []).length).toBe(1)
  })

  // -------------------------------------------------------------------------
  // FINDING #4: a failed attempt that ALREADY streamed actions to the client
  // must NOT be retried — re-streaming a fresh plan would duplicate the shown
  // actions in the client timeline. Instead the partial turn is ACCEPTED with
  // a `warn` ('turn ended early') and completes normally.
  // Assert: (a) the 2 partial actions land and NO fallback say is added, (b)
  // NO retry/escalation (exactly 1 call), (c) a `turn ended early` warn + a
  // `done` (no `error`), and (d) the session stays usable.
  // -------------------------------------------------------------------------
  it('accepts a partial turn (with a warn) instead of retrying when actions were already emitted', async () => {
    let call = 0
    const models: (string | undefined)[] = []
    const turnFn: RouteDeps['turnFn'] = async ({ model, cb }) => {
      call++
      models.push(model)
      cb.onAction({ op: 'say', text: 'partial-one' } as Action)
      cb.onAction({ op: 'say', text: 'partial-two' } as Action)
      throw new BoardTurnError('transient failure', true)
    }
    const app = createApp({ client: fakeClient(), turnFn })

    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'x' }),
    })
    const { id } = await sessionRes.json()

    const res = await app.request(`/api/session/${id}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'start' }),
    })
    const body = await res.text()

    // (a) exactly the 2 partial actions — no fallback `say` appended.
    expect((body.match(/event: action/g) ?? []).length).toBe(2)
    expect(body).toContain('partial-one')
    expect(body).toContain('partial-two')
    expect(body).not.toContain('Sorry — let me regroup')

    // (b) NO retry/escalation: a single attempt, at BOARD_MODEL.
    expect(call).toBe(1)
    expect(models).toEqual([BOARD_MODEL])

    // (c) partial accepted: a `turn ended early` warn + a `done`, no `error`.
    expect((body.match(/event: warn/g) ?? []).length).toBe(1)
    expect(body).toContain('turn ended early')
    expect((body.match(/event: done/g) ?? []).length).toBe(1)
    expect((body.match(/event: error/g) ?? []).length).toBe(0)

    // (d) session stays usable: still registered, and a follow-up turn works.
    const session = sessions.get(id)
    expect(session).toBeDefined()

    const okTurnFn: RouteDeps['turnFn'] = async ({ cb }) => {
      cb.onAction({ op: 'say', text: 'recovered' } as Action)
      return { actions: [{ op: 'say', text: 'recovered' }] as Action[], scene: emptyScene, usage: { input: 1, output: 1, cacheRead: 0 } }
    }
    const app2 = createApp({ client: fakeClient(), turnFn: okTurnFn })
    const res2 = await app2.request(`/api/session/${id}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', text: 'ping' }),
    })
    const body2 = await res2.text()
    expect((body2.match(/event: done/g) ?? []).length).toBe(1)
    expect(body2).toContain('recovered')
  })

  // -------------------------------------------------------------------------
  // FINDING #4 (complement): a retryable failure with ZERO actions emitted is
  // safe to retry — nothing was shown to the client yet — so the full ladder
  // (same-model retry -> escalate to PLANNER_MODEL -> fallback) still runs.
  // -------------------------------------------------------------------------
  it('still retries + escalates + falls back when a retryable failure emitted no actions', async () => {
    let call = 0
    const models: (string | undefined)[] = []
    const turnFn: RouteDeps['turnFn'] = async ({ model }) => {
      call++
      models.push(model)
      throw new BoardTurnError(`failure #${call}`, true) // never emits anything
    }
    const app = createApp({ client: fakeClient(), turnFn })

    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'x' }),
    })
    const { id } = await sessionRes.json()

    const res = await app.request(`/api/session/${id}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'start' }),
    })
    const body = await res.text()

    // initial + one same-model retry + one escalation = 3 calls
    expect(call).toBe(3)
    expect(models[0]).toBe(BOARD_MODEL)
    expect(models[1]).toBe(BOARD_MODEL)
    expect(models[2]).toBe(PLANNER_MODEL)

    // fallback say + error, no done
    expect((body.match(/event: action/g) ?? []).length).toBe(1)
    expect(body).toContain('Sorry — let me regroup')
    expect((body.match(/event: error/g) ?? []).length).toBe(1)
    expect((body.match(/event: done/g) ?? []).length).toBe(0)
  })

  it('escalates once directly (no same-model retry) on a non-retryable error', async () => {
    let call = 0
    const models: (string | undefined)[] = []
    const turnFn: RouteDeps['turnFn'] = async ({ model }) => {
      call++
      models.push(model)
      throw new BoardTurnError('bad request', false)
    }
    const app = createApp({ client: fakeClient(), turnFn })
    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'x' }),
    })
    const { id } = await sessionRes.json()

    const res = await app.request(`/api/session/${id}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'start' }),
    })
    await res.text()

    expect(call).toBe(2) // initial (non-retryable) + one escalation, no same-model retry
    expect(models[0]).toBe(BOARD_MODEL)
    expect(models[1]).toBe(PLANNER_MODEL)
  })

  it('warn: a winning turn with dropped/rewritten actions still emits a warn per reason before done', async () => {
    const turnFn: RouteDeps['turnFn'] = async ({ cb }) => {
      cb.onAction({ op: 'say', text: 'kept' } as Action)
      cb.onError('unknown id: ghost')
      return { actions: [{ op: 'say', text: 'kept' }] as Action[], scene: emptyScene, usage: { input: 1, output: 1, cacheRead: 0 } }
    }
    const app = createApp({ client: fakeClient(), turnFn })
    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'x' }),
    })
    const { id } = await sessionRes.json()

    const res = await app.request(`/api/session/${id}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'start' }),
    })
    const body = await res.text()
    expect((body.match(/event: warn/g) ?? []).length).toBe(1)
    expect(body).toContain('unknown id: ghost')
    expect((body.match(/event: done/g) ?? []).length).toBe(1)
  })

  it('0 valid actions -> one retry with a Correction message appended', async () => {
    let call = 0
    const seenMessages: unknown[] = []
    const turnFn: RouteDeps['turnFn'] = async ({ messages }) => {
      call++
      seenMessages.push(messages)
      if (call === 1) return { actions: [], scene: emptyScene, usage: { input: 1, output: 1, cacheRead: 0 } }
      return { actions: [{ op: 'say', text: 'fixed' }] as Action[], scene: emptyScene, usage: { input: 1, output: 1, cacheRead: 0 } }
    }
    const app = createApp({ client: fakeClient(), turnFn })
    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'x' }),
    })
    const { id } = await sessionRes.json()

    const res = await app.request(`/api/session/${id}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'start' }),
    })
    const body = await res.text()
    expect(call).toBe(2)
    expect((body.match(/event: done/g) ?? []).length).toBe(1)
    const secondCallMessages = seenMessages[1] as Array<{ role: string; content: string }>
    const lastMsg = secondCallMessages[secondCallMessages.length - 1]
    expect(lastMsg).toBeDefined()
    expect(lastMsg?.content).toContain('Correction:')
    expect(lastMsg?.content).toContain('Re-emit valid actions only.')
  })

  // -------------------------------------------------------------------------
  // task-pd: the `wish` op (self-improvement loop) — a `wish` action must be
  // logged to the component-wishes.jsonl file instead of reaching the SSE
  // stream, while every other action in the same turn is unaffected.
  // COMPONENT_WISHES_PATH points at a throwaway temp file so this never
  // touches the real server/data/component-wishes.jsonl.
  // -------------------------------------------------------------------------
  it('wish op: logs to the jsonl file, emits no `action` SSE frame for it, other actions unaffected', async () => {
    const prev = process.env.COMPONENT_WISHES_PATH
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-wishlog-'))
    const wishPath = path.join(tmpDir, 'component-wishes.jsonl')
    process.env.COMPONENT_WISHES_PATH = wishPath
    try {
      const turnFn: RouteDeps['turnFn'] = async ({ cb }) => {
        cb.onAction({ op: 'wish', component: 'field-lines', why: 'electrostatics needs vector field viz' } as Action)
        cb.onAction({ op: 'say', text: 'kept' } as Action)
        return {
          actions: [
            { op: 'wish', component: 'field-lines', why: 'electrostatics needs vector field viz' },
            { op: 'say', text: 'kept' },
          ] as Action[],
          scene: emptyScene,
          usage: { input: 1, output: 1, cacheRead: 0 },
        }
      }
      const app = createApp({ client: fakeClient(), turnFn })
      const sessionRes = await app.request('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'electrostatics' }),
      })
      const { id } = await sessionRes.json()

      const res = await app.request(`/api/session/${id}/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'start' }),
      })
      const body = await res.text()

      // Exactly one `action` SSE frame — the `say`, never the `wish`.
      expect((body.match(/event: action/g) ?? []).length).toBe(1)
      expect(body).toContain('kept')
      expect(body).not.toContain('field-lines')
      expect((body.match(/event: done/g) ?? []).length).toBe(1)

      // The jsonl file was created lazily with exactly one logged wish.
      const lines = fs.readFileSync(wishPath, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      const entry = JSON.parse(lines[0]!)
      expect(entry).toMatchObject({
        topic: 'electrostatics',
        component: 'field-lines',
        why: 'electrostatics needs vector field viz',
      })
      expect(typeof entry.ts).toBe('string')
      expect(Number.isNaN(Date.parse(entry.ts))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.COMPONENT_WISHES_PATH
      else process.env.COMPONENT_WISHES_PATH = prev
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Regression: advanceAfterTeach must gate on teach-delivering input kinds
// (start/answer), never on a leftover phase left behind by event/chat turns.
// ---------------------------------------------------------------------------

function echoingTurnFn(seenMessages: string[]): RouteDeps['turnFn'] {
  return async ({ messages, scene, cb }) => {
    const last = messages[messages.length - 1] as { role: string; content: string }
    seenMessages.push(String(last.content))
    cb.onAction({ op: 'say', text: 'ok' } as Action)
    // Returns the scene unchanged (a say adds nothing) — preserves whatever
    // the route already folded in (e.g. an applied param event).
    return { actions: [{ op: 'say', text: 'ok' }] as Action[], scene, usage: { input: 1, output: 1, cacheRead: 0 } }
  }
}

async function postTurn(app: ReturnType<typeof createApp>, id: string, input: unknown) {
  const res = await app.request(`/api/session/${id}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  // streamSSE resolves the Response as soon as the stream is set up, well
  // before the async callback (and its session mutations / turnFn calls)
  // finishes running. Drain a clone so every await postTurn(...) call site
  // can assert on post-turn state without separately worrying about that.
  await res.clone().text()
  return res
}

describe('advanceAfterTeach gating: beat-skip regression', () => {
  it('an event turn interleaved right after a checkless auto-advance does not skip beat 1\'s teaching', async () => {
    const seenMessages: string[] = []
    const turnFn = echoingTurnFn(seenMessages)
    const app = createApp({ client: fakeClient(), turnFn, blueprintProvider: async () => checklessThenCheckedBlueprint })

    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'two-beats' }),
    })
    const { id } = await sessionRes.json()
    const session = sessions.get(id)!

    // Turn 1 (start): teaches beat 0 (checkless) -> auto-advances to beat 1,
    // phase left at 'teach' awaiting beat 1's actual teach turn.
    await postTurn(app, id, { kind: 'start' })
    expect(seenMessages[0]).toContain('Teach beat 0')
    expect(session.beatIndex).toBe(1)
    expect(session.phase).toBe('teach')

    // Turn 2 (event): student drags a slider mid-lesson. Must NOT be treated
    // as having delivered beat 1's teaching -- phase must stay 'teach'.
    await postTurn(app, id, {
      kind: 'event',
      event: { ev: 'param', id: 'p1', k: 'deg', from: 0, to: 10 },
    })
    expect(session.beatIndex).toBe(1)
    expect(session.phase).toBe('teach') // NOT skipped to 'check' or 'done'

    // Turn 3 (start/continue): composes beat 1's teach message for the first
    // (and only) time, then correctly advances into 'check' afterward.
    await postTurn(app, id, { kind: 'start' })
    expect(session.beatIndex).toBe(1)
    expect(session.phase).toBe('check')

    const teachBeat1Count = seenMessages.filter((m) => m.includes('Teach beat 1')).length
    expect(teachBeat1Count).toBe(1)
    expect(seenMessages[1]).not.toContain('Teach beat 1')
    expect(seenMessages[2]).toContain('Teach beat 1')
  })
})

// ---------------------------------------------------------------------------
// task F-1: `continue` turn kind, route-level. Same beat-skip hazard as
// above, but exercised through `continue` (the turn App.tsx now fires for
// "ok"/"what's next" chat phrases and the player-bar Continue button)
// instead of `start` -- proves `continue` reuses composeProgress's existing
// positioning rather than re-incrementing beatIndex on top of it.
// ---------------------------------------------------------------------------
describe('continue turn (route-level)', () => {
  it('resumes into beat 1 exactly once after a checkless auto-advance, then advances into check on the next continue after answering', async () => {
    const seenMessages: string[] = []
    const turnFn = echoingTurnFn(seenMessages)
    const app = createApp({ client: fakeClient(), turnFn, blueprintProvider: async () => checklessThenCheckedBlueprint })

    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'two-beats' }),
    })
    const { id } = await sessionRes.json()
    const session = sessions.get(id)!

    // Turn 1 (start): teaches beat 0 (checkless) -> auto-advances to beat 1.
    await postTurn(app, id, { kind: 'start' })
    expect(session.beatIndex).toBe(1)
    expect(session.phase).toBe('teach')

    // Turn 2 (continue): must teach beat 1 -- NOT skip straight to done by
    // incrementing beatIndex a second time.
    await postTurn(app, id, { kind: 'continue' })
    expect(seenMessages[1]).toContain('Teach beat 1')
    expect(session.beatIndex).toBe(1)
    expect(session.phase).toBe('check') // beat 1 has a check -> advanceAfterTeach moved to 'check'
  })

  it('a continue turn fired during a pending check does not advance beatIndex or phase', async () => {
    const seenMessages: string[] = []
    const turnFn = echoingTurnFn(seenMessages)
    const app = createApp({ client: fakeClient(), turnFn, blueprintProvider: async () => blueprint })

    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'parabolas' }),
    })
    const { id } = await sessionRes.json()
    const session = sessions.get(id)!

    await postTurn(app, id, { kind: 'start' }) // teaches beat 0 (has a check) -> phase 'check'
    expect(session.phase).toBe('check')
    expect(session.beatIndex).toBe(0)

    await postTurn(app, id, { kind: 'continue' })
    expect(session.phase).toBe('check') // still pending -- continue refused to advance
    expect(session.beatIndex).toBe(0)
    expect(seenMessages[1]).toMatch(/pending question|What shape is x\^2\?/)
  })
})

// ---------------------------------------------------------------------------
// task D-2: `warmup` at the route level. `deliversTeach` (routes.ts) must
// also gate on `input.kind === 'warmup'` -- a warmup turn that resumes
// teaching in the SAME turn (no prerequisites left to probe, e.g. the chip
// was clicked defensively even though prereqCount is 0) still needs
// advanceAfterTeach to run, or the session gets stuck in 'teach' forever
// once the beat's check should have taken over.
// ---------------------------------------------------------------------------
describe('warmup turn (route-level): still triggers advanceAfterTeach when it resumes teaching', () => {
  it('a warmup turn with nothing left to probe resumes teach beat 0 and still advances into check', async () => {
    const seenMessages: string[] = []
    const turnFn = echoingTurnFn(seenMessages)
    const noPrereqBlueprint = { ...blueprint, prerequisites: [] }
    const app = createApp({ client: fakeClient(), turnFn, blueprintProvider: async () => noPrereqBlueprint })

    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'parabolas' }),
    })
    const { id } = await sessionRes.json()
    const session = sessions.get(id)!

    // Nothing to probe (prereqCount 0) -- composeWarmupProgress resumes
    // straight into composeProgress within this SAME turn, so this turn's
    // input.kind is 'warmup' AND its freshly-composed phase is 'teach'.
    // Fired as the FIRST turn: firing warmup while a check is pending is now
    // rejected with 409 by the warmup-during-check guard (tested separately).
    await postTurn(app, id, { kind: 'warmup' })
    expect(seenMessages[0]).toContain('Teach beat 0')
    expect(session.beatIndex).toBe(0)
    expect(session.phase).toBe('check') // advanceAfterTeach fired for the warmup turn too
  })

  it('POST /api/session still reports prereqCount for the client warm-up chip gate', async () => {
    const app = createApp({ client: fakeClient(), blueprintProvider: async () => blueprint })
    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'parabolas' }),
    })
    const body = await res.json()
    expect(body.prereqCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Concurrency guard: per-session turnInFlight lock
// ---------------------------------------------------------------------------

describe('concurrency guard: per-session turnInFlight lock', () => {
  it('a second overlapping turn request gets 409; a third request succeeds once the first resolves', async () => {
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let calls = 0
    const turnFn: RouteDeps['turnFn'] = async ({ cb }) => {
      calls++
      if (calls === 1) await gate
      cb.onAction({ op: 'say', text: `call-${calls}` } as Action)
      return { actions: [{ op: 'say', text: `call-${calls}` }] as Action[], scene: emptyScene, usage: { input: 1, output: 1, cacheRead: 0 } }
    }
    const app = createApp({ client: fakeClient(), turnFn })
    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'x' }),
    })
    const { id } = await sessionRes.json()

    const firstReqPromise = postTurn(app, id, { kind: 'start' })

    // Let the first request's handler run synchronously up through setting
    // turnInFlight=true and blocking inside the gated turnFn.
    await new Promise((r) => setTimeout(r, 0))

    const secondRes = await postTurn(app, id, {
      kind: 'event',
      event: { ev: 'nav', action: 'back', step: 1 },
    })
    expect(secondRes.status).toBe(409)
    const secondBody = await secondRes.json()
    expect(secondBody).toEqual({ error: 'turn in flight' })

    releaseFirst()
    const firstRes = await firstReqPromise
    expect(firstRes.status).toBe(200)
    await firstRes.text() // drain the stream so the finally block has run

    const thirdRes = await postTurn(app, id, { kind: 'chat', text: 'ping' })
    expect(thirdRes.status).toBe(200)
    const thirdBody = await thirdRes.text()
    expect(thirdBody).toContain('call-2')
    expect(calls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Guard: warmup blocked during pending check
// ---------------------------------------------------------------------------

describe('guard: warmup during pending check', () => {
  it('warmup turn during check phase returns 409, session state untouched, subsequent answer still grades check', async () => {
    const seenMessages: string[] = []
    const turnFn = echoingTurnFn(seenMessages)
    const app = createApp({ client: fakeClient(), turnFn, blueprintProvider: async () => singleBeatBlueprint })

    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'single' }),
    })
    const { id } = await sessionRes.json()
    const session = sessions.get(id)!

    // Turn 1 (start): teaches beat 0, moves to check phase
    await postTurn(app, id, { kind: 'start' })
    expect(session.beatIndex).toBe(0)
    expect(session.phase).toBe('check')

    // Manually set up an ask so the answer will be valid
    session.asks['test-ask'] = { answer: 'yes' }

    // Turn 2 (warmup): should return 409 without mutating session
    const warmupRes = await postTurn(app, id, { kind: 'warmup' })
    expect(warmupRes.status).toBe(409)
    const warmupBody = await warmupRes.json()
    expect(warmupBody).toEqual({ error: 'finish the current check first' })
    // Session state unchanged
    expect(session.beatIndex).toBe(0)
    expect(session.phase).toBe('check')

    // Turn 3 (answer): should still process the check correctly with correct answer
    const answerRes = await postTurn(app, id, { kind: 'answer', askId: 'test-ask', value: 'yes' })
    expect(answerRes.status).toBe(200)
    // After answering check correctly: beatIndex advances to 1,
    // which is >= beats.length (1), so phase becomes 'done'
    expect(session.beatIndex).toBe(1)
    expect(session.phase).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// Guard: continue blocked during pending probe
// ---------------------------------------------------------------------------

describe('guard: continue during pending probe', () => {
  it('continue turn during probe phase returns 409, session state untouched, subsequent correct probe answer still grades and advances', async () => {
    const seenMessages: string[] = []
    const turnFn = echoingTurnFn(seenMessages)
    const app = createApp({ client: fakeClient(), turnFn, blueprintProvider: async () => blueprint })

    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'parabolas' }),
    })
    const { id } = await sessionRes.json()
    const session = sessions.get(id)!

    // Turn 1 (warmup): enters the probe sequence -- phase 'probe', probeIndex 0.
    await postTurn(app, id, { kind: 'warmup' })
    expect(session.phase).toBe('probe')
    expect(session.probeIndex).toBe(0)
    expect(session.beatIndex).toBe(0)

    // Turn 2 (continue): should return 409 without mutating session.
    const continueRes = await postTurn(app, id, { kind: 'continue' })
    expect(continueRes.status).toBe(409)
    const continueBody = await continueRes.json()
    expect(continueBody).toEqual({ error: 'finish the warm-up first' })
    // Session state unchanged
    expect(session.probeIndex).toBe(0)
    expect(session.phase).toBe('probe')
    expect(session.beatIndex).toBe(0)

    // Turn 3 (answer): a correct probe answer still grades and advances --
    // the guard above didn't leave the probe machinery wedged.
    const answerRes = await postTurn(app, id, { kind: 'answer', askId: 'probe-ask', value: 'a symbol' })
    expect(answerRes.status).toBe(200)
    expect(session.probeIndex).toBe(1) // advanced past prerequisite q1
    expect(session.phase).toBe('probe') // q2 remains -- still probing
    expect(session.beatIndex).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Chained-flow tests (no impl change expected for these two): exercise
// multi-turn sequences entirely through the public HTTP API.
// ---------------------------------------------------------------------------

describe('chained flow: probe wrong -> remediation -> same probe right -> next probe reached', () => {
  it('carries state correctly across a continuous session, all through the public API', async () => {
    const seenMessages: string[] = []
    const turnFn = echoingTurnFn(seenMessages)
    const app = createApp({ client: fakeClient(), turnFn, blueprintProvider: async () => blueprint })

    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'parabolas' }),
    })
    const { id } = await sessionRes.json()
    const session = sessions.get(id)!

    // task D-2: probing is opt-in via the `warmup` turn kind now -- `start`
    // would go straight to teaching (see the state-machine tests above).
    await postTurn(app, id, { kind: 'warmup' })
    expect(session.phase).toBe('probe')
    expect(session.probeIndex).toBe(0)
    expect(seenMessages[0]).toContain('Probe prerequisite 1')

    // WRONG answer -> remediation, stays on the same probe.
    await postTurn(app, id, { kind: 'answer', askId: 'q1', value: 'a number' })
    expect(session.phase).toBe('probe')
    expect(session.probeIndex).toBe(0)
    expect(seenMessages[1]).toContain('variables represent unknown values')

    // Same probe answered RIGHT -> advances to the next probe.
    await postTurn(app, id, { kind: 'answer', askId: 'q1', value: 'a symbol' })
    expect(session.phase).toBe('probe')
    expect(session.probeIndex).toBe(1)
    expect(seenMessages[2]).toContain('Probe prerequisite 2')
  })
})

describe('chained flow: teach beat N -> chat (qa) turn -> beat progression unaffected', () => {
  it('a qa interleave does not disturb beatIndex/phase progression, all through the public API', async () => {
    const seenMessages: string[] = []
    const turnFn: RouteDeps['turnFn'] = async ({ messages, cb }) => {
      const last = messages[messages.length - 1] as { role: string; content: string }
      seenMessages.push(String(last.content))
      cb.onAction({ op: 'ask', id: 'chkA', kind: 'free', text: 'A check?', answer: 'yes' } as Action)
      return {
        actions: [{ op: 'ask', id: 'chkA', kind: 'free', text: 'A check?', answer: 'yes' }] as Action[],
        scene: emptyScene,
        usage: { input: 1, output: 1, cacheRead: 0 },
      }
    }
    const app = createApp({ client: fakeClient(), turnFn, blueprintProvider: async () => twoCheckedBeatsBlueprint })

    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'x' }),
    })
    const { id } = await sessionRes.json()
    const session = sessions.get(id)!

    // Teach beat 0 -> auto-advances into 'check' (beat 0 has a check).
    await postTurn(app, id, { kind: 'start' })
    expect(seenMessages[0]).toContain('Teach beat 0')
    expect(session.beatIndex).toBe(0)
    expect(session.phase).toBe('check')

    // qa aside -- must not touch beatIndex/phase at all.
    await postTurn(app, id, { kind: 'chat', text: 'why though?' })
    expect(session.beatIndex).toBe(0)
    expect(session.phase).toBe('check')

    // Answer the check correctly -> advances to beat 1, composes Teach beat 1.
    await postTurn(app, id, { kind: 'answer', askId: 'chkA', value: 'yes' })
    expect(seenMessages[2]).toContain('Teach beat 1')
    expect(session.beatIndex).toBe(1)
    expect(session.phase).toBe('check') // beat 1 also has a check -> auto-advanced again
  })
})

// ---------------------------------------------------------------------------
// FINDING #1: session.scene must persist across turns. A turnFn that runs the
// real sanitize -> verify -> apply pipeline (mirroring streamBoardTurn) and
// returns the accumulated scene, so scene-dependent sanitization is exercised
// end-to-end through the route.
// ---------------------------------------------------------------------------

function pipelineTurnFn(scriptFor: (call: number) => unknown[], seenMessages?: string[]): RouteDeps['turnFn'] {
  let call = 0
  return async ({ messages, scene, cb }) => {
    call++
    if (seenMessages) seenMessages.push(String((messages[messages.length - 1] as { content: string }).content))
    const script = scriptFor(call)
    let live = scene
    const actions: Action[] = []
    for (const raw of script) {
      const s = sanitizeAction(raw, live)
      if (!s.ok) {
        cb.onError(s.reason)
        continue
      }
      const { actions: verified, errors } = verifyActions([s.action])
      for (const e of errors) cb.onError(e)
      const a = verified[0]
      if (!a) continue
      live = applyAction(live, a)
      actions.push(a)
      cb.onAction(a)
    }
    return { actions, scene: live, usage: { input: 1, output: 1, cacheRead: 0 } }
  }
}

describe('scene persistence across turns (finding #1)', () => {
  it('a turn-2 set targeting a turn-1 element survives sanitization end-to-end', async () => {
    // k: 'label' (not 'color') — task-19 nit (c) tightened `set k='color'` to
    // require a color-eligible target component; axes isn't one. This test's
    // own concern is scene persistence across turns, not color, so any
    // SET_EXTRA_KEYS member settable on any component works just as well.
    const turnFn = pipelineTurnFn((call) =>
      call === 1
        ? [{ op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 }]
        : [{ op: 'set', id: 'ax1', k: 'label', v: 'red' }],
    )
    const app = createApp({ client: fakeClient(), turnFn })
    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'x' }),
    })
    const { id } = await sessionRes.json()
    const session = sessions.get(id)!

    // Turn 1 adds ax1; the route must persist it into session.scene.
    await postTurn(app, id, { kind: 'start' })
    expect(session.scene.elements.ax1).toBeDefined()

    // Turn 2's set targets ax1 (a turn-1 element). Without scene persistence
    // the turnFn would see emptyScene, sanitize would drop it ("unknown id"),
    // and it would never reach the client.
    const res2 = await app.request(`/api/session/${id}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', text: 'make it red' }),
    })
    const body2 = await res2.text()
    expect(body2).not.toContain('unknown id')
    expect((body2.match(/event: action/g) ?? []).length).toBe(1)
    expect(session.scene.elements.ax1?.params.label).toBe('red')
  })

  it('the turn-2 teach message lists turn-1 board elements in its scene summary', async () => {
    const seenMessages: string[] = []
    const turnFn = pipelineTurnFn(
      (call) =>
        call === 1
          ? [{ op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 }]
          : [{ op: 'say', text: 'continuing' }],
      seenMessages,
    )
    const twoChecklessBeats: Blueprint = {
      title: 'Continuous board',
      prerequisites: [],
      beats: [
        { title: 'Beat zero', goal: 'g0', skeleton: [] as Action[] }, // checkless -> auto-advance
        { title: 'Beat one', goal: 'g1', skeleton: [] as Action[] },
      ],
    }
    const app = createApp({ client: fakeClient(), turnFn, blueprintProvider: async () => twoChecklessBeats })
    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'x' }),
    })
    const { id } = await sessionRes.json()

    await postTurn(app, id, { kind: 'start' }) // teach beat 0, adds ax1, auto-advances to beat 1
    await postTurn(app, id, { kind: 'start' }) // teach beat 1

    expect(seenMessages[1]).toContain('Teach beat 1')
    // Board summary in the beat-1 teach message reflects the turn-1 element.
    expect(seenMessages[1]).toContain('ax1=axes')
  })

  it('a param event folds the student drag into session.scene before the turn runs', async () => {
    const app = createApp({ client: fakeClient(), turnFn: echoingTurnFn([]) })
    const sessionRes = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'x' }),
    })
    const { id } = await sessionRes.json()
    const session = sessions.get(id)!
    session.scene = applyAction(emptyScene, { op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45 } as Action)

    await postTurn(app, id, { kind: 'event', event: { ev: 'param', id: 'p1', k: 'deg', from: 45, to: 60 } })

    expect(session.scene.elements.p1?.params.deg).toBe(60)
  })

  it('applyParamEvent applies a sanitized set and skips silently on an unknown id', () => {
    const s = createSession('x')
    s.scene = applyAction(emptyScene, { op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45 } as Action)
    applyParamEvent(s, { ev: 'param', id: 'p1', k: 'deg', from: 45, to: 60 })
    expect(s.scene.elements.p1?.params.deg).toBe(60)

    applyParamEvent(s, { ev: 'param', id: 'ghost', k: 'deg', from: 0, to: 10 })
    expect(s.scene.elements.ghost).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// FINDING #7: probes must have an attempt cap so a student who can't answer a
// prerequisite doesn't loop on it forever. After 2 wrong tries on the SAME
// probe, deliver the remediation one final time and advance regardless.
// ---------------------------------------------------------------------------

describe('nextUserMessage: probe attempt cap (probe entry re-targeted to warmup)', () => {
  it('two wrong answers on the same probe advance to the next probe with a final remediation', () => {
    const s = freshBlueprintSession(blueprint)
    nextUserMessage(s, { kind: 'warmup' }) // probe 0

    const m1 = nextUserMessage(s, { kind: 'answer', askId: 'q1', value: 'nonsense' })
    expect(s.probeIndex).toBe(0) // 1st miss: stays on the same probe
    expect(s.phase).toBe('probe')
    expect(m1).toContain('variables represent unknown values')

    const m2 = nextUserMessage(s, { kind: 'answer', askId: 'q1', value: 'still nonsense' })
    expect(s.probeIndex).toBe(1) // 2nd miss: advances regardless
    expect(m2).toContain('variables represent unknown values') // remediation one final time
    expect(m2).toContain('Probe prerequisite 2') // ...and moves on to the next probe
  })

  it('the attempt counter resets per probe, so a later probe still gets its own two tries', () => {
    const s = freshBlueprintSession(blueprint)
    nextUserMessage(s, { kind: 'warmup' })
    nextUserMessage(s, { kind: 'answer', askId: 'q1', value: 'a symbol' }) // probe 0 correct -> probe 1
    expect(s.probeIndex).toBe(1)
    expect(s.failedProbes).toBe(0)

    const m1 = nextUserMessage(s, { kind: 'answer', askId: 'q2', value: 'wrong' })
    expect(s.probeIndex).toBe(1) // first miss on probe 1 stays (not immediately advanced)
    expect(s.failedProbes).toBe(1)
    expect(m1).toContain('squaring means x times x')
  })
})
