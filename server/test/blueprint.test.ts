import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { getBlueprint, slugify, BlueprintSchema, validateBlueprint, type Blueprint } from '../src/blueprint'
import { createApp } from '../src/routes'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A schema-valid, math-correct, sequentially-coherent blueprint: beat 1's
// skeleton references ids (`ax1`, `p1`) added by beat 0 -- this is only valid
// because validateBlueprint replays skeletons in beat order, threading the
// accumulated scene forward (per-beat-in-isolation replay would reject this).
const GOOD_BLUEPRINT: Blueprint = {
  title: 'Parabolas 101',
  prerequisites: [
    {
      id: 'q1',
      question: 'What is a variable?',
      options: ['a symbol standing for a number', 'a type of equation'],
      answer: 'a symbol standing for a number',
      remediation: 'A variable is a placeholder symbol (like x) that stands for a number.',
    },
    {
      id: 'q2',
      question: 'What does squaring a number mean?',
      options: ['multiplying it by itself', 'adding it to itself'],
      answer: 'multiplying it by itself',
      remediation: 'Squaring x means computing x * x.',
    },
  ],
  beats: [
    {
      title: 'Intro to parabolas',
      goal: 'see the U shape',
      skeleton: [
        { op: 'step', title: 'Intro' },
        { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
        { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2' },
        { op: 'say', text: 'This is a parabola opening upward.', sync: 'p1' },
      ],
      check: { text: 'Which way does x^2 open?', options: ['up', 'down'], answer: 'up' },
    },
    {
      title: 'Vertex',
      goal: 'find the vertex',
      skeleton: [
        { op: 'step', title: 'Vertex' },
        { op: 'focus', ids: ['p1'], style: 'highlight' },
        { op: 'say', text: 'The vertex sits at ({{vertexX(1,0,0)}}, {{vertexY(1,0,0)}}).' },
      ],
      // no check -> beat auto-advances
    },
  ],
} as Blueprint

// Same shape as GOOD_BLUEPRINT but beat 0's skeleton references an id
// ('ghost') that was never added -- sanitizeAction rejects it as an unknown
// id reference, so validateBlueprint should surface exactly this problem.
const BAD_BLUEPRINT: Blueprint = {
  ...GOOD_BLUEPRINT,
  beats: [
    {
      ...GOOD_BLUEPRINT.beats[0]!,
      skeleton: [
        { op: 'step', title: 'Intro' },
        { op: 'set', id: 'ghost', k: 'color', v: 'red' },
        { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
        { op: 'add', c: 'plot', id: 'p1', on: 'ax1', expr: 'x^2' },
      ],
    },
    GOOD_BLUEPRINT.beats[1]!,
  ],
} as Blueprint

// ---------------------------------------------------------------------------
// Fake Anthropic client: a queue of `create()` responses (forced-tool
// pattern — a tool_use block named 'emit_blueprint', or no tool_use block at
// all for the null-parsed_output case), call-counted.
// ---------------------------------------------------------------------------

function fakeParseClient(responses: Array<Blueprint | null>) {
  let calls = 0
  const client = {
    messages: {
      create: async () => {
        const blueprint = responses[Math.min(calls, responses.length - 1)] ?? null
        calls++
        return {
          content: blueprint ? [{ type: 'tool_use', name: 'emit_blueprint', input: blueprint }] : [],
        }
      },
    },
  } as unknown as Anthropic
  return { client, callCount: () => calls }
}

function throwingClient(message = 'should not be called') {
  return {
    messages: {
      create: async () => {
        throw new Error(message)
      },
    },
  } as unknown as Anthropic
}

// ---------------------------------------------------------------------------
// Temp BLUEPRINT_DIR per test
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blueprint-test-'))
  process.env.BLUEPRINT_DIR = tmpDir
})

afterEach(async () => {
  delete process.env.BLUEPRINT_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('lowercases, replaces non-alnum runs with a single -, and trims', () => {
    expect(slugify('Projectile Motion!!')).toBe('projectile-motion')
    expect(slugify('  Leading/Trailing  ')).toBe('leading-trailing')
  })

  it('caps at 60 chars', () => {
    const long = 'a'.repeat(100)
    expect(slugify(long).length).toBeLessThanOrEqual(60)
  })
})

// ---------------------------------------------------------------------------
// validateBlueprint — templated check/prereq strings (finding #2)
// ---------------------------------------------------------------------------

describe('validateBlueprint: check/prerequisite template evaluation', () => {
  it('returns no errors for a blueprint whose checks/prereqs have no templates', () => {
    expect(validateBlueprint(GOOD_BLUEPRINT)).toEqual([])
  })

  it('flags a broken {{...}} template in a beat check (text/answer/options)', () => {
    const bp: Blueprint = {
      ...GOOD_BLUEPRINT,
      beats: [
        {
          ...GOOD_BLUEPRINT.beats[0]!,
          check: { text: 'What is {{nope(1,2)}}?', options: ['up', 'down'], answer: 'up' },
        },
        GOOD_BLUEPRINT.beats[1]!,
      ],
    } as Blueprint
    const errors = validateBlueprint(bp)
    expect(errors.some((e) => /check/.test(e) && /bad math expression/.test(e))).toBe(true)
  })

  it('flags a broken {{...}} template in a prerequisite (question/answer/options/remediation)', () => {
    const bp: Blueprint = {
      ...GOOD_BLUEPRINT,
      prerequisites: [
        { ...GOOD_BLUEPRINT.prerequisites[0]!, remediation: 'recall that {{bogus(9)}}' },
        GOOD_BLUEPRINT.prerequisites[1]!,
      ],
    } as Blueprint
    const errors = validateBlueprint(bp)
    expect(errors.some((e) => /prerequisite/.test(e) && /bad math expression/.test(e))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getBlueprint
// ---------------------------------------------------------------------------

describe('getBlueprint', () => {
  it('cache miss calls the model once, writes the cache file, and round-trips the schema', async () => {
    const { client, callCount } = fakeParseClient([GOOD_BLUEPRINT])

    const result = await getBlueprint(client, 'parabolas')

    expect(callCount()).toBe(1)
    expect(BlueprintSchema.safeParse(result).success).toBe(true)
    expect(result).toEqual(GOOD_BLUEPRINT)

    const cacheFile = path.join(tmpDir, `${slugify('parabolas')}.json`)
    const onDisk = JSON.parse(await fs.readFile(cacheFile, 'utf8'))
    expect(onDisk).toEqual(GOOD_BLUEPRINT)
  })

  it('a second call for the same topic hits disk and never calls the model again', async () => {
    const { client } = fakeParseClient([GOOD_BLUEPRINT])
    await getBlueprint(client, 'parabolas')

    const result2 = await getBlueprint(throwingClient('model should not be called on cache hit'), 'parabolas')
    expect(result2).toEqual(GOOD_BLUEPRINT)
  })

  it('an invalid skeleton (unknown id reference) triggers exactly one corrective retry, then succeeds', async () => {
    const { client, callCount } = fakeParseClient([BAD_BLUEPRINT, GOOD_BLUEPRINT])

    const result = await getBlueprint(client, 'parabolas')

    expect(callCount()).toBe(2)
    expect(result).toEqual(GOOD_BLUEPRINT)
  })

  it('parsed_output === null triggers the same one corrective retry, then succeeds', async () => {
    const { client, callCount } = fakeParseClient([null, GOOD_BLUEPRINT])

    const result = await getBlueprint(client, 'parabolas')

    expect(callCount()).toBe(2)
    expect(result).toEqual(GOOD_BLUEPRINT)
  })

  // task-19 nit (b): distinct from the `null` case above (no tool_use block
  // at all, i.e. `!toolUse`) — here a tool_use block for `emit_blueprint` IS
  // present, but its `input` is missing a schema-required field (`title`), so
  // `attempt()`'s `BlueprintSchema.safeParse(toolUse.input)` itself fails
  // (`!parsed.success`). Both branches happen to feed the same
  // 'model returned no parsed output' corrective message today, but they are
  // reached via different code paths in `attempt()` and deserve independent
  // coverage.
  it('a tool_use block whose input is missing a required field (safeParse failure, not a missing tool_use block) triggers the same one corrective retry, then succeeds', async () => {
    const { title: _droppedTitle, ...blueprintMissingTitle } = GOOD_BLUEPRINT
    const { client, callCount } = fakeParseClient([blueprintMissingTitle as unknown as Blueprint, GOOD_BLUEPRINT])

    const result = await getBlueprint(client, 'parabolas')

    expect(callCount()).toBe(2)
    expect(result).toEqual(GOOD_BLUEPRINT)
  })

  it('still invalid after the corrective retry -> throws, without a third call', async () => {
    const { client, callCount } = fakeParseClient([BAD_BLUEPRINT, BAD_BLUEPRINT])

    await expect(getBlueprint(client, 'parabolas')).rejects.toThrow()
    expect(callCount()).toBe(2)
  })

  it('still null after the corrective retry -> throws', async () => {
    const { client, callCount } = fakeParseClient([null, null])

    await expect(getBlueprint(client, 'parabolas')).rejects.toThrow()
    expect(callCount()).toBe(2)
  })

  it('parse throws on first call, succeeds on second -> triggers corrective retry and succeeds', async () => {
    let calls = 0
    const client = {
      messages: {
        create: async () => {
          calls++
          if (calls === 1) {
            throw new Error('schema validation failed')
          }
          return { content: [{ type: 'tool_use', name: 'emit_blueprint', input: GOOD_BLUEPRINT }] }
        },
      },
    } as unknown as Anthropic

    const result = await getBlueprint(client, 'parabolas')

    expect(calls).toBe(2)
    expect(result).toEqual(GOOD_BLUEPRINT)
  })
})

// ---------------------------------------------------------------------------
// routes.ts wiring (step 5): default blueprintProvider seam -> getBlueprint,
// and blueprint failures surface as a `warning` field alongside freeform.
// ---------------------------------------------------------------------------

describe('routes: blueprintProvider default wiring', () => {
  it('with no blueprintProvider override, POST /api/session calls getBlueprint and returns its beats', async () => {
    const { client } = fakeParseClient([GOOD_BLUEPRINT])
    const app = createApp({ client })

    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'parabolas' }),
    })
    const body = await res.json()

    expect(body.title).toBe('Parabolas 101')
    expect(body.beatTitles).toEqual(['Intro to parabolas', 'Vertex'])
    expect(body.prereqCount).toBe(2)
    expect(body.warning).toBeUndefined()
  })

  it('surfaces a `warning` field and falls back to freeform when blueprint generation fails', async () => {
    const app = createApp({ client: throwingClient('planner unavailable') })

    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'projectile motion' }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.title).toBe('projectile motion')
    expect(body.beatTitles).toEqual([])
    expect(body.prereqCount).toBe(0)
    expect(typeof body.warning).toBe('string')
    expect(body.warning.length).toBeGreaterThan(0)
  })
})
