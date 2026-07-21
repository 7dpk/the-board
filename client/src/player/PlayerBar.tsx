// PlayerBar.tsx — playback transport: pause/play, replay-current-step,
// prev/next step nav, a speed selector, and (task F-1) a Continue button.
//
// Step nav during live stream is allowed by design (task-15 brief): jumping
// calls `store.jumpToStep`, which calls `timeline.clear()` to interrupt any
// in-flight queued playback. Per the T11 carried fix (timeline.ts/store.ts),
// `clear()` also cancels a pending `ask` gate instead of leaving the pump
// parked forever, so manual nav mid-ask is safe.
//
// Continue button (task F-1, screenshot bug: "ok"/"what's next" repeated the
// same animation): fires `{kind:'continue'}` (App.tsx's `onContinue`), the
// same turn kind the chat phrase-mapping now sends for trivial
// continue-intent messages. Unlike a one-shot button (e.g. the warm-up
// chip), Continue is meant to be clicked repeatedly across a whole lesson,
// so `firedRef` only guards against two clicks landing in the same
// synchronous tick (before React has re-rendered with the button disabled) —
// it resets once `turnInFlight` flips back to false, ready for the next
// beat's Continue click.
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { ttsProvider } from '../tts'
import { useBoard } from '../store'

const SPEEDS = [0.5, 1, 1.5, 2]

export default function PlayerBar({ onContinue }: { onContinue: () => void }): ReactElement {
  const playing = useBoard((s) => s.playing)
  const pause = useBoard((s) => s.pause)
  const play = useBoard((s) => s.play)
  const speed = useBoard((s) => s.speed)
  const setSpeed = useBoard((s) => s.setSpeed)
  const jumpToStep = useBoard((s) => s.jumpToStep)
  const stepCount = useBoard((s) => s.steps.length)
  const turnInFlight = useBoard((s) => s.turnInFlight)
  // Frames mode (V-1): toggling mid-lesson only affects FUTURE anims — see
  // timeline.ts, which reads `framesMode` once per anim, at the moment it
  // starts.
  const framesMode = useBoard((s) => s.framesMode)
  const toggleFramesMode = useBoard((s) => s.toggleFramesMode)
  // Voice narration (V-1): disabled (with a tooltip) when the current
  // ttsProvider reports no browser support — computed fresh each render so
  // swapping providers (setTtsProvider) is reflected immediately.
  const voiceOn = useBoard((s) => s.voiceOn)
  const toggleVoice = useBoard((s) => s.toggleVoice)
  const voiceAvailable = ttsProvider.available()

  const continueFiredRef = useRef(false)
  useEffect(() => {
    if (!turnInFlight) continueFiredRef.current = false
  }, [turnInFlight])

  function handleContinueClick(): void {
    if (continueFiredRef.current) return // already fired this turn — ignore a race/double click
    continueFiredRef.current = true
    onContinue()
  }

  // Follows the latest step as new ones stream in; a manual ◀/▶/⟲ click
  // overrides it until the next new step lands and resets it to "latest"
  // again. Local to the component (not store state) — the store's own
  // `steps`/`history` are the source of truth for *what* each step is;
  // this is just "which one is the player bar currently pointed at".
  const [index, setIndex] = useState(-1)
  useEffect(() => {
    setIndex(stepCount - 1)
  }, [stepCount])

  function go(i: number): void {
    if (i < 0 || i >= stepCount) return
    setIndex(i)
    jumpToStep(i)
  }

  return (
    <div className="player-bar">
      <button type="button" onClick={() => (playing ? pause() : play())} aria-label={playing ? 'pause' : 'play'}>
        {playing ? '⏸' : '▶'}
      </button>
      <button type="button" onClick={() => go(index)} aria-label="replay current step" disabled={index < 0}>
        ⟲
      </button>
      <button type="button" onClick={() => go(index - 1)} aria-label="previous step" disabled={index <= 0}>
        ◀
      </button>
      <button
        type="button"
        onClick={() => go(index + 1)}
        aria-label="next step"
        disabled={index < 0 || index >= stepCount - 1}
      >
        ▶
      </button>
      <button type="button" className="continue-btn" onClick={handleContinueClick} aria-label="continue">
        Continue ▸
      </button>
      <button
        type="button"
        className={framesMode ? 'frames-toggle btn-pressed' : 'frames-toggle'}
        onClick={toggleFramesMode}
        aria-pressed={framesMode}
        aria-label="toggle frames mode"
        title="Frames mode: show animation steps as still frames instead of tweening"
      >
        ▤ Frames
      </button>
      <button
        type="button"
        className={voiceOn ? 'voice-toggle btn-pressed' : 'voice-toggle'}
        onClick={toggleVoice}
        aria-pressed={voiceOn}
        aria-label="toggle voice narration"
        disabled={!voiceAvailable}
        title={voiceAvailable ? 'Read narration aloud' : 'Voice narration is not supported in this browser'}
      >
        {voiceOn ? '🔊' : '🔈'}
      </button>
      <select value={speed} onChange={(e) => setSpeed(Number(e.currentTarget.value))} aria-label="playback speed">
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
    </div>
  )
}
