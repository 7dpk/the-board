import type { Action } from './protocol/actions'
import { COMPONENT_SPECS, type ComponentType } from './protocol/components'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SceneElement = {
  id: string
  c: ComponentType
  params: Record<string, number | string | boolean | unknown>
}

export type Control = {
  id: string
  k: string
  kind: 'slider' | 'drag' | 'input'
  min: number
  max: number
  step: number
  label?: string
}

export type Focus = { ids: string[]; style: 'highlight' | 'pulse' | 'dim-others' } | null

export type Scene = {
  elements: Record<string, SceneElement>
  order: string[]
  controls: Control[]
  focus: Focus
  steps: string[]
}

export const emptyScene: Scene = {
  elements: {},
  order: [],
  controls: [],
  focus: null,
  steps: [],
}

// ---------------------------------------------------------------------------
// DEFAULTS — the single place add-time defaults are filled in (protocol
// schemas deliberately have no `.default()`, so this table owns that job).
// ---------------------------------------------------------------------------

const DEFAULTS: Partial<Record<ComponentType, Record<string, number | string | boolean>>> = {
  axes: { grid: true },
  plot: { color: 'blue' },
  point: { color: 'red' },
  vector: { x1: 0, y1: 0, color: 'green' },
  segment: { color: 'gray' },
  area: { color: 'orange' },
  tangent: { color: 'purple' },
  projectile: { g: 9.8, t: 0, trace: true },
  incline: { mu: 0, mass: 1, showForces: true },
  pendulum: { t: 0, showForces: true },
  orbit: { t: 0, showVectors: true, showSweep: false }, // e is required, no inert default
  spring: { k: 100, mass: 1, t: 0, showForces: false },
  wave: { t: 0, standing: false },
  ray: { showLabels: true },
}

// ---------------------------------------------------------------------------
// niceStep — pick a "nice" slider step ~= range/100, snapped to 1/2/5 x 10^k.
// (Graphics-Gems-style "nice numbers" rounding.)
// ---------------------------------------------------------------------------

export function niceStep(range: number): number {
  const r = Math.abs(range)
  if (r === 0 || !Number.isFinite(r)) return 1
  const rough = r / 100
  const exp = Math.floor(Math.log10(rough))
  const base = Math.pow(10, exp)
  const f = rough / base
  const nice = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10
  return nice * base
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function applyAdd(scene: Scene, action: Extract<Action, { op: 'add' }>): Scene {
  const raw = action as unknown as Record<string, unknown>
  const { op: _op, c: _c, id: _id, ...params } = raw
  const defaults = DEFAULTS[action.c] ?? {}
  const merged: Record<string, unknown> = { ...defaults, ...params }

  // steps: `shown` defaults to "reveal every line" (lines.length), which
  // depends on the add's own `lines` array — a value the static DEFAULTS
  // table (fixed literals only, keyed purely by ComponentType) can't express.
  // Handled here as a one-off for this component rather than widening
  // DEFAULTS' type for every other component's sake.
  if (action.c === 'steps' && merged.shown === undefined) {
    merged.shown = Array.isArray(merged.lines) ? merged.lines.length : 0
  }

  const element: SceneElement = {
    id: action.id,
    c: action.c,
    params: merged,
  }
  const isNew = !(action.id in scene.elements)
  return {
    ...scene,
    elements: { ...scene.elements, [action.id]: element },
    order: isNew ? [...scene.order, action.id] : scene.order,
  }
}

function applyParamChange(scene: Scene, id: string, k: string, v: unknown): Scene {
  const el = scene.elements[id]
  if (!el) return scene
  return {
    ...scene,
    elements: { ...scene.elements, [id]: { ...el, params: { ...el.params, [k]: v } } },
  }
}

// Keep only the ids matching `keep` in a Focus, or null it out if none survive.
function filterFocus(focus: Focus, keep: (id: string) => boolean): Focus {
  if (!focus) return focus
  const ids = focus.ids.filter(keep)
  return ids.length ? { ...focus, ids } : null
}

function applyDel(scene: Scene, id: string): Scene {
  if (!(id in scene.elements)) return scene
  const elements = { ...scene.elements }
  delete elements[id]
  const order = scene.order.filter((oid) => oid !== id)
  const controls = scene.controls.filter((ctl) => ctl.id !== id)
  const focus = filterFocus(scene.focus, (fid) => fid !== id)
  return { ...scene, elements, order, controls, focus }
}

function applyClear(scene: Scene, keep: string[]): Scene {
  const keepSet = new Set(keep)
  const elements: Record<string, SceneElement> = {}
  const order: string[] = []
  for (const id of scene.order) {
    const el = scene.elements[id]
    if (keepSet.has(id) && el) {
      elements[id] = el
      order.push(id)
    }
  }
  const controls = scene.controls.filter((ctl) => keepSet.has(ctl.id))
  const focus = filterFocus(scene.focus, (id) => keepSet.has(id))
  return { ...scene, elements, order, controls, focus }
}

function applyCtl(scene: Scene, action: Extract<Action, { op: 'ctl' }>): Scene {
  const { id, k, kind, label } = action
  const el = scene.elements[id]
  const clamp = el ? COMPONENT_SPECS[el.c].clamps[k] : undefined
  const min = action.min ?? clamp?.min ?? -10
  const max = action.max ?? clamp?.max ?? 10
  const step = action.step ?? niceStep(max - min)
  const control: Control = { id, k, kind, min, max, step, label }
  const idx = scene.controls.findIndex((ctl) => ctl.id === id && ctl.k === k)
  const controls =
    idx >= 0
      ? scene.controls.map((ctl, i) => (i === idx ? control : ctl))
      : [...scene.controls, control]
  return { ...scene, controls }
}

function applyFocus(scene: Scene, action: Extract<Action, { op: 'focus' }>): Scene {
  if (action.style === 'none') return { ...scene, focus: null }
  const ids = action.ids.filter((id) => id in scene.elements)
  return { ...scene, focus: { ids, style: action.style } }
}

export function applyAction(scene: Scene, action: Action): Scene {
  switch (action.op) {
    case 'add':
      return applyAdd(scene, action)
    case 'set':
      return applyParamChange(scene, action.id, action.k, action.v)
    case 'anim':
      return applyParamChange(scene, action.id, action.k, action.to)
    case 'del':
      return applyDel(scene, action.id)
    case 'clear':
      return applyClear(scene, action.keep ?? [])
    case 'ctl':
      return applyCtl(scene, action)
    case 'focus':
      return applyFocus(scene, action)
    case 'step':
      return { ...scene, steps: [...scene.steps, action.title] }
    case 'say':
    case 'ask':
    case 'wish':
      return scene
    default:
      return scene
  }
}
