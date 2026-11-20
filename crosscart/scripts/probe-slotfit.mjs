import { readFileSync } from 'node:fs'
import { detectGarments, findBodyBox } from '../packages/core/dist/index.js'
import { decodePng, downscale } from '../packages/bridge/src/png.mjs'

const key = process.argv[2] ?? 'f777gz'
const planRes = await fetch('http://127.0.0.1:8790/api/plans/pln_001')
const plan = await planRes.json()
const img = downscale(decodePng(readFileSync(`data/scenes/${key}.png`)), 320)
const res = detectGarments(img, plan.slots)
console.log('subject', res.subject, 'img', img.width, 'x', img.height)
for (const s of res.slots) {
  console.log(s.slot.padEnd(10), s.status.padEnd(7), 'conf', s.confidence, 'method', s.method, 'rect', s.region && { x: +s.region.x.toFixed(3), y: +s.region.y.toFixed(3), w: +s.region.w.toFixed(3), h: +s.region.h.toFixed(3) })
}
