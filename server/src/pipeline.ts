import {
  sanitizeAction,
  applyAction,
  verifyActions,
  createActionExtractor,
  type Action,
  type Scene,
} from '@board/shared'

// ---------------------------------------------------------------------------
// Provider-agnostic pieces shared by anthropic.ts and openai.ts.
//
// TurnCallbacks / TurnMessage / TurnUsage / TurnResult describe the board-turn
// contract BOTH providers implement identically (see anthropic.ts's
// streamBoardTurn and openai.ts's streamBoardTurnOpenAI) — kept here rather
// than re-declared per module so the two streaming implementations can never
// silently drift apart on shape.
//
// TurnMessage is deliberately just `{role, content: string}` — the narrowest
// common denominator of Anthropic.MessageParam and OpenAI's
// ChatCompletionMessageParam for plain-text turns, which is all session.ts's
// transcript ever produces (no image/tool-result blocks). Both SDKs' wider
// message param types structurally accept this shape.
// ---------------------------------------------------------------------------

export type TurnMessage = { role: 'user' | 'assistant'; content: string }

export type TurnCallbacks = {
  onAction: (a: Action) => void
  onError: (reason: string) => void
}

export type TurnUsage = { input: number; output: number; cacheRead: number }

export type TurnResult = { actions: Action[]; scene: Scene; usage: TurnUsage }

// ---------------------------------------------------------------------------
// createBoardActionExtractor — the per-action sanitize -> verify (math
// templating) -> apply -> emit pipeline, factored out of anthropic.ts so
// openai.ts (and any future provider) can reuse it verbatim instead of
// duplicating it. Wraps shared/src/stream.ts's createActionExtractor (which
// only knows how to carve complete `{...}` objects out of a raw partial-JSON
// character stream) with the board-specific per-action processing.
//
// createActionExtractor throws through whatever its onAction callback
// throws, so every failure mode here must be caught locally and reported via
// cb.onError — one malformed/unverifiable action must never abort the rest
// of the stream. Returns `push`/`end` (pass straight through to the
// extractor) plus live accessors for the actions emitted so far and the
// scene accumulated by applying them, in order.
// ---------------------------------------------------------------------------

export function createBoardActionExtractor(scene: Scene, cb: TurnCallbacks) {
  const actions: Action[] = []
  let liveScene = scene

  const extractor = createActionExtractor((raw) => {
    try {
      const sanitized = sanitizeAction(raw, liveScene)
      if (!sanitized.ok) {
        cb.onError(sanitized.reason)
        return
      }

      const { actions: verified, errors } = verifyActions([sanitized.action])
      for (const reason of errors) cb.onError(reason)

      const action = verified[0]
      if (!action) return

      liveScene = applyAction(liveScene, action)
      actions.push(action)
      cb.onAction(action)
    } catch (err) {
      cb.onError(err instanceof Error ? err.message : String(err))
    }
  })

  return {
    push: extractor.push,
    end: extractor.end,
    get actions(): Action[] {
      return actions
    },
    get scene(): Scene {
      return liveScene
    },
  }
}
