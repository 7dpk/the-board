// app.test.tsx — smoke tests for App.tsx's session bootstrap wiring
// (TopicPicker -> createSession -> streamTurn('start')) and its topbar.
// `../src/api` is mocked here (api.ts's own createSession/streamTurn/parseSSE
// contract is exercised for real in api.test.ts) so this stays a pure
// component-wiring test: does App call the right functions with the right
// arguments, and does it render the right thing once a session exists.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyScene } from '@board/shared'
import App from '../src/App'
import * as api from '../src/api'
import { useBoard } from '../src/store'

vi.mock('../src/api', () => ({
  createSession: vi.fn(),
  streamTurn: vi.fn(),
  setAccessCode: vi.fn(),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useBoard.setState({
    scene: emptyScene,
    history: [],
    steps: [],
    chat: [],
    ask: null,
    caption: '',
    selection: null,
    activeTurnKind: null,
  })
  vi.mocked(api.createSession).mockReset()
  vi.mocked(api.streamTurn).mockReset()
  vi.mocked(api.setAccessCode).mockReset()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(<App />)
  })
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function findButton(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text)
  if (!btn) throw new Error(`no button with text "${text}"`)
  return btn
}

describe('App', () => {
  it('shows TopicPicker (both lesson cards) when there is no session yet', async () => {
    await render()
    expect(container.textContent).toContain('Quadratic Functions')
    expect(container.textContent).toContain('Projectile Motion')
    expect(container.querySelector('.topbar')).toBeNull()
  })

  it('picking a lesson card calls createSession(topic), then streamTurn(id, {kind:"start"}, handlers)', async () => {
    vi.mocked(api.createSession).mockResolvedValue({
      id: 's1',
      title: 'Quadratics',
      beatTitles: ['intro', 'graphing'],
      prereqCount: 1,
    })
    vi.mocked(api.streamTurn).mockResolvedValue(undefined)

    await render()
    await act(async () => {
      findButton('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
      await flush()
    })

    expect(api.createSession).toHaveBeenCalledWith('Quadratic Functions')
    expect(api.streamTurn).toHaveBeenCalledWith(
      's1',
      { kind: 'start' },
      expect.objectContaining({
        onAction: expect.any(Function),
        onPhase: expect.any(Function),
        onWarn: expect.any(Function),
        onDone: expect.any(Function),
        onError: expect.any(Function),
      }),
    )
  })

  it('after a session is created, shows the topbar with the session title and beat count', async () => {
    vi.mocked(api.createSession).mockResolvedValue({
      id: 's1',
      title: 'Quadratics',
      beatTitles: ['intro', 'graphing'],
      prereqCount: 1,
    })
    vi.mocked(api.streamTurn).mockResolvedValue(undefined)

    await render()
    await act(async () => {
      findButton('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
      await flush()
    })

    const topbar = container.querySelector('.topbar')
    expect(topbar).toBeTruthy()
    expect(topbar?.textContent).toContain('Quadratics')
    expect(topbar?.textContent).toContain('beat 1/2') // beatIndex 0 (default phase state) + 1, of 2 beats
    expect(container.querySelector('.topic-picker')).toBeNull()
  })

  it('a session `warning` is surfaced as a system chat message', async () => {
    vi.mocked(api.createSession).mockResolvedValue({
      id: 's1',
      title: 'freeform',
      beatTitles: [],
      prereqCount: 0,
      warning: 'planner unavailable',
    })
    vi.mocked(api.streamTurn).mockResolvedValue(undefined)

    await render()
    await act(async () => {
      findButton('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
      await flush()
    })

    expect(useBoard.getState().chat.some((m) => m.from === 'system' && m.text.includes('planner unavailable'))).toBe(
      true,
    )
    // freeform (0 beats) -> no beat counter chip
    expect(container.querySelector('.topbar')?.textContent).not.toContain('beat')
  })

  it('typing a custom topic and submitting also creates a session', async () => {
    vi.mocked(api.createSession).mockResolvedValue({ id: 's2', title: 'Trig', beatTitles: [], prereqCount: 0 })
    vi.mocked(api.streamTurn).mockResolvedValue(undefined)

    await render()
    const input = container.querySelector('.topic-custom input') as HTMLInputElement
    await act(async () => {
      input.value = 'Trigonometry'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('.topic-custom')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await flush()
      await flush()
    })

    expect(api.createSession).toHaveBeenCalledWith('Trigonometry')
  })

  it('surfaces a createSession failure as an error message instead of crashing', async () => {
    vi.mocked(api.createSession).mockRejectedValue(new Error('network down'))

    await render()
    await act(async () => {
      findButton('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
      await flush()
    })

    expect(container.querySelector('.app-error')?.textContent).toBe('network down')
    // still on the picker — no session was established
    expect(container.querySelector('.topic-picker')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// activeTurnKind wiring (task P-B item 4: dialogue-only chat). store.ts's
// `commit` gates a `say` action's chat-append on `activeTurnKind` — this is
// the other half: does App.tsx actually set it to 'chat' vs 'other' around
// the right `streamTurn` calls. `../src/api` is fully mocked here (as for
// every other test in this file), so each mock `streamTurn` implementation
// below calls `handlers.onDone()` itself to settle the single-flight queue —
// without it, `inFlight` would stay stuck true and the second (chat) turn
// would never fire at all.
// ---------------------------------------------------------------------------
describe('App activeTurnKind wiring (dialogue-only chat)', () => {
  it("sets activeTurnKind to 'other' for the start turn, and 'chat' for a subsequent chat turn", async () => {
    vi.mocked(api.createSession).mockResolvedValue({
      id: 's1',
      title: 'Quadratics',
      beatTitles: ['intro'],
      prereqCount: 0,
    })
    const capturedKinds: unknown[] = []
    vi.mocked(api.streamTurn).mockImplementation(async (_id, _input, handlers) => {
      capturedKinds.push(useBoard.getState().activeTurnKind)
      handlers.onDone()
    })

    await render()
    await act(async () => {
      findButton('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
      await flush()
    })
    expect(capturedKinds).toEqual(['other']) // the 'start' turn

    const input = container.querySelector('.chat-input-row input') as HTMLInputElement
    await act(async () => {
      input.value = 'why does it open upward?'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('.chat-input-row')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await flush()
      await flush()
    })

    expect(capturedKinds).toEqual(['other', 'chat']) // the follow-up 'chat' turn
  })
})

// ---------------------------------------------------------------------------
// D-2: "Warm-up questions" chip. Story-first start (feedback: "clicking on a
// topic asks me some questions, ideally it should display already created
// story") means probing prerequisites is now opt-in via this chip, gated on
// `session.prereqCount > 0` and hidden once taken. `warmupFiredRef` mirrors
// AskWidget's `submittedRef` double-click guard.
// ---------------------------------------------------------------------------
describe('App: "Warm-up questions" chip (task D-2)', () => {
  it('shown when prereqCount > 0, fires exactly one {kind:"warmup"} turn, then hides itself', async () => {
    vi.mocked(api.createSession).mockResolvedValue({
      id: 's1',
      title: 'Quadratics',
      beatTitles: ['intro'],
      prereqCount: 1,
    })
    vi.mocked(api.streamTurn).mockImplementation(async (_id, _input, handlers) => {
      handlers.onDone() // settle the queue so a same-tick second turn could dispatch if it were ever sent
    })

    await render()
    await act(async () => {
      findButton('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
      await flush()
    })

    const chip = findButton('Warm-up questions')

    await act(async () => {
      // Two rapid clicks on the same tick -- the ref-guard (not React state
      // timing) must stop the second one from firing a second turn.
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
      await flush()
    })

    const warmupCalls = vi
      .mocked(api.streamTurn)
      .mock.calls.filter(([, input]) => (input as { kind: string }).kind === 'warmup')
    expect(warmupCalls).toHaveLength(1)
    expect(() => findButton('Warm-up questions')).toThrow() // hidden once taken
  })

  it('is not shown when prereqCount is 0', async () => {
    vi.mocked(api.createSession).mockResolvedValue({
      id: 's2',
      title: 'Freeform',
      beatTitles: [],
      prereqCount: 0,
    })
    vi.mocked(api.streamTurn).mockResolvedValue(undefined)

    await render()
    await act(async () => {
      findButton('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
      await flush()
    })

    expect(() => findButton('Warm-up questions')).toThrow()
  })

  it('is hidden while ask state is pending (prevents discarding pending check answers)', async () => {
    vi.mocked(api.createSession).mockResolvedValue({
      id: 's1',
      title: 'Quadratics',
      beatTitles: ['intro'],
      prereqCount: 1,
    })
    vi.mocked(api.streamTurn).mockResolvedValue(undefined)

    await render()
    await act(async () => {
      findButton('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
      await flush()
    })

    const chip = findButton('Warm-up questions')
    expect(chip).toBeTruthy()

    // Simulate an ask arriving (e.g., a check question)
    await act(async () => {
      useBoard.setState({
        ask: { id: 'q1', kind: 'mcq', text: 'What is the answer?', options: ['A', 'B'] },
      })
      await flush()
    })

    // Chip should now be hidden
    expect(() => findButton('Warm-up questions')).toThrow()

    // Clear the ask
    await act(async () => {
      useBoard.setState({ ask: null })
      await flush()
    })

    // Chip should be visible again
    expect(findButton('Warm-up questions')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// D-2: sidebar tabs (Chat / Transcript). Chat is the existing panel,
// unchanged; Transcript accumulates every narrated `say` (store.ts's
// `selectTranscript`, a selector over `history` -- not new state) grouped
// under its beat's `step` title.
// ---------------------------------------------------------------------------
describe('App: sidebar tabs (task D-2)', () => {
  async function bootstrap(): Promise<void> {
    vi.mocked(api.createSession).mockResolvedValue({
      id: 's1',
      title: 'Quadratics',
      beatTitles: ['intro'],
      prereqCount: 0,
    })
    vi.mocked(api.streamTurn).mockResolvedValue(undefined)
    await render()
    await act(async () => {
      findButton('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
      await flush()
    })
  }

  it('defaults to Chat, switches to Transcript and back, without both panels mounting at once', async () => {
    await bootstrap()

    expect(container.querySelector('.chat')).toBeTruthy()
    expect(container.querySelector('.transcript-log')).toBeNull()

    await act(async () => {
      findButton('Transcript').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('.transcript-log')).toBeTruthy()
    expect(container.querySelector('.chat')).toBeNull()

    await act(async () => {
      findButton('Chat').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('.chat')).toBeTruthy()
    expect(container.querySelector('.transcript-log')).toBeNull()
  })

  it('Transcript tab renders every narrated say grouped under its step title', async () => {
    await bootstrap()

    act(() => {
      useBoard.getState().commit({ op: 'step', title: 'Intro to parabolas' })
      useBoard.getState().commit({ op: 'say', text: 'a parabola opens upward when a > 0' })
    })

    await act(async () => {
      findButton('Transcript').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const log = container.querySelector('.transcript-log')
    expect(log?.textContent).toContain('Intro to parabolas')
    expect(log?.textContent).toContain('a parabola opens upward when a > 0')
  })
})

// ---------------------------------------------------------------------------
// Reading pace (V-1, caption ghost, feedback: "the text goes too fast, I'm
// unable to finish it and it goes away"): the caption area shows the
// previous say (dimmed, `.caption-ghost`) above the current one.
// ---------------------------------------------------------------------------
describe('App: caption ghost (V-1)', () => {
  async function bootstrap(): Promise<void> {
    vi.mocked(api.createSession).mockResolvedValue({
      id: 's1',
      title: 'Quadratics',
      beatTitles: ['intro'],
      prereqCount: 0,
    })
    vi.mocked(api.streamTurn).mockResolvedValue(undefined)
    await render()
    await act(async () => {
      findButton('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
      await flush()
    })
  }

  it('shows no ghost line before any previous caption exists', async () => {
    await bootstrap()
    act(() => {
      useBoard.setState({ caption: 'first line', captionPrev: '' })
    })
    expect(container.querySelector('.caption-ghost')).toBeNull()
    expect(container.querySelector('.caption')?.textContent).toContain('first line')
  })

  it('renders captionPrev dimmed above the current caption once a previous say exists', async () => {
    await bootstrap()
    act(() => {
      useBoard.setState({ caption: 'the new line', captionPrev: 'the old line' })
    })
    const ghost = container.querySelector('.caption-ghost')
    expect(ghost?.textContent).toBe('the old line')
    expect(container.querySelector('.caption')?.textContent).toContain('the new line')
  })
})

// ---------------------------------------------------------------------------
// Access gate (server/src/accessGate.ts's BOARD_ACCESS_CODE): when
// createSession's first call comes back 401 {error:'access code required'},
// App shows a minimal code prompt instead of the generic error banner, then
// retries createSession with the same topic once a code is submitted.
// ---------------------------------------------------------------------------
describe('App: access gate (BOARD_ACCESS_CODE)', () => {
  it('shows the code prompt on a 401 access-code-required error, then retries createSession after submitting a code', async () => {
    vi.mocked(api.createSession)
      .mockRejectedValueOnce(new Error('access code required'))
      .mockResolvedValueOnce({ id: 's1', title: 'Quadratics', beatTitles: ['intro'], prereqCount: 0 })
    vi.mocked(api.streamTurn).mockResolvedValue(undefined)

    await render()
    await act(async () => {
      findButton('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
      await flush()
    })

    const gate = container.querySelector('.access-gate')
    expect(gate).toBeTruthy()
    expect(container.querySelector('.app-error')).toBeNull() // gated, not a generic error
    expect(container.querySelector('.topic-picker')).toBeNull() // picker swapped out for the gate

    const input = gate!.querySelector('input') as HTMLInputElement
    await act(async () => {
      input.value = 'abcd1234'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      gate!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await flush()
      await flush()
    })

    expect(api.setAccessCode).toHaveBeenCalledWith('abcd1234')
    expect(api.createSession).toHaveBeenCalledTimes(2)
    expect(api.createSession).toHaveBeenNthCalledWith(2, 'Quadratic Functions') // same topic, retried
    expect(container.querySelector('.access-gate')).toBeNull()
    expect(container.querySelector('.topbar')?.textContent).toContain('Quadratics')
  })

  it('a non-gate createSession error still shows the generic app-error banner, not the gate', async () => {
    vi.mocked(api.createSession).mockRejectedValue(new Error('network down'))

    await render()
    await act(async () => {
      findButton('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
      await flush()
    })

    expect(container.querySelector('.access-gate')).toBeNull()
    expect(container.querySelector('.app-error')?.textContent).toBe('network down')
  })
})
