// accessGate.ts — optional app-level access gate for the Board API.
//
// Production runs on a Vercel Hobby plan (no SSO protection available for
// production deployments) with the owner's paid Anthropic key living
// server-side — this gate is the only thing standing between a stranger with
// the URL and that key. Kept deliberately simple and completely inert when
// unconfigured: if BOARD_ACCESS_CODE isn't set, every request passes through
// unchanged (local dev is unaffected).
//
// When BOARD_ACCESS_CODE IS set (non-empty), every /api/* request except
// /api/health must carry a matching `x-board-code` header, or it's rejected
// with 401 {error:'access code required'} before it ever reaches a route
// handler (so a missing/wrong code never touches the Anthropic client).
//
// The comparison is constant-time (crypto.timingSafeEqual) to avoid leaking
// the code's length/prefix via response-time side channels. timingSafeEqual
// itself throws on differing-length buffers, so a length mismatch is checked
// up front and treated as a plain failure rather than an error.
import type { Context, Next } from 'hono'
import { timingSafeEqual } from 'node:crypto'

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export async function boardAccessGate(c: Context, next: Next): Promise<Response | void> {
  const code = process.env.BOARD_ACCESS_CODE
  if (!code) return next() // unconfigured -> inert

  if (c.req.path === '/api/health') return next() // health check always exempt

  const provided = c.req.header('x-board-code') ?? ''
  if (!constantTimeEquals(provided, code)) {
    return c.json({ error: 'access code required' }, 401)
  }
  return next()
}
