import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

// ---------------------------------------------------------------------------
// component-wishes.jsonl — the self-improvement "wish" loop's append-only
// log. When the tutor LLM emits a `wish` action (no component fits the
// concept it's teaching), routes.ts intercepts it before the SSE stream and
// logs it here instead of showing it to the student, for a human to later
// review and decide whether to build the component.
//
// COMPONENT_WISHES_PATH overrides the file path (tests point it at a
// throwaway temp file so they never touch the real
// server/data/component-wishes.jsonl checked-out-of-git path). Read at call
// time, not module load, so it can vary per test without a module reset —
// mirrors BLUEPRINT_DIR in blueprint.ts.
// ---------------------------------------------------------------------------

const DEFAULT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'component-wishes.jsonl',
)

export function wishLogPath(): string {
  return process.env.COMPONENT_WISHES_PATH ?? DEFAULT_PATH
}

export type ComponentWish = { ts: string; topic: string; component: string; why: string }

// Appends one JSON line. Creates the containing directory (and the file, via
// appendFileSync) lazily on first use rather than requiring it to exist.
// Must not throw: wish logging happens in SSE streaming context and any exception
// would kill the connection. On error, silently log a warning and return.
export function logComponentWish(topic: string, component: string, why: string): void {
  try {
    const filePath = wishLogPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const entry: ComponentWish = { ts: new Date().toISOString(), topic, component, why }
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('wish log write failed:', message)
  }
}
