// App.tsx — the app shell. No session -> TopicPicker. Once a session
// exists: topbar (title, phase chip, beat n/m) over a `.main` grid of the
// board area (Board + caption + AskWidget + ControlStrip + PlayerBar) and
// the ChatPanel.
//
// Turn plumbing: every server round-trip (start/chat/event/answer) goes
// through `runTurn`, which wraps `streamTurn` with a tiny single-flight
// queue — the server 409s a turn while one is already in flight
// (server/src/routes.ts), and a burst of param-drag events (events.ts's
// debounced emitter) or a stray double-submit could otherwise race one.
//
// Queue policy (fix round 1 — was "latest wins" over *any* queued turn,
// which could silently evict a still-unset `chat`/`answer` turn): only
// `event`-kind turns coalesce — pushing one while another `event` is already
// queued replaces it in place (latest event wins). `chat`/`answer`/`start`
// turns are never dropped: they append to a small FIFO array and are sent in
// order, each once the previous turn settles.
//
// Sink wiring: the generic event sink (events.ts) also carries `ev:'answer'`
// events (for the tutor's local-grading bookkeeping), but App.tsx sends the
// real `{kind:'answer', askId, value}` turn separately (see handleAnswer /
// AskWidget's onAnswer). Forwarding the sink's `ev:'answer'` as an
// `event`-kind turn too would double-fire a server turn per answer — one
// real, one spurious — so it's filtered out here; param/select/nav events
// still flow through unchanged.
//
// activeTurnKind (dialogue-only chat, store.ts): `say` actions arrive
// identically whether they're narrating a teach/event/answer turn or
// replying to a student's `chat` turn — App.tsx is the only place that knows
// which kind of turn is currently in flight, so `fire` sets
// `store.activeTurnKind` right before every `streamTurn` call; `commit`
// reads it to decide whether that `say` also belongs in the chat transcript.
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { createSession, setAccessCode, streamTurn, type SessionInfo, type TurnInput } from './api'
import Board from './board/Board'
import AskWidget from './chat/AskWidget'
import ChatPanel from './chat/ChatPanel'
import TranscriptPanel from './chat/TranscriptPanel'
import ControlStrip from './controls/ControlStrip'
import { setEventSink } from './events'
import PlayerBar from './player/PlayerBar'
import { useBoard } from './store'
import TopicPicker from './TopicPicker'

type Phase = { phase: string; beatIndex: number }
type SidebarTab = 'chat' | 'transcript'

// task F-1 (screenshot bug: saying "ok"/"what's next" made the tutor REPEAT
// the same animation instead of advancing). Root cause: those phrases used
// to route through `{kind:'chat'}`, which never advances beatIndex/phase and
// tells the model to "return to the lesson after" -- with nothing to
// advance, the model just re-narrated/re-animated whatever was already on
// the board. Trivial continue-intent phrases now map to `{kind:'continue'}`
// instead, which explicitly advances (or politely refuses during a pending
// check) -- see server/src/session.ts's composeContinue.
//
// Strict-anchored (^...$, whole trimmed message only): "ok" continues, but
// "ok but why is the sun at the focus" has substantive content and must
// still reach the model as a real chat question -- the anchors make sure any
// text beyond the bare phrase (plus trailing punctuation/whitespace) falls
// through to `chat` instead of being swallowed as a content-free continue.
export const CONTINUE_INTENT_RE = /^(ok(ay)?|next|continue|go on|what'?s next|proceed|sure)[.!? ]*$/i

export function isContinueIntent(text: string): boolean {
  return CONTINUE_INTENT_RE.test(text.trim())
}

// Access gate (server/src/accessGate.ts): production has no SSO available
// (Vercel Hobby plan) and holds the owner's paid Anthropic key server-side,
// so a deployment can opt in to requiring a short code. createSession is the
// FIRST server call a fresh page ever makes, so a wrong/missing code always
// surfaces there first — a turn can only 401 on this if the code changed out
// from under an already-open tab, which isn't worth extra UI for. Matching
// this exact string (not just "any 401") avoids mistaking a real server
// error for the gate.
const ACCESS_GATE_ERROR = 'access code required'

export default function App(): ReactElement {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [phase, setPhase] = useState<Phase>({ phase: 'plan', beatIndex: 0 })
  const [error, setError] = useState<string | null>(null)
  const caption = useBoard((s) => s.caption)
  // Reading pace (V-1, caption ghost): the previous say lingers above the
  // current one, dimmed — see store.ts's `beginSay`/timeline.ts's `runSay`.
  const captionPrev = useBoard((s) => s.captionPrev)
  const ask = useBoard((s) => s.ask)

  // D-2: right-sidebar tabs (Chat / Transcript) — pure UI state, unrelated to
  // the turn/session lifecycle below.
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('chat')

  // D-2 (story-first start, feedback: "clicking on a topic asks me some
  // questions, ideally it should display already created story"): probing
  // prerequisites is opt-in now — a "Warm-up questions" chip fires one
  // `{kind:'warmup'}` turn. `warmupTaken` hides the chip once clicked;
  // `warmupFiredRef` is the same synchronous double-click guard AskWidget's
  // `submittedRef` uses (React state alone can't stop two clicks landing in
  // the same tick before a re-render applies `disabled`).
  const [warmupTaken, setWarmupTaken] = useState(false)
  const warmupFiredRef = useRef(false)

  // Access gate (see ACCESS_GATE_ERROR above): `gateTopic` is the topic that
  // was being picked when the gate fired, kept around so submitting the code
  // can retry that exact pick — null means the gate isn't showing.
  const [gateTopic, setGateTopic] = useState<string | null>(null)
  const [gateCode, setGateCode] = useState('')

  const inFlight = useRef(false)
  // FIFO queue of turns waiting behind the in-flight one. Only `event`-kind
  // turns ever get evicted (a new `event` replaces an already-queued
  // `event`, in place); `chat`/`answer`/`start` always append and are never
  // dropped.
  const queue = useRef<{ sessionId: string; input: TurnInput }[]>([])

  function runTurn(sessionId: string, input: TurnInput): void {
    function settle(): void {
      inFlight.current = false
      // Button responsiveness (task-s2): accurate in-flight signal for the
      // Chat Send button — unlike setActiveTurnKind below, this must reset
      // back to false here (see store.ts's turnInFlight doc for why
      // activeTurnKind itself can't be reused for this).
      useBoard.getState().setTurnInFlight(false)
      const next = queue.current.shift()
      if (next) fire(next.sessionId, next.input)
    }
    function fire(sid: string, turnInput: TurnInput): void {
      inFlight.current = true
      useBoard.getState().setTurnInFlight(true)
      // Dialogue-only chat (store.ts's `commit`): only a `chat`-kind turn's
      // `say` actions belong in the chat transcript; everything else
      // (start/event/answer) is narration and stays caption-only.
      useBoard.getState().setActiveTurnKind(turnInput.kind === 'chat' ? 'chat' : 'other')
      void streamTurn(sid, turnInput, {
        onAction: (a) => useBoard.getState().enqueue(a),
        onPhase: (p) => setPhase(p),
        onWarn: (m) => useBoard.setState((s) => ({ chat: [...s.chat, { from: 'system', text: m }] })),
        onDone: settle,
        onError: (m) => {
          setError(m)
          // P-E follow-up (P-B feedback fold-in): a failed `chat`-kind turn
          // used to only surface via the topbar error chip, easy to miss
          // since the student's own question just sits in the transcript
          // with no reply. Mirror it into the chat log itself, system-styled
          // (same treatment as onWarn above), so the transcript itself shows
          // the tutor didn't answer instead of silently going quiet.
          if (turnInput.kind === 'chat') {
            useBoard.setState((s) => ({
              chat: [...s.chat, { from: 'error', text: "Couldn't reach the tutor — try again." }],
            }))
          }
          settle()
        },
      })
    }
    if (inFlight.current) {
      if (input.kind === 'event') {
        const idx = queue.current.findIndex((t) => t.input.kind === 'event')
        if (idx !== -1) {
          queue.current[idx] = { sessionId, input } // latest event wins over the one it replaces
          return
        }
      }
      queue.current.push({ sessionId, input }) // chat/answer/start (or the first queued event): never dropped
      return
    }
    fire(sessionId, input)
  }

  useEffect(() => {
    if (!session) return
    const id = session.id
    setEventSink((event) => {
      // `ev:'answer'` is fully covered by the explicit `{kind:'answer'}` turn
      // (see handleAnswer) — forwarding it here too would fire a second,
      // spurious server turn per answer. param/select/nav pass through as-is.
      if (event.ev === 'answer') return
      runTurn(id, { kind: 'event', event })
    })
    return () => setEventSink(() => {})
  }, [session])

  async function handlePick(topic: string): Promise<void> {
    useBoard.getState().reset() // wipe any previous session's board/timeline/ask state
    setError(null)
    setPhase({ phase: 'plan', beatIndex: 0 })
    setSidebarTab('chat')
    setWarmupTaken(false)
    warmupFiredRef.current = false
    try {
      const info = await createSession(topic)
      setGateTopic(null) // clear a stale gate prompt on a fresh success
      setSession(info)
      if (info.warning) {
        useBoard.setState((s) => ({ chat: [...s.chat, { from: 'system', text: `Note: ${info.warning}` }] }))
      }
      runTurn(info.id, { kind: 'start' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === ACCESS_GATE_ERROR) {
        setGateTopic(topic) // show the code prompt; keep the topic to retry
        return
      }
      setError(message)
    }
  }

  function submitGateCode(e: FormEvent): void {
    e.preventDefault()
    const code = gateCode.trim()
    if (code === '' || gateTopic === null) return
    setAccessCode(code)
    const topic = gateTopic
    setGateCode('')
    void handlePick(topic)
  }

  function handleChatSend(text: string): void {
    if (!session) return
    // The student's own message still lands in the chat panel either way
    // (ChatPanel.tsx appends it locally before calling this) -- only the
    // server turn kind differs.
    if (isContinueIntent(text)) {
      runTurn(session.id, { kind: 'continue' })
      return
    }
    runTurn(session.id, { kind: 'chat', text })
  }

  function handleAnswer(askId: string, value: string): void {
    if (!session) return
    runTurn(session.id, { kind: 'answer', askId, value })
  }

  function handleContinue(): void {
    if (!session) return
    runTurn(session.id, { kind: 'continue' })
  }

  function handleWarmup(): void {
    if (!session) return
    if (warmupFiredRef.current) return // already fired for this session — ignore a double click
    warmupFiredRef.current = true
    setWarmupTaken(true)
    runTurn(session.id, { kind: 'warmup' })
  }

  if (!session) {
    // Landing uses its OWN full-height shell, not `.app-shell` — the app grid
    // reserves a fixed topbar row as its first track, which (with no topbar
    // rendered here) crushed TopicPicker into that row and clipped the centred
    // header. `.landing-shell` is a plain flex column at full viewport height.
    return (
      <div className="landing-shell">
        {gateTopic !== null ? (
          <form className="access-gate" onSubmit={submitGateCode}>
            <p className="access-gate-copy">This board is locked. Enter the access code to continue.</p>
            <input
              type="text"
              value={gateCode}
              onInput={(e) => setGateCode(e.currentTarget.value)}
              placeholder="Access code"
              aria-label="access code"
              autoFocus
            />
            <button type="submit">Unlock</button>
          </form>
        ) : (
          <TopicPicker onPick={handlePick} />
        )}
        {error && <div className="app-error">{error}</div>}
      </div>
    )
  }

  const beatTotal = session.beatTitles.length

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand-mark" aria-hidden="true" />
        <span className="topbar-title">{session.title}</span>
        <span className="chip chip-phase">{phase.phase}</span>
        {beatTotal > 0 && (
          <span className="chip">
            beat {Math.min(phase.beatIndex + 1, beatTotal)}/{beatTotal}
          </span>
        )}
        {session.prereqCount > 0 && !warmupTaken && ask === null && (
          <button type="button" className="warmup-chip" onClick={handleWarmup}>
            Warm-up questions
          </button>
        )}
        {error && <span className="chip chip-error">{error}</span>}
      </header>
      <div className="main">
        <div className="board-wrap">
          <Board />
          <div className="caption">
            {captionPrev && <div className="caption-ghost">{captionPrev}</div>}
            {caption}
          </div>
          <AskWidget onAnswer={handleAnswer} />
          <ControlStrip />
          <PlayerBar onContinue={handleContinue} />
        </div>
        <div className="sidebar">
          <div className="sidebar-tabs">
            <button
              type="button"
              className="tab-chat"
              aria-selected={sidebarTab === 'chat'}
              onClick={() => setSidebarTab('chat')}
            >
              Chat
            </button>
            <button
              type="button"
              className="tab-transcript"
              aria-selected={sidebarTab === 'transcript'}
              onClick={() => setSidebarTab('transcript')}
            >
              Transcript
            </button>
          </div>
          {sidebarTab === 'chat' ? <ChatPanel onSend={handleChatSend} /> : <TranscriptPanel />}
        </div>
      </div>
    </div>
  )
}
