import { z } from 'zod'

// ---------------------------------------------------------------------------
// Component type + color enums
// ---------------------------------------------------------------------------

export const COMPONENT_TYPES = [
  'axes', 'plot', 'point', 'vector', 'segment', 'area', 'tangent', 'label',
  'numberline', 'table', 'projectile', 'incline', 'pendulum', 'fbd', 'steps',
  'orbit', 'spring', 'wave', 'ray',
] as const
export type ComponentType = typeof COMPONENT_TYPES[number]

export const COLOR = ['blue', 'red', 'green', 'orange', 'purple', 'gray', 'gold'] as const
export const ColorEnum = z.enum(COLOR)
export type Color = z.infer<typeof ColorEnum>

// ---------------------------------------------------------------------------
// Add-variant schemas (one z.strictObject per component, discriminated on `c`)
// ---------------------------------------------------------------------------

const id = z.string()

const axesVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('axes'), id,
  xmin: z.number(), xmax: z.number(), ymin: z.number(), ymax: z.number(),
  xl: z.string().optional(), yl: z.string().optional(),
  grid: z.boolean().optional(),
})

const plotVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('plot'), id,
  on: z.string(), expr: z.string(), color: ColorEnum.optional(), dash: z.boolean().optional(),
})

const pointVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('point'), id,
  on: z.string(), x: z.number(), y: z.number(),
  label: z.string().optional(), color: ColorEnum.optional(),
})

const vectorVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('vector'), id,
  on: z.string(), x2: z.number(), y2: z.number(),
  x1: z.number().optional(), y1: z.number().optional(),
  label: z.string().optional(), color: ColorEnum.optional(),
})

const segmentVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('segment'), id,
  on: z.string(), x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
  label: z.string().optional(), dash: z.boolean().optional(), color: ColorEnum.optional(),
})

const areaVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('area'), id,
  on: z.string(), expr: z.string(), from: z.number(), to: z.number(), color: ColorEnum.optional(),
})

const tangentVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('tangent'), id,
  on: z.string(), expr: z.string(), at: z.number(), color: ColorEnum.optional(),
})

const labelVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('label'), id,
  tex: z.string(), on: z.string().optional(), x: z.number().optional(), y: z.number().optional(),
})

const numberlineVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('numberline'), id,
  min: z.number(), max: z.number(), marks: z.array(z.number()).optional(),
})

const tableVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('table'), id,
  cols: z.array(z.string()), rows: z.array(z.array(z.string())),
})

const projectileVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('projectile'), id,
  v0: z.number(), deg: z.number(), g: z.number().optional(), t: z.number().optional(),
  trace: z.boolean().optional(),
})

const inclineVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('incline'), id,
  deg: z.number(), mu: z.number().optional(), mass: z.number().optional(),
  showForces: z.boolean().optional(),
})

const pendulumVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('pendulum'), id,
  length: z.number(), deg0: z.number(), t: z.number().optional(), showForces: z.boolean().optional(),
})

const forceEntry = z.strictObject({ name: z.string(), deg: z.number(), mag: z.number() })

const fbdVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('fbd'), id,
  label: z.string(), forces: z.array(forceEntry),
})

// steps: a worked-derivation card (task-pa, user feedback (a) "solved
// systematically"). `lines` is one KaTeX string per equation-transformation;
// `notes` is a parallel, optional array of short plain-text justifications
// (same index = same line). `shown` controls how many lines are currently
// revealed, so a beat can `add` with shown:1 and `anim` it upward to narrate
// one line at a time — see COMPONENT_SPECS.steps below and scene.ts's
// applyAdd for the dynamic (lines.length) default. Unrelated to Scene.steps
// (the array of beat titles pushed by the `step` op) — same word, different
// concept: one is a component type, the other a top-level scene field.
const stepsVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('steps'), id,
  title: z.string().optional(),
  lines: z.array(z.string()),
  notes: z.array(z.string()).optional(),
  shown: z.number().optional(),
})

// ---------------------------------------------------------------------------
// JEE-physics pack (task-pd): orbit/spring/wave/ray. All four are standalone
// (like projectile/incline/pendulum/fbd above) — never `on` an axes; see
// prompt.ts's standalone list and sanitize.ts's AXIS_PARAM_MAP, which
// intentionally omits them for the same reason.
// ---------------------------------------------------------------------------

const orbitVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('orbit'), id,
  a: z.number(), e: z.number(), t: z.number().optional(),
  showVectors: z.boolean().optional(),
  centerLabel: z.string().optional(), bodyLabel: z.string().optional(),
  // task-s2 (feedback: "kepler laws didn't shade the area"): plain optional
  // boolean, no new clamp — see COMPONENT_SPECS.orbit's doc for the
  // shaded-sector semantics and physics2.tsx's OrbitRenderer for the sweep
  // geometry.
  showSweep: z.boolean().optional(),
})

const springVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('spring'), id,
  amp: z.number(), k: z.number().optional(), mass: z.number().optional(),
  t: z.number().optional(), showForces: z.boolean().optional(),
})

const waveVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('wave'), id,
  amp: z.number(), wavelength: z.number(), freq: z.number(),
  t: z.number().optional(), standing: z.boolean().optional(),
})

export const RAY_KIND = ['convex-lens', 'concave-lens', 'concave-mirror', 'convex-mirror'] as const
export const RayKindEnum = z.enum(RAY_KIND)
export type RayKind = z.infer<typeof RayKindEnum>

const rayVariant = z.strictObject({
  op: z.literal('add'), c: z.literal('ray'), id,
  kind: RayKindEnum, objectDist: z.number(), focalLength: z.number(),
  showLabels: z.boolean().optional(),
})

export const addVariants = z.discriminatedUnion('c', [
  axesVariant, plotVariant, pointVariant, vectorVariant, segmentVariant, areaVariant,
  tangentVariant, labelVariant, numberlineVariant, tableVariant, projectileVariant,
  inclineVariant, pendulumVariant, fbdVariant, stepsVariant,
  orbitVariant, springVariant, waveVariant, rayVariant,
])
export type AddAction = z.infer<typeof addVariants>

// ---------------------------------------------------------------------------
// COMPONENT_SPECS — docs, examples, clamps, animatable/controllable keys
// ---------------------------------------------------------------------------

export interface ComponentSpec {
  doc: string
  example: string
  clamps: Record<string, { min: number; max: number }>
  animatable: string[]
  controllable: string[]
}

export const COMPONENT_SPECS: Record<ComponentType, ComponentSpec> = {
  axes: {
    doc: 'Cartesian axes that other components attach to via on=<axes id>. Set xmin,xmax,ymin,ymax for the viewport and optional xl/yl to label the axes. Set grid:false for clean diagrams like orbits/ray optics.',
    example: '{"op":"add","c":"axes","id":"ax1","xmin":-10,"xmax":10,"ymin":-10,"ymax":10}',
    clamps: {
      xmin: { min: -1000, max: 1000 }, xmax: { min: -1000, max: 1000 },
      ymin: { min: -1000, max: 1000 }, ymax: { min: -1000, max: 1000 },
    },
    animatable: [],
    controllable: [],
  },
  plot: {
    doc: 'Graph of a function of x on an axes. expr is a mathjs expression, e.g. "x^2 - 4". Requires on=<axes id>.',
    example: '{"op":"add","c":"plot","id":"pl1","on":"ax1","expr":"x^2 - 4"}',
    clamps: {},
    animatable: [],
    controllable: [],
  },
  point: {
    doc: 'A draggable point at (x,y) on an axes; dragging moves both x and y. Requires on=<axes id>.',
    example: '{"op":"add","c":"point","id":"pt1","on":"ax1","x":2,"y":3}',
    clamps: { x: { min: -1000, max: 1000 }, y: { min: -1000, max: 1000 } },
    animatable: ['x', 'y'],
    controllable: ['x', 'y'],
  },
  vector: {
    doc: 'An arrow from (x1,y1), default the origin, to (x2,y2) on an axes; dragging moves the head. Requires on=<axes id>.',
    example: '{"op":"add","c":"vector","id":"v1","on":"ax1","x2":3,"y2":4}',
    clamps: {
      x1: { min: -1000, max: 1000 }, y1: { min: -1000, max: 1000 },
      x2: { min: -1000, max: 1000 }, y2: { min: -1000, max: 1000 },
    },
    animatable: ['x2', 'y2'],
    controllable: ['x2', 'y2'],
  },
  segment: {
    doc: 'A straight line segment between (x1,y1) and (x2,y2) on an axes; optional color (default gray). Requires on=<axes id>.',
    example: '{"op":"add","c":"segment","id":"s1","on":"ax1","x1":0,"y1":0,"x2":4,"y2":4}',
    clamps: {
      x1: { min: -1000, max: 1000 }, y1: { min: -1000, max: 1000 },
      x2: { min: -1000, max: 1000 }, y2: { min: -1000, max: 1000 },
    },
    animatable: ['x1', 'y1', 'x2', 'y2'],
    controllable: [],
  },
  area: {
    doc: 'Shaded region under expr between x=from and x=to on an axes. Requires on=<axes id>.',
    example: '{"op":"add","c":"area","id":"ar1","on":"ax1","expr":"x^2","from":0,"to":2}',
    clamps: { from: { min: -1000, max: 1000 }, to: { min: -1000, max: 1000 } },
    animatable: ['from', 'to'],
    controllable: ['from', 'to'],
  },
  tangent: {
    doc: 'Tangent line to expr at x=at on an axes. Requires on=<axes id>.',
    example: '{"op":"add","c":"tangent","id":"tg1","on":"ax1","expr":"x^2","at":1}',
    clamps: { at: { min: -1000, max: 1000 } },
    animatable: ['at'],
    controllable: ['at'],
  },
  label: {
    doc: 'A KaTeX-rendered math label; anchored at (x,y) on an axes if on is set, otherwise floats free.',
    example: '{"op":"add","c":"label","id":"lb1","tex":"E=mc^2","on":"ax1","x":0,"y":5}',
    clamps: { x: { min: -1000, max: 1000 }, y: { min: -1000, max: 1000 } },
    animatable: [],
    controllable: [],
  },
  numberline: {
    doc: 'A 1D number line spanning min to max with optional tick marks at the given values.',
    example: '{"op":"add","c":"numberline","id":"nl1","min":0,"max":10,"marks":[2,4,6]}',
    clamps: { min: { min: -1e6, max: 1e6 }, max: { min: -1e6, max: 1e6 } },
    animatable: [],
    controllable: [],
  },
  table: {
    doc: 'A simple data table rendered from header cols and string rows.',
    example: '{"op":"add","c":"table","id":"tb1","cols":["x","y"],"rows":[["1","2"],["3","4"]]}',
    clamps: {},
    animatable: [],
    controllable: [],
  },
  projectile: {
    doc: 'Projectile motion trajectory launched at speed v0 and angle deg; t is the normalized 0..1 progress through the flight.',
    example: '{"op":"add","c":"projectile","id":"p1","v0":20,"deg":45}',
    clamps: {
      v0: { min: 1, max: 100 }, deg: { min: 5, max: 85 },
      g: { min: 1, max: 30 }, t: { min: 0, max: 1 },
    },
    animatable: ['t', 'deg', 'v0'],
    controllable: ['deg', 'v0', 't'],
  },
  incline: {
    doc: 'An inclined plane at angle deg with optional friction coefficient mu and block mass; showForces overlays force vectors.',
    example: '{"op":"add","c":"incline","id":"in1","deg":30,"mu":0.2,"mass":5}',
    clamps: { deg: { min: 5, max: 60 }, mu: { min: 0, max: 1.5 }, mass: { min: 0.1, max: 100 } },
    animatable: ['deg', 'mu'],
    controllable: ['deg', 'mu', 'mass'],
  },
  pendulum: {
    doc: 'A simple pendulum of given length swinging from deg0; angle over time follows theta(t)=deg0*cos(sqrt(g/length)*t).',
    example: '{"op":"add","c":"pendulum","id":"pd1","length":2,"deg0":30}',
    clamps: { length: { min: 0.5, max: 5 }, deg0: { min: -60, max: 60 }, t: { min: 0, max: 120 } },
    animatable: ['t', 'length', 'deg0'],
    controllable: ['length', 'deg0'],
  },
  fbd: {
    doc: 'A free-body diagram: a labeled point with a list of force vectors {name,deg,mag}, at most 6 forces.',
    example: '{"op":"add","c":"fbd","id":"fb1","label":"Block","forces":[{"name":"gravity","deg":270,"mag":50}]}',
    clamps: { mag: { min: 0, max: 1000 }, deg: { min: 0, max: 360 } },
    animatable: [],
    controllable: [],
  },
  steps: {
    doc: 'Worked derivation card: solve/derive step by step, one transformation per line; reveal progressively by animating shown.',
    example: '{"op":"add","c":"steps","id":"st1","title":"Solve for x","lines":["2x + 3 = 11","2x = 8","x = 4"],"notes":["subtract 3 from both sides","divide both sides by 2"],"shown":1}',
    clamps: { shown: { min: 0, max: 40 } },
    animatable: ['shown'],
    controllable: ['shown'],
  },
  orbit: {
    doc: 'Elliptical orbit around a central body (Kepler): body sweeps with correct speed variation; use for gravitation/planetary motion. showSweep shades the area swept over a fixed time window — Kepler\'s second law: equal areas in equal times.',
    example: '{"op":"add","c":"orbit","id":"orb1","a":40,"e":0.4,"showVectors":true,"showSweep":true,"centerLabel":"Sun","bodyLabel":"Earth"}',
    clamps: { a: { min: 1, max: 100 }, e: { min: 0, max: 0.9 }, t: { min: 0, max: 1 } },
    animatable: ['t', 'e', 'a'],
    controllable: ['e', 'a', 't'],
  },
  spring: {
    doc: 'SHM mass-spring: x(t)=amp*cos(sqrt(k/mass)*t); k and mass set the oscillation frequency. showForces draws the restoring-force arrow.',
    example: '{"op":"add","c":"spring","id":"sp1","amp":2,"showForces":true}',
    clamps: {
      amp: { min: 0.1, max: 10 }, k: { min: 1, max: 1000 },
      mass: { min: 0.1, max: 100 }, t: { min: 0, max: 120 },
    },
    animatable: ['t', 'amp'],
    controllable: ['k', 'mass', 'amp'],
  },
  wave: {
    doc: 'Traveling wave y=amp*sin(2*pi*(x/wavelength-freq*t)); standing:true for a standing wave instead.',
    example: '{"op":"add","c":"wave","id":"w1","amp":2,"wavelength":4,"freq":1,"standing":false}',
    clamps: {
      amp: { min: 0.1, max: 10 }, wavelength: { min: 0.5, max: 50 },
      freq: { min: 0.05, max: 20 }, t: { min: 0, max: 120 },
    },
    animatable: ['t', 'amp', 'wavelength', 'freq'],
    controllable: ['amp', 'wavelength', 'freq'],
  },
  ray: {
    doc: 'Ray-optics diagram: principal rays + computed image for a lens/mirror; image position follows the lens/mirror formula. kind: convex-lens, concave-lens, concave-mirror, or convex-mirror.',
    example: '{"op":"add","c":"ray","id":"ry1","kind":"convex-lens","objectDist":20,"focalLength":10,"showLabels":true}',
    clamps: { objectDist: { min: 1, max: 100 }, focalLength: { min: 1, max: 50 } },
    animatable: ['objectDist'],
    controllable: ['objectDist', 'focalLength'],
  },
}
