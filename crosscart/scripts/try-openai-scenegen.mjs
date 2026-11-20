/**
 * OpenAI 图像 API 最小验证（不污染正式场景缓存，不改方案状态）：
 *   node scripts/try-openai-scenegen.mjs
 *
 * 三步，对应「能不能用它做动态场景穿搭」的核心问题：
 *   1. 真实商品图 → 生成身穿整套服装、站在东京街头的写实人物（image-to-image）
 *   2. 以第 1 步的图为底，只把外套换成另一件真实商品（人物与其余衣物不动）
 *   3. 以第 1 步的图为底，只把场景换成巴黎咖啡馆（穿搭原样保留）
 *
 * 每步记录耗时与 usage tokens（如实估算成本），输出到 .tmp/scenegen-test/。
 * 前提：data/scenegen.config.json 已填 OpenAI key，refsMode=openai。
 */
import { resolveProviderConfig, callImageApi, checkProvider } from '../packages/bridge/src/scenegen.mjs'
import { buildScenePrompt, resolveScene, garmentPhrase } from '../packages/core/dist/index.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, '.tmp', 'scenegen-test')
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const log = (...a) => console.log('[try]', ...a)
const cfg = resolveProviderConfig(ROOT)
if (!cfg.available) {
  console.error(`[try] 图像服务未配置：缺 ${cfg.missing.join(', ')}。请先在 data/scenegen.config.json 填 apiKey。`)
  process.exit(1)
}
if (cfg.refsMode !== 'openai') {
  console.error(`[try] 当前 refsMode=${cfg.refsMode}，本验证需要 "openai"（参考图走 /images/edits）`)
  process.exit(1)
}
log(`provider: ${cfg.baseUrl} | model: ${cfg.model} | size: ${cfg.size} | quality: ${cfg.quality} | proxy: ${cfg.proxy || '直连'}`)

/* 免费自检：只列模型，不花图像费用 */
const chk = await checkProvider(cfg)
if (!chk.ok) {
  console.error(`[try] 服务自检失败（${chk.status}）：${chk.error}`)
  console.error('[try] 常见原因：key 无效、账号无图像权限、需要代理（配 provider.proxy）。')
  process.exit(1)
}
const hasModel = chk.models.includes(cfg.model)
log(`自检通过：可用模型 ${chk.models.join(', ') || '（列表为空）'}${hasModel ? '' : ` ⚠️ 不含 ${cfg.model}`}`)
if (!hasModel && chk.models.length) {
  console.error(`[try] 这个 key 没有 ${cfg.model} 的权限，可用的是：${chk.models.join(', ')}`)
  process.exit(1)
}

const plan = JSON.parse(readFileSync(join(ROOT, 'data', 'state.json'), 'utf8')).plans.find((p) => p.planId === 'pln_020')
if (!plan) throw new Error('pln_020 不存在')

const spec = resolveScene({ place: 'tokyo-street', season: 'autumn', time: 'afternoon', weather: 'clear' })

async function fileOf(url, name) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`下载失败 ${r.status}：${url}`)
  const mime = r.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
  return { role: 'product', name, mime, buffer: Buffer.from(await r.arrayBuffer()) }
}

const cutouts = []
for (const s of plan.slots.filter((x) => x.item?.image?.cutout && /^https?:/.test(x.item.image.cutout))) {
  cutouts.push(await fileOf(s.item.image.cutout, `${s.slot}.jpg`))
}
log(`下载到 ${cutouts.length} 张真实商品图作参考`)

async function step(n, label, prompt, files, outName) {
  log(`—— 第 ${n} 步：${label} ——`)
  const t0 = Date.now()
  const { buffer: buf } = await callImageApi(cfg, prompt, { urls: [], files }, log)
  writeFileSync(join(OUT, outName), buf)
  log(`✅ ${outName}（${(buf.length / 1024 / 1024).toFixed(2)}MB，${((Date.now() - t0) / 1000).toFixed(1)}s）`)
  return buf
}

/* 1. 商品图 → 人物场景 */
const prompt1 =
  'The product reference images show the actual items she must be wearing — match their color, material and style precisely. ' +
  buildScenePrompt(plan, spec)
const img1 = await step(1, '真实商品图 → 身穿整套服装的人物 + 东京街头', prompt1, cutouts, 'step1-tokyo.png')

/* 2. 只换外套 */
const catalog = JSON.parse(readFileSync(join(ROOT, 'data', 'live', 'catalog.json'), 'utf8'))
const current = plan.slots.find((s) => s.slot === 'outerwear')
const alt = (catalog.items ?? []).find(
  (i) => i.category === 'outerwear' && i.productId !== current.item.productId && /^https?:/.test(i.image?.cutout ?? '') && /^https?:/.test(i.url ?? ''),
)
if (!alt) throw new Error('目录里找不到另一件可换的真实外套')
const prompt2 =
  `Use the first reference image as the base: keep the same woman — identical face, pose, body proportions and framing — and keep the street, lighting, and ALL other garments and the backpack exactly as they are. ` +
  `Replace ONLY her jacket with the product shown in the second reference image (${garmentPhrase(alt)}). Match its color and material precisely. Photorealistic, no watermark, no text.`
await step(
  2,
  `只换外套 → ${alt.title}（其余不动）`,
  prompt2,
  [{ role: 'base', name: 'base.png', mime: 'image/png', buffer: img1 }, await fileOf(alt.image.cutout, 'new-outerwear.jpg')],
  'step2-swap-outerwear.png',
)

/* 3. 只换场景 */
const paris = resolveScene({ place: 'paris-cafe', season: 'spring', time: 'morning', weather: 'clear' })
const prompt3 =
  'Use the first reference image as the base: keep the same woman — identical face, pose, body proportions and framing — and keep her ENTIRE outfit and backpack exactly as they are. ' +
  `Change ONLY the environment to: ${paris.prompt}. Match the new scene's light direction and color temperature on the subject. Photorealistic, no watermark, no text.`
await step(3, `只换场景 → ${paris.label}（穿搭原样）`, prompt3, [{ role: 'base', name: 'base.png', mime: 'image/png', buffer: img1 }], 'step3-paris.png')

log('全部完成，产物在 .tmp/scenegen-test/。人工核对：人物是否同一人、服装是否还原、场景是否生效、单张成本是否可接受。')
