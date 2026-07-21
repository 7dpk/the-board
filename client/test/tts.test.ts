// tts.test.ts — BrowserTts (V-1 voice narration). jsdom (this workspace's
// test environment, see test/setup.ts) implements neither
// `window.speechSynthesis` nor `SpeechSynthesisUtterance`, so `available()`
// is exercised in its natural false state, and the "available" behaviors
// (speak/cancel/pause/resume actually delegating) are exercised against a
// small fake `speechSynthesis`/`SpeechSynthesisUtterance` installed just for
// those tests and removed afterward.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserTts, setTtsProvider, ttsProvider } from '../src/tts'

describe('BrowserTts.available()', () => {
  it('is false under jsdom (no speechSynthesis/SpeechSynthesisUtterance support)', () => {
    const tts = new BrowserTts()
    expect(tts.available()).toBe(false)
  })

  it('every method is a safe no-op when unavailable', async () => {
    const tts = new BrowserTts()
    expect(tts.available()).toBe(false)
    await expect(tts.speak('hello', 1)).resolves.toBeUndefined()
    expect(() => tts.cancel()).not.toThrow()
    expect(() => tts.pause()).not.toThrow()
    expect(() => tts.resume()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// A minimal fake of the two Web Speech API globals BrowserTts touches,
// installed only for this describe block so the rest of the suite keeps
// exercising the real "unavailable under jsdom" path above.
// ---------------------------------------------------------------------------
class FakeUtterance {
  text: string
  rate = 1
  voice: unknown = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(text: string) {
    this.text = text
  }
}

function installFakeSpeechSynthesis(voices: Array<{ lang: string; default?: boolean }> = []) {
  const spoken: FakeUtterance[] = []
  const fakeSynth = {
    getVoices: () => voices,
    speak: vi.fn((u: FakeUtterance) => spoken.push(u)),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  }
  const win = window as unknown as { speechSynthesis?: unknown }
  const globalScope = globalThis as unknown as { SpeechSynthesisUtterance?: unknown }
  const prevSynth = win.speechSynthesis
  const prevUtter = globalScope.SpeechSynthesisUtterance

  win.speechSynthesis = fakeSynth
  globalScope.SpeechSynthesisUtterance = FakeUtterance

  return {
    fakeSynth,
    spoken,
    restore: () => {
      win.speechSynthesis = prevSynth
      globalScope.SpeechSynthesisUtterance = prevUtter
    },
  }
}

describe('BrowserTts with a fake speechSynthesis installed', () => {
  afterEach(() => {
    setTtsProvider(new BrowserTts())
  })

  it('becomes available once speechSynthesis + SpeechSynthesisUtterance exist', () => {
    const { restore } = installFakeSpeechSynthesis()
    try {
      expect(new BrowserTts().available()).toBe(true)
    } finally {
      restore()
    }
  })

  it('speak() clamps rate into [0.5, 2] and resolves when the utterance ends', async () => {
    const { fakeSynth, spoken, restore } = installFakeSpeechSynthesis()
    try {
      const tts = new BrowserTts()
      const done = tts.speak('hello board', 5) // way above the 2.0 ceiling
      expect(fakeSynth.speak).toHaveBeenCalledTimes(1)
      const utter = spoken[0]!
      expect(utter.rate).toBe(2)
      utter.onend?.()
      await expect(done).resolves.toBeUndefined()
    } finally {
      restore()
    }
  })

  it('speak() also resolves on utterance error (never stalls the caller)', async () => {
    const { spoken, restore } = installFakeSpeechSynthesis()
    try {
      const tts = new BrowserTts()
      const done = tts.speak('hello', 1)
      spoken[0]!.onerror?.()
      await expect(done).resolves.toBeUndefined()
    } finally {
      restore()
    }
  })

  it('picks a default English voice when one is flagged default', async () => {
    const { spoken, restore } = installFakeSpeechSynthesis([
      { lang: 'fr-FR' },
      { lang: 'en-US', default: true },
      { lang: 'en-GB' },
    ])
    try {
      const tts = new BrowserTts()
      const done = tts.speak('hi', 1)
      spoken[0]!.onend?.()
      await done
      expect((spoken[0]!.voice as { lang: string }).lang).toBe('en-US')
    } finally {
      restore()
    }
  })

  it('falls back to the first English voice when none is flagged default', async () => {
    const { spoken, restore } = installFakeSpeechSynthesis([{ lang: 'fr-FR' }, { lang: 'en-GB' }])
    try {
      const tts = new BrowserTts()
      const done = tts.speak('hi', 1)
      spoken[0]!.onend?.()
      await done
      expect((spoken[0]!.voice as { lang: string }).lang).toBe('en-GB')
    } finally {
      restore()
    }
  })

  it('cancel/pause/resume delegate to the underlying speechSynthesis', () => {
    const { fakeSynth, restore } = installFakeSpeechSynthesis()
    try {
      const tts = new BrowserTts()
      tts.cancel()
      tts.pause()
      tts.resume()
      expect(fakeSynth.cancel).toHaveBeenCalledTimes(1)
      expect(fakeSynth.pause).toHaveBeenCalledTimes(1)
      expect(fakeSynth.resume).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// Stuck-utterance timeout (review V-1): speechSynthesis's onend/onerror can
// simply never fire — a documented Chrome flake (backgrounded tabs,
// sleep/wake resuming with the engine wedged). timeline.ts's pump does
// `await Promise.all([dwell, speech])`, so an utterance that never settles
// would hang the whole lesson queue forever. speak() now races the utterance
// against a generous fake-timer-driven `max(15000, words*600)`ms timeout
// that *resolves* (never rejects) and cancels the stuck utterance.
// ---------------------------------------------------------------------------
describe('BrowserTts stuck-utterance timeout (review V-1)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    setTtsProvider(new BrowserTts())
  })

  it('resolves after the timeout when onend/onerror never fire, cancels the stuck utterance, and warns', async () => {
    const { fakeSynth, restore } = installFakeSpeechSynthesis()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tts = new BrowserTts()
      let resolved = false
      // 'hi' is 1 word -> timeout floor: max(15000, 1*600) = 15000ms.
      tts.speak('hi', 1).then(() => {
        resolved = true
      })

      await vi.advanceTimersByTimeAsync(14999)
      expect(resolved).toBe(false) // just under the floor: the fake utterance never fired

      await vi.advanceTimersByTimeAsync(1) // crosses the 15000ms floor
      expect(resolved).toBe(true)
      expect(fakeSynth.cancel).toHaveBeenCalledTimes(1) // stuck utterance is cancelled
      expect(warnSpy).toHaveBeenCalledWith('tts: utterance timeout — continuing')
    } finally {
      warnSpy.mockRestore()
      restore()
    }
  })

  it('the timeout scales with word count (never cuts off legitimately long speech early)', async () => {
    const { restore } = installFakeSpeechSynthesis()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tts = new BrowserTts()
      // 30 words -> max(15000, 30*600) = 18000ms, above the 15000ms floor.
      const longText = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')
      let resolved = false
      tts.speak(longText, 1).then(() => {
        resolved = true
      })

      await vi.advanceTimersByTimeAsync(15000)
      expect(resolved).toBe(false) // the floor alone must not cut this off

      await vi.advanceTimersByTimeAsync(3000) // crosses 18000ms
      expect(resolved).toBe(true)
    } finally {
      warnSpy.mockRestore()
      restore()
    }
  })

  it('a normal onend before the timeout resolves immediately and never fires the timeout path', async () => {
    const { fakeSynth, spoken, restore } = installFakeSpeechSynthesis()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tts = new BrowserTts()
      const done = tts.speak('hello', 1)
      spoken[0]!.onend?.()
      await expect(done).resolves.toBeUndefined()

      await vi.advanceTimersByTimeAsync(20000) // well past any timeout floor
      expect(warnSpy).not.toHaveBeenCalled() // timer was cleared, not just outraced
      expect(fakeSynth.cancel).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      restore()
    }
  })
})

describe('ttsProvider (swappable singleton)', () => {
  afterEach(() => {
    setTtsProvider(new BrowserTts())
  })

  it('defaults to a BrowserTts instance', () => {
    expect(ttsProvider).toBeInstanceOf(BrowserTts)
  })

  it('setTtsProvider swaps the live binding for every future import site', () => {
    const fake = {
      available: () => true,
      speak: vi.fn(() => Promise.resolve()),
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    }
    setTtsProvider(fake)
    expect(ttsProvider).toBe(fake)
  })
})
