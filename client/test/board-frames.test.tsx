// board-frames.test.tsx — Board.tsx's frames-mode strip (V-1, feedback:
// "instead of animation, we could use multiple pictures on bottom of each
// other... if animation is getting complicated"). timeline.ts/store.ts
// record `frameSnapshots` (unit-tested there); this file covers Board's
// render of that data: one `.frames-strip` per snapshot, one `.frames-item`
// per sampled value, and — the important regression case — that nesting a
// preview <Board> inside the live one doesn't let the preview hijack the
// real board's auto-follow scrolling (see Board.tsx's `!sceneOverride` gate).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Action, applyAction, emptyScene, formatNum } from '@board/shared'
import Board from '../src/board/Board'
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

const BASE: Action[] = [
  { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
  { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 0, y: 0 },
]

function seed(actions: Action[], frameSnapshots: ReturnType<typeof useBoard.getState>['frameSnapshots'] = []): void {
  const scene = actions.reduce(applyAction, emptyScene)
  useBoard.setState({ scene, history: actions, liveOverrides: {}, selection: null, frameSnapshots })
}

async function renderBoard(): Promise<void> {
  await act(async () => {
    root.render(<Board />)
  })
}

describe('Board frames-strip render (V-1)', () => {
  it('renders no strip when there are no snapshots', async () => {
    seed(BASE, [])
    await renderBoard()
    expect(container.querySelector('.frames-strip')).toBeNull()
  })

  it('renders one .frames-strip with 4 .frames-item entries, labeled k = formatNum(v)', async () => {
    seed(BASE, [{ elId: 'pt1', k: 'x', values: [0, 3, 6, 9] }])
    await renderBoard()

    const strips = container.querySelectorAll('.frames-strip')
    expect(strips).toHaveLength(1)
    const items = strips[0]!.querySelectorAll('.frames-item')
    expect(items).toHaveLength(4)

    const labels = Array.from(items).map((el) => el.querySelector('.frames-item-label')?.textContent)
    expect(labels).toEqual([0, 3, 6, 9].map((v) => `x = ${formatNum(v)}`))
  })

  it('each frames-item renders a nested preview Board of just that element, pinned to its sampled value', async () => {
    seed(BASE, [{ elId: 'pt1', k: 'x', values: [0, 3, 6, 9] }])
    await renderBoard()

    const previews = container.querySelectorAll('.frames-item-preview .board-canvas')
    expect(previews).toHaveLength(4) // one nested Board per sampled value
  })

  it('a snapshot for an element no longer on the board (e.g. since deleted) renders no strip at all', async () => {
    seed(BASE, [{ elId: 'nonexistent', k: 'x', values: [0, 1, 2, 3] }])
    await renderBoard()
    // Snapshots are matched to a live block by element id; one with no
    // matching block on the current scene simply has nothing to attach to.
    expect(container.querySelector('.frames-strip')).toBeNull()
  })

  it('multiple snapshots targeting the same element render as separate strips (a history of anims)', async () => {
    seed(BASE, [
      { elId: 'pt1', k: 'x', values: [0, 3, 6, 9] },
      { elId: 'pt1', k: 'y', values: [0, 1, 2, 3] },
    ])
    await renderBoard()
    expect(container.querySelectorAll('.frames-strip')).toHaveLength(2)
  })
})

describe('Board frames-strip previews never hijack the live board\'s auto-follow (regression)', () => {
  function mockMetrics(el: HTMLElement, m: { scrollHeight: number; clientHeight: number }): void {
    Object.defineProperty(el, 'scrollHeight', { value: m.scrollHeight, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: m.clientHeight, configurable: true })
  }

  it('scrollIntoView is called on the real newest block, not on any nested frames-strip preview', async () => {
    seed(BASE, [{ elId: 'pt1', k: 'x', values: [0, 3, 6, 9] }])
    await act(async () => {
      root.render(
        <div className="board-wrap">
          <Board />
        </div>,
      )
    })

    const wrap = container.querySelector('.board-wrap') as HTMLDivElement
    mockMetrics(wrap, { scrollHeight: 500, clientHeight: 500 })

    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
    spy.mockClear()

    await act(async () => {
      seed([...BASE, { op: 'add', c: 'numberline', id: 'nl1', min: 0, max: 10 }], [
        { elId: 'pt1', k: 'x', values: [0, 3, 6, 9] },
      ])
    })

    // Only the real board's own auto-follow effect may call scrollIntoView —
    // every nested preview Board (4 of them, one per sampled value) has its
    // scroll-follow effects gated off via `sceneOverride`.
    expect(spy).toHaveBeenCalledTimes(1)
    const scrolledEl = spy.mock.instances.at(-1) as unknown as HTMLElement
    expect(scrolledEl.getAttribute('data-el-id')).toBe('nl1')
  })
})
