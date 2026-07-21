import OpenAI, {
  APIError,
  RateLimitError,
  InternalServerError,
  APIConnectionError,
} from 'openai'
import { renderPlanJsonSchema, type Scene } from '@board/shared'
import { BoardTurnError, type TurnCallbacks } from './anthropic'
import { BOARD_MODEL } from './models'
import { createBoardActionExtractor, type TurnResult } from './pipeline'

// ---------------------------------------------------------------------------
// renderPlanFunctionTool — the openai-SDK equivalent of anthropic.ts's
// renderPlanTool: a single forced function tool the model must call every
// board turn, built from the exact same renderPlanJsonSchema (shared/src/
// protocol/actions.ts) so both providers validate/accept the identical
// action-protocol shape. `strict: true` + `tool_choice: {type:'function',
// function:{name:'render_plan'}}` (set in streamBoardTurnOpenAI below) forces
// exactly this one tool call, matching the Anthropic path's forced
// tool_choice.
// ---------------------------------------------------------------------------

export const renderPlanFunctionTool = {
  type: 'function' as const,
  function: {
    name: 'render_plan',
    description: 'Render actions onto the teaching whiteboard.',
    parameters: renderPlanJsonSchema as Record<string, unknown>,
    strict: true,
  },
}

function isRetryable(err: APIError): boolean {
  if (err instanceof RateLimitError || err instanceof InternalServerError || err instanceof APIConnectionError) {
    return true
  }
  // Belt-and-suspenders: the SDK's APIError.generate() already maps every
  // status >= 500 onto InternalServerError, so this is only reachable for an
  // APIError constructed some other way (e.g. directly in a test double).
  return typeof err.status === 'number' && err.status >= 500
}

// ---------------------------------------------------------------------------
// Minimal structural shape of the pieces of the OpenAI client this module
// touches — same test-injection seam as anthropic.ts's AnthropicLike.
// `chat.completions.create({..., stream:true})` returns the SDK's raw
// `Stream<ChatCompletionChunk>` (a plain async iterable); we read
// `delta.tool_calls[0].function.arguments` chunks directly off it (no
// accumulator helper involved), feeding them into the SAME
// createBoardActionExtractor-based pipeline anthropic.ts uses — the
// extractor only ever sees a stream of raw partial-JSON text, so it is
// completely provider-agnostic.
// ---------------------------------------------------------------------------

export interface OpenAILike {
  chat: {
    completions: {
      create(
        params: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
      ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>
    }
  }
}

export async function streamBoardTurnOpenAI(opts: {
  client: OpenAI | OpenAILike
  system: string
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  scene: Scene
  model?: string
  cb: TurnCallbacks
}): Promise<TurnResult> {
  // Per-action pipeline (sanitize -> verify (math templating) -> apply ->
  // emit), shared verbatim with anthropic.ts — see pipeline.ts.
  const pipeline = createBoardActionExtractor(opts.scene, opts.cb)

  // Usage arrives once, on the final chunk (`stream_options:{include_usage:
  // true}` — every other chunk's `usage` field is null per the OpenAI spec).
  // `prompt_tokens_details.cached_tokens` is the OpenAI-shape equivalent of
  // Anthropic's cache_read_input_tokens; defaults to 0 when the provider
  // doesn't report it (DeepSeek's cache-hit accounting is not guaranteed).
  const usage = { input: 0, output: 0, cacheRead: 0 }

  try {
    const stream = await opts.client.chat.completions.create({
      model: opts.model ?? BOARD_MODEL,
      messages: [{ role: 'system', content: opts.system }, ...opts.messages],
      tools: [renderPlanFunctionTool],
      tool_choice: { type: 'function', function: { name: 'render_plan' } },
      stream: true,
      stream_options: { include_usage: true },
    })

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta
      const args = delta?.tool_calls?.[0]?.function?.arguments
      if (args) pipeline.push(args)

      if (chunk.usage) {
        usage.input = chunk.usage.prompt_tokens ?? 0
        usage.output = chunk.usage.completion_tokens ?? 0
        usage.cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
      }
      // Everything else (role/content deltas, finish_reason, etc.) is
      // irrelevant to the render_plan-only pipeline — ignored.
    }

    const { trailingGarbage } = pipeline.end()
    if (trailingGarbage) {
      opts.cb.onError('render_plan stream ended mid-action')
    }

    return {
      actions: pipeline.actions,
      scene: pipeline.scene,
      usage,
    }
  } catch (err) {
    if (err instanceof APIError) {
      throw new BoardTurnError(err.message, isRetryable(err), { cause: err })
    }
    throw err
  }
}
