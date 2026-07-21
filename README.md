# Board

An AI teaching whiteboard. A student picks a topic; a small model teaches it
by driving a live, manipulable math/physics canvas — not by generating text,
and not by generating raw SVG/code per turn.

**Built on the OpenAI API standard** — Chat Completions with a forced
function `tool_choice`, the same integration surface used by the OpenAI API,
DeepSeek's OpenAI-compatible endpoint, and any other OpenAI-compatible
provider. An Anthropic-compatible path (Claude, or DeepSeek's `/anthropic`
surface) is also fully supported — see [Quickstart](#quickstart) for both.

## What Board is

Every other "AI tutor with visuals" approach generates the visual itself —
raw SVG, a chart-library call, an image — as free-form output per turn. That
is slow (3-8s to first pixel), expensive (1,000-3,000 output tokens per
visual), unreliable on small/cheap models, and prone to producing a broken or
hallucinated picture mid-lesson, since the model is simultaneously deciding
*what* to teach and *how to draw it correctly*. Board separates those two
problems. The client owns a fixed palette of pre-built, parameterized,
animatable components (a Cartesian plot, a projectile trajectory, a
free-body diagram, ...); the model's only job is to emit a short, streamed
JSON action protocol — `add`, `set`, `focus`, `say`, `ask`, ... — that
assembles and narrates a scene from that palette, the way a teacher reaches
for a marker rather than hand-drawing a graph from scratch every time.

This is the token-efficient action-protocol thesis the whole system rests
on: a visual costs ~100-300 output tokens instead of thousands, the first
element can render in ~1s instead of several seconds, and it works reliably
on a fast/cheap model. This POC runs on Claude Haiku 4.5 by default, and is
verified end-to-end on BOTH wire protocols against the same DeepSeek
infrastructure: the **OpenAI-compatible** endpoint (`BOARD_PROVIDER=openai`,
`deepseek-chat` — 98.6% validity / 89.7% semantic / 121.5 tok-vis / 1291ms
TTFA, all PASS) and the **Anthropic-compatible** endpoint
(`BOARD_PROVIDER=anthropic`, currently configured on `deepseek-v4-pro` for
stronger teaching quality; `deepseek-v4-flash` is the faster/cheaper
alternative). All measured against the same 4 targets — see
[Measured success criteria](#measured-success-criteria) and
[`docs/eval-baseline.md`](docs/eval-baseline.md) for the full comparison
across both providers.
Every action is schema-validated, sanitized, and math-checked server-side
before it ever reaches the client, so the model narrates numbers it computed
via verified `{{expr}}` templates, not arithmetic it made up. Students can
also reach back into the scene — drag a point, move a slider — and the tutor
perceives and reacts to exactly what changed, closing the manipulation loop
that static-visual tutors don't have.

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│  client/   Vite + React + zustand                                     │
│  TopicPicker → App (Board canvas + caption + AskWidget + ControlStrip │
│                      + PlayerBar + ChatPanel)                         │
│  Gallery (/#gallery) — every component, offline, interactively driven │
│                                                                         │
│        SSE: action | phase | warn | done | error                      │
│   ◄─────────────────────────────────────────────────────────────────  │
│        POST /api/session, POST /api/session/:id/turn                  │
│   ─────────────────────────────────────────────────────────────────►  │
└───────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌───────────────────────────────────────────────────────────────────────┐
│  server/   Hono                                                       │
│  routes.ts     SSE turn endpoint; failure ladder (retry same model →  │
│                 escalate to PLANNER_MODEL → fallback "let me regroup")│
│  session.ts    state machine: plan → probe → teach → qa → check → done│
│  provider.ts   BOARD_PROVIDER seam — picks the client + turn fn below │
│  openai.ts     streamBoardTurnOpenAI — Chat Completions, forced       │
│                 function tool_choice, tool_calls[].function.arguments│
│  anthropic.ts  streamBoardTurn — forced tool_choice, incremental JSON │
│                 parse; both providers share one sanitize/verify/apply│
│                 pipeline (pipeline.ts) per-action as it streams in    │
│  blueprint.ts  cached lesson plan (prereqs + teaching beats), planned │
│                 once per topic by PLANNER_MODEL, validated + replayed │
└───────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌───────────────────────────────────────────────────────────────────────┐
│  shared/   protocol package — single source of truth for both sides   │
│  protocol/actions.ts     Zod ActionSchema (11 ops) → JSON Schema for   │
│                           the forced tool/function call (either       │
│                           provider)                                    │
│  protocol/components.ts  19 component specs (doc/example/clamps/keys) │
│  prompt.ts               buildSystemPrompt() — generated FROM the     │
│                           specs above; add a component, the prompt    │
│                           updates itself                              │
│  sanitize.ts   the trust boundary: parse → id-normalize → ref-checks  │
│                 → key-checks (incl. color eligibility) → clamp →      │
│                 expr-safety → ask-arity → string-length clamp         │
│  mathcheck.ts  {{expr}} template evaluation — verified math, never    │
│                 arithmetic the model did in its head                 │
│  scene.ts      the reducer: Action → Scene (elements/order/controls)  │
└───────────────────────────────────────────────────────────────────────┘
```

**Action flow, one turn:** student input (pick a lesson / answer / chat /
manipulate a control) → `session.ts` composes the next user message from the
state machine → one forced tool/function call (streamed), via whichever
provider `BOARD_PROVIDER` selects → per action, as it completes: Zod-parse →
`sanitizeAction` → mathcheck-verify
→ apply to the server's authoritative `Scene` → emitted over SSE →
client-side `timeline.ts` paces/tweens/gates it (an `ask` blocks further
playback until answered) → React renders it → a student manipulation is
debounced into a `BoardEvent` and folds into the *next* turn's context.

## Quickstart

**1. Configure `.env`** (repo root; every provider block is in
`.env.example` — uncomment exactly one):

```bash
cp .env.example .env
```

```bash
# --- OpenAI-compatible (BOARD_PROVIDER=openai) — DeepSeek's OpenAI endpoint ---
BOARD_PROVIDER=openai
OPENAI_API_KEY=sk-...              # falls back to ANTHROPIC_AUTH_TOKEN if unset
# OPENAI_BASE_URL=https://api.deepseek.com   # default if unset; use OpenAI's
                                    # own base URL (or omit) for real OpenAI
BOARD_MODEL=deepseek-chat          # REQUIRED on this endpoint: the v4-pro/
                                    # -flash/reasoner ids are "thinking mode"
                                    # and reject a forced tool_choice (400) —
                                    # deepseek-chat is the one id that accepts
                                    # it. See docs/eval-baseline.md.
PLANNER_MODEL=deepseek-chat
```

```bash
# --- Claude (BOARD_PROVIDER=anthropic, the default; SDK reads ANTHROPIC_API_KEY) ---
ANTHROPIC_API_KEY=sk-ant-...
# BOARD_MODEL=claude-haiku-4-5      # default if unset
# PLANNER_MODEL=claude-sonnet-5     # default if unset

# --- or DeepSeek (Anthropic-compatible endpoint; BOARD_PROVIDER=anthropic) ---
ANTHROPIC_AUTH_TOKEN=sk-...
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
BOARD_MODEL=deepseek-v4-pro        # smarter/default; deepseek-v4-flash is the
                                    # faster/cheaper option — see docs/eval-baseline.md
PLANNER_MODEL=deepseek-v4-pro
BOARD_THINKING=disabled            # required: DeepSeek thinks by default,
                                    # which 400s a forced tool_choice unless disabled
```

Never set `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` together — the SDK
sends both auth headers and the request is rejected. `BOARD_PROVIDER`
(`openai` | `anthropic`, default `anthropic`) picks which of the two blocks
above is active — see `server/src/provider.ts`.

**2. Install + run**

```bash
npm install
npm run dev          # server on :8787 + client on :5173, together
```

Open `http://localhost:5173` and pick one of the four flagship lesson cards —
**Quadratic Functions**, **Projectile Motion**, **Kepler's Laws and
Gravitation**, or **Simple Harmonic Motion** — or type any topic (it falls
back to a freeform session if a blueprint can't be planned).

**Component gallery** (every component, offline, live-editable controls, no
API calls): `http://localhost:5173/#gallery`

## The action protocol (11 ops)

Source of truth: `shared/src/protocol/actions.ts`.

| op | payload | purpose |
|---|---|---|
| `step` | `{title}` | begin a teaching beat; groups later actions for step-back navigation |
| `add` | `{id, c, ...params}` | create one of the 19 component types (`c`) below |
| `set` | `{id, k, v, dur?}` | update one param; `dur` tweens the change instead of snapping |
| `anim` | `{id, k, to, dur, ease?}` | keyframe one param over time (`linear` / `inOut` / `spring`) |
| `focus` | `{ids, style}` | highlight / pulse / dim-others / none — direct the student's eye |
| `say` | `{text, sync?}` | a narration beat; `sync` times the caption to an element's animation |
| `wish` | `{component, why}` | self-improvement loop: the tutor asks for a component that doesn't exist yet instead of faking it in `say`; never shown to the student — see [Wish loop](#wish-loop) |
| `ctl` | `{id, k, kind, min?, max?, step?, label?}` | expose a manipulable (`slider` / `drag` / `input`) |
| `ask` | `{id, kind, text, options?, answer?}` | understanding check (`mcq` / `numeric` / `free`); gates playback until answered |
| `del` | `{id}` | remove one element |
| `clear` | `{keep?}` | wipe the board, optionally keeping listed ids |

## Component palette (19)

Source of truth: `shared/src/protocol/components.ts` (`COMPONENT_SPECS`).

| component | what it is |
|---|---|
| `axes` | Cartesian axes other components attach to via `on=<axes id>` |
| `plot` | graph of `y = f(x)` from a mathjs expression |
| `point` | a draggable point `(x, y)` |
| `vector` | an arrow from `(x1,y1)` to `(x2,y2)`; dragging moves the head |
| `segment` | a straight line between two points |
| `area` | shaded region under a curve between `from` and `to` |
| `tangent` | the tangent line to a curve at `x = at` |
| `label` | a KaTeX-rendered math label, on-axes or free-floating |
| `numberline` | a 1D number line with optional tick marks |
| `table` | a data table from header cols + string rows |
| `projectile` | projectile-motion trajectory (`v0`, `deg`, normalized time `t`) |
| `incline` | an inclined plane, optional friction/mass/force overlay |
| `pendulum` | a simple pendulum (`length`, `deg0`, time `t`) |
| `fbd` | a free-body diagram: a labeled point + up to 6 force vectors |
| `steps` | a worked-derivation card, revealed line by line via `shown` |
| `orbit` | elliptical (Kepler) orbit around a central body — grid-free gravitation/planetary-motion viz, correct speed variation, no Cartesian axes needed |
| `spring` | SHM mass-spring oscillator (`amp`, `k`, `mass`), optional restoring-force arrow |
| `wave` | traveling or standing wave (`amp`, `wavelength`, `freq`) |
| `ray` | ray-optics diagram (lens/mirror) with computed image position |

## Wish loop

When no component in the palette fits the concept being taught, the tutor
emits a `wish` action instead of faking the visual in narration. The server
intercepts it before the SSE stream and appends it to
`server/data/component-wishes.jsonl` (never shown to the student) — a
running backlog of "components students would benefit from" for a human to
review and decide whether to build.

## Blueprint format + scripts

A **blueprint** (`server/src/blueprint.ts`'s `BlueprintSchema`) is the
lesson-level plan generated once per topic by `PLANNER_MODEL` and cached to
`server/data/blueprints/<slug>.json`:

```ts
{
  title: string,
  prerequisites: { id, question, options, answer, remediation }[], // 2-3 checks
  beats: { title, goal, skeleton: Action[], check?: { text, options?, answer } }[], // 4-6 beats
}
```

Every beat's `skeleton` is replayed through `sanitizeAction` + `verifyActions`
at plan time (in beat order, threading the accumulated scene forward), so a
cached blueprint is guaranteed structurally valid and math-verified before a
student ever sees it. A schema-invalid or math-broken blueprint gets exactly
one corrective retry before the session falls back to freeform.

**Flagship lessons** (committed, hand-verified blueprints under
`server/data/blueprints/`, surfaced as the four TopicPicker cards):

| topic | arc |
|---|---|
| Quadratic Functions | roots → vertex → factoring → the parabola's shape |
| Projectile Motion | launch → split into x/y → time of flight → range & the 45° rule |
| Kepler's Laws and Gravitation | hook → first law (ellipse) → second law (equal-area sweep) → third law (`T²∝a³`) → Newton's gravity → synthesis |
| Simple Harmonic Motion | spring hook → spring clock (`springPeriod`) → pendulum → the sine-wave connection → derive `T=2π√(m/k)` → synthesis |

The two physics flagships showcase the JEE component pack: `orbit`
(with `showSweep` for Kepler's second law), `spring`, `wave`, and `steps`
derivation cards.

Scripts (run from `server/`, need a configured `.env`):

```bash
tsx --env-file=../.env scripts/gen-blueprint.ts "Some New Topic"
# generates (or reads the cache for) a blueprint and prints its beats/checks

tsx --env-file=../.env scripts/drive-lesson.ts "Quadratic Functions"
# drives a full lesson end-to-end through the real Hono app against the
# LIVE provider, logging every turn's actions/says/warns — the fastest way
# to smoke-test a prompt/fewshot change
```

## Eval harness

`server/src/eval/run.ts` runs 10 named cases (`server/src/eval/cases.ts`)
covering both lessons' core teaching moments, and reports validity%,
semantic pass%, output tokens/visual, and median time-to-first-action.

```bash
# zero-API structural smoke test (scripted actions through the real
# sanitize -> verify -> apply pipeline; proves the plumbing, not the model)
npm run eval -w server -- --dry

# live run against the configured provider — writes server/eval-results.json
npm run eval -w server

# filter to one case
npm run eval -w server -- --case quadratic-intro
```

## How to add a component

1. **Spec entry**: add the type to `COMPONENT_TYPES` and a `z.strictObject`
   add-variant + a `COMPONENT_SPECS` entry (`doc`, `example`, `clamps`,
   `animatable`, `controllable`) in `shared/src/protocol/components.ts`.
2. **Renderer**: add a `React.FC<{ el: SceneElement }>` in
   `client/src/board/math.tsx` or `physics.tsx`, reading params through
   `effectiveParams` (never `el.params` directly, so live drag/tween
   overrides render without a store commit).
3. **Registry**: register it in `client/src/board/registry.tsx`.
4. **Gallery**: nothing to do — `Gallery.tsx` iterates `COMPONENT_TYPES` and
   renders `COMPONENT_SPECS[type].example` automatically.
5. **Prompt**: nothing to do — `buildSystemPrompt()` (`shared/src/prompt.ts`)
   is generated *from* `COMPONENT_SPECS`, so the model's reference doc
   updates itself.

## Measured success criteria

From `server/eval-results.json` (latest live run: **2026-07-19**, model
**`deepseek-v4-pro`** — the currently configured `BOARD_MODEL` — via the
Anthropic-compatible API, 10/10 cases, not a `--dry` run):

| Criterion | Target | Measured | Status |
|---|---|---|---|
| Validity % (sanitize-accepted / emitted) | ≥ 95% | **100.0%** | PASS |
| Semantic pass % (per-case check predicates) | ≥ 80% | **89.7%** | PASS |
| Tokens / visual (output tokens ÷ `add` actions) | ≤ 300 | **123.7** | PASS |
| Median TTFA (time to first streamed action) | < 1500 ms | **1488 ms** | PASS (12ms of margin — thin) |
| Mathcheck-verify errors (broken `{{expr}}` templates) | 0 | **0** | PASS |

`deepseek-v4-flash` is the faster/cheaper alternative (98.7% / 96.6% /
116.9 tok-vis / 1345ms TTFA — comfortable margins on every target, but less
"smart" per the model-switch ask). **Board model is configurable; pro =
better teaching (validity, zero sanitize drops), slower first visual and a
few more semantic-check misses.** Full flash-vs-pro comparison table and
recommendation: [`docs/eval-baseline.md`](docs/eval-baseline.md#2026-07-19-update--re-baseline--smarter-model-eval-flash-vs-pro).

The genuine **OpenAI-API** path (`BOARD_PROVIDER=openai`, `deepseek-chat`,
same DeepSeek infrastructure over its OpenAI-compatible endpoint instead of
`/anthropic`) was measured the same way: **98.6% / 89.7% / 121.5 tok-vis /
1291ms TTFA — all PASS**, plus a live full-lesson run
(`scripts/drive-lesson.ts "Kepler's Laws and Gravitation"`) with zero
dropped actions. See [`docs/eval-baseline.md`](docs/eval-baseline.md#2026-07-21-update--genuine-openai-api-provider-path-board_provideropenai)
for the full run and the `deepseek-chat`-only model-id finding (the
v4-pro/-flash/reasoner ids are "thinking mode" and reject a forced
`tool_choice` on this endpoint).

**Known residual issue:** the `numberline-fractions` case passes 2/3 checks —
its narration never literally says the word "fraction" (a content nit in
that case's `say` text, not a validity or math error; the numberline and its
mark render correctly).

## Known limitations

- **A truncated template can render literally.** Text over 2,000 chars is
  clamped in the sanitizer *before* `{{...}}` templates are evaluated; a
  template straddling the cut renders as a literal `{{frag` instead of a
  computed value (no crash; typical text is far below the limit). Similarly,
  each line in a `steps` component is truncated at 500 chars, so a template
  straddling that boundary in a step's line shares the same edge case.
- **Table cells bypass `{{...}}` verification.** A `table` component's rows
  are plain strings, not run through `mathcheck` — a hardcoded number typed
  into a table cell is never math-verified the way a `say`/`label`'s
  `{{expr}}` template is.
- **Live blueprint generation on `deepseek-v4-pro` usually needs the
  hand-edit workflow.** The cached blueprints in `server/data/blueprints/`
  were hand-verified/adjusted after generation rather than accepted as-is —
  `gen-blueprint.ts`'s automatic corrective retry doesn't reliably converge
  on that model for every topic.
- **`ask.answer` is visible client-side (devtools).** The correct answer to
  an understanding check ships to the client in the `ask` action / store
  state for local grading; there is no server-side-only answer key.
- **Single-session, in-memory state; no persistence.** `sessions` is a
  process-memory `Map` (`server/src/session.ts`) — a server restart loses
  every in-progress session.
- **The system prompt is below Claude Haiku's minimum cacheable prompt
  length**, so `cache_control: ephemeral` doesn't actually reduce cost today
  on that model — a real optimization opportunity, not a correctness bug.

## Testing

```bash
npm test --workspaces --if-present   # shared + server + client unit/integration suites
npx tsc --noEmit -p shared/tsconfig.json   # (and server/, client/)
npm run build -w client                    # production build (tsc + vite build)
npm run test:e2e                           # live Playwright happy path (needs a configured .env; auto-skips otherwise)
```

The e2e spec (`e2e/lesson.spec.ts`) drives the real dev servers end-to-end:
pick "Quadratic Functions" → answer the prerequisite probes → manipulate the
launch-angle slider in the control strip → answer the first beat's check →
a `plot` renders → ask a free-text question in chat and get a response. See
`playwright.config.ts` for the `webServer` setup (or start both servers
manually with `npm run dev -w server` / `npm run dev -w client` and point
`baseURL` at them).

## Deploy (Vercel)

The Vite client (`client/dist`) and the Hono server are deployed together as
one Vercel project: static assets served from the filesystem, `/api/*`
routed to a single serverless function (`api/index.ts`) that reuses the real
Hono app from `server/src/index.ts` via `hono/vercel`'s `handle()`. See
`vercel.json` for the build/route/function config.

### Required environment variables

Set these on the Vercel project (Settings → Environment Variables) before
deploying — same variables as local `.env`, see `.env.example`:

| Variable | Purpose |
| --- | --- |
| `BOARD_PROVIDER` | `openai` or `anthropic` (default `anthropic`) — which wire protocol drives board turns + blueprint generation |
| `OPENAI_API_KEY` | API key for an OpenAI-compatible provider (falls back to `ANTHROPIC_AUTH_TOKEN` if unset) — only used when `BOARD_PROVIDER=openai` |
| `OPENAI_BASE_URL` | OpenAI-compatible provider base URL (default `https://api.deepseek.com`) — only used when `BOARD_PROVIDER=openai` |
| `ANTHROPIC_AUTH_TOKEN` | API key for the LLM provider (Anthropic-wire-compatible; e.g. DeepSeek), sent as `Authorization: Bearer` — only used when `BOARD_PROVIDER=anthropic` |
| `ANTHROPIC_BASE_URL` | Provider base URL (omit to use Anthropic directly with `ANTHROPIC_API_KEY` instead) — only used when `BOARD_PROVIDER=anthropic` |
| `BOARD_MODEL` | Fast per-turn board renderer model |
| `PLANNER_MODEL` | Blueprint planner / escalation model |
| `BOARD_THINKING` | Set to `disabled` for Anthropic-wire providers whose models think by default and reject a forced `tool_choice` otherwise (no effect under `BOARD_PROVIDER=openai`) |
| `BOARD_ACCESS_CODE` | Optional access gate: when set, every `/api/*` call (except `/api/health`) must carry a matching `x-board-code` header or it 401s. Unset = gate is inert (open deployment) |

### Access gate & shareable links

With `BOARD_ACCESS_CODE` set, the client prompts for the code on first use
and stores it in `localStorage`. To skip the prompt entirely, share a link
that carries the code:

```
https://<your-deployment>/#code=YOUR_CODE     # preferred — the hash fragment never reaches server/CDN logs
https://<your-deployment>/?code=YOUR_CODE     # also supported
```

On load the client stores the code and immediately scrubs it from the
address bar (`history.replaceState`), so it doesn't linger in the URL,
browser history, or screenshots. A code in a link overwrites a previously
stored one, so re-sharing a link after rotating the code just works.

### Deploy commands

```bash
vercel link            # associate this repo with a Vercel project (one-time)
vercel env add BOARD_PROVIDER
vercel env add OPENAI_API_KEY      # or ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL for BOARD_PROVIDER=anthropic
vercel env add BOARD_MODEL
vercel env add PLANNER_MODEL
vercel env add BOARD_THINKING      # BOARD_PROVIDER=anthropic only
vercel --prod           # deploy
```

### Caveats

- **Sessions are in-memory** (`server/src/session.ts`'s process-memory `Map`)
  — acceptable for personal-scale use, but every cold start / redeploy /
  scale-out event loses in-progress sessions, and concurrent instances don't
  share state. `regions: ["bom1"]` (single region) is set in `vercel.json` to
  minimize routing across separate instances, but Vercel may still spin up
  multiple concurrent instances under load — this is not a substitute for
  real session storage (Redis/KV) if the deployment sees real traffic.
- **The function filesystem is read-only** outside `/tmp`. The bundled
  lesson blueprints (`server/data/blueprints/**`, included via
  `functions.includeFiles`) are read fine, but the blueprint disk-cache
  *write* (`writeCache` in `server/src/blueprint.ts`) fails on every deployed
  request — this is handled: the write is wrapped in try/catch and only
  `console.warn`s, so `getBlueprint` still returns the freshly generated
  blueprint, it just never persists it back to the bundle.

### SECURITY warning

**Anyone who can reach the API can spend the owner's LLM API budget** —
`/api/session` and `/api/turn` call the configured provider using the
server-side key. Before sharing the URL outside a trusted circle, set
`BOARD_ACCESS_CODE` (see *Access gate & shareable links* above) so every
API call requires the code, and/or enable **Vercel Deployment Protection**
(Settings → Deployment Protection — Vercel Authentication or a
Password/trusted-IP gate). The access code is a lightweight shared secret,
not real auth: anyone you share a `#code=` link with can forward it.
