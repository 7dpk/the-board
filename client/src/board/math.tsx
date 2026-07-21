// math.tsx — Mafs-backed renderers for the board's math component pack.
//
// Every renderer is a `React.FC<{ el: SceneElement }>` registered in
// registry.tsx; each reads its parameters through `effectiveParams` (never
// `el.params` directly) so live drag/tween overrides render at 60fps without
// waiting for a store commit.
import { useEffect, useMemo, useReducer, useRef } from 'react'
import type { FC } from 'react'
import {
  Coordinates,
  Line,
  MovablePoint,
  Plot,
  Point as MafsPoint,
  Polygon,
  Text as MafsText,
  useTransformContext,
  Vector as MafsVector,
  vec,
} from 'mafs'
import katex from 'katex'
import { compileExpr, formatNum, niceStep, type Color, type SceneElement } from '@board/shared'
import { useBoard } from '../store'
import { effectiveParams, onParamDrag } from './params'
import { Katex } from './Katex'

// Series palette — "Lamplight" design pass. The 7 enum NAMES are fixed by the
// shared `Color` type; only the hexes changed. This set is stepped for the dark
// board surface (--surface-1 #1c1915) and validated as a categorical palette by
// the dataviz skill's validate_palette.js:
//
//   node validate_palette.js "#df5b5b,#4a90e2,#d9772e,#33a578,#ba8712,#9a78e0,#b58c3e" \
//     --mode dark --surface "#1c1915"
//   [PASS] Lightness band      all 7 inside L 0.48–0.67
//   [PASS] Chroma floor        all 7 >= 0.1
//   [PASS] CVD separation      worst adjacent green↔orange ΔE 9.7 (protan) · tritan 9.9
//   [PASS] Normal-vision floor worst adjacent gold↔green ΔE 16.7
//   [PASS] Contrast vs surface all 7 >= 3:1  → ALL CHECKS PASS (exit 0)
//
// The KEY ORDER below IS the validated adjacency order (max-min-ΔE ordering the
// validator was run against) — physics.tsx's `COLOR_CYCLE = Object.values(COLORS)`
// walks it for FBD force colors, so keeping it in this order gives cycled marks
// the same separation the validator certifies. `gold` is the board's "active
// body" mark (ball/bob/satellite/orbit-centre); the brighter UI lamplight accent
// is a separate token (--accent in styles.css), decoupled so data marks stay in
// the validated band while chrome can glow.
export const COLORS: Record<Color, string> = {
  red: '#df5b5b',
  blue: '#4a90e2',
  orange: '#d9772e',
  green: '#33a578',
  gold: '#ba8712',
  purple: '#9a78e0',
  gray: '#b58c3e',
}

// ---------------------------------------------------------------------------
// Small, defensive readers over a params bag typed as
// Record<string, number | string | boolean | unknown> — LLM-authored/replayed
// scenes should never crash the board on a missing or wrong-typed field.
// ---------------------------------------------------------------------------
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function bool(v: unknown): boolean {
  return v === true
}

function colorOf(v: unknown, fallback: Color): string {
  return COLORS[typeof v === 'string' && v in COLORS ? (v as Color) : fallback]
}

// ---------------------------------------------------------------------------
// plot
// ---------------------------------------------------------------------------
// Renderer-level expr morph (task-s2, "more ways to visualize... 3b1b feel"):
// timeline.ts's `set`+`dur` tweening only handles NUMERIC params
// (`typeof action.v === 'number'`, see runAction's 'set' case) — an expr
// change instantly swaps the plotted function at commit with no animation.
// This morphs the transition locally instead, entirely inside the
// component: keep the fn compiled from the PREVIOUS expr around for
// PLOT_MORPH_MS after a change, and render y = (1-p)*f_old(x) + p*f_new(x),
// p driven 0->1 by a local rAF loop. Deliberately NOT routed through the
// store's liveOverrides — that bag only ever carries numeric per-element
// params (see params.ts), and an interpolation weight between two whole
// FUNCTIONS has no numeric param to live under, so there is nothing here
// for it to fight with.
const PLOT_MORPH_MS = 600

// fix (task-s2 review, fix round 1): freezes an in-flight from/to morph's
// blend weight `p` at the CURRENT instant into a standalone function. Used
// when a second expr change interrupts an already-running morph, so the new
// morph continues from the exact value that was actually on screen rather
// than snapping back to either endpoint — see the `if (expr !== ...)` block
// below for why that snap used to happen.
function blendAt(
  fromFn: (x: number) => number,
  toFn: (x: number) => number,
  startedAt: number,
): (x: number) => number {
  const p = Math.min(1, Math.max(0, (performance.now() - startedAt) / PLOT_MORPH_MS))
  return (x: number): number => (1 - p) * fromFn(x) + p * toFn(x)
}

export const PlotRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const p = effectiveParams(el)
  const expr = str(p.expr)
  const fn = useMemo(() => compileExpr(expr) ?? ((): number => NaN), [expr])
  const color = colorOf(p.color, 'blue')
  const dashStyle = bool(p.dash) ? 'dashed' : undefined

  // `morphRef` holds the in-progress morph (previous fn + start time), or
  // null once settled. Reset during render (not in an effect) when `expr`
  // changes, so the very first paint after the change already starts the
  // interpolation at p=0 instead of flashing straight to the new fn for one
  // frame — a supported React pattern (deriving/resetting state while
  // rendering) since this only mutates refs, never calls setState mid-render.
  const morphRef = useRef<{ fromFn: (x: number) => number; startedAt: number } | null>(null)
  const prevExprRef = useRef(expr)
  const prevFnRef = useRef(fn)
  const [, forceRender] = useReducer((n: number) => n + 1, 0)

  if (expr !== prevExprRef.current) {
    // fix (task-s2 review, fix round 1): this used to always read
    // `prevFnRef.current` as the new morph's `fromFn` — but that ref holds
    // the PREVIOUS morph's TARGET, not what was actually rendering at this
    // instant. A second expr change mid-morph (e.g. 0->10 interrupted at
    // blend=0.5 by a change to 20) would therefore restart the new morph
    // from 10 (the superseded target), producing a visible snap instead of
    // continuing from the ~5 actually on screen. Fix: if a morph is already
    // in flight, freeze its current blend into a one-off closure (`blendAt`)
    // and use THAT as the new fromFn; otherwise (settled) the plain previous
    // fn is still correct, same as before.
    const prevMorph = morphRef.current
    const fromFn = prevMorph ? blendAt(prevMorph.fromFn, prevFnRef.current, prevMorph.startedAt) : prevFnRef.current
    morphRef.current = { fromFn, startedAt: performance.now() }
    prevExprRef.current = expr
    prevFnRef.current = fn
  }

  useEffect(() => {
    if (!morphRef.current) return
    let raf = 0
    function tick(): void {
      const morph = morphRef.current
      if (!morph) return
      const elapsed = performance.now() - morph.startedAt
      if (elapsed >= PLOT_MORPH_MS) {
        morphRef.current = null
        forceRender()
        return
      }
      forceRender()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // Deliberately keyed on `expr` alone: this should (re)start exactly once
    // per expr change (a fresh morph), not on every unrelated re-render.
  }, [expr])

  const morph = morphRef.current
  let renderFn = fn
  if (morph) {
    const t = Math.min(1, Math.max(0, (performance.now() - morph.startedAt) / PLOT_MORPH_MS))
    const fromFn = morph.fromFn
    const toFn = fn
    renderFn = (x: number): number => (1 - t) * fromFn(x) + t * toFn(x)
  }

  return <Plot.OfX y={renderFn} color={color} style={dashStyle} />
}

// ---------------------------------------------------------------------------
// point
// ---------------------------------------------------------------------------
export const PointRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const controls = useBoard((s) => s.scene.controls)
  const p = effectiveParams(el)
  const x = num(p.x)
  const y = num(p.y)
  const color = colorOf(p.color, 'red')
  const label = typeof p.label === 'string' ? p.label : undefined
  const draggable = controls.some((c) => c.id === el.id && c.kind === 'drag' && (c.k === 'x' || c.k === 'y'))

  function handleMove([nx, ny]: [number, number]): void {
    const before = effectiveParams(el)
    const fromX = num(before.x)
    const fromY = num(before.y)
    const store = useBoard.getState()
    store.setOverride(el.id, 'x', nx)
    store.setOverride(el.id, 'y', ny)
    onParamDrag?.(el.id, 'x', fromX, nx)
    onParamDrag?.(el.id, 'y', fromY, ny)
  }

  return (
    <>
      {draggable ? (
        <MovablePoint point={[x, y]} onMove={handleMove} color={color} />
      ) : (
        <MafsPoint x={x} y={y} color={color} />
      )}
      {label && (
        <MafsText x={x} y={y} attach="ne" attachDistance={8} color={color}>
          {label}
        </MafsText>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// vector
// ---------------------------------------------------------------------------
export const VectorRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const p = effectiveParams(el)
  const x1 = num(p.x1)
  const y1 = num(p.y1)
  const x2 = num(p.x2)
  const y2 = num(p.y2)
  const color = colorOf(p.color, 'green')
  const label = typeof p.label === 'string' ? p.label : undefined
  return (
    <>
      <MafsVector tail={[x1, y1]} tip={[x2, y2]} color={color} />
      {label && (
        <MafsText x={x2} y={y2} attach="ne" attachDistance={8} color={color}>
          {label}
        </MafsText>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// segment
// ---------------------------------------------------------------------------
export const SegmentRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const p = effectiveParams(el)
  const color = colorOf(p.color, 'gray')
  return (
    <Line.Segment
      point1={[num(p.x1), num(p.y1)]}
      point2={[num(p.x2), num(p.y2)]}
      style={bool(p.dash) ? 'dashed' : 'solid'}
      color={color}
    />
  )
}

// ---------------------------------------------------------------------------
// area
// ---------------------------------------------------------------------------
const AREA_SAMPLES = 40

export const AreaRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const p = effectiveParams(el)
  const from = num(p.from)
  const to = num(p.to)
  const expr = str(p.expr)
  const color = colorOf(p.color, 'orange')
  const fn = useMemo(() => compileExpr(expr) ?? ((): number => NaN), [expr])
  const points = useMemo<[number, number][]>(() => {
    const pts: [number, number][] = [[from, 0]]
    for (let i = 0; i < AREA_SAMPLES; i++) {
      const x = from + ((to - from) * i) / (AREA_SAMPLES - 1)
      pts.push([x, fn(x)])
    }
    pts.push([to, 0])
    return pts
  }, [from, to, fn])
  return <Polygon points={points} color={color} fillOpacity={0.25} />
}

// ---------------------------------------------------------------------------
// tangent
// ---------------------------------------------------------------------------
const DERIV_H = 1e-4

export const TangentRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const p = effectiveParams(el)
  const at = num(p.at)
  const expr = str(p.expr)
  const color = colorOf(p.color, 'purple')
  const fn = useMemo(() => compileExpr(expr) ?? ((): number => NaN), [expr])
  const y0 = fn(at)
  const slope = (fn(at + DERIV_H) - fn(at - DERIV_H)) / (2 * DERIV_H)
  return (
    <>
      <Line.PointSlope point={[at, y0]} slope={slope} color={color} />
      <MafsPoint x={at} y={y0} color={color} />
    </>
  )
}

// ---------------------------------------------------------------------------
// axes coordinates (task-21 fix 1)
// ---------------------------------------------------------------------------
// Mafs's <Coordinates.Cartesian/> defaults both axes to `lines: 1`
// (`defaultAxisOptions` in node_modules/mafs/build/index.js) — a gridline
// AND a label every 1 unit, since Cartesian's XLabels/YLabels take their
// `separation` straight from `xAxis.lines`/`yAxis.lines` (same file,
// `function Cartesian`: `separation: xAxis.lines || 1`). Fine for a -10..10
// axes block; unusable for a 0..50 projectile-motion axis, where it smears
// 51 overlapping labels into noise (task-21). We instead pick a "nice" pitch
// per axis so any range renders roughly the same, readable number of
// gridlines, and pass it straight through as `lines` — no separate label
// callback needed, since `lines` already IS the label separation.
function axisPitch(range: number): number {
  // niceStep(x) (shared/src/scene.ts) rounds x/100 to a nice 1/2/5x10^k
  // value — it's built for ~100-step sliders. We want a step that's
  // ~1/8th of the range instead (a handful of gridlines, not a hundred), so
  // scale the input by 100/8 = 12.5 before handing it to niceStep's own
  // /100 rounding. Verified against the actual rendered label count in
  // math-render.test.tsx rather than just hand-derived.
  const TARGET_LINES = 8
  return niceStep(Math.abs(range) * (100 / TARGET_LINES))
}

// task-pe: axes.grid:false ("clean diagrams" — the axes doc string calls out
// orbit/ray-style minimal look as the reference aesthetic, even though those
// are unrelated standalone components). Mafs couples gridline visibility and
// label spacing onto the SAME `lines` field (see the comment above:
// `separation: xAxis.lines || 1` is used for BOTH the grid pattern's tile
// size AND XLabels/YLabels' tick spacing) — there is no prop that hides only
// the grid while keeping the axisPitch-scaled labels at their existing
// spacing; setting `lines:false` also resets label separation to Mafs's
// default of 1 (`false || 1`), which would silently reintroduce the task-21
// label-density bug for a wide range. So grid:false trades numeric tick
// labels away too rather than ship that regression: `{ lines: false, labels:
// false }` on both axes keeps the plain x/y axis crosshair (axis:true is
// still the default) but drops both gridlines and tick labels — genuinely
// "clean," and still recognizably an axes block, not nothing.
export const AxesCoordinates: FC<{ xmin: number; xmax: number; ymin: number; ymax: number; grid?: boolean }> = ({
  xmin,
  xmax,
  ymin,
  ymax,
  grid = true,
}) =>
  grid ? (
    <Coordinates.Cartesian xAxis={{ lines: axisPitch(xmax - xmin) }} yAxis={{ lines: axisPitch(ymax - ymin) }} />
  ) : (
    <Coordinates.Cartesian xAxis={{ lines: false, labels: false }} yAxis={{ lines: false, labels: false }} />
  )

// ---------------------------------------------------------------------------
// label
// ---------------------------------------------------------------------------
// KNOWN ADAPTATION FROM THE BRIEF (see task-12 report): the brief anticipated
// that Mafs's <Text> can't render arbitrary HTML/KaTeX, and suggested a
// plain-tex fallback for on-axes labels ("known POC limitation"). Mafs 0.21
// actually ships a `LaTeX` display component
// (node_modules/mafs/build/index.js, `function LaTeX(...)`) built for
// exactly this: it calls `katex.render` into a <foreignObject> positioned at
// a math-space point via useTransformContext. Flow labels (no `on`) use our
// own Katex.tsx wrapper since they render outside any Mafs transform
// context.
//
// task-21 fix 2: Mafs's own <LaTeX> centers its content on `at`, regardless
// of the content's width — great for short labels, but a wide formula
// centered on a point near the left edge of the axes has nowhere to grow
// except off-canvas (this is exactly what clipped the projectile-motion
// lesson). <LaTeX> has no `attach`/anchor prop (unlike its <Text>, which
// supports attach="ne" etc — see TextProps/CardinalDirection in
// mafs/build/index.d.ts and `function Text` in index.js, which implements
// "ne" as textAnchor:"start" + dominantBaseline:"baseline", i.e. text grows
// right+up from the point). <LaTeX> has no such option, so we reimplement
// its foreignObject-centering trick (same file, `function LaTeX`) ourselves
// below with the box pinned at its bottom-left (SW) corner instead of
// centered — content then only ever grows right+up from `at`, the same
// effect as attach="ne". We also clamp `at` a few percent inside the parent
// axes' own [xmin,xmax]/[ymin,ymax] so a label anchored at or past an edge
// can't render off-canvas at all.
//
// That clamp range is deliberately NOT Mafs's usePaneContext(): verified
// empirically (see task-21 report) that xPaneRange/yPaneRange is an internal
// power-of-2-quantized tiling bound used for gridline-pattern repetition
// (PaneManager in mafs/build/index.js — e.g. it reports [-32, 64] for a
// nominal 0..50 axes block), not the axes' authored viewBox — clamping
// against it is nearly a no-op since most off-canvas anchors already fall
// "inside" that much wider synthetic range. The axes' real range is instead
// looked up straight from the scene the way PointRenderer/etc. already do
// (via useBoard), matching the same defaults AxesBlock (Board.tsx) uses.
const LATEX_BOX = 99999
// Anchor point is kept at least this fraction of the axis range inside from
// each edge, so content growing from the anchor still starts on-canvas.
const EDGE_MARGIN_FRACTION = 0.05

function clampIntoRange([lo, hi]: readonly [number, number], v: number): number {
  const span = hi - lo
  if (!(span > 0)) return v
  const margin = span * EDGE_MARGIN_FRACTION
  return Math.min(Math.max(v, lo + margin), hi - margin)
}

const AnchoredLaTeX: FC<{
  x: number
  y: number
  tex: string
  color?: string
  xRange: readonly [number, number]
  yRange: readonly [number, number]
}> = ({ x, y, tex, color, xRange, yRange }) => {
  const ref = useRef<HTMLSpanElement>(null)
  const { viewTransform, userTransform } = useTransformContext()

  const cx = clampIntoRange(xRange, x)
  const cy = clampIntoRange(yRange, y)
  const combined = vec.matrixMult(viewTransform, userTransform)
  // Pixel position of the (clamped) anchor is the box's bottom-left (SW)
  // corner: box x = anchor pixel x (content grows right, into the box);
  // box y = anchor pixel y - box height (content grows up, since SVG y
  // grows downward, so "up" from the anchor means the box sits above it).
  const [anchorPxX, anchorPxY] = vec.transform([cx, cy], combined)

  useEffect(() => {
    if (!ref.current) return
    try {
      katex.render(tex, ref.current, { throwOnError: false })
    } catch {
      // Malformed input beyond what throwOnError:false catches (e.g. a
      // RangeError from runaway nesting) — leave the span empty rather than
      // crash the board; see Katex.tsx for the same defensive posture.
    }
  }, [tex])

  return (
    <foreignObject x={anchorPxX} y={anchorPxY - LATEX_BOX} width={LATEX_BOX} height={LATEX_BOX} pointerEvents="none">
      <div
        style={{
          width: LATEX_BOX,
          height: LATEX_BOX,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'flex-start',
          position: 'fixed',
          fontSize: '1.3em',
          color,
        }}
      >
        <span ref={ref} />
      </div>
    </foreignObject>
  )
}

export const LabelRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const p = effectiveParams(el)
  const tex = str(p.tex)
  const on = typeof p.on === 'string' ? p.on : undefined
  // Same store PointRenderer already reaches into (see setOverride above) —
  // the axes' own params are cleanly reachable from here, so we read its
  // range directly rather than falling back to Mafs's pane range (see the
  // comment on AnchoredLaTeX for why that range is the wrong thing to clamp
  // against). Same -10/10 defaults as AxesBlock in Board.tsx.
  const axesParams = useBoard((s) => (on ? s.scene.elements[on]?.params : undefined))
  if (on) {
    const xRange: [number, number] = [num(axesParams?.xmin, -10), num(axesParams?.xmax, 10)]
    const yRange: [number, number] = [num(axesParams?.ymin, -10), num(axesParams?.ymax, 10)]
    return <AnchoredLaTeX x={num(p.x)} y={num(p.y)} tex={tex} xRange={xRange} yRange={yRange} />
  }
  return <Katex tex={tex} className="board-label" />
}

// ---------------------------------------------------------------------------
// numberline — plain SVG, standalone flow block (no Mafs dependency).
// ---------------------------------------------------------------------------
const NL_WIDTH = 480
const NL_HEIGHT = 60
const NL_PAD = 20
const NL_Y = 30

export const NumberlineRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const p = effectiveParams(el)
  const min = num(p.min)
  const max = num(p.max, min + 1)
  const marks = Array.isArray(p.marks) ? p.marks.filter((m): m is number => typeof m === 'number') : []
  const span = max - min || 1
  const usable = NL_WIDTH - NL_PAD * 2
  const step = niceStep(span)
  const toPx = (v: number): number => NL_PAD + ((v - min) / span) * usable

  const ticks: number[] = []
  const firstTick = Math.ceil(min / step) * step
  for (let t = firstTick; t <= max + 1e-9; t += step) {
    ticks.push(Math.round(t / step) * step)
  }

  return (
    <svg className="board-numberline" width={NL_WIDTH} height={NL_HEIGHT} role="img" aria-label="number line">
      <line x1={toPx(min)} y1={NL_Y} x2={toPx(max)} y2={NL_Y} stroke="var(--ink)" strokeWidth={2} />
      {ticks.map((t) => (
        <g key={`tick-${t}`}>
          <line x1={toPx(t)} y1={NL_Y - 6} x2={toPx(t)} y2={NL_Y + 6} stroke="var(--ink)" strokeWidth={1} />
          <text x={toPx(t)} y={NL_Y + 22} fontSize={11} textAnchor="middle" fill="var(--ink)">
            {formatNum(t)}
          </text>
        </g>
      ))}
      {marks.map((m) => (
        <g key={`mark-${m}`}>
          <circle cx={toPx(m)} cy={NL_Y} r={5} fill={COLORS.gold} />
          <text x={toPx(m)} y={NL_Y - 14} fontSize={11} textAnchor="middle" fill={COLORS.gold}>
            {formatNum(m)}
          </text>
        </g>
      ))}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// table
// ---------------------------------------------------------------------------
export const TableRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const p = effectiveParams(el)
  const cols = Array.isArray(p.cols) ? p.cols.filter((c): c is string => typeof c === 'string') : []
  const rows = Array.isArray(p.rows) ? p.rows.filter((r): r is string[] => Array.isArray(r)) : []
  return (
    <table className="board-table">
      <thead>
        <tr>
          {cols.map((c, i) => (
            <th key={i}>
              <Katex tex={c} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri}>
            {row.map((cell, ci) => (
              <td key={ci}>
                <Katex tex={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
