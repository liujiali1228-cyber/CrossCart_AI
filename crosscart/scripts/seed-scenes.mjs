/**
 * 注册会话内生成的场景图：每张图写入
 *   - 精确的缓存键（与运行时 sceneCacheKey 完全一致）
 *   - 实际使用的提示词（不是「现在模板会生成的提示词」）
 *   - 逐图人工核对过的热点区域
 * 用法：node scripts/seed-scenes.mjs
 */
import { resolveScene, sceneCacheKey } from '../packages/core/dist/index.js'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const GEN = join(ROOT, '.tmp', 'gen')
const OUT = join(ROOT, 'data', 'scenes')
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const plan = JSON.parse(readFileSync(join(ROOT, 'data', 'state.json'), 'utf8')).plans.find((p) => p.planId === 'pln_020')
if (!plan) throw new Error('pln_020 不存在')

const OUTFIT = 'snow cashmere zip-up turtleneck jacket, italian straw striped silky cotton shirt top, vintage heather grey fleece barrel pants, white canvas shoes, navy blazer backpack bag'
const base = (scene, extra = '') =>
  `photorealistic lifestyle photograph of a young East Asian woman with natural skin texture and realistic body proportions, wearing ${OUTFIT}, full-body composition, standing relaxed, feet fully visible, facing the camera slightly angled, hands natural, scene: ${scene}${extra}, consistent light direction between subject and environment, natural ground contact and shadows, realistic fabric drape and texture, editorial street-style quality, shot on 35mm film look, no plastic skin, no over-smoothing, no watermark, no text`

const seeds = [
  {
    query: { place: 'tokyo-street', season: 'autumn', time: 'afternoon', weather: 'clear' },
    file: 'photorealistic_lifestyle_photo_2026-11-17T11-22-35.png',
    prompt: base('a quiet side street in Shimokitazawa, Tokyo, small storefronts and vending machines, utility poles, autumn, scattered fallen leaves, afternoon sun with defined shadows, clear sky, eye-level full-body street photography, 35mm'),
    regions: {
      outerwear: { x: 0.27, y: 0.22, w: 0.47, h: 0.27 },
      top: { x: 0.4, y: 0.31, w: 0.22, h: 0.2 },
      bottom: { x: 0.34, y: 0.49, w: 0.32, h: 0.33 },
      shoes: { x: 0.37, y: 0.82, w: 0.28, h: 0.12 },
      bag: { x: 0.22, y: 0.24, w: 0.16, h: 0.26 },
    },
  },
  {
    query: { place: 'tokyo-street', season: 'autumn', time: 'night', weather: 'rain' },
    file: 'photorealistic_lifestyle_photo_2026-11-17T11-23-14.png',
    prompt: base('a quiet side street in Shimokitazawa, Tokyo, small storefronts and vending machines, utility poles, autumn, scattered fallen leaves, night, city lights and neon reflections, warm street lamps, just after rain, wet pavement with reflections, a few umbrellas in the distance, eye-level full-body street photography, 35mm'),
    regions: {
      outerwear: { x: 0.26, y: 0.3, w: 0.36, h: 0.33 },
      top: { x: 0.395, y: 0.33, w: 0.13, h: 0.22 },
      bottom: { x: 0.36, y: 0.62, w: 0.22, h: 0.25 },
      shoes: { x: 0.36, y: 0.87, w: 0.16, h: 0.09 },
      bag: { x: 0.235, y: 0.36, w: 0.11, h: 0.22 },
    },
  },
  {
    query: { place: 'paris-cafe', season: 'spring', time: 'morning', weather: 'clear' },
    file: 'Same_woman__same_face__same_ou_2026-11-17T11-26-02.png',
    prompt:
      'Same woman, same face, same outfit exactly as the reference image (cream fleece zip-up jacket over a straw-striped shirt, grey fleece pants, white canvas sneakers, navy backpack). Now she stands on the terrace of a Parisian corner café with rattan chairs and a zinc bar visible through the window. Spring, fresh foliage, mid-morning clean daylight, clear sky. Full-body composition, standing relaxed, feet fully visible. Eye-level, 50mm, shallow depth of field. Photorealistic editorial street-style photography, realistic fabric drape, natural ground contact and shadows, no plastic skin, no over-smoothing, no watermark, no text.',
    refImage: 'photorealistic_lifestyle_photo_2026-11-17T11-22-35.png',
    regions: {
      outerwear: { x: 0.29, y: 0.2, w: 0.44, h: 0.35 },
      top: { x: 0.41, y: 0.25, w: 0.19, h: 0.3 },
      bottom: { x: 0.36, y: 0.54, w: 0.3, h: 0.33 },
      shoes: { x: 0.37, y: 0.87, w: 0.27, h: 0.1 },
      bag: { x: 0.27, y: 0.22, w: 0.15, h: 0.33 },
    },
  },
  {
    query: { place: 'seaside', season: 'summer', time: 'afternoon', weather: 'clear' },
    file: 'photorealistic_lifestyle_photo_2026-11-17T11-23-51.png',
    prompt: base('a wooden boardwalk by the sea, dunes and distant white parasols, summer, bright and warm, afternoon sun with defined shadows, clear sky, eye-level full-body, bright natural light'),
    regions: {
      outerwear: { x: 0.3, y: 0.205, w: 0.38, h: 0.3 },
      top: { x: 0.38, y: 0.225, w: 0.235, h: 0.325 },
      bottom: { x: 0.36, y: 0.5, w: 0.3, h: 0.36 },
      shoes: { x: 0.37, y: 0.86, w: 0.29, h: 0.09 },
      bag: { x: 0.55, y: 0.2, w: 0.23, h: 0.32 },
    },
  },
  {
    query: { place: 'park', season: 'autumn', time: 'morning', weather: 'rain' },
    file: 'photorealistic_lifestyle_photo_2026-11-17T11-24-13.png',
    prompt: base('a gravel path in a city park with open lawn and mature trees, autumn, scattered fallen leaves, mid-morning, clean daylight, just after rain, wet pavement with reflections, a few umbrellas in the distance, eye-level full-body, open shade'),
    regions: {
      outerwear: { x: 0.29, y: 0.22, w: 0.42, h: 0.29 },
      top: { x: 0.37, y: 0.25, w: 0.24, h: 0.3 },
      bottom: { x: 0.34, y: 0.5, w: 0.3, h: 0.35 },
      shoes: { x: 0.33, y: 0.85, w: 0.3, h: 0.09 },
      bag: { x: 0.52, y: 0.22, w: 0.23, h: 0.3 },
    },
  },
  {
    query: { place: 'nyc-commute', season: 'winter', time: 'morning', weather: 'overcast' },
    file: 'Same_woman__same_face__same_ou_2026-11-17T11-26-30.png',
    prompt:
      'Same woman, same face, same outfit exactly as the reference image (cream fleece zip-up jacket over a straw-striped shirt, grey fleece pants, white canvas sneakers, navy backpack). Now she stands on a crosswalk in Midtown Manhattan, yellow cabs and a steam vent in the background, winter with bare branches and cold air, mid-morning overcast diffused daylight. Full-body composition, standing relaxed, feet fully visible. Slightly low angle, 50mm. Photorealistic editorial street-style photography, realistic fabric drape, natural ground contact and shadows, no plastic skin, no over-smoothing, no watermark, no text.',
    refImage: 'photorealistic_lifestyle_photo_2026-11-17T11-22-35.png',
    regions: {
      outerwear: { x: 0.27, y: 0.19, w: 0.42, h: 0.36 },
      top: { x: 0.4, y: 0.25, w: 0.22, h: 0.31 },
      bottom: { x: 0.35, y: 0.55, w: 0.3, h: 0.33 },
      shoes: { x: 0.35, y: 0.88, w: 0.29, h: 0.08 },
      bag: { x: 0.25, y: 0.22, w: 0.16, h: 0.33 },
    },
  },
]

const idxPath = join(OUT, 'index.json')
const idx = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : { entries: {} }

for (const s of seeds) {
  const spec = resolveScene(s.query)
  const key = sceneCacheKey(plan, spec)
  const file = `${key}.png`
  copyFileSync(join(GEN, s.file), join(OUT, file))
  idx.entries[key] = {
    key,
    planId: plan.planId,
    sceneId: spec.sceneId,
    label: spec.label,
    status: 'ready',
    file,
    prompt: s.prompt,
    refImage: s.refImage ?? null,
    provider: 'session-imagegen',
    model: 'imagegen (via WorkBuddy)',
    regions: s.regions,
    createdAt: new Date().toISOString(),
    note: '会话内生成并人工核对热点；运行时同一键命中缓存，不会重复调用',
  }
  console.log('registered', key, spec.label, '->', file)
}
writeFileSync(idxPath, JSON.stringify(idx, null, 2))
console.log('total entries:', Object.keys(idx.entries).length)
