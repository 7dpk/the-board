// Vitest jsdom setup, shared by every client test file (wired via
// vite.config.ts's `test.setupFiles`).
//
// This workspace has no @testing-library/react (not a declared dep), which
// is what normally flips this flag on for you. Without it, React 18's `act`
// (imported from 'react' — see client/test/math-render.test.tsx) still runs,
// but async work scheduled inside it can commit *after* `act` hands control
// back, at a point where React has already torn down its internal hooks
// dispatcher — surfacing as a confusing "Cannot read properties of null
// (reading 'useCallback')" from deep inside some unrelated hook, rather than
// any error that points at this flag. See
// https://github.com/reactwg/react-18/discussions/102.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Mafs (used by client/src/board/Board.tsx) measures its <Mafs> container's
// pixel width via `use-resize-observer` whenever it's given `width="auto"`
// (its default). Board.tsx deliberately always passes an explicit numeric
// `width` instead — tracing `use-resize-observer`'s source
// (node_modules/use-resize-observer/dist/bundle.cjs.js) shows that when the
// observed `ref` resolves to `null` (which is exactly what Mafs passes when
// `width !== "auto"`), no `ResizeObserver` instance is ever constructed. So
// in practice this polyfill is not on Board's own critical path today — but
// it's added anyway per the T12 brief, as a defensive shim for any future
// `width="auto"` usage or other ResizeObserver-dependent code under test.
// Named *Polyfill to avoid colliding with the ambient `ResizeObserver` type
// lib.dom.d.ts already declares globally (this file has no import/export, so
// TS treats it as a global script, not a module — a same-named class here
// would be a duplicate-identifier error against that ambient declaration).
class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!('ResizeObserver' in globalThis)) {
  ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverPolyfill }).ResizeObserver =
    ResizeObserverPolyfill
}

// jsdom's layout engine always reports zero-size rects. Mafs reads
// `getBoundingClientRect()` for pointer-gesture math (pan/zoom/click-to-point
// coordinate conversion) — irrelevant to render-only smoke tests, but stubbed
// with a non-zero size so any future test that simulates a drag/click
// gesture on a Mafs canvas gets sane pixel math instead of silently dividing
// by a zero-width rect.
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
  const rect = originalGetBoundingClientRect.call(this)
  if (rect.width > 0 || rect.height > 0) return rect
  return { ...rect, width: 640, height: 360, right: rect.left + 640, bottom: rect.top + 360 } as DOMRect
}

// jsdom does not implement Element.scrollIntoView at all (calling it throws
// "not a function", even though lib.dom.d.ts declares it — this file only
// ever runs under Vitest's jsdom test environment, never a real browser, so
// unconditionally stubbing it is safe) — needed by board/Board.tsx's
// auto-follow (task P-B). Stubbed as a no-op here (rather than only in the
// one test file that exercises it) so any other test that happens to
// trigger it doesn't crash, and so tests can assert on calls via
// `vi.spyOn(Element.prototype, 'scrollIntoView')`.
Element.prototype.scrollIntoView = function (): void {}
