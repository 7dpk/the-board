// Env-driven provider config — no speculative abstraction, just override
// points so the server can run against Claude (default) or an
// Anthropic-wire-compatible endpoint (e.g. DeepSeek's /anthropic surface) via
// ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN. BOARD_MODEL drives the fast
// per-turn streaming board renderer (Haiku by default); PLANNER_MODEL is the
// escalation target (T9) when a Haiku turn produces 0 valid actions or >=3
// sanitize failures. THINKING_DISABLED covers providers whose models think by
// default and reject a forced tool_choice unless thinking is explicitly
// turned off (see anthropic.ts / blueprint.ts).
export const BOARD_MODEL = process.env.BOARD_MODEL ?? 'claude-haiku-4-5'
export const PLANNER_MODEL = process.env.PLANNER_MODEL ?? 'claude-sonnet-5'
export const THINKING_DISABLED = process.env.BOARD_THINKING === 'disabled'

// BOARD_PROVIDER — which wire protocol/SDK drives board turns + blueprint
// generation: the Anthropic Messages API (strict tool_choice, input_json_delta
// streaming — anthropic.ts) by default, or the OpenAI Chat Completions API
// (forced function tool_choice, tool_calls[].function.arguments streaming —
// openai.ts) when set to 'openai'. Any other/unset value falls back to
// 'anthropic' rather than throwing, so a typo never hard-fails startup — see
// provider.ts for the client construction + turn-fn selection this drives.
export const BOARD_PROVIDER: 'anthropic' | 'openai' =
  process.env.BOARD_PROVIDER === 'openai' ? 'openai' : 'anthropic'
