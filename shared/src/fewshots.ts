import type { Action } from './protocol/actions'

// ---------------------------------------------------------------------------
// FEWSHOTS — worked examples embedded in the system prompt. Each `actions`
// list must (a) parse via RenderPlanSchema and (b) sanitize cleanly with
// sanitizeAction against a scene reduced with applyAction after each prior
// action — enforced by shared/test/prompt.test.ts. Keep these two examples
// hand-verified against COMPONENT_SPECS clamps/animatable/controllable so a
// future registry change fails the test loudly instead of drifting silently.
// ---------------------------------------------------------------------------

export interface FewShot {
  name: string
  user: string
  actions: Action[]
}

export const FEWSHOTS: FewShot[] = [
  {
    name: 'quadratic-intro',
    user: 'Teach me about the vertex of a parabola.',
    actions: [
      { op: 'step', title: 'Find the vertex' },
      { op: 'add', c: 'axes', id: 'ax1', xmin: -6, xmax: 6, ymin: -8, ymax: 6, xl: 'x', yl: 'y' },
      { op: 'add', c: 'plot', id: 'pl1', on: 'ax1', expr: 'x^2 - 2*x - 3', color: 'blue' },
      {
        op: 'say',
        text: 'This is y = x^2 - 2x - 3. Before I mark anything — where do you think its lowest point is?',
        sync: 'pl1',
      },
      { op: 'add', c: 'point', id: 'pt1', on: 'ax1', x: 1, y: -4, label: 'vertex', color: 'red' },
      { op: 'ctl', id: 'pt1', k: 'x', kind: 'drag' },
      {
        op: 'say',
        text: 'The vertex sits at x = {{vertexX(1,-2)}}. Drag the point along the curve — does the y-value ever go lower than that?',
        sync: 'pt1',
      },
    ],
  },
  {
    name: 'projectile-intro',
    user: 'Show me how launch angle affects range.',
    actions: [
      { op: 'step', title: 'Launch the projectile' },
      { op: 'add', c: 'projectile', id: 'pr1', v0: 20, deg: 45 },
      {
        op: 'say',
        text: "Watch this ball launch at 20 m/s and 45 degrees. Where do you think it'll land?",
        sync: 'pr1',
      },
      { op: 'anim', id: 'pr1', k: 't', to: 1, dur: 2 },
      { op: 'ctl', id: 'pr1', k: 'deg', kind: 'slider', min: 15, max: 75 },
      {
        op: 'say',
        text: 'At 45 degrees it landed {{projRange(20,45)}} meters out. Try the angle slider — is 45 degrees really the farthest?',
      },
    ],
  },
]
