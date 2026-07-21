import { describe, it, expect, vi, afterEach } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { emptyScene, type Scene } from '@board/shared'
import { streamBoardTurn, BoardTurnError, type TurnCallbacks } from '../src/anthropic'
import { BOARD_MODEL } from '../src/models'

// ---------------------------------------------------------------------------
// Test doubles: a fake `client.messages.create({..., stream:true})` shaped
// exactly like the real SDK's RAW event stream (`Stream<RawMessageStreamEvent>`
// — a plain async iterable of message_start/content_block_delta/message_delta
// events, with NO accumulation) — zero SDK network dependency, and
// deliberately NOT the `MessageStream` helper shape (no `finalMessage()`),
// since streamBoardTurn no longer uses `client.messages.stream()`.
// ---------------------------------------------------------------------------

type FakeUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number | null }

function chunksOf(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

// `includeMessageDelta` lets tests exercise the defensive path where a turn's
// raw event stream never carries a message_delta at all (usage.output must
// then default to 0 rather than throw or stay undefined).
function fakeStreamFor(
  fullJson: string,
  usage: FakeUsage,
  chunkSize = 17,
  includeMessageDelta = true,
): AsyncIterable<Anthropic.RawMessageStreamEvent> {
  const events: Anthropic.RawMessageStreamEvent[] = [
    {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: usage.input_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
        },
      },
    } as unknown as Anthropic.RawMessageStartEvent,
  ]
  for (const partial_json of chunksOf(fullJson, chunkSize)) {
    events.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json },
    } as Anthropic.RawContentBlockDeltaEvent)
  }
  if (includeMessageDelta) {
    events.push({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null, container: null, stop_details: null },
      usage: { output_tokens: usage.output_tokens },
    } as unknown as Anthropic.RawMessageDeltaEvent)
  }
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e
    },
  }
}

function fakeClientFor(fullJson: string, usage: FakeUsage, chunkSize = 17, includeMessageDelta = true) {
  return {
    messages: {
      create: async (_params: Anthropic.MessageCreateParamsStreaming) =>
        fakeStreamFor(fullJson, usage, chunkSize, includeMessageDelta),
    },
  }
}

function collectingCb(): TurnCallbacks & { seenActions: unknown[]; seenErrors: string[] } {
  const seenActions: unknown[] = []
  const seenErrors: string[] = []
  return {
    seenActions,
    seenErrors,
    onAction: (a) => seenActions.push(a),
    onError: (reason) => seenErrors.push(reason),
  }
}

const scene: Scene = emptyScene

describe('streamBoardTurn', () => {
  it('(a) fires onAction per action, in order, sanitized, for a chunked canonical plan', async () => {
    const plan = {
      actions: [
        { op: 'add', c: 'axes', id: 'AX1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
        { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2 - 4' },
        { op: 'say', text: 'a parabola' },
      ],
    }
    const client = fakeClientFor(JSON.stringify(plan), { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 })
    const cb = collectingCb()

    const result = await streamBoardTurn({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'draw a parabola' }],
      scene,
      cb,
    })

    // sanitizeId lowercases ids -> "AX1" is normalized to "ax1", so the plot's
    // on:"ax1" reference resolves against the axes just added.
    expect(result.actions).toHaveLength(3)
    expect(result.actions[0]).toMatchObject({ op: 'add', c: 'axes', id: 'ax1' })
    expect(result.actions[1]).toMatchObject({ op: 'add', c: 'plot', id: 'p1', on: 'ax1' })
    expect(result.actions[2]).toMatchObject({ op: 'say', text: 'a parabola' })

    expect(cb.seenActions).toEqual(result.actions)
    expect(cb.seenErrors).toEqual([])
  })

  it('(b) drops an action referencing an unknown id and reports it via onError', async () => {
    const plan = {
      actions: [
        { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
        { op: 'set', id: 'ghost', k: 'color', v: 'red' },
        { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2 - 4' },
      ],
    }
    const client = fakeClientFor(JSON.stringify(plan), { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0 })
    const cb = collectingCb()

    const result = await streamBoardTurn({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      cb,
    })

    expect(result.actions).toHaveLength(2)
    expect(result.actions.map((a) => a.op)).toEqual(['add', 'add'])
    expect(cb.seenErrors).toHaveLength(1)
    expect(cb.seenErrors[0]).toMatch(/unknown id: ghost/)
  })

  it('(c) rewrites {{root1(1,0,-4)}} in a say action to -2', async () => {
    const plan = {
      actions: [{ op: 'say', text: 'the smaller root is {{root1(1,0,-4)}}' }],
    }
    const client = fakeClientFor(JSON.stringify(plan), { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 })
    const cb = collectingCb()

    const result = await streamBoardTurn({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      cb,
    })

    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]).toMatchObject({ op: 'say', text: 'the smaller root is -2' })
    expect(cb.seenErrors).toEqual([])
  })

  it('(c2) on unverifiable math, still emits the action with ? placeholders and reports via onError', async () => {
    const plan = {
      actions: [{ op: 'say', text: 'bad math: {{nope(1,2)}}' }],
    }
    const client = fakeClientFor(JSON.stringify(plan), { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 })
    const cb = collectingCb()

    const result = await streamBoardTurn({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      cb,
    })

    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]).toMatchObject({ op: 'say', text: 'bad math: ?' })
    expect(cb.seenErrors).toHaveLength(1)
    expect(cb.seenErrors[0]).toMatch(/bad math expression/)
  })

  it('(a2) returns the scene accumulated by applying every emitted action (finding #1)', async () => {
    const plan = {
      actions: [
        { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
        { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2' },
        { op: 'set', id: 'p1', k: 'color', v: 'green' },
      ],
    }
    const client = fakeClientFor(JSON.stringify(plan), { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 })
    const cb = collectingCb()

    const result = await streamBoardTurn({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      cb,
    })

    expect(result.scene.elements.ax1).toBeDefined()
    expect(result.scene.elements.p1?.params.color).toBe('green')
    expect(result.scene.order).toEqual(['ax1', 'p1'])
  })

  it('(d) propagates usage from message_start/message_delta raw events', async () => {
    const plan = { actions: [{ op: 'say', text: 'hi' }] }
    const client = fakeClientFor(JSON.stringify(plan), {
      input_tokens: 123,
      output_tokens: 45,
      cache_read_input_tokens: 7,
    })
    const cb = collectingCb()

    const result = await streamBoardTurn({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      cb,
    })

    expect(result.usage).toEqual({ input: 123, output: 45, cacheRead: 7 })
  })

  it('(d2) defaults cacheRead to 0 when cache_read_input_tokens is null', async () => {
    const plan = { actions: [{ op: 'say', text: 'hi' }] }
    const client = fakeClientFor(JSON.stringify(plan), {
      input_tokens: 5,
      output_tokens: 5,
      cache_read_input_tokens: null,
    })
    const cb = collectingCb()

    const result = await streamBoardTurn({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      cb,
    })

    expect(result.usage.cacheRead).toBe(0)
  })

  it('(d3) defaults usage.output to 0 when message_delta never arrives', async () => {
    const plan = { actions: [{ op: 'say', text: 'hi' }] }
    const client = fakeClientFor(
      JSON.stringify(plan),
      { input_tokens: 8, output_tokens: 999, cache_read_input_tokens: 2 },
      17,
      /* includeMessageDelta */ false,
    )
    const cb = collectingCb()

    const result = await streamBoardTurn({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      cb,
    })

    // input/cacheRead still come from message_start; output has no source and
    // must default to 0 rather than throw or stay undefined.
    expect(result.usage).toEqual({ input: 8, output: 0, cacheRead: 2 })
    expect(result.actions).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Regression fixture for the production crash (S-1): DeepSeek's
  // Anthropic-compat endpoint (BOARD_MODEL=deepseek-v4-pro) sometimes emits
  // input_json_delta chunks whose concatenation contains a complete
  // `{"actions":[...]}` value FOLLOWED by trailing garbage (here, a duplicate
  // `{"actions":[]}`). The SDK's `client.messages.stream()` helper used to
  // accumulate these deltas through a vendored partial-JSON parser that threw
  // `AnthropicError: Unexpected non-whitespace character after JSON at
  // position N` on exactly this shape — asynchronously, inside MessageStream,
  // uncatchable by streamBoardTurn's try/catch. Now that streamBoardTurn reads
  // raw events via `messages.create({stream:true})` there is no such
  // accumulator: the trailing chunk flows straight into createActionExtractor,
  // which already tolerates it (depth returns to 0 with no captured object)
  // — so this must resolve normally with all valid actions emitted and usage
  // populated, and must NOT throw.
  // -------------------------------------------------------------------------

  it('(e) tolerates trailing garbage after a complete render_plan JSON value without throwing', async () => {
    const validPlan = {
      actions: [
        { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
        { op: 'say', text: 'a parabola' },
      ],
    }
    const trailingGarbage = { actions: [] }
    const fullJson = JSON.stringify(validPlan) + JSON.stringify(trailingGarbage)

    const client = fakeClientFor(fullJson, { input_tokens: 50, output_tokens: 30, cache_read_input_tokens: 4 })
    const cb = collectingCb()

    const result = await streamBoardTurn({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'draw a parabola' }],
      scene,
      cb,
    })

    expect(result.actions).toHaveLength(2)
    expect(result.actions[0]).toMatchObject({ op: 'add', c: 'axes', id: 'ax1' })
    expect(result.actions[1]).toMatchObject({ op: 'say', text: 'a parabola' })
    expect(cb.seenErrors).toEqual([])
    expect(result.usage).toEqual({ input: 50, output: 30, cacheRead: 4 })
  })

  it('defaults to BOARD_MODEL and forwards system/tool_choice/tools/stream to client.messages.create', async () => {
    const plan = { actions: [{ op: 'say', text: 'hi' }] }
    let capturedParams: Anthropic.MessageCreateParamsStreaming | undefined
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParamsStreaming) => {
          capturedParams = params
          return fakeStreamFor(JSON.stringify(plan), { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 })
        },
      },
    }

    await streamBoardTurn({
      client,
      system: 'be a good tutor',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      cb: collectingCb(),
    })

    expect(capturedParams?.model).toBe(BOARD_MODEL)
    expect(capturedParams?.stream).toBe(true)
    expect(capturedParams?.tool_choice).toEqual({ type: 'tool', name: 'render_plan' })
    expect(capturedParams?.tools).toHaveLength(1)
    expect(capturedParams?.tools?.[0]).toMatchObject({ name: 'render_plan', strict: true })
    expect(capturedParams?.system).toEqual([
      { type: 'text', text: 'be a good tutor', cache_control: { type: 'ephemeral' } },
    ])
    expect(capturedParams?.max_tokens).toBe(8000)
  })

  it('honors an explicit model override (escalation to PLANNER_MODEL)', async () => {
    const plan = { actions: [{ op: 'say', text: 'hi' }] }
    let capturedModel: string | undefined
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParamsStreaming) => {
          capturedModel = params.model
          return fakeStreamFor(JSON.stringify(plan), { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 })
        },
      },
    }

    await streamBoardTurn({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      model: 'claude-sonnet-5',
      cb: collectingCb(),
    })

    expect(capturedModel).toBe('claude-sonnet-5')
  })

  it('wraps a thrown Anthropic.RateLimitError as a retryable BoardTurnError', async () => {
    const client = {
      messages: {
        create: async (_params: Anthropic.MessageCreateParamsStreaming) => ({
          [Symbol.asyncIterator]: async function* (): AsyncGenerator<Anthropic.RawMessageStreamEvent> {
            throw new Anthropic.RateLimitError(429, {}, 'rate limited', new Headers())
          },
        }),
      },
    }

    await expect(
      streamBoardTurn({
        client,
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        scene,
        cb: collectingCb(),
      }),
    ).rejects.toMatchObject({ retryable: true })

    try {
      await streamBoardTurn({
        client,
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        scene,
        cb: collectingCb(),
      })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(BoardTurnError)
    }
  })

  it('wraps a thrown Anthropic.BadRequestError as a non-retryable BoardTurnError', async () => {
    const client = {
      messages: {
        create: async (_params: Anthropic.MessageCreateParamsStreaming) => ({
          [Symbol.asyncIterator]: async function* (): AsyncGenerator<Anthropic.RawMessageStreamEvent> {
            throw new Anthropic.BadRequestError(400, {}, 'bad request', new Headers())
          },
        }),
      },
    }

    await expect(
      streamBoardTurn({
        client,
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        scene,
        cb: collectingCb(),
      }),
    ).rejects.toMatchObject({ retryable: false })
  })

  it('(f) emits all partial actions before throwing, then rejects with retryable BoardTurnError', async () => {
    // Regression: ensure that when the raw event stream throws mid-iteration
    // (after yielding some valid input_json_delta chunks), all actions parsed
    // from those chunks are delivered to cb.onAction BEFORE the error propagates.
    // This tests the boundary between extractor.push completing actions and
    // stream iteration throwing.
    const validPlan = {
      actions: [
        { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
        { op: 'say', text: 'hello' },
      ],
    }
    const fullJson = JSON.stringify(validPlan)

    const client = {
      messages: {
        create: async (_params: Anthropic.MessageCreateParamsStreaming) => ({
          [Symbol.asyncIterator]: async function* (): AsyncGenerator<Anthropic.RawMessageStreamEvent> {
            // Emit message_start with usage
            yield {
              type: 'message_start',
              message: {
                usage: {
                  input_tokens: 10,
                  cache_read_input_tokens: 0,
                },
              },
            } as unknown as Anthropic.RawMessageStartEvent

            // Emit chunks of the JSON
            for (const chunk of chunksOf(fullJson, 17)) {
              yield {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: chunk },
              } as Anthropic.RawContentBlockDeltaEvent
            }

            // Now throw after all valid chunks are yielded
            throw new Anthropic.RateLimitError(429, {}, 'rate limited', new Headers())
          },
        }),
      },
    }

    const cb = collectingCb()

    await expect(
      streamBoardTurn({
        client,
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        scene,
        cb,
      }),
    ).rejects.toMatchObject({ retryable: true })

    // Both actions should have been emitted before the error was thrown
    expect(cb.seenActions).toHaveLength(2)
    expect(cb.seenActions[0]).toMatchObject({ op: 'add', c: 'axes', id: 'ax1' })
    expect(cb.seenActions[1]).toMatchObject({ op: 'say', text: 'hello' })
  })
})

// ---------------------------------------------------------------------------
// THINKING_DISABLED (BOARD_THINKING=disabled) — anthropic.ts reads this from
// models.ts at module-load time, so exercising both branches requires a
// fresh module evaluation per env value: stub the env, drop the cached
// module registry, then dynamic-import both models.ts and anthropic.ts so
// their top-level state re-runs against the stubbed env. See models.test.ts
// for the same pattern applied directly to models.ts.
// ---------------------------------------------------------------------------

describe('streamBoardTurn: thinking config follows BOARD_THINKING (models.ts)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('omits `thinking` entirely when BOARD_THINKING is unset (Claude default, unchanged behavior)', async () => {
    vi.stubEnv('BOARD_THINKING', undefined)
    vi.resetModules()
    const { streamBoardTurn: freshStreamBoardTurn } = await import('../src/anthropic')

    const plan = { actions: [{ op: 'say', text: 'hi' }] }
    let capturedParams: Anthropic.MessageCreateParamsStreaming | undefined
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParamsStreaming) => {
          capturedParams = params
          return fakeStreamFor(JSON.stringify(plan), { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 })
        },
      },
    }

    await freshStreamBoardTurn({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      cb: collectingCb(),
    })

    expect(capturedParams).not.toHaveProperty('thinking')
  })

  it('includes `thinking: {type: "disabled"}` when BOARD_THINKING=disabled', async () => {
    vi.stubEnv('BOARD_THINKING', 'disabled')
    vi.resetModules()
    const { streamBoardTurn: freshStreamBoardTurn } = await import('../src/anthropic')

    const plan = { actions: [{ op: 'say', text: 'hi' }] }
    let capturedParams: Anthropic.MessageCreateParamsStreaming | undefined
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParamsStreaming) => {
          capturedParams = params
          return fakeStreamFor(JSON.stringify(plan), { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 })
        },
      },
    }

    await freshStreamBoardTurn({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      cb: collectingCb(),
    })

    expect(capturedParams?.thinking).toEqual({ type: 'disabled' })
  })
})
