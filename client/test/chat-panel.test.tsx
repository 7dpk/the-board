// chat-panel.test.tsx — ChatPanel's log rendering + student submit, with
// task-15's selection-scope nuance: a non-null `store.selection` shows an
// "asking about: {id}" chip and prefixes the outgoing/stored text with
// `[about ${id}] `.
//
// Scroll-pin coverage (task P-B): jsdom never computes real scrollHeight/
// clientHeight (see test/setup.ts's header comment), so `.chat-log`'s
// metrics are faked per-test via `mockMetrics` (an own-property override
// shadowing the inherited zero-returning getters) to simulate "scrolled up"
// vs. "at the bottom" before dispatching a real `scroll` event — the same
// contract src/chat/ChatPanel.tsx's `onScroll` handler consumes.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyScene } from '@board/shared'
import ChatPanel from '../src/chat/ChatPanel'
import { useBoard } from '../src/store'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useBoard.setState({ scene: emptyScene, history: [], steps: [], chat: [], ask: null, selection: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

async function renderPanel(onSend = vi.fn()): Promise<typeof onSend> {
  await act(async () => {
    root.render(<ChatPanel onSend={onSend} />)
  })
  return onSend
}

async function typeAndSubmit(text: string): Promise<void> {
  const input = container.querySelector('input') as HTMLInputElement
  await act(async () => {
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('ChatPanel', () => {
  it('renders the existing chat log', async () => {
    useBoard.setState({ chat: [{ from: 'teacher', text: 'hello' }] })
    await renderPanel()
    expect(container.querySelector('.chat-teacher')?.textContent).toBe('hello')
  })

  it('submitting with no selection sends plain text and appends a student message', async () => {
    const onSend = await renderPanel()
    await typeAndSubmit('what is a parabola?')

    expect(onSend).toHaveBeenCalledWith('what is a parabola?')
    expect(useBoard.getState().chat).toEqual([{ from: 'student', text: 'what is a parabola?' }])
  })

  it('with a selection, shows the "asking about" chip and prefixes the sent + stored text', async () => {
    useBoard.setState({ selection: 'pt1' })
    const onSend = await renderPanel()

    expect(container.querySelector('.selection-chip')?.textContent).toBe('asking about: pt1')

    await typeAndSubmit('why does it move')

    expect(onSend).toHaveBeenCalledWith('[about pt1] why does it move')
    expect(useBoard.getState().chat).toEqual([{ from: 'student', text: '[about pt1] why does it move' }])
  })

  it('submitting empty/whitespace text is a no-op', async () => {
    const onSend = await renderPanel()
    await typeAndSubmit('   ')

    expect(onSend).not.toHaveBeenCalled()
    expect(useBoard.getState().chat).toEqual([])
  })

  it('clears the draft input after a successful submit', async () => {
    await renderPanel()
    await typeAndSubmit('hi')
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.value).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Button responsiveness (task-s2, feedback: "buttons are not very
// responsive"): store.ts's `turnInFlight` (set by App.tsx's fire()/settle()
// around every network turn) drives the Send button's busy indicator.
//
// fix round 1: disabling the input/Send button for every in-flight turn
// contradicted the approved FIFO chat-queueing design (App.tsx's turn queue
// — see app-turns.test.tsx's "two rapid chats both reach the server in
// order, neither dropped"). The input now stays typable and Send stays
// clickable at all times; `turnInFlight` only toggles the visual busy
// indicator.
// ---------------------------------------------------------------------------
describe('ChatPanel Send button responsiveness (task-s2 / fix round 1)', () => {
  it('shows a busy indicator on Send while a turn is in flight, but never disables the input or Send button', async () => {
    useBoard.setState({ turnInFlight: false })
    await renderPanel()

    const input = container.querySelector('input') as HTMLInputElement
    let sendButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Send') as HTMLButtonElement
    expect(input.disabled).toBe(false)
    expect(sendButton.disabled).toBe(false)
    expect(sendButton.classList.contains('btn-loading')).toBe(false)

    await act(async () => {
      useBoard.setState({ turnInFlight: true })
    })
    sendButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Send') as HTMLButtonElement
    // Busy indicator shows, but nothing is disabled — students can keep
    // composing and Send keeps queuing further turns behind the in-flight
    // one, per the FIFO design.
    expect(input.disabled).toBe(false)
    expect(sendButton.disabled).toBe(false)
    expect(sendButton.classList.contains('btn-loading')).toBe(true)

    await act(async () => {
      useBoard.setState({ turnInFlight: false })
    })
    sendButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Send') as HTMLButtonElement
    expect(sendButton.classList.contains('btn-loading')).toBe(false)
  })

  it('typing and submitting a message while a turn is already in flight still queues it (input/Send stay usable)', async () => {
    const onSend = await renderPanel()

    await act(async () => {
      useBoard.setState({ turnInFlight: true })
    })

    await typeAndSubmit('queued while busy')

    expect(onSend).toHaveBeenCalledWith('queued while busy')
    expect(useBoard.getState().chat).toEqual([{ from: 'student', text: 'queued while busy' }])
  })
})

// ---------------------------------------------------------------------------
// Scroll pin (task P-B, feedback: "the right chat sidebar doesn't scroll
// up") — smart auto-pin: pinned when at the bottom, no forced scroll once
// the reader scrolls away.
// ---------------------------------------------------------------------------
function mockMetrics(el: HTMLElement, m: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(el, 'scrollHeight', { value: m.scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: m.clientHeight, configurable: true })
}

function scrollTo(el: HTMLElement, scrollTop: number): void {
  el.scrollTop = scrollTop
  el.dispatchEvent(new Event('scroll', { bubbles: false }))
}

function addTeacherMessage(text: string): void {
  useBoard.setState((s) => ({ chat: [...s.chat, { from: 'teacher', text }] }))
}

describe('ChatPanel scroll pin', () => {
  it('does not force-scroll a new message down while the reader has scrolled away from the bottom', async () => {
    useBoard.setState({ chat: [{ from: 'teacher', text: 'first' }] })
    await renderPanel()
    const log = container.querySelector('.chat-log') as HTMLDivElement
    mockMetrics(log, { scrollHeight: 1000, clientHeight: 200 })

    act(() => {
      scrollTo(log, 0) // far from the bottom (distance 800 > 40px threshold) -> unpins
    })
    expect(log.scrollTop).toBe(0)

    await act(async () => {
      addTeacherMessage('second')
    })

    expect(log.scrollTop).toBe(0) // not yanked back down
  })

  it('keeps a new message pinned to the bottom while the reader is already at the bottom', async () => {
    useBoard.setState({ chat: [{ from: 'teacher', text: 'first' }] })
    await renderPanel()
    const log = container.querySelector('.chat-log') as HTMLDivElement
    mockMetrics(log, { scrollHeight: 1000, clientHeight: 200 })

    act(() => {
      scrollTo(log, 800) // scrollHeight - clientHeight: exactly at the bottom -> stays pinned
    })
    expect(log.scrollTop).toBe(800)

    await act(async () => {
      addTeacherMessage('second')
    })

    expect(log.scrollTop).toBe(1000) // re-pinned to the (new) bottom
  })

  it('starts pinned: the very first message does not require a prior scroll to land at the bottom', async () => {
    await renderPanel()
    const log = container.querySelector('.chat-log') as HTMLDivElement
    mockMetrics(log, { scrollHeight: 500, clientHeight: 200 })

    await act(async () => {
      addTeacherMessage('welcome')
    })

    expect(log.scrollTop).toBe(500)
  })
})
