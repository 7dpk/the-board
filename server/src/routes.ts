import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { buildSystemPrompt, applyAction, type Action, type Scene } from '@board/shared'
import { BoardTurnError } from './anthropic'
import { getBlueprint } from './blueprint'
import { BOARD_MODEL, PLANNER_MODEL } from './models'
import { getTurnFn, type TurnFn } from './provider'
import type { TurnCallbacks } from './pipeline'
import { logComponentWish } from './wishlog'
import {
  createSession,
  sessions,
  nextUserMessage,
  recordTurn,
  advanceAfterTeach,
  applyParamEvent,
  type Blueprint,
  type Session,
  type TurnInput,
} from './session'

// buildSystemPrompt() is deterministic byte-for-byte across calls (see
// shared/src/prompt.ts) — call it ONCE at module init and reuse the same
// string every turn so prompt caching (cache_control: ephemeral) actually
// hits across turns/sessions instead of re-hashing a "new" string each time.
const SYSTEM_PROMPT = buildSystemPrompt()

const FALLBACK_SAY: Action = { op: 'say', text: 'Sorry — let me regroup. Ask me that again?' }

export type RouteDeps = {
  client: Anthropic | OpenAI
  blueprintProvider?: (topic: string) => Promise<Blueprint | null>
  turnFn?: TurnFn
}

type AttemptOutcome =
  | { kind: 'ok'; actions: Action[]; scene: Scene; usage: { input: number; output: number; cacheRead: number }; errors: string[] }
  | { kind: 'zero'; errors: string[] }
  // `emitted` = actions already streamed to the client via cb.onAction before
  // the failure. A retry MUST NOT re-stream a fresh plan on top of these (it
  // would duplicate them in the client timeline), so the ladder only retries
  // when emitted.length === 0 — see finding #4.
  | { kind: 'error'; err: BoardTurnError; emitted: Action[]; errors: string[] }

export function createApp(deps: RouteDeps) {
  // Default seam: provider.ts's getTurnFn, bound (closure) to this app's
  // client — picks streamBoardTurn or streamBoardTurnOpenAI per
  // BOARD_PROVIDER. Callers (tests) override with their own turnFn to inject
  // fakes without needing a real client at all.
  const turnFn: TurnFn = deps.turnFn ?? getTurnFn(deps.client)
  // Default seam: T10's getBlueprint, bound to this app's client. Callers
  // (tests) override with their own blueprintProvider to inject fakes.
  const blueprintProvider = deps.blueprintProvider ?? ((topic: string) => getBlueprint(deps.client, topic))

  const app = new Hono()

  app.post('/api/session', async (c) => {
    const body = await c.req.json<{ topic: string }>()
    const topic = body.topic
    const session = createSession(topic)
    let warning: string | undefined
    try {
      session.blueprint = await blueprintProvider(topic)
    } catch (err) {
      // T10's getBlueprint may fail (model error, cache miss + generation
      // failure, etc.) — degrade to freeform rather than fail session
      // creation. There is no SSE channel on this endpoint to `warn` on (that
      // event is reserved for the /turn stream, see below), so the failure
      // surfaces as a `warning` field alongside the freeform session instead.
      session.blueprint = null
      warning = err instanceof Error ? err.message : String(err)
    }
    return c.json({
      id: session.id,
      title: session.blueprint?.title ?? topic,
      beatTitles: session.blueprint?.beats.map((b) => b.title) ?? [],
      prereqCount: session.blueprint?.prerequisites.length ?? 0,
      ...(warning ? { warning } : {}),
    })
  })

  app.post('/api/session/:id/turn', async (c) => {
    const id = c.req.param('id')
    const session = sessions.get(id)
    if (!session) return c.json({ error: 'session not found' }, 404)
    if (session.turnInFlight) return c.json({ error: 'turn in flight' }, 409)

    session.turnInFlight = true
    let input: TurnInput
    try {
      input = await c.req.json<TurnInput>()
    } catch (err) {
      session.turnInFlight = false
      throw err
    }

    // Guard: warmup during pending check would discard the check's answer and
    // cause it to be misgraded as a probe answer. Block with 409.
    if (input.kind === 'warmup' && session.phase === 'check') {
      session.turnInFlight = false
      return c.json({ error: 'finish the current check first' }, 409)
    }

    // Guard: continue during pending probe would discard the probe's answer and
    // abandon the warm-up probes. Block with 409.
    if (input.kind === 'continue' && session.phase === 'probe') {
      session.turnInFlight = false
      return c.json({ error: 'finish the warm-up first' }, 409)
    }

    return streamSSE(c, async (stream) => {
      try {
        // A promise chain so cb.onAction's writeSSE calls stay strictly
        // ordered even though the callback itself is synchronous.
        let writeChain: Promise<void> = Promise.resolve()
        const emit = (event: string, data: unknown) => {
          writeChain = writeChain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
          return writeChain
        }

        // A student drag (param event) is a real board mutation: fold it into
        // session.scene BEFORE composing the message so the board summary the
        // tutor sees reflects the manipulation (finding #1).
        if (input.kind === 'event') applyParamEvent(session, input.event)

        const userMsg = nextUserMessage(session, input)
        // Only `start`, `answer`, `warmup`, and `continue` inputs ever compose
        // teach content (via composeProgress/composeWarmupProgress/
        // composeContinue -> composeTeachMessage) and mutate s.phase to
        // 'teach' when they do (`warmup` does so once its probe detour
        // resumes the beat the student was already on — see session.ts;
        // `continue` does so via composeProgress UNLESS a check is pending,
        // in which case phase stays 'check' and this stays false — task F-1).
        // `event` and `chat` never mutate s.phase (see nextUserMessage), so
        // gating on session.phase alone after those kinds would fire
        // advanceAfterTeach off a *stale* leftover 'teach' phase from an
        // earlier checkless auto-advance and silently skip the next beat's
        // teaching. Gate on the input kind AND the freshly-composed phase
        // together.
        const deliversTeach =
          (input.kind === 'start' || input.kind === 'answer' || input.kind === 'warmup' || input.kind === 'continue') &&
          session.phase === 'teach'
        const phaseForTurn = input.kind === 'chat' ? 'qa' : session.phase
        await emit('phase', { phase: phaseForTurn, beatIndex: session.beatIndex })

        const baseMessages = [...session.transcript, { role: 'user' as const, content: userMsg }]

        const runAttempt = async (model: string, extraMsg?: string): Promise<AttemptOutcome> => {
          const messages = extraMsg
            ? [...baseMessages, { role: 'user' as const, content: extraMsg }]
            : baseMessages
          const errors: string[] = []
          const emitted: Action[] = []
          const cb: TurnCallbacks = {
            onAction: (a) => {
              // wish (task-pd): the self-improvement loop. The tutor is
              // asking for a component that doesn't exist yet — log it for a
              // human to review instead of ever showing it on the board.
              if (a.op === 'wish') {
                logComponentWish(session.topic, a.component, a.why)
                return
              }
              if (a.op === 'ask') session.asks[a.id] = { answer: a.answer }
              emitted.push(a)
              void emit('action', a)
            },
            onError: (reason) => errors.push(reason),
          }
          try {
            const result = await turnFn({
              system: SYSTEM_PROMPT,
              messages,
              scene: session.scene,
              model,
              cb,
            })
            if (result.actions.length === 0) return { kind: 'zero', errors }
            return { kind: 'ok', actions: result.actions, scene: result.scene, usage: result.usage, errors }
          } catch (err) {
            if (err instanceof BoardTurnError) return { kind: 'error', err, emitted, errors }
            throw err
          }
        }

        const correctionFor = (outcome: AttemptOutcome): string | undefined =>
          outcome.kind === 'zero' ? `Correction: ${outcome.errors.join('; ')}. Re-emit valid actions only.` : undefined

        // Failure ladder: attempt @ BOARD_MODEL -> (retryable | zero-actions) one
        // retry @ BOARD_MODEL -> escalate once @ PLANNER_MODEL -> fallback.
        // A non-retryable BoardTurnError skips straight to escalation.
        // EXCEPTION (finding #4): an attempt that already streamed actions to
        // the client before failing is NOT retried — the partial turn is
        // accepted with a `warn` instead, since re-streaming would duplicate
        // the already-shown actions.
        let model: string = BOARD_MODEL
        let outcome = await runAttempt(model)
        let usedSameModelRetry = false
        let partial: { emitted: Action[]; errors: string[] } | null = null

        while (outcome.kind !== 'ok') {
          if (outcome.kind === 'error' && outcome.emitted.length > 0) {
            partial = { emitted: outcome.emitted, errors: outcome.errors }
            break
          }

          const extraMsg = correctionFor(outcome)

          if (model === BOARD_MODEL && !usedSameModelRetry && (outcome.kind === 'zero' || outcome.err.retryable)) {
            usedSameModelRetry = true
            outcome = await runAttempt(model, extraMsg)
            continue
          }
          if (model !== PLANNER_MODEL) {
            model = PLANNER_MODEL
            usedSameModelRetry = true
            outcome = await runAttempt(model, extraMsg)
            continue
          }
          break // exhausted the ladder
        }

        // Accepted partial turn: the actions are already on the client's
        // timeline. Rebuild the scene from them (streamBoardTurn threw before
        // returning its liveScene, but re-applying the emitted actions to the
        // pre-turn scene reproduces it exactly), warn, and complete normally.
        if (partial) {
          for (const reason of partial.errors) await emit('warn', { reason })
          await emit('warn', { reason: 'turn ended early' })
          let scene = session.scene
          for (const a of partial.emitted) scene = applyAction(scene, a)
          session.scene = scene
          recordTurn(session, userMsg, partial.emitted)
          if (deliversTeach) advanceAfterTeach(session)
          await emit('done', { usage: { input: 0, output: 0, cacheRead: 0 } })
          return
        }

        if (outcome.kind !== 'ok') {
          await emit('action', FALLBACK_SAY)
          const message =
            outcome.kind === 'error'
              ? outcome.err.message
              : `no valid actions after retries: ${outcome.errors.join('; ')}`
          await emit('error', { message })
          recordTurn(session, userMsg, [FALLBACK_SAY])
          return
        }

        // A winning attempt can still have dropped/rewritten individual
        // actions (sanitize/verify failures reported via cb.onError) without
        // the turn as a whole qualifying as "0 valid actions" — surface those
        // as non-fatal `warn`s rather than silently swallowing them.
        for (const reason of outcome.errors) {
          await emit('warn', { reason })
        }

        // Persist the scene so later turns can reference elements this turn
        // added/manipulated (finding #1).
        session.scene = outcome.scene
        recordTurn(session, userMsg, outcome.actions)
        if (deliversTeach) advanceAfterTeach(session)
        await emit('done', { usage: outcome.usage })
      } finally {
        session.turnInFlight = false
      }
    })
  })

  return app
}

export type { Session, TurnInput, Blueprint }
