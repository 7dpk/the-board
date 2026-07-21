// ControlStrip.tsx — renders `scene.controls` as interactive widgets bound to
// live/committed store state. Every renderer elsewhere reads params through
// `effectiveParams` (liveOverrides merged over committed params); this is the
// one place that WRITES to that same override during a drag/slide, then
// promotes the final value to a real `set` commit + a debounced semantic
// event once the interaction ends. See events.ts for the debounce contract.
//
// Kinds:
//   - slider: range input. `input` (fires continuously while dragging) ->
//     setOverride only, so the render is live at 60fps with no history
//     writes. `pointerup`/`keyup` (interaction end, mouse or keyboard) ->
//     clears the override, commits a real `set` action, and fires
//     emitParamEvent(id,k,from,to) where `from` is the value that was
//     current when the interaction began (not the previous override tick).
//   - input: a plain number field. Local draft state while typing; commits
//     on blur or Enter (brief: "commit on blur/Enter"), same commit+event
//     path as the slider.
//   - drag: rendered on-canvas instead (see board/math.tsx's MovablePoint
//     wiring) — intentionally renders nothing here.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import { formatNum, type Control } from '@board/shared'
import { emitParamEvent } from '../events'
import { useBoard } from '../store'

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function controlLabel(ctl: Control): string {
  return ctl.label ?? `${ctl.id}.${ctl.k}`
}

// ---------------------------------------------------------------------------
// slider
// ---------------------------------------------------------------------------
function SliderControl({ ctl }: { ctl: Control }): ReactElement {
  const committed = useBoard((s) => num(s.scene.elements[ctl.id]?.params[ctl.k]))
  const override = useBoard((s) => s.liveOverrides[ctl.id]?.[ctl.k])
  const setOverride = useBoard((s) => s.setOverride)
  const commit = useBoard((s) => s.commit)
  const value = override ?? committed
  // Value the interaction started from — captured once at gesture start
  // (pointerdown/focus), not re-read on every intermediate input tick, so a
  // whole drag reports one (from, to) pair instead of a chain of them.
  const fromRef = useRef(committed)

  function begin(): void {
    fromRef.current = committed
  }

  function handleInput(e: { currentTarget: HTMLInputElement }): void {
    setOverride(ctl.id, ctl.k, Number(e.currentTarget.value))
  }

  function finish(e: { currentTarget: HTMLInputElement }): void {
    const v = Number(e.currentTarget.value)
    setOverride(ctl.id, ctl.k, null)
    // Skip the no-op case (pointerdown+pointerup/keyup with no actual
    // movement): nothing changed, so neither a history entry nor a tutor
    // event is warranted.
    if (v !== fromRef.current) {
      commit({ op: 'set', id: ctl.id, k: ctl.k, v })
      emitParamEvent(ctl.id, ctl.k, fromRef.current, v)
    }
  }

  return (
    <label className="control control-slider">
      <span className="control-label">{controlLabel(ctl)}</span>
      <input
        type="range"
        min={ctl.min}
        max={ctl.max}
        step={ctl.step}
        value={value}
        onPointerDown={begin}
        onFocus={begin}
        onInput={handleInput}
        onPointerUp={finish}
        onKeyUp={finish}
      />
      <span className="control-value">{formatNum(value)}</span>
    </label>
  )
}

// ---------------------------------------------------------------------------
// input (number field)
// ---------------------------------------------------------------------------
function NumberControl({ ctl }: { ctl: Control }): ReactElement {
  const committed = useBoard((s) => num(s.scene.elements[ctl.id]?.params[ctl.k]))
  const commit = useBoard((s) => s.commit)
  const [draft, setDraft] = useState(() => String(committed))
  const fromRef = useRef(committed)
  const editing = useRef(false)

  // Keep the field in sync with external changes (tween/anim/replay) while
  // the student isn't actively editing it; never clobber an in-progress edit.
  useEffect(() => {
    if (!editing.current) setDraft(String(committed))
  }, [committed])

  function handleFocus(): void {
    editing.current = true
    fromRef.current = committed
  }

  function commitDraft(): void {
    // Guards against the Enter path (below) committing once, then the
    // `blur()` it triggers firing this handler again for the same edit.
    if (!editing.current) return
    editing.current = false
    const v = Number(draft)
    if (!Number.isFinite(v)) {
      setDraft(String(committed)) // reject unparseable input, revert to last committed value
      return
    }
    // Skip the no-op case (focused and blurred without actually editing).
    if (v !== fromRef.current) {
      commit({ op: 'set', id: ctl.id, k: ctl.k, v })
      emitParamEvent(ctl.id, ctl.k, fromRef.current, v)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      commitDraft()
      e.currentTarget.blur()
    }
  }

  return (
    <label className="control control-input">
      <span className="control-label">{controlLabel(ctl)}</span>
      <input
        type="number"
        min={ctl.min}
        max={ctl.max}
        step={ctl.step}
        value={draft}
        onFocus={handleFocus}
        onInput={(e: { currentTarget: HTMLInputElement }) => setDraft(e.currentTarget.value)}
        onBlur={commitDraft}
        onKeyDown={handleKeyDown}
      />
    </label>
  )
}

// ---------------------------------------------------------------------------
// ControlStrip
// ---------------------------------------------------------------------------
export default function ControlStrip(): ReactElement | null {
  const controls = useBoard((s) => s.scene.controls)
  const visible = controls.filter((c) => c.kind === 'slider' || c.kind === 'input')
  if (visible.length === 0) return null

  return (
    <div className="control-strip">
      {visible.map((ctl) =>
        ctl.kind === 'slider' ? (
          <SliderControl key={`${ctl.id}.${ctl.k}`} ctl={ctl} />
        ) : (
          <NumberControl key={`${ctl.id}.${ctl.k}`} ctl={ctl} />
        ),
      )}
    </div>
  )
}
