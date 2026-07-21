// scrollPin.ts — the "should this scroll region auto-follow new content"
// decision, shared by ChatPanel (chat/ChatPanel.tsx) and Board
// (board/Board.tsx) so both panels pin-to-bottom the same way.
//
// Kept pure and DOM-independent on purpose: jsdom's layout engine always
// reports zero-size rects (scrollHeight/clientHeight/scrollTop are just
// plain numbers it never computes from real layout — see test/setup.ts's
// header comment for the same caveat re: getBoundingClientRect), so the
// actual scroll-listener/scrollIntoView wiring in each component is a thin,
// largely-untestable-in-jsdom shim around this — the interesting decision
// logic lives here instead, where it's fully unit-testable (see
// client/test/scroll-pin.test.ts).
export type ScrollMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

// Feedback round: "the right chat sidebar doesn't scroll up" / "the left
// visual tab stays where it is" — both trace back to the *same* heuristic:
// a panel is considered "at the bottom" (and therefore safe to auto-follow)
// once it's within this many px of its true bottom edge.
export const BOTTOM_THRESHOLD_PX = 40

/** True when `m` is within `thresholdPx` of its scrollable bottom edge. */
export function isNearBottom(m: ScrollMetrics, thresholdPx: number = BOTTOM_THRESHOLD_PX): boolean {
  const distanceFromBottom = m.scrollHeight - m.scrollTop - m.clientHeight
  return distanceFromBottom <= thresholdPx
}

/**
 * Board's auto-follow gate (task P-B item 2, revised task P-E): reuses
 * `isNearBottom` (same heuristic as chat). `msSinceManualScroll` is `null`
 * when the user has never manually scrolled (or not since the last follow),
 * which always allows auto-follow — there's nothing to resume *from* yet.
 *
 * P-E fix (P-B follow-up, user feedback): the original version also OR'd in
 * a bare 5s timeout — once a manual scroll-away was more than
 * `MANUAL_SCROLL_GRACE_MS` old, auto-follow forcibly resumed and yanked the
 * view back down even while the reader was still deliberately scrolled up
 * reading something. That timeout escape hatch is gone: once the reader has
 * manually scrolled away, auto-follow only resumes once metrics say they're
 * actually back near the bottom themselves — no time-based override. The
 * `msSinceManualScroll === null` case is the one form of "grace" that
 * remains: before any manual scroll has ever happened, following is
 * unconditional.
 */
export function shouldAutoFollow(metrics: ScrollMetrics, msSinceManualScroll: number | null): boolean {
  if (isNearBottom(metrics)) return true
  return msSinceManualScroll === null
}
