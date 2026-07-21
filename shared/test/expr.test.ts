import { describe, it, expect } from 'vitest'
import { compileExpr, isSafeExpr } from '../src/expr'

describe('isSafeExpr', () => {
  it('accepts allowlisted functions composed with the x symbol', () => {
    expect(isSafeExpr('sin(x)*x^2')).toBe(true)
    expect(isSafeExpr('sqrt(abs(x)) + log(x) - exp(x)')).toBe(true)
    expect(isSafeExpr('min(x, max(x, 2)) + pow(x, 3)')).toBe(true)
  })

  it('accepts the pi and e constant symbols alongside x', () => {
    expect(isSafeExpr('pi * x')).toBe(true)
    expect(isSafeExpr('e ^ x')).toBe(true)
  })

  it('rejects calls to non-allowlisted functions (sandbox escape attempts)', () => {
    expect(isSafeExpr("import('fs')")).toBe(false)
    expect(isSafeExpr("system('rm')")).toBe(false)
    expect(isSafeExpr('eval(x)')).toBe(false)
  })

  it('rejects symbols other than x, pi, e', () => {
    expect(isSafeExpr('y + 1')).toBe(false)
    expect(isSafeExpr('x + z')).toBe(false)
  })

  it('rejects assignment, accessor, block, and function-definition nodes', () => {
    expect(isSafeExpr('x = 5')).toBe(false)
    expect(isSafeExpr('x.y')).toBe(false)
    expect(isSafeExpr('x; x')).toBe(false)
    expect(isSafeExpr('f(x) = x^2')).toBe(false)
  })

  it('rejects malformed expressions instead of throwing', () => {
    expect(() => isSafeExpr('sin(x')).not.toThrow()
    expect(isSafeExpr('sin(x')).toBe(false)
  })
})

describe('compileExpr', () => {
  it('compiles a safe expression into a callable (x: number) => number', () => {
    const f = compileExpr('sin(x) * x^2')
    expect(f).not.toBeNull()
    expect(f?.(2)).toBeCloseTo(Math.sin(2) * 4)
  })

  it('returns null for unsafe or invalid expressions', () => {
    expect(compileExpr("system('rm')")).toBeNull()
    expect(compileExpr('y + 1')).toBeNull()
    expect(compileExpr('sin(x')).toBeNull()
  })

  it('evaluate failures at runtime return NaN instead of throwing', () => {
    const f = compileExpr('x')
    expect(f).not.toBeNull()
    // evaluating with a non-numeric-coercible input should not throw
    expect(() => f?.(Number('not-a-number'))).not.toThrow()
    expect(Number.isNaN(f?.(Number('not-a-number')))).toBe(true)
  })
})
