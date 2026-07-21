#!/usr/bin/env node
// Pre-bundles the Vercel serverless function entry (server/src/vercel-entry.ts)
// into api/index.mjs at build time.
//
// Why: @vercel/node compiles the function's own entry file but does NOT
// transpile .ts files reached through a node_modules symlink. @board/shared's
// `main` is TypeScript source (shared/src/index.ts), resolved via the npm
// workspace symlink node_modules/@board/shared -> ../../shared. Importing it
// (transitively, via server/src/index.ts) straight from a Vercel function
// entry builds fine but throws FUNCTION_INVOCATION_FAILED at runtime the
// moment the import is evaluated. Bundling with esbuild here inlines
// @board/shared's source directly — the emitted api/index.mjs has zero
// remaining workspace imports, so @vercel/node has nothing left to
// mis-handle.
//
// api/index.mjs is build output, not checked into git (see .gitignore) —
// this script must run before every Vercel build (see vercel.json's
// buildCommand) and before any local smoke test of the bundled function.
import * as esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..')

await esbuild.build({
  entryPoints: [path.join(repoRoot, 'server/src/vercel-entry.ts')],
  outfile: path.join(repoRoot, 'api/index.mjs'),
  platform: 'node',
  format: 'esm',
  target: 'node20',
  bundle: true,
  // Nothing to externalize: no optional native deps in this dependency
  // graph (the whole point is to inline @board/shared's TS source too).
  external: [],
  logLevel: 'info',
})

console.log('[build-api] wrote api/index.mjs')
