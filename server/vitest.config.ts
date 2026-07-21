import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Mirrors client/vite.config.ts: the workspace symlink at
// node_modules/@board/shared points at a package whose "main" is a raw .ts
// file, which vitest's default node_modules-external dep handling won't
// transform. Alias straight to source so imports resolve under vitest.
export default defineConfig({
  resolve: { alias: { '@board/shared': path.resolve(__dirname, '../shared/src/index.ts') } },
})
