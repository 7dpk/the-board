import { ActionSchema, type Action } from './protocol/actions'
import { COMPONENT_SPECS, ColorEnum, type ComponentType } from './protocol/components'
import type { Scene } from './scene'
import { isSafeExpr } from './expr'

// ---------------------------------------------------------------------------
// sanitizeAction — the trust boundary. Every LLM-emitted action passes through
// here before it is allowed to touch a Scene. Rule order is normative:
//   (1) parse -> (2) id-normalize -> (3) reference checks -> (4) key checks
//   -> (5) clamp -> (6) expr safety -> (7) ask arity
// sanitizeAction never mutates `raw`; it returns a repaired copy.
// ---------------------------------------------------------------------------

export type SanitizeResult = { ok: true; action: Action } | { ok: false; reason: string }

export function sanitizeId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24)
}

function fail(reason: string): SanitizeResult {
  return { ok: false, reason }
}

function clampNum(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

// Ordered (lo, hi) param pairs that must be swapped if given inverted.
const ORDERED_PAIRS: Partial<Record<ComponentType, [string, string][]>> = {
  axes: [['xmin', 'xmax'], ['ymin', 'ymax']],
  numberline: [['min', 'max']],
  area: [['from', 'to']],
}

const SET_EXTRA_KEYS = ['expr', 'label', 'tex', 'color']

// task-19 nit (c): the components whose add-variant schema actually declares
// a `color` field (shared/src/protocol/components.ts) — kept in sync with the
// prompt's own documented eligibility line (shared/src/prompt.ts: "Only
// plot, point, vector, area, tangent, and segment accept a color."). `set
// k='color'` reached the generic SET_EXTRA_KEYS allow-list for every
// component regardless of type, and accepted any string as the value —
// tightened below to require both an eligible target AND a real ColorEnum
// member.
const COLOR_ELIGIBLE_COMPONENTS: ReadonlySet<ComponentType> = new Set([
  'plot',
  'point',
  'vector',
  'segment',
  'area',
  'tangent',
])

// task-19 nit (d): a cheap KaTeX-DoS guard — label.tex / say.text / a set of
// k=tex|label are LLM-authored strings with no schema-level length bound
// (zod min/max can't be expressed for the structured-output JSON-schema
// translation — see actions.ts). Truncate rather than fail: a too-long
// string is still perfectly renderable once cut down, no need to drop the
// whole action over it.
const MAX_TEX_LEN = 2000
function clampTexLen(s: string): string {
  return s.length > MAX_TEX_LEN ? s.slice(0, MAX_TEX_LEN) : s
}

// task-pa (1): same DoS-guard rationale as clampTexLen above, sized for the
// steps component's `lines`/`notes` — an LLM-authored derivation could in
// principle emit an unbounded number of unbounded-length strings. Truncate
// per-string at MAX_STEPS_LINE_LEN and cap the array at MAX_STEPS_LINES
// (dropping extras) rather than failing the whole action.
const MAX_STEPS_LINE_LEN = 500
const MAX_STEPS_LINES = 20
function clampStepsLine(s: string): string {
  return s.length > MAX_STEPS_LINE_LEN ? s.slice(0, MAX_STEPS_LINE_LEN) : s
}

// task-pd: wish — same DoS-guard rationale, sized for the short
// component-name/reason strings a `wish` action carries. Always truncates,
// never fails (unlike every other op above, `wish` has no reference/key/expr
// checks to run at all — it isn't tied to any scene element).
const MAX_WISH_COMPONENT_LEN = 60
const MAX_WISH_WHY_LEN = 300

// task-pa (2): on-axes coordinate clamping (user feedback (d) "drawing out
// of the board"). Maps each coordinate-bearing param of an on-axes child
// component to the axis ('x' or 'y') whose range it must be clamped into.
// Only components that can carry `on` and have coordinate params are listed;
// physics components (projectile/incline/pendulum/fbd) and free labels are
// standalone and intentionally absent, so they're never looked up here.
const AXIS_PARAM_MAP: Partial<Record<ComponentType, Record<string, 'x' | 'y'>>> = {
  point: { x: 'x', y: 'y' },
  vector: { x1: 'x', y1: 'y', x2: 'x', y2: 'y' },
  segment: { x1: 'x', y1: 'y', x2: 'x', y2: 'y' },
  area: { from: 'x', to: 'x' },
  tangent: { at: 'x' },
  label: { x: 'x', y: 'y' },
}

type AxesRange = { xmin: number; xmax: number; ymin: number; ymax: number }

// Resolves `axesId` against the scene and returns its viewport range, or null
// if it isn't (yet, or any longer) a real axes element — callers treat null
// as "nothing to clamp against" rather than an error.
function axesRangeFor(scene: Scene, axesId: unknown): AxesRange | null {
  if (typeof axesId !== 'string') return null
  const axesEl = scene.elements[axesId]
  if (!axesEl || axesEl.c !== 'axes') return null
  const { xmin, xmax, ymin, ymax } = axesEl.params as Record<string, unknown>
  if (
    typeof xmin !== 'number' || typeof xmax !== 'number' ||
    typeof ymin !== 'number' || typeof ymax !== 'number'
  ) {
    return null
  }
  return { xmin, xmax, ymin, ymax }
}

function clampToAxis(v: number, axis: 'x' | 'y', range: AxesRange): number {
  return axis === 'x' ? clampNum(v, range.xmin, range.xmax) : clampNum(v, range.ymin, range.ymax)
}

export function sanitizeAction(raw: unknown, scene: Scene): SanitizeResult {
  // (1) schema parse
  const parsed = ActionSchema.safeParse(raw)
  if (!parsed.success) return fail('invalid action: does not match ActionSchema')

  // Work on a shallow clone so `raw`/`parsed.data` are never mutated.
  const action = { ...parsed.data } as unknown as Record<string, unknown>

  // (2) normalize ids on every id/ids/keep/on/sync field
  if (typeof action.id === 'string') {
    action.id = sanitizeId(action.id)
    // A primary id that sanitizes down to '' (e.g. '!!!' — all chars stripped)
    // is unusable: it can neither be referenced nor addressed. Fail the whole
    // action rather than proceeding with an empty id.
    if (action.id === '') return fail('invalid id')
  }
  if (typeof action.on === 'string') action.on = sanitizeId(action.on)
  if (typeof action.sync === 'string') action.sync = sanitizeId(action.sync)
  if (Array.isArray(action.ids)) action.ids = (action.ids as string[]).map(sanitizeId)
  if (Array.isArray(action.keep)) action.keep = (action.keep as string[]).map(sanitizeId)

  const op = action.op as Action['op']

  // (3) reference checks
  if (op === 'set' || op === 'anim' || op === 'del' || op === 'ctl') {
    const id = action.id as string
    if (!(id in scene.elements)) return fail(`unknown id: ${id}`)
  }

  if (op === 'add' && typeof action.on === 'string') {
    const target = scene.elements[action.on]
    if (!target || target.c !== 'axes') {
      return fail(`add.on must reference an existing axes id: ${action.on as string}`)
    }
  }

  if (op === 'focus') {
    const ids = (action.ids as string[]).filter((id) => id in scene.elements)
    if (ids.length === 0 && action.style !== 'none') return fail('empty focus list')
    action.ids = ids
  }

  if (op === 'clear' && Array.isArray(action.keep)) {
    action.keep = (action.keep as string[]).filter((id) => id in scene.elements)
  }

  if (op === 'say' && typeof action.sync === 'string' && !(action.sync in scene.elements)) {
    delete action.sync
  }

  // (4) key checks: set/anim/ctl `k` must be in the target component's
  // animatable/controllable list respectively (set also allows expr/label/tex/color).
  if (op === 'set' || op === 'anim' || op === 'ctl') {
    const id = action.id as string
    const k = action.k as string
    const el = scene.elements[id]
    if (!el) return fail(`unknown id: ${id}`) // defensive; already checked above
    const spec = COMPONENT_SPECS[el.c]

    if (op === 'anim') {
      if (!spec.animatable.includes(k)) return fail(`key not animatable: ${k}`)
    } else if (op === 'ctl') {
      if (!spec.controllable.includes(k)) return fail(`key not controllable: ${k}`)
    } else {
      const allowed = new Set([...spec.animatable, ...spec.controllable, ...SET_EXTRA_KEYS])
      if (!allowed.has(k)) return fail(`key not settable: ${k}`)

      // task-19 nit (c): `color` additionally needs an eligible target type
      // and a real ColorEnum value — SET_EXTRA_KEYS alone (checked just
      // above) only gates the *key name*, not who may set it or to what.
      if (k === 'color') {
        if (!COLOR_ELIGIBLE_COMPONENTS.has(el.c)) return fail(`color not settable on component type: ${el.c}`)
        if (typeof action.v !== 'string' || !ColorEnum.safeParse(action.v).success) {
          return fail(`invalid color value: ${String(action.v)}`)
        }
      }
    }
  }

  // (5) clamps
  if (op === 'add') {
    const c = action.c as ComponentType
    const spec = COMPONENT_SPECS[c]

    if (c === 'fbd' && Array.isArray(action.forces)) {
      const forceClamp = spec.clamps
      action.forces = (action.forces as Record<string, unknown>[]).slice(0, 6).map((f) => {
        const force = { ...f }
        if (typeof force.mag === 'number' && forceClamp.mag) {
          force.mag = clampNum(force.mag, forceClamp.mag.min, forceClamp.mag.max)
        }
        if (typeof force.deg === 'number' && forceClamp.deg) {
          force.deg = clampNum(force.deg, forceClamp.deg.min, forceClamp.deg.max)
        }
        return force
      })
    } else {
      for (const [key, range] of Object.entries(spec.clamps)) {
        if (typeof action[key] === 'number') {
          action[key] = clampNum(action[key] as number, range.min, range.max)
        }
      }
    }

    const pairs = ORDERED_PAIRS[c]
    if (pairs) {
      for (const [loKey, hiKey] of pairs) {
        const lo = action[loKey]
        const hi = action[hiKey]
        if (typeof lo === 'number' && typeof hi === 'number' && lo > hi) {
          action[loKey] = hi
          action[hiKey] = lo
        }
      }
    }

    // task-pa (2): global +-1000 clamps (above) apply first; this narrows
    // further into the parent axes' own viewport, if it's attached to one.
    const axisParams = AXIS_PARAM_MAP[c]
    if (axisParams && typeof action.on === 'string') {
      const range = axesRangeFor(scene, action.on)
      if (range) {
        for (const [key, axis] of Object.entries(axisParams)) {
          if (typeof action[key] === 'number') {
            action[key] = clampToAxis(action[key] as number, axis, range)
          }
        }
      }
    }

    // task-pa (1): steps — truncate lines/notes and narrow `shown` (already
    // clamped to [0,40] by the generic clamps loop above) down to the actual
    // (possibly-just-truncated) line count.
    if (c === 'steps' && Array.isArray(action.lines)) {
      const lines = (action.lines as unknown[])
        .filter((l): l is string => typeof l === 'string')
        .slice(0, MAX_STEPS_LINES)
        .map(clampStepsLine)
      action.lines = lines

      if (Array.isArray(action.notes)) {
        action.notes = (action.notes as unknown[])
          .filter((n): n is string => typeof n === 'string')
          .slice(0, lines.length)
          .map(clampStepsLine)
      }

      if (typeof action.shown === 'number') {
        action.shown = clampNum(action.shown, 0, lines.length)
      }
    }
  }

  if (op === 'set' || op === 'anim') {
    const id = action.id as string
    const k = action.k as string
    const el = scene.elements[id]
    const targetClamp = el ? COMPONENT_SPECS[el.c].clamps[k] : undefined

    // task-pa (3): steps.shown special case — clamp against lines.length,
    // not the static spec range [0,40]. This mirrors the add-time logic above.
    if (el && el.c === 'steps' && k === 'shown') {
      const linesLen = Array.isArray(el.params.lines) ? el.params.lines.length : 0
      if (op === 'set' && typeof action.v === 'number') {
        action.v = clampNum(action.v, 0, linesLen)
      } else if (op === 'anim' && typeof action.to === 'number') {
        action.to = clampNum(action.to, 0, linesLen)
      }
    } else if (targetClamp) {
      if (op === 'set' && typeof action.v === 'number') {
        action.v = clampNum(action.v, targetClamp.min, targetClamp.max)
      } else if (op === 'anim' && typeof action.to === 'number') {
        action.to = clampNum(action.to, targetClamp.min, targetClamp.max)
      }
    }
    if (typeof action.dur === 'number') {
      action.dur = clampNum(action.dur, 0.1, 10)
    }

    // Enforce ordered pairs for area from/to on set/anim: clamp incoming value to sibling
    if (el && el.c === 'area') {
      if (k === 'from' && typeof el.params.to === 'number') {
        const incomingVal = op === 'set' ? (action.v as unknown) : (action.to as unknown)
        if (typeof incomingVal === 'number' && incomingVal > el.params.to) {
          // Clamp incoming from to sibling to value to maintain from ≤ to
          if (op === 'set') action.v = el.params.to as number
          else action.to = el.params.to as number
        }
      } else if (k === 'to' && typeof el.params.from === 'number') {
        const incomingVal = op === 'set' ? (action.v as unknown) : (action.to as unknown)
        if (typeof incomingVal === 'number' && incomingVal < el.params.from) {
          // Clamp incoming to to sibling from value to maintain from ≤ to
          if (op === 'set') action.v = el.params.from as number
          else action.to = el.params.from as number
        }
      }
    }

    // task-pa (2): mirror the add-time on-axes clamp above for set/anim,
    // using the target element's own recorded `on` (the axes it was added
    // to) rather than anything on the incoming action.
    if (el) {
      const axis = AXIS_PARAM_MAP[el.c]?.[k]
      if (axis) {
        const range = axesRangeFor(scene, el.params.on)
        if (range) {
          if (op === 'set' && typeof action.v === 'number') {
            action.v = clampToAxis(action.v, axis, range)
          } else if (op === 'anim' && typeof action.to === 'number') {
            action.to = clampToAxis(action.to, axis, range)
          }
        }
      }
    }
  }

  if (op === 'ctl') {
    const id = action.id as string
    const k = action.k as string
    const el = scene.elements[id]
    const targetClamp = el ? COMPONENT_SPECS[el.c].clamps[k] : undefined

    // task-pa (3): steps.shown special case — clamp min/max against lines.length,
    // not the static spec range [0,40]. This mirrors the set/anim logic above.
    if (el && el.c === 'steps' && k === 'shown') {
      const linesLen = Array.isArray(el.params.lines) ? el.params.lines.length : 0
      if (typeof action.min === 'number') {
        action.min = clampNum(action.min, 0, linesLen)
      }
      if (typeof action.max === 'number') {
        action.max = clampNum(action.max, 0, linesLen)
      }
    } else if (targetClamp) {
      if (typeof action.min === 'number') {
        action.min = clampNum(action.min, targetClamp.min, targetClamp.max)
      }
      if (typeof action.max === 'number') {
        action.max = clampNum(action.max, targetClamp.min, targetClamp.max)
      }
    }
    if (typeof action.min === 'number' && typeof action.max === 'number' && action.min > action.max) {
      const tmp = action.min
      action.min = action.max
      action.max = tmp
    }
  }

  // (5b) string length guard: label.tex / say.text / set(k=tex|label).v —
  // truncate rather than fail (task-19 nit d).
  if (op === 'add' && action.c === 'label' && typeof action.tex === 'string') {
    action.tex = clampTexLen(action.tex)
  }
  if (op === 'say' && typeof action.text === 'string') {
    action.text = clampTexLen(action.text)
  }
  if (op === 'set' && (action.k === 'tex' || action.k === 'label') && typeof action.v === 'string') {
    action.v = clampTexLen(action.v)
  }
  if (op === 'wish') {
    if (typeof action.component === 'string') action.component = action.component.slice(0, MAX_WISH_COMPONENT_LEN)
    if (typeof action.why === 'string') action.why = action.why.slice(0, MAX_WISH_WHY_LEN)
  }

  // (6) expr safety: add.expr, and set.v when k === 'expr'
  if (op === 'add' && typeof action.expr === 'string') {
    if (!isSafeExpr(action.expr)) return fail(`unsafe expr: ${action.expr}`)
  }
  if (op === 'set' && action.k === 'expr') {
    if (typeof action.v !== 'string') {
      return fail('expr value must be a string')
    }
    if (!isSafeExpr(action.v)) return fail(`unsafe expr: ${action.v}`)
  }

  // (7) ask arity: mcq requires >=2 options
  if (op === 'ask' && action.kind === 'mcq') {
    const options = action.options as string[] | undefined
    if (!options || options.length < 2) return fail('mcq requires at least 2 options')
  }

  return { ok: true, action: action as unknown as Action }
}
