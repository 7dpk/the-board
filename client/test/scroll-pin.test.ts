// scroll-pin.test.ts — pure unit tests for scrollPin.ts's auto-follow
// decision helpers, shared by ChatPanel (chat scroll pin) and Board (board
// auto-follow). Kept DOM-free on purpose (see scrollPin.ts's header) —
// jsdom never computes real scrollHeight/clientHeight, so the interesting
// logic is tested here directly against synthetic metrics rather than via a
// rendered component.
import { describe, expect, it } from 'vitest'
import { BOTTOM_THRESHOLD_PX, isNearBottom, shouldAutoFollow } from '../src/scrollPin'

describe('isNearBottom', () => {
  it('is true when scrolled exactly to the bottom', () => {
    expect(isNearBottom({ scrollTop: 560, scrollHeight: 800, clientHeight: 240 })).toBe(true)
  })

  it('is true within the default threshold of the bottom', () => {
    expect(isNearBottom({ scrollTop: 560 - BOTTOM_THRESHOLD_PX, scrollHeight: 800, clientHeight: 240 })).toBe(true)
  })

  it('is false just past the default threshold', () => {
    expect(isNearBottom({ scrollTop: 560 - BOTTOM_THRESHOLD_PX - 1, scrollHeight: 800, clientHeight: 240 })).toBe(
      false,
    )
  })

  it('is false when scrolled to the very top of tall content', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 800, clientHeight: 240 })).toBe(false)
  })

  it('is true when content does not overflow the viewport at all', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 240 })).toBe(true)
  })

  it('respects a custom threshold', () => {
    const metrics = { scrollTop: 500, scrollHeight: 800, clientHeight: 240 } // distance = 60
    expect(isNearBottom(metrics, 50)).toBe(false)
    expect(isNearBottom(metrics, 60)).toBe(true)
  })
})

describe('shouldAutoFollow', () => {
  const atBottom = { scrollTop: 560, scrollHeight: 800, clientHeight: 240 }
  const scrolledAway = { scrollTop: 0, scrollHeight: 800, clientHeight: 240 }

  it('follows when at the bottom and no manual scroll has happened', () => {
    expect(shouldAutoFollow(atBottom, null)).toBe(true)
  })

  it('does not follow when scrolled away and the manual scroll was recent', () => {
    expect(shouldAutoFollow(scrolledAway, 100)).toBe(false)
  })

  // P-E fix: the old bare-timeout escape hatch (resume once
  // msSinceManualScroll exceeded a 5s grace, regardless of position) is
  // gone — scrolled-away never resumes on elapsed time alone anymore, no
  // matter how long ago the manual scroll was.
  it('does not resume on elapsed time alone, however long ago the manual scroll was', () => {
    expect(shouldAutoFollow(scrolledAway, 5000)).toBe(false)
    expect(shouldAutoFollow(scrolledAway, 60_000)).toBe(false)
    expect(shouldAutoFollow(scrolledAway, Number.MAX_SAFE_INTEGER)).toBe(false)
  })

  it('resumes once the reader is actually back near the bottom, regardless of how long they were away', () => {
    expect(shouldAutoFollow(atBottom, 5000)).toBe(true)
    expect(shouldAutoFollow(atBottom, 60_000)).toBe(true)
  })

  it('a recent manual scroll does not block following if metrics say we are back at the bottom', () => {
    expect(shouldAutoFollow(atBottom, 100)).toBe(true)
  })
})
