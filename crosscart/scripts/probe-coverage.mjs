import { readFileSync } from 'node:fs'
import { detectGarments, resolveColor, colorDistance } from '../packages/core/dist/index.js'
import { decodePng, downscale } from '../packages/bridge/src/png.mjs'

const key = process.argv[2] ?? 'f777gz'
const planId = process.argv[3] ?? 'pln_001'
const plan = await (await fetch(`http://127.0.0.1:8790/api/plans/${planId}`)).json()
const img = downscale(decodePng(readFileSync(`data/scenes/${key}.png`)), 320)
const res = detectGarments(img, plan.slots)
const { width: W, data } = img

function coverage(reg, target, tol) {
  const x0 = Math.round(reg.x * W), x1 = Math.round((reg.x + reg.w) * W) - 1
  const y0 = Math.round(reg.y * img.height), y1 = Math.round((reg.y + reg.h) * img.height) - 1
  let hit = 0, n = 0, sum = { r: 0, g: 0, b: 0 }
  for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
    const i = (y * W + x) * 4
    const px = { r: data[i], g: data[i + 1], b: data[i + 2] }
    n++; sum.r += px.r; sum.g += px.g; sum.b += px.b
    if (colorDistance(px, target) * 255 <= tol) hit++
  }
  const mean = { r: Math.round(sum.r / n), g: Math.round(sum.g / n), b: Math.round(sum.b / n) }
  return { cov: +(hit / n).toFixed(3), mean, meanDist: Math.round(colorDistance(mean, target) * 255) }
}
for (const s of res.slots) {
  if (!s.region) { console.log(s.slot, 'no region'); continue }
  const it = plan.slots.find((x) => x.slot === s.slot).item
  const proto = resolveColor(it.color, it.colorFamily)
  const c = coverage(s.region, proto.rgb, proto.tol)
  console.log(s.slot.padEnd(10), 'cov', String(c.cov).padEnd(6), 'target', JSON.stringify(proto.rgb), 'tol', proto.tol, '| 框均色', JSON.stringify(c.mean), 'dist', c.meanDist)
}
