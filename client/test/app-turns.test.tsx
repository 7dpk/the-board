// app-turns.test.tsx — fix round 1 regression coverage for two review
// findings in App.tsx's turn plumbing:
//
//   1. ask-answer double-turn: events.ts's sink also carries `ev:'answer'`
//      (for local grading bookkeeping) alongside the real
//      `{kind:'answer', askId, value}` turn App.tsx sends from
//      AskWidget's `onAnswer`. Before the fix, App.tsx's sink handler
//      forwarded *every* sink event (including `ev:'answer'`) as its own
//      `{kind:'event', event}` turn — so one answer submission fired TWO
//      server turns. Fixed by filtering `ev === 'answer'` out of the sink
//      handler; param/select/nav events still pass through.
//
//   2. silent turn eviction: the single-flight queue used to be "latest
//      queued turn wins", which could silently drop an already-queued
//      `chat`/`answer` turn if any other turn (in particular a param-drag
//      `event`) arrived behind it. Fixed by making the queue a FIFO array
//      where only `event`-kind turns coalesce (a new `event` replaces an
//      already-queued `event`, in place); `chat`/`answer`/`start` always
//      append and are never dropped.
//
// Unlike app.test.tsx (which mocks `../src/api` wholesale), these tests mock
// `global.fetch` directly and let the real `api.ts`/`events.ts` wiring run,
// so the turn queue's actual network behavior — call counts, order, and
// bodies — is what's under test. `../src/events` is partially mocked only
// to capture the exact sink function App.tsx registers (so event-turn
// bursts can be injected directly, independent of emitParamEvent's own
// 400ms debounce, which is events.test.ts's concern, not this file's).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type BoardEvent, emptyScene } from '@board/shared'
import App from '../src/App'
import type { TurnInput } from '../src/api'
import { useBoard } from '../src/store'

let capturedSink: ((e: BoardEvent) => void) | null = null

vi.mock('../src/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/events')>()
  return {
    ...actual,
    setEventSink: (fn: (e: BoardEvent) => void) => {
      capturedSink = fn
      actual.setEventSink(fn) // keep the real module wired so submitAskAnswer/emitParamEvent behave normally
    },
  }
})

// ---------------------------------------------------------------------------
// fetch mocking — mirrors client/test/api.test.ts's real-Response approach,
// but turn requests resolve to a controlled Response (via a captured
// resolver) rather than immediately, so tests can hold a turn "in flight" to
// exercise the queue.
// ---------------------------------------------------------------------------
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function doneResponse(): Response {
  const bytes = new TextEncoder().encode(sseFrame('done', { usage: {} }))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const SESSION = { id: 's1', title: 'Quadratics', beatTitles: ['intro', 'graphing'], prereqCount: 1 }

let sentTurns: TurnInput[]
let pendingResolvers: Array<(r: Response) => void>
let fetchMock: ReturnType<typeof vi.fn>

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  capturedSink = null
  sentTurns = []
  pendingResolvers = []
  fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    if (url === '/api/session') return Promise.resolve(jsonResponse(SESSION))
    if (url === `/api/session/${SESSION.id}/turn`) {
      sentTurns.push(JSON.parse(String(init?.body)) as TurnInput)
      return new Promise<Response>((resolve) => {
        pendingResolvers.push(resolve)
      })
    }
    throw new Error(`unexpected fetch url: ${String(url)}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  useBoard.setState({
    scene: emptyScene,
    history: [],
    steps: [],
    chat: [],
    ask: null,
    caption: '',
    selection: null,
  })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.unstubAllGlobals()
})

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function findButton(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text)
  if (!btn) throw new Error(`no button with text "${text}"`)
  return btn
}

// Renders App, picks the "Quadratic Functions" lesson card, and waits for
// createSession + the resulting {kind:'start'} turn to reach fetch (still
// unresolved — it stays "in flight" until a test explicitly resolves it).
async function bootstrapSession(): Promise<void> {
  await act(async () => {
    root.render(<App />)
  })
  await act(async () => {
    findButton('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    await flush()
  })
}

// Resolves the oldest still-pending turn request with a bare `done` SSE
// frame, letting the queue's `settle()` fire whatever turn was queued next.
async function resolveNextTurn(): Promise<void> {
  const resolve = pendingResolvers.shift()
  if (!resolve) throw new Error('resolveNextTurn: no pending turn request to resolve')
  await act(async () => {
    resolve(doneResponse())
    await flush()
    await flush()
  })
}

function setAsk(ask: { id: string; kind: 'mcq'; text: string; options: string[]; answer: string }): void {
  act(() => {
    useBoard.setState({ ask })
  })
}

function clickAskOption(text: string): void {
  const btn = Array.from(container.querySelectorAll('.ask-options button')).find((b) => b.textContent === text)
  if (!btn) throw new Error(`no ask option button "${text}"`)
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function submitChat(text: string): Promise<void> {
  const input = container.querySelector('.chat-input-row input') as HTMLInputElement
  await act(async () => {
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    container.querySelector('.chat-input-row')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

// ---------------------------------------------------------------------------
// Finding 1: ask-answer double-turn
// ---------------------------------------------------------------------------
describe('ask-answer turn (fix: no more spurious event-kind turn)', () => {
  it('submitting an ask answer results in exactly ONE network turn, of kind "answer"', async () => {
    await bootstrapSession()
    expect(sentTurns).toEqual([{ kind: 'start' }])
    await resolveNextTurn() // let the 'start' turn settle so the queue is empty and idle

    setAsk({ id: 'q1', kind: 'mcq', text: 'x or y?', options: ['x', 'y'], answer: 'y' })
    clickAskOption('y')
    await act(async () => {
      await flush()
    })

    const turnCalls = fetchMock.mock.calls.filter(([url]) => url === `/api/session/${SESSION.id}/turn`)
    expect(turnCalls).toHaveLength(2) // 'start' + exactly one 'answer' — no extra event-kind turn
    expect(sentTurns).toEqual([{ kind: 'start' }, { kind: 'answer', askId: 'q1', value: 'y' }])
  })
})

// ---------------------------------------------------------------------------
// Finding 2: FIFO queue, event-only coalescing
// ---------------------------------------------------------------------------
describe('turn queue (fix: FIFO with event-only coalescing)', () => {
  it('a queued answer turn survives a subsequent burst of param-event turns', async () => {
    await bootstrapSession()
    expect(sentTurns).toEqual([{ kind: 'start' }]) // 'start' is in flight, unresolved

    setAsk({ id: 'q1', kind: 'mcq', text: 'x or y?', options: ['x', 'y'], answer: 'y' })
    clickAskOption('y') // queues the answer turn behind the in-flight 'start'
    expect(sentTurns).toEqual([{ kind: 'start' }]) // not yet dispatched — still queued

    expect(capturedSink).not.toBeNull()
    act(() => {
      capturedSink!({ ev: 'param', id: 'p1', k: 'x', from: 0, to: 1 })
      capturedSink!({ ev: 'param', id: 'p1', k: 'x', from: 1, to: 2 })
      capturedSink!({ ev: 'param', id: 'p1', k: 'x', from: 2, to: 3 }) // only this one should ever reach the server
    })
    expect(sentTurns).toEqual([{ kind: 'start' }]) // burst only touched the queue, nothing dispatched yet

    await resolveNextTurn() // settle 'start' -> the queued answer turn fires next (FIFO), not evicted
    expect(sentTurns).toEqual([{ kind: 'start' }, { kind: 'answer', askId: 'q1', value: 'y' }])

    await resolveNextTurn() // settle 'answer' -> the coalesced (latest) event turn fires
    expect(sentTurns).toEqual([
      { kind: 'start' },
      { kind: 'answer', askId: 'q1', value: 'y' },
      { kind: 'event', event: { ev: 'param', id: 'p1', k: 'x', from: 2, to: 3 } },
    ])
  })

  it('two rapid chats both reach the server in order, neither dropped', async () => {
    await bootstrapSession()
    expect(sentTurns).toEqual([{ kind: 'start' }]) // 'start' is in flight, unresolved

    await submitChat('question one') // queues behind 'start'
    await submitChat('question two') // queues behind 'question one' — appended, not coalesced
    expect(sentTurns).toEqual([{ kind: 'start' }]) // neither chat dispatched yet

    await resolveNextTurn() // settle 'start' -> chat 1 fires
    expect(sentTurns).toEqual([{ kind: 'start' }, { kind: 'chat', text: 'question one' }])

    await resolveNextTurn() // settle chat 1 -> chat 2 fires
    expect(sentTurns).toEqual([
      { kind: 'start' },
      { kind: 'chat', text: 'question one' },
      { kind: 'chat', text: 'question two' },
    ])
  })

  it('event coalescing still works: only the latest of several queued events reaches the server', async () => {
    await bootstrapSession()
    expect(sentTurns).toEqual([{ kind: 'start' }])

    expect(capturedSink).not.toBeNull()
    act(() => {
      capturedSink!({ ev: 'select', id: 'p1' })
      capturedSink!({ ev: 'select', id: 'p2' })
      capturedSink!({ ev: 'select', id: 'p3' }) // latest wins
    })
    expect(sentTurns).toEqual([{ kind: 'start' }]) // still just queued, nothing dispatched

    await resolveNextTurn() // settle 'start' -> the coalesced event turn fires
    expect(sentTurns).toEqual([{ kind: 'start' }, { kind: 'event', event: { ev: 'select', id: 'p3' } }])
  })
})

// ---------------------------------------------------------------------------
// Finding #3: a network-level fetch rejection must still settle the queue.
// Before the api.ts fix, the rejection escaped App's `void streamTurn(...)`,
// settle() never ran, and inFlight stuck true forever -> every later turn was
// silently queued and never dispatched.
// ---------------------------------------------------------------------------
describe('turn queue survives a network-level fetch rejection (fix #3)', () => {
  it('a rejected turn settles the queue so a subsequent turn still dispatches', async () => {
    let turnCall = 0
    fetchMock.mockImplementation((url: string | URL | Request, init?: RequestInit) => {
      if (url === '/api/session') return Promise.resolve(jsonResponse(SESSION))
      if (url === `/api/session/${SESSION.id}/turn`) {
        sentTurns.push(JSON.parse(String(init?.body)) as TurnInput)
        turnCall++
        if (turnCall === 1) return Promise.reject(new TypeError('network down'))
        return Promise.resolve(doneResponse())
      }
      throw new Error(`unexpected fetch url: ${String(url)}`)
    })

    await bootstrapSession() // 'start' turn dispatched -> fetch rejects -> onError -> settle
    await act(async () => {
      await flush()
      await flush()
    })
    expect(sentTurns).toEqual([{ kind: 'start' }])

    // A follow-up chat must dispatch — the in-flight lock was released by the
    // failed turn's settle(). With the pre-fix deadlock it would never fire.
    await submitChat('after the failure')
    await act(async () => {
      await flush()
    })

    expect(sentTurns).toEqual([{ kind: 'start' }, { kind: 'chat', text: 'after the failure' }])
  })
})

// ---------------------------------------------------------------------------
// task F-1 (screenshot bug: "ok"/"what's next" repeated the same animation
// instead of advancing). Trivial continue-intent chat phrases must map to a
// `{kind:'continue'}` turn instead of `{kind:'chat'}` -- the student's typed
// message still lands in the chat panel either way (ChatPanel.tsx appends it
// locally regardless of what turn kind App.tsx dispatches).
// ---------------------------------------------------------------------------
describe('chat phrase mapping: trivial continue-intent messages fire {kind:continue} (task F-1)', () => {
  const phrases = ['ok', 'Ok', 'okay', 'OKAY', 'next', 'continue', 'go on', "what's next", 'whats next', 'proceed', 'sure', 'ok.', 'ok!', 'sure  ', '  next ', "what's next?", 'ok?', 'Next!?']

  for (const phrase of phrases) {
    it(`"${phrase}" fires {kind:'continue'}, not {kind:'chat'}`, async () => {
      await bootstrapSession()
      await resolveNextTurn() // settle 'start' so chat isn't stuck queued behind it

      await submitChat(phrase)
      expect(sentTurns.at(-1)).toEqual({ kind: 'continue' })

      // The student's own message still appears in the chat log (ChatPanel
      // trims the draft before displaying/sending it, hence `.trim()` here).
      expect(useBoard.getState().chat).toEqual(
        expect.arrayContaining([{ from: 'student', text: phrase.trim() }]),
      )
    })
  }

  it('a phrase with substantive content beyond the bare word still reaches the model as real chat (strict-anchored, negative case)', async () => {
    await bootstrapSession()
    await resolveNextTurn()

    await submitChat('ok but why is the sun at the focus')
    expect(sentTurns.at(-1)).toEqual({ kind: 'chat', text: 'ok but why is the sun at the focus' })
  })

  it('"ok but why?" has substantive content beyond the bare word and still reaches the model as real chat', async () => {
    await bootstrapSession()
    await resolveNextTurn()

    await submitChat('ok but why?')
    expect(sentTurns.at(-1)).toEqual({ kind: 'chat', text: 'ok but why?' })
  })

  it('an ordinary question is unaffected and still fires {kind:chat}', async () => {
    await bootstrapSession()
    await resolveNextTurn()

    await submitChat('why is the sky blue?')
    expect(sentTurns.at(-1)).toEqual({ kind: 'chat', text: 'why is the sky blue?' })
  })
})

// ---------------------------------------------------------------------------
// task-pe (P-B fold-in): a failed `chat`-kind turn used to only surface via
// the topbar's error chip — easy to miss, since the student's own question
// just sits in the transcript with no reply. It should also land as a
// system-styled message in the chat transcript itself, in addition to (not
// instead of) the banner. A failed non-chat turn (e.g. `start`) must NOT
// gain a spurious chat message — there's no student question for it to
// "reply" to.
// ---------------------------------------------------------------------------
describe('chat-turn errors also appear in the transcript (P-B fold-in)', () => {
  it('appends a system chat message when a chat-kind turn errors, in addition to the banner', async () => {
    let turnCall = 0
    fetchMock.mockImplementation((url: string | URL | Request, init?: RequestInit) => {
      if (url === '/api/session') return Promise.resolve(jsonResponse(SESSION))
      if (url === `/api/session/${SESSION.id}/turn`) {
        sentTurns.push(JSON.parse(String(init?.body)) as TurnInput)
        turnCall++
        if (turnCall === 2) return Promise.reject(new TypeError('network down')) // the chat turn fails
        return Promise.resolve(doneResponse())
      }
      throw new Error(`unexpected fetch url: ${String(url)}`)
    })

    await bootstrapSession()
    await act(async () => {
      await flush()
      await flush()
    }) // settle 'start' (a bare doneResponse from the shared mock above)

    await submitChat('will this work?')
    await act(async () => {
      await flush()
      await flush()
    })

    expect(sentTurns).toEqual([{ kind: 'start' }, { kind: 'chat', text: 'will this work?' }])
    expect(useBoard.getState().chat).toEqual(
      expect.arrayContaining([{ from: 'error', text: "Couldn't reach the tutor — try again." }]),
    )
    // The banner (App.tsx's own `error` state) still fires too — this is IN
    // ADDITION to it, not a replacement.
    expect(container.querySelector('.chip-error')).toBeTruthy()
  })

  it('does not append a spurious chat message when a non-chat turn errors', async () => {
    fetchMock.mockImplementation((url: string | URL | Request) => {
      if (url === '/api/session') return Promise.resolve(jsonResponse(SESSION))
      if (url === `/api/session/${SESSION.id}/turn`) return Promise.reject(new TypeError('network down'))
      throw new Error(`unexpected fetch url: ${String(url)}`)
    })

    await bootstrapSession() // the 'start' turn itself fails
    await act(async () => {
      await flush()
      await flush()
    })

    expect(useBoard.getState().chat).toEqual([])
    expect(container.querySelector('.chip-error')).toBeTruthy()
  })
})
