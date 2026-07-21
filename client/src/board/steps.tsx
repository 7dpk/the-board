// steps.tsx — flow-card renderer for the `steps` worked-derivation component
// (task-pa / task-pe). Standalone (no `on` field — see components.ts), so
// Board.tsx always mounts it as its own `.board-block` flow div, already
// wrapped in that block's own opacity/y enter tween; per physics.tsx's
// convention we additionally animate each individual row's reveal (see
// StepRow below) rather than the whole card, since rows appear one at a time
// as `shown` is animated upward by a beat rather than all at once.
//
// `lines`/`notes` are parallel arrays (same index = same equation-
// transformation line + its optional plain-text justification) — see the
// stepsVariant comment in shared/src/protocol/components.ts. `shown` is
// animatable (timeline tweens it beat by beat); mid-tween it arrives here as
// a fractional number via effectiveParams' liveOverrides merge, so it's
// rounded before slicing — this is the one place "shown" ever becomes an
// integer index rather than the animation's raw float, matching the brief
// ("round the effective value (Math.round) when slicing").
import type { FC } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { SceneElement } from '@board/shared'
import { effectiveParams } from './params'
import { Katex } from './Katex'

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export const StepsRenderer: FC<{ el: SceneElement }> = ({ el }) => {
  const p = effectiveParams(el)
  const title = str(p.title)
  const lines = strArray(p.lines)
  const notes = strArray(p.notes)

  // Default (no `shown` at all) reveals every line — matches scene.ts's
  // applyAdd default of lines.length, kept here too as a defensive fallback
  // for any element that somehow reaches this renderer without it.
  const rawShown = num(p.shown, lines.length)
  const shown = Math.max(0, Math.min(lines.length, Math.round(rawShown)))
  const visible = lines.slice(0, shown)

  return (
    <div className="board-steps">
      {title && <div className="board-steps-title">{title}</div>}
      <AnimatePresence initial={false}>
        {visible.map((line, i) => (
          <motion.div
            key={i}
            className="board-steps-row"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <Katex tex={line} className="board-steps-line" />
            {notes[i] && <span className="board-steps-note">{notes[i]}</span>}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
