import { resolveColor, colorDistance } from '../packages/core/dist/index.js'
const plan = await (await fetch('http://127.0.0.1:8790/api/plans/pln_001')).json()
for (const s of plan.slots) {
  if (!s.item) continue
  const it = s.item
  const proto = resolveColor(it.color, it.colorFamily)
  console.log(s.slot.padEnd(10), 'color=', JSON.stringify(it.color), 'family=', it.colorFamily, '→', JSON.stringify(proto))
}
