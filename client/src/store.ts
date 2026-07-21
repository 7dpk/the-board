// store.ts — the Board client's single state container (zustand).
//
// `enqueue` is the only entry point actions arrive through in normal
// operation: it forwards to the timeline, which paces/tweens/gates them and
// calls back into `commit` one at a time, in order. `commit` is the actual
// reducer — it applies the action to `scene` via the shared `applyAction`
// reducer, appends it to `history` (the full replay log), and updates the
// few pieces of derived state (`chat`, `ask`, `steps`) that depend on which
// op just landed.
//
// ask handshake (see timeline.ts for the other half): when an `ask` action
// commits, `commit` sets `ask` state and the timeline is left awaiting
// `resolveAsk()`. `answerAsk()` clears `ask` and calls `timeline.resolveAsk()`
// — a plain callback handshake between the store and the timeline, no event
// bus involved. Correctness-checking of the student's actual answer against
// `ask.answer` is out of scope here (later task); this only unblocks playback.
//
// Dialogue-only chat (task P-B, feedback: "less content in chat and more on
// the board"): a `say` action always renders as the synced caption (that's
// timeline.ts's `runSay` -> `setCaption`, unaffected by anything here) but
// only ALSO lands in `chat` when it arrived during a `chat`-kind turn — a
// tutor reply to a student's typed question belongs in the transcript
// alongside their question; narration during a teach/event/answer turn
// doesn't, or the chat panel would just mirror the whole lesson script.
// `say` and narration `say` are otherwise indistinguishable actions (same
// `{op:'say', text}` shape, same SSE stream) — App.tsx is the one place that
// knows which turn kind is in flight, so it threads that through via
// `setActiveTurnKind`, set once around each `streamTurn` call.
import { create } from 'zustand'
import { type Action, type Scene, applyAction, emptyScene } from '@board/shared'
import { createTimeline, type Timeline } from './timeline'
import { ttsProvider } from './tts'

// ---------------------------------------------------------------------------
// localStorage-backed preferences (V-1: frames mode + voice narration).
// Guarded (`typeof localStorage === 'undefined'`, try/catch) so this stays
// safe in any environment without a real localStorage (SSR, locked-down
// private browsing quota errors) — falls back to the given default rather
// than throwing.
// ---------------------------------------------------------------------------
const LS_FRAMES_MODE = 'board.framesMode'
const LS_VOICE_ON = 'board.voiceOn'

function readBoolLS(key: string, fallback: boolean): boolean {
  if (typeof localStorage === 'undefined') return fallback
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === 'true'
  } catch {
    return fallback
  }
}

function writeBoolLS(key: string, value: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // ignore — e.g. private-browsing quota errors; the toggle still works
    // for the rest of this session, it just won't survive a reload.
  }
}

/** Exported so tests can exercise the read path directly, with no module-reload gymnastics. */
export function readFramesModeLS(): boolean {
  return readBoolLS(LS_FRAMES_MODE, false)
}

/** Exported so tests can exercise the read path directly, with no module-reload gymnastics. */
export function readVoiceOnLS(): boolean {
  return readBoolLS(LS_VOICE_ON, false)
}

// Frames mode (V-1, feedback: "instead of animation, we could use multiple
// pictures on bottom of each other... if animation is getting complicated").
// One entry per `anim` action processed while frames mode is on — see
// timeline.ts's `addFrameSnapshot` dep and Board.tsx's frames-strip render.
export type FrameSnapshot = { elId: string; k: string; values: number[] }

export type ChatMsg = { from: 'teacher' | 'student' | 'system' | 'error'; text: string }

export type AskState = {
  id: string
  kind: 'mcq' | 'numeric' | 'free'
  text: string
  options?: string[]
  answer?: string
} | null

// Which server turn kind is currently streaming actions in, as far as `say`
// routing cares: 'chat' (a student-initiated question, see App.tsx's
// `handleChatSend`) vs. everything else (start/event/answer — narration,
// not dialogue). `null` before any turn has run.
//
// Deliberately NEVER reset back to null once a turn has run (see App.tsx's
// `fire`/`settle`) — it must stay correctly attributed to "whichever turn's
// actions are still draining through the timeline's queue" for as long as
// that queue is still committing `say`s from it, which can run well after
// the network round-trip itself finishes (typewriter pacing, HOLD_MS, etc.
// — see timeline.ts). That means `activeTurnKind !== null` is NOT a valid
// "is a turn currently in flight" signal for UI purposes (button
// responsiveness, task-s2) — see `turnInFlight` below for that.
export type ActiveTurnKind = 'chat' | 'other' | null

export type BoardStore = {
  scene: Scene
  caption: string
  /**
   * Reading pace (V-1, caption ghost): the PREVIOUS say's full caption text,
   * shown dimmed above the current one so a reader who glances away doesn't
   * lose the line that just finished. Set by `beginSay()` (timeline.ts calls
   * it right before a new say starts typing) and cleared alongside `caption`
   * on replay/jumpToStep/reset.
   */
  captionPrev: string
  chat: ChatMsg[]
  ask: AskState
  /**
   * task F-1 (screenshot bug: mcq options render disabled even before
   * answering). Root cause: a beat that re-teaches (re-teach after warmup, a
   * hint re-ask) re-streams an `ask` action with the SAME id as a previous
   * one -- AskWidget's old reset logic keyed only on `ask.id` changing, so a
   * same-id re-arrival left its submitted/disabled state locked from the
   * FIRST answer. `askNonce` bumps on every `ask` action `commit` (whether or
   * not the id changed) so AskWidget can re-arm on every genuine arrival, not
   * just a change in id. See AskWidget.tsx's arm-key comment for the other
   * half.
   */
  askNonce: number
  steps: { title: string; startIndex: number }[]
  history: Action[] // all committed actions, replayable
  selection: string | null
  playing: boolean
  speed: number
  liveOverrides: Record<string, Record<string, number>> // transient param values during tween/drag (rendered over scene)
  activeTurnKind: ActiveTurnKind // which in-flight turn's actions are currently landing (see file header)
  /**
   * Button responsiveness (task-s2, feedback: "buttons are not very
   * responsive"): true from the moment App.tsx's `fire()` dispatches a turn
   * until its `settle()` runs — unlike `activeTurnKind` above, this DOES
   * reset back to false, so it's the accurate "is a network turn currently
   * in flight" signal ChatPanel's Send button uses for its busy indicator.
   * fix (fix round 1): deliberately NOT used to `disable` the input/button —
   * that would block the approved FIFO chat-queueing design (see
   * ChatPanel.tsx).
   */
  turnInFlight: boolean
  /**
   * Frames mode (V-1, feedback: "instead of animation, we could use
   * multiple pictures on bottom of each other... if animation is getting
   * complicated"). While on, future `anim`s (timeline.ts reads this once per
   * anim, at the moment it starts) commit instantly and emit a
   * `frameSnapshots` entry instead of tweening. Persisted to localStorage.
   */
  framesMode: boolean
  /** See `FrameSnapshot`/Board.tsx's frames-strip render. Cleared on jumpToStep/reset. */
  frameSnapshots: FrameSnapshot[]
  /**
   * Voice narration (V-1, feedback: "can we use text to voice... to make it
   * more interactive?"). While on, each `say` is also spoken via the
   * swappable `ttsProvider` (tts.ts). Persisted to localStorage, default off.
   */
  voiceOn: boolean

  enqueue(a: Action): void
  commit(a: Action): void
  setCaption(t: string): void
  /** Timeline hook (V-1): snapshot the outgoing caption into `captionPrev` before a new say starts typing. */
  beginSay(): void
  toggleFramesMode(): void
  addFrameSnapshot(elId: string, k: string, values: number[]): void
  toggleVoice(): void
  setSelection(id: string | null): void
  setOverride(id: string, k: string, v: number | null): void
  /** Set by App.tsx around each streamTurn call — see file header. */
  setActiveTurnKind(kind: ActiveTurnKind): void
  /** Set by App.tsx's `fire()`/`settle()` — see `turnInFlight` above. */
  setTurnInFlight(v: boolean): void
  /** rebuild scene = history.slice(0, steps[i].startIndex).reduce(applyAction) */
  jumpToStep(i: number): void
  pause(): void
  play(): void
  setSpeed(n: number): void
  /** Clears `ask` and unblocks the timeline's pending gate. See file header. */
  answerAsk(): void
  /**
   * Wipes scene/history/chat/ask/steps back to empty and cancels any pending
   * ask (via `timeline.clear()` — see timeline.ts's T11 carried fix). Used
   * when a new session starts over an old one, so a still-blocking ask from
   * the previous lesson can't leave the pump parked forever.
   */
  reset(): void
}

// applyAction's `focus` case can leave `scene.focus = { ids: [], style }` when
// every requested id was filtered out (unknown ids) — that is semantically
// "no focus", not an empty-but-active focus. Normalize it here, the one place
// scene is (re)computed, so every consumer of `scene.focus` sees `null`
// instead of having to special-case an empty array itself.
function normalizeScene(scene: Scene): Scene {
  if (scene.focus && scene.focus.ids.length === 0) {
    return { ...scene, focus: null }
  }
  return scene
}

function withOverride(
  overrides: Record<string, Record<string, number>>,
  id: string,
  k: string,
  v: number | null,
): Record<string, Record<string, number>> {
  const forId = { ...(overrides[id] ?? {}) }
  if (v === null) {
    delete forId[k]
  } else {
    forId[k] = v
  }
  const next = { ...overrides }
  if (Object.keys(forId).length === 0) {
    delete next[id]
  } else {
    next[id] = forId
  }
  return next
}

// ---------------------------------------------------------------------------
// selectTranscript (task D-2, feedback: "it should store whatever text it
// has shown in the right chat bar, for us to reference") -- a pure
// derivation over `history` (the store's existing full replay log), not new
// state: walks every committed action, grouping each `say`'s text under the
// most recent `step`'s title. `step` actions are already emitted once per
// beat (see shared/src/prompt.ts: "Start each beat with one step"), so this
// reproduces the lesson's section structure for free. Says that land before
// any step at all (freeform sessions, or a `chat` aside before the first
// beat starts) fall into an untitled leading group. Groups with no lines yet
// are dropped -- a `step` with nothing said under it isn't worth a transcript
// section header.
// ---------------------------------------------------------------------------
export type TranscriptGroup = { title: string; lines: string[] }

export function selectTranscript(history: Action[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = []
  let current: TranscriptGroup | null = null
  for (const a of history) {
    if (a.op === 'step') {
      current = { title: a.title, lines: [] }
      groups.push(current)
    } else if (a.op === 'say') {
      if (!current) {
        current = { title: '', lines: [] }
        groups.push(current)
      }
      current.lines.push(a.text)
    }
  }
  return groups.filter((g) => g.lines.length > 0)
}

export const useBoard = create<BoardStore>()((set, get) => {
  const timeline: Timeline = createTimeline({
    commit: (a) => get().commit(a),
    setCaption: (t) => get().setCaption(t),
    setOverride: (id, k, v) => get().setOverride(id, k, v),
    getParam: (id, k) => get().scene.elements[id]?.params[k],
    isPaused: () => !get().playing,
    speed: () => get().speed,
    now: () => Date.now(),
    raf: (cb) => {
      requestAnimationFrame(cb)
    },
    beginSay: () => get().beginSay(),
    isFramesMode: () => get().framesMode,
    addFrameSnapshot: (elId, k, values) => get().addFrameSnapshot(elId, k, values),
    isVoiceOn: () => get().voiceOn,
  })

  return {
    scene: emptyScene,
    caption: '',
    captionPrev: '',
    chat: [],
    ask: null,
    askNonce: 0,
    steps: [],
    history: [],
    selection: null,
    playing: true,
    speed: 1,
    liveOverrides: {},
    activeTurnKind: null,
    turnInFlight: false,
    framesMode: readFramesModeLS(),
    frameSnapshots: [],
    voiceOn: readVoiceOnLS(),

    enqueue: (a) => timeline.enqueue(a),

    commit: (a) =>
      set((state) => {
        const scene = normalizeScene(applyAction(state.scene, a))
        const patch: Partial<BoardStore> = { scene, history: [...state.history, a] }
        if (a.op === 'step') {
          patch.steps = [...state.steps, { title: a.title, startIndex: state.history.length }]
        } else if (a.op === 'say') {
          // Dialogue-only chat (see file header): only a `chat`-kind turn's
          // says land in the transcript. Narration during teach/event/answer
          // turns still reaches the student via the synced caption alone
          // (timeline.ts's `runSay` -> `setCaption`, unconditional).
          if (state.activeTurnKind === 'chat') {
            patch.chat = [...state.chat, { from: 'teacher', text: a.text }]
          }
        } else if (a.op === 'ask') {
          patch.ask = { id: a.id, kind: a.kind, text: a.text, options: a.options, answer: a.answer }
          patch.askNonce = state.askNonce + 1 // re-arm AskWidget even on a same-id re-arrival
        }
        return patch
      }),

    setCaption: (t) => set({ caption: t }),
    // Caption ghost (V-1): snapshot the outgoing caption into `captionPrev`
    // right before the incoming say resets `caption` to start typing. Called
    // once per say by timeline.ts, before its typewriter starts.
    beginSay: () => set((state) => ({ captionPrev: state.caption, caption: '' })),
    toggleFramesMode: () =>
      set((state) => {
        const next = !state.framesMode
        writeBoolLS(LS_FRAMES_MODE, next)
        return { framesMode: next }
      }),
    addFrameSnapshot: (elId, k, values) =>
      set((state) => ({ frameSnapshots: [...state.frameSnapshots, { elId, k, values }] })),
    toggleVoice: () =>
      set((state) => {
        const next = !state.voiceOn
        writeBoolLS(LS_VOICE_ON, next)
        if (!next) ttsProvider.cancel() // switching off mid-utterance stops it immediately
        return { voiceOn: next }
      }),
    setSelection: (id) => set({ selection: id }),
    setOverride: (id, k, v) => set((state) => ({ liveOverrides: withOverride(state.liveOverrides, id, k, v) })),
    setActiveTurnKind: (kind) => set({ activeTurnKind: kind }),
    setTurnInFlight: (v) => set({ turnInFlight: v }),

    jumpToStep: (i) =>
      set((state) => {
        const step = state.steps[i]
        if (!step) return {}
        // Manual nav interrupts any in-flight queued playback — including a
        // pending `ask` gate, which `clear()` now also cancels (T11 carried
        // fix, see timeline.ts), and any in-flight speech (voice narration,
        // V-1). `ask` is cleared here too so the UI doesn't keep showing a
        // stale AskWidget for a question the pump has already moved past;
        // `caption`/`captionPrev` reset for the same reason (a stale ghost
        // from a beat we just navigated away from would be misleading), and
        // `frameSnapshots` reset since any not-yet-committed snapshot
        // belongs to an anim this rebuilt scene hasn't reached yet.
        timeline.clear()
        const scene = normalizeScene(state.history.slice(0, step.startIndex).reduce(applyAction, emptyScene))
        return { scene, ask: null, caption: '', captionPrev: '', frameSnapshots: [] }
      }),

    pause: () => {
      set({ playing: false })
      // Voice narration: pausing playback pauses any in-flight speech too
      // (left untouched when voice is off — no provider call at all).
      if (get().voiceOn) ttsProvider.pause()
    },
    play: () => {
      set({ playing: true })
      if (get().voiceOn) ttsProvider.resume()
    },
    setSpeed: (n) => set({ speed: n }),

    answerAsk: () => {
      set({ ask: null })
      timeline.resolveAsk()
    },

    reset: () => {
      timeline.clear() // drop any queued playback + cancel a pending ask/speech before wiping state
      set({
        scene: emptyScene,
        caption: '',
        captionPrev: '',
        chat: [],
        ask: null,
        askNonce: 0,
        steps: [],
        history: [],
        selection: null,
        playing: true,
        speed: 1,
        liveOverrides: {},
        activeTurnKind: null,
        turnInFlight: false,
        frameSnapshots: [],
        // framesMode/voiceOn deliberately NOT reset here — they're persisted
        // user preferences (like a theme toggle), not per-session state; a
        // new lesson starting over an old one shouldn't silently flip them.
      })
    },
  }
})
