// gallery-render.test.tsx — Gallery.tsx smoke coverage (task-pe).
//
// Regression test for a real bug found while verifying the new steps/orbit/
// spring/wave/ray cards render "with sliders" per the brief: ComponentCard
// built its own `localScene` state and a `handleParamChange` slider handler,
// but rendered the SHARED, module-level `useBoard` store's <Board/> instead
// of that local scene — since `useBoard` is a single `create()` singleton
// (store.ts), every one of the ~18 simultaneously-mounted cards showed the
// exact same (usually empty) global scene, and no card's slider ever did
// anything visible. Fixed by giving Board an optional `scene` prop
// (Board.tsx) and passing `localScene` through it here. These tests would
// have failed against the pre-fix code (no `.physics-orbit`/etc. would ever
// render, since the global store's scene is empty before any session runs).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMPONENT_TYPES } from '@board/shared'
import Gallery from '../src/Gallery'
import { useBoard } from '../src/store'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useBoard.getState().reset()
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

async function renderGallery(): Promise<void> {
  await act(async () => {
    root.render(<Gallery />)
  })
}

function cardFor(componentType: string): HTMLElement {
  const heading = Array.from(container.querySelectorAll('.gallery-card h3')).find((h) => h.textContent === componentType)
  if (!heading) throw new Error(`no gallery card for "${componentType}"`)
  return heading.closest('.gallery-card') as HTMLElement
}

function sliderFor(card: HTMLElement, paramKey: string): HTMLInputElement {
  const label = Array.from(card.querySelectorAll('.gallery-slider .slider-label')).find((s) => s.textContent === paramKey)
  if (!label) throw new Error(`no "${paramKey}" slider on card`)
  return label.closest('.gallery-slider')!.querySelector('input[type="range"]') as HTMLInputElement
}

// React patches a controlled <input>'s OWN `value` property (per-instance,
// via inputValueTracking) so it can tell "did this change land through
// React's own controlled-value path or from outside it" — plain `el.value =
// x` goes through that patched setter and, empirically (verified directly
// against this exact slider), does not reliably make the following
// dispatched 'input' event's onChange see the new value. Setting through the
// ORIGINAL prototype setter first (same trick React Testing Library's
// `fireEvent.change` uses under the hood) bypasses React's instance patch, so
// the subsequent native 'input' event's onChange reads the real new value.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!

function setSliderValue(slider: HTMLInputElement, value: string): void {
  nativeInputValueSetter.call(slider, value)
  slider.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Gallery / standalone (no-axes) component cards render their own local scene', () => {
  it('renders one card per non-axes ComponentType, plus the replay demo card', async () => {
    await renderGallery()
    // `.replay-demo` also carries the `.gallery-card` class (and its own
    // <h3>Replay Demo</h3>), so it's excluded here and checked separately.
    const componentCardHeadings = container.querySelectorAll('.gallery-card:not(.replay-demo) h3')
    expect(componentCardHeadings.length).toBe(COMPONENT_TYPES.length - 1) // every type except axes
    expect(container.querySelector('.replay-demo')).toBeTruthy()
  })

  it('renders the steps card from its own example (not the empty global store)', async () => {
    await renderGallery()
    const card = cardFor('steps')
    expect(card.querySelector('.board-steps')).toBeTruthy()
    expect(card.querySelector('.board-unknown')).toBeNull()
    expect(card.querySelector('.board-orphaned')).toBeNull()
  })

  it.each(['orbit', 'spring', 'wave', 'ray'] as const)('renders the %s card from its own example', async (type) => {
    await renderGallery()
    const card = cardFor(type)
    expect(card.querySelector(`.physics-${type}`)).toBeTruthy()
    expect(card.querySelector('.board-unknown')).toBeNull()
  })

  it('dragging the orbit "t" slider actually changes what that card renders', async () => {
    await renderGallery()
    const card = cardFor('orbit')
    const before = card.querySelector('.physics-orbit circle[data-role="satellite"]')!.getAttribute('cx')

    const slider = sliderFor(card, 't')
    await act(async () => {
      setSliderValue(slider, String(Number(slider.max) * 0.5))
    })

    const after = card.querySelector('.physics-orbit circle[data-role="satellite"]')!.getAttribute('cx')
    expect(after).not.toBe(before)
  })

  it('dragging the steps "shown" slider changes how many rows that card reveals', async () => {
    await renderGallery()
    const card = cardFor('steps')
    const slider = sliderFor(card, 'shown')

    await act(async () => {
      setSliderValue(slider, '1')
    })
    const rowsAtOne = card.querySelectorAll('.board-steps-row').length

    await act(async () => {
      setSliderValue(slider, String(Number(slider.max)))
    })
    const rowsAtMax = card.querySelectorAll('.board-steps-row').length

    expect(rowsAtMax).toBeGreaterThan(rowsAtOne)
  })

  it("changing one card's slider does not affect another card's rendering (no shared-store crosstalk)", async () => {
    await renderGallery()
    const orbitCard = cardFor('orbit')
    const springCard = cardFor('spring')
    const springBefore = springCard.querySelector('.physics-spring rect[data-role="block"]')!.getAttribute('x')

    const slider = sliderFor(orbitCard, 't')
    await act(async () => {
      setSliderValue(slider, String(Number(slider.max) * 0.5))
    })

    const springAfter = springCard.querySelector('.physics-spring rect[data-role="block"]')!.getAttribute('x')
    expect(springAfter).toBe(springBefore)
  })
})
