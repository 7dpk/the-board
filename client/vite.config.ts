import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@board/shared': path.resolve(__dirname, '../shared/src/index.ts') } },
  server: { proxy: { '/api': 'http://localhost:8787' } },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'] },
})
