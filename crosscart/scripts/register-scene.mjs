/**
 * 把一张已生成的场景图登记进缓存（会话内真实生成 → 运行时按键命中）。
 * 用法：node scripts/register-scene.mjs <planId> <sceneQueryJson> <imagePath> [regionsJson]
 * 键 = sceneCacheKey(plan, spec)，与运行时完全一致。
 */
import { createPlan, resolveScene, sceneCacheKey, buildScenePrompt, DEFAULT_REGIONS } from '../packages/core/dist/index.js'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [planId, queryJson, imagePath, regionsJson] = process.argv.slice(2)
if (!planId || !queryJson || !imagePath) {
  console.error('usage: node scripts/register-scene.mjs <planId> <sceneQueryJson> <imagePath> [regionsJson]')
  process.exit(1)
}
const ROOT = join(process.cwd())
const st = JSON.parse(readFileSync(join(ROOT, 'data', 'state.json'), 'utf8'))
const plan = st.plans.find((p) => p.planId === planId)
if (!plan) throw new Error(`找不到方案 ${planId}`)
const spec = resolveScene(JSON.parse(queryJson))
const key = sceneCacheKey(plan, spec)
const file = `${key}.png`
copyFileSync(imagePath, join(ROOT, 'data', 'scenes', file))
const idxPath = join(ROOT, 'data', 'scenes', 'index.json')
const idx = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : { entries: {} }
idx.entries[key] = {
  key, planId, sceneId: spec.sceneId, label: spec.label, status: 'ready', file,
  prompt: buildScenePrompt(plan, spec),
  provider: 'workbuddy-session', model: 'imagegen (hunyuan-class)',
  regions: regionsJson ? JSON.parse(regionsJson) : DEFAULT_REGIONS,
  createdAt: new Date().toISOString(),
}
writeFileSync(idxPath, JSON.stringify(idx, null, 2))
console.log('registered', key, spec.label, '->', file)
console.log('prompt:', buildScenePrompt(plan, spec).slice(0, 200))
