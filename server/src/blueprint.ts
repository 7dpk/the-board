import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import {
  ActionSchema,
  sanitizeAction,
  applyAction,
  emptyScene,
  verifyActions,
  evalTemplate,
  buildSystemPrompt,
  type Action,
  type Scene,
} from '@board/shared'
import { PLANNER_MODEL, THINKING_DISABLED, BOARD_PROVIDER } from './models'

// ---------------------------------------------------------------------------
// BlueprintSchema — the lesson-level plan Sonnet generates once per topic:
// 2-3 prerequisite checks (the KST fringe just below the topic) plus 4-6
// teaching beats, each with a math-verified scene skeleton. Like the shared
// protocol schemas, this must stay free of zod min/max/length constraints —
// zodOutputFormat's structured-output JSON-schema translation can't express
// them (see shared/src/protocol/actions.ts for the precedent).
// ---------------------------------------------------------------------------

export const BlueprintSchema = z.strictObject({
  title: z.string(),
  prerequisites: z.array(
    z.strictObject({
      id: z.string(),
      question: z.string(),
      options: z.array(z.string()),
      answer: z.string(),
      remediation: z.string(),
    }),
  ),
  beats: z.array(
    z.strictObject({
      title: z.string(),
      goal: z.string(),
      skeleton: z.array(ActionSchema),
      check: z
        .strictObject({
          text: z.string(),
          options: z.array(z.string()).optional(),
          answer: z.string(),
        })
        .optional(),
    }),
  ),
})
export type Blueprint = z.infer<typeof BlueprintSchema>
export type Prerequisite = Blueprint['prerequisites'][number]
export type Beat = Blueprint['beats'][number]

// ---------------------------------------------------------------------------
// emitBlueprintTool — forced-tool pattern, single code path for both Claude
// and Anthropic-wire-compatible providers (e.g. DeepSeek). Replaces the old
// client.messages.parse + zodOutputFormat call: structured-outputs
// enforcement (output_config.format) is unverified against non-Anthropic
// providers, whereas a forced tool_choice + strict:true is empirically solid
// across both (see anthropic.ts's renderPlanTool for the same pattern).
// ---------------------------------------------------------------------------

const blueprintJsonSchema = z.toJSONSchema(BlueprintSchema) as { type: 'object' } & Record<string, unknown>

const emitBlueprintTool = {
  name: 'emit_blueprint',
  description: 'Emit the complete lesson blueprint.',
  strict: true,
  input_schema: blueprintJsonSchema,
} as const

// openai.ts-shape equivalent for the BOARD_PROVIDER=openai path: same forced
// function-call pattern (see openai.ts's renderPlanFunctionTool), same
// blueprintJsonSchema, non-streaming (blueprint generation is a single
// up-front planning call, never incrementally rendered to a student).
const emitBlueprintFunctionTool = {
  type: 'function' as const,
  function: {
    name: 'emit_blueprint',
    description: 'Emit the complete lesson blueprint.',
    parameters: blueprintJsonSchema,
    strict: true,
  },
}

// ---------------------------------------------------------------------------
// Disk cache — one JSON file per topic slug. BLUEPRINT_DIR overrides the
// directory (tests point it at a throwaway temp dir so they never touch the
// real server/data/blueprints/ checked into the repo).
// ---------------------------------------------------------------------------

// Two candidates:
//  - IMPORT_META_DIR: resolved relative to *this module's own file location*.
//    Correct for local dev/test (tsx runs server/src/blueprint.ts unbundled,
//    so import.meta.url really is .../server/src/blueprint.ts).
//  - CWD_RELATIVE_DIR: resolved relative to process.cwd(). On Vercel, the
//    function entry (api/index.ts, which imports this module transitively)
//    is bundled — esbuild inlines this file into one output, so
//    import.meta.url no longer points at server/src/ and the IMPORT_META_DIR
//    walk lands in the wrong place. Vercel sets process.cwd() to the project
//    root at runtime, and vercel.json's functions.includeFiles preserves the
//    repo-relative path server/data/blueprints/**, so CWD_RELATIVE_DIR is the
//    one that resolves correctly there.
// Pick whichever candidate actually exists on disk at module init (existence
// doesn't change over the process lifetime), falling back to the
// import.meta.url form so nothing regresses for dev/test if neither exists
// yet (e.g. a fresh checkout before any blueprint has been cached).
const IMPORT_META_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'blueprints')
const CWD_RELATIVE_DIR = path.join(process.cwd(), 'server', 'data', 'blueprints')
const DEFAULT_DIR = fsSync.existsSync(CWD_RELATIVE_DIR) ? CWD_RELATIVE_DIR : IMPORT_META_DIR

function blueprintDir(): string {
  return process.env.BLUEPRINT_DIR ?? DEFAULT_DIR
}

// lowercase, collapse any run of non-alphanumeric chars to a single '-',
// trim leading/trailing '-', cap at 60 chars (and re-trim in case the cap
// landed mid hyphen-run).
export function slugify(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.slice(0, 60).replace(/-+$/g, '')
}

function cachePath(topic: string): string {
  return path.join(blueprintDir(), `${slugify(topic)}.json`)
}

async function readCache(topic: string): Promise<Blueprint | null> {
  try {
    const raw = await fs.readFile(cachePath(topic), 'utf8')
    return BlueprintSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

// Non-fatal by design: Vercel's function filesystem is read-only outside
// /tmp, so this write will fail on every deployed request. Caching is a pure
// optimization (readCache() simply misses next time), never a correctness
// requirement — getBlueprint() must still return the freshly generated,
// already-validated blueprint even when the cache write fails.
async function writeCache(topic: string, blueprint: Blueprint): Promise<void> {
  try {
    const dir = blueprintDir()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(cachePath(topic), JSON.stringify(blueprint, null, 2), 'utf8')
  } catch (err) {
    console.warn(`blueprint cache write failed for "${topic}" (non-fatal):`, err instanceof Error ? err.message : err)
  }
}

// ---------------------------------------------------------------------------
// Planner prompt — built fresh per call (topic varies); reuses
// buildSystemPrompt()'s component/math-function reference so the blueprint's
// skeleton actions are drawn from the exact same protocol the board renderer
// (streamBoardTurn) understands and validates against.
// ---------------------------------------------------------------------------

function plannerPrompt(topic: string): string {
  return `${buildSystemPrompt()}

# Blueprint planning task
Ignore the "respond only by calling render_plan" instruction above — you are
not narrating a single turn right now. Instead, design a full LESSON
BLUEPRINT for the topic "${topic}", matching the JSON schema given to you as
your required output format.

Requirements:
- prerequisites: 2-3 checks one step BELOW "${topic}" — the fringe of prior
  knowledge a student needs before this topic makes sense, not the topic
  itself. Each is a question, 2+ multiple-choice options, the correct
  answer (verbatim, matching one option), and a one-line remediation to teach
  if the student misses it.
- beats: 4-6 beats. Each has a title, a goal, and a "skeleton" of 4-10
  actions (using the action protocol above: add/set/anim/focus/say/ctl/ask/
  step/del/clear) that stages a coherent scene toward that goal. A beat's
  skeleton may build on ids added by an earlier beat's skeleton — beats are
  taught in order on a continuous board, not reset between beats.
- The FIRST beat's skeleton builds concrete intuition (a picture, a
  relatable scenario) before any formal notation or vocabulary.
- Difficulty rises monotonically beat-to-beat — never repeat or regress to
  something easier than an earlier beat.
- Every computed number that appears in say/ask/label text MUST be written
  as a {{...}} template expression using the math functions listed above —
  never a number you computed yourself. Get the underlying math right: the
  numeric parameters you put on added elements (coefficients, ranges, etc.)
  must make each template expression evaluate to the value you intend.
- A beat MAY end with a "check": a short question (mcq with options, or a
  free-response) testing that beat's goal. Not every beat needs one.`
}

function correctionMessage(errors: string[]): string {
  return (
    `Correction: the previous blueprint had these problems:\n` +
    errors.map((e) => `- ${e}`).join('\n') +
    `\nRe-generate the FULL blueprint from scratch, fixing all of them.`
  )
}

// ---------------------------------------------------------------------------
// validateBlueprint — replays each beat's skeleton, in beat order, through
// sanitizeAction + applyAction, threading the scene accumulated from ALL
// PRIOR beats' skeletons into the next beat's validation. This mirrors how
// the session state machine hands beats to the board renderer in sequence
// (see session.ts's composeTeachMessage: beats are taught back-to-back on one
// continuous board, never reset) while still requiring each beat's skeleton
// to be individually coherent against that running state. Every sanitize
// failure and every verifyActions math error is collected (not just the
// first) so a single corrective retry can address everything at once.
// ---------------------------------------------------------------------------

export function validateBlueprint(bp: Blueprint): string[] {
  const errors: string[] = []
  let scene: Scene = emptyScene

  // Prerequisite question/answer/options/remediation are shown to the student
  // verbatim (never rendered through the board's action pipeline), so any
  // {{...}} template in them would never be evaluated live — catch broken ones
  // here at plan time, exactly as skeleton math errors are caught below.
  bp.prerequisites.forEach((pre, i) => {
    const strings = [pre.question, pre.answer, pre.remediation, ...pre.options]
    for (const s of strings) {
      const { errors: e } = evalTemplate(s)
      for (const reason of e) errors.push(`prerequisite ${i} ("${pre.id}"): ${reason}`)
    }
  })

  bp.beats.forEach((beat, i) => {
    let beatScene = scene
    const sanitized: Action[] = []
    for (const raw of beat.skeleton) {
      const result = sanitizeAction(raw, beatScene)
      if (!result.ok) {
        errors.push(`beat ${i} ("${beat.title}"): ${result.reason}`)
        continue
      }
      sanitized.push(result.action)
      beatScene = applyAction(beatScene, result.action)
    }
    const { errors: mathErrors } = verifyActions(sanitized)
    for (const reason of mathErrors) errors.push(`beat ${i} ("${beat.title}"): ${reason}`)

    // The beat check's text/answer/options are also templated at compose time
    // (session.ts's composeTeachMessage feeds them into the ask), so a broken
    // {{...}} in any of them must be caught here too.
    if (beat.check) {
      const checkStrings = [beat.check.text, beat.check.answer, ...(beat.check.options ?? [])]
      for (const s of checkStrings) {
        const { errors: e } = evalTemplate(s)
        for (const reason of e) errors.push(`beat ${i} ("${beat.title}") check: ${reason}`)
      }
    }

    scene = beatScene
  })

  return errors
}

// ---------------------------------------------------------------------------
// getBlueprint
// ---------------------------------------------------------------------------

// PlannerMessage — the narrowest common shape both providers' message params
// accept for the planner's plain-text turns (never anything but a `user`
// role, before/after the one corrective retry) — see pipeline.ts's
// TurnMessage for the same rationale applied to board turns.
type PlannerMessage = { role: 'user'; content: string }

async function attempt(
  client: Anthropic,
  messages: PlannerMessage[],
): Promise<{ blueprint: Blueprint | null; errors: string[] }> {
  let response
  try {
    response = await client.messages.create({
      model: PLANNER_MODEL,
      max_tokens: 16000,
      tools: [emitBlueprintTool],
      tool_choice: { type: 'tool', name: 'emit_blueprint' },
      // See anthropic.ts: some Anthropic-wire-compatible providers think by
      // default and reject a forced tool_choice unless thinking is disabled.
      ...(THINKING_DISABLED ? { thinking: { type: 'disabled' as const } } : {}),
      messages,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return { blueprint: null, errors: [`parse error: ${errorMsg}`] }
  }

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'emit_blueprint',
  )
  const parsed = toolUse ? BlueprintSchema.safeParse(toolUse.input) : null
  // Missing tool_use block or a schema-invalid input behaves exactly like the
  // old null-parsed_output case: feed the existing corrective-retry.
  if (!parsed || !parsed.success) return { blueprint: null, errors: ['model returned no parsed output'] }

  const errors = validateBlueprint(parsed.data)
  return { blueprint: errors.length === 0 ? parsed.data : null, errors }
}

// openai.ts-equivalent of attempt() above: same forced-function-call ->
// validate -> corrective-retry semantics, non-streaming
// (chat.completions.create without stream:true), reading the tool call's
// arguments as a JSON STRING (unlike Anthropic's already-parsed
// tool_use.input) per the OpenAI wire format.
async function attemptOpenAI(
  client: OpenAI,
  messages: PlannerMessage[],
): Promise<{ blueprint: Blueprint | null; errors: string[] }> {
  let response
  try {
    response = await client.chat.completions.create({
      model: PLANNER_MODEL,
      max_tokens: 16000,
      tools: [emitBlueprintFunctionTool],
      tool_choice: { type: 'function', function: { name: 'emit_blueprint' } },
      messages,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return { blueprint: null, errors: [`parse error: ${errorMsg}`] }
  }

  const toolCall = response.choices[0]?.message.tool_calls?.find(
    (tc) => tc.type === 'function' && tc.function.name === 'emit_blueprint',
  )
  let input: unknown = null
  if (toolCall && toolCall.type === 'function') {
    try {
      input = JSON.parse(toolCall.function.arguments)
    } catch {
      input = null
    }
  }
  const parsed = input !== null ? BlueprintSchema.safeParse(input) : null
  // Missing tool call, unparseable arguments, or a schema-invalid input all
  // behave exactly like the Anthropic path's null-parsed_output case: feed
  // the existing corrective-retry.
  if (!parsed || !parsed.success) return { blueprint: null, errors: ['model returned no parsed output'] }

  const errors = validateBlueprint(parsed.data)
  return { blueprint: errors.length === 0 ? parsed.data : null, errors }
}

export async function getBlueprint(client: Anthropic | OpenAI, topic: string): Promise<Blueprint> {
  const cached = await readCache(topic)
  if (cached) return cached

  const baseMessages: PlannerMessage[] = [{ role: 'user', content: plannerPrompt(topic) }]
  const runOne = (messages: PlannerMessage[]) =>
    BOARD_PROVIDER === 'openai' ? attemptOpenAI(client as OpenAI, messages) : attempt(client as Anthropic, messages)

  let result = await runOne(baseMessages)
  if (!result.blueprint) {
    const retryMessages = [...baseMessages, { role: 'user' as const, content: correctionMessage(result.errors) }]
    result = await runOne(retryMessages)
  }
  if (!result.blueprint) {
    throw new Error(
      `blueprint generation failed for "${topic}" after one corrective retry: ${result.errors.join('; ')}`,
    )
  }

  await writeCache(topic, result.blueprint)
  return result.blueprint
}
