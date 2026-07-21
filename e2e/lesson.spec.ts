// e2e/lesson.spec.ts — one live happy-path run against the real DeepSeek
// (Anthropic-compat) endpoint configured in the repo-root .env. Skipped
// automatically (not failed) when no key is configured, so this spec is safe
// in any environment — see playwright.config.ts for how .env gets loaded into
// process.env before this file's top-level `test.skip` guard runs.
//
// Path (brief, task-19): open app -> pick "Quadratic Functions" -> first
// probe ask renders (mcq) -> click an option -> ... -> a `plot` svg path
// appears (teach beat) -> change a slider in the control strip -> a new
// teacher chat line appears -> ask a question in chat -> teacher responds.
//
// Real flow detail (verified against server/src/session.ts +
// server/data/blueprints/quadratic-functions.json, the cached blueprint this
// topic resolves to): the session asks 3 prerequisite mcqs first (phase
// 'probe'), then teaches beat 0 ("Tossing a Ball" — a projectile with NO
// axes/plot, just a launch-angle slider) ending in its own check mcq, then
// (as part of the SAME turn that grades that check) teaches beat 1 ("Shape
// of a Parabola" — axes + several `plot`s). So the slider appears BEFORE the
// first plot chronologically; this spec exercises both regardless of order
// rather than assuming the brief's illustrative ordering is load-bearing.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

const hasKey = Boolean(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY)

type Blueprint = {
  prerequisites: { question: string; answer: string }[]
  beats: { check?: { answer: string } }[]
}

// Resolved relative to this file (`__dirname`, not process.cwd()) so it's
// correct regardless of the directory `npx playwright test` is invoked from.
// (Deliberately not `import.meta.url`: this repo has no root "type":"module",
// and mixing that with plain `require`-based node: imports in the same file
// makes Playwright's transform pick ESM loading for the whole file, which
// then breaks on the very same imports — see task-19 report.)
const repoRoot = path.resolve(__dirname, '..')
const blueprintPath = path.join(repoRoot, 'server/data/blueprints/quadratic-functions.json')
const blueprint: Blueprint | null = fs.existsSync(blueprintPath)
  ? (JSON.parse(fs.readFileSync(blueprintPath, 'utf8')) as Blueprint)
  : null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Loose equality for mcq option text vs. the blueprint's cached answer
// string: the model echoes options close to verbatim but isn't guaranteed
// byte-identical (seen live: unicode minus U+2212 in place of a plain
// hyphen). Collapse whitespace and unify dash variants; do NOT strip other
// punctuation/digits — e.g. "x^2 + x - 6" vs "x^2 - x - 6" must stay distinct.
function normalizeAnswerText(s: string): string {
  return s
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** Waits for the ask widget's mcq to render, then clicks the option matching
 * `knownAnswer` (loosely) if one is found, else the first option — a wrong
 * click just costs an extra remediation round-trip (session.ts's
 * failedProbes/failedChecks ladder bounds it at 2 attempts), it doesn't fail
 * the run. */
async function answerMcq(page: Page, knownAnswer?: string): Promise<void> {
  const askText = page.locator('.ask-widget .ask-text')
  await expect(askText).toBeVisible({ timeout: 90_000 })

  const options = page.locator('.ask-widget .ask-options button')
  await expect(options.first()).toBeVisible({ timeout: 10_000 })

  let target = options.first()
  if (knownAnswer) {
    const wanted = normalizeAnswerText(knownAnswer)
    const count = await options.count()
    for (let i = 0; i < count; i++) {
      const candidate = options.nth(i)
      if (normalizeAnswerText(await candidate.innerText()) === wanted) {
        target = candidate
        break
      }
    }
  }
  await target.click()
}

async function hasSampledPlotPath(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const paths = Array.from(document.querySelectorAll('.board-canvas svg path'))
    return paths.some((p) => (p.getAttribute('d') ?? '').trim().split(/\s+/).length > 3)
  })
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

test.describe('Board lesson happy path (live)', () => {
  test.skip(!hasKey, 'no ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY configured — skipping live e2e')

  test('Quadratic Functions: probe -> teach -> manipulate -> chat', async ({ page }) => {
    test.setTimeout(5 * 60 * 1000) // several chained live model turns

    await page.goto('/')

    // ---- pick the lesson -----------------------------------------------
    await page.getByRole('button', { name: 'Quadratic Functions', exact: true }).click()

    // ---- 3 prerequisite probes (mcq) ------------------------------------
    const prereqAnswers = blueprint?.prerequisites.map((p) => p.answer) ?? [undefined, undefined, undefined]
    for (const answer of prereqAnswers) {
      await answerMcq(page, answer)
    }

    // ---- beat 0 ("Tossing a Ball"): a launch-angle slider appears, then a
    // check mcq gates the beat. --------------------------------------------
    //
    // Architectural note (discovered running this spec live, not assumed):
    // the client plays every turn's actions through ONE ordered timeline
    // pump (client/src/timeline.ts). That beat's own skeleton ends with the
    // check `ask`, which the pump commits right after the slider's `ctl` —
    // an `ask` action blocks the pump (`await waitForAsk()`) until the
    // student answers it. So a param-event turn fired while this check is
    // still pending WILL reach the server and get a real reply, but that
    // reply's `say` sits queued behind the still-open ask and only actually
    // renders once the ask is resolved. We verify the two halves separately:
    // (1) the slider drag really produces an `event`-kind turn over the
    // network (fast, deterministic), and (2) new teacher dialogue (that
    // queued reply, plus beat 1's own teaching) appears once the check is
    // answered and the pump unblocks.
    await expect(page.locator('.ask-widget .ask-text')).toBeVisible({ timeout: 90_000 })

    const slider = page.locator('.control-strip input[type=range]').first()
    await expect(slider).toBeVisible({ timeout: 10_000 })

    const chatTeacherBefore = await page.locator('.chat-msg.chat-teacher').count()

    const eventTurnSent = page.waitForRequest((req) => {
      if (!req.url().includes('/turn') || req.method() !== 'POST') return false
      try {
        return (req.postDataJSON() as { kind?: string })?.kind === 'event'
      } catch {
        return false
      }
    }, { timeout: 10_000 })

    await slider.focus()
    await slider.press('ArrowRight')
    await slider.press('ArrowRight') // clear the no-op guard (finish() skips if v === fromRef.current)

    // (1) the slider commit -> emitParamEvent (400ms debounce) -> a real
    // `event`-kind turn POSTed to the server. Proves the manipulation loop
    // fired, independent of the ask-gating timing described above.
    await eventTurnSent

    // ---- answer beat 0's check mcq -> unblocks the pump (surfacing the
    // queued event-turn reply) AND, in the SAME server turn, teaches beat 1
    // ("Shape of a Parabola" — axes + several `plot`s). ---------------------
    await answerMcq(page, blueprint?.beats[0]?.check?.answer)

    // (2) new teacher dialogue appears (the queued slider reply and/or beat
    // 1's own says) and a `plot` svg path renders.
    await expect
      .poll(async () => page.locator('.chat-msg.chat-teacher').count(), { timeout: 120_000, message: 'no new teacher chat line after slider change + check answer' })
      .toBeGreaterThan(chatTeacherBefore)

    await expect
      .poll(async () => hasSampledPlotPath(page), { timeout: 120_000, message: 'no plot svg path rendered' })
      .toBe(true)

    // ---- chat: ask a free-text question, expect a teacher response -------
    const chatTeacherBeforeQuestion = await page.locator('.chat-msg.chat-teacher').count()
    await page.getByLabel('chat message').fill('Why does the parabola open upward here?')
    await page.getByRole('button', { name: 'Send', exact: true }).click()

    await expect
      .poll(async () => page.locator('.chat-msg.chat-teacher').count(), { timeout: 90_000, message: 'no teacher response to chat question' })
      .toBeGreaterThan(chatTeacherBeforeQuestion)
  })
})
