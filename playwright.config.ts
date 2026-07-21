// playwright.config.ts — single live e2e spec (e2e/lesson.spec.ts) against the
// real dev servers. `npm run dev -w server` reads server/../.env itself
// (`tsx watch --env-file=../.env`), but the Playwright *test runner* process
// does not — so we load repo-root .env into process.env here too, before
// anything else runs, so both:
//   (a) the webServer child processes below inherit it (harmless — the
//       server's own --env-file load would set the same values again), and
//   (b) e2e/lesson.spec.ts's `test.skip(!ANTHROPIC_AUTH_TOKEN/API_KEY)` guard
//       can actually see the key that's really configured.
// Never overwrites an already-set env var (a real shell export wins).
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const envPath = path.resolve(process.cwd(), '.env')
if (fs.existsSync(envPath)) {
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key && !(key in process.env)) process.env[key] = value
  }
}

const PORT_CLIENT = 5173
const PORT_SERVER = 8787

export default defineConfig({
  testDir: './e2e',
  timeout: 5 * 60 * 1000, // live model turns can chain several real calls — generous per-test budget
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT_CLIENT}`,
    trace: 'retain-on-failure',
    actionTimeout: 20_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Both servers are plain `npm run dev -w <pkg>` — same commands a human
  // would run manually (documented in README as the manual-start fallback).
  webServer: [
    {
      command: 'npm run dev -w server',
      url: `http://localhost:${PORT_SERVER}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'npm run dev -w client',
      url: `http://localhost:${PORT_CLIENT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
})
