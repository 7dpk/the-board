// physics.tsx — custom-SVG renderers for the board's physics component pack
// (T13): projectile, pendulum, incline, fbd. None of these are Mafs
// components (they have no `on: <axes id>` field in their schemas — see
// shared/src/protocol/components.ts) so, per Board.tsx's grouping pass, they
// always render as standalone flow blocks, each already wrapped in
// Board.tsx's own `motion.div` (opacity/y enter tween). Per the brief we
// additionally wrap each renderer's own root in `motion.svg` with the same
// tween so the SVG content itself animates in, matching the math pack's feel.
//
// Every renderer reads params through `effectiveParams` (never `el.params`
// directly, same rule as math.tsx) and renders every numeric label through
// `formatNum`. Colors come from math.tsx's COLORS map — no hexes are
// redeclared here.
import { useMemo, useId } from 'react'
import type { FC, ReactElement } from 'react'
import { motion } from 'motion/react'
import { formatNum, type SceneElement } from '@board/shared'
import { effectiveParams } from './params'
import { COLORS } from './math'
import { ArrowDefs, ForceArrow, type Point } from './arrows'

// ---------------------------------------------------------------------------
// Small, defensive param readers (same philosophy as math.tsx's num/str/bool:
// LLM-authored/replayed scenes should never crash the board on a missing or
// wrong-typed field). Kept local rather than imported from math.tsx since
// math.tsx doesn't export them and they hold no color hexes to dedupe.
// ---------------------------------------------------------------------------
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

type ForceEntry = { name: string; deg: number; mag: number }

function forcesOf(v: unknown): ForceEntry[] {
  if (!Array.isArray(v)) return []
  const out: ForceEntry[] = []
  for (const f of v) {
    if (
      typeof f === 'object' &&
      f !== null &&
      typeof (f as Record<string, unknown>).name === 'string' &&
      typeof (f as Record<string, unknown>).deg === 'number' &&
      typeof (f as Record<string, unknown>).mag === 'number'
    ) {
      out.push(f as ForceEntry)
    }
  }
  return out
}

const COLOR_CYCLE = Object.values(COLORS)

function cycleColor(i: number): string {
  return COLOR_CYCLE[i % COLOR_CYCLE.length] ?? COLORS.blue
}

// Converts a screen-space direction vector to the math-CCW-from-+x angle
// (in degrees) that <ForceArrow> expects — the inverse of the flip ForceArrow
// applies internally. Used wherever a force direction is derived from
// geometry (pendulum tension, incline normal/friction) rather than given
// directly as a `deg` field (fbd).
function angleDegOfScreenVector(dx: number, dy: number): number {
  return (Math.atan2(-dy, dx) * 180) / Math.PI
}

// A small arc + angle label at `center`, sweeping from `fromDeg` to `toDeg`
// (both math CCW-from-+x, screen y-flipped, same convention as ForceArrow) —
// reused by projectile's launch angle, pendulum's swing angle, and incline's
// base angle.
function AngleArc({
  center,
  fromDeg,
  toDeg,
  radius,
  text,
  color,
}: {
  center: Point
  fromDeg: number
  toDeg: number
  radius: number
  text: string
  color: string
}): ReactElement {
  const toRad = (d: number): number => (d * Math.PI) / 180
  const p0 = { x: center.x + radius * Math.cos(toRad(fromDeg)), y: center.y - radius * Math.sin(toRad(fromDeg)) }
  const p1 = { x: center.x + radius * Math.cos(toRad(toDeg)), y: center.y - radius * Math.sin(toRad(toDeg)) }
  const delta = toDeg - fromDeg
  const largeArc = Math.abs(delta) > 180 ? 1 : 0
  const sweep = delta > 0 ? 0 : 1
  const midDeg = (fromDeg + toDeg) / 2
  const labelR = radius + 14
  const lx = center.x + labelR * Math.cos(toRad(midDeg))
  const ly = center.y - labelR * Math.sin(toRad(midDeg))
  return (
    <g className="angle-arc">
      <path
        d={`M ${p0.x} ${p0.y} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${p1.x} ${p1.y}`}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
      />
      <text x={lx} y={ly} fontSize={11} fill={color} textAnchor="middle">
        {text}
      </text>
    </g>
  )
}

// ---------------------------------------------------------------------------
// projectile — viewBox 0 0 600 320; origin px (40,280); ground line y=280.
// ---------------------------------------------------------------------------
const PROJ_W = 600
const PROJ_H = 320
const PROJ_ORIGIN: Point = { x: 40, y: 280 }
const PROJ_MAX_R_PX = 520
const PROJ_MAX_H_PX = 220
const PROJ_TRACE_SAMPLES = 41

function projectileKinematics(v0: number, deg: number, g: number): { theta: number; T: number; R: number; H: number } {
  const theta = (deg * Math.PI) / 180
  const T = (2 * v0 * Math.sin(theta)) / g
  const R = (v0 * v0 * Math.sin(2 * theta)) / g
  const H = (v0 * v0 * Math.sin(theta) * Math.sin(theta)) / (2 * g)
  return { theta, T, R, H }
}

// px-per-meter, same scale on both axes so the parabola's true shape is
// preserved (brief: "same for both axes so parabola shape is true").
function projectileScale(R: number, H: number): number {
  const sR = R > 0 ? PROJ_MAX_R_PX / R : Infinity
  const sH = H > 0 ? PROJ_MAX_H_PX / H : Infinity
  const s = Math.min(sR, sH)
  return Number.isFinite(s) && s > 0 ? s : 1
}

function projectilePosition(v0: number, theta: number, g: number, T: number, t: number): { mx: number; my: number; tau: number } {
  const tau = t * T
  const mx = v0 * Math.cos(theta) * tau
  const my = v0 * Math.sin(theta) * tau - 0.5 * g * tau * tau
  return { mx, my, tau }
}

export const ProjectileRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const markerId = useId()
  const p = effectiveParams(el)
  const v0 = num(p.v0, 20)
  const deg = num(p.deg, 45)
  const g = num(p.g, 9.8) || 9.8
  const t = num(p.t, 0)
  const trace = bool(p.trace, true)

  const { theta, T, R, H } = projectileKinematics(v0, deg, g)
  const s = projectileScale(R, H)
  const { mx, my, tau } = projectilePosition(v0, theta, g, T, t)
  const ballX = PROJ_ORIGIN.x + mx * s
  const ballY = PROJ_ORIGIN.y - my * s
  const vx = v0 * Math.cos(theta)
  const vy = v0 * Math.sin(theta) - g * tau

  const tracePath = useMemo(() => {
    if (!trace) return ''
    const segs: string[] = []
    for (let i = 0; i < PROJ_TRACE_SAMPLES; i++) {
      const ti = i / (PROJ_TRACE_SAMPLES - 1)
      const { mx: sx, my: sy } = projectilePosition(v0, theta, g, T, ti)
      const x = PROJ_ORIGIN.x + sx * s
      const y = PROJ_ORIGIN.y - sy * s
      segs.push(`${i === 0 ? 'M' : 'L'} ${x} ${y}`)
    }
    return segs.join(' ')
  }, [trace, v0, theta, g, T, s])

  return (
    <motion.svg
      viewBox={`0 0 ${PROJ_W} ${PROJ_H}`}
      width={PROJ_W}
      height={PROJ_H}
      className="physics-projectile"
      role="img"
      aria-label="projectile motion"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <ArrowDefs id={markerId} />
      <line
        x1={0}
        y1={PROJ_ORIGIN.y}
        x2={PROJ_W}
        y2={PROJ_ORIGIN.y}
        stroke="var(--ink)"
        strokeWidth={2}
      />
      {trace && <path d={tracePath} fill="none" stroke={COLORS.gray} strokeWidth={1.5} strokeDasharray="4 4" />}
      <ForceArrow from={{ x: ballX, y: ballY }} angleDeg={0} lengthPx={vx * 2} color={COLORS.green} markerId={markerId} />
      <ForceArrow
        from={{ x: ballX, y: ballY }}
        angleDeg={vy >= 0 ? 90 : 270}
        lengthPx={Math.abs(vy) * 2}
        color={COLORS.red}
        markerId={markerId}
      />
      <circle data-role="ball" cx={ballX} cy={ballY} r={9} fill={COLORS.gold} />
      <AngleArc
        center={PROJ_ORIGIN}
        fromDeg={0}
        toDeg={deg}
        radius={28}
        text={`${formatNum(deg)}°`}
        color={COLORS.blue}
      />
      <text x={PROJ_ORIGIN.x + (R * s) / 2} y={PROJ_ORIGIN.y + 22} fontSize={12} textAnchor="middle" fill="var(--ink)">
        {`R = ${formatNum(R)} m`}
      </text>
    </motion.svg>
  )
}

// ---------------------------------------------------------------------------
// pendulum — viewBox 0 0 400 340; pivot (200,40).
// ---------------------------------------------------------------------------
const PEND_W = 400
const PEND_H = 340
const PEND_PIVOT: Point = { x: 200, y: 40 }
const PEND_K_BASE = 240
const PEND_K_CAP = 120
const PEND_G = 9.8

function pendulumK(length: number): number {
  return Math.min(PEND_K_BASE / Math.max(length, 1), PEND_K_CAP)
}

export const PendulumRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const markerId = useId()
  const p = effectiveParams(el)
  const length = num(p.length, 1)
  const deg0 = num(p.deg0, 30)
  const t = num(p.t, 0)
  const showForces = bool(p.showForces, true)

  const k = pendulumK(length)
  const omega = Math.sqrt(PEND_G / Math.max(length, 1e-6))
  const theta = ((deg0 * Math.PI) / 180) * Math.cos(omega * t)
  const bobX = PEND_PIVOT.x + length * k * Math.sin(theta)
  const bobY = PEND_PIVOT.y + length * k * Math.cos(theta)
  const period = 2 * Math.PI * Math.sqrt(Math.max(length, 0) / PEND_G)

  const refEnd = { x: PEND_PIVOT.x, y: PEND_PIVOT.y + length * k }
  // theta measured CCW from straight-down (math convention feeding AngleArc
  // /ForceArrow, both of which are CCW-from-+x, y-flipped): straight down is
  // -90°/270°, and the rod sits `theta` further around from there.
  const rodAngleDeg = 270 + (theta * 180) / Math.PI
  const tensionAngleDeg = angleDegOfScreenVector(PEND_PIVOT.x - bobX, PEND_PIVOT.y - bobY)

  return (
    <motion.svg
      viewBox={`0 0 ${PEND_W} ${PEND_H}`}
      width={PEND_W}
      height={PEND_H}
      className="physics-pendulum"
      role="img"
      aria-label="pendulum"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <ArrowDefs id={markerId} />
      <line
        x1={PEND_PIVOT.x}
        y1={PEND_PIVOT.y}
        x2={refEnd.x}
        y2={refEnd.y}
        stroke={COLORS.gray}
        strokeWidth={1}
        strokeDasharray="4 4"
      />
      <AngleArc center={PEND_PIVOT} fromDeg={270} toDeg={rodAngleDeg} radius={22} text={`${formatNum((theta * 180) / Math.PI)}°`} color={COLORS.blue} />
      <line x1={PEND_PIVOT.x} y1={PEND_PIVOT.y} x2={bobX} y2={bobY} stroke="var(--ink)" strokeWidth={2} />
      <circle cx={PEND_PIVOT.x} cy={PEND_PIVOT.y} r={4} fill={COLORS.gray} />
      {showForces && (
        <>
          <ForceArrow from={{ x: bobX, y: bobY }} angleDeg={270} lengthPx={60} color={COLORS.red} label="mg" markerId={markerId} />
          <ForceArrow from={{ x: bobX, y: bobY }} angleDeg={tensionAngleDeg} lengthPx={50} color={COLORS.blue} label="T" markerId={markerId} />
        </>
      )}
      <circle data-role="bob" cx={bobX} cy={bobY} r={14} fill={COLORS.gold} />
      <text x={PEND_PIVOT.x} y={PEND_H - 12} fontSize={12} textAnchor="middle" fill="var(--ink)">
        {`T = ${formatNum(period)} s`}
      </text>
    </motion.svg>
  )
}

// ---------------------------------------------------------------------------
// incline — viewBox 0 0 520 320.
// ---------------------------------------------------------------------------
const INC_W = 520
const INC_H = 320
const INC_BASE_LEFT: Point = { x: 40, y: 280 }
const INC_MAX_BASE_LEN = 440
const INC_MIN_APEX_Y = 40
const INC_BLOCK_SIZE = 44

function inclineGeometry(deg: number): { apex: Point; baseRight: Point } {
  const rad = (deg * Math.PI) / 180
  const tanDeg = Math.tan(rad)
  let baseLen = INC_MAX_BASE_LEN
  let apexY = INC_BASE_LEFT.y - baseLen * tanDeg
  if (tanDeg > 0 && apexY < INC_MIN_APEX_Y) {
    baseLen = (INC_BASE_LEFT.y - INC_MIN_APEX_Y) / tanDeg
    apexY = INC_MIN_APEX_Y
  }
  return {
    apex: { x: INC_BASE_LEFT.x, y: apexY },
    baseRight: { x: INC_BASE_LEFT.x + baseLen, y: INC_BASE_LEFT.y },
  }
}

export const InclineRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const markerId = useId()
  const p = effectiveParams(el)
  const deg = num(p.deg, 30)
  const mu = num(p.mu, 0)
  const mass = num(p.mass, 1)
  const showForces = bool(p.showForces, true)

  const { apex, baseRight } = inclineGeometry(deg)
  const mid: Point = { x: (apex.x + baseRight.x) / 2, y: (apex.y + baseRight.y) / 2 }

  const heightPx = INC_BASE_LEFT.y - apex.y
  const baseLenPx = baseRight.x - INC_BASE_LEFT.x
  const hyp = Math.sqrt(heightPx * heightPx + baseLenPx * baseLenPx) || 1
  const normalAngleDeg = angleDegOfScreenVector(heightPx / hyp, -baseLenPx / hyp)
  const uphillAngleDeg = angleDegOfScreenVector(-baseLenPx / hyp, -heightPx / hyp)

  const mgLen = Math.min(4 * mass + 30, 90)
  const normalLen = mgLen * Math.cos((deg * Math.PI) / 180)
  const frictionLen = Math.min(mu * mgLen, 90)

  return (
    <motion.svg
      viewBox={`0 0 ${INC_W} ${INC_H}`}
      width={INC_W}
      height={INC_H}
      className="physics-incline"
      role="img"
      aria-label="inclined plane"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <ArrowDefs id={markerId} />
      <path
        className="incline-triangle"
        d={`M ${INC_BASE_LEFT.x} ${INC_BASE_LEFT.y} L ${baseRight.x} ${baseRight.y} L ${apex.x} ${apex.y} Z`}
        fill="var(--panel)"
        stroke="var(--ink)"
        strokeWidth={2}
      />
      <AngleArc
        center={baseRight}
        fromDeg={180}
        toDeg={uphillAngleDeg}
        radius={30}
        text={`${formatNum(deg)}°`}
        color={COLORS.blue}
      />
      <g className="incline-block" transform={`rotate(${deg} ${mid.x} ${mid.y})`}>
        <rect
          x={mid.x - INC_BLOCK_SIZE / 2}
          y={mid.y - INC_BLOCK_SIZE / 2}
          width={INC_BLOCK_SIZE}
          height={INC_BLOCK_SIZE}
          fill={COLORS.orange}
          stroke="var(--ink)"
          strokeWidth={2}
        />
      </g>
      {showForces && (
        <>
          <ForceArrow from={mid} angleDeg={270} lengthPx={mgLen} color={COLORS.red} label="mg" markerId={markerId} />
          <ForceArrow from={mid} angleDeg={normalAngleDeg} lengthPx={normalLen} color={COLORS.green} label="N" markerId={markerId} />
          {mu > 0 && <ForceArrow from={mid} angleDeg={uphillAngleDeg} lengthPx={frictionLen} color={COLORS.purple} label="f" markerId={markerId} />}
        </>
      )}
    </motion.svg>
  )
}

// ---------------------------------------------------------------------------
// fbd — viewBox 0 0 300 300; center dot (150,150).
// ---------------------------------------------------------------------------
const FBD_W = 300
const FBD_H = 300
const FBD_CENTER: Point = { x: 150, y: 150 }
const FBD_LEN_SCALE = 110
const FBD_LEN_BASE = 20

export const FbdRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const markerId = useId()
  const p = effectiveParams(el)
  const label = str(p.label, '')
  const forces = forcesOf(p.forces)
  const maxMag = Math.max(...forces.map((f) => f.mag), 1e-6)

  return (
    <motion.svg
      viewBox={`0 0 ${FBD_W} ${FBD_H}`}
      width={FBD_W}
      height={FBD_H}
      className="physics-fbd"
      role="img"
      aria-label="free body diagram"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <ArrowDefs id={markerId} />
      {forces.map((f, i) => (
        <ForceArrow
          key={`${f.name}-${i}`}
          from={FBD_CENTER}
          angleDeg={f.deg}
          lengthPx={(f.mag / maxMag) * FBD_LEN_SCALE + FBD_LEN_BASE}
          label={f.name}
          color={cycleColor(i)}
          markerId={markerId}
        />
      ))}
      <circle cx={FBD_CENTER.x} cy={FBD_CENTER.y} r={6} fill={COLORS.gray} />
      <text x={FBD_CENTER.x} y={FBD_CENTER.y - 12} textAnchor="middle" fontSize={12} fill="var(--ink)">
        {label}
      </text>
    </motion.svg>
  )
}
