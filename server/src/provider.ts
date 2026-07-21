import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { Scene } from '@board/shared'
import { BOARD_PROVIDER } from './models'
import { streamBoardTurn } from './anthropic'
import { streamBoardTurnOpenAI } from './openai'
import type { TurnCallbacks, TurnMessage, TurnResult } from './pipeline'

// ---------------------------------------------------------------------------
// The provider seam. BOARD_PROVIDER (models.ts) picks between two genuinely
// different API surfaces at three call sites: the LLM client itself, the
// per-turn board-render function, and (blueprint.ts) the blueprint planner.
// This module owns the client construction + turn-fn selection so routes.ts,
// server/src/eval/run.ts and the driver scripts all wire up identically
// instead of re-deriving the branch three times.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// createProviderClient — env mapping per provider:
//   anthropic (default): bare `new Anthropic()` — reads ANTHROPIC_API_KEY /
//     ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL from the environment itself,
//     unchanged from before this module existed.
//   openai: DeepSeek's OpenAI-compatible endpoint is the reference target —
//     same key as the Anthropic-compat path (OPENAI_API_KEY falls back to
//     ANTHROPIC_AUTH_TOKEN so one DeepSeek key configures either provider),
//     OPENAI_BASE_URL defaults to DeepSeek's OpenAI-surface base URL (NOT the
//     /anthropic one anthropic.ts's DeepSeek path uses).
// ---------------------------------------------------------------------------

export function createProviderClient(): Anthropic | OpenAI {
  if (BOARD_PROVIDER === 'openai') {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN,
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    })
  }
  return new Anthropic()
}

// ---------------------------------------------------------------------------
// TurnFn — the client-BOUND per-turn function shape every call site (routes.ts,
// eval/run.ts) actually calls. Deliberately excludes `client`: streamBoardTurn
// and streamBoardTurnOpenAI take incompatible client types (Anthropic|
// AnthropicLike vs OpenAI|OpenAILike — not mutually assignable, so a single
// function-typed variable can't switch between them by client shape alone).
// getTurnFn partially applies the already-constructed client via closure so
// callers never see the split.
// ---------------------------------------------------------------------------

export type TurnFn = (opts: {
  system: string
  messages: TurnMessage[]
  scene: Scene
  model?: string
  cb: TurnCallbacks
}) => Promise<TurnResult>

export function getTurnFn(client: Anthropic | OpenAI): TurnFn {
  if (BOARD_PROVIDER === 'openai') {
    const openaiClient = client as OpenAI
    return (opts) => streamBoardTurnOpenAI({ ...opts, client: openaiClient })
  }
  const anthropicClient = client as Anthropic
  return (opts) => streamBoardTurn({ ...opts, client: anthropicClient })
}
