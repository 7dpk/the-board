import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { boardAccessGate } from './accessGate'
import { createApp } from './routes'
import { createProviderClient } from './provider'

export const app = new Hono()
// Optional access gate (inert unless BOARD_ACCESS_CODE is set) — see
// accessGate.ts. Registered before any route so it can short-circuit before
// a stranger's request ever reaches the LLM client.
app.use('/api/*', boardAccessGate)
app.get('/api/health', (c) => c.json({ ok: true }))
// createProviderClient() picks Anthropic vs OpenAI (DeepSeek's OpenAI-compat
// endpoint by default) per BOARD_PROVIDER — see provider.ts.
app.route('/', createApp({ client: createProviderClient() }))

// Skip the standalone HTTP listener under tests (existing guard) AND on
// Vercel (process.env.VERCEL is set in every Vercel build/runtime): the
// Vercel entry point (api/index.ts) imports this same `app` and drives it
// through the platform's own request handler instead of a bound port.
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  serve({ fetch: app.fetch, port: 8787 })
  console.log('board server on :8787')
}
