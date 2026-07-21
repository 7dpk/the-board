import { parse } from 'mathjs'

// ---------------------------------------------------------------------------
// Expression safety — mathjs AST allowlist.
//
// LLM-authored `expr` strings (plot/area/tangent, and `set` where k==='expr')
// are compiled and evaluated by the client. Since mathjs expressions can call
// through to arbitrary registered functions (e.g. `import`, `createUnit`) or
// assign into scope, every expression must be walked and validated against an
// allowlist before it is trusted to compile or evaluate.
// ---------------------------------------------------------------------------

const ALLOWED_FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sqrt', 'abs', 'log', 'log10',
  'exp', 'min', 'max', 'floor', 'ceil', 'round', 'pow',
])

const ALLOWED_SYMBOLS = new Set(['x', 'pi', 'e'])

const FORBIDDEN_NODE_TYPES = new Set([
  'AssignmentNode', 'AccessorNode', 'BlockNode', 'FunctionAssignmentNode',
])

// A minimal structural view of the mathjs AST nodes this walk cares about —
// avoids depending on mathjs's internal (non-exported) node classes.
interface AstNode {
  type: string
  name?: string
  fn?: { name: string }
  traverse(callback: (node: AstNode, path: string, parent: AstNode | null) => void): void
  compile(): { evaluate(scope: Record<string, unknown>): unknown }
}

function isSafeAst(root: AstNode): boolean {
  let safe = true
  root.traverse((node, path) => {
    if (!safe) return
    if (FORBIDDEN_NODE_TYPES.has(node.type)) {
      safe = false
      return
    }
    if (node.type === 'FunctionNode') {
      if (!node.fn || !ALLOWED_FUNCTIONS.has(node.fn.name)) safe = false
    } else if (node.type === 'SymbolNode' && path !== 'fn') {
      // `path === 'fn'` is the function-name symbol of a parent FunctionNode
      // (e.g. `sin` in `sin(x)`), already validated above via node.fn.name —
      // it is not itself a variable reference and must not be checked against
      // ALLOWED_SYMBOLS.
      if (!node.name || !ALLOWED_SYMBOLS.has(node.name)) safe = false
    }
  })
  return safe
}

function parseSafe(expr: string): AstNode | null {
  try {
    const node = parse(expr) as unknown as AstNode
    return isSafeAst(node) ? node : null
  } catch {
    return null
  }
}

export function isSafeExpr(expr: string): boolean {
  return parseSafe(expr) !== null
}

export function compileExpr(expr: string): ((x: number) => number) | null {
  const node = parseSafe(expr)
  if (!node) return null
  let compiled: { evaluate(scope: Record<string, unknown>): unknown }
  try {
    compiled = node.compile()
  } catch {
    return null
  }
  return (x: number): number => {
    try {
      const result = compiled.evaluate({ x })
      return typeof result === 'number' ? result : NaN
    } catch {
      return NaN
    }
  }
}
