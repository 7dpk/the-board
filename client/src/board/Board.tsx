// Board.tsx — renders useBoard's scene as live math graphics.
//
// Grouping: scene.order is walked once to find every element whose
// `params.on` resolves to an `axes` element in the scene — those become the
// children of that axes's single <Mafs> canvas (rendered in scene.order,
// inside <Coordinates.Cartesian/>). Everything else (numberline/table/free
// labels/physics-until-T13/anything with no or a dangling `on`) renders as
// its own standalone flow block, in scene.order position — an element with a
// dangling `on` (its axes was `del`eted; see StandaloneBlock/OrphanedComponent)
// renders a placeholder there instead of its real, Mafs-context-dependent
// renderer.
//
// Responsive sizing (task P-B, feedback: "the visual has graph, value big in
// size — amend to suit different scale"): axes height is computed from the
// viewport (`clampAxesHeight`, responsive.ts) and re-measured on resize,
// rather than hardcoded — width stays a fixed 640 (Mafs needs a definite
// numeric size; see the ResizeObserver note below). Physics SVGs/table/label
// max-widths are handled in styles.css instead, since those aren't Mafs.
//
// Board auto-follow (task P-B, feedback: "the left visual tab stays where it
// is, forcing me to scroll up to see the visual"): whenever something new
// commits (`history.length` grows), the newest block scrolls into view via
// `scrollIntoView({behavior:'smooth', block:'nearest'})` — but only if the
// reader hasn't manually scrolled `.board-wrap` away from the bottom
// (scrollPin.ts's `shouldAutoFollow`, the same heuristic ChatPanel uses —
// once scrolled away, resuming requires actually being back near the bottom
// again, no timeout override; see that file for the P-E revision). `.board-
// wrap` lives in App.tsx, one level up from
// this component's own root (`.board-canvas`) — found via `closest` rather
// than threaded through props, so this stays self-contained even when Board
// is reused without a `.board-wrap` ancestor (Gallery.tsx's demo cards),
// where auto-follow simply no-ops.
import { AnimatePresence, motion } from 'motion/react'
import { Mafs } from 'mafs'
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { emptyScene, formatNum, type Scene, type SceneElement } from '@board/shared'
import { type FrameSnapshot, useBoard } from '../store'
import { AxesCoordinates } from './math'
import { registry } from './registry'
import { clampAxesHeight } from './responsive'
import { shouldAutoFollow } from '../scrollPin'

// Mafs measures its container via ResizeObserver when given width="auto"
// (its default) — see client/test/setup.ts for the full story. We sidestep
// that whole codepath by always passing an explicit numeric width/height,
// which also keeps every <Mafs> canvas a predictable size in this POC. Height
// is still adaptive (clampAxesHeight, computed from the viewport) — it's a
// plain number recomputed on resize, not Mafs's own auto-measurement.
const MAFS_WIDTH = 640

function defaultViewportHeight(): number {
  return typeof window !== 'undefined' ? window.innerHeight : 760
}

function focusClassFor(scene: Scene, id: string): string {
  const focus = scene.focus
  if (!focus) return ''
  const inFocus = focus.ids.includes(id)
  if (focus.style === 'dim-others') return inFocus ? '' : 'focus-dim'
  if (focus.style === 'pulse') return inFocus ? 'focus-pulse' : ''
  if (focus.style === 'highlight') return inFocus ? 'focus-highlight' : ''
  return ''
}

function joinClasses(...parts: Array<string | false | undefined>): string | undefined {
  const cls = parts.filter(Boolean).join(' ')
  return cls || undefined
}

// Plot draw-in (task-s2, "more ways to visualize, like manim/3b1b"): plot/
// segment/vector are the on-axes components a lesson typically narrates
// live as it's introduced, so they get a 3b1b-style stroke reveal on mount
// (styles.css's `.board-draw-in`, a pure CSS keyframe on stroke-dashoffset —
// Mafs renders their <path>/<line> internally with no ref exposed to drive
// via Motion's pathLength). Every other on-axes type (point/area/tangent/
// label) either has no stroke to reveal (point/area are filled) or isn't
// something a lesson "draws" so much as places, so they're left with their
// existing plain mount (no regression risk to their own render tests). A
// fresh <g key={el.id}> only ever mounts once per element (Board.tsx reuses
// the same DOM node across liveOverride/tween re-renders), so this class
// plays exactly once, on first paint, and never replays on drag/tween.
const DRAW_IN_TYPES = new Set(['plot', 'segment', 'vector'])

function drawInClassFor(c: string): string | undefined {
  return DRAW_IN_TYPES.has(c) ? 'board-draw-in' : undefined
}

function UnknownComponent({ c }: { c: string }): ReactElement {
  return <div className="board-unknown">unsupported component: {c}</div>
}

// ---------------------------------------------------------------------------
// Frames mode (V-1, feedback: "instead of animation, we could use multiple
// pictures on bottom of each other... if animation is getting complicated").
// While frames mode is on, timeline.ts commits an `anim`'s final value
// instantly instead of tweening and records a `FrameSnapshot` (4 sampled
// values, endpoints included) in the store. This renders that snapshot as a
// small strip of the SAME component, each copy pinned to one sampled value —
// reusing Gallery.tsx's isolated-scene trick (Board's own `scene` override
// prop) rather than building a parallel renderer.
// ---------------------------------------------------------------------------

// Isolates just the snapshotted element (plus its axes, if it's on one) into
// its own tiny scene with param `k` pinned to `v` — everything else in the
// live scene is irrelevant to "what did this one component look like at this
// value".
function buildFrameScene(scene: Scene, elId: string, k: string, v: number): Scene {
  const el = scene.elements[elId]
  if (!el) return emptyScene
  const pinned: SceneElement = { ...el, params: { ...el.params, [k]: v } }
  const onId = typeof el.params.on === 'string' ? el.params.on : undefined
  const axesEl = onId ? scene.elements[onId] : undefined
  if (axesEl) {
    return { ...emptyScene, order: [axesEl.id, pinned.id], elements: { [axesEl.id]: axesEl, [pinned.id]: pinned } }
  }
  return { ...emptyScene, order: [pinned.id], elements: { [pinned.id]: pinned } }
}

function FramesStrips({ scene, snapshots }: { scene: Scene; snapshots: FrameSnapshot[] }): ReactElement | null {
  if (snapshots.length === 0) return null
  return (
    <div className="frames-strips">
      {snapshots.map((snap, i) => (
        <div className="frames-strip" key={`${snap.elId}:${snap.k}:${i}`}>
          {snap.values.map((v, vi) => (
            <div className="frames-item" key={vi}>
              <div className="frames-item-preview">
                <Board scene={buildFrameScene(scene, snap.elId, snap.k, v)} />
              </div>
              <div className="frames-item-label">
                {snap.k} = {formatNum(v)}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// Placeholder for an element whose `params.on` points at an axes id that no
// longer resolves to a live `axes` element (i.e. that axes was `del`eted out
// from under it). Its real renderer (registry[el.c], e.g. PointRenderer) is
// written for on-axes use only — it calls Mafs hooks (useTransformContext)
// that require an ancestor <Mafs> element. Board.tsx no longer nests this
// element under any <Mafs> once its axes is gone (StandaloneBlock, a plain
// flow <div>, is the only place left for it to render), so mounting the real
// renderer there throws Mafs's TransformContext invariant instead of
// rendering. Render this instead of the real renderer in that case.
function OrphanedComponent(): ReactElement {
  return <div className="board-orphaned">detached from deleted axes</div>
}

// Selection + focus wiring shared by every element wrapper (SVG <g> inside a
// Mafs canvas, or a flow <div> standalone). Click sets selection and stops
// propagation so it never also fires the board-background click-to-clear
// handler or (for on-axes elements) the containing axes block's own handler.
function useElementWiring(scene: Scene, id: string): { className: string | undefined; onClick: (e: { stopPropagation(): void }) => void } {
  const selection = useBoard((s) => s.selection)
  const setSelection = useBoard((s) => s.setSelection)
  const className = joinClasses(focusClassFor(scene, id), selection === id && 'board-selected')
  const onClick = (e: { stopPropagation(): void }): void => {
    e.stopPropagation()
    setSelection(id)
  }
  return { className, onClick }
}

function MafsChild({ el, scene }: { el: SceneElement; scene: Scene }): ReactElement {
  const { className, onClick } = useElementWiring(scene, el.id)
  const Cmp = registry[el.c]
  // Animation opacity discipline (explicit user ask): while THIS element is
  // mid-tween/mid-drag, its id sits in the store's liveOverrides (timeline.ts's
  // `tween` -> setOverride, ControlStrip drag -> setOverride). Render it at
  // reduced opacity via `.board-animating` (styles.css) and let the wrapper's
  // opacity transition settle it back to 1.0 when the override clears — no
  // layout shift, no flicker (opacity only). A per-element subscription so only
  // the animating element re-renders on its own override ticks.
  const animating = useBoard((s) => el.id in s.liveOverrides)
  const drawnClassName = joinClasses(className, drawInClassFor(el.c), animating && 'board-animating')
  // No <UnknownComponent> fallback here (unlike StandaloneBlock): a plain
  // <div> isn't valid direct SVG content, and every current on-axes-capable
  // ComponentType (plot/point/vector/segment/area/tangent/on-axes label) has
  // a registry entry already — only the physics types (T13) and axes itself
  // lack one, and none of those declare an `on` field, so this branch is
  // unreachable with today's component schemas. Rendering nothing here is
  // the correct degenerate behavior if that ever changes.
  return (
    <g className={drawnClassName} onClick={onClick} data-el-id={el.id}>
      {Cmp ? <Cmp el={el} /> : null}
    </g>
  )
}

// `blockRef` is set only on the newest block (Board's own bookkeeping, see
// below) so Board can `scrollIntoView` it on auto-follow without threading a
// ref through every block on every render.
function StandaloneBlock({
  el,
  scene,
  orphaned,
  blockRef,
  snapshots,
}: {
  el: SceneElement
  scene: Scene
  orphaned: boolean
  blockRef?: (node: HTMLDivElement | null) => void
  snapshots: FrameSnapshot[]
}): ReactElement {
  const { className, onClick } = useElementWiring(scene, el.id)
  const Cmp = registry[el.c]
  return (
    <motion.div
      ref={blockRef}
      className={joinClasses('board-block', className)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      onClick={onClick}
      data-el-id={el.id}
    >
      {orphaned ? <OrphanedComponent /> : Cmp ? <Cmp el={el} /> : <UnknownComponent c={el.c} />}
      <FramesStrips scene={scene} snapshots={snapshots} />
    </motion.div>
  )
}

function AxesBlock({
  axes,
  elements,
  scene,
  height,
  blockRef,
  snapshots,
}: {
  axes: SceneElement
  elements: SceneElement[]
  scene: Scene
  height: number
  blockRef?: (node: HTMLDivElement | null) => void
  snapshots: FrameSnapshot[]
}): ReactElement {
  const { className, onClick } = useElementWiring(scene, axes.id)
  const p = axes.params
  const xmin = typeof p.xmin === 'number' ? p.xmin : -10
  const xmax = typeof p.xmax === 'number' ? p.xmax : 10
  const ymin = typeof p.ymin === 'number' ? p.ymin : -10
  const ymax = typeof p.ymax === 'number' ? p.ymax : 10
  // scene.ts's DEFAULTS always fills axes.grid = true at add-time unless the
  // action explicitly sets grid:false, so `p.grid !== false` (not `?? true`)
  // is the correct read here — any non-false value (including an
  // unexpected/missing one on a hand-built scene) keeps the grid on.
  const grid = p.grid !== false

  return (
    <motion.div
      ref={blockRef}
      className={joinClasses('board-block', className)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      onClick={onClick}
      data-el-id={axes.id}
    >
      <Mafs
        viewBox={{ x: [xmin, xmax], y: [ymin, ymax] }}
        pan={false}
        zoom={false}
        width={MAFS_WIDTH}
        height={height}
      >
        <AxesCoordinates xmin={xmin} xmax={xmax} ymin={ymin} ymax={ymax} grid={grid} />
        {elements.map((child) => (
          <MafsChild key={child.id} el={child} scene={scene} />
        ))}
      </Mafs>
      <FramesStrips scene={scene} snapshots={snapshots} />
    </motion.div>
  )
}

type Block =
  | { kind: 'axes'; key: string; axes: SceneElement; elements: SceneElement[] }
  | { kind: 'standalone'; key: string; el: SceneElement; orphaned: boolean }

function groupBlocks(scene: Scene): Block[] {
  const childrenByAxes = new Map<string, SceneElement[]>()
  const consumed = new Set<string>()

  for (const id of scene.order) {
    const el = scene.elements[id]
    if (!el) continue
    const on = el.params.on
    if (typeof on === 'string' && scene.elements[on]?.c === 'axes') {
      const arr = childrenByAxes.get(on) ?? []
      arr.push(el)
      childrenByAxes.set(on, arr)
      consumed.add(id)
    }
  }

  const blocks: Block[] = []
  for (const id of scene.order) {
    if (consumed.has(id)) continue
    const el = scene.elements[id]
    if (!el) continue
    if (el.c === 'axes') {
      blocks.push({ kind: 'axes', key: id, axes: el, elements: childrenByAxes.get(id) ?? [] })
    } else {
      // Not consumed above, and not axes itself: either a genuine flow
      // element (no `on` — numberline/table/free label/physics) or one whose
      // `on` is a string that failed the live-axes check above (its axes was
      // deleted, or never was an axes at all) — the latter renders a
      // placeholder instead of its real (Mafs-dependent) renderer.
      const orphaned = typeof el.params.on === 'string'
      blocks.push({ kind: 'standalone', key: id, el, orphaned })
    }
  }
  return blocks
}

// `sceneOverride` (task-pe, Gallery.tsx): every consumer of Board() shares
// ONE module-level zustand store (store.ts's `useBoard`, a plain `create()`
// singleton — not a per-instance context), which is exactly right for
// App.tsx's single live session but breaks Gallery.tsx's ComponentCard,
// which mounts ~18 Board instances at once, each wanting to preview its OWN
// local example scene and react live to its own slider. Reading straight
// from the shared store, every card would render the same (whichever the
// global store's scene currently is) and no card's slider would visibly do
// anything — `localScene` state existed but nothing ever fed it to Board.
// An optional `scene` prop lets a caller override just the rendered scene
// while everything else on this render path (liveOverrides, selection,
// auto-follow) still reads the real store as before — Gallery's demo cards
// don't drag/tween/select, so those stay harmlessly shared/inert for them.
export default function Board({ scene: sceneOverride }: { scene?: Scene } = {}): ReactElement {
  const storeScene = useBoard((s) => s.scene)
  const scene = sceneOverride ?? storeScene
  // Subscribed for its reference-change alone: effectiveParams() (called
  // deep inside registry renderers, see params.ts) reads
  // useBoard.getState().liveOverrides directly rather than via a hook, so
  // something on this render path must still be subscribed to liveOverrides
  // or a mid-tween/mid-drag override would never trigger a re-render here.
  // This is a coarse (whole-Board) re-render on every override tick, which
  // is fine at this POC's scale but is the one obvious place to add
  // per-element memoization if perf ever becomes a problem.
  useBoard((s) => s.liveOverrides)
  const setSelection = useBoard((s) => s.setSelection)
  // history.length is the "something new just committed" signal that drives
  // auto-follow below — every commit (add/set/say/step/...) grows it by one.
  const historyLength = useBoard((s) => s.history.length)
  // Frames mode (V-1): every accumulated snapshot, filtered per-block below.
  // A `sceneOverride` render (Gallery's preview cards, and — critically —
  // each small preview a frames-strip itself renders via `<Board
  // scene={buildFrameScene(...)}>`, see FramesStrips above) never shows
  // strips of its own: the pinned preview element keeps the SAME id as the
  // live one, so without this gate every preview would recurse into
  // rendering its own frames-strip for the very snapshot it's already one
  // frame of. Only the real, store-driven Board renders strips.
  const frameSnapshots = useBoard((s) => s.frameSnapshots)
  const snapshotsForBlocks = sceneOverride ? [] : frameSnapshots
  const blocks = groupBlocks(scene)

  const [axesHeight, setAxesHeight] = useState(() => clampAxesHeight(defaultViewportHeight()))
  useEffect(() => {
    function onResize(): void {
      setAxesHeight(clampAxesHeight(window.innerHeight))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Board auto-follow (see file header). `canvasRef` locates `.board-wrap`
  // (this component's scrollable ancestor in App.tsx, absent in Gallery.tsx's
  // reuse of Board — `closest` returning null there is the correct no-op).
  // `lastBlockRef` is (re)attached to whichever block is currently last via
  // each block's own `blockRef` prop below.
  //
  // `lastManualScrollAt` records every scroll event unconditionally,
  // including ones our own `scrollIntoView` call below causes — no attempt
  // is made to distinguish "our" scrolls from the reader's: `block:
  // 'nearest'` always lands the newest block at (or right at the edge of)
  // the bottom, so the very next `isNearBottom` check reads true regardless
  // of this timestamp anyway (shouldAutoFollow's first, short-circuiting
  // check). The timestamp only ever matters while genuinely scrolled away,
  // which is exactly the case a real manual scroll produces.
  const canvasRef = useRef<HTMLDivElement>(null)
  const lastBlockRef = useRef<HTMLDivElement | null>(null)
  const lastManualScrollAt = useRef<number | null>(null)

  useEffect(() => {
    // A sceneOverride render (Gallery previews, frames-strip previews) is an
    // isolated snapshot, not the live board — it must never hijack the real
    // Board's scroll position even though it may share the same `.board-wrap`
    // ancestor (frames-strip previews are nested inside the live board).
    if (sceneOverride) return
    const wrap = canvasRef.current?.closest('.board-wrap')
    if (!wrap) return
    function onScroll(): void {
      lastManualScrollAt.current = Date.now()
    }
    wrap.addEventListener('scroll', onScroll)
    return () => wrap.removeEventListener('scroll', onScroll)
  }, [sceneOverride])

  useEffect(() => {
    if (sceneOverride) return
    const wrap = canvasRef.current?.closest('.board-wrap')
    const last = lastBlockRef.current
    if (!wrap || !last || typeof last.scrollIntoView !== 'function') return
    const metrics = { scrollTop: wrap.scrollTop, scrollHeight: wrap.scrollHeight, clientHeight: wrap.clientHeight }
    const msSinceManualScroll = lastManualScrollAt.current === null ? null : Date.now() - lastManualScrollAt.current
    if (!shouldAutoFollow(metrics, msSinceManualScroll)) return
    last.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    // Deliberately keyed on historyLength alone — re-run only when something
    // new actually committed, not on every unrelated Board re-render.
  }, [historyLength])

  // Quiet, designed empty state before the first action commits (real session
  // only — Gallery/preview always passes a populated `sceneOverride`).
  const showEmpty = blocks.length === 0 && !sceneOverride

  return (
    <div className="board-canvas" ref={canvasRef} onClick={() => setSelection(null)}>
      {showEmpty && (
        <div className="board-empty">
          <div className="board-empty-mark" aria-hidden="true" />
          <div className="board-empty-title">The board is clear</div>
          <div className="board-empty-sub">Pick a lesson and the tutor will start drawing here.</div>
        </div>
      )}
      <AnimatePresence>
        {blocks.map((b, i) => {
          const blockRef = i === blocks.length - 1 ? (node: HTMLDivElement | null) => (lastBlockRef.current = node) : undefined
          const blockElIds = b.kind === 'axes' ? [b.axes.id, ...b.elements.map((e) => e.id)] : [b.el.id]
          const snapshots = snapshotsForBlocks.filter((s) => blockElIds.includes(s.elId))
          return b.kind === 'axes' ? (
            <AxesBlock
              key={b.key}
              axes={b.axes}
              elements={b.elements}
              scene={scene}
              height={axesHeight}
              blockRef={blockRef}
              snapshots={snapshots}
            />
          ) : (
            <StandaloneBlock
              key={b.key}
              el={b.el}
              scene={scene}
              orphaned={b.orphaned}
              blockRef={blockRef}
              snapshots={snapshots}
            />
          )
        })}
      </AnimatePresence>
    </div>
  )
}
