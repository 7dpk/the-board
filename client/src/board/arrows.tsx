// arrows.tsx — shared arrowhead <defs> marker + <ForceArrow>, used by every
// physics.tsx renderer (projectile velocity vectors, pendulum mg/tension,
// incline mg/normal/friction, fbd force vectors) so there is exactly one
// arrowhead definition per <svg>, not one per force.
//
// Angle convention (per task-13 brief, fbd bullet): `angleDeg` is CCW from
// +x, standard math convention — but screen space has y growing downward, so
// ForceArrow flips the y component internally. Callers never need to negate
// anything themselves; they just pass the math angle they'd use on paper.
import type { FC, ReactElement } from 'react'

export const ARROW_MARKER_ID = 'board-force-arrowhead'

// One marker, reused by every arrow via `currentColor`: the marker's
// internal path fills with `currentColor`, and the CSS `color` property
// (unlike `fill`/`stroke`) is ordinary inherited CSS, so setting `color` on
// the referencing <line> (via the `style` prop below) cascades into the
// marker's rendered content. That lets a single <defs> entry serve every
// force color instead of needing one marker per COLORS entry.
export function ArrowDefs({ id = ARROW_MARKER_ID }: { id?: string } = {}): ReactElement {
  return (
    <defs>
      <marker
        id={id}
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
      </marker>
    </defs>
  )
}

export type Point = { x: number; y: number }

// A single force/velocity arrow: a line from `from` in direction `angleDeg`
// (math CCW-from-+x, y-flipped for screen) with length `lengthPx`, plus an
// optional text label at the tip.
export const ForceArrow: FC<{
  from: Point
  angleDeg: number
  lengthPx: number
  label?: string
  color: string
  markerId?: string
}> = ({ from, angleDeg, lengthPx, label, color, markerId = ARROW_MARKER_ID }) => {
  const rad = (angleDeg * Math.PI) / 180
  const dx = lengthPx * Math.cos(rad)
  const dy = -lengthPx * Math.sin(rad) // screen y flipped: math +y (up) is screen -y
  const tx = from.x + dx
  const ty = from.y + dy
  return (
    <g className="force-arrow" style={{ color }}>
      <line
        x1={from.x}
        y1={from.y}
        x2={tx}
        y2={ty}
        stroke={color}
        strokeWidth={2}
        markerEnd={`url(#${markerId})`}
      />
      {label && (
        <text
          x={tx}
          y={ty}
          dx={dx >= 0 ? 6 : -6}
          dy={dy >= 0 ? 14 : -6}
          fontSize={11}
          fill={color}
          textAnchor={dx >= 0 ? 'start' : 'end'}
        >
          {label}
        </text>
      )}
    </g>
  )
}
