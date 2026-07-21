// api.test.ts — TDD for the client's HTTP/SSE transport (client/src/api.ts).
//
// `parseSSE` is tested standalone (no fetch/network involved at all): it's a
// pure async generator over whatever chunks a "chunkFeeder" async iterable
// hands it, so tests just build one from a plain array of strings.
//
// `createSession`/`streamTurn` are tested against a mocked `global.fetch`
// returning *real* `Response` objects (Node 22 has real fetch/Response/
// ReadableStream/TextDecoderStream globally) — this exercises the real
// `res.body.pipeThrough(new TextDecoderStream())` codepath, not a stub of it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Action, applyAction, emptyScene } from '@board/shared'
import { adoptAccessCodeFromUrl, createSession, parseSSE, setAccessCode, streamTurn, type StreamHandlers } from '../src/api'
import { useBoard } from '../src/store'

// ---------------------------------------------------------------------------
// parseSSE
// ---------------------------------------------------------------------------

async function* feed(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of gen) out.push(v)
  return out
}

describe('parseSSE', () => {
  it('parses a single complete frame delivered in one chunk', async () => {
    const events = await collect(parseSSE(feed(['event: action\ndata: {"op":"step","title":"a"}\n\n'])))
    expect(events).toEqual([{ event: 'action', data: '{"op":"step","title":"a"}' }])
  })

  it('parses multiple frames delivered in one chunk', async () => {
    const body = 'event: phase\ndata: {"phase":"teach","beatIndex":0}\n\n' + 'event: done\ndata: {"usage":{}}\n\n'
    const events = await collect(parseSSE(feed([body])))
    expect(events).toEqual([
      { event: 'phase', data: '{"phase":"teach","beatIndex":0}' },
      { event: 'done', data: '{"usage":{}}' },
    ])
  })

  it('reassembles a frame split across multiple chunks, mid-line and mid-field', async () => {
    const chunks = ['event: acti', 'on\ndata: {"op":"step",', '"title":"a"}\n', '\n']
    const events = await collect(parseSSE(feed(chunks)))
    expect(events).toEqual([{ event: 'action', data: '{"op":"step","title":"a"}' }])
  })

  it('reassembles the blank-line frame terminator itself when split across chunks', async () => {
    // worst case: the \n\n separator's two newlines arrive in different chunks
    const chunks = ['event: done\ndata: {}\n', '\n']
    const events = await collect(parseSSE(feed(chunks)))
    expect(events).toEqual([{ event: 'done', data: '{}' }])
  })

  it('joins multiple data: lines in one frame with a newline, per the SSE spec', async () => {
    const events = await collect(parseSSE(feed(['event: say\ndata: line one\ndata: line two\n\n'])))
    expect(events).toEqual([{ event: 'say', data: 'line one\nline two' }])
  })

  it('defaults the event name to "message" when no event: line is present', async () => {
    const events = await collect(parseSSE(feed(['data: {"x":1}\n\n'])))
    expect(events).toEqual([{ event: 'message', data: '{"x":1}' }])
  })

  it('ignores a frame with no data: line at all (e.g. a bare comment/keep-alive)', async () => {
    const events = await collect(parseSSE(feed([': keep-alive\n\n', 'event: done\ndata: {}\n\n'])))
    expect(events).toEqual([{ event: 'done', data: '{}' }])
  })

  it('processes frames incrementally, not buffered until the iterable ends', async () => {
    // Regression guard for "streams events as they arrive" rather than
    // collecting everything and yielding it all at the end: a for-await
    // consumer should be able to see the first event before the feeder has
    // produced its second chunk.
    let secondChunkFed = false
    async function* slowFeed(): AsyncGenerator<string> {
      yield 'event: a\ndata: 1\n\n'
      secondChunkFed = true
      yield 'event: b\ndata: 2\n\n'
    }
    const seenBeforeSecondChunk: boolean[] = []
    for await (const evt of parseSSE(slowFeed())) {
      seenBeforeSecondChunk.push(secondChunkFed)
      void evt
    }
    expect(seenBeforeSecondChunk).toEqual([false, true])
  })
})

// ---------------------------------------------------------------------------
// fetch mocking helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// Builds a real ReadableStream<Uint8Array> Response, delivering the frames
// split into multiple chunks (even mid-frame) to exercise the same
// reassembly path as the parseSSE tests above, end to end through streamTurn.
function sseResponse(frames: string[], chunkSize = 17): Response {
  const bytes = new TextEncoder().encode(frames.join(''))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize))
      }
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function noHandlersCalled(): StreamHandlers {
  return {
    onAction: vi.fn(),
    onPhase: vi.fn(),
    onWarn: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe('createSession', () => {
  it('POSTs {topic} to /api/session and resolves the session info', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('/api/session')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ topic: 'Quadratic Functions' })
      return jsonResponse({ id: 's1', title: 'Quadratics', beatTitles: ['b1', 'b2'], prereqCount: 2 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const info = await createSession('Quadratic Functions')
    expect(info).toEqual({ id: 's1', title: 'Quadratics', beatTitles: ['b1', 'b2'], prereqCount: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('passes through an optional warning field (blueprint generation failed, degraded to freeform)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ id: 's2', title: 'topic', beatTitles: [], prereqCount: 0, warning: 'planner down' })),
    )
    const info = await createSession('topic')
    expect(info.warning).toBe('planner down')
  })

  it('throws with the server-provided error message on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'boom' }, 500)))
    await expect(createSession('x')).rejects.toThrow('boom')
  })
})

// ---------------------------------------------------------------------------
// Access gate header (server/src/accessGate.ts's `x-board-code`) — the code
// lives in localStorage('board:code'); setAccessCode writes it, and every
// fetch (createSession + streamTurn) attaches it when present, omits it when
// absent (so local dev / an unconfigured deployment sends no header at all).
// ---------------------------------------------------------------------------
describe('access code header (x-board-code)', () => {
  it('setAccessCode persists the code to localStorage under board:code', () => {
    setAccessCode('abcd1234')
    expect(localStorage.getItem('board:code')).toBe('abcd1234')
  })

  it('createSession omits x-board-code when no code is stored', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['x-board-code']).toBeUndefined()
      return jsonResponse({ id: 's1', title: 't', beatTitles: [], prereqCount: 0 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await createSession('topic')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('createSession attaches x-board-code from localStorage when a code is stored', async () => {
    setAccessCode('sekrit-code')
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['x-board-code']).toBe('sekrit-code')
      return jsonResponse({ id: 's1', title: 't', beatTitles: [], prereqCount: 0 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await createSession('topic')
  })

  it('streamTurn attaches x-board-code from localStorage when a code is stored', async () => {
    setAccessCode('sekrit-code')
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['x-board-code']).toBe('sekrit-code')
      return sseResponse([sseFrame('done', { usage: {} })])
    })
    vi.stubGlobal('fetch', fetchMock)
    await streamTurn('s1', { kind: 'start' }, noHandlersCalled())
  })

  it('a 401 access-code-required response surfaces its message via createSession rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'access code required' }, 401)))
    await expect(createSession('topic')).rejects.toThrow('access code required')
  })
})

// ---------------------------------------------------------------------------
// adoptAccessCodeFromUrl — shareable-link auth. A `?code=` or `#code=` in the
// landing URL is persisted to localStorage('board:code') and scrubbed from
// the address bar (replaceState) before the app renders (main.tsx calls this
// pre-render, so the gallery hash check and the first fetch both see the
// post-scrub state).
// ---------------------------------------------------------------------------
describe('adoptAccessCodeFromUrl', () => {
  function landOn(path: string): void {
    window.history.replaceState(null, '', path)
  }

  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('persists ?code= to localStorage and strips it from the URL', () => {
    landOn('/?code=link-code')
    adoptAccessCodeFromUrl()
    expect(localStorage.getItem('board:code')).toBe('link-code')
    expect(window.location.search).toBe('')
    expect(window.location.href.includes('link-code')).toBe(false)
  })

  it('persists #code= to localStorage and clears the hash', () => {
    landOn('/#code=hash-code')
    adoptAccessCodeFromUrl()
    expect(localStorage.getItem('board:code')).toBe('hash-code')
    expect(window.location.hash).toBe('')
  })

  it('preserves unrelated query params while stripping only code', () => {
    landOn('/?utm=demo&code=abc&x=1')
    adoptAccessCodeFromUrl()
    expect(localStorage.getItem('board:code')).toBe('abc')
    const params = new URLSearchParams(window.location.search)
    expect(params.get('utm')).toBe('demo')
    expect(params.get('x')).toBe('1')
    expect(params.get('code')).toBeNull()
  })

  it('URL-decodes a percent-encoded hash code', () => {
    landOn('/#code=with%20space')
    adoptAccessCodeFromUrl()
    expect(localStorage.getItem('board:code')).toBe('with space')
  })

  it('a link code overwrites a previously stored code', () => {
    setAccessCode('old-code')
    landOn('/?code=new-code')
    adoptAccessCodeFromUrl()
    expect(localStorage.getItem('board:code')).toBe('new-code')
  })

  it('does nothing when the URL carries no code (stored code untouched)', () => {
    setAccessCode('keep-me')
    landOn('/#gallery')
    adoptAccessCodeFromUrl()
    expect(localStorage.getItem('board:code')).toBe('keep-me')
    expect(window.location.hash).toBe('#gallery')
  })
})

// ---------------------------------------------------------------------------
// streamTurn
// ---------------------------------------------------------------------------

describe('streamTurn', () => {
  it('POSTs the TurnInput body to /api/session/:id/turn', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('/api/session/s1/turn')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ kind: 'start' })
      return sseResponse([sseFrame('done', { usage: {} })])
    })
    vi.stubGlobal('fetch', fetchMock)

    const handlers = noHandlersCalled()
    await streamTurn('s1', { kind: 'start' }, handlers)
    expect(handlers.onDone).toHaveBeenCalledTimes(1)
  })

  it('dispatches one handler call per SSE event type, in stream order', async () => {
    const action: Action = { op: 'say', text: 'hi' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          sseFrame('phase', { phase: 'teach', beatIndex: 1 }),
          sseFrame('action', action),
          sseFrame('warn', { reason: 'dropped one action' }),
          sseFrame('done', { usage: { input: 10, output: 5, cacheRead: 0 } }),
        ]),
      ),
    )

    const calls: string[] = []
    const handlers: StreamHandlers = {
      onAction: (a) => calls.push(`action:${JSON.stringify(a)}`),
      onPhase: (p) => calls.push(`phase:${JSON.stringify(p)}`),
      onWarn: (m) => calls.push(`warn:${m}`),
      onDone: () => calls.push('done'),
      onError: (m) => calls.push(`error:${m}`),
    }

    await streamTurn('s1', { kind: 'chat', text: 'hello' }, handlers)

    expect(calls).toEqual([
      'phase:{"phase":"teach","beatIndex":1}',
      `action:${JSON.stringify(action)}`,
      'warn:dropped one action',
      'done',
    ])
  })

  it('calls onError with the server message on an `error` SSE event, and does not call onDone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([sseFrame('action', { op: 'say', text: 'sorry' }), sseFrame('error', { message: 'model exhausted retries' })])),
    )

    const handlers = noHandlersCalled()
    await streamTurn('s1', { kind: 'start' }, handlers)

    expect(handlers.onError).toHaveBeenCalledWith('model exhausted retries')
    expect(handlers.onDone).not.toHaveBeenCalled()
  })

  it('surfaces a non-OK response (409 turn-in-flight) via onError instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'turn in flight' }, 409)))

    const handlers = noHandlersCalled()
    await expect(streamTurn('s1', { kind: 'event', event: { ev: 'select', id: 'p1' } }, handlers)).resolves.toBeUndefined()

    expect(handlers.onError).toHaveBeenCalledWith('turn in flight')
    expect(handlers.onAction).not.toHaveBeenCalled()
  })

  it('surfaces a 404 session-not-found response via onError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'session not found' }, 404)))
    const handlers = noHandlersCalled()
    await streamTurn('bad-id', { kind: 'start' }, handlers)
    expect(handlers.onError).toHaveBeenCalledWith('session not found')
  })

  it('surfaces a network-level fetch rejection via onError instead of rejecting (finding #3)', async () => {
    // A fetch that REJECTS (offline/DNS/CORS), not one that resolves non-OK.
    // Must resolve (not throw) so App.tsx's `void streamTurn(...)` still runs
    // settle() and the turn queue does not deadlock.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const handlers = noHandlersCalled()
    await expect(streamTurn('s1', { kind: 'start' }, handlers)).resolves.toBeUndefined()
    expect(handlers.onError).toHaveBeenCalledWith('Failed to fetch')
    expect(handlers.onDone).not.toHaveBeenCalled()
    expect(handlers.onAction).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Integration: createSession -> streamTurn(start) -> real timeline, per the
// task-15 context's substitute for the (deferred, needs-real-key) live smoke.
// ---------------------------------------------------------------------------

describe('integration: createSession + streamTurn(start) walk into the real store/timeline', () => {
  it('enqueues 6 scripted actions into the real timeline in order and surfaces phase updates', async () => {
    useBoard.setState({ scene: emptyScene, history: [], steps: [], chat: [], ask: null })

    // `set` with no `dur`/on a nonexistent id: applyParamChange no-ops
    // safely (see shared/src/scene.ts) and the timeline commits it with NO
    // post-commit hold (unlike add/step/etc.), so all 6 land in `history`
    // within a handful of microtask ticks — no real 350ms-per-action wait.
    const actions: Action[] = Array.from({ length: 6 }, (_, i) => ({ op: 'set', id: `marker${i}`, k: 'x', v: i }))

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (url === '/api/session') {
          expect(JSON.parse(String(init?.body))).toEqual({ topic: 'Quadratic Functions' })
          return jsonResponse({ id: 's1', title: 'Quadratic Functions', beatTitles: ['intro', 'graphing'], prereqCount: 1 })
        }
        if (url === '/api/session/s1/turn') {
          expect(JSON.parse(String(init?.body))).toEqual({ kind: 'start' })
          return sseResponse([
            sseFrame('phase', { phase: 'teach', beatIndex: 0 }),
            ...actions.map((a) => sseFrame('action', a)),
            sseFrame('done', { usage: { input: 1, output: 1, cacheRead: 0 } }),
          ])
        }
        throw new Error(`unexpected fetch url: ${String(url)}`)
      }),
    )

    const info = await createSession('Quadratic Functions')
    expect(info.id).toBe('s1')

    const phases: Array<{ phase: string; beatIndex: number }> = []
    await streamTurn(info.id, { kind: 'start' }, {
      onAction: (a) => useBoard.getState().enqueue(a),
      onPhase: (p) => phases.push(p),
      onWarn: () => {},
      onDone: () => {},
      onError: (m) => {
        throw new Error(`unexpected onError: ${m}`)
      },
    })

    // Let the real timeline's microtask chain finish committing all 6.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(useBoard.getState().history).toEqual(actions)
    expect(phases).toEqual([{ phase: 'teach', beatIndex: 0 }])
  })
})
