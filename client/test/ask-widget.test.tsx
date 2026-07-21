// ask-widget.test.tsx — AskWidget renders per ask.kind and, on submit, both
// runs the local grading/unblock flow (events.ts's submitAskAnswer) and
// reports {askId, value} to the caller for the server-side {kind:'answer'}
// turn (task-15 brief: student answers go BOTH places).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyScene } from '@board/shared'
import AskWidget from '../src/chat/AskWidget'
import { setEventSink } from '../src/events'
import { useBoard } from '../src/store'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useBoard.setState({ scene: emptyScene, history: [], steps: [], chat: [], ask: null })
  setEventSink(() => {})
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

async function renderWidget(onAnswer: (askId: string, value: string) => void = vi.fn()): Promise<void> {
  await act(async () => {
    root.render(<AskWidget onAnswer={onAnswer} />)
  })
}

describe('AskWidget', () => {
  it('renders nothing when there is no active ask', async () => {
    await renderWidget()
    expect(container.querySelector('.ask-widget')).toBeNull()
  })

  it('mcq: renders one button per option; clicking one grades locally and reports to the server', async () => {
    useBoard.setState({
      ask: { id: 'q1', kind: 'mcq', text: 'x or y?', options: ['x', 'y'], answer: 'y' },
    })
    const sink = vi.fn()
    setEventSink(sink)
    const onAnswer = vi.fn()
    await renderWidget(onAnswer)

    const buttons = Array.from(container.querySelectorAll('.ask-options button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['x', 'y'])

    await act(async () => {
      buttons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(sink).toHaveBeenCalledWith({ ev: 'answer', askId: 'q1', value: 'y', correct: true })
    expect(onAnswer).toHaveBeenCalledWith('q1', 'y')
    expect(useBoard.getState().ask).toBeNull() // submitAskAnswer -> store.answerAsk clears it
  })

  it('numeric: typing a value and submitting the form reports it both locally and to the server', async () => {
    useBoard.setState({ ask: { id: 'q2', kind: 'numeric', text: '2+2?', answer: '4' } })
    const sink = vi.fn()
    setEventSink(sink)
    const onAnswer = vi.fn()
    await renderWidget(onAnswer)

    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    await act(async () => {
      input.value = '4'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(sink).toHaveBeenCalledWith({ ev: 'answer', askId: 'q2', value: '4', correct: true })
    expect(onAnswer).toHaveBeenCalledWith('q2', '4')
  })

  it('free: submits the textarea content and reports correct:null when the ask has no stored answer', async () => {
    useBoard.setState({ ask: { id: 'q3', kind: 'free', text: 'why?' } })
    const sink = vi.fn()
    setEventSink(sink)
    const onAnswer = vi.fn()
    await renderWidget(onAnswer)

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      textarea.value = 'because reasons'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(sink).toHaveBeenCalledWith({ ev: 'answer', askId: 'q3', value: 'because reasons', correct: null })
    expect(onAnswer).toHaveBeenCalledWith('q3', 'because reasons')
  })

  it('submitting an empty value is a no-op (no sink call, onAnswer not called)', async () => {
    useBoard.setState({ ask: { id: 'q4', kind: 'free', text: 'why?' } })
    const sink = vi.fn()
    setEventSink(sink)
    const onAnswer = vi.fn()
    await renderWidget(onAnswer)

    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(sink).not.toHaveBeenCalled()
    expect(onAnswer).not.toHaveBeenCalled()
    expect(useBoard.getState().ask).not.toBeNull() // still pending — nothing was answered
  })
})

// ---------------------------------------------------------------------------
// Button responsiveness (task-s2, feedback: "buttons are not very
// responsive — if I click once it should get disabled").
// ---------------------------------------------------------------------------
describe('AskWidget button responsiveness (task-s2)', () => {
  it('double-clicking an mcq option (both dispatches before a re-render) results in exactly ONE answer event/turn', async () => {
    useBoard.setState({
      ask: { id: 'q5', kind: 'mcq', text: 'x or y?', options: ['x', 'y'], answer: 'y' },
    })
    const sink = vi.fn()
    setEventSink(sink)
    const onAnswer = vi.fn()
    await renderWidget(onAnswer)

    const button = container.querySelectorAll('.ask-options button')[1] as HTMLButtonElement
    await act(async () => {
      // Two dispatches back-to-back, synchronously, with no intervening
      // render — simulates a real double-click landing before React has had
      // a chance to flip `disabled` to true.
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(sink).toHaveBeenCalledTimes(1)
    expect(onAnswer).toHaveBeenCalledTimes(1)
  })

  it('disables every mcq option and marks the chosen one as pressed immediately after a click', async () => {
    useBoard.setState({
      ask: { id: 'q6', kind: 'mcq', text: 'x or y?', options: ['x', 'y'], answer: 'y' },
    })
    setEventSink(() => {})
    await renderWidget()

    const buttons = Array.from(container.querySelectorAll('.ask-options button')) as HTMLButtonElement[]
    await act(async () => {
      buttons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(buttons[0]!.disabled).toBe(true)
    expect(buttons[1]!.disabled).toBe(true)
    expect(buttons[1]!.classList.contains('btn-pressed')).toBe(true)
    expect(buttons[0]!.classList.contains('btn-pressed')).toBe(false)
  })

  it('re-enables options once a new ask arrives', async () => {
    useBoard.setState({
      ask: { id: 'q7', kind: 'mcq', text: 'x or y?', options: ['x', 'y'], answer: 'y' },
    })
    setEventSink(() => {})
    await renderWidget()

    await act(async () => {
      container.querySelectorAll('.ask-options button')[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect((container.querySelectorAll('.ask-options button')[0] as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      useBoard.setState({ ask: { id: 'q8', kind: 'mcq', text: 'a or b?', options: ['a', 'b'], answer: 'a' } })
    })

    const freshButtons = Array.from(container.querySelectorAll('.ask-options button')) as HTMLButtonElement[]
    expect(freshButtons.every((b) => !b.disabled)).toBe(true)
    expect(freshButtons.some((b) => b.classList.contains('btn-pressed'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// task F-1 (screenshot bug: "mcq options render disabled even before
// answering"). Root cause: a beat that re-teaches (re-teach after warmup, a
// hint re-ask, etc.) re-streams an `ask` action with the SAME id as a
// previous one on this session. The old reset logic keyed purely on
// `displayed.id` changing -- a same-id re-arrival left `submittedRef`/
// `chosen` locked from the FIRST answer, so the options rendered disabled
// from the very first render of the "new" (same-id) ask, before the student
// ever touched them.
//
// Fix: store.ts's `commit` bumps a monotonic `askNonce` every time an `ask`
// action lands (regardless of whether the id changed); AskWidget resets its
// submitted/chosen state whenever EITHER the id OR the nonce changes, so a
// same-id re-arrival re-arms the widget too.
//
// These go through the real `commit` reducer (not a manual `setState({ask})`
// like the tests above) so the nonce actually bumps -- that's the production
// code path (timeline -> store.commit) an `ask` action always takes.
// ---------------------------------------------------------------------------
describe('AskWidget re-arm on same-id ask re-arrival (task F-1)', () => {
  it('committing the same ask id twice re-enables options after the second arrival', async () => {
    setEventSink(() => {})
    await renderWidget()

    act(() => {
      useBoard.getState().commit({ op: 'ask', id: 'q9', kind: 'mcq', text: 'x or y?', options: ['x', 'y'], answer: 'y' })
    })

    await act(async () => {
      container.querySelectorAll('.ask-options button')[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect((container.querySelectorAll('.ask-options button')[0] as HTMLButtonElement).disabled).toBe(true)

    // The beat re-teaches: the SAME ask id re-streams (a genuinely new `ask`
    // action, same id, e.g. after a re-teach or hint re-ask).
    await act(async () => {
      useBoard.getState().commit({ op: 'ask', id: 'q9', kind: 'mcq', text: 'x or y?', options: ['x', 'y'], answer: 'y' })
    })

    const freshButtons = Array.from(container.querySelectorAll('.ask-options button')) as HTMLButtonElement[]
    expect(freshButtons.every((b) => !b.disabled)).toBe(true)
    expect(freshButtons.some((b) => b.classList.contains('btn-pressed'))).toBe(false)
  })

  it('numeric: a partial draft is cleared when a new ask arrives via the real store commit path (nonce bump)', async () => {
    setEventSink(() => {})
    await renderWidget()

    act(() => {
      useBoard.getState().commit({ op: 'ask', id: 'q10', kind: 'numeric', text: '2+2?', answer: '4' })
    })

    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    await act(async () => {
      input.value = '3'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe('3') // partial draft typed, not yet submitted

    // A new ask arrives via the real commit reducer (not a manual setState)
    // so askNonce actually bumps -- the production code path an `ask` action
    // always takes.
    await act(async () => {
      useBoard.getState().commit({ op: 'ask', id: 'q11', kind: 'numeric', text: '3+3?', answer: '6' })
    })

    const freshInput = container.querySelector('input[type="number"]') as HTMLInputElement
    expect(freshInput.value).toBe('') // draft cleared on re-arm
  })
})
