// responsive.ts — pure sizing math for Board.tsx's adaptive Mafs axes
// height (task P-B item 3: "the visual has graph, value big in size — amend
// to suit different scale").
//
// Mafs measures its container via ResizeObserver whenever given a non-numeric
// `height`/`width` (see Board.tsx's MAFS_WIDTH/HEIGHT comment) — Board.tsx
// deliberately keeps passing an explicit *numeric* height to stay off that
// codepath, so "adaptive" here means computing that number from the viewport
// rather than switching Mafs to auto-measurement. Kept as a standalone pure
// function (of viewportHeightPx) so it's unit-testable without a real layout
// engine (jsdom reports zero for all measured sizes) — see
// client/test/responsive.test.ts.
const AXES_MIN_HEIGHT = 260
const AXES_MAX_HEIGHT = 420
const AXES_HEIGHT_VH_FRACTION = 0.38

/** clamp(260px, 38vh, 420px) */
export function clampAxesHeight(viewportHeightPx: number): number {
  return Math.min(AXES_MAX_HEIGHT, Math.max(AXES_MIN_HEIGHT, viewportHeightPx * AXES_HEIGHT_VH_FRACTION))
}
