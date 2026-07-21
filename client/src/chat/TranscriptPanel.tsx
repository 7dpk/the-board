// TranscriptPanel.tsx — D-2's Transcript tab (right sidebar, alongside
// ChatPanel — see App.tsx's `sidebar-tabs`). Feedback: "it should store
// whatever text it has shown in the right chat bar, for us to reference" —
// `history` (store.ts) already IS that record of everything narrated; this
// just walks it (via `selectTranscript`, a pure selector, NOT new state) and
// renders every `say` line grouped under its beat's `step` title.
//
// Scroll pin: same auto-follow contract as ChatPanel's `.chat-log`
// (scrollPin.ts's `isNearBottom`) — pinned to the bottom while the reader
// hasn't scrolled away, so new narration doesn't force the view back down
// once they've scrolled up to reread something earlier in the lesson.
import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { selectTranscript, useBoard } from '../store'
import { isNearBottom } from '../scrollPin'

export default function TranscriptPanel(): ReactElement {
  const history = useBoard((s) => s.history)
  const groups = selectTranscript(history)
  const logRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true) // starts pinned: nothing to scroll away from yet

  function handleScroll(): void {
    const el = logRef.current
    if (!el) return
    pinnedRef.current = isNearBottom(el)
  }

  // Re-pin on every new line (not just every new group) -- a growing final
  // group's lines wouldn't otherwise re-trigger this effect.
  const lineCount = groups.reduce((n, g) => n + g.lines.length, 0)
  useEffect(() => {
    const el = logRef.current
    if (!el || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [lineCount])

  return (
    <div className="transcript-log" ref={logRef} onScroll={handleScroll}>
      {groups.length === 0 && (
        <div className="transcript-empty">
          <div className="transcript-empty-title">Nothing narrated yet</div>
          <div className="transcript-empty-sub">
            The tutor&rsquo;s spoken lines collect here as the lesson plays, grouped by step.
          </div>
        </div>
      )}
      {groups.map((g, i) => (
        <div key={i} className="transcript-group">
          {g.title && <div className="transcript-title">{g.title}</div>}
          {g.lines.map((line, j) => (
            <div key={j} className="transcript-line">
              {line}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
