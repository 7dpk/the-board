// responsive.test.ts — pure unit tests for board/responsive.ts's
// clampAxesHeight (task P-B item 3: "the visual has graph, value big in
// size — amend to suit different scale"). No DOM/viewport involved — it's
// a plain function of a viewport-height number.
import { describe, expect, it } from 'vitest'
import { clampAxesHeight } from '../src/board/responsive'

describe('clampAxesHeight', () => {
  it('clamps to the 260px floor on a short viewport', () => {
    expect(clampAxesHeight(400)).toBe(260) // 38% of 400 = 152, below the floor
  })

  it('clamps to the 420px ceiling on a tall viewport', () => {
    expect(clampAxesHeight(2000)).toBe(420) // 38% of 2000 = 760, above the ceiling
  })

  it('scales linearly with viewport height in between', () => {
    expect(clampAxesHeight(1000)).toBeCloseTo(380) // 38% of 1000
  })

  it('is exactly the floor/ceiling at their boundary viewport heights', () => {
    expect(clampAxesHeight(260 / 0.38)).toBeCloseTo(260)
    expect(clampAxesHeight(420 / 0.38)).toBeCloseTo(420)
  })
})
