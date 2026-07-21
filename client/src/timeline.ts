// timeline.ts — the sequential action processor (framework core).
//
// createTimeline(deps) is PURE: it owns no timers of its own. All "waiting"
// is expressed as repeated `deps.raf(cb)` registrations combined with
// `deps.now()` deltas, scaled by `deps.speed()` and gated by `deps.isPaused()`.
// This lets tests drive the whole thing with fake, manually-ticked time (see
// client/test/timeline.test.ts) instead of real timers.
//
// Deviation from the brief's literal deps signature, documented:
//   `getParam(id, k)` was added. The `set`/`anim` tween needs a starting
//   value ("from") for the param being animated, and the timeline has no
//   other way to read the current committed scene (it deliberately does not
//   hold its own shadow copy of Scene, to avoid drifting out of sync with
//   the store's real scene across `jumpToStep`/manual nav). The store wires
//   this to `get().scene.elements[id]?.params[k]`.
//
// ask handshake, documented: `ask` actions must pause the queue until the
// student's answer is submitted. The deps interface has no subscription
// primitive for that, so `createTimeline` returns an extra `resolveAsk()`
// method alongside `enqueue`/`clear`. The store calls `timeline.resolveAsk()`
// from its own `answerAsk()` action after clearing `ask` state — a plain
// callback handshake, no event bus required.
//
// T11 carried fix: `clear()` used to only drop the queue, leaving a pending
// `ask` gate (`askResolve` still armed) forever un-resolved if one was
// in-flight — the pump stays suspended on `await waitForAsk()`, `running`
// never flips back to `false`, and every subsequent `enqueue()` silently
// no-ops forever (`kick()`'s `if (running) return` guard). Manual step nav
// (PlayerBar) and starting a new session both call `clear()` while an ask
// can be actively blocking, so `clear()` now cancels any pending ask too
// (via the same `settleAsk` used by `resolveAsk()`) — the pump's `waitForAsk`
// resolves, the loop re-checks the now-empty queue, and `running` correctly
// falls back to `false`.

import type { Action } from '@board/shared'
import { ttsProvider } from './tts'

export type TimelineDeps = {
  commit(a: Action): void
  setCaption(t: string): void
  setOverride(id: string, k: string, v: number | null): void
  /** Current value of a scene param, used as the tween/anim "from". */
  getParam(id: string, k: string): unknown
  isPaused(): boolean
  speed(): number
  now(): number
  raf(cb: () => void): void
  /**
   * Reading pace (V-1, caption ghost): called right before a new `say`
   * starts typing, so the store can snapshot the outgoing caption into
   * `captionPrev` before resetting `caption` for the incoming text.
   */
  beginSay(): void
  /**
   * Frames mode (V-1, feedback: "multiple pictures... if animation is
   * getting complicated"). True while `anim` should commit its final value
   * instantly and emit a sampled snapshot strip instead of tweening. Read
   * once per `anim` action at the moment it starts running, so toggling
   * mid-lesson only affects anims that haven't started yet — an in-flight
   * tween is never retroactively interrupted.
   */
  isFramesMode(): boolean
  /** Frames mode (V-1): records one {elId,k,values} entry for Board's frames-strip UI. */
  addFrameSnapshot(elId: string, k: string, values: number[]): void
  /** Voice narration (V-1). True while `say`s should also be spoken via `ttsProvider`. */
  isVoiceOn(): boolean
}

export type Timeline = {
  enqueue(a: Action): void
  /** Drops all not-yet-processed queued actions (used on manual step nav). */
  clear(): void
  /** Unblocks a pending `ask` gate. No-op if nothing is waiting. */
  resolveAsk(): void
}

type Ease = (p: number) => number

const easeLinear: Ease = (p) => p

const easeInOutCubic: Ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)

// Back-out with a mild ~5% overshoot (spring "≈ overshoot 1.05").
const easeSpring: Ease = (p) => {
  const c1 = 0.6
  const c3 = c1 + 1
  const t = p - 1
  return 1 + c3 * t * t * t + c1 * t * t
}

const EASES: Record<'linear' | 'inOut' | 'spring', Ease> = {
  linear: easeLinear,
  inOut: easeInOutCubic,
  spring: easeSpring,
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback
}

const HOLD_MS = 350 // enter/exit settle time after add/del/clear/focus/ctl/step
const SAY_MS_PER_CHAR = 28
const SAY_MIN_MS = 800

// Reading pace (V-1, feedback: "the text goes too fast, I'm unable to
// finish it and it goes away"): after a say's typewriter finishes, hold the
// queue for a bit longer so the reader actually has time to finish reading
// before the board moves on. Scales with how much there was to read.
const DWELL_MIN_MS = 1200
const DWELL_MS_PER_WORD = 250

function wordCount(text: string): number {
  const trimmed = text.trim()
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length
}

function computeDwellMs(text: string): number {
  return Math.max(DWELL_MIN_MS, wordCount(text) * DWELL_MS_PER_WORD)
}

// Frames mode (V-1): 4 evenly spaced samples from `from` to `to`, endpoints
// included (t = 0, 1/3, 2/3, 1) — one strip item per sample, in Board.tsx.
const FRAME_SAMPLE_COUNT = 4

function sampleFrames(from: number, to: number): number[] {
  const values: number[] = []
  for (let i = 0; i < FRAME_SAMPLE_COUNT; i++) {
    values.push(lerp(from, to, i / (FRAME_SAMPLE_COUNT - 1)))
  }
  return values
}

export function createTimeline(deps: TimelineDeps): Timeline {
  let queue: Action[] = []
  let running = false
  let askResolve: (() => void) | null = null

  function waitFrame(): Promise<void> {
    return new Promise((resolve) => deps.raf(() => resolve()))
  }

  // Holds the queue at its current state while the store is paused.
  async function waitWhilePaused(): Promise<void> {
    while (deps.isPaused()) {
      await waitFrame()
    }
  }

  // Advances `baseMs` of *logical* time, scaled by speed() each frame, only
  // while not paused. Used for both plain holds and tween/typewriter timing.
  async function waitLogicalMs(baseMs: number, onTick?: (elapsedMs: number) => void): Promise<void> {
    if (baseMs <= 0) return
    let elapsed = 0
    let last = deps.now()
    while (elapsed < baseMs) {
      await waitFrame()
      const t = deps.now()
      if (!deps.isPaused()) elapsed += (t - last) * deps.speed()
      last = t
      onTick?.(Math.min(elapsed, baseMs))
    }
  }

  async function tween(id: string, k: string, from: number, to: number, durSeconds: number, ease: Ease): Promise<void> {
    const totalMs = durSeconds * 1000
    if (totalMs <= 0) {
      deps.setOverride(id, k, null)
      return
    }
    await waitLogicalMs(totalMs, (elapsedMs) => {
      const p = Math.min(1, elapsedMs / totalMs)
      deps.setOverride(id, k, lerp(from, to, ease(p)))
    })
    deps.setOverride(id, k, null)
  }

  // Reading pace: the post-typewriter hold. Uses the same paused/speed-aware
  // `waitLogicalMs` as every other wait in this file, so pausing mid-dwell
  // holds it and a higher `speed()` shortens it, exactly like HOLD_MS/tweens.
  async function dwell(text: string): Promise<void> {
    if (text.trim().length === 0) return
    await waitLogicalMs(computeDwellMs(text))
  }

  // Voice narration: speaks `text` via the swappable `ttsProvider` when
  // voiceOn, resolving immediately (provider untouched) otherwise.
  function speakSay(text: string): Promise<void> {
    if (!deps.isVoiceOn()) return Promise.resolve()
    return ttsProvider.speak(text, deps.speed())
  }

  async function typewriter(text: string): Promise<void> {
    if (text.length === 0) {
      deps.setCaption('')
      return
    }
    const totalMs = Math.max(text.length * SAY_MS_PER_CHAR, SAY_MIN_MS)
    let shown = 0
    await waitLogicalMs(totalMs, (elapsedMs) => {
      const chars = Math.min(text.length, Math.floor(elapsedMs / SAY_MS_PER_CHAR))
      if (chars !== shown) {
        shown = chars
        deps.setCaption(text.slice(0, chars))
      }
    })
    if (shown !== text.length) deps.setCaption(text)
  }

  function waitForAsk(): Promise<void> {
    return new Promise((resolve) => {
      askResolve = resolve
    })
  }

  // Shared by `resolveAsk()` (normal answer path) and `clear()` (cancel
  // path): resolves whatever `waitForAsk()` promise is currently pending, if
  // any, and disarms it. No-op if nothing is waiting.
  function settleAsk(): void {
    if (askResolve) {
      const resolve = askResolve
      askResolve = null
      resolve()
    }
  }

  async function runSay(action: Extract<Action, { op: 'say' }>): Promise<void> {
    deps.commit(action) // history/chat entry happens immediately; caption animates after.
    deps.beginSay() // caption ghost: snapshot the outgoing caption before typing the new one
    const speech = speakSay(action.text)
    await typewriter(action.text)
    // Dwell AND speech both gate the queue — whichever finishes later.
    await Promise.all([dwell(action.text), speech])
  }

  async function runAction(action: Action): Promise<void> {
    switch (action.op) {
      case 'add':
      case 'del':
      case 'clear':
      case 'focus':
      case 'ctl':
      case 'step':
        deps.commit(action)
        await waitLogicalMs(HOLD_MS)
        return
      case 'set': {
        // Frames mode (V-1): a `set` with `dur` also skips tweening (instant
        // commit) — but unlike `anim`, it never emits a snapshot strip.
        if (action.dur !== undefined && typeof action.v === 'number' && !deps.isFramesMode()) {
          const from = asNumber(deps.getParam(action.id, action.k), action.v)
          await tween(action.id, action.k, from, action.v, action.dur, easeInOutCubic)
        }
        deps.commit(action)
        return
      }
      case 'anim': {
        const from = asNumber(deps.getParam(action.id, action.k), action.to)
        // Frames mode: commit the final value instantly (no tween) and emit
        // a 4-sample snapshot strip instead — read once, here, so a toggle
        // mid-lesson only affects anims that haven't started yet.
        if (deps.isFramesMode()) {
          deps.addFrameSnapshot(action.id, action.k, sampleFrames(from, action.to))
          deps.commit(action)
          return
        }
        const ease = EASES[action.ease ?? 'inOut']
        await tween(action.id, action.k, from, action.to, action.dur, ease)
        deps.commit(action)
        return
      }
      case 'say':
        await runSay(action)
        return
      case 'ask':
        deps.commit(action)
        await waitForAsk()
        return
      default:
        return
    }
  }

  async function pump(): Promise<void> {
    while (queue.length > 0) {
      await waitWhilePaused()
      if (queue.length === 0) break
      const action = queue.shift()!

      // `say` with `sync`: if the *next* queued action targets the same id,
      // run the typewriter concurrently with it instead of sequentially.
      if (action.op === 'say' && action.sync) {
        const next = queue[0]
        if (next && (next.op === 'set' || next.op === 'anim') && next.id === action.sync) {
          queue.shift()
          // Extend, don't break, sync semantics: the typewriter runs
          // concurrently with the synced action (as before), but the dwell
          // (and any speech) now only starts once BOTH have settled, so the
          // reading-pace hold still applies to synced says.
          deps.commit(action)
          deps.beginSay()
          const speech = speakSay(action.text)
          await Promise.all([typewriter(action.text), runAction(next)])
          await Promise.all([dwell(action.text), speech])
          continue
        }
      }

      await runAction(action)
    }
    running = false
  }

  function kick(): void {
    if (running) return
    running = true
    void pump()
  }

  return {
    enqueue(a: Action) {
      queue.push(a)
      kick()
    },
    clear() {
      queue = []
      settleAsk() // cancel any pending ask so the pump can't stay parked forever
      // Voice narration: manual step nav / a new session must cut off any
      // in-flight narration too, not just leave it talking over the new view.
      if (deps.isVoiceOn()) ttsProvider.cancel()
    },
    resolveAsk() {
      settleAsk()
    },
  }
}
