/**
 * CrossCart 第二阶段验收（A–H）：真实浏览器 + 真实 AI 场景图 + 真实商品。
 *
 * 前提：`npm run studio` 在跑，且已有带场景缓存的方案（默认 pln_020）。
 * 断言原则：宁可测出「产品在说谎」，也不要给一个好看的假通过。
 */
import { chromium } from 'playwright-core'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8790'
const OUT = 'shots'
if (!existsSync(OUT)) mkdirSync(OUT)

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))

let pass = 0
let fail = 0
const failures = []
function expect(ok, label) {
  if (ok) {
    pass += 1
    console.log(`[verify] ✅ ${label}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`[verify] ❌ ${label}`)
  }
}
const log = (t) => console.log(`[verify] ${t}`)

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'content-type': 'application/json' }, ...opts })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b ?? {}) })

async function resetScroll(page) {
  await page.evaluate(() => {
    const shop = document.getElementById('shop-scroll')
    if (shop) shop.scrollTop = 0
    const plan = document.getElementById('pane-plan')
    if (plan) plan.scrollTop = 0
    const msgs = document.getElementById('messages')
    if (msgs) msgs.scrollTop = msgs.scrollHeight
  })
  await page.waitForTimeout(250)
}

/**
 * 点击热点：热点区域之间会重叠（包 vs 外套），点错会换错衣服。
 * 所以在目标热点盒内做网格采样，用 elementFromPoint 找到「最上层就是目标热点」的点再点，
 * 这样测的就是用户真实能点到的位置，而不是靠猜坐标。
 */
async function clickHotspot(page, slot) {
  const point = await page.evaluate((want) => {
    const el = document.querySelector(`.hotspot[data-hot="${want}"]`)
    if (!el) return null
    const b = el.getBoundingClientRect()
    const step = 0.1
    const hits = []
    for (let y = step / 2; y < 1; y += step) {
      for (let x = step / 2; x < 1; x += step) {
        const px = b.x + b.width * x
        const py = b.y + b.height * y
        const top = document.elementFromPoint(px, py)?.closest('.hotspot')
        if (top?.dataset.hot === want) {
          // 越靠中心越好点（贴近真实用户行为）
          hits.push({ px, py, d: (x - 0.5) ** 2 + (y - 0.5) ** 2 })
        }
      }
    }
    if (!hits.length) return null
    hits.sort((a, b2) => a.d - b2.d)
    return { px: hits[0].px, py: hits[0].py, sampled: hits.length }
  }, slot)
  if (!point) throw new Error(`hotspot ${slot} 的可点区域被其他热点完全覆盖`)
  await page.mouse.click(point.px, point.py)
  await page.waitForTimeout(500)
  return point
}

async function hashOf(url) {
  const buf = await (await fetch(`${BASE}${url}`)).arrayBuffer()
  return { hash: createHash('sha1').update(Buffer.from(buf)).digest('hex').slice(0, 12), bytes: buf.byteLength }
}

const planUrl = (id) => `${BASE}/?plan=${id}`

/* ---------------------------------------------------------------- 启动 */

const all = (await api('/api/plans')).body.plans
const withScene = []
for (const p of all) {
  const v = (await api(`/api/plans/${p.planId}`)).body
  if (v.sceneView?.status === 'ready') withScene.push(p.planId)
}
log(`有场景图的方案：${withScene.join(', ') || '（无）'}`)
if (withScene.length === 0) {
  console.error('[verify] 没有已生成场景图的方案，先跑 scripts/seed-scenes.mjs')
  process.exit(1)
}
// 选基线：优先 pln_020（8 个场景都有图，切场景的对比才有意义）。
// 曾经因为按列表顺序取第一个（恰好只有 1 张图的新方案），E 段「至少 3 个不同场景」直接失败。
const basePlan = process.argv[3] ?? (withScene.includes('pln_020') ? 'pln_020' : withScene[0])
// 用「副本」跑验收：换件、锁定、AI 写入都发生在副本上。
// 原因：基线方案若遇到商品下架，复原请求会 NO_CANDIDATE，把基线永久改坏（缓存键也跟着漂）。
const dupVm = (await post(`/api/plans/${basePlan}/duplicate`, {})).body
if (!dupVm?.planId) {
  console.error('[verify] 复制方案失败，无法在不破坏基线的前提下验收')
  process.exit(1)
}
const planId = dupVm.planId
log(`验收方案：${basePlan} 的副本 ${planId}（基线方案不动）`)

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

const vm = (await api(`/api/plans/${planId}`)).body
const before = {
  ids: vm.slots.map((s) => s.item?.productId ?? null),
  total: vm.cost.breakdown.knownTotal,
  budget: vm.cost.budget.limit,
  buys: vm.purchases.lines.map((l) => (l.buy.state === 'buyable' ? l.buy.url : null)),
}
await page.goto(planUrl(planId), { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#stage-img:not([hidden])', { timeout: 20000 })
await page.waitForTimeout(1500)

/* ============================ A 默认场景生成 ============================ */
log('—— A 默认场景：中间是穿着当前方案的人物场景图，不是商品槽位板 ——')
const stageA = await page.evaluate(() => ({
  imgSrc: document.querySelector('#stage-img')?.getAttribute('src'),
  imgVisible: !document.querySelector('#stage-img')?.hidden,
  boardHidden: document.querySelector('#stage-board')?.hidden,
  hotspots: [...document.querySelectorAll('.hotspot')].map((h) => h.dataset.hot),
  sceneName: document.querySelector('#scene-name')?.innerText,
  badge: document.querySelector('#stage-caption')?.innerText ?? '',
  overlayHidden: document.querySelector('#stage-overlay')?.hidden,
}))
// 页面图可能是原图 .png，也可能是 900px 网页小图 .webp（窄带下原图传不完）。
// 断言要保证「舞台上是这张生成的场景图」，不锁死后缀。
expect(/^\/scenes\/[0-9a-z]+\.(png|webp)(\?v=\d+)?$/.test(stageA.imgSrc ?? ''), `A：中间是 AI 场景图（${stageA.imgSrc}）`)
expect(stageA.imgVisible && stageA.boardHidden, 'A：默认不展示商品槽位板')
expect(stageA.hotspots.length === vm.slots.filter((s) => s.item).length, `A：每件已选单品都有热点（${stageA.hotspots.join('/')}）`)
expect(stageA.overlayHidden === true, 'A：没有错误/加载遮罩挡着画面')
expect(!!stageA.sceneName && stageA.sceneName !== '—', `A：场景名可见（${stageA.sceneName}）`)
expect(stageA.badge.includes('AI 模拟穿搭'), 'A：画面标注「AI 模拟穿搭 · 仅供效果参考」')
await resetScroll(page)
await page.screenshot({ path: join(OUT, 'scene-a-default.png') })

/* ============================ E 多样化图像 ============================ */
log('—— E 多样化：不同地点/时间/天气是不同图，不是同一张背景 ——')
const sceneSet = [
  { place: 'tokyo-street', season: 'autumn', time: 'afternoon', weather: 'clear' },
  { place: 'tokyo-street', season: 'autumn', time: 'night', weather: 'rain' },
  { place: 'paris-cafe', season: 'spring', time: 'morning', weather: 'clear' },
  { place: 'seaside', season: 'summer', time: 'afternoon', weather: 'clear' },
  { place: 'nyc-commute', season: 'winter', time: 'morning', weather: 'overcast' },
]
// 前面几段换过件，缓存键已经变了 —— 用一份干净副本做场景对比，才有可比性
const cleanPlanId = (await post(`/api/plans/${planId}/duplicate`, {})).body.planId
log(`E 诊断：验收方案 ${planId} / 干净副本 ${cleanPlanId}`)
const seen = new Set()
const shots = []
for (const q of sceneSet) {
  // 场景端点现在返回 { view, estimate, cached, requiresConfirm }（付费前要确认），这里只取视图
  const view = (await post(`/api/plans/${cleanPlanId}/scene`, q)).body.view
  if (view.status !== 'ready') {
    log(`E：${view.spec.label} 没有缓存图（${view.status}），跳过对比`)
    continue
  }
  const h = await hashOf(view.image)
  seen.add(view.image)
  shots.push({ label: view.spec.label, image: view.image, sceneId: view.spec.sceneId, ...h })
}
expect(seen.size >= 3, `E：至少 3 个不同场景图（实际 ${seen.size}）`)
expect(new Set(shots.map((s) => s.sceneId)).size === shots.length, 'E：每个场景的 sceneId 唯一（地点×季节×时间×天气）')
expect(new Set(shots.map((s) => s.hash)).size === shots.length, 'E：图片内容哈希互不相同（不是重复使用同一背景）')
log(`E：${shots.map((s) => `${s.label}=${s.bytes}B/${s.hash}`).join(' | ')}`)

/* ============================ C 仅切换场景 ============================ */
log('—— C 仅切换场景：商品 / 预算 / 购买链接都不许变 ——')
const target = { place: 'tokyo-street', season: 'autumn', time: 'night', weather: 'rain' }
log(`C 诊断：切换前页面 url=${await page.evaluate(() => location.search)} name=${await page.evaluate(() => document.querySelector('#scene-name')?.innerText)}`)
log(`C 诊断：服务端 planId=${planId} 当前场景=${(await api(`/api/plans/${planId}`)).body.sceneView.spec.sceneId}`)
const viewC = (await post(`/api/plans/${planId}/scene`, target)).body.view
// 页面同步是 SSE 驱动的：UI 操作后会短暂忽略自己的事件（防回声），所以这里等「最终一致」而不是死等固定毫秒
await page
  .waitForFunction((want) => document.querySelector('#stage-img')?.getAttribute('src') === want, viewC.image, {
    timeout: 8000,
  })
  .catch(() => {})
await page.waitForTimeout(200)
const afterC = (await api(`/api/plans/${planId}`)).body
expect(
  JSON.stringify(afterC.slots.map((s) => s.item?.productId ?? null)) === JSON.stringify(before.ids),
  'C：切场景后商品 ID 完全不变',
)
expect(afterC.cost.breakdown.knownTotal === before.total, `C：总额不变（$${afterC.cost.breakdown.knownTotal}）`)
expect(afterC.cost.budget.limit === before.budget, 'C：预算不变')
expect(
  JSON.stringify(afterC.purchases.lines.map((l) => (l.buy.state === 'buyable' ? l.buy.url : null))) === JSON.stringify(before.buys),
  'C：购买链接不变',
)
expect(afterC.revision === vm.revision, `C：revision 不变（${afterC.revision}，切场景不是改方案）`)
const stageC = await page.evaluate(() => ({
  src: document.querySelector('#stage-img')?.getAttribute('src'),
  name: document.querySelector('#scene-name')?.innerText,
}))
expect(
  stageC.src === viewC.image,
  `C：页面已经换成新场景图（页面=${stageC.name} ${stageC.src} / 期望=${viewC.spec.label} ${viewC.image}）`,
)
await resetScroll(page)
await page.screenshot({ path: join(OUT, 'scene-c-switched.png') })

/* ============================ D 场景适配建议 ============================ */
log('—— D 场景适配：雨天给建议，但不确认就不改方案 ——')
const viewD = (await post(`/api/plans/${planId}/scene`, { place: 'park', season: 'autumn', time: 'morning', weather: 'rain' })).body.view
await page.waitForTimeout(1200)
const adapt = await page.evaluate(() => {
  const el = document.getElementById('adaptation')
  return { hidden: el?.hidden, text: el?.innerText ?? '' }
})
expect(viewD.adaptation?.needed === true, `D：服务端判定场景需要适配（${viewD.adaptation?.hints?.[0] ?? '—'}）`)
expect(adapt.hidden === false && adapt.text.length > 0, 'D：页面出现适配提示条')
expect(adapt.text.includes('让 AI 建议调整'), 'D：提供「让 AI 建议调整」入口（需用户确认）')
const afterD = (await api(`/api/plans/${planId}`)).body
expect(
  JSON.stringify(afterD.slots.map((s) => s.item?.productId ?? null)) === JSON.stringify(before.ids),
  'D：仅提示，没有擅自改任何商品',
)
expect(afterD.revision === vm.revision, 'D：revision 仍未变（未经确认不动方案）')
await resetScroll(page)
await page.screenshot({ path: join(OUT, 'scene-d-adaptation.png') })

/* ============================ F 商品真实性 ============================ */
log('—— F 真实性：提示词来自结构化方案，画面标注不是真实照片 ——')
const fvm = (await api(`/api/plans/${planId}`)).body
const prompt = fvm.sceneView.prompt
const toBuy = fvm.slots.filter((s) => s.item && s.status === 'to_buy')
const colorsIn = toBuy.filter((s) => prompt.toLowerCase().includes(String(s.item.color).toLowerCase()))
expect(colorsIn.length === toBuy.length, `F：每件待买商品的颜色都进了提示词（${colorsIn.length}/${toBuy.length}）`)
expect(/full-body/i.test(prompt), 'F：提示词要求全身构图（热点才有意义）')
expect(!!fvm.sceneView.model, `F：记录了生成模型（${fvm.sceneView.model}）`)
const badgeText = await page.evaluate(() => document.querySelector('#stage-caption')?.innerText ?? '')
expect(badgeText.includes('AI 模拟穿搭'), 'F：场景图明确标注「AI 模拟穿搭」，不冒充真实照片')
expect(fvm.purchases.buyableCount > 0, `F：右侧仍有 ${fvm.purchases.buyableCount} 件真实商品可核对`)

/* ============================ B 点击衣物换件 ============================ */
log('—— B 点击人物身上的衣物：右栏出候选 → 确认 → 只改一件 ——')
await post(`/api/plans/${planId}/scene`, { place: 'tokyo-street', season: 'autumn', time: 'afternoon', weather: 'clear' })
await page.goto(planUrl(planId), { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#stage-img:not([hidden])')
await page.waitForTimeout(1300)

const targetSlot =
  fvm.slots.find((s) => s.slot === 'outerwear' && s.item && !s.locked)?.slot ??
  fvm.slots.find((s) => s.item && !s.locked)?.slot
expect(!!targetSlot, `B：找到可换的衣物热点（${targetSlot}）`)
const hit = await clickHotspot(page, targetSlot)
const selText = await page.evaluate(() => document.querySelector('#selection')?.innerText ?? '')
expect(selText.length > 0, `B：点击人物衣物后右栏切换为该商品详情（命中采样 ${hit.sampled} 点）`)
await page.screenshot({ path: join(OUT, 'scene-b-hotspot.png') })

const idsBeforeB = (await api(`/api/plans/${planId}`)).body.slots.map((s) => s.item?.productId ?? null)
await page.click('#selection [data-act="swap"]')
await page.waitForSelector('.cand', { timeout: 20000 })
await page.waitForTimeout(600)
await page.locator('.cand').first().click()
await page.waitForSelector('#btn-confirm-swap', { timeout: 8000 })
await page.click('#btn-confirm-swap')
await page.waitForTimeout(1800)
const afterB = (await api(`/api/plans/${planId}`)).body
const idsAfterB = afterB.slots.map((s) => s.item?.productId ?? null)
const changed = idsAfterB.map((id, i) => (id !== idsBeforeB[i] ? afterB.slots[i].slot : null)).filter(Boolean)
expect(changed.length === 1 && changed[0] === targetSlot, `B：只改了「${targetSlot}」，实际 [${changed.join(',')}]`)
expect(afterB.revision === vm.revision + 1, `B：revision ${vm.revision} → ${afterB.revision}`)
expect(afterB.cost.breakdown.knownTotal !== before.total, `B：费用同步重算（$${before.total} → $${afterB.cost.breakdown.knownTotal}）`)
// 换到的这套组合如果以前画过，会命中缓存并直接显示正确的图（免费）——这时再换一件「没画过」的，
// 才能验证「图还是上一版」的提示。换件本身不调用图像 API，不花钱。
if (afterB.sceneView?.stale !== true) {
  const cands = (await api(`/api/plans/${planId}/candidates?slot=${targetSlot}&strategy=similar`)).body.candidates ?? []
  for (const c of cands.slice(0, 6)) {
    await post(`/api/plans/${planId}/swap`, { slot: targetSlot, productId: c.productId, by: 'ui' })
    const q = (await api(`/api/scenes/quote?planId=${planId}`)).body
    if (q.cached === false) break
  }
  await page.waitForTimeout(1500)
}
const stale = await page.evaluate(() => {
  const ov = document.getElementById('stage-overlay')
  return { hidden: ov?.hidden, text: ov?.innerText ?? '' }
})
expect(stale.hidden === false && /搭配已(更新|变化)/.test(stale.text), 'B：旧场景图被标成「搭配已更新」，没有假装已经重画')
await resetScroll(page)
await page.screenshot({ path: join(OUT, 'scene-b-after-swap.png') })

// 换回原来那件，保证后续场景缓存仍能命中
const idx = afterB.slots.findIndex((s) => s.slot === targetSlot)
await post(`/api/plans/${planId}/swap`, { slot: targetSlot, productId: before.ids[idx], by: 'ui' })
const restored = (await api(`/api/plans/${planId}`)).body
expect(
  JSON.stringify(restored.slots.map((s) => s.item?.productId ?? null)) === JSON.stringify(before.ids),
  `B：换回原商品后状态复位（${targetSlot}）`,
)

/* ============================ G 回归与稳定性 ============================ */
log('—— G 回归：锁定 / AI 写入 → 页面自动同步 / 购买链接 ——')
const lock = await post(`/api/plans/${planId}/lock`, { slot: targetSlot, locked: true })
expect(lock.status === 200, 'G：锁定接口正常')
const lockedVm = (await api(`/api/plans/${planId}`)).body
const revAfterLock = lockedVm.revision
const blocked = await post(`/api/plans/${planId}/swap`, { slot: targetSlot, strategy: 'cheaper', by: 'ai' })
expect(blocked.status === 409 && blocked.body.code === 'SLOT_LOCKED', `G：锁定位置拒绝替换（${blocked.status} ${blocked.body.code}）`)
const afterLock = (await api(`/api/plans/${planId}`)).body
expect(afterLock.revision === revAfterLock, `G：被拒绝的替换没有改动方案（revision 停在 ${afterLock.revision}）`)
await post(`/api/plans/${planId}/lock`, { slot: targetSlot, locked: false })

// AI 写入 → 页面自动同步（走 SSE，不刷新）。不依赖模型时延，验证的是状态通道。
const aiTarget = (await api(`/api/plans/${planId}`)).body.slots.find((s) => s.item && !s.locked && s.slot !== targetSlot)
if (aiTarget) {
  const aiSwap = await post(`/api/plans/${planId}/swap`, { slot: aiTarget.slot, strategy: 'similar', by: 'ai' })
  expect([200, 422].includes(aiSwap.status), `G：AI 侧换件走同一份状态（${aiSwap.status}）`)
  if (aiSwap.status === 200) {
    await page.waitForTimeout(1800)
    const chip = await page.evaluate((slot) => {
      const el = document.querySelector(`.slot-chip[data-select="${slot}"]`)
      return el?.innerText ?? ''
    }, aiTarget.slot)
    expect(chip.length > 0 && chip.includes('$'), `G：页面无需刷新即同步 AI 的改动（${aiTarget.label}）`)
    await post(`/api/plans/${planId}/swap`, { slot: aiTarget.slot, productId: aiTarget.item.productId, by: 'ui' })
  }
}
const buyLinks = await page.evaluate(() => [...document.querySelectorAll('a.buy-link')].map((a) => a.href))
expect(buyLinks.length > 0, `G：购物清单里有可核实购买入口（${buyLinks.length} 个）`)
expect(
  buyLinks.every((u) => /^https:\/\/(www\.)?(everlane|allbirds|cuyana|rothys)\.com\/products\//.test(u)),
  'G：购买链接都落在白名单店铺的商详页',
)

/* ============================ H 响应式 ============================ */
log('—— H 390px：看场景图 / 切场景 / 点衣物 / 完成替换 ——')
await page.setViewportSize({ width: 390, height: 844 })
await page.waitForTimeout(900)
await page.click('[data-tab="plan"]')
await page.waitForTimeout(800)
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
expect(overflow <= 1, `H：搭配视图无横向溢出（${overflow}px）`)
const mobileStage = await page.evaluate(() => {
  const s = document.querySelector('#stage').getBoundingClientRect()
  return { h: Math.round(s.height), imgVisible: !document.querySelector('#stage-img')?.hidden }
})
expect(mobileStage.imgVisible && mobileStage.h > 260, `H：移动端场景图可见（高 ${mobileStage.h}px）`)
await page.screenshot({ path: join(OUT, 'scene-h-mobile.png'), fullPage: true })

// 移动端点击衣物 → 选中 → 抽屉可打开（完整替换流程在桌面已验，这里验可操作性）
await clickHotspot(page, targetSlot)
const mobileSel = await page.evaluate(() => document.querySelector('#selection')?.innerText ?? '')
expect(mobileSel.length > 0, `H：移动端点击衣物可选中（${targetSlot}）`)
const drawerBtn = await page.locator('#selection [data-act="swap"]').count()
expect(drawerBtn > 0, 'H：移动端选中后能进入换件')
await page.click('[data-tab="plan"]')
await page.click('#btn-scene-switch')
await page.waitForTimeout(800)
const pickerOpen = await page.evaluate(() => !document.querySelector('#scene-picker').hidden)
expect(pickerOpen, 'H：移动端能打开场景选择面板')
await page.click('#btn-picker-close')
await page.click('[data-tab="shop"]')
await page.waitForTimeout(500)
const overflowShop = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
expect(overflowShop <= 1, `H：清单视图无横向溢出（${overflowShop}px）`)

expect(pageErrors.length === 0, `G：页面无 JS 报错（${pageErrors.slice(0, 2).join(' | ') || '无'}）`)

await browser.close()

console.log(`\n[verify] 通过 ${pass} 项，失败 ${fail} 项`)
if (fail) {
  console.log('[verify] 失败项：')
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('[verify] ✅ A–H 全部通过')
