// topic-picker.test.tsx — TopicPicker.tsx's button responsiveness (task-s2,
// feedback: "buttons are not very responsive — if I click once it should
// get disabled"): every lesson card locks the instant one is picked (a
// loading state on the chosen card), re-enabling only if the pick fails.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TopicPicker from '../src/TopicPicker'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
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

async function renderPicker(onPick: (topic: string) => void | Promise<void>): Promise<void> {
  await act(async () => {
    root.render(<TopicPicker onPick={onPick} />)
  })
}

function findCard(title: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('.lesson-card')).find((b) => b.textContent === title)
  if (!btn) throw new Error(`no lesson card "${title}"`)
  return btn as HTMLButtonElement
}

describe('TopicPicker button responsiveness (task-s2)', () => {
  it('disables every lesson card and marks the chosen one as loading immediately after a click', async () => {
    let resolvePick: () => void = () => {}
    const onPick = vi.fn(() => new Promise<void>((resolve) => (resolvePick = resolve)))
    await renderPicker(onPick)

    await act(async () => {
      findCard('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(findCard('Quadratic Functions').disabled).toBe(true)
    expect(findCard('Projectile Motion').disabled).toBe(true)
    expect(findCard('Quadratic Functions').classList.contains('btn-loading')).toBe(true)
    expect(onPick).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolvePick()
    })
  })

  // fix round 1: the guard used to be React state (`picking`), so two
  // synchronous clicks landing in the SAME render/tick (before React commits
  // `disabled`) both passed the `if (picking) return` check and both fired
  // onPick. Both dispatches must land in ONE act() block (no intervening
  // render) to actually exercise that race — mirrors
  // ask-widget.test.tsx's mcq double-click case.
  it('a synchronous double-click on the same card fires onPick exactly once', async () => {
    let resolvePick: () => void = () => {}
    const onPick = vi.fn(() => new Promise<void>((resolve) => (resolvePick = resolve)))
    await renderPicker(onPick)

    await act(async () => {
      // Two dispatches back-to-back, synchronously, with no intervening
      // render — simulates a real double-click landing before React has had
      // a chance to flip `disabled` to true.
      findCard('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      findCard('Quadratic Functions').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onPick).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolvePick()
    })
  })

  it('re-enables the cards if the pick fails (e.g. createSession rejects)', async () => {
    const onPick = vi.fn(() => Promise.reject(new Error('network down')))
    await renderPicker(onPick)

    await act(async () => {
      findCard('Projectile Motion').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(findCard('Projectile Motion').disabled).toBe(false)
    expect(findCard('Projectile Motion').classList.contains('btn-loading')).toBe(false)
  })

  it('submitting a custom topic also locks the lesson cards', async () => {
    let resolvePick: () => void = () => {}
    const onPick = vi.fn(() => new Promise<void>((resolve) => (resolvePick = resolve)))
    await renderPicker(onPick)

    const input = container.querySelector('input') as HTMLInputElement
    await act(async () => {
      input.value = 'Trigonometry'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('.topic-custom')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onPick).toHaveBeenCalledWith('Trigonometry')
    expect(findCard('Quadratic Functions').disabled).toBe(true)

    await act(async () => {
      resolvePick()
    })
  })
})
