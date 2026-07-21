// api.ts — HTTP + SSE transport to the Board tutor server.
//
// Two calls: `createSession` (session bootstrap) and `streamTurn` (one
// turn's worth of server-sent events). `parseSSE` is exported standalone —
// pure, no fetch dependency — so the frame-reassembly logic is unit-testable
// with synthetic chunk sequences instead of a real network stream (see
// client/test/api.test.ts). `streamTurn` is just fetch + TextDecoderStream +
// parseSSE + a dispatch table.
//
// Server contract (server/src/routes.ts + session.ts — fixed HTTP shape;
// this branch doesn't carry the server tree itself, see task-15 context):
//   POST /api/session {topic}
//     -> 200 {id, title, beatTitles, prereqCount, warning?}
//   POST /api/session/:id/turn {TurnInput}
//     -> SSE stream: event: action|phase|warn|done|error, one JSON `data:` each
//     -> 404 {error} if the session doesn't exist, 409 {error} if a turn is
//        already in flight (both plain JSON, no SSE body to read at all)
import type { Action, BoardEvent } from '@board/shared'

// ---------------------------------------------------------------------------
// Access gate (server/src/accessGate.ts) — inert unless the deployment has
// BOARD_ACCESS_CODE set. When it IS set, every /api/* call (except
// /api/health) must carry a matching `x-board-code` header or the server
// 401s with {error:'access code required'}. The code lives in localStorage
// only (never sent anywhere but this header) so it survives a page reload;
// App.tsx prompts for it the first time a call comes back gated (see
// App.tsx's access-gate UI) and calls setAccessCode to persist it.
// ---------------------------------------------------------------------------
const ACCESS_CODE_STORAGE_KEY = 'board:code'

function getAccessCode(): string | null {
  try {
    return localStorage.getItem(ACCESS_CODE_STORAGE_KEY)
  } catch {
    return null // localStorage unavailable (e.g. private mode) — degrade to no header
  }
}

export function setAccessCode(code: string): void {
  try {
    localStorage.setItem(ACCESS_CODE_STORAGE_KEY, code)
  } catch {
    // ignore — nothing sensible to do if storage is unavailable
  }
}

// Shareable-link auth: a link can carry the code itself as `?code=XXX` or
// `#code=XXX` (hash form never reaches server/CDN logs). Called once at boot
// (main.tsx, before render) — persists the code, then scrubs it from the
// address bar via replaceState so it doesn't linger in the URL, browser
// history, or screenshots. A code in the link overwrites a stored one, so a
// re-shared link with a rotated code "just works" on a stale tab's profile.
export function adoptAccessCodeFromUrl(): void {
  try {
    const url = new URL(window.location.href)
    const fromSearch = url.searchParams.get('code')
    const fromHash = url.hash.startsWith('#code=')
      ? decodeURIComponent(url.hash.slice('#code='.length))
      : null
    const code = fromSearch ?? fromHash
    if (!code) return
    setAccessCode(code)
    if (fromSearch !== null) url.searchParams.delete('code')
    if (fromHash !== null) url.hash = ''
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
  } catch {
    // ignore — worst case the prompt-based gate still works
  }
}

function withAccessHeader(headers: Record<string, string>): Record<string, string> {
  const code = getAccessCode()
  return code ? { ...headers, 'x-board-code': code } : headers
}

// ---------------------------------------------------------------------------
// TurnInput — mirrors server/src/session.ts's TurnInput union exactly (not
// re-exported from there: the server tree isn't part of this branch/worktree,
// only the HTTP contract is fixed). Note `start` carries no `text` field —
// the brief's flattened `{kind, text?, event?, askId?, value?}` sketch is a
// looser description of the same four shapes.
// ---------------------------------------------------------------------------
export type TurnInput =
  | { kind: 'start' }
  | { kind: 'chat'; text: string }
  | { kind: 'event'; event: BoardEvent }
  | { kind: 'answer'; askId: string; value: string }
  // task D-2: fired by the "Warm-up questions" chip (App.tsx) -- runs the
  // prerequisite probe sequence (opt-in now that `start` teaches beat 0
  // immediately), then resumes teaching where the student left off. See
  // server/src/session.ts's TurnInput for the state machine this drives.
  | { kind: 'warmup' }
  // task F-1: fired by the player-bar Continue button and by trivial
  // continue-intent chat phrases ("ok", "next", "what's next", ...) --
  // advances the lesson (or, if a check is pending, politely refuses and
  // points back at it) instead of routing through `chat`, which never
  // advances anything. See server/src/session.ts's TurnInput/composeContinue.
  | { kind: 'continue' }

export type SessionInfo = {
  id: string
  title: string
  beatTitles: string[]
  prereqCount: number
  warning?: string
}

export type StreamHandlers = {
  onAction(a: Action): void
  onPhase(p: { phase: string; beatIndex: number }): void
  onWarn(m: string): void
  onDone(): void
  onError(m: string): void
}

export type SSEEvent = { event: string; data: string }

// ---------------------------------------------------------------------------
// parseSSE — feed it an async iterable of raw text chunks (in whatever
// pieces the network happened to deliver them — mid-line, mid-field, even
// mid-separator), get back the reassembled {event, data} frames as they
// complete. Per the SSE spec: a frame ends at a blank line (\n\n); a frame's
// `data:` field may repeat across several lines (joined with \n); any other
// line (`:`-prefixed comments, `id:`, `retry:`, or simply no recognized
// field) is ignored. A frame with no `data:` line at all produces no event.
// No `event:` line defaults the event name to "message" (SSE spec default).
// ---------------------------------------------------------------------------
export async function* parseSSE(chunks: AsyncIterable<string>): AsyncGenerator<SSEEvent> {
  let buffer = ''
  for await (const chunk of chunks) {
    buffer += chunk
    let sep: number
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const parsed = parseFrame(frame)
      if (parsed) yield parsed
    }
  }
}

function parseFrame(frame: string): SSEEvent | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim())
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------
export async function createSession(topic: string): Promise<SessionInfo> {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: withAccessHeader({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ topic }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'createSession'))
  return (await res.json()) as SessionInfo
}

// ---------------------------------------------------------------------------
// streamTurn — POST the turn, then read the SSE body and dispatch to
// `handlers` per event as it arrives (not buffered until the stream ends).
// A non-OK / bodyless response (404 session-not-found, 409 turn-in-flight)
// has no SSE stream to read — reported via `onError` rather than thrown, so
// callers get one consistent error channel regardless of which layer failed.
// ---------------------------------------------------------------------------
export async function streamTurn(sessionId: string, input: TurnInput, handlers: StreamHandlers): Promise<void> {
  // The fetch itself (DNS/offline/CORS) can reject, not just resolve non-OK.
  // Such a rejection must surface via onError like every other failure — if it
  // escaped, App.tsx's `void streamTurn(...)` would leave the turn queue's
  // in-flight flag stuck true and deadlock all further turns (finding #3).
  let reader: ReadableStreamDefaultReader<string>
  try {
    const res = await fetch(`/api/session/${sessionId}/turn`, {
      method: 'POST',
      headers: withAccessHeader({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(input),
    })
    if (!res.ok || !res.body) {
      handlers.onError(await errorMessage(res, 'turn'))
      return
    }
    reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  } catch (err) {
    handlers.onError(err instanceof Error ? err.message : String(err))
    return
  }

  try {
    for await (const evt of parseSSE(readAll(reader))) {
      dispatch(evt, handlers)
    }
  } catch (err) {
    handlers.onError(err instanceof Error ? err.message : String(err))
  }
}

async function* readAll(reader: ReadableStreamDefaultReader<string>): AsyncGenerator<string> {
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    if (value) yield value
  }
}

function dispatch(evt: SSEEvent, handlers: StreamHandlers): void {
  switch (evt.event) {
    case 'action':
      handlers.onAction(JSON.parse(evt.data) as Action)
      return
    case 'phase':
      handlers.onPhase(JSON.parse(evt.data) as { phase: string; beatIndex: number })
      return
    case 'warn':
      handlers.onWarn((JSON.parse(evt.data) as { reason: string }).reason)
      return
    case 'done':
      handlers.onDone()
      return
    case 'error':
      handlers.onError((JSON.parse(evt.data) as { message: string }).message)
      return
    default:
      return // unrecognized event name — ignore rather than throw
  }
}

// Best-effort: the server's non-2xx responses are plain {error} JSON, but
// fall back to a generic "<what> failed: HTTP <status>" if the body isn't
// there or isn't JSON (defensive — should not happen against this contract).
async function errorMessage(res: Response, what: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    if (body.error) return body.error
  } catch {
    // not JSON, or already consumed — fall through to the generic message
  }
  return `${what} failed: HTTP ${res.status}`
}
