import { useState } from 'react'
import {
  COMPONENT_SPECS,
  COMPONENT_TYPES,
  type Action,
  type Scene,
  applyAction,
  emptyScene,
} from '@board/shared'
import { useBoard } from './store'
import Board from './board/Board'

// Individual card renderer for a single component type
function ComponentCard({ componentType }: { componentType: Exclude<typeof COMPONENT_TYPES[number], 'axes'> }) {
  const spec = COMPONENT_SPECS[componentType]
  const [localScene, setLocalScene] = useState<Scene>(() => {
    const exampleAction = JSON.parse(spec.example) as Action
    return applyAction(emptyScene, exampleAction)
  })

  // Get controllable params for this component
  const controllable = spec.controllable
  // Components that animate over `t` but don't already list it in their own
  // `controllable` (some do — e.g. orbit's is ['e','a','t']) get a slider
  // added for it here so the gallery preview can scrub their animation too.
  // task-pe: spring/wave joined this list (JEE pack components whose `t` is
  // animatable but not controllable per their COMPONENT_SPECS entry, same
  // gap projectile/incline/pendulum already had).
  const animatesOverT = ['projectile', 'incline', 'pendulum', 'spring', 'wave'].includes(componentType)

  const controllableParams = animatesOverT ? [...controllable, 't'].filter((p, i, arr) => arr.indexOf(p) === i) : controllable

  const handleParamChange = (paramKey: string, value: number) => {
    setLocalScene((prev) => {
      const elId = prev.order[0]
      const el = elId ? prev.elements[elId] : undefined
      if (!el) return prev
      const clamps = COMPONENT_SPECS[componentType].clamps[paramKey]
      const clampedValue = clamps ? Math.max(clamps.min, Math.min(clamps.max, value)) : value
      return {
        ...prev,
        elements: {
          ...prev.elements,
          [el.id]: {
            ...el,
            params: {
              ...el.params,
              [paramKey]: clampedValue,
            },
          },
        },
      }
    })
  }

  const getParamRange = (paramKey: string): [number, number] => {
    const clamp = spec.clamps[paramKey]
    return clamp ? [clamp.min, clamp.max] : [0, 10]
  }

  const elId = localScene.order[0]
  const el = elId ? localScene.elements[elId] : undefined

  return (
    <div className="gallery-card">
      <div className="card-header">
        <h3>{componentType}</h3>
        <p className="card-doc">{spec.doc}</p>
      </div>
      <div className="card-content">
        <div className="card-renderer">
          <Board scene={localScene} />
        </div>
        <div className="card-code">
          <pre>{spec.example}</pre>
        </div>
      </div>
      {controllableParams.length > 0 && (
        <div className="card-controls">
          {controllableParams.map((paramKey) => {
            const [min, max] = getParamRange(paramKey)
            const step = (max - min) / 100
            const currentVal = (el?.params[paramKey] ?? 0) as number
            return (
              <label key={paramKey} className="gallery-slider">
                <span className="slider-label">{paramKey}</span>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={currentVal}
                  onChange={(e) => handleParamChange(paramKey, Number(e.currentTarget.value))}
                />
                <span className="slider-value">{currentVal.toFixed(2)}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Replay demo card that runs a hardcoded 8-action stream through the real timeline
function ReplayDemoCard() {
  const store = useBoard()
  const [isPlaying, setIsPlaying] = useState(false)

  const handleRunDemo = () => {
    setIsPlaying(true)
    // Reset first
    store.reset()
    store.pause()

    // Hardcoded 8-action stream
    const demoActions: Action[] = [
      { op: 'step', title: 'Setup' },
      { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
      { op: 'add', c: 'plot', id: 'pl1', on: 'ax1', expr: 'x^2 - 4', color: 'blue' },
      { op: 'say', text: 'This is a parabola.' },
      { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 0, y: -4, color: 'red' },
      { op: 'anim', id: 'pt1', k: 'x', to: 3, dur: 1000 },
      { op: 'ctl', id: 'pt1', k: 'x', kind: 'drag', min: -10, max: 10 },
      { op: 'focus', ids: ['pt1'], style: 'highlight' },
    ]

    demoActions.forEach((action) => {
      store.enqueue(action)
    })

    setTimeout(() => {
      store.play()
    }, 100)

    setTimeout(() => {
      setIsPlaying(false)
    }, 5000)
  }

  return (
    <div className="gallery-card replay-demo">
      <div className="card-header">
        <h3>Replay Demo</h3>
        <p className="card-doc">Shows an 8-action sequence animated through the timeline, proving offline capability.</p>
      </div>
      <div className="card-content">
        <div className="card-renderer">
          <Board />
        </div>
        <div className="card-code">
          <pre>
            {JSON.stringify(
              [
                { op: 'step', title: 'Setup' },
                { op: 'add', c: 'axes', id: 'ax1', xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
                { op: 'add', c: 'plot', id: 'pl1', on: 'ax1', expr: 'x^2 - 4' },
                '... 6 more actions ...',
              ],
              null,
              2,
            )}
          </pre>
        </div>
      </div>
      <div className="card-controls">
        <button onClick={handleRunDemo} disabled={isPlaying} className="replay-button">
          {isPlaying ? 'Playing...' : 'Run Sequence'}
        </button>
      </div>
    </div>
  )
}

// Main Gallery page
export default function Gallery() {
  return (
    <div className="gallery-page">
      <header className="gallery-header">
        <h1>Board Component Gallery</h1>
        {/* Component count derived from COMPONENT_TYPES rather than
            hardcoded (task-pe: was a stale "14" left over from before the
            steps + JEE physics pack — orbit/spring/wave/ray — landed). */}
        <p>Explore all {COMPONENT_TYPES.length - 1} components with interactive controls and offline replay demo</p>
      </header>

      <div className="gallery-grid">
        {/* Render all non-axes components */}
        {COMPONENT_TYPES.filter((c) => c !== 'axes').map((componentType) => (
          <ComponentCard key={componentType} componentType={componentType as Exclude<typeof COMPONENT_TYPES[number], 'axes'>} />
        ))}

        {/* Replay demo card */}
        <ReplayDemoCard />
      </div>
    </div>
  )
}
