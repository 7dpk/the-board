// params.ts — effectiveParams + the drag -> tutor-event hook point.
//
// Split out from registry.tsx (which re-exports everything here) purely to
// avoid a registry.tsx <-> math.tsx circular import: math.tsx's renderers
// need effectiveParams/onParamDrag, and registry.tsx needs math.tsx's
// renderer components to build the `registry` map. Both import from here
// instead of from each other; registry.tsx still re-exports these names so
// `import { effectiveParams } from './registry'` (the brief's documented
// interface) keeps working for consumers.
import type { SceneElement } from '@board/shared'
import { useBoard } from '../store'

// Merges liveOverrides[el.id] (transient tween/drag values) over el.params.
// Every renderer MUST read params through this, never `el.params` directly —
// it's how tweens and drags render at 60fps without waiting for a commit.
export function effectiveParams(el: SceneElement): SceneElement['params'] {
  const overrides = useBoard.getState().liveOverrides[el.id]
  return overrides ? { ...el.params, ...overrides } : el.params
}

// Module-level drag -> tutor-event hook. T14 wires a debounced emitter in
// via setParamDragHandler(emitParamEvent); until then it's a no-op, so
// dragging a point in T12/T13 is safe even before T14 lands.
export let onParamDrag: ((id: string, k: string, from: number, to: number) => void) | undefined

export function setParamDragHandler(fn: typeof onParamDrag): void {
  onParamDrag = fn
}
