import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { sanitizeAction, applyAction, verifyActions, emptyScene, type Action, type Scene } from '@board/shared'
import { BlueprintSchema, validateBlueprint } from '../src/blueprint'

// ---------------------------------------------------------------------------
// On-disk blueprint gate. Every committed blueprint under
// server/data/blueprints/ must clear the exact bar validateBlueprint enforces
// at generation time: BlueprintSchema parse + a sequential sanitizeAction
// replay per beat (scene threaded across beats) + verifyActions with zero math
// errors + templated prereq/check strings that evaluate cleanly. A hand-edit
// that breaks any of these fails here loudly instead of shipping a lesson the
// live board renderer would choke on.
// ---------------------------------------------------------------------------

const BLUEPRINT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'blueprints')

function blueprintFiles(): string[] {
  return fs
    .readdirSync(BLUEPRINT_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(BLUEPRINT_DIR, f))
}

describe('on-disk blueprints', () => {
  const files = blueprintFiles()

  it('the two flagship blueprints are present', () => {
    const names = files.map((f) => path.basename(f))
    expect(names).toContain('quadratic-functions.json')
    expect(names).toContain('projectile-motion.json')
  })

  it.each(files)('%s parses, sanitizes, and math-verifies cleanly', (file) => {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))

    // (1) schema
    const parsed = BlueprintSchema.safeParse(raw)
    expect(parsed.success, `${path.basename(file)} failed BlueprintSchema`).toBe(true)
    if (!parsed.success) return
    const bp = parsed.data

    // (2) sequential sanitize replay + (3) verifyActions per beat, scene
    // threaded across beats exactly as the session teaches them back-to-back.
    let scene: Scene = emptyScene
    for (const [i, beat] of bp.beats.entries()) {
      let beatScene = scene
      const sanitized: Action[] = []
      for (const rawAction of beat.skeleton) {
        const result = sanitizeAction(rawAction, beatScene)
        expect(
          result.ok,
          `${path.basename(file)} beat ${i} ("${beat.title}") sanitize: ${result.ok ? '' : result.reason}`,
        ).toBe(true)
        if (result.ok) {
          sanitized.push(result.action)
          beatScene = applyAction(beatScene, result.action)
        }
      }
      const { errors } = verifyActions(sanitized)
      expect(errors, `${path.basename(file)} beat ${i} ("${beat.title}") math errors`).toEqual([])
      scene = beatScene
    }

    // (4) full validateBlueprint (adds prereq/check template checks) == clean.
    expect(validateBlueprint(bp), `${path.basename(file)} validateBlueprint`).toEqual([])
  })
})
