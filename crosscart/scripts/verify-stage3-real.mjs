/**
 * 第三阶段的**真实 API 抽查**（只跑 2 次付费生成，别多花钱）。
 *
 * 覆盖 mock 测不出来的两件事：
 *  1. 自动模式下换件 → 真的调用图像服务 → 新图与原图的像素确实不同、人物还在、热点重新识别；
 *  2. 自定义场景（自然语言）→ 真的生成一个不一样的环境，而商品一个都不动。
 *
 * 一切都在**副本方案**上做，基线 pln_020 不动。
 * 用法：node scripts/verify-stage3-real.mjs [planId]
 * 前提：`npm run studio` 在跑，且 data/scenegen.config.json 已配好可用的图像服务与代理。
 */
import { chromium } from 'playwright-core'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[3] ?? 'http://127.0.0.1:8790'
const OUT = join(process.cwd(), 'shots', 'stage3-real')
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))

let pass = 0
let fail = 0
const failures = []
const out = { startedAt: new Date().toISOString(), real: true, cases: [] }
function expect(ok, label) {
  if (ok) {
    pass += 1
    console.log(`[real] ✅ ${label}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`[real] ❌ ${label}`)
  }
}
const log = (t) => console.log(`[real] ${t}`)

const api = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, { headers: { 'content-type': 'application/json' }, ...opts })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b ?? {}) })
const hashOf = async (url) => {
  const buf = Buffer.from(await (await fetch(`${BASE}${url}`)).arrayBuffer())
  return { hash: createHash('sha1').update(buf).digest('hex').slice(0, 12), bytes: buf.byteLength }
}
async function waitScene(planId, timeout = 180000) {
  const t0 = Date.now()
  let last = null
  let prev = null
  while (Date.now() - t0 < timeout) {
    last = (await api(`/api/plans/${planId}`)).body
    const st = last?.sceneView?.status
    if (prev === 'generating' && (st === 'ready' || st === 'error')) return last
    if (st !== 'generating' && Date.now() - t0 > 4000) return last
    prev = st
    await new Promise((r) => setTimeout(r, 1500))
  }
  return last
}

if (!EDGE) {
  console.error('[real] 找不到 Edge/Chrome')
  process.exit(1)
}

const health = (await api('/api/health')).body
const cfg = (await api(`/api/scenes/quote?planId=${process.argv[2] ?? (await api('/api/plans')).body.plans[0].planId}`)).body
log(`服务：${BASE}（真实商品 ${health.catalog?.live} 件）`)
log(`图像服务：${cfg.available ? '已配置' : '未配置'} · 当前估价 ${JSON.stringify(cfg.estimate?.amount)} ${cfg.estimate?.basis}`)
if (!cfg.available) {
  console.error('[real] 图像服务未配置，跳过真实抽查')
  process.exit(1)
}

// 基线：找一个已经有场景图的方案，复制一份来折腾
let basePlan = process.argv[2]
if (!basePlan) {
  for (const p of (await api('/api/plans')).body.plans) {
    const v = (await api(`/api/plans/${p.planId}`)).body
    if (v.sceneView?.status === 'ready') {
      basePlan = p.planId
      break
    }
  }
}
const dup = (await post(`/api/plans/${basePlan}/duplicate`, {})).body
const planId = dup.planId
log(`真实抽查方案：${basePlan} 的副本 ${planId}（基线不动）`)

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } })
const errors = page.on ? [] : []
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
void errors

await page.goto(`${BASE}/?plan=${planId}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#stage-img:not([hidden])', { timeout: 30000 })
await page.waitForTimeout(1500)

const vm0 = (await api(`/api/plans/${planId}`)).body
const ids0 = vm0.slots.map((s) => s.item?.productId ?? null)
const img0 = vm0.sceneView.image
const h0 = await hashOf(img0)
log(`起始图：${h0.hash}（${(h0.bytes / 1024).toFixed(0)}KB）· 热点 ${vm0.sceneView.hotspots?.okCount}/${vm0.sceneView.hotspots?.total}`)
await page.screenshot({ path: join(OUT, 'real-1-before.png') })

/* ============ 真实用例 1：自动模式换件 → 真的重画一张 ============ */
log('—— 用例 1：自动模式下换一件外套，真的调用图像服务重画 ——')
const budgetBefore = (await api('/api/scenes/budget')).body.budget
const autoOn = await post(`/api/plans/${planId}/scene/auto`, { enabled: true, confirmBudget: true })
expect(autoOn.body.enabled === true, '真实：自动模式已开启（已确认会产生费用）')

const target = vm0.slots.find((s) => s.slot === 'outerwear' && s.item && !s.locked) ?? vm0.slots.find((s) => s.item && !s.locked)
let swap = await post(`/api/plans/${planId}/swap`, { slot: target.slot, strategy: 'similar', by: 'ui' })
if (swap.status !== 200) swap = await post(`/api/plans/${planId}/swap`, { slot: target.slot, strategy: 'cheaper', by: 'ui' })
expect(swap.status === 200, `真实：换掉「${target.label}」（${swap.status}）`)
const t1 = Date.now()
const vm1 = await waitScene(planId)
const ms1 = Date.now() - t1
expect(vm1.sceneView.status === 'ready', `真实：换件后图重画成功（${vm1.sceneView.status}，约 ${(ms1 / 1000).toFixed(0)}s 等待）`)
const ids1 = vm1.slots.map((s) => s.item?.productId ?? null)
const changed = ids1.filter((id, i) => id !== ids0[i])
expect(changed.length === 1, `真实：只换了 1 件（${changed.length}）`)
const h1 = await hashOf(vm1.sceneView.image)
expect(h1.hash !== h0.hash, `真实：新图与旧图像素不同（${h0.hash} → ${h1.hash}）`)
expect(vm1.sceneView.hotspots?.okCount >= 3, `真实：新图重新识别出热点（${vm1.sceneView.hotspots?.okCount}/${vm1.sceneView.hotspots?.total}）`)
expect(vm1.sceneView.hotspots?.at > vm0.sceneView.hotspots?.at, '真实：热点元数据时间戳是新的（不是沿用旧图）')
const budget1 = (await api('/api/scenes/budget')).body
const spent1 = Number((budget1.budget.spent - budgetBefore.spent).toFixed(3))
expect(budget1.budget.spent > budgetBefore.spent, `真实：这次生成记了费用 $${spent1}（累计 $${budget1.budget.spent}/$${budget1.budget.limit}）`)
const rec1 = (budget1.log ?? []).find((r) => r.kind === 'scene-swap')
expect(!!rec1 && rec1.ok === true, `真实：账本记录了这次调用（${rec1?.model} · ${rec1 ? (rec1.ms / 1000).toFixed(1) : '?'}s · $${rec1?.amount}）`)
log(`真实：usage=${JSON.stringify(rec1?.usage)} basis=${rec1?.basis}`)

await page.waitForTimeout(1200)
const dom1 = await page.evaluate(() => ({
  src: document.querySelector('#stage-img')?.getAttribute('src'),
  note: document.querySelector('#hotspot-note')?.innerText ?? '',
}))
expect(dom1.src === vm1.sceneView.image, '真实：页面已显示新图')
await page.screenshot({ path: join(OUT, 'real-2-after-swap.png') })
out.cases.push({
  case: 'auto-swap',
  waitMs: ms1,
  before: h0.hash,
  after: h1.hash,
  hotspots: vm1.sceneView.hotspots?.okCount,
  cost: spent1,
  record: rec1 ? { model: rec1.model, ms: rec1.ms, amount: rec1.amount, basis: rec1.basis, usage: rec1.usage } : null,
})

// 关掉自动模式，避免后面误触发付费生成
await post(`/api/plans/${planId}/scene/auto`, { enabled: false, confirmBudget: true })

/* ============ 真实用例 2：自定义场景 → 真的换环境 ============ */
log('—— 用例 2：自定义场景（自然语言），真的生成另一个环境 ——')
const customText = '雨后傍晚的代官山小巷，霓虹刚亮起来，地面有积水反光'
const idsBefore2 = (await api(`/api/plans/${planId}`)).body.slots.map((s) => s.item?.productId ?? null)
const q2 = (await api(`/api/scenes/quote?planId=${planId}&custom=${encodeURIComponent(customText)}`)).body
expect(q2.cached === false, '真实：新自定义场景没有缓存，需要付费生成')
expect(q2.estimate.amount > 0, `真实：先给出估价 $${q2.estimate.amount}（${q2.estimate.basis}）`)

const t2 = Date.now()
const choose = await post(`/api/plans/${planId}/scene`, { custom: customText, confirm: true })
expect(choose.status === 200, `真实：提交生成（${choose.status}）`)
const vm2 = await waitScene(planId)
const ms2 = Date.now() - t2
expect(vm2.sceneView.status === 'ready', `真实：自定义场景生成成功（${vm2.sceneView.status}，约 ${(ms2 / 1000).toFixed(0)}s）`)
expect(vm2.sceneView.spec.sceneId.startsWith('custom'), `真实：sceneId 反映自定义（${vm2.sceneView.spec.sceneId}）`)
const h2 = await hashOf(vm2.sceneView.image)
expect(h2.hash !== h1.hash, `真实：与上一张确实不同（${h1.hash} → ${h2.hash}）`)
expect(
  JSON.stringify(vm2.slots.map((s) => s.item?.productId ?? null)) === JSON.stringify(idsBefore2),
  '真实：切场景没有改动任何商品',
)
expect(/代官山/.test(vm2.sceneView.prompt), '真实：自定义描述进了提示词')
await page.waitForTimeout(1200)
await page.screenshot({ path: join(OUT, 'real-3-custom-scene.png') })
const budget2 = (await api('/api/scenes/budget')).body
const rec2 = (budget2.log ?? []).find((r) => r.kind === 'scene-scene')
expect(!!rec2 && rec2.ok === true, `真实：场景生成也记录了费用（$${rec2?.amount}）`)
out.cases.push({
  case: 'custom-scene',
  waitMs: ms2,
  before: h1.hash,
  after: h2.hash,
  sceneId: vm2.sceneView.spec.sceneId,
  cost: rec2?.amount ?? null,
  record: rec2 ? { model: rec2.model, ms: rec2.ms, amount: rec2.amount, basis: rec2.basis, usage: rec2.usage } : null,
})

/* ============ 收尾：缓存复核 + 汇总 ============ */
const q3 = (await api(`/api/scenes/quote?planId=${planId}`)).body
expect(q3.cached === true && q3.estimate.amount === 0, '真实：刚生成的场景再问一次是 0 费用（缓存命中）')
const budgetEnd = (await api('/api/scenes/budget')).body.budget
log(`真实：本次共花 $${(budgetEnd.spent - budgetBefore.spent).toFixed(3)}，本月累计 $${budgetEnd.spent}/$${budgetEnd.limit}`)
out.budget = { before: budgetBefore, after: budgetEnd }
out.passed = pass
out.failed = fail
out.failures = failures
out.finishedAt = new Date().toISOString()
out.planId = planId
writeFileSync(join(OUT, 'report.json'), JSON.stringify(out, null, 2))

await browser.close()
console.log(`\n[real] 通过 ${pass} 项，失败 ${fail} 项`)
if (fail) {
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('[real] ✅ 真实 API 抽查通过（2 次付费生成）')
