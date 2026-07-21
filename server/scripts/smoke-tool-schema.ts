// One-shot integration check: does the live Anthropic strict-tool validator
// accept our zod -> JSON-schema emission (renderPlanJsonSchema)? Run manually
// (not in CI/tests): `tsx --env-file=../.env scripts/smoke-tool-schema.ts`
// from server/.
import Anthropic from '@anthropic-ai/sdk'
import { RenderPlanSchema } from '@board/shared'
import { renderPlanTool } from '../src/anthropic'
import { BOARD_MODEL, THINKING_DISABLED } from '../src/models'

async function main() {
  // Either credential env var authenticates the bare `new Anthropic()` client
  // below (ANTHROPIC_API_KEY for Claude, ANTHROPIC_AUTH_TOKEN for DeepSeek's
  // Anthropic-compatible endpoint — see .env.example).
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log('SKIP: neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set')
    return
  }

  const client = new Anthropic()

  try {
    const message = await client.messages.create({
      model: BOARD_MODEL,
      max_tokens: 600,
      tools: [renderPlanTool],
      tool_choice: { type: 'tool', name: 'render_plan' },
      messages: [{ role: 'user', content: 'Draw a plot of x^2-4 on axes -5..5 with one say action.' }],
      // DeepSeek's models think by default and reject a forced tool_choice
      // with a 400 unless thinking is explicitly disabled (BOARD_THINKING=disabled).
      ...(THINKING_DISABLED ? { thinking: { type: 'disabled' as const } } : {}),
    })

    const toolUse = message.content.find((b) => b.type === 'tool_use')
    const parsed = toolUse ? RenderPlanSchema.safeParse(toolUse.input) : null

    console.log('ACCEPTED: strict-tool schema was accepted by the API (no 400)')
    console.log(`actions: ${parsed?.success ? parsed.data.actions.length : `PARSE FAILED: ${JSON.stringify(parsed && !parsed.success ? parsed.error.issues : toolUse)}`}`)
  } catch (err) {
    console.log('REJECTED:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  }
}

main()
