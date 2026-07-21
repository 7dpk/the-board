// player-bar.test.tsx — PlayerBar's transport controls: pause/play toggle,
// step nav (◀/▶/⟲) driving store.jumpToStep, and boundary disabling.
//
// The speed <select>'s onChange isn't exercised here via a simulated
// interaction (documented gap, see task-15 report): this codebase's
// established jsdom quirk (see events.test.ts/ControlStrip's `onInput` fix,
// T14) is specific to controlled inputs/textareas whose value is set via a
// raw DOM property assignment before a synthetic event dispatch; reproducing
// an equivalent reliable harness for <select> wasn't worth the time here.
// The initial-value render (reflecting store.speed) is still asserted.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Action, applyAction, emptyScene } from '@board/shared'
import PlayerBar from '../src/player/PlayerBar'
import { useBoard } from '../src/store'
import { BrowserTts, setTtsProvider, type TtsProvider } from '../src/tts'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useBoard.setState({
    scene: emptyScene,
    history: [],
    steps: [],
    chat: [],
    ask: null,
    playing: true,
    speed: 1,
    turnInFlight: false,
    framesMode: false,
    voiceOn: false,
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
  setTtsProvider(new BrowserTts()) // restore the real (jsdom: unavailable) provider
})

async function renderBar(onContinue: () => void = vi.fn()): Promise<void> {
  await act(async () => {
    root.render(<PlayerBar onContinue={onContinue} />)
  })
}

function seedSteps(): void {
  const actions: Action[] = [
    { op: 'step', title: 'a' },
    { op: 'step', title: 'b' },
    { op: 'step', title: 'c' },
  ]
  for (const a of actions) useBoard.getState().commit(a)
}

function button(label: string): HTMLButtonElement {
  const el = container.querySelector(`button[aria-label="${label}"]`)
  if (!el) throw new Error(`no button aria-label="${label}"`)
  return el as HTMLButtonElement
}

async function click(el: HTMLButtonElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('PlayerBar', () => {
  it('renders pause when playing, and clicking it pauses the store', async () => {
    await renderBar()
    expect(button('pause').textContent).toBe('⏸')
    await click(button('pause'))
    expect(useBoard.getState().playing).toBe(false)
  })

  it('renders play when paused, and clicking it resumes the store', async () => {
    useBoard.setState({ playing: false })
    await renderBar()
    expect(button('play').textContent).toBe('▶')
    await click(button('play'))
    expect(useBoard.getState().playing).toBe(true)
  })

  it('with no steps yet, replay/prev/next are all disabled', async () => {
    await renderBar()
    expect(button('replay current step').disabled).toBe(true)
    expect(button('previous step').disabled).toBe(true)
    expect(button('next step').disabled).toBe(true)
  })

  it('follows the latest step: next is disabled at the end, previous enabled once past the first', async () => {
    seedSteps()
    await renderBar()
    expect(button('next step').disabled).toBe(true) // already at the latest (index 2 of 0..2)
    expect(button('previous step').disabled).toBe(false)
    expect(button('replay current step').disabled).toBe(false)
  })

  it('clicking previous calls jumpToStep with the prior index and rebuilds the scene accordingly', async () => {
    seedSteps()
    await renderBar()

    await click(button('previous step')) // index 2 -> 1

    const { steps, history } = useBoard.getState()
    const expected = history.slice(0, steps[1]!.startIndex).reduce(applyAction, emptyScene)
    expect(useBoard.getState().scene).toEqual(expected)
  })

  it('previous is disabled once nav reaches the first step', async () => {
    seedSteps()
    await renderBar()

    await click(button('previous step')) // -> index 1
    await click(button('previous step')) // -> index 0
    expect(button('previous step').disabled).toBe(true)
    expect(button('next step').disabled).toBe(false)
  })

  it('renders the current store speed as the selected option', async () => {
    useBoard.setState({ speed: 1.5 })
    await renderBar()
    const select = container.querySelector('select[aria-label="playback speed"]') as HTMLSelectElement
    expect(select.value).toBe('1.5')
  })
})

// ---------------------------------------------------------------------------
// task F-1: Continue button. Fires `onContinue` (App.tsx wires this to a
// `{kind:'continue'}` turn) exactly once per click, guarded the same way
// AskWidget/the warm-up chip guard against a double-dispatch landing before
// React has re-rendered.
// ---------------------------------------------------------------------------
describe('PlayerBar Continue button (task F-1)', () => {
  it('renders a Continue button that fires onContinue on click', async () => {
    const onContinue = vi.fn()
    await renderBar(onContinue)
    await click(button('continue'))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('two rapid clicks (both dispatched before a re-render) fire onContinue exactly once', async () => {
    const onContinue = vi.fn()
    await renderBar(onContinue)
    const btn = button('continue')
    await act(async () => {
      // Two dispatches back-to-back, synchronously, with no intervening
      // render -- same double-click hazard AskWidget's submittedRef guards.
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('re-arms once turnInFlight flips back to false, so the next beat\'s click still fires', async () => {
    const onContinue = vi.fn()
    await renderBar(onContinue)
    await click(button('continue'))
    expect(onContinue).toHaveBeenCalledTimes(1)

    // Turn settles.
    await act(async () => {
      useBoard.setState({ turnInFlight: true })
    })
    await act(async () => {
      useBoard.setState({ turnInFlight: false })
    })

    await click(button('continue'))
    expect(onContinue).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Frames mode toggle (V-1, feedback: "instead of animation, we could use
// multiple pictures on bottom of each other... if animation is getting
// complicated").
// ---------------------------------------------------------------------------
describe('PlayerBar frames-mode toggle (V-1)', () => {
  it('reflects the store\'s framesMode as aria-pressed, off by default', async () => {
    await renderBar()
    expect(button('toggle frames mode').getAttribute('aria-pressed')).toBe('false')
  })

  it('clicking it flips the store\'s framesMode', async () => {
    await renderBar()
    await click(button('toggle frames mode'))
    expect(useBoard.getState().framesMode).toBe(true)
    expect(button('toggle frames mode').getAttribute('aria-pressed')).toBe('true')

    await click(button('toggle frames mode'))
    expect(useBoard.getState().framesMode).toBe(false)
  })

  it('persists the toggle to localStorage', async () => {
    await renderBar()
    await click(button('toggle frames mode'))
    expect(localStorage.getItem('board.framesMode')).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// Voice narration toggle (V-1, feedback: "can we use text to voice... to
// make it more interactive?"). jsdom has no speechSynthesis support, so the
// real BrowserTts is naturally unavailable — the "available" case is
// exercised with a fake provider.
// ---------------------------------------------------------------------------
describe('PlayerBar voice toggle (V-1)', () => {
  it('is disabled when the ttsProvider reports unavailable (real jsdom BrowserTts)', async () => {
    setTtsProvider(new BrowserTts())
    await renderBar()
    const btn = button('toggle voice narration')
    expect(btn.disabled).toBe(true)
    expect(btn.title).toMatch(/not supported/i)
  })

  it('is enabled and toggles the store when the provider is available', async () => {
    const fake: TtsProvider = {
      available: () => true,
      speak: () => Promise.resolve(),
      cancel: () => {},
      pause: () => {},
      resume: () => {},
    }
    setTtsProvider(fake)
    await renderBar()
    const btn = button('toggle voice narration')
    expect(btn.disabled).toBe(false)

    await click(btn)
    expect(useBoard.getState().voiceOn).toBe(true)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
  })
})
