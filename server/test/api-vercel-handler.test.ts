import { describe, it, expect } from 'vitest'
// The real Vercel function entry point source (server/src/vercel-entry.ts) —
// imported from here rather than duplicated so this test exercises the exact
// module Vercel's build pre-bundles into api/index.mjs (see
// scripts/build-api.mjs), not a re-implementation of it. repo-root api/ is
// build output only now (generated at build time, gitignored) — @vercel/node
// can't compile the .ts reached through @board/shared's node_modules symlink
// (its `main` is TypeScript source), so the function entry is pre-bundled by
// esbuild instead of relying on Vercel's own compile step. It imports
// server/src/index.ts's `app` transitively, which is why this test lives in
// the server workspace (so `npm test --workspaces --if-present` covers it
// without needing a new npm workspace just for `api/`).
//
// Named `fetch` export, not default (verified live against Vercel's Node.js
// function runtime): a default export is only recognized in the legacy
// `(req, res) => void` Node http signature there — a Fetch-style
// `(Request) => Promise<Response>` default export gets its return value
// silently discarded, and the request hangs until `maxDuration` and 504s.
import { fetch as handler } from '../src/vercel-entry'

describe('server/src/vercel-entry.ts — Vercel function entry (named `fetch` export)', () => {
  it('drives a fetch-style Request through the real app and returns /api/health\'s 200 {ok:true}', async () => {
    const res = await handler(new Request('http://x/api/health'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('routes into the mounted /api/* app (404s a route that does not exist, proving real routing, not a stub)', async () => {
    const res = await handler(new Request('http://x/api/does-not-exist'))
    expect(res.status).toBe(404)
  })
})
