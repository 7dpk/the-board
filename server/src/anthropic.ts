import Anthropic, {
  APIError,
  RateLimitError,
  InternalServerError,
  APIConnectionError,
} from '@anthropic-ai/sdk'
import { renderPlanJsonSchema, type Scene } from '@board/shared'
import { BOARD_MODEL, THINKING_DISABLED } from './models'
import { createBoardActionExtractor, type TurnCallbacks, type TurnResult } from './pipeline'

export type { TurnCallbacks }

// ---------------------------------------------------------------------------
// renderPlanTool — the single strict tool Claude is forced to call every
// board turn. `strict: true` + `tool_choice: {type:'tool', name:'render_plan'}`
// (set in streamBoardTurn below) means the model can only ever emit
// render_plan input, validated live against renderPlanJsonSchema by the API.
// ---------------------------------------------------------------------------

export const renderPlanTool = {
  name: 'render_plan',
  description: 'Render actions onto the teaching whiteboard.',
  strict: true,
  // renderPlanJsonSchema is typed loosely (Record<string, unknown>) on the
  // shared side; the Anthropic SDK's Tool.InputSchema additionally requires
  // a literal `type: 'object'`, which z.toJSONSchema always produces at
  // runtime for a z.strictObject root — assert the shape rather than
  // widen/narrow through the SDK's own (possibly differently-exported)
  // namespaced type.
  input_schema: renderPlanJsonSchema as { type: 'object' } & Record<string, unknown>,
} as const

// ---------------------------------------------------------------------------
// BoardTurnError — the only error type streamBoardTurn ever throws. Wraps
// Anthropic.APIError subclasses (and anything else) with a `retryable` flag
// so callers (T9's escalation loop) can decide whether to retry / escalate
// to PLANNER_MODEL or give up.
// ---------------------------------------------------------------------------

export class BoardTurnError extends Error {
  retryable: boolean

  constructor(message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BoardTurnError'
    this.retryable = retryable
  }
}

function isRetryable(err: APIError): boolean {
  return (
    err instanceof RateLimitError ||
    err instanceof InternalServerError ||
    err instanceof APIConnectionError
  )
}

// ---------------------------------------------------------------------------
// Minimal structural shape of the pieces of the Anthropic client this module
// touches. Lets tests inject a fake `{ messages: { create } }` object without
// constructing (or mocking) the real SDK client — `opts.client` accepts
// either a real `Anthropic` instance or anything shaped like this.
//
// IMPORTANT: this calls `messages.create({..., stream: true})` — the SDK's
// *raw* event stream (`Stream<RawMessageStreamEvent>`, a plain async
// iterable) — NOT `messages.stream()` (the `MessageStream` helper). The
// helper accumulates every `input_json_delta` chunk into a running JSON
// snapshot internally (`_accumulateMessage`) via a vendored partial-JSON
// parser that throws `AnthropicError: Unexpected non-whitespace character
// after JSON at position N` when a provider's concatenated deltas contain
// trailing content after a complete JSON value (observed live with DeepSeek's
// Anthropic-compat endpoint, BOARD_MODEL=deepseek-v4-pro). That accumulation
// is pure SDK-side bookkeeping we never read (we drive our own extractor off
// the raw deltas below) — `create({stream:true})` does no accumulation at
// all, so the same trailing-garbage input that used to throw asynchronously
// inside MessageStream now just flows to createActionExtractor, which
// already tolerates it (see shared/src/stream.ts).
// ---------------------------------------------------------------------------

export interface AnthropicLike {
  messages: {
    // Return type widened from SDK's APIPromise<Stream<...>> to plain Promise<AsyncIterable<...>> for test injection.
    create(
      params: Anthropic.MessageCreateParamsStreaming,
    ): Promise<AsyncIterable<Anthropic.RawMessageStreamEvent>>
  }
}

export async function streamBoardTurn(opts: {
  client: Anthropic | AnthropicLike
  system: string
  messages: Anthropic.MessageParam[]
  scene: Scene
  model?: string
  cb: TurnCallbacks
}): Promise<TurnResult> {
  // Per-action pipeline (sanitize -> verify (math templating) -> apply ->
  // emit), shared verbatim with openai.ts — see pipeline.ts.
  const pipeline = createBoardActionExtractor(opts.scene, opts.cb)

  // Usage is accumulated from raw events as they arrive (no finalMessage() to
  // ask for the total): message_start carries input/cache-read tokens up
  // front, message_delta carries a running (already-cumulative) output-token
  // total that we overwrite on every occurrence so the last one wins. If a
  // turn ends without ever emitting a message_delta, output stays at its 0
  // default rather than throwing or leaving it undefined.
  const usage = { input: 0, output: 0, cacheRead: 0 }

  try {
    const stream = await opts.client.messages.create({
      model: opts.model ?? BOARD_MODEL,
      max_tokens: 8000,
      system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
      tools: [renderPlanTool],
      tool_choice: { type: 'tool', name: 'render_plan' },
      messages: opts.messages,
      stream: true,
      // Some Anthropic-wire-compatible providers (e.g. DeepSeek) think by
      // default and reject a forced tool_choice with a 400 unless thinking is
      // explicitly disabled. Claude's default behavior is unchanged: the field
      // is omitted entirely unless BOARD_THINKING=disabled is set.
      ...(THINKING_DISABLED ? { thinking: { type: 'disabled' as const } } : {}),
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
        pipeline.push(event.delta.partial_json)
      } else if (event.type === 'message_start') {
        usage.input = event.message.usage.input_tokens ?? 0
        usage.cacheRead = event.message.usage.cache_read_input_tokens ?? 0
      } else if (event.type === 'message_delta') {
        usage.output = event.usage.output_tokens ?? 0
      }
      // Everything else (content_block_start/stop, message_stop, thinking/text
      // deltas, etc.) is irrelevant to the render_plan-only pipeline — ignored.
    }

    const { trailingGarbage } = pipeline.end()
    if (trailingGarbage) {
      opts.cb.onError('render_plan stream ended mid-action')
    }

    return {
      actions: pipeline.actions,
      // The scene accumulated by applying every emitted action in order.
      // Callers (routes.ts) persist this as session.scene so later turns can
      // reference elements added/manipulated on this one.
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
