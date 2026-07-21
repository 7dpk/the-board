// tts.ts — voice narration provider (V-1, feedback: "can we use text to
// voice... to make it more interactive?"). DeepSeek has no TTS API (verified)
// so V-1 speaks via the browser's own `window.speechSynthesis` instead of a
// server round-trip — free, offline-capable, zero added latency per `say`.
//
// `TtsProvider` is a small seam so a future paid provider (better voices,
// non-Chromium support) can be dropped in later without touching
// timeline.ts/store.ts: both only ever call through the swappable
// `ttsProvider` binding below, never `BrowserTts` directly.
//
// available() guard: jsdom (this workspace's test environment, see
// client/test/setup.ts) implements neither `window.speechSynthesis` nor
// `SpeechSynthesisUtterance` — every method here is a safe no-op when it's
// false, so the real `BrowserTts` singleton can be constructed and probed
// (PlayerBar's voice-toggle disabled state) in every test file without any
// jsdom polyfilling.
export interface TtsProvider {
  speak(text: string, rate: number): Promise<void>
  cancel(): void
  pause(): void
  resume(): void
  available(): boolean
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function wordCount(text: string): number {
  const trimmed = text.trim()
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length
}

// Stuck-utterance guard (review V-1): `speechSynthesis`'s onend/onerror can
// simply never fire — a documented Chrome flake (backgrounded tabs,
// sleep/wake resuming with the speech engine wedged). Since timeline.ts's
// pump does `await Promise.all([dwell(text), speech])` before advancing, one
// stuck utterance would hang the entire lesson queue forever. Generous on
// purpose — this is a last-resort safety net, not a pacing mechanism, so it
// must never fire on legitimate speech.
const UTTERANCE_TIMEOUT_FLOOR_MS = 15000
const UTTERANCE_TIMEOUT_MS_PER_WORD = 600

function computeUtteranceTimeoutMs(text: string): number {
  return Math.max(UTTERANCE_TIMEOUT_FLOOR_MS, wordCount(text) * UTTERANCE_TIMEOUT_MS_PER_WORD)
}

// Prefer a default English voice (most engines flag exactly one `default:
// true` voice per language pack); fall back to the first English voice, then
// to whatever the engine offers first. `getVoices()` can legitimately return
// `[]` before the engine's async voice list has loaded — `undefined` here
// just means "let the engine pick its own default", not an error.
function pickVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | undefined {
  const voices = synth.getVoices()
  if (voices.length === 0) return undefined
  return (
    voices.find((v) => v.lang?.toLowerCase().startsWith('en') && v.default) ??
    voices.find((v) => v.lang?.toLowerCase().startsWith('en')) ??
    voices[0]
  )
}

export class BrowserTts implements TtsProvider {
  available(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.speechSynthesis !== 'undefined' &&
      typeof SpeechSynthesisUtterance !== 'undefined'
    )
  }

  speak(text: string, rate: number): Promise<void> {
    if (!this.available()) return Promise.resolve()
    const synth = window.speechSynthesis
    const utter = new SpeechSynthesisUtterance(text)
    utter.rate = clamp(rate, 0.5, 2)
    const voice = pickVoice(synth)
    if (voice) utter.voice = voice

    const utterancePromise = new Promise<void>((resolve) => {
      // Resolve on error too — a TTS hiccup (engine reset, unsupported
      // voice, browser quirk) must not stall the lesson queue forever;
      // timeline.ts's pump awaits this promise before advancing.
      utter.onend = () => resolve()
      utter.onerror = () => resolve()
    })

    let resolveTimeout: () => void = () => {}
    const timeoutPromise = new Promise<void>((resolve) => {
      resolveTimeout = resolve
    })
    const timer = setTimeout(() => {
      // Never rejects — a stuck utterance must let the queue continue, not
      // blow up the caller. Cancel it so the engine doesn't keep "talking"
      // (or holding the mic/audio device) after we've moved on.
      console.warn('tts: utterance timeout — continuing')
      synth.cancel()
      resolveTimeout()
    }, computeUtteranceTimeoutMs(text))

    synth.speak(utter)

    return Promise.race([utterancePromise, timeoutPromise]).then(() => {
      clearTimeout(timer)
    })
  }

  cancel(): void {
    if (this.available()) window.speechSynthesis.cancel()
  }

  pause(): void {
    if (this.available()) window.speechSynthesis.pause()
  }

  resume(): void {
    if (this.available()) window.speechSynthesis.resume()
  }
}

// Swappable module-level singleton (same pattern as board/params.ts's
// `onParamDrag`/`setParamDragHandler`): timeline.ts imports the live binding
// `ttsProvider` directly rather than taking it as a constructor arg, so
// tests can drop in a fake via `setTtsProvider` and a future paid provider
// can replace `BrowserTts` app-wide with one call.
export let ttsProvider: TtsProvider = new BrowserTts()

export function setTtsProvider(p: TtsProvider): void {
  ttsProvider = p
}
