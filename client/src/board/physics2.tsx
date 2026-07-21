// physics2.tsx — custom-SVG renderers for the board's JEE physics pack
// (task-pd protocol / task-pe renderers): orbit, spring, wave, ray. Kept in
// a separate file from physics.tsx (T13's projectile/pendulum/incline/fbd)
// purely to keep each file a manageable size — same conventions throughout:
// every renderer reads params via `effectiveParams` (never `el.params`
// directly), every numeric label goes through `formatNum`, arrowheads/force
// vectors reuse arrows.tsx's <ArrowDefs>/<ForceArrow> (one marker per <svg>
// via useId), and the SVG root is wrapped in `motion.svg` with the same
// opacity/y enter tween as every other physics renderer. All four are
// standalone (no `on` field — see components.ts), so Board.tsx always mounts
// them as their own flow block, never inside a Mafs canvas.
import { useId, useMemo } from 'react'
import type { FC } from 'react'
import { motion } from 'motion/react'
import { formatNum, type RayKind, type SceneElement } from '@board/shared'
import { effectiveParams } from './params'
import { COLORS } from './math'
import { ArrowDefs, ForceArrow, type Point } from './arrows'

// ---------------------------------------------------------------------------
// Small, defensive param readers — same philosophy as physics.tsx's num/str/
// bool (LLM-authored/replayed scenes should never crash the board on a
// missing or wrong-typed field). Duplicated rather than imported: physics.tsx
// doesn't export these either (see its own header comment for the same call).
// ---------------------------------------------------------------------------
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

// =============================================================================
// orbit — viewBox 0 0 480 360. Kepler ellipse: the central body sits at a
// FOCUS (not the ellipse's own geometric center), and the satellite sweeps
// with the correct, non-uniform equal-areas speed variation as `t` (mean
// anomaly fraction, 0..1 per orbit) animates linearly — that's the entire
// physical point of drawing this via Kepler's equation rather than just
// parameterizing position by angle directly.
// =============================================================================
const ORBIT_W = 480
const ORBIT_H = 360
const ORBIT_PAD = 30
const ORBIT_CENTER: Point = { x: ORBIT_W / 2, y: ORBIT_H / 2 }
const ORBIT_CENTRAL_R = 16
const ORBIT_BODY_R = 8
const ORBIT_NEWTON_ITERS = 5

// task-s2 (feedback: "kepler laws didn't shade the area"): showSweep shades
// the elliptical sector swept over a fixed TIME window ending at the
// current `t` — Kepler's second law, equal areas in equal times. `t` is
// already mean-anomaly-linear-in-time (M = 2*pi*t, see orbitGeometry above),
// so a fixed window in `t` IS a fixed window in real time; sampling it
// uniformly and running each sample through the same non-uniform-speed
// Kepler solve the satellite itself uses is what makes the drawn wedge
// automatically equal-area regardless of where in the orbit it's centered —
// no separate area bookkeeping needed. 0.06 of a period is wide enough to
// read as a wedge, narrow enough that even the fast perihelion sweep stays a
// small slice of the full ellipse.
const ORBIT_SWEEP_DELTA = 0.06
const ORBIT_SWEEP_SAMPLES = 14

// Solves Kepler's equation E - e*sin(E) = M for the eccentric anomaly E via
// Newton's method, starting from E0 = M (a fine starting guess for any e in
// the supported [0, ~0.95] range) and refining for a fixed 5 iterations —
// plenty for double-precision convergence at these eccentricities.
function solveKepler(M: number, e: number): number {
  let E = M
  for (let i = 0; i < ORBIT_NEWTON_ITERS; i++) {
    E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
  }
  return E
}

// Position/speed geometry for a given (a, e, t). `x`/`y` are FOCAL
// coordinates — already relative to the focus the satellite orbits, not the
// ellipse's own geometric center: x = a(cosE - e), y = b*sinE is the
// standard focal-radius identity (the distance from this origin works out to
// r = a(1 - e*cosE), the textbook r(theta) orbit equation), so placing the
// central body at this coordinate system's origin and the satellite at
// (x,y) is directly correct with no separate focus-offset bookkeeping needed
// at draw time — see `focus`/`satellite` below.
function orbitGeometry(a: number, e: number, t: number) {
  const b = a * Math.sqrt(Math.max(0, 1 - e * e))
  const c = a * e
  // Fit scale: the ellipse's own bounding box is 2a wide / 2b tall around
  // its TRUE geometric center (not the focus) — computing scale from that
  // full extent, then drawing the true center at the viewBox's own center
  // (see `focus` below), is what makes "scaled to fit, 30px padding" true
  // regardless of eccentricity, while the body still renders off-center at
  // the focus as the brief requires.
  const s = Math.min((ORBIT_W / 2 - ORBIT_PAD) / Math.max(a, 1e-6), (ORBIT_H / 2 - ORBIT_PAD) / Math.max(b, 1e-6))
  const M = 2 * Math.PI * t
  const E = solveKepler(M, e)
  const x = a * (Math.cos(E) - e)
  const y = b * Math.sin(E)
  const r = Math.sqrt(x * x + y * y)
  return { b, c, s, E, x, y, r }
}

export const OrbitRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const markerId = useId()
  const p = effectiveParams(el)
  const a = Math.max(num(p.a, 40), 1e-6)
  const e = Math.min(Math.max(num(p.e, 0.4), 0), 0.95)
  const t = num(p.t, 0)
  const showVectors = bool(p.showVectors, true)
  const showSweep = bool(p.showSweep, false)
  const centerLabel = str(p.centerLabel)
  const bodyLabel = str(p.bodyLabel)

  const { b, c, s, E, x, y, r } = orbitGeometry(a, e, t)
  // The ellipse's true center sits at the viewBox's own center; the central
  // body sits at the RIGHT focus, offset from that center by c*s px — see
  // orbitGeometry's comment for why (x,y) are already focus-relative.
  const focus: Point = { x: ORBIT_CENTER.x + c * s, y: ORBIT_CENTER.y }
  const satellite: Point = { x: focus.x + x * s, y: focus.y - y * s }

  // Sweep sector: focus -> N sampled points along the orbit path between
  // (t - delta) and t -> back to focus. Clamped at t=0 (can't sweep before
  // the start of the orbit) rather than wrapping negative.
  const sweepStart = Math.max(0, t - ORBIT_SWEEP_DELTA)
  const sweepPath = useMemo(() => {
    if (!showSweep || t <= sweepStart) return ''
    const pts: Point[] = []
    for (let i = 0; i < ORBIT_SWEEP_SAMPLES; i++) {
      const ti = sweepStart + ((t - sweepStart) * i) / (ORBIT_SWEEP_SAMPLES - 1)
      const g = orbitGeometry(a, e, ti)
      pts.push({ x: focus.x + g.x * s, y: focus.y - g.y * s })
    }
    const [first, ...rest] = pts
    return `M ${focus.x} ${focus.y} L ${first!.x} ${first!.y} ${rest.map((pt) => `L ${pt.x} ${pt.y}`).join(' ')} Z`
  }, [showSweep, a, e, t, sweepStart, s, focus.x, focus.y])

  // Tangent direction (dx/dE, dy/dE): its SIGN doesn't depend on dE/dt
  // (always positive for e<1), only its magnitude does, so this is already
  // the velocity's direction without needing the full dE/dt expression.
  const dxdE = -a * Math.sin(E)
  const dydE = b * Math.cos(E)
  const velAngleDeg = (Math.atan2(dydE, dxdE) * 180) / Math.PI
  // vis-viva in GM=1 schematic units (per the brief): speed^2 ~ 2/r - 1/a.
  const speed = Math.sqrt(Math.max(2 / Math.max(r, 1e-6) - 1 / a, 0))
  const velLenPx = Math.min(90, Math.max(14, speed * 45))

  const forceAngleDeg = (Math.atan2(-y, -x) * 180) / Math.PI
  const forceLenPx = Math.min(80, Math.max(18, (a / Math.max(r, 1e-6)) * 26))

  return (
    <motion.svg
      viewBox={`0 0 ${ORBIT_W} ${ORBIT_H}`}
      width={ORBIT_W}
      height={ORBIT_H}
      className="physics-orbit"
      role="img"
      aria-label="elliptical orbit"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <ArrowDefs id={markerId} />
      <ellipse
        cx={ORBIT_CENTER.x}
        cy={ORBIT_CENTER.y}
        rx={a * s}
        ry={b * s}
        fill="none"
        stroke={COLORS.gray}
        strokeWidth={1.5}
        strokeDasharray="6 6"
      />
      {sweepPath && <path data-role="sweep" d={sweepPath} fill={COLORS.gold} fillOpacity={0.25} stroke="none" />}
      {showVectors && (
        <>
          <ForceArrow
            from={satellite}
            angleDeg={forceAngleDeg}
            lengthPx={forceLenPx}
            color={COLORS.red}
            label="F"
            markerId={markerId}
          />
          <ForceArrow
            from={satellite}
            angleDeg={velAngleDeg}
            lengthPx={velLenPx}
            color={COLORS.green}
            label="v"
            markerId={markerId}
          />
        </>
      )}
      <circle data-role="central" cx={focus.x} cy={focus.y} r={ORBIT_CENTRAL_R} fill={COLORS.gold} />
      {centerLabel && (
        <text x={focus.x} y={focus.y - ORBIT_CENTRAL_R - 8} fontSize={12} textAnchor="middle" fill="var(--ink)">
          {centerLabel}
        </text>
      )}
      <circle data-role="satellite" cx={satellite.x} cy={satellite.y} r={ORBIT_BODY_R} fill={COLORS.blue} />
      {bodyLabel && (
        <text x={satellite.x} y={satellite.y - ORBIT_BODY_R - 8} fontSize={11} textAnchor="middle" fill={COLORS.blue}>
          {bodyLabel}
        </text>
      )}
    </motion.svg>
  )
}

// =============================================================================
// spring — viewBox 0 0 480 200. Wall-mounted horizontal spring-mass SHM:
// x(t) = amp*cos(sqrt(k/mass)*t), scaled 12px/data-unit off the equilibrium
// position.
// =============================================================================
const SPRING_W = 480
const SPRING_H = 200
const SPRING_WALL_X = 30
const SPRING_NATURAL_PX = 220
const SPRING_Y = 100
const SPRING_PX_PER_UNIT = 12
const SPRING_COILS = 8
const SPRING_ZIGZAG_AMP = 14
const SPRING_BLOCK_SIZE = 40

// n=2*coils segments, alternating above/below the centerline, with the
// first/last point pinned exactly to the wall/block anchors (y, no zigzag)
// so the coil pattern reads cleanly against both endpoints.
function springZigzag(x1: number, x2: number, y: number, coils: number, amp: number): string {
  const n = Math.max(2, coils * 2)
  const step = (x2 - x1) / n
  const pts: Point[] = [{ x: x1, y }]
  for (let i = 1; i < n; i++) {
    pts.push({ x: x1 + step * i, y: y + (i % 2 === 1 ? -amp : amp) })
  }
  pts.push({ x: x2, y })
  return pts.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ')
}

export const SpringRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const markerId = useId()
  const p = effectiveParams(el)
  const amp = Math.max(num(p.amp, 2), 0)
  const k = Math.max(num(p.k, 100), 1e-6)
  const mass = Math.max(num(p.mass, 1), 1e-6)
  const t = num(p.t, 0)
  const showForces = bool(p.showForces, false)

  const omega = Math.sqrt(k / mass)
  const x = amp * Math.cos(omega * t)
  const period = 2 * Math.PI * Math.sqrt(mass / k)

  const equilibriumX = SPRING_WALL_X + SPRING_NATURAL_PX
  const blockX = equilibriumX + x * SPRING_PX_PER_UNIT
  const springEndX = blockX - SPRING_BLOCK_SIZE / 2

  const zigzagPath = useMemo(
    () => springZigzag(SPRING_WALL_X, springEndX, SPRING_Y, SPRING_COILS, SPRING_ZIGZAG_AMP),
    [springEndX],
  )

  // Restoring force F = -kx: points back toward equilibrium; magnitude is a
  // visual proxy off the current pixel displacement (same spirit as
  // incline/pendulum's fixed-scale force arrows in physics.tsx).
  const forceAngleDeg = x >= 0 ? 180 : 0
  const forceLenPx = Math.min(70, Math.max(16, Math.abs(x) * SPRING_PX_PER_UNIT + 10))

  return (
    <motion.svg
      viewBox={`0 0 ${SPRING_W} ${SPRING_H}`}
      width={SPRING_W}
      height={SPRING_H}
      className="physics-spring"
      role="img"
      aria-label="mass-spring oscillator"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <ArrowDefs id={markerId} />
      <rect x={0} y={0} width={SPRING_WALL_X} height={SPRING_H} fill="var(--ink)" opacity={0.5} />
      <line
        x1={equilibriumX}
        y1={SPRING_Y - 50}
        x2={equilibriumX}
        y2={SPRING_Y + 50}
        stroke={COLORS.gray}
        strokeWidth={1}
        strokeDasharray="4 4"
      />
      <path d={zigzagPath} fill="none" stroke="var(--ink)" strokeWidth={2} />
      {showForces && (
        <ForceArrow
          from={{ x: blockX, y: SPRING_Y }}
          angleDeg={forceAngleDeg}
          lengthPx={forceLenPx}
          color={COLORS.red}
          label="F"
          markerId={markerId}
        />
      )}
      <rect
        data-role="block"
        x={blockX - SPRING_BLOCK_SIZE / 2}
        y={SPRING_Y - SPRING_BLOCK_SIZE / 2}
        width={SPRING_BLOCK_SIZE}
        height={SPRING_BLOCK_SIZE}
        fill={COLORS.orange}
        stroke="var(--ink)"
        strokeWidth={2}
      />
      <text x={SPRING_W / 2} y={SPRING_H - 14} fontSize={12} textAnchor="middle" fill="var(--ink)">
        {`T = ${formatNum(period)} s`}
      </text>
    </motion.svg>
  )
}

// =============================================================================
// wave — viewBox 0 0 560 220. Traveling or standing wave, sampled at 120
// points across exactly 2 wavelengths — a fixed number of periods shown, so
// the drawing looks equally readable regardless of the actual `wavelength`
// value's huge dynamic range (0.5..50 per its clamp).
// =============================================================================
const WAVE_W = 560
const WAVE_H = 220
const WAVE_Y = 110
const WAVE_PAD_X = 20
const WAVE_NOMINAL_PX_PER_UNIT = 14
const WAVE_MAX_AMP_PX = 90
const WAVE_SAMPLES = 120
const WAVE_PERIODS_SHOWN = 2

export const WaveRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const p = effectiveParams(el)
  const amp = Math.max(num(p.amp, 2), 1e-6)
  const wavelength = Math.max(num(p.wavelength, 4), 1e-6)
  const freq = num(p.freq, 1)
  const t = num(p.t, 0)
  const standing = bool(p.standing, false)

  const dataWidth = WAVE_PERIODS_SHOWN * wavelength
  const drawWidth = WAVE_W - 2 * WAVE_PAD_X
  const xToPx = (xData: number): number => WAVE_PAD_X + (xData / dataWidth) * drawWidth
  // Nominal 14px/unit, capped so amplitudes near the clamp's top end (10)
  // still fit inside the viewBox instead of the waveform running off top/bottom.
  const ampPxPerUnit = Math.min(WAVE_NOMINAL_PX_PER_UNIT, WAVE_MAX_AMP_PX / amp)
  const yToPx = (yData: number): number => WAVE_Y - yData * ampPxPerUnit

  function sample(fn: (xData: number) => number): string {
    const segs: string[] = []
    for (let i = 0; i < WAVE_SAMPLES; i++) {
      const xData = (i / (WAVE_SAMPLES - 1)) * dataWidth
      segs.push(`${i === 0 ? 'M' : 'L'} ${xToPx(xData)} ${yToPx(fn(xData))}`)
    }
    return segs.join(' ')
  }

  const wavePath = useMemo(
    () =>
      standing
        ? sample((xData) => 2 * amp * Math.sin((2 * Math.PI * xData) / wavelength) * Math.cos(2 * Math.PI * freq * t))
        : sample((xData) => amp * Math.sin(2 * Math.PI * (xData / wavelength - freq * t))),
    [standing, amp, wavelength, freq, t, dataWidth, ampPxPerUnit],
  )

  // The standing wave's amplitude ENVELOPE (max displacement reached at each
  // x over all t, since the time-dependent cos factor ranges -1..1 uniformly
  // across x) is the time-independent curve y = ±2*amp*|sin(2*pi*x/wavelength)|.
  const envelopeTop = useMemo(
    () => (standing ? sample((xData) => 2 * amp * Math.abs(Math.sin((2 * Math.PI * xData) / wavelength))) : ''),
    [standing, amp, wavelength, dataWidth, ampPxPerUnit],
  )
  const envelopeBottom = useMemo(
    () => (standing ? sample((xData) => -2 * amp * Math.abs(Math.sin((2 * Math.PI * xData) / wavelength))) : ''),
    [standing, amp, wavelength, dataWidth, ampPxPerUnit],
  )

  const speed = freq * wavelength

  return (
    <motion.svg
      viewBox={`0 0 ${WAVE_W} ${WAVE_H}`}
      width={WAVE_W}
      height={WAVE_H}
      className="physics-wave"
      role="img"
      aria-label={standing ? 'standing wave' : 'traveling wave'}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <line x1={WAVE_PAD_X} y1={WAVE_Y} x2={WAVE_W - WAVE_PAD_X} y2={WAVE_Y} stroke={COLORS.gray} strokeWidth={1} />
      {standing && (
        <>
          <path data-role="envelope-top" d={envelopeTop} fill="none" stroke={COLORS.gray} strokeWidth={1} strokeDasharray="4 4" />
          <path data-role="envelope-bottom" d={envelopeBottom} fill="none" stroke={COLORS.gray} strokeWidth={1} strokeDasharray="4 4" />
        </>
      )}
      <path data-role="wave" d={wavePath} fill="none" stroke={COLORS.blue} strokeWidth={2.5} />
      <text x={WAVE_W / 2} y={WAVE_H - 12} fontSize={12} textAnchor="middle" fill="var(--ink)">
        {`v = ${formatNum(speed)} units/s`}
      </text>
    </motion.svg>
  )
}

// =============================================================================
// ray — viewBox 0 0 560 260. Ray-optics diagram: 2 principal rays converging
// on (or, for a virtual image, appearing to diverge from) the image formed
// by a thin lens or mirror, per the thin-lens/mirror equation — the SAME
// "real-positive" sign convention as shared/src/mathcheck.ts's
// MATH_FNS.lensImage, so this diagram and any verified narration numbers for
// the same scene always agree:
//
//   v = 1/(1/f - 1/u),  u = objectDist (always entered as a positive
//   magnitude), f signed by kind — convex-lens/concave-mirror (both
//   converging) get f = +focalLength; concave-lens/convex-mirror (both
//   diverging) get f = -focalLength ("mirrors mirrored": a concave mirror
//   behaves like a convex lens and vice versa, focal-length-sign-wise).
//
// v > 0 is a real (inverted) image; v < 0 is virtual (upright, dashed back-
// extension). Which SIDE of the element a real image renders on differs for
// lenses (transmission: opposite side from the object) vs mirrors
// (reflection: same side as the object) — virtual images always render on
// the other side from wherever real images land for that kind.
// =============================================================================
const RAY_W = 560
const RAY_H = 260
const RAY_AXIS_Y = 130
const RAY_ELEMENT_X = 280
const RAY_HALF_W = RAY_ELEMENT_X - 40 // usable px on each side of the element
const RAY_OBJECT_H_PX = 50

function isMirror(kind: RayKind): boolean {
  return kind === 'concave-mirror' || kind === 'convex-mirror'
}

// Signed focal length per the file-header convention.
function signedFocalLength(kind: RayKind, focalLength: number): number {
  const converging = kind === 'convex-lens' || kind === 'concave-mirror'
  return converging ? focalLength : -focalLength
}

export const RayRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const markerId = useId()
  const p = effectiveParams(el)
  const kind = ((typeof p.kind === 'string' ? p.kind : 'convex-lens') as RayKind)
  const u = Math.max(num(p.objectDist, 20), 1e-6)
  const focalLength = Math.max(num(p.focalLength, 10), 1e-6)
  const showLabels = bool(p.showLabels, true)

  const mirror = isMirror(kind)
  const f = signedFocalLength(kind, focalLength)
  const vRaw = u === f ? NaN : 1 / (1 / f - 1 / u)
  const real = Number.isFinite(vRaw) && vRaw > 0
  // No finite image (object exactly at the focal point) — fall back to a
  // layout-only placeholder so the geometry below never NaNs out; the label
  // branch checks `Number.isFinite(vRaw)` directly and reports "at infinity"
  // instead of showing this placeholder's number.
  const v = Number.isFinite(vRaw) ? vRaw : u * 4

  // Fit scale: the larger of u, |v|, and 2*focalLength (so F/2F ticks stay
  // roughly on-canvas too) maps to the available half-width; if the true
  // math yields a |v| too large to fit, the drawn position clamps but the
  // numeric label (below) always reports the real, unclamped value.
  const largest = Math.max(u, Math.abs(v), 2 * focalLength, 1e-6)
  const scale = Math.min(8, RAY_HALF_W / largest)

  const objX = RAY_ELEMENT_X - u * scale
  const objTip: Point = { x: objX, y: RAY_AXIS_Y - RAY_OBJECT_H_PX }

  const onObjectSide = real ? mirror : !mirror
  const imgOffsetPx = Math.min(RAY_HALF_W, Math.abs(v) * scale)
  const imgX = onObjectSide ? RAY_ELEMENT_X - imgOffsetPx : RAY_ELEMENT_X + imgOffsetPx
  const magnitudeRatio = Math.abs(v) / u
  const imgHeightPx = Math.min(120, Math.max(10, RAY_OBJECT_H_PX * magnitudeRatio))
  // Real images invert; virtual images stay upright (true for both lenses
  // and mirrors — only the SIDE differs, already captured by onObjectSide).
  const imgTip: Point = { x: imgX, y: real ? RAY_AXIS_Y + imgHeightPx : RAY_AXIS_Y - imgHeightPx }

  // Two principal rays, both geometrically required to pass through (or,
  // for a virtual image, appear to diverge from) the same image point — see
  // file header. Ray A is parallel to the axis until the element; ray B
  // goes through the lens's optical center (or the mirror's vertex)
  // undeviated. Real images: draw a solid segment straight through to the
  // image tip. Virtual images: the physically-traveling ray after the
  // element actually diverges away from the (behind-the-scenes) image point
  // — drawn as a short solid ray in that direction, plus a dashed backward
  // extension through to the image tip (the "appears to come from"
  // construction the brief calls for).
  function outgoingSegment(elementPoint: Point): { solid: [Point, Point]; dashed?: [Point, Point] } {
    if (real) return { solid: [elementPoint, imgTip] }
    const dx = elementPoint.x - imgTip.x
    const dy = elementPoint.y - imgTip.y
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const forward: Point = { x: elementPoint.x + (dx / len) * 90, y: elementPoint.y + (dy / len) * 90 }
    return { solid: [elementPoint, forward], dashed: [elementPoint, imgTip] }
  }

  const vertexOrCenter: Point = { x: RAY_ELEMENT_X, y: RAY_AXIS_Y }
  const rayAElementPoint: Point = { x: RAY_ELEMENT_X, y: objTip.y }
  const rayA = outgoingSegment(rayAElementPoint)
  const rayB = outgoingSegment(vertexOrCenter)

  const fPx = focalLength * scale
  const ticks = [
    { x: RAY_ELEMENT_X - fPx, label: 'F' },
    { x: RAY_ELEMENT_X + fPx, label: 'F' },
    { x: RAY_ELEMENT_X - 2 * fPx, label: '2F' },
    { x: RAY_ELEMENT_X + 2 * fPx, label: '2F' },
  ]

  return (
    <motion.svg
      viewBox={`0 0 ${RAY_W} ${RAY_H}`}
      width={RAY_W}
      height={RAY_H}
      className="physics-ray"
      role="img"
      aria-label="ray optics diagram"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <ArrowDefs id={markerId} />
      <line x1={0} y1={RAY_AXIS_Y} x2={RAY_W} y2={RAY_AXIS_Y} stroke={COLORS.gray} strokeWidth={1} />

      {ticks.map((tick, i) => (
        <g key={i}>
          <line x1={tick.x} y1={RAY_AXIS_Y - 5} x2={tick.x} y2={RAY_AXIS_Y + 5} stroke={COLORS.gray} strokeWidth={1.5} />
          {showLabels && (
            <text x={tick.x} y={RAY_AXIS_Y + 18} fontSize={10} textAnchor="middle" fill={COLORS.gray}>
              {tick.label}
            </text>
          )}
        </g>
      ))}

      {mirror ? (
        <path
          data-role="element"
          d={
            kind === 'concave-mirror'
              ? `M ${RAY_ELEMENT_X} ${RAY_AXIS_Y - 90} Q ${RAY_ELEMENT_X + 24} ${RAY_AXIS_Y} ${RAY_ELEMENT_X} ${RAY_AXIS_Y + 90}`
              : `M ${RAY_ELEMENT_X} ${RAY_AXIS_Y - 90} Q ${RAY_ELEMENT_X - 24} ${RAY_AXIS_Y} ${RAY_ELEMENT_X} ${RAY_AXIS_Y + 90}`
          }
          fill="none"
          stroke="var(--ink)"
          strokeWidth={2.5}
        />
      ) : (
        <g data-role="element">
          <line x1={RAY_ELEMENT_X} y1={RAY_AXIS_Y - 90} x2={RAY_ELEMENT_X} y2={RAY_AXIS_Y + 90} stroke="var(--ink)" strokeWidth={2} />
          {kind === 'convex-lens' ? (
            <>
              <path
                d={`M ${RAY_ELEMENT_X - 10} ${RAY_AXIS_Y - 78} L ${RAY_ELEMENT_X} ${RAY_AXIS_Y - 90} L ${RAY_ELEMENT_X + 10} ${RAY_AXIS_Y - 78}`}
                fill="none"
                stroke="var(--ink)"
                strokeWidth={2}
              />
              <path
                d={`M ${RAY_ELEMENT_X - 10} ${RAY_AXIS_Y + 78} L ${RAY_ELEMENT_X} ${RAY_AXIS_Y + 90} L ${RAY_ELEMENT_X + 10} ${RAY_AXIS_Y + 78}`}
                fill="none"
                stroke="var(--ink)"
                strokeWidth={2}
              />
            </>
          ) : (
            <>
              <path
                d={`M ${RAY_ELEMENT_X - 10} ${RAY_AXIS_Y - 90} L ${RAY_ELEMENT_X} ${RAY_AXIS_Y - 78} L ${RAY_ELEMENT_X + 10} ${RAY_AXIS_Y - 90}`}
                fill="none"
                stroke="var(--ink)"
                strokeWidth={2}
              />
              <path
                d={`M ${RAY_ELEMENT_X - 10} ${RAY_AXIS_Y + 90} L ${RAY_ELEMENT_X} ${RAY_AXIS_Y + 78} L ${RAY_ELEMENT_X + 10} ${RAY_AXIS_Y + 90}`}
                fill="none"
                stroke="var(--ink)"
                strokeWidth={2}
              />
            </>
          )}
        </g>
      )}

      <g data-role="object">
        <ForceArrow from={{ x: objX, y: RAY_AXIS_Y }} angleDeg={90} lengthPx={RAY_OBJECT_H_PX} color={COLORS.blue} markerId={markerId} />
      </g>
      <g data-role="image">
        <ForceArrow
          from={{ x: imgX, y: RAY_AXIS_Y }}
          angleDeg={real ? 270 : 90}
          lengthPx={imgHeightPx}
          color={real ? COLORS.orange : COLORS.purple}
          markerId={markerId}
        />
      </g>

      {/* principal ray A: parallel to axis, then through (or from) the image point */}
      <line x1={objTip.x} y1={objTip.y} x2={rayAElementPoint.x} y2={rayAElementPoint.y} stroke={COLORS.green} strokeWidth={1.5} />
      <line
        x1={rayA.solid[0].x}
        y1={rayA.solid[0].y}
        x2={rayA.solid[1].x}
        y2={rayA.solid[1].y}
        stroke={COLORS.green}
        strokeWidth={1.5}
        markerEnd={`url(#${markerId})`}
        style={{ color: COLORS.green }}
      />
      {rayA.dashed && (
        <line
          x1={rayA.dashed[0].x}
          y1={rayA.dashed[0].y}
          x2={rayA.dashed[1].x}
          y2={rayA.dashed[1].y}
          stroke={COLORS.green}
          strokeWidth={1}
          strokeDasharray="4 4"
        />
      )}

      {/* principal ray B: through the optical center / vertex, then through (or from) the image point */}
      <line x1={objTip.x} y1={objTip.y} x2={vertexOrCenter.x} y2={vertexOrCenter.y} stroke={COLORS.red} strokeWidth={1.5} />
      <line
        x1={rayB.solid[0].x}
        y1={rayB.solid[0].y}
        x2={rayB.solid[1].x}
        y2={rayB.solid[1].y}
        stroke={COLORS.red}
        strokeWidth={1.5}
        markerEnd={`url(#${markerId})`}
        style={{ color: COLORS.red }}
      />
      {rayB.dashed && (
        <line
          x1={rayB.dashed[0].x}
          y1={rayB.dashed[0].y}
          x2={rayB.dashed[1].x}
          y2={rayB.dashed[1].y}
          stroke={COLORS.red}
          strokeWidth={1}
          strokeDasharray="4 4"
        />
      )}

      {showLabels && (
        <text x={RAY_W / 2} y={RAY_H - 10} fontSize={12} textAnchor="middle" fill="var(--ink)">
          {Number.isFinite(vRaw)
            ? `${real ? 'real' : 'virtual'} image at ${formatNum(Math.abs(vRaw))} units (${real ? 'inverted' : 'upright'})`
            : 'image at infinity (object at the focal point)'}
        </text>
      )}
    </motion.svg>
  )
}
