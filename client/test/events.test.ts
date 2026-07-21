// events.test.ts — T14: debounced param events, ControlStrip wiring, ask-answer flow.
//
// Three concerns, one file (mirrors the brief's single declared test file):
//   1. emitParamEvent's 400ms-per-(id,k) debounce contract (first `from`,
//      last `to`, independent per pair).
//   2. ControlStrip (slider + number input) driving setOverride live and
//      commit+emitParamEvent on interaction end.
//   3. submitAskAnswer's correctness check + store unblock handshake.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Action, applyAction, emptyScene } from '@board/shared'
import { emitParamEvent, setEventSink, submitAskAnswer } from '../src/events'
import { onParamDrag } from '../src/board/params'
import { useBoard } from '../src/store'
import ControlStrip from '../src/controls/ControlStrip'

function seedScene(actions: Action[]): void {
  const scene = actions.reduce(applyAction, emptyScene)
  useBoard.setState({ scene, liveOverrides: {}, ask: null, history: [] })
}

// ---------------------------------------------------------------------------
// Shared harness for the whole file: fake timers (every group here either
// exercises the 400ms debounce directly or transitively via ControlStrip),
// a mount point for the react-dom/client render harness (same pattern as
// math-render.test.tsx — no @testing-library/react in this workspace), and
// a reset event sink so no test leaks a mock into the next one.
// ---------------------------------------------------------------------------
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  setEventSink(() => {})
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.runOnlyPendingTimers() // flush any leftover burst so it can't leak into the next test
  vi.useRealTimers()
})

async function renderStrip(): Promise<void> {
  await act(async () => {
    root.render(createElement(ControlStrip))
  })
}

// ---------------------------------------------------------------------------
// emitParamEvent debounce
// ---------------------------------------------------------------------------
describe('emitParamEvent', () => {
  it('collapses a rapid burst on the same (id,k) into one sink call with the first `from` and last `to`', () => {
    const sink = vi.fn()
    setEventSink(sink)

    emitParamEvent('p1', 'x', 1, 2)
    vi.advanceTimersByTime(100)
    emitParamEvent('p1', 'x', 2, 3)
    vi.advanceTimersByTime(100)
    emitParamEvent('p1', 'x', 3, 5)

    expect(sink).not.toHaveBeenCalled() // still inside the 400ms silence window

    vi.advanceTimersByTime(400)

    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith({ ev: 'param', id: 'p1', k: 'x', from: 1, to: 5 })
  })

  it('does not flush before 400ms of silence on the pair', () => {
    const sink = vi.fn()
    setEventSink(sink)

    emitParamEvent('p1', 'x', 1, 2)
    vi.advanceTimersByTime(399)

    expect(sink).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('debounces independently per (id,k) pair', () => {
    const sink = vi.fn()
    setEventSink(sink)

    emitParamEvent('p1', 'x', 0, 1)
    emitParamEvent('p1', 'y', 0, 9)
    vi.advanceTimersByTime(400)

    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink).toHaveBeenCalledWith({ ev: 'param', id: 'p1', k: 'x', from: 0, to: 1 })
    expect(sink).toHaveBeenCalledWith({ ev: 'param', id: 'p1', k: 'y', from: 0, to: 9 })
  })

  it('starts a fresh first-`from` for a new burst after a previous one flushed', () => {
    const sink = vi.fn()
    setEventSink(sink)

    emitParamEvent('p2', 'x', 0, 1)
    vi.advanceTimersByTime(400)
    expect(sink).toHaveBeenCalledTimes(1)

    emitParamEvent('p2', 'x', 1, 10)
    vi.advanceTimersByTime(400)

    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink).toHaveBeenLastCalledWith({ ev: 'param', id: 'p2', k: 'x', from: 1, to: 10 })
  })

  it('wires emitParamEvent as the module-level drag handler at import time (setParamDragHandler)', () => {
    const sink = vi.fn()
    setEventSink(sink)

    onParamDrag?.('p3', 'x', 0, 1)
    vi.advanceTimersByTime(400)

    expect(sink).toHaveBeenCalledWith({ ev: 'param', id: 'p3', k: 'x', from: 0, to: 1 })
  })
})

// ---------------------------------------------------------------------------
// ControlStrip / slider
// ---------------------------------------------------------------------------
describe('ControlStrip / slider', () => {
  beforeEach(() => {
    seedScene([
      { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: 2 },
      { op: 'ctl', id: 'pt1', k: 'x', kind: 'slider', min: -10, max: 10, step: 1, label: 'x' },
    ])
  })

  it('renders a range input with min/max/step from the control and the live value', async () => {
    await renderStrip()
    const input = container.querySelector('input[type="range"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.min).toBe('-10')
    expect(input.max).toBe('10')
    expect(input.step).toBe('1')
    expect(input.value).toBe('1')
    expect(container.textContent).toContain('1') // formatNum(1) live value display
  })

  it('input events update the live override (60fps local) without committing', async () => {
    await renderStrip()
    const input = container.querySelector('input[type="range"]') as HTMLInputElement

    await act(async () => {
      input.value = '5'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(useBoard.getState().liveOverrides.pt1?.x).toBe(5)
    expect(useBoard.getState().scene.elements.pt1?.params.x).toBe(1) // not yet committed
  })

  it('pointerup commits a `set` action and fires a debounced param event with the pre-drag `from`', async () => {
    const sink = vi.fn()
    setEventSink(sink)
    await renderStrip()
    const input = container.querySelector('input[type="range"]') as HTMLInputElement

    await act(async () => {
      input.value = '3'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.value = '5'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })

    expect(useBoard.getState().scene.elements.pt1?.params.x).toBe(5)
    expect(useBoard.getState().liveOverrides.pt1?.x).toBeUndefined()
    expect(useBoard.getState().history.at(-1)).toEqual({ op: 'set', id: 'pt1', k: 'x', v: 5 })

    expect(sink).not.toHaveBeenCalled() // debounce still pending
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(sink).toHaveBeenCalledWith({ ev: 'param', id: 'pt1', k: 'x', from: 1, to: 5 })
  })

  it('does not emit a param event if the value did not actually change', async () => {
    const sink = vi.fn()
    setEventSink(sink)
    await renderStrip()
    const input = container.querySelector('input[type="range"]') as HTMLInputElement

    await act(async () => {
      input.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    await act(async () => {
      vi.advanceTimersByTime(400)
    })

    expect(sink).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// ControlStrip / number input
// ---------------------------------------------------------------------------
describe('ControlStrip / number input', () => {
  beforeEach(() => {
    seedScene([
      { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: 2 },
      { op: 'ctl', id: 'pt1', k: 'y', kind: 'input', min: -10, max: 10, step: 1, label: 'y' },
    ])
  })

  it('commits on blur', async () => {
    const sink = vi.fn()
    setEventSink(sink)
    await renderStrip()
    const input = container.querySelector('input[type="number"]') as HTMLInputElement

    // Real `.focus()`/`.blur()` DOM calls, not synthetic 'focus'/'blur'
    // events dispatched directly: those two native events don't bubble, and
    // React's delegated listener for onFocus/onBlur is registered on
    // 'focusin'/'focusout' (which do bubble) — only real focus/blur calls
    // fire the full native sequence jsdom (and React) expect.
    await act(async () => {
      input.focus()
    })
    await act(async () => {
      input.value = '7'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useBoard.getState().scene.elements.pt1?.params.y).toBe(2) // not yet committed

    await act(async () => {
      input.blur()
    })

    expect(useBoard.getState().scene.elements.pt1?.params.y).toBe(7)
    expect(useBoard.getState().history.at(-1)).toEqual({ op: 'set', id: 'pt1', k: 'y', v: 7 })

    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(sink).toHaveBeenCalledWith({ ev: 'param', id: 'pt1', k: 'y', from: 2, to: 7 })
  })

  it('commits on Enter, exactly once (Enter also blurs, which must not double-commit)', async () => {
    await renderStrip()
    const input = container.querySelector('input[type="number"]') as HTMLInputElement

    await act(async () => {
      input.focus()
    })
    await act(async () => {
      input.value = '9'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(useBoard.getState().scene.elements.pt1?.params.y).toBe(9)
    // Enter's handler commits, then calls .blur() — which fires onBlur and
    // must not commit a second time (regression: this used to push a
    // duplicate identical `set` action onto history).
    const history = useBoard.getState().history
    expect(history.filter((a) => a.op === 'set' && a.id === 'pt1' && a.k === 'y')).toHaveLength(1)
  })

  it('does not commit a no-op (focus + blur with no actual edit)', async () => {
    await renderStrip()
    const input = container.querySelector('input[type="number"]') as HTMLInputElement

    await act(async () => {
      input.focus()
    })
    await act(async () => {
      input.blur()
    })

    expect(useBoard.getState().history).toHaveLength(0)
  })

  it('renders nothing for a `drag` kind control (handled on-canvas, not here)', async () => {
    seedScene([
      { op: 'add', c: 'point', id: 'pt2', on: 'ax1', x: 0, y: 0 },
      { op: 'ctl', id: 'pt2', k: 'x', kind: 'drag' },
    ])
    await renderStrip()
    expect(container.querySelector('input')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// submitAskAnswer — ask-answer flow (T14 half; T15's AskWidget calls this).
// ---------------------------------------------------------------------------
describe('submitAskAnswer', () => {
  beforeEach(() => {
    useBoard.setState({
      ask: { id: 'ask1', kind: 'mcq', text: 'Capital of France?', options: ['Paris', 'Lyon'], answer: 'Paris' },
    })
  })

  it('emits {ev:"answer", correct:true} for a case-insensitive, trimmed match, and clears `ask`', () => {
    const sink = vi.fn()
    setEventSink(sink)

    submitAskAnswer(' paris ')

    expect(sink).toHaveBeenCalledWith({ ev: 'answer', askId: 'ask1', value: ' paris ', correct: true })
    expect(useBoard.getState().ask).toBeNull()
  })

  it('emits correct:false for a wrong answer', () => {
    const sink = vi.fn()
    setEventSink(sink)

    submitAskAnswer('Berlin')

    expect(sink).toHaveBeenCalledWith({ ev: 'answer', askId: 'ask1', value: 'Berlin', correct: false })
  })

  it('emits correct:null when the ask has no stored answer (ungraded free response)', () => {
    useBoard.setState({ ask: { id: 'ask2', kind: 'free', text: 'Thoughts?' } })
    const sink = vi.fn()
    setEventSink(sink)

    submitAskAnswer('whatever')

    expect(sink).toHaveBeenCalledWith({ ev: 'answer', askId: 'ask2', value: 'whatever', correct: null })
    expect(useBoard.getState().ask).toBeNull()
  })

  it('is a no-op if there is no active ask', () => {
    useBoard.setState({ ask: null })
    const sink = vi.fn()
    setEventSink(sink)

    submitAskAnswer('anything')

    expect(sink).not.toHaveBeenCalled()
  })
})
