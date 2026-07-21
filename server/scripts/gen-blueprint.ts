import { getBlueprint, slugify } from '../src/blueprint'
import { PLANNER_MODEL } from '../src/models'
import { createProviderClient } from '../src/provider'

const topic = process.argv.slice(2).join(' ').trim()
if (!topic) {
  console.error('usage: tsx --env-file=../.env scripts/gen-blueprint.ts "<topic>"')
  process.exit(1)
}

const client = createProviderClient()
console.log(`generating blueprint for "${topic}" via ${PLANNER_MODEL} ...`)
const bp = await getBlueprint(client, topic)

console.log(`\ncache: server/data/blueprints/${slugify(topic)}.json`)
console.log(`title: ${bp.title}`)
console.log(`prerequisites (${bp.prerequisites.length}): ${bp.prerequisites.map((p) => p.question).join(' | ')}`)
console.log(`beats (${bp.beats.length}):`)
for (const [i, b] of bp.beats.entries()) {
  const ops = b.skeleton.map((a) => a.op).join(',')
  const check = b.check ? ` [check: ${b.check.text}]` : ''
  console.log(`  ${i}. ${b.title} — goal: ${b.goal}\n     ops(${b.skeleton.length}): ${ops}${check}`)
}
