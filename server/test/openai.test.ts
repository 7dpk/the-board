import { describe, it, expect } from 'vitest'
import OpenAI from 'openai'
import { emptyScene, type Scene } from '@board/shared'
import { streamBoardTurnOpenAI } from '../src/openai'
import { BoardTurnError, type TurnCallbacks } from '../src/anthropic'
import { BOARD_MODEL } from '../src/models'

// ---------------------------------------------------------------------------
// Test doubles mirroring anthropic.test.ts's fakeStreamFor/fakeClientFor:
// a fake `client.chat.completions.create({..., stream:true})` shaped exactly
// like the real SDK's raw `Stream<ChatCompletionChunk>` (a plain async
// iterable, no accumulation) — zero SDK network dependency. Every chunk
// carries one `delta.tool_calls[0].function.arguments` fragment (the forced
// single `render_plan` function call, so index is always 0); the final chunk
// carries `usage` per `stream_options:{include_usage:true}`.
// ---------------------------------------------------------------------------

type FakeUsage = { prompt_tokens: number; completion_tokens: number; cached_tokens: number | null }

function chunksOf(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

function argChunk(partial: string): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: BOARD_MODEL,
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: partial } }] },
        finish_reason: null,
        logprobs: null,
      },
    ],
  } as unknown as OpenAI.Chat.ChatCompletionChunk
}

function usageChunk(usage: FakeUsage): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: BOARD_MODEL,
    choices: [],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.prompt_tokens + usage.completion_tokens,
      ...(usage.cached_tokens !== null
        ? { prompt_tokens_details: { cached_tokens: usage.cached_tokens } }
        : {}),
    },
  } as unknown as OpenAI.Chat.ChatCompletionChunk
}

function fakeStreamFor(
  fullJson: string,
  usage: FakeUsage,
  chunkSize = 17,
  includeUsageChunk = true,
): AsyncIterable<OpenAI.Chat.ChatCompletionChunk> {
  const chunks: OpenAI.Chat.ChatCompletionChunk[] = chunksOf(fullJson, chunkSize).map(argChunk)
  if (includeUsageChunk) chunks.push(usageChunk(usage))
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c
    },
  }
}

function fakeClientFor(fullJson: string, usage: FakeUsage, chunkSize = 17, includeUsageChunk = true) {
  return {
    chat: {
      completions: {
        create: async (_params: OpenAI.Chat.ChatCompletionCreateParamsStreaming) =>
          fakeStreamFor(fullJson, usage, chunkSize, includeUsageChunk),
      },
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

describe('streamBoardTurnOpenAI', () => {
  it('(a) happy path: fires onAction per action, in order, sanitized, for a chunked canonical plan', async () => {
    const plan = {
      actions: [
        { op: 'add', c: 'axes', id: 'AX1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
        { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2 - 4' },
        { op: 'say', text: 'a parabola' },
      ],
    }
    const client = fakeClientFor(JSON.stringify(plan), { prompt_tokens: 10, completion_tokens: 20, cached_tokens: 0 })
    const cb = collectingCb()

    const result = await streamBoardTurnOpenAI({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'draw a parabola' }],
      scene,
      cb,
    })

    expect(result.actions).toHaveLength(3)
    expect(result.actions[0]).toMatchObject({ op: 'add', c: 'axes', id: 'ax1' })
    expect(result.actions[1]).toMatchObject({ op: 'add', c: 'plot', id: 'p1', on: 'ax1' })
    expect(result.actions[2]).toMatchObject({ op: 'say', text: 'a parabola' })
    expect(cb.seenActions).toEqual(result.actions)
    expect(cb.seenErrors).toEqual([])
  })

  it('(b) sanitize-drop: drops an action referencing an unknown id and reports it via onError', async () => {
    const plan = {
      actions: [
        { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
        { op: 'set', id: 'ghost', k: 'color', v: 'red' },
        { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2 - 4' },
      ],
    }
    const client = fakeClientFor(JSON.stringify(plan), { prompt_tokens: 1, completion_tokens: 2, cached_tokens: 0 })
    const cb = collectingCb()

    const result = await streamBoardTurnOpenAI({
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

  it('(c) propagates usage from the final chunk (stream_options:{include_usage:true})', async () => {
    const plan = { actions: [{ op: 'say', text: 'hi' }] }
    const client = fakeClientFor(JSON.stringify(plan), {
      prompt_tokens: 123,
      completion_tokens: 45,
      cached_tokens: 7,
    })
    const cb = collectingCb()

    const result = await streamBoardTurnOpenAI({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      cb,
    })

    expect(result.usage).toEqual({ input: 123, output: 45, cacheRead: 7 })
  })

  it('(c2) defaults usage to all-zero when no usage chunk ever arrives', async () => {
    const plan = { actions: [{ op: 'say', text: 'hi' }] }
    const client = fakeClientFor(
      JSON.stringify(plan),
      { prompt_tokens: 999, completion_tokens: 999, cached_tokens: 999 },
      17,
      /* includeUsageChunk */ false,
    )
    const cb = collectingCb()

    const result = await streamBoardTurnOpenAI({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      cb,
    })

    expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0 })
    expect(result.actions).toHaveLength(1)
  })

  it('defaults to BOARD_MODEL and forwards tools/tool_choice/stream/stream_options to client.chat.completions.create', async () => {
    const plan = { actions: [{ op: 'say', text: 'hi' }] }
    let captured: OpenAI.Chat.ChatCompletionCreateParamsStreaming | undefined
    const client = {
      chat: {
        completions: {
          create: async (params: OpenAI.Chat.ChatCompletionCreateParamsStreaming) => {
            captured = params
            return fakeStreamFor(JSON.stringify(plan), { prompt_tokens: 1, completion_tokens: 1, cached_tokens: 0 })
          },
        },
      },
    }

    await streamBoardTurnOpenAI({
      client,
      system: 'be a good tutor',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      cb: collectingCb(),
    })

    expect(captured?.model).toBe(BOARD_MODEL)
    expect(captured?.stream).toBe(true)
    expect(captured?.stream_options).toEqual({ include_usage: true })
    expect(captured?.tool_choice).toEqual({ type: 'function', function: { name: 'render_plan' } })
    expect(captured?.tools).toHaveLength(1)
    expect(captured?.tools?.[0]).toMatchObject({ type: 'function', function: { name: 'render_plan', strict: true } })
    expect(captured?.messages[0]).toEqual({ role: 'system', content: 'be a good tutor' })
  })

  it('honors an explicit model override (escalation to PLANNER_MODEL)', async () => {
    const plan = { actions: [{ op: 'say', text: 'hi' }] }
    let capturedModel: string | undefined
    const client = {
      chat: {
        completions: {
          create: async (params: OpenAI.Chat.ChatCompletionCreateParamsStreaming) => {
            capturedModel = params.model
            return fakeStreamFor(JSON.stringify(plan), { prompt_tokens: 1, completion_tokens: 1, cached_tokens: 0 })
          },
        },
      },
    }

    await streamBoardTurnOpenAI({
      client,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene,
      model: 'deepseek-reasoner',
      cb: collectingCb(),
    })

    expect(capturedModel).toBe('deepseek-reasoner')
  })

  it('wraps a thrown OpenAI.RateLimitError as a retryable BoardTurnError', async () => {
    const client = {
      chat: {
        completions: {
          create: async (_params: OpenAI.Chat.ChatCompletionCreateParamsStreaming) => ({
            [Symbol.asyncIterator]: async function* (): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
              throw new OpenAI.RateLimitError(429, {}, 'rate limited', new Headers())
            },
          }),
        },
      },
    }

    await expect(
      streamBoardTurnOpenAI({
        client,
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        scene,
        cb: collectingCb(),
      }),
    ).rejects.toMatchObject({ retryable: true })

    try {
      await streamBoardTurnOpenAI({
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

  it('wraps a thrown OpenAI.BadRequestError as a non-retryable BoardTurnError', async () => {
    const client = {
      chat: {
        completions: {
          create: async (_params: OpenAI.Chat.ChatCompletionCreateParamsStreaming) => ({
            [Symbol.asyncIterator]: async function* (): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
              throw new OpenAI.BadRequestError(400, {}, 'bad request', new Headers())
            },
          }),
        },
      },
    }

    await expect(
      streamBoardTurnOpenAI({
        client,
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        scene,
        cb: collectingCb(),
      }),
    ).rejects.toMatchObject({ retryable: false })
  })

  it('(f) partial-then-error: emits all partial actions before throwing, then rejects with retryable BoardTurnError', async () => {
    const validPlan = {
      actions: [
        { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
        { op: 'say', text: 'hello' },
      ],
    }
    const fullJson = JSON.stringify(validPlan)

    const client = {
      chat: {
        completions: {
          create: async (_params: OpenAI.Chat.ChatCompletionCreateParamsStreaming) => ({
            [Symbol.asyncIterator]: async function* (): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
              for (const chunk of chunksOf(fullJson, 17)) yield argChunk(chunk)
              throw new OpenAI.RateLimitError(429, {}, 'rate limited', new Headers())
            },
          }),
        },
      },
    }

    const cb = collectingCb()

    await expect(
      streamBoardTurnOpenAI({
        client,
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        scene,
        cb,
      }),
    ).rejects.toMatchObject({ retryable: true })

    expect(cb.seenActions).toHaveLength(2)
    expect(cb.seenActions[0]).toMatchObject({ op: 'add', c: 'axes', id: 'ax1' })
    expect(cb.seenActions[1]).toMatchObject({ op: 'say', text: 'hello' })
  })
})
