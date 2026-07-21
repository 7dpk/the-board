// steps-render.test.tsx — smoke tests for the `steps` worked-derivation card
// (client/src/board/steps.tsx, task-pe). Same mount harness as
// physics-render.test.tsx (no @testing-library/react in this workspace).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Action, applyAction, emptyScene } from '@board/shared'
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
})

async function renderScene(actions: Action[]): Promise<void> {
  await act(async () => {
    const scene = actions.reduce(applyAction, emptyScene)
    useBoard.setState({ scene, liveOverrides: {}, selection: null })
    root.render(<Board />)
  })
}

const LINES = ['2x + 3 = 11', '2x = 8', 'x = 4']
const NOTES = ['subtract 3 from both sides', 'divide both sides by 2', undefined as unknown as string].filter(
  Boolean,
) as string[]

describe('Board / steps render pack', () => {
  it('shown=2 renders exactly 2 rows, in order, with the third line hidden', async () => {
    await renderScene([{ op: 'add', c: 'steps', id: 'st1', lines: LINES, shown: 2 }])
    const rows = container.querySelectorAll('.board-steps .board-steps-row')
    expect(rows.length).toBe(2)
    expect(rows[0]!.textContent).toContain('2x')
    expect(container.querySelector('.board-steps')!.textContent).not.toContain('x = 4')
  })

  it('defaults shown to lines.length (reveal everything) when shown is omitted', async () => {
    await renderScene([{ op: 'add', c: 'steps', id: 'st1', lines: LINES }])
    expect(container.querySelectorAll('.board-steps .board-steps-row').length).toBe(3)
  })

  it('rounds a fractional (mid-tween) shown value before slicing', async () => {
    // Directly seed a scene with a non-integer `shown` (as if mid-animation)
    // rather than going through the timeline, since this renderer's own
    // rounding is what's under test, not the tween mechanics.
    const scene = applyAction(emptyScene, { op: 'add', c: 'steps', id: 'st1', lines: LINES, shown: 1 })
    await act(async () => {
      useBoard.setState({
        scene: { ...scene, elements: { ...scene.elements, st1: { ...scene.elements.st1!, params: { ...scene.elements.st1!.params, shown: 1.6 } } } },
        liveOverrides: {},
        selection: null,
      })
      root.render(<Board />)
    })
    // Math.round(1.6) = 2 -> exactly 2 rows.
    expect(container.querySelectorAll('.board-steps .board-steps-row').length).toBe(2)
  })

  it('renders a title when given, and each line via KaTeX with its parallel note', async () => {
    await renderScene([
      { op: 'add', c: 'steps', id: 'st1', title: 'Solve for x', lines: LINES, notes: NOTES, shown: 2 },
    ])
    const card = container.querySelector('.board-steps')!
    expect(card.querySelector('.board-steps-title')!.textContent).toBe('Solve for x')
    expect(card.querySelectorAll('.katex').length).toBe(2) // 2 revealed lines rendered via KaTeX
    const rows = card.querySelectorAll('.board-steps-row')
    expect(rows[0]!.querySelector('.board-steps-note')!.textContent).toBe(NOTES[0])
    expect(rows[1]!.querySelector('.board-steps-note')!.textContent).toBe(NOTES[1])
  })

  it('does not crash with shown=0 (no rows revealed yet)', async () => {
    await expect(renderScene([{ op: 'add', c: 'steps', id: 'st1', lines: LINES, shown: 0 }])).resolves.not.toThrow()
    expect(container.querySelectorAll('.board-steps .board-steps-row').length).toBe(0)
  })
})
