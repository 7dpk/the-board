import { z } from 'zod'
import { addVariants } from './components' // z.discriminatedUnion('c', [...19 strict objects])

const id = z.string()

export const ActionSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('step'), title: z.string() }),
  addVariants, // z.strictObject add variants merged: each variant is {op:'add', c:literal, id, ...params}
  z.strictObject({ op: z.literal('set'), id, k: z.string(), v: z.union([z.number(), z.string(), z.boolean()]), dur: z.number().optional() }),
  z.strictObject({ op: z.literal('anim'), id, k: z.string(), to: z.number(), dur: z.number(), ease: z.enum(['linear', 'inOut', 'spring']).optional() }),
  z.strictObject({ op: z.literal('focus'), ids: z.array(id), style: z.enum(['highlight', 'pulse', 'dim-others', 'none']) }),
  z.strictObject({ op: z.literal('say'), text: z.string(), sync: z.string().optional() }),
  // wish: self-improvement loop (task-pd) — the tutor asks for a component
  // that doesn't exist yet instead of apologizing in `say`. Never fails
  // sanitization (see sanitize.ts) and is a scene no-op (see scene.ts); the
  // server intercepts it before the SSE stream and logs it for a human to
  // review (server/src/wishlog.ts), it is never shown to the client.
  z.strictObject({ op: z.literal('wish'), component: z.string(), why: z.string() }),
  z.strictObject({ op: z.literal('ctl'), id, k: z.string(), kind: z.enum(['slider', 'drag', 'input']), min: z.number().optional(), max: z.number().optional(), step: z.number().optional(), label: z.string().optional() }),
  z.strictObject({ op: z.literal('ask'), id, kind: z.enum(['mcq', 'numeric', 'free']), text: z.string(), options: z.array(z.string()).optional(), answer: z.string().optional() }),
  z.strictObject({ op: z.literal('del'), id }),
  z.strictObject({ op: z.literal('clear'), keep: z.array(id).optional() }),
])
export type Action = z.infer<typeof ActionSchema>

export const RenderPlanSchema = z.strictObject({ actions: z.array(ActionSchema) })
export const renderPlanJsonSchema = z.toJSONSchema(RenderPlanSchema) as Record<string, unknown>
