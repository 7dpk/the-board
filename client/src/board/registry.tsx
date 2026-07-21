// registry.tsx — maps ComponentType -> renderer, plus the effectiveParams
// helper and drag->event hook every renderer depends on (both actually
// implemented in ./params, re-exported here — see params.ts for why).
import type { FC } from 'react'
import type { ComponentType, SceneElement } from '@board/shared'
import {
  AreaRenderer,
  LabelRenderer,
  NumberlineRenderer,
  PlotRenderer,
  PointRenderer,
  SegmentRenderer,
  TableRenderer,
  TangentRenderer,
  VectorRenderer,
} from './math'
import { FbdRenderer, InclineRenderer, PendulumRenderer, ProjectileRenderer } from './physics'
import { OrbitRenderer, RayRenderer, SpringRenderer, WaveRenderer } from './physics2'
import { StepsRenderer } from './steps'

export { effectiveParams, onParamDrag, setParamDragHandler } from './params'

export type ElementRenderer = FC<{ el: SceneElement }>

// Partial, not Record<ComponentType, ...>: `axes` is never looked up here at
// all (Board.tsx special-cases it as the Mafs container element, not a child
// renderer) — every other ComponentType has an entry as of task-pe (steps +
// the JEE physics pack). Board.tsx still falls back to a small "unknown
// component" placeholder for any ComponentType with no entry (kept for
// forward-compat with future component types this registry hasn't caught up
// with yet).
export const registry: Partial<Record<ComponentType, ElementRenderer>> = {
  plot: PlotRenderer,
  point: PointRenderer,
  vector: VectorRenderer,
  segment: SegmentRenderer,
  area: AreaRenderer,
  tangent: TangentRenderer,
  label: LabelRenderer,
  numberline: NumberlineRenderer,
  table: TableRenderer,
  projectile: ProjectileRenderer,
  incline: InclineRenderer,
  pendulum: PendulumRenderer,
  fbd: FbdRenderer,
  steps: StepsRenderer,
  orbit: OrbitRenderer,
  spring: SpringRenderer,
  wave: WaveRenderer,
  ray: RayRenderer,
}
