// board-responsive.test.tsx — Board.tsx's two P-B polish features that need
// a real render to exercise:
//
//   1. Auto-follow: scrollIntoView on the newest block when new history
//      commits, gated by the shared `shouldAutoFollow` decision (unit-tested
//      standalone in scroll-pin.test.ts) — this file covers the DOM-facing
//      wiring around it (scroll listeners, closest('.board-wrap'), which
//      element gets scrolled).
//   2. Adaptive axes height: Mafs's `height` prop is `clampAxesHeight`
//      (responsive.ts) applied to the viewport, not a hardcoded constant.
//
// scrollIntoView is stubbed globally as a no-op in test/setup.ts (jsdom
// doesn't implement it at all); scrollHeight/clientHeight are faked per-test
// via `mockMetrics` the same way chat-panel.test.tsx does, since jsdom never
// computes real layout.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Action, applyAction, emptyScene } from '@board/shared'
import Board from '../src/board/Board'
import { clampAxesHeight } from '../src/board/responsive'
import { useBoard } from '../src/store'

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
  vi.restoreAllMocks()
})

// Sets scene + history together (unlike math-render.test.tsx's seedScene,
// which only needs `scene` for its render-pack assertions) — Board's
// auto-follow effect is keyed on `history.length`, so a real, growing
// history is the point here.
function seedHistory(actions: Action[]): void {
  const scene = actions.reduce(applyAction, emptyScene)
  useBoard.setState({ scene, history: actions, liveOverrides: {}, selection: null })
}

async function renderInWrap(): Promise<void> {
  await act(async () => {
    root.render(
      <div className="board-wrap">
        <Board />
      </div>,
    )
  })
}

function mockMetrics(el: HTMLElement, m: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(el, 'scrollHeight', { value: m.scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: m.clientHeight, configurable: true })
}

const BASE: Action[] = [
  { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
  { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: 1 },
]

async function commitOneMore(): Promise<void> {
  await act(async () => {
    seedHistory([...BASE, { op: 'add', c: 'numberline', id: 'nl1', min: 0, max: 10 }])
  })
}

describe('Board auto-follow (task P-B item 2)', () => {
  it('scrolls the newest block into view when new history commits while at the bottom', async () => {
    seedHistory(BASE)
    await renderInWrap()

    const wrap = container.querySelector('.board-wrap') as HTMLDivElement
    mockMetrics(wrap, { scrollHeight: 500, clientHeight: 500 }) // fully visible -> "at bottom"

    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
    spy.mockClear()

    await commitOneMore()

    expect(spy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' })
    const scrolledEl = spy.mock.instances.at(-1) as unknown as HTMLElement
    expect(scrolledEl.getAttribute('data-el-id')).toBe('nl1') // the newest block, not an arbitrary one
  })

  it('does not auto-follow when the reader has recently scrolled away from the bottom', async () => {
    seedHistory(BASE)
    await renderInWrap()

    const wrap = container.querySelector('.board-wrap') as HTMLDivElement
    mockMetrics(wrap, { scrollHeight: 2000, clientHeight: 200 }) // tall content, far from the bottom
    act(() => {
      wrap.scrollTop = 0
      wrap.dispatchEvent(new Event('scroll'))
    })

    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
    spy.mockClear()

    await commitOneMore()

    expect(spy).not.toHaveBeenCalled()
  })

  // P-E fix: the old bare-timeout resume (auto-follow forcibly resuming once
  // a manual scroll-away was more than 5s old, regardless of position) is
  // gone — see scrollPin.ts's shouldAutoFollow. These two tests replace the
  // removed "resumes after the grace period elapses" case.
  it('does NOT resume on elapsed time alone, however long the reader has been scrolled away', async () => {
    seedHistory(BASE)
    await renderInWrap()

    const wrap = container.querySelector('.board-wrap') as HTMLDivElement
    mockMetrics(wrap, { scrollHeight: 2000, clientHeight: 200 })
    act(() => {
      wrap.scrollTop = 0
      wrap.dispatchEvent(new Event('scroll')) // records "manual scroll" at the real current time
    })

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000) // 60s later — still far from the bottom

    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
    spy.mockClear()

    await commitOneMore()

    expect(spy).not.toHaveBeenCalled()
  })

  it('resumes once the reader has scrolled back near the bottom themselves, no matter how long they were away', async () => {
    seedHistory(BASE)
    await renderInWrap()

    const wrap = container.querySelector('.board-wrap') as HTMLDivElement
    mockMetrics(wrap, { scrollHeight: 2000, clientHeight: 200 })
    act(() => {
      wrap.scrollTop = 0
      wrap.dispatchEvent(new Event('scroll')) // manual scroll-away
    })

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000) // long after — position, not time, must decide
    mockMetrics(wrap, { scrollHeight: 2000, clientHeight: 1800 }) // reader scrolled back near the bottom themselves
    act(() => {
      wrap.scrollTop = 1780
      wrap.dispatchEvent(new Event('scroll'))
    })

    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
    spy.mockClear()

    await commitOneMore()

    expect(spy).toHaveBeenCalled()
  })

  it('is a no-op (no crash) when Board is rendered with no .board-wrap ancestor (Gallery.tsx reuse)', async () => {
    seedHistory(BASE)
    await act(async () => {
      root.render(<Board />)
    })

    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
    spy.mockClear()

    await expect(commitOneMore()).resolves.not.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('Board adaptive axes height (task P-B item 3)', () => {
  it('sizes the Mafs canvas to clampAxesHeight(viewport height), not a hardcoded constant', async () => {
    seedHistory(BASE)
    await renderInWrap()

    const mafsView = container.querySelector('.MafsView') as HTMLDivElement
    expect(mafsView).toBeTruthy()
    expect(mafsView.style.height).toBe(`${clampAxesHeight(window.innerHeight)}px`)
  })

  it('recomputes the axes height on window resize', async () => {
    seedHistory(BASE)
    await renderInWrap()

    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { value: 2000, configurable: true })
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })

    const mafsView = container.querySelector('.MafsView') as HTMLDivElement
    expect(mafsView.style.height).toBe(`${clampAxesHeight(2000)}px`) // clamps to the 420px ceiling

    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true })
  })
})
