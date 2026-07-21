// Katex.tsx — flow (non-Mafs) KaTeX rendering.
//
// On-axes labels use Mafs's own <LaTeX> display component instead (see the
// comment on LabelRenderer in math.tsx) since they need to be anchored to a
// math-space point inside a Mafs transform context. This component is for
// everywhere else that needs rendered math: standalone/flow labels and
// table cells, which have no Mafs context to anchor to.
import type { ReactElement } from 'react'
import katex from 'katex'

// Returns KaTeX's rendered HTML, or `null` if rendering threw for any
// reason. `throwOnError: false` already makes KaTeX render its own in-place
// error span instead of throwing for most malformed input, but that option
// only covers `ParseError` — other exceptions (e.g. a `RangeError` from
// "Maximum call stack size exceeded" on deeply-nested input) still propagate.
// Callers MUST NOT treat a `null` return as safe HTML to inject; see Katex()
// below, which is the only sanctioned caller.
export function renderKatex(tex: string): string | null {
  try {
    return katex.renderToString(tex, { throwOnError: false })
  } catch {
    return null
  }
}

// `dangerouslySetInnerHTML` here holds only KaTeX's own successful
// renderToString output, never raw user/LLM text — the standard, documented
// way to mount KaTeX output in React. When rendering throws for any reason
// (see renderKatex above), the raw `tex` is instead mounted as a plain React
// text node (JSX child, not dangerouslySetInnerHTML), so React escapes it
// like any other string — a malicious `<img onerror>` payload that survives
// as plain text can never execute as markup. This is the fix for the stored
// XSS reported in task-12 review round 1: a RangeError (or any other
// non-ParseError exception) from katex.renderToString used to fall through
// to `return tex` and get injected as raw HTML by the caller below.
export function Katex({ tex, className }: { tex: string; className?: string }): ReactElement {
  const html = renderKatex(tex)
  if (html === null) {
    return <span className="katex-fallback">{tex}</span>
  }
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />
}
