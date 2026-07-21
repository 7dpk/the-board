// ChatPanel.tsx — the chat log + student input, right-hand column of `.main`
// (App.tsx). Student messages append to `store.chat` directly (via
// `useBoard.setState`, no new store action needed for this) and are handed
// to `onSend` (App.tsx turns that into a `{kind:'chat'}` server turn).
//
// Selection scope (task-15 brief): if the board has a selected element,
// show an "asking about: {id}" chip and prefix the outgoing text with
// `[about ${id}] ` — both in what's stored/sent and in the student-facing
// chat bubble, so the transcript reads the same as what the tutor saw.
//
// Scroll pin (task P-B, feedback: "the right chat sidebar doesn't scroll
// up"): `.chat-log` is the actual `overflow-y:auto` region (styles.css).
// Smart auto-pin — a scroll listener tracks whether the reader is within
// `BOTTOM_THRESHOLD_PX` of the bottom (scrollPin.ts's `isNearBottom`, shared
// with Board.tsx's auto-follow). While pinned, a new message re-pins the view
// to the bottom; once the reader scrolls up to reread history, new messages
// land without yanking the view back down.
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { useBoard } from '../store'
import { isNearBottom } from '../scrollPin'

export default function ChatPanel({ onSend }: { onSend: (text: string) => void }): ReactElement {
  const chat = useBoard((s) => s.chat)
  const selection = useBoard((s) => s.selection)
  // Button responsiveness (task-s2, feedback: "buttons are not very
  // responsive"): `turnInFlight` (store.ts) is the accurate "a network turn
  // is currently running" signal — App.tsx's fire()/settle() toggle it
  // around every streamTurn call.
  //
  // fix (task-s2 review, fix round 1): this used to also gate a DOM
  // `disabled` attribute on both the input and the Send button for every
  // in-flight turn — but that contradicts the approved FIFO design
  // (App.tsx's turn queue deliberately lets a student compose and fire off
  // several chat messages back to back while earlier ones are still
  // resolving; see app-turns.test.tsx's "two rapid chats both reach the
  // server in order, neither dropped"). Disabling the input blocked
  // composing/queueing entirely, not just an accidental double-click.
  // `turnInFlight` now ONLY drives the Send button's visual busy indicator
  // (`btn-loading`) — the input stays typable and Send stays clickable at
  // all times, so the queue keeps absorbing new turns as designed.
  const turnInFlight = useBoard((s) => s.turnInFlight)
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true) // starts pinned: nothing to scroll away from yet

  function handleScroll(): void {
    const el = logRef.current
    if (!el) return
    pinnedRef.current = isNearBottom(el)
  }

  useEffect(() => {
    const el = logRef.current
    if (!el || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [chat])

  function submit(e: FormEvent): void {
    e.preventDefault()
    const text = draft.trim()
    if (text === '') return
    const prefixed = selection ? `[about ${selection}] ${text}` : text
    useBoard.setState((s) => ({ chat: [...s.chat, { from: 'student', text: prefixed }] }))
    onSend(prefixed)
    setDraft('')
  }

  return (
    <div className="chat">
      <div className="chat-log" ref={logRef} onScroll={handleScroll}>
        {chat.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-title">Ask anything</div>
            <div className="chat-empty-sub">
              Questions you type here go straight to the tutor — it answers in the log and on the
              board.
            </div>
          </div>
        ) : (
          chat.map((m, i) => (
            <div key={i} className={`chat-msg chat-${m.from}`}>
              {m.text}
            </div>
          ))
        )}
      </div>
      {selection && <div className="selection-chip">asking about: {selection}</div>}
      <form className="chat-input-row" onSubmit={submit}>
        <input
          type="text"
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
          placeholder="Ask a question..."
          aria-label="chat message"
        />
        <button type="submit" className={`btn${turnInFlight ? ' btn-loading' : ''}`}>
          Send
        </button>
      </form>
    </div>
  )
}
