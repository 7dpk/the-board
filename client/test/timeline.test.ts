import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Action, applyAction, emptyScene } from '@board/shared'
import { createTimeline, type TimelineDeps } from '../src/timeline'
import { useBoard } from '../src/store'
import { BrowserTts, setTtsProvider, type TtsProvider } from '../src/tts'

// ---------------------------------------------------------------------------
// Fake-time harness: `now`/`raf` are driven manually so the timeline's own
// promise-based waits (no real setTimeout/rAF) can be advanced deterministically.
//
// `step(dtMs)` advances the fake clock by dtMs, fires whatever raf callbacks
// are currently pending, then flushes the microtask queue (via a real
// `setTimeout(0)`) so the timeline's chained `await`s settle before the next
// assertion. One `step` call == "one animation frame" from the timeline's view.
// ---------------------------------------------------------------------------
function makeHarness(
  paramMap: Record<string, Record<string, number>> = {},
  initialSpeed = 1,
  opts: { framesMode?: boolean; voiceOn?: boolean } = {},
) {
  let now = 0
  let paused = false
  let speed = initialSpeed
  let framesMode = opts.framesMode ?? false
  let voiceOn = opts.voiceOn ?? false
  let pendingRaf: Array<() => void> = []

  const commits: Action[] = []
  const captions: string[] = []
  const overrideCalls: Array<{ id: string; k: string; v: number | null }> = []
  const beginSayCalls: number[] = []
  const frameSnapshots: Array<{ elId: string; k: string; values: number[] }> = []

  const deps: TimelineDeps = {
    commit: (a) => commits.push(a),
    setCaption: (t) => captions.push(t),
    setOverride: (id, k, v) => overrideCalls.push({ id, k, v }),
    getParam: (id, k) => paramMap[id]?.[k],
    isPaused: () => paused,
    speed: () => speed,
    now: () => now,
    raf: (cb) => {
      pendingRaf.push(cb)
    },
    beginSay: () => beginSayCalls.push(1),
    isFramesMode: () => framesMode,
    addFrameSnapshot: (elId, k, values) => frameSnapshots.push({ elId, k, values }),
    isVoiceOn: () => voiceOn,
  }

  function tick(dtMs: number) {
    now += dtMs
    const cbs = pendingRaf
    pendingRaf = []
    cbs.forEach((cb) => cb())
  }

  async function step(dtMs = 16) {
    tick(dtMs)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  return {
    deps,
    step,
    commits,
    captions,
    overrideCalls,
    beginSayCalls,
    frameSnapshots,
    setPaused: (p: boolean) => {
      paused = p
    },
    setSpeed: (s: number) => {
      speed = s
    },
    setFramesMode: (v: boolean) => {
      framesMode = v
    },
    setVoiceOn: (v: boolean) => {
      voiceOn = v
    },
  }
}

describe('createTimeline', () => {
  it('processes enqueued actions in order', async () => {
    const h = makeHarness()
    const timeline = createTimeline(h.deps)
    const a1: Action = { op: 'add', c: 'point', id: 'p1', on: 'ax', x: 0, y: 0 }
    const a2: Action = { op: 'add', c: 'point', id: 'p2', on: 'ax', x: 1, y: 1 }
    const a3: Action = { op: 'del', id: 'p1' }

    timeline.enqueue(a1)
    timeline.enqueue(a2)
    timeline.enqueue(a3)

    for (let i = 0; i < 60; i++) await h.step(50)

    expect(h.commits).toEqual([a1, a2, a3])
  })

  it('tweens a numeric param monotonically, then clears the override and commits', async () => {
    const h = makeHarness({ p1: { x: 0 } })
    const timeline = createTimeline(h.deps)
    const action: Action = { op: 'anim', id: 'p1', k: 'x', to: 10, dur: 1, ease: 'linear' }

    timeline.enqueue(action)
    for (let i = 0; i < 15; i++) await h.step(100)

    const xCalls = h.overrideCalls.filter((c) => c.id === 'p1' && c.k === 'x')
    expect(xCalls.length).toBeGreaterThan(1)

    const numeric = xCalls.filter((c) => c.v !== null).map((c) => c.v as number)
    for (let i = 1; i < numeric.length; i++) {
      expect(numeric[i]!).toBeGreaterThanOrEqual(numeric[i - 1]!)
    }
    expect(numeric.at(-1)).toBeCloseTo(10)

    // last override call clears it back to null, and the final value is committed.
    expect(xCalls.at(-1)?.v).toBeNull()
    expect(h.commits).toEqual([action])
  })

  it('types the caption progressively and settles on the full text', async () => {
    const h = makeHarness()
    const timeline = createTimeline(h.deps)
    const text = 'Hello board'
    const action: Action = { op: 'say', text }

    timeline.enqueue(action)
    for (let i = 0; i < 40; i++) await h.step(50)

    expect(h.captions.length).toBeGreaterThan(1) // progressive reveal, not one jump
    expect(h.captions.at(-1)).toBe(text)
    // strictly growing prefixes
    for (let i = 1; i < h.captions.length; i++) {
      expect(h.captions[i]!.length).toBeGreaterThanOrEqual(h.captions[i - 1]!.length)
    }
    expect(h.commits).toEqual([action]) // say commits immediately for history/chat replay
  })

  it('holds the queue while paused and resumes on play', async () => {
    const h = makeHarness()
    const timeline = createTimeline(h.deps)
    const a1: Action = { op: 'focus', ids: ['x'], style: 'highlight' }
    const a2: Action = { op: 'focus', ids: ['y'], style: 'highlight' }

    timeline.enqueue(a1)
    timeline.enqueue(a2)

    await h.step(100)
    expect(h.commits).toEqual([a1]) // a1 commits immediately, its 350ms hold begins

    h.setPaused(true)
    for (let i = 0; i < 10; i++) await h.step(100) // way past 350ms of wall time, but paused
    expect(h.commits).toEqual([a1]) // still holding — a2 must not have committed

    h.setPaused(false)
    for (let i = 0; i < 10; i++) await h.step(100)
    expect(h.commits).toEqual([a1, a2])
  })

  it('speed=2 halves how many frames a hold takes relative to speed=1', async () => {
    async function ticksUntilSecondCommit(speed: number): Promise<number> {
      const h = makeHarness({}, speed)
      const timeline = createTimeline(h.deps)
      timeline.enqueue({ op: 'step', title: 'a' })
      timeline.enqueue({ op: 'step', title: 'b' })

      await h.step(25) // first action commits, its 350ms/speed hold begins
      expect(h.commits).toHaveLength(1)

      let ticks = 0
      while (h.commits.length < 2) {
        await h.step(25)
        ticks++
      }
      return ticks
    }

    const ticksAt1x = await ticksUntilSecondCommit(1)
    const ticksAt2x = await ticksUntilSecondCommit(2)

    expect(ticksAt1x).toBe(14) // 350ms / 25ms per frame
    expect(ticksAt2x).toBe(7) // 350ms / (25ms * speed 2)
  })

  it('ask blocks the queue until resolveAsk is called', async () => {
    const h = makeHarness()
    const timeline = createTimeline(h.deps)
    const ask: Action = { op: 'ask', id: 'q1', kind: 'numeric', text: 'What is 2+2?' }
    const after: Action = { op: 'step', title: 'after' }

    timeline.enqueue(ask)
    timeline.enqueue(after)

    await h.step(10)
    expect(h.commits).toEqual([ask]) // ask commits immediately, then gates

    for (let i = 0; i < 25; i++) await h.step(10)
    expect(h.commits).toEqual([ask]) // no amount of ticking unblocks an ask on its own

    timeline.resolveAsk()
    await h.step(10)

    expect(h.commits).toEqual([ask, after])
  })

  it('clear() while an ask is pending cancels it and lets the pump exit cleanly (T11 carried fix)', async () => {
    const h = makeHarness()
    const timeline = createTimeline(h.deps)
    const ask: Action = { op: 'ask', id: 'q1', kind: 'numeric', text: 'What is 2+2?' }
    const after: Action = { op: 'step', title: 'after' }

    timeline.enqueue(ask)
    await h.step(10)
    expect(h.commits).toEqual([ask]) // ask commits immediately, then gates — pump now parked on waitForAsk()

    // Simulates manual step nav / a new session interrupting the blocking ask.
    // Before the fix, this only emptied `queue`, leaving `askResolve` armed
    // and `running` stuck `true` forever.
    timeline.clear()

    // If the pump were still parked, `kick()`'s `if (running) return` guard
    // would silently drop this — it must actually land in `commits`.
    timeline.enqueue(after)
    await h.step(10)

    expect(h.commits).toEqual([ask, after])
  })

  it('clear() with nothing pending is a harmless no-op (resolveAsk has nothing to settle)', async () => {
    const h = makeHarness()
    const timeline = createTimeline(h.deps)
    expect(() => timeline.clear()).not.toThrow()
    expect(() => timeline.resolveAsk()).not.toThrow()
  })

  it('say with sync runs concurrently with the matching next action instead of sequentially', async () => {
    const h = makeHarness({ p1: { x: 0 } })
    const timeline = createTimeline(h.deps)
    const say: Action = { op: 'say', text: 'watch it move', sync: 'p1' }
    const anim: Action = { op: 'anim', id: 'p1', k: 'x', to: 10, dur: 1, ease: 'linear' }

    timeline.enqueue(say)
    timeline.enqueue(anim)

    // both the typewriter and the tween should be progressing before either finishes.
    // (the first frame only arms each rAF wait; the second is what advances them.)
    await h.step(100)
    expect(h.commits).toEqual([say]) // say commits immediately, as always
    await h.step(100)
    expect(h.captions.length).toBeGreaterThan(0)
    expect(h.overrideCalls.some((c) => c.id === 'p1' && c.k === 'x')).toBe(true)

    for (let i = 0; i < 15; i++) await h.step(100)

    expect(h.commits).toEqual([say, anim])
    expect(h.captions[h.captions.length - 1]).toBe('watch it move')
  })

  it('sync+dwell ordering: a following action only starts once max(typewriter, anim) + dwell has elapsed', async () => {
    const h = makeHarness({ p1: { x: 0 } })
    const timeline = createTimeline(h.deps)
    // typewriter: max(14*28, 800) = 800ms. dwell (3 words): max(1200, 3*250) = 1200ms.
    const text = 'watch it move'
    const say: Action = { op: 'say', text, sync: 'p1' }
    // 3s anim — well longer than the 800ms typewriter, so it's the "max" of the two.
    const anim: Action = { op: 'anim', id: 'p1', k: 'x', to: 10, dur: 3, ease: 'linear' }
    const after: Action = { op: 'step', title: 'after' }

    timeline.enqueue(say)
    timeline.enqueue(anim)
    timeline.enqueue(after)

    // max(typewriter, anim) = 3000ms: both the typewriter and the anim have
    // just settled (a couple of frames' margin for the tween's own frame
    // accounting), but the post-sync dwell hasn't started counting down yet.
    for (let i = 0; i < 62; i++) await h.step(50) // 3100ms
    expect(h.commits).toEqual([say, anim]) // 'after' must NOT start yet — sync doesn't skip the dwell

    // Still mid-dwell, comfortably short of the full +1200ms.
    for (let i = 0; i < 15; i++) await h.step(50) // +750ms = 3750ms
    expect(h.commits).toEqual([say, anim]) // still held

    // Past max(typewriter, anim) + dwell (3000 + 1200 = 4200ms).
    for (let i = 0; i < 15; i++) await h.step(50) // +750ms = 4500ms
    expect(h.commits).toEqual([say, anim, after])
  })

  it('pause mid-tween freezes the override value; play resumes and completes', async () => {
    const h = makeHarness({ p1: { x: 0 } })
    const timeline = createTimeline(h.deps)
    const action: Action = { op: 'anim', id: 'p1', k: 'x', to: 100, dur: 1, ease: 'linear' }

    timeline.enqueue(action)

    // Advance ~500ms of the 1000ms tween
    for (let i = 0; i < 31; i++) await h.step(16)

    const xCalls = h.overrideCalls.filter((c) => c.id === 'p1' && c.k === 'x' && c.v !== null)
    const valueAtPause = xCalls[xCalls.length - 1]?.v
    expect(valueAtPause).toBeDefined()
    expect(valueAtPause).toBeGreaterThan(40) // Should be close to 50
    expect(valueAtPause).toBeLessThan(60)

    // Pause the timeline
    h.setPaused(true)

    // Advance many frames while paused — override value should remain frozen
    for (let i = 0; i < 50; i++) await h.step(16)

    const xCallsAfterPause = h.overrideCalls.filter((c) => c.id === 'p1' && c.k === 'x' && c.v !== null)
    const valueWhilePaused = xCallsAfterPause[xCallsAfterPause.length - 1]?.v
    // Value should not have progressed while paused
    expect(valueWhilePaused).toBe(valueAtPause)

    // Resume and let tween complete
    h.setPaused(false)
    for (let i = 0; i < 50; i++) await h.step(16)

    expect(h.commits).toEqual([action])

    const xFinal = h.overrideCalls.filter((c) => c.id === 'p1' && c.k === 'x')
    // Last override should clear it back to null (end of tween)
    expect(xFinal[xFinal.length - 1]?.v).toBeNull()
  })

  it('changing speed mid-wait completes the hold in fewer frames at higher speed', async () => {
    const h = makeHarness({}, 1)
    const timeline = createTimeline(h.deps)
    const a1: Action = { op: 'add', c: 'point', id: 'p1', on: 'ax', x: 0, y: 0 }
    const a2: Action = { op: 'step', title: 'after' }

    timeline.enqueue(a1)
    timeline.enqueue(a2)

    // First action commits immediately, its 350ms hold begins
    await h.step(16)
    expect(h.commits).toHaveLength(1)

    // Advance part way through the hold (e.g., ~180ms)
    for (let i = 0; i < 11; i++) await h.step(16)
    expect(h.commits).toHaveLength(1) // still waiting

    // Change speed to 2x: remaining 170ms should take ~85ms (5.3 frames)
    h.setSpeed(2)

    let framesUntilSecond = 0
    while (h.commits.length < 2) {
      await h.step(16)
      framesUntilSecond++
      if (framesUntilSecond > 20) break // safety check
    }

    expect(h.commits).toHaveLength(2)
    // At speed 2x, remaining ~170ms should take ~6 frames (16ms each)
    // Being lenient here (expect < 10) to account for timing variations
    expect(framesUntilSecond).toBeLessThan(10)
  })

  it('second ask cycle: ask #2 blocks after answering ask #1, then add commits after answering ask #2', async () => {
    const h = makeHarness()
    const timeline = createTimeline(h.deps)
    const ask1: Action = { op: 'ask', id: 'q1', kind: 'numeric', text: 'Question 1?' }
    const ask2: Action = { op: 'ask', id: 'q2', kind: 'numeric', text: 'Question 2?' }
    const add: Action = { op: 'add', c: 'point', id: 'p1', on: 'ax', x: 0, y: 0 }

    timeline.enqueue(ask1)
    timeline.enqueue(ask2)
    timeline.enqueue(add)

    // Step for ask1 to commit and block
    await h.step(10)
    expect(h.commits).toEqual([ask1])

    // Resolve ask1, pump should move to ask2
    timeline.resolveAsk()
    await h.step(10)
    expect(h.commits).toEqual([ask1, ask2])

    // ask2 is now blocking; add should not have committed
    expect(h.commits).not.toContain(add)

    // Even with many frames, add stays blocked
    for (let i = 0; i < 25; i++) await h.step(10)
    expect(h.commits).toEqual([ask1, ask2])

    // Resolve ask2, add can now commit and hold
    timeline.resolveAsk()
    await h.step(10)
    expect(h.commits).toEqual([ask1, ask2, add])

    // Add's 350ms hold completes
    for (let i = 0; i < 30; i++) await h.step(16)

    // After the hold, pump should be idle (no more actions)
    expect(h.commits).toEqual([ask1, ask2, add])
  })
})

// ---------------------------------------------------------------------------
// Reading pace (V-1, feedback: "the text goes too fast, I'm unable to finish
// it and it goes away"): after a say's typewriter finishes, the queue must
// hold for `max(1200, wordCount*250)` logical ms (scaled by speed, gated by
// pause — same paused/speed-aware `waitLogicalMs` every other wait in this
// file uses) before the next queued action is allowed to commit.
// ---------------------------------------------------------------------------
describe('reading pace (V-1): dwell after the typewriter finishes', () => {
  it('holds the queue after a short say (typewriter done) until the ~1200ms floor dwell elapses', async () => {
    const h = makeHarness()
    const timeline = createTimeline(h.deps)
    timeline.enqueue({ op: 'say', text: 'hi' }) // 1 word: typewriter ~800ms (SAY_MIN_MS), dwell floor 1200ms
    timeline.enqueue({ op: 'step', title: 'after' })

    for (let i = 0; i < 30; i++) await h.step(50) // 1500ms: typewriter long done, still mid-dwell
    expect(h.commits.map((a) => a.op)).toEqual(['say']) // 'after' must not have committed yet

    for (let i = 0; i < 20; i++) await h.step(50) // +1000ms = 2500ms, past 800+1200
    expect(h.commits.map((a) => a.op)).toEqual(['say', 'step'])
  })

  it('dwells longer for a longer say (scales with word count)', async () => {
    async function ticksToSecondCommit(text: string): Promise<number> {
      const h = makeHarness()
      const timeline = createTimeline(h.deps)
      timeline.enqueue({ op: 'say', text })
      timeline.enqueue({ op: 'step', title: 'after' })
      let ticks = 0
      while (h.commits.length < 2 && ticks < 300) {
        await h.step(50)
        ticks++
      }
      return ticks
    }

    const shortTicks = await ticksToSecondCommit('one two') // dwell floor: max(1200, 500) = 1200ms
    const longTicks = await ticksToSecondCommit(
      Array.from({ length: 12 }, (_, i) => `word${i}`).join(' '), // dwell: max(1200, 3000) = 3000ms
    )
    expect(longTicks).toBeGreaterThan(shortTicks)
  })

  it('a higher speed shortens the time to the next commit (dwell scales with speed)', async () => {
    // 10 words -> dwell = max(1200, 2500) = 2500ms, comfortably dominating the ~1120ms typewriter.
    const text = 'one two three four five six seven eight nine ten'

    async function ticksToSecondCommit(speed: number): Promise<number> {
      const h = makeHarness({}, speed)
      const timeline = createTimeline(h.deps)
      timeline.enqueue({ op: 'say', text })
      timeline.enqueue({ op: 'step', title: 'after' })
      let ticks = 0
      while (h.commits.length < 2 && ticks < 400) {
        await h.step(25)
        ticks++
      }
      return ticks
    }

    const ticksAt1x = await ticksToSecondCommit(1)
    const ticksAt2x = await ticksToSecondCommit(2)
    expect(ticksAt2x).toBeLessThan(ticksAt1x * 0.65)
  })

  it('pausing during dwell holds it; resuming lets it complete', async () => {
    const h = makeHarness()
    const timeline = createTimeline(h.deps)
    timeline.enqueue({ op: 'say', text: 'hi' })
    timeline.enqueue({ op: 'step', title: 'after' })

    for (let i = 0; i < 20; i++) await h.step(50) // 1000ms: typewriter done, mid-dwell
    expect(h.commits.map((a) => a.op)).toEqual(['say'])

    h.setPaused(true)
    for (let i = 0; i < 40; i++) await h.step(50) // way past the dwell's real-time budget, but paused
    expect(h.commits.map((a) => a.op)).toEqual(['say']) // still held

    h.setPaused(false)
    for (let i = 0; i < 40; i++) await h.step(50)
    expect(h.commits.map((a) => a.op)).toEqual(['say', 'step'])
  })

  it('beginSay fires once per say — drives the store\'s caption-ghost succession', async () => {
    const h = makeHarness()
    const timeline = createTimeline(h.deps)
    timeline.enqueue({ op: 'say', text: 'first' })
    timeline.enqueue({ op: 'say', text: 'second' })

    for (let i = 0; i < 150; i++) await h.step(50)
    expect(h.beginSayCalls.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Frames mode (V-1, feedback: "instead of animation, we could use multiple
// pictures on bottom of each other... if animation is getting complicated"):
// while on, `anim` commits its final value instantly (no tween) and records
// a 4-sample snapshot for Board's frames-strip UI; a `set` with `dur` also
// skips its tween but never records a snapshot.
// ---------------------------------------------------------------------------
describe('frames mode (V-1): anim commits instantly + emits a snapshot strip', () => {
  it('commits the final value on the very first frame, makes no override/tween calls, and records a 4-sample snapshot incl. endpoints', async () => {
    const h = makeHarness({ p1: { x: 0 } }, 1, { framesMode: true })
    const timeline = createTimeline(h.deps)
    const action: Action = { op: 'anim', id: 'p1', k: 'x', to: 9, dur: 1, ease: 'linear' }
    timeline.enqueue(action)

    await h.step(16)

    expect(h.commits).toEqual([action])
    expect(h.overrideCalls).toEqual([]) // no tween ever ran
    expect(h.frameSnapshots).toEqual([{ elId: 'p1', k: 'x', values: [0, 3, 6, 9] }])
  })

  it('samples span the full from..to range, endpoints included, for a non-zero-aligned range', async () => {
    const h = makeHarness({ p1: { x: 2 } }, 1, { framesMode: true })
    const timeline = createTimeline(h.deps)
    timeline.enqueue({ op: 'anim', id: 'p1', k: 'x', to: 10, dur: 2 })
    await h.step(16)

    const values = h.frameSnapshots[0]?.values
    expect(values).toHaveLength(4)
    expect(values?.[0]).toBeCloseTo(2)
    expect(values?.[3]).toBeCloseTo(10)
  })

  it('a `set` with `dur` in frames mode also skips the tween (instant commit) but records no snapshot', async () => {
    const h = makeHarness({ p1: { x: 0 } }, 1, { framesMode: true })
    const timeline = createTimeline(h.deps)
    const action: Action = { op: 'set', id: 'p1', k: 'x', v: 5, dur: 1 }
    timeline.enqueue(action)
    await h.step(16)

    expect(h.commits).toEqual([action])
    expect(h.overrideCalls).toEqual([])
    expect(h.frameSnapshots).toEqual([])
  })

  it('normal mode (framesMode off) is unaffected: anim still tweens over time as before', async () => {
    const h = makeHarness({ p1: { x: 0 } }, 1, { framesMode: false })
    const timeline = createTimeline(h.deps)
    const action: Action = { op: 'anim', id: 'p1', k: 'x', to: 10, dur: 1, ease: 'linear' }
    timeline.enqueue(action)

    for (let i = 0; i < 15; i++) await h.step(100)

    expect(h.overrideCalls.length).toBeGreaterThan(1) // the tween produced progressive override calls
    expect(h.frameSnapshots).toEqual([])
    expect(h.commits).toEqual([action])
  })
})

// ---------------------------------------------------------------------------
// Voice narration (V-1, feedback: "can we use text to voice... to make it
// more interactive?"). A FAKE TtsProvider is injected via the swappable
// `setTtsProvider` (tts.ts) so these tests never touch a real
// speechSynthesis engine.
// ---------------------------------------------------------------------------
class FakeTts implements TtsProvider {
  calls: Array<{ text: string; rate: number }> = []
  cancelCalls = 0
  pauseCalls = 0
  resumeCalls = 0
  private resolvers: Array<() => void> = []

  available(): boolean {
    return true
  }

  speak(text: string, rate: number): Promise<void> {
    this.calls.push({ text, rate })
    return new Promise((resolve) => {
      this.resolvers.push(resolve)
    })
  }

  resolveNext(): void {
    this.resolvers.shift()?.()
  }

  cancel(): void {
    this.cancelCalls++
  }

  pause(): void {
    this.pauseCalls++
  }

  resume(): void {
    this.resumeCalls++
  }
}

describe('voice narration (V-1): ttsProvider wiring at the timeline level', () => {
  let fake: FakeTts

  beforeEach(() => {
    fake = new FakeTts()
    setTtsProvider(fake)
  })

  afterEach(() => {
    setTtsProvider(new BrowserTts()) // restore the real (jsdom: unavailable) provider
  })

  it('voiceOn: speak is called with the say text and the current speed as rate', async () => {
    const h = makeHarness({}, 1.5, { voiceOn: true })
    const timeline = createTimeline(h.deps)
    timeline.enqueue({ op: 'say', text: 'watch this' })

    await h.step(10)
    expect(fake.calls).toEqual([{ text: 'watch this', rate: 1.5 }])
  })

  it('voice off: the provider is never called', async () => {
    const h = makeHarness({}, 1, { voiceOn: false })
    const timeline = createTimeline(h.deps)
    timeline.enqueue({ op: 'say', text: 'silent narration' })

    for (let i = 0; i < 80; i++) await h.step(50)
    expect(fake.calls).toEqual([])
    expect(fake.cancelCalls).toBe(0)
    expect(fake.pauseCalls).toBe(0)
    expect(fake.resumeCalls).toBe(0)
  })

  it('the queue waits for the speech promise to resolve, even after typewriter+dwell would otherwise be done', async () => {
    const h = makeHarness({}, 1, { voiceOn: true })
    const timeline = createTimeline(h.deps)
    timeline.enqueue({ op: 'say', text: 'hi' }) // typewriter ~800ms + dwell 1200ms = 2000ms
    timeline.enqueue({ op: 'step', title: 'after' })

    for (let i = 0; i < 60; i++) await h.step(50) // 3000ms: well past typewriter+dwell
    expect(h.commits.map((a) => a.op)).toEqual(['say']) // still gated on speech

    fake.resolveNext() // speech finally ends
    await h.step(10)
    expect(h.commits.map((a) => a.op)).toEqual(['say', 'step'])
  })

  it('speech shorter than dwell: the queue proceeds only after the full dwell, not as soon as speech resolves', async () => {
    const h = makeHarness({}, 1, { voiceOn: true })
    const timeline = createTimeline(h.deps)
    // 10 words -> dwell = max(1200, 2500) = 2500ms, comfortably longer than the ~1120ms typewriter
    // and *far* longer than the fake speech, which resolves almost immediately below.
    const text = 'one two three four five six seven eight nine ten'
    timeline.enqueue({ op: 'say', text })
    timeline.enqueue({ op: 'step', title: 'after' })

    await h.step(10)
    expect(fake.calls).toEqual([{ text, rate: 1 }])
    fake.resolveNext() // speech finishes almost instantly — much shorter than the dwell

    for (let i = 0; i < 50; i++) await h.step(50) // 2500ms: past the ~1120ms typewriter, still mid-dwell
    expect(h.commits.map((a) => a.op)).toEqual(['say']) // must still be gated on dwell, not released early by speech

    for (let i = 0; i < 40; i++) await h.step(50) // +2000ms = 4500ms, comfortably past typewriter+dwell (~3620ms)
    expect(h.commits.map((a) => a.op)).toEqual(['say', 'step'])
  })

  it('clear() cancels any in-flight speech when voice is on', async () => {
    const h = makeHarness({}, 1, { voiceOn: true })
    const timeline = createTimeline(h.deps)
    timeline.enqueue({ op: 'say', text: 'narrating' })
    await h.step(10)

    timeline.clear()
    expect(fake.cancelCalls).toBe(1)
  })

  it('clear() does not touch the provider when voice is off', async () => {
    const h = makeHarness({}, 1, { voiceOn: false })
    const timeline = createTimeline(h.deps)
    timeline.enqueue({ op: 'say', text: 'narrating' })
    await h.step(10)

    timeline.clear()
    expect(fake.cancelCalls).toBe(0)
  })
})

describe('useBoard.jumpToStep', () => {
  it('rebuilds the scene from the history prefix at steps[i].startIndex', () => {
    useBoard.setState({ scene: emptyScene, history: [], steps: [], chat: [], ask: null })

    const actions: Action[] = [
      { op: 'add', c: 'axes', id: 'ax', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
      { op: 'step', title: 'intro' },
      { op: 'add', c: 'point', id: 'p1', on: 'ax', x: 1, y: 1 },
      { op: 'step', title: 'point added' },
      { op: 'add', c: 'point', id: 'p2', on: 'ax', x: 2, y: 2 },
    ]
    for (const a of actions) useBoard.getState().commit(a)

    const { steps, history } = useBoard.getState()
    expect(steps).toHaveLength(2)

    useBoard.getState().jumpToStep(1)

    const expected = history.slice(0, steps[1]!.startIndex).reduce(applyAction, emptyScene)
    expect(useBoard.getState().scene).toEqual(expected)
    // sanity: step 1's prefix should NOT yet include p2 (added after step 1).
    expect(expected.elements['p2']).toBeUndefined()
  })

  it('answerAsk clears ask state and unblocks a pending ask in the timeline', async () => {
    useBoard.setState({ scene: emptyScene, history: [], steps: [], chat: [], ask: null })

    useBoard.getState().enqueue({ op: 'ask', id: 'q1', kind: 'free', text: 'why?' })
    // let the real timeline (real raf/Date.now) process the enqueue + commit.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(useBoard.getState().ask).toEqual({ id: 'q1', kind: 'free', text: 'why?', options: undefined, answer: undefined })

    useBoard.getState().answerAsk()
    expect(useBoard.getState().ask).toBeNull()
  })

  it('jumpToStep interrupts a pending ask (clears stale ask state, does not deadlock the pump) — T11 carried fix', async () => {
    useBoard.setState({ scene: emptyScene, history: [], steps: [], chat: [], ask: null })

    useBoard.getState().commit({ op: 'step', title: 'start' }) // steps[0], startIndex 0
    useBoard.getState().enqueue({ op: 'ask', id: 'qX', kind: 'free', text: 'pending?' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(useBoard.getState().ask).not.toBeNull() // ask landed and is blocking the pump

    useBoard.getState().jumpToStep(0) // manual nav interrupts the pending ask

    // Stale ask state must not linger in the UI after nav cancels it.
    expect(useBoard.getState().ask).toBeNull()

    // If the pump were left parked (pre-fix: `clear()` never resolved
    // `askResolve`), this would never land in history. Uses a `set` (not
    // `step`/`add`/etc.) deliberately: `set` with no `dur` commits with no
    // post-commit hold, so this assertion isn't racing a real 350ms timer
    // left running in the background for the *next* test in this file.
    useBoard.getState().enqueue({ op: 'set', id: 'after-nav-marker', k: 'x', v: 1 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(useBoard.getState().history.some((a) => a.op === 'set' && a.id === 'after-nav-marker')).toBe(true)
  })

  it('reset() wipes board state and cancels a pending ask (new session interrupting an old one)', async () => {
    useBoard.setState({ scene: emptyScene, history: [], steps: [], chat: [], ask: null })

    useBoard.getState().enqueue({ op: 'ask', id: 'qY', kind: 'free', text: 'old session ask' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(useBoard.getState().ask).not.toBeNull()

    useBoard.getState().reset()

    expect(useBoard.getState().ask).toBeNull()
    expect(useBoard.getState().history).toEqual([])
    expect(useBoard.getState().scene).toEqual(emptyScene)

    // Pump must not be left parked from the cancelled ask — a fresh enqueue
    // in the "new session" has to actually process. `set` with no `dur`
    // again (see previous test's comment) to avoid a lingering real-timer
    // hold bleeding into whatever test runs next in this file.
    useBoard.getState().enqueue({ op: 'set', id: 'new-session-marker', k: 'x', v: 1 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(useBoard.getState().history.some((a) => a.op === 'set' && a.id === 'new-session-marker')).toBe(true)
  })

  it('treats a focus action whose ids all get filtered out as no-focus, not an empty-array focus', () => {
    useBoard.setState({ scene: emptyScene, history: [], steps: [], chat: [], ask: null })

    // 'ghost' doesn't exist in the scene, so applyAction's focus reducer
    // filters it out, leaving ids: []. The store must normalize that to null.
    useBoard.getState().commit({ op: 'focus', ids: ['ghost'], style: 'highlight' })

    expect(useBoard.getState().scene.focus).toBeNull()
  })
})
