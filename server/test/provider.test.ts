import { describe, it, expect, vi, afterEach } from 'vitest'
import { emptyScene } from '@board/shared'

// ---------------------------------------------------------------------------
// provider.ts computes nothing at its own module-load time (BOARD_PROVIDER
// itself is models.ts's top-level const), but createProviderClient() and
// getTurnFn() both branch on models.ts's BOARD_PROVIDER at CALL time via a
// live import binding — so exercising both provider branches still requires
// a fresh module evaluation per env value: stub the env, drop the cached
// module registry, then dynamic-import so models.ts's top-level const
// re-runs against the stubbed env before provider.ts reads it. Same pattern
// as models.test.ts / anthropic.test.ts's THINKING_DISABLED suite.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('provider.ts: createProviderClient', () => {
  it('defaults to an Anthropic client when BOARD_PROVIDER is unset', async () => {
    vi.stubEnv('BOARD_PROVIDER', undefined)
    vi.resetModules()
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const { createProviderClient } = await import('../src/provider')

    expect(createProviderClient()).toBeInstanceOf(Anthropic)
  })

  it('constructs an OpenAI client pointed at DeepSeek defaults when BOARD_PROVIDER=openai (ANTHROPIC_AUTH_TOKEN fallback)', async () => {
    vi.stubEnv('BOARD_PROVIDER', 'openai')
    vi.stubEnv('OPENAI_API_KEY', undefined)
    vi.stubEnv('OPENAI_BASE_URL', undefined)
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-deepseek-test')
    vi.resetModules()
    const OpenAI = (await import('openai')).default
    const { createProviderClient } = await import('../src/provider')

    const client = createProviderClient()
    expect(client).toBeInstanceOf(OpenAI)
    const openaiClient = client as InstanceType<typeof OpenAI>
    expect(openaiClient.baseURL).toBe('https://api.deepseek.com')
    expect(openaiClient.apiKey).toBe('sk-deepseek-test')
  })

  it('OPENAI_API_KEY / OPENAI_BASE_URL take precedence over the ANTHROPIC_* fallback when both are set', async () => {
    vi.stubEnv('BOARD_PROVIDER', 'openai')
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test')
    vi.stubEnv('OPENAI_BASE_URL', 'https://example.com/v1')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-deepseek-test')
    vi.resetModules()
    const OpenAI = (await import('openai')).default
    const { createProviderClient } = await import('../src/provider')

    const client = createProviderClient() as InstanceType<typeof OpenAI>
    expect(client.apiKey).toBe('sk-openai-test')
    expect(client.baseURL).toBe('https://example.com/v1')
  })
})

describe('provider.ts: getTurnFn provider selection', () => {
  it('routes to streamBoardTurnOpenAI (chat.completions.create) when BOARD_PROVIDER=openai', async () => {
    vi.stubEnv('BOARD_PROVIDER', 'openai')
    vi.resetModules()
    const { getTurnFn } = await import('../src/provider')

    let anthropicCalled = false
    let openaiCalled = false
    const fakeClient = {
      messages: {
        create: async () => {
          anthropicCalled = true
          throw new Error('anthropic path should not be called under BOARD_PROVIDER=openai')
        },
      },
      chat: {
        completions: {
          create: async () => {
            openaiCalled = true
            return { [Symbol.asyncIterator]: async function* () {} }
          },
        },
      },
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const turnFn = getTurnFn(fakeClient as any)
    await turnFn({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene: emptyScene,
      cb: { onAction: () => {}, onError: () => {} },
    })

    expect(openaiCalled).toBe(true)
    expect(anthropicCalled).toBe(false)
  })

  it('routes to streamBoardTurn (messages.create) when BOARD_PROVIDER is unset (default anthropic)', async () => {
    vi.stubEnv('BOARD_PROVIDER', undefined)
    vi.resetModules()
    const { getTurnFn } = await import('../src/provider')

    let anthropicCalled = false
    let openaiCalled = false
    const fakeClient = {
      messages: {
        create: async () => {
          anthropicCalled = true
          return { [Symbol.asyncIterator]: async function* () {} }
        },
      },
      chat: {
        completions: {
          create: async () => {
            openaiCalled = true
            throw new Error('openai path should not be called under the default provider')
          },
        },
      },
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const turnFn = getTurnFn(fakeClient as any)
    await turnFn({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      scene: emptyScene,
      cb: { onAction: () => {}, onError: () => {} },
    })

    expect(anthropicCalled).toBe(true)
    expect(openaiCalled).toBe(false)
  })
})
