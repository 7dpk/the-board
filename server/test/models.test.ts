import { describe, it, expect, vi, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// models.ts computes BOARD_MODEL / PLANNER_MODEL / THINKING_DISABLED from
// process.env at module-load time (top-level const, no speculative getter
// indirection). To exercise both branches of `process.env.X ?? default` we
// have to force a fresh module evaluation per env combination: stub the env
// with vi.stubEnv, drop the cached module with vi.resetModules(), then
// dynamic-import so the top-level consts re-run against the stubbed env.
// A single static import at file top would only ever observe the env as it
// was at test-collection time.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('models: env overrides', () => {
  it('falls back to the Claude defaults when BOARD_MODEL/PLANNER_MODEL/BOARD_THINKING are unset', async () => {
    vi.stubEnv('BOARD_MODEL', undefined)
    vi.stubEnv('PLANNER_MODEL', undefined)
    vi.stubEnv('BOARD_THINKING', undefined)
    vi.resetModules()

    const { BOARD_MODEL, PLANNER_MODEL, THINKING_DISABLED } = await import('../src/models')

    expect(BOARD_MODEL).toBe('claude-haiku-4-5')
    expect(PLANNER_MODEL).toBe('claude-sonnet-5')
    expect(THINKING_DISABLED).toBe(false)
  })

  it('honors BOARD_MODEL / PLANNER_MODEL overrides (e.g. DeepSeek model ids)', async () => {
    vi.stubEnv('BOARD_MODEL', 'deepseek-v4-flash')
    vi.stubEnv('PLANNER_MODEL', 'deepseek-v4-pro')
    vi.resetModules()

    const { BOARD_MODEL, PLANNER_MODEL } = await import('../src/models')

    expect(BOARD_MODEL).toBe('deepseek-v4-flash')
    expect(PLANNER_MODEL).toBe('deepseek-v4-pro')
  })

  it('THINKING_DISABLED is true only when BOARD_THINKING is exactly "disabled"', async () => {
    vi.stubEnv('BOARD_THINKING', 'disabled')
    vi.resetModules()
    const disabled = await import('../src/models')
    expect(disabled.THINKING_DISABLED).toBe(true)

    vi.stubEnv('BOARD_THINKING', 'nope')
    vi.resetModules()
    const other = await import('../src/models')
    expect(other.THINKING_DISABLED).toBe(false)
  })
})
