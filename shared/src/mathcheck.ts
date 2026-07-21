import { create, all, derivative } from 'mathjs'
import type { Action } from './protocol/actions'

// A single mathjs instance used for all trusted parsing/compiling in this
// file. Note: we deliberately do NOT override/disable import, createUnit,
// evaluate, or parse on this instance the way mathjs's own "secure sandbox"
// docs suggest — doing so replaces those methods everywhere on the instance,
// including our own trusted `math.parse(...)` calls below. Instead, the
// "restricted eval scope" the brief calls for is achieved by construction:
// the scope object handed to `.evaluate()` is exactly `EVAL_SCOPE` (never
// import/createUnit/evaluate/parse), and the AST allowlist below rejects any
// FunctionNode/SymbolNode whose name isn't one of the whitelisted builtins or
// MATH_FNS/deriv keys — so those functions can never be reached from `{{...}}`
// text even though they still exist on `math` itself.
// `all` is destructured from a `Record<string, FactoryFunctionMap>` in
// mathjs's own type declarations, so under this project's
// `noUncheckedIndexedAccess` it types as `FactoryFunctionMap | undefined`
// even though it is always defined at runtime — hence the assertion.
const math = create(all!)

// ---------------------------------------------------------------------------
// MATH_FNS — deterministic "fact" functions. The tutor LLM must never write a
// computed number itself; instead it writes {{root1(1,0,-4)}} and the server
// evaluates it here so the board only ever shows verified math.
// ---------------------------------------------------------------------------

const toRad = (deg: number): number => (deg * Math.PI) / 180

export const MATH_FNS: Record<string, (...a: number[]) => number> = {
  disc: (a, b, c) => b * b - 4 * a * c,

  root1: (a, b, c) => {
    const d = b * b - 4 * a * c
    if (a === 0 || d < 0) return NaN
    return (-b - Math.sqrt(d)) / (2 * a)
  },

  root2: (a, b, c) => {
    const d = b * b - 4 * a * c
    if (a === 0 || d < 0) return NaN
    return (-b + Math.sqrt(d)) / (2 * a)
  },

  vertexX: (a, b) => (a === 0 ? NaN : -b / (2 * a)),

  vertexY: (a, b, c) => {
    if (a === 0) return NaN
    const x = -b / (2 * a)
    return a * x * x + b * x + c
  },

  // v0^2 * sin(2*theta) / g
  projRange: (v0, deg, g = 9.8) => (v0 * v0 * Math.sin(2 * toRad(deg))) / g,

  // v0^2 * sin(theta)^2 / (2*g)
  projApex: (v0, deg, g = 9.8) => (v0 * v0 * Math.sin(toRad(deg)) ** 2) / (2 * g),

  // 2 * v0 * sin(theta) / g
  projTime: (v0, deg, g = 9.8) => (2 * v0 * Math.sin(toRad(deg))) / g,

  // 2*pi*sqrt(L/g)
  pendPeriod: (L, g = 9.8) => 2 * Math.PI * Math.sqrt(L / g),

  // task-pd: JEE physics pack — verified narration facts for orbit/spring/
  // wave/ray so the tutor never writes a computed number by hand for these
  // domains either.

  // SHM mass-spring period: 2*pi*sqrt(m/k)
  springPeriod: (m, k) => 2 * Math.PI * Math.sqrt(m / k),

  // wave speed: f * lambda
  waveSpeed: (f, lambda) => f * lambda,

  // thin-lens/mirror image distance (real-positive convention): 1/(1/f - 1/u).
  // NaN-guarded at u === f (object at the focal point -> image at infinity).
  lensImage: (f, u) => {
    if (u === f) return NaN
    return 1 / (1 / f - 1 / u)
  },

  // Kepler's third law: t2 = t1 * (a2/a1)^1.5
  kepler3: (a1, t1, a2) => t1 * Math.pow(a2 / a1, 1.5),
}

// ---------------------------------------------------------------------------
// deriv — trusted derivative helper. Reachable both directly from trusted
// server code (e.g. to verify a tangent-line slope) AND from inside {{...}}
// templates as `deriv("<x-expression>", at)` — tutor narration like
// "the slope is {{deriv(\"x^2\",3)}}" must evaluate to 6. The latter path is
// gated tightly by isSafeNode below: 'deriv' is in SAFE_FN_NAMES so its
// FunctionNode is reachable, but its first argument must be a string
// ConstantNode whose *contents* independently parse and pass isSafeNode as a
// plain derivative expression (symbols x/pi/e only, allowlisted functions,
// no nested deriv) — see isSafeDerivExprString. Any other string constant
// appearing anywhere in a template is unsafe.
// ---------------------------------------------------------------------------

export function deriv(expr: string, at: number): number {
  try {
    const value: unknown = derivative(expr, 'x').compile().evaluate({ x: at })
    return typeof value === 'number' ? value : NaN
  } catch {
    return NaN
  }
}

// The scope handed to `.evaluate()` for `{{...}}` content: MATH_FNS plus
// `deriv` itself, so a template-level `deriv(...)` call can actually run.
const EVAL_SCOPE: Record<string, unknown> = { ...MATH_FNS, deriv }

// ---------------------------------------------------------------------------
// AST allowlist. Task 4 (parallel worktree) owns `expr.ts` with the canonical
// version of this walk for compileExpr/isSafeExpr; that file does not exist
// yet in this worktree, so this is a local, private copy scoped to
// evalTemplate's `{{...}}` content. TODO(post-merge cleanup): dedupe this
// walker with shared/src/expr.ts once Task 4 lands, so the allowlist lives in
// exactly one place.
// ---------------------------------------------------------------------------

const SAFE_FN_NAMES = new Set<string>([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sqrt', 'abs', 'log', 'log10',
  'exp', 'min', 'max', 'floor', 'ceil', 'round', 'pow', 'deriv',
  ...Object.keys(MATH_FNS),
])

const SAFE_SYMBOL_NAMES = new Set<string>(['pi', 'e', ...Object.keys(MATH_FNS)])

// Symbols allowed inside the derivative-expression STRING passed as the
// first argument to deriv(...) — that string is compiled and evaluated by
// mathjs's own `derivative(expr, 'x').compile().evaluate({ x: at })`
// against just the bound variable `x`, so only x/pi/e may appear there.
const SAFE_DERIV_EXPR_SYMBOL_NAMES = new Set<string>(['x', 'pi', 'e'])

interface AstNode {
  type: string
  args?: AstNode[]
  content?: AstNode
  name?: string
  value?: unknown
}

// `context: 'derivExpr'` marks that we're walking the AST parsed out of a
// deriv(...) string argument rather than top-level {{...}} template text.
// It tightens the SymbolNode allowlist to x/pi/e and forbids deriv-in-deriv.
type SafeNodeContext = 'template' | 'derivExpr'

function isSafeNode(node: AstNode, context: SafeNodeContext = 'template'): boolean {
  switch (node.type) {
    case 'ConstantNode':
      // Numeric/boolean constants are always safe. A STRING constant is
      // unsafe on its own — the only place one may appear is as the first
      // argument of deriv(...), which is validated explicitly in the
      // FunctionNode case below (via isSafeDerivExprString) and never
      // recurses back into this branch for that argument.
      return typeof node.value !== 'string'
    case 'ParenthesisNode':
      return node.content ? isSafeNode(node.content, context) : false
    case 'OperatorNode':
      return (node.args ?? []).every((n) => isSafeNode(n, context))
    case 'FunctionNode': {
      if (!node.name || !SAFE_FN_NAMES.has(node.name)) return false
      const args = node.args ?? []
      if (node.name === 'deriv') {
        // Reject deriv-in-deriv to keep string validation simple: a
        // derivative-expression string is parsed fresh as a plain
        // x-expression, so `deriv` never legally appears inside one.
        if (context === 'derivExpr') return false
        const exprArg = args[0]
        const atArg = args[1]
        return (
          !!exprArg &&
          exprArg.type === 'ConstantNode' &&
          typeof exprArg.value === 'string' &&
          isSafeDerivExprString(exprArg.value) &&
          (!atArg || isSafeNode(atArg, context))
        )
      }
      return args.every((n) => isSafeNode(n, context))
    }
    case 'SymbolNode': {
      if (!node.name) return false
      const allowlist = context === 'derivExpr' ? SAFE_DERIV_EXPR_SYMBOL_NAMES : SAFE_SYMBOL_NAMES
      return allowlist.has(node.name)
    }
    default:
      // Rejects AssignmentNode, AccessorNode, BlockNode, FunctionAssignmentNode,
      // ObjectNode, ArrayNode, IndexNode, ConditionalNode, RangeNode, etc.
      return false
  }
}

// Validates the string passed as deriv(...)'s first argument: it must
// itself parse with math.parse and pass isSafeNode as a plain x/pi/e-only
// expression (allowlisted functions, no nested deriv).
function isSafeDerivExprString(exprString: string): boolean {
  try {
    const node = math.parse(exprString)
    return isSafeNode(node as unknown as AstNode, 'derivExpr')
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// formatNum
// ---------------------------------------------------------------------------

export function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '?'
  let s = n.toFixed(3)
  if (s.includes('.')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '')
  }
  return s === '-0' ? '0' : s
}

// ---------------------------------------------------------------------------
// evalTemplate
// ---------------------------------------------------------------------------

const TEMPLATE_RE = /\{\{(.+?)\}\}/g

export function evalTemplate(text: string): { text: string; errors: string[] } {
  const errors: string[] = []

  const out = text.replace(TEMPLATE_RE, (_match, expr: string) => {
    try {
      const node = math.parse(expr)
      if (!isSafeNode(node as unknown as AstNode)) {
        throw new Error(`unsafe expression: ${expr}`)
      }
      const value: unknown = node.compile().evaluate(EVAL_SCOPE)
      if (typeof value !== 'number') {
        throw new Error(`non-numeric result: ${expr}`)
      }
      return formatNum(value)
    } catch (err) {
      errors.push(`bad math expression "${expr}": ${(err as Error).message}`)
      return '?'
    }
  })

  return { text: out, errors }
}

// ---------------------------------------------------------------------------
// verifyActions
// ---------------------------------------------------------------------------

export function verifyActions(actions: Action[]): { actions: Action[]; errors: string[] } {
  const errors: string[] = []

  const run = (s: string): string => {
    const { text, errors: e } = evalTemplate(s)
    errors.push(...e)
    return text
  }

  const out = actions.map((action): Action => {
    if (action.op === 'say') {
      return { ...action, text: run(action.text) }
    }
    if (action.op === 'ask') {
      // ask.answer must be templated too: a templated answer like
      // {{root1(1,-3,-4)}} has to be rewritten to the same computed value the
      // options are rewritten to, or grading (normalize(value) ===
      // normalize(answer)) can never match a correct student pick.
      const rewritten = { ...action, text: run(action.text) }
      if (action.options) rewritten.options = action.options.map(run)
      if (action.answer !== undefined) rewritten.answer = run(action.answer)
      return rewritten
    }
    if (action.op === 'add' && action.c === 'label') {
      return { ...action, tex: run(action.tex) }
    }
    // task-pa: steps is a worked derivation — every line (and its optional
    // justification note) is exactly the kind of LLM-authored, potentially
    // computed-number-bearing text the {{...}} discipline exists for, same
    // as label.tex above.
    if (action.op === 'add' && action.c === 'steps') {
      const lines = action.lines.map(run)
      const notes = action.notes ? action.notes.map(run) : action.notes
      return { ...action, lines, notes }
    }
    // set targeting a text-bearing key (tex/label) carries a string value that
    // may itself contain a {{...}} template — evaluate it the same way add.label
    // is evaluated above.
    if (action.op === 'set' && (action.k === 'tex' || action.k === 'label') && typeof action.v === 'string') {
      return { ...action, v: run(action.v) }
    }
    return action
  })

  return { actions: out, errors }
}
