// AskWidget.tsx — renders under the caption (see App.tsx) whenever the store
// has an active `ask` (set by the timeline when an `ask` action commits and
// gates playback — see timeline.ts/store.ts). Three kinds: mcq buttons,
// numeric input, free textarea.
//
// Submitting an answer does TWO things (per task-15 brief, "student answer
// submissions go BOTH to the local flow AND to the server"):
//   1. `submitAskAnswer` (events.ts) — grades it against `ask.answer`
//      (case-insensitive/trimmed), emits a `BoardEvent` through the sink, and
//      clears `ask` + unblocks the timeline's pending gate (store.answerAsk).
//   2. `onAnswer(askId, value)` — the caller (App.tsx) turns this into a
//      `{kind:'answer', askId, value}` server turn so the tutor reacts.
// The askId must be captured *before* calling submitAskAnswer, since that
// clears `ask` as one of its side effects.
import { useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { submitAskAnswer } from '../events'
import { useBoard } from '../store'

function joinClass(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export default function AskWidget({ onAnswer }: { onAnswer: (askId: string, value: string) => void }): ReactElement | null {
  const ask = useBoard((s) => s.ask)
  // task F-1 (screenshot bug: "mcq options render disabled even before
  // answering"). Root cause: when a beat re-teaches (re-teach after warmup, a
  // hint re-ask), the SAME ask id re-streams -- the old reset logic below
  // keyed purely on `displayed.id` changing, so a same-id re-arrival left
  // `submittedRef`/`chosen` locked from the FIRST answer and the options
  // rendered disabled from the widget's very first render of the "new"
  // question. `askNonce` (store.ts) bumps on every `ask` commit regardless of
  // id, so the reset guard below fires on EITHER an id change or a nonce
  // change -- a same-id re-arrival now re-arms the widget too.
  const askNonce = useBoard((s) => s.askNonce)
  // Native `onInput` passthrough, not `onChange` — this codebase's ControlStrip
  // hit a jsdom quirk where a controlled input's onChange never fired via a
  // raw dispatchEvent('input'); onInput sidesteps it (see events.test.ts / T14).
  const [draft, setDraft] = useState('')

  // Button responsiveness (task-s2, feedback: "buttons are not very
  // responsive — if I click once it should get disabled" / "re-enable only
  // when a new ask arrives"): `submitAskAnswer` clears store.ask
  // SYNCHRONOUSLY (see events.ts), in the same React batch as the click that
  // triggers it — so rendering straight off `ask` would make the "disabled +
  // pressed" state invisible for even a single frame (the widget would just
  // vanish). `displayedRef` keeps rendering the just-answered ask (options,
  // text, kind — everything) until a genuinely NEW one arrives, so the
  // locked/pressed state introduced below is actually the last thing the
  // student sees, instead of the question disappearing out from under them.
  const displayedRef = useRef(ask)
  if (ask) displayedRef.current = ask
  const displayed = ask ?? displayedRef.current

  // `submittedRef` is a SYNCHRONOUS per-ask guard, independent of React's
  // render timing — a double-click dispatched before React has re-rendered
  // with `disabled` still needs blocking there, since the DOM `disabled`
  // attribute itself only takes effect on the NEXT render. `chosen` mirrors
  // it into visible state (disables every option + marks the pressed one)
  // once that render lands. Both reset only when `displayed`'s id actually
  // changes (a genuinely new ask, not the current one clearing to null) —
  // reset during render (not an effect) is the same "derive/reset state from
  // a changed key" pattern used elsewhere in this codebase (see math.tsx's
  // PlotRenderer), safe here since it only mutates a ref plus one guarded
  // setState, never loops.
  const submittedRef = useRef(false)
  const [chosen, setChosen] = useState<string | null>(null)
  // Arm key = (id, nonce) pair. `id` alone catches the ask changing to a
  // different question; `askNonce` alone catches a same-id re-arrival (the
  // F-1 bug fix). Either one changing means a genuinely new `ask` action
  // landed, so re-arm.
  const armRef = useRef({ id: displayed?.id, nonce: askNonce })
  if (displayed?.id !== armRef.current.id || askNonce !== armRef.current.nonce) {
    armRef.current = { id: displayed?.id, nonce: askNonce }
    submittedRef.current = false
    if (chosen !== null) setChosen(null)
    setDraft('')
  }

  if (!displayed) return null
  const askId = displayed.id // capture before submitAskAnswer clears store.ask; TS
  // can't narrow `displayed` itself into a nested function declaration below
  // (function declarations are hoisted/analyzed independently of the
  // enclosing guard).

  function submit(value: string): void {
    const trimmed = value.trim()
    if (trimmed === '') return
    if (submittedRef.current) return // already answered this ask — ignore a race/double click
    submittedRef.current = true
    setChosen(value)
    submitAskAnswer(trimmed)
    onAnswer(askId, trimmed)
    setDraft('')
  }

  function submitDraft(e: FormEvent): void {
    e.preventDefault()
    submit(draft)
  }

  const locked = chosen !== null

  return (
    <div className="ask-widget">
      <div className="ask-text">{displayed.text}</div>
      {displayed.kind === 'mcq' && (
        <div className="ask-options">
          {(displayed.options ?? []).map((opt) => (
            <button
              key={opt}
              type="button"
              className={joinClass('btn', chosen === opt && 'btn-pressed')}
              disabled={locked}
              onClick={() => submit(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      {displayed.kind === 'numeric' && (
        <form className="ask-input-row" onSubmit={submitDraft}>
          <input
            type="number"
            value={draft}
            onInput={(e) => setDraft(e.currentTarget.value)}
            aria-label="numeric answer"
            disabled={locked}
          />
          <button type="submit" className={joinClass('btn', locked && 'btn-pressed')} disabled={locked}>
            Answer
          </button>
        </form>
      )}
      {displayed.kind === 'free' && (
        <form className="ask-input-row" onSubmit={submitDraft}>
          <textarea
            value={draft}
            onInput={(e) => setDraft(e.currentTarget.value)}
            aria-label="free-response answer"
            disabled={locked}
          />
          <button type="submit" className={joinClass('btn', locked && 'btn-pressed')} disabled={locked}>
            Answer
          </button>
        </form>
      )}
    </div>
  )
}
