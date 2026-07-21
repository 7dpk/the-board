// katex.test.tsx — regression coverage for the task-12 review round 1 stored
// XSS in Katex.tsx: katex.renderToString(tex, { throwOnError: false }) only
// suppresses KaTeX's own ParseError, not other exceptions (e.g. a RangeError
// from "Maximum call stack size exceeded" on deeply-nested tex input). The
// pre-fix code caught that exception and fell through to `return tex`, which
// the caller then mounted with dangerouslySetInnerHTML — injecting raw,
// unescaped LLM-authored text (including a real <img onerror> payload) as
// live markup. The fix: any exception now renders `tex` as a plain React
// text node instead, so React escapes it like any other string.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Katex } from '../src/board/Katex'

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
  delete (window as unknown as { __pwned?: unknown }).__pwned
})

describe('Katex fallback (stored XSS regression)', () => {
  it('renders a tex payload that throws (not just fails to parse) as inert text, never as HTML', async () => {
    // 25k levels of nested braces reliably blows KaTeX's parser call stack
    // (a RangeError, not a ParseError) — throwOnError:false does not catch
    // this. The onerror payload is the attacker's actual exploit string.
    const payload = '{'.repeat(25000) + 'x' + '}'.repeat(25000) + '<img src=x onerror="window.__pwned=1">'

    await act(async () => {
      root.render(<Katex tex={payload} />)
    })

    // No <img> ever got mounted as an element (which would have fired
    // onerror on load-failure and set window.__pwned).
    expect(container.querySelector('img')).toBeNull()
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined()

    // The payload survived only as inert text content, escaped by React.
    expect(container.textContent).toBe(payload)
    expect(container.querySelector('.katex-fallback')).toBeTruthy()
  })

  it('still renders real KaTeX markup (via dangerouslySetInnerHTML) for tex that renders successfully', async () => {
    await act(async () => {
      root.render(<Katex tex="x^2" />)
    })

    expect(container.querySelector('.katex')).toBeTruthy()
    expect(container.querySelector('.katex-fallback')).toBeNull()
  })
})
