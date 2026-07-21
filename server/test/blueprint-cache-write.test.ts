import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { getBlueprint, type Blueprint } from '../src/blueprint'

// ---------------------------------------------------------------------------
// Vercel's function filesystem is read-only outside /tmp, so writeCache()'s
// fs.mkdir/fs.writeFile calls will fail on every deployed request. This must
// never fail the request itself — getBlueprint() should still return the
// freshly generated, already-validated blueprint. See blueprint.ts's
// writeCache() try/catch + console.warn.
// ---------------------------------------------------------------------------

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
    },
  ],
} as Blueprint

function fakeParseClient(blueprint: Blueprint) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'tool_use', name: 'emit_blueprint', input: blueprint }],
      }),
    },
  } as unknown as Anthropic
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blueprint-writecache-test-'))
  process.env.BLUEPRINT_DIR = tmpDir
})

afterEach(async () => {
  delete process.env.BLUEPRINT_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('writeCache failure is non-fatal', () => {
  it('getBlueprint still returns the blueprint when fs.writeFile rejects (simulated read-only fs)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const writeSpy = vi
      .spyOn(fs, 'writeFile')
      .mockRejectedValue(new Error('EROFS: read-only file system, open'))

    const client = fakeParseClient(GOOD_BLUEPRINT)
    const result = await getBlueprint(client, 'writecache-fail-topic')

    expect(result).toEqual(GOOD_BLUEPRINT)
    expect(warnSpy).toHaveBeenCalled()
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/cache write failed/)

    writeSpy.mockRestore()
    // No cache file should exist — the write genuinely failed, it was just swallowed.
    const cacheFiles = await fs.readdir(tmpDir)
    expect(cacheFiles).toEqual([])
  })

  it('getBlueprint still returns the blueprint when fs.mkdir rejects too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(fs, 'mkdir').mockRejectedValue(new Error('EROFS: read-only file system, mkdir'))

    const client = fakeParseClient(GOOD_BLUEPRINT)
    const result = await getBlueprint(client, 'writecache-fail-topic-2')

    expect(result).toEqual(GOOD_BLUEPRINT)
  })
})
