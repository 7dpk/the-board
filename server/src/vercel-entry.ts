// Vercel serverless function entry point.
//
// This module is pre-bundled at build time (see scripts/build-api.mjs) into
// api/index.mjs — the actual file Vercel's filesystem-routing convention
// picks up as the handler for every request rewritten to /api/index (see
// vercel.json's `rewrites`). It used to live at api/index.ts directly, but
// @vercel/node only compiles the function's own entry file; it does NOT
// transpile .ts files reached through a node_modules symlink, and
// @board/shared's `main` is TypeScript source (shared/src/index.ts) resolved
// through exactly such a symlink (node_modules/@board/shared -> ../../shared,
// an npm workspace link). Importing `app` (which imports @board/shared)
// straight from api/index.ts therefore built fine but failed at runtime with
// FUNCTION_INVOCATION_FAILED as soon as the import was actually evaluated.
// Pre-bundling this file with esbuild inlines @board/shared's source
// directly into the output, sidestepping @vercel/node's compile step
// entirely — the emitted api/index.mjs has no remaining workspace imports.
//
// Reuses the REAL Hono app (server/src/index.ts) rather than re-declaring
// routes here, so local dev (tsx + @hono/node-server) and the Vercel
// deployment run the exact same route tree. server/src/index.ts's serve()
// boot is guarded off when process.env.VERCEL is set (every Vercel build/
// runtime sets this), so importing `app` here does not also bind a port.
//
// Export shape (verified live, not assumed): Vercel's Node.js function
// runtime recognizes exactly two handler contracts — the legacy
// `export default (req, res) => void` Node http signature, or Web
// Fetch-API-style handlers exported as a named `fetch` function (or named
// per-HTTP-method functions, GET/POST/etc). `hono/vercel`'s `handle(app)` is
// literally `(req) => app.fetch(req)` — a Fetch-style function — but
// exporting it as `export default` makes Vercel treat it as the legacy
// (req, res) contract: it invokes the function, discards the returned
// `Promise<Response>` ("default export returned a Response" warning), and
// since nothing ever calls `res.end()`, the request hangs until
// `maxDuration` and 504s ("Vercel Runtime Timeout Error"). Confirmed via a
// live deploy: /api/health hung for the full 300s before timing out with a
// default export. Exporting `fetch` directly (Hono's `app.fetch` is already
// a `(Request) => Promise<Response>` arrow-bound instance method — no
// `handle()` adapter needed) matches Vercel's modern contract and returns
// immediately.
import { app } from './index'

export const fetch = app.fetch
