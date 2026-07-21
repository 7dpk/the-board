import { describe, it, expect } from 'vitest'
import { createActionExtractor } from '../src/stream'

// Canonical plan: same projectile beat used by shared/test/protocol.test.ts
const canonicalActions = [
  { op: 'step', title: 'Launch' },
  { op: 'add', c: 'projectile', id: 'p1', v0: 20, deg: 45 },
  { op: 'say', text: 'Watch the ball fly.', sync: 'p1' },
  { op: 'anim', id: 'p1', k: 't', to: 1, dur: 3 },
  { op: 'ctl', id: 'p1', k: 'deg', kind: 'slider', min: 15, max: 75 },
]

function run(json: string, chunks: string[]) {
  const received: unknown[] = []
  const extractor = createActionExtractor((raw) => received.push(raw))
  for (const chunk of chunks) extractor.push(chunk)
  const result = extractor.end()
  return { received, result }
}

// Splits `s` into single characters — the most brutal chunk boundary.
function charChunks(s: string): string[] {
  return Array.from(s)
}

// Splits `s` so every `{` / `}` is delivered as its own isolated chunk,
// forcing depth transitions to land exactly at a chunk boundary.
function braceChunks(s: string): string[] {
  const chunks: string[] = []
  let cur = ''
  for (const ch of s) {
    if (ch === '{' || ch === '}') {
      if (cur) chunks.push(cur)
      cur = ''
      chunks.push(ch)
    } else {
      cur += ch
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}

describe('createActionExtractor', () => {
  it('(a) emits every action from the canonical plan, fed one char at a time', () => {
    const json = JSON.stringify({ actions: canonicalActions })
    const { received, result } = run(json, charChunks(json))
    expect(received).toEqual(canonicalActions)
    expect(result.trailingGarbage).toBe(false)
  })

  it('(b) survives a chunk split mid-escape (right between \\ and ")', () => {
    const actions = [{ op: 'say', text: 'She said "hi" to the ball.' }]
    const json = JSON.stringify({ actions })
    const escIdx = json.indexOf('\\"')
    expect(escIdx).toBeGreaterThan(-1)
    const splitAt = escIdx + 1 // split right after the backslash, before the quote
    const chunks = [json.slice(0, splitAt), json.slice(splitAt)]
    const { received, result } = run(json, chunks)
    expect(received).toEqual(actions)
    expect(result.trailingGarbage).toBe(false)
  })

  it('(c) survives chunk splits landing exactly on a `{`', () => {
    const json = JSON.stringify({ actions: canonicalActions })
    const { received, result } = run(json, braceChunks(json))
    expect(received).toEqual(canonicalActions)
    expect(result.trailingGarbage).toBe(false)
  })

  it('(d) truncated stream emits the completed prefix and end() reports trailingGarbage', () => {
    const json = JSON.stringify({ actions: canonicalActions })
    const thirdActionStart = json.indexOf('{"op":"say"')
    expect(thirdActionStart).toBeGreaterThan(-1)
    const cutAt = thirdActionStart + 15 // inside the 3rd action, before its closing brace
    const prefix = json.slice(0, cutAt)
    const { received, result } = run(json, [prefix])
    expect(received).toEqual(canonicalActions.slice(0, 2))
    expect(result.trailingGarbage).toBe(true)
  })

  it('(e) nested objects/arrays inside an action (fbd forces) do not confuse depth tracking', () => {
    const actions = [
      {
        op: 'add', c: 'fbd', id: 'fb1', label: 'Block',
        forces: [
          { name: 'gravity', deg: 270, mag: 50 },
          { name: 'normal', deg: 90, mag: 50 },
        ],
      },
      { op: 'step', title: 'Next' },
    ]
    const json = JSON.stringify({ actions })
    const { received, result } = run(json, charChunks(json))
    expect(received).toEqual(actions)
    expect(result.trailingGarbage).toBe(false)
  })

  it('(f) strings containing `{`/`}` do not confuse depth tracking', () => {
    const actions = [
      { op: 'say', text: 'Use {curly} braces like this: {a:1, b:{c:2}}' },
      { op: 'step', title: 'Continue' },
    ]
    const json = JSON.stringify({ actions })
    const { received, result } = run(json, charChunks(json))
    expect(received).toEqual(actions)
    expect(result.trailingGarbage).toBe(false)
  })

  it('emits each action incrementally without waiting for the array/envelope to close', () => {
    const json = JSON.stringify({ actions: canonicalActions })
    const received: unknown[] = []
    const extractor = createActionExtractor((raw) => received.push(raw))
    // Feed everything except the final `]}` — actions must already be out.
    extractor.push(json.slice(0, -2))
    expect(received).toEqual(canonicalActions)
  })

  it('skips a malformed action slice silently and keeps processing later actions', () => {
    // Hand-crafted stream: a broken object at depth 2 followed by a valid one.
    // `{bad json}` is not valid JSON, so JSON.parse must fail and be swallowed.
    const stream = '{"actions":[{bad json}' + ',' + JSON.stringify(canonicalActions[0]) + ']}'
    const received: unknown[] = []
    const extractor = createActionExtractor((raw) => received.push(raw))
    extractor.push(stream)
    const result = extractor.end()
    expect(received).toEqual([canonicalActions[0]])
    expect(result.trailingGarbage).toBe(false)
  })

  it('propagates onAction errors and still skips malformed JSON silently', () => {
    // Stream with malformed JSON followed by valid action
    const stream = '{"actions":[{bad json}' + ',' + JSON.stringify({ op: 'say', text: 'Hi' }) + ']}'
    const received: unknown[] = []
    const extractor = createActionExtractor((raw) => {
      received.push(raw)
      // Throw on the second (valid) action
      if (received.length === 1) {
        throw new Error('onAction error')
      }
    })

    // The malformed JSON is silently skipped, the valid action triggers onAction which throws
    expect(() => {
      extractor.push(stream)
    }).toThrow('onAction error')

    // Only the second action should have been received (and then errored)
    expect(received).toEqual([{ op: 'say', text: 'Hi' }])
  })
})
