// TopicPicker.tsx — the pre-session landing screen. Four fixed lesson cards
// (the blueprint-backed flagship topics, one per committed blueprint) plus a
// free-text field for anything else (falls back to a freeform session
// server-side if no blueprint can be planned — see server/src/routes.ts's
// `warning` field). The card titles must match a blueprint's topic verbatim
// so slugify() resolves to its cached server/data/blueprints/<slug>.json.
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'

const LESSONS = [
  'Quadratic Functions',
  'Projectile Motion',
  "Kepler's Laws and Gravitation",
  'Simple Harmonic Motion',
]

function joinClass(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export default function TopicPicker({ onPick }: { onPick: (topic: string) => void | Promise<void> }): ReactElement {
  const [custom, setCustom] = useState('')
  // Button responsiveness (task-s2, feedback: "buttons are not very
  // responsive — if I click once it should get disabled"): `picking` drives
  // the VISIBLE lock (disabled + loading state on the chosen card) so a
  // stray double-click can't fire createSession twice. `onPick` may reject
  // (App.tsx's handlePick catches it and shows the error banner, staying on
  // this screen) — `mountedRef` guards the post-await `setPicking(null)`
  // reset so a slow rejection after the component has since unmounted (a
  // later pick DID succeed) doesn't warn/crash; on the success path this
  // screen is torn down anyway once App.tsx sets `session`.
  //
  // fix (task-s2 review, fix round 1): `picking` alone is React state, so
  // two synchronous clicks landing in the same render/tick (before React
  // commits the `disabled` attribute) BOTH read `picking === null` and both
  // pass the `if (picking) return` guard — a real double-click race. Mirrors
  // AskWidget.tsx's `submittedRef` pattern: `pickingRef` is a plain ref set
  // SYNCHRONOUSLY, before any `await`, so the second of two back-to-back
  // clicks always sees it already `true` regardless of render timing.
  const [picking, setPicking] = useState<string | null>(null)
  const pickingRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => () => {
    mountedRef.current = false
  }, [])

  async function pick(topic: string): Promise<void> {
    if (pickingRef.current) return // synchronous guard — already submitting, ignore further clicks
    pickingRef.current = true
    setPicking(topic)
    try {
      await onPick(topic)
    } catch {
      // Swallowed: the real caller (App.tsx's handlePick) already handles
      // its own errors via the topbar `error` banner — this only needs to
      // know when to release the lock, not the error content itself.
    } finally {
      pickingRef.current = false
      if (mountedRef.current) setPicking(null)
    }
  }

  function submitCustom(e: FormEvent): void {
    e.preventDefault()
    const topic = custom.trim()
    if (topic === '') return
    void pick(topic)
  }

  const locked = picking !== null

  return (
    <div className="topic-picker">
      <div className="landing-brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="landing-wordmark">Board</span>
      </div>
      <h1 className="landing-title">
        What do you want to <span className="accent">learn</span>?
      </h1>
      <p className="landing-promise">
        A tutor that thinks on the whiteboard — watch each idea drawn, graphed, and derived, then
        steer it with your own questions.
      </p>
      <div className="lesson-cards">
        {LESSONS.map((title) => (
          <button
            key={title}
            type="button"
            className={joinClass('btn', 'lesson-card', picking === title && 'btn-loading')}
            disabled={locked}
            onClick={() => void pick(title)}
          >
            {title}
          </button>
        ))}
      </div>
      <form className="topic-custom" onSubmit={submitCustom}>
        <input
          type="text"
          value={custom}
          onInput={(e) => setCustom(e.currentTarget.value)}
          placeholder="Or type any topic…"
          aria-label="custom topic"
          disabled={locked}
        />
        <button type="submit" className={joinClass('btn', locked && 'btn-loading')} disabled={locked}>
          Start
        </button>
      </form>
    </div>
  )
}
