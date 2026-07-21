// access-gate.test.ts — TDD for server/src/accessGate.ts, the optional
// app-level gate that stands between a stranger with the production URL and
// the owner's paid Anthropic key (see accessGate.ts's own header comment).
//
// Two layers of coverage:
//   1. `boardAccessGate` in isolation, mounted on a throwaway Hono app with a
//      fake protected route — exercises every branch of the gate itself.
//   2. The REAL app (server/src/index.ts) — proves the gate is actually
//      wired in front of /api/session and that /api/health stays reachable,
//      mirroring api-vercel-handler.test.ts's pattern of testing the real
//      entry point rather than a re-implementation of it.
import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { boardAccessGate } from '../src/accessGate'
import { app as realApp } from '../src/index'

const ENV_KEY = 'BOARD_ACCESS_CODE'
const prevEnv = process.env[ENV_KEY]

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = prevEnv
})

function buildTestApp(): Hono {
  const app = new Hono()
  app.use('/api/*', boardAccessGate)
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.get('/api/thing', (c) => c.json({ ok: true }))
  return app
}

describe('boardAccessGate (isolated)', () => {
  it('passes every request through unchanged when BOARD_ACCESS_CODE is unset (local dev unaffected)', async () => {
    delete process.env[ENV_KEY]
    const res = await buildTestApp().request('/api/thing')
    expect(res.status).toBe(200)
  })

  it('401s a protected route with no x-board-code header', async () => {
    process.env[ENV_KEY] = 'sekrit-code'
    const res = await buildTestApp().request('/api/thing')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'access code required' })
  })

  it('401s a protected route with a wrong x-board-code header of the same length', async () => {
    process.env[ENV_KEY] = 'sekrit-code'
    const res = await buildTestApp().request('/api/thing', { headers: { 'x-board-code': 'wrong-code!!' } })
    expect(res.status).toBe(401)
  })

  it('401s a protected route with a wrong x-board-code header of a different length (no throw)', async () => {
    process.env[ENV_KEY] = 'sekrit-code'
    const res = await buildTestApp().request('/api/thing', { headers: { 'x-board-code': 'short' } })
    expect(res.status).toBe(401)
  })

  it('passes a protected route when the header matches exactly', async () => {
    process.env[ENV_KEY] = 'sekrit-code'
    const res = await buildTestApp().request('/api/thing', { headers: { 'x-board-code': 'sekrit-code' } })
    expect(res.status).toBe(200)
  })

  it('exempts /api/health even when the env is set and no header is sent', async () => {
    process.env[ENV_KEY] = 'sekrit-code'
    const res = await buildTestApp().request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('boardAccessGate wired into the real app (server/src/index.ts)', () => {
  // The gate reads process.env.BOARD_ACCESS_CODE per-request (not once at
  // module load), so re-using the one real `app` singleton across these
  // cases is safe — no need to re-import the module per test.
  it('401s the real POST /api/session without a header when BOARD_ACCESS_CODE is set', async () => {
    process.env[ENV_KEY] = 'sekrit-code'
    const res = await realApp.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'x' }),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'access code required' })
  })

  it('/api/health on the real app stays open even when BOARD_ACCESS_CODE is set', async () => {
    process.env[ENV_KEY] = 'sekrit-code'
    const res = await realApp.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('the real app is fully open when BOARD_ACCESS_CODE is unset', async () => {
    delete process.env[ENV_KEY]
    const res = await realApp.request('/api/health')
    expect(res.status).toBe(200)
  })
})
