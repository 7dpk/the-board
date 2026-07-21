// events.ts — turns raw student board manipulation into semantic
// `BoardEvent`s the tutor can react to (T15 wires the transport; here it's
// just an injectable sink, default no-op so this module is safe to import
// standalone, e.g. in tests, before any API wiring exists).
//
// Debounce contract (normative, from the plan): `emitParamEvent(id,k,from,to)`
// debounces 400ms PER (id,k) pair. Every call within an active window resets
// that pair's timer and extends the burst; the flushed event carries the
// FIRST `from` seen since the last flush and the LAST `to` — i.e. "where the
// student started" and "where they ended up", not every intermediate tick.
// This is what lets both an on-canvas drag (many onParamDrag calls per
// gesture, see PointRenderer.handleMove in board/math.tsx) and a single
// slider commit (one call, see controls/ControlStrip.tsx) share one emitter
// without the tutor being spammed with intermediate positions.
//
// Module-init wiring: `setParamDragHandler(emitParamEvent)` runs as an
// IMPORT SIDE EFFECT below, so merely importing this module anywhere in the
// app (e.g. from main.tsx or api.ts) is enough to make on-canvas point drags
// flow through the debounced emitter — no explicit call site needed. Wired
// against `../board/params` directly rather than `../board/registry`: the
// hook is actually owned by params.ts (registry.tsx only re-exports it for
// convenience, see that file's own header comment), and importing the raw
// hook module avoids pulling the whole render registry (math.tsx/physics.tsx
// and their mafs/katex/motion deps) into this otherwise-tiny module's import
// graph. math.tsx does the same (imports `onParamDrag` from './params', not
// './registry').
import type { BoardEvent } from '@board/shared'
import { setParamDragHandler } from './board/params'
import { useBoard } from './store'

const DEBOUNCE_MS = 400

let sink: (e: BoardEvent) => void = () => {}

export function setEventSink(fn: (e: BoardEvent) => void): void {
  sink = fn
}

type PendingParam = { from: number; to: number; timer: ReturnType<typeof setTimeout> }

// Keyed by "id k" — a plain string key so a Map (not a nested
// Record<string, Record<string,...>>) can hold one timer per (id,k) pair.
const pending = new Map<string, PendingParam>()

function keyOf(id: string, k: string): string {
  return `${id} ${k}`
}

export function emitParamEvent(id: string, k: string, from: number, to: number): void {
  const key = keyOf(id, k)
  const existing = pending.get(key)
  if (existing) {
    clearTimeout(existing.timer)
    existing.to = to // extend the burst; first `from` is untouched
    existing.timer = setTimeout(() => flush(id, k), DEBOUNCE_MS)
    return
  }
  pending.set(key, { from, to, timer: setTimeout(() => flush(id, k), DEBOUNCE_MS) })
}

function flush(id: string, k: string): void {
  const key = keyOf(id, k)
  const entry = pending.get(key)
  if (!entry) return
  pending.delete(key)
  sink({ ev: 'param', id, k, from: entry.from, to: entry.to })
}

// Wire the on-canvas drag hook. Import side effect, documented above.
setParamDragHandler(emitParamEvent)

// ---------------------------------------------------------------------------
// Ask-answer flow — T15's AskWidget calls this on submit. Correctness is
// checked against the store's current `ask.answer` (case-insensitive,
// trimmed); the reported `value` in the emitted event is the student's raw
// input, unmodified. An ask with no stored `answer` (e.g. an ungraded free
// response) reports `correct: null` rather than guessing.
// ---------------------------------------------------------------------------
function normalize(s: string): string {
  return s.trim().toLowerCase()
}

export function submitAskAnswer(value: string): void {
  const store = useBoard.getState()
  const ask = store.ask
  if (!ask) return
  const correct = ask.answer === undefined ? null : normalize(value) === normalize(ask.answer)
  sink({ ev: 'answer', askId: ask.id, value, correct })
  store.answerAsk() // clears `ask` state + unblocks the timeline's pending gate
}
