/**
 * 第二阶段交付截图（不调用图像生成，全部命中已缓存的真实场景图）：
 *   node scripts/shoot-workbench.mjs [baseUrl] [planId]
 * 产出：默认场景 / 热点选中 / 场景面板 / 换场景前后对比 / 多场景对比 / 换件后旧图标注 / 移动端。
 * 截图过程中会真的换件与切场景，结束时把方案恢复原样。
 */
import { chromium } from 'playwright-core'
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

const api = async (p, opts = {}) => (await fetch(`${BASE}${p}`, { headers: { 'content-type': 'application/json' }, ...opts })).json()
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b ?? {}) })

const planId = process.argv[3] ?? 'pln_020'
const vm0 = await api(`/api/plans/${planId}`)
const ids0 = vm0.slots.map((s) => s.item?.productId ?? null)
const scene0 = vm0.sceneView?.spec ?? null
console.log('[shots] 方案', planId, '场景', scene0?.label)

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

const cleanScroll = async () => {
  await page.evaluate(() => {
    for (const id of ['pane-shop', 'pane-plan']) document.getElementById(id).scrollTop = 0
    const m = document.getElementById('messages')
    if (m) m.scrollTop = m.scrollHeight
  })
  await page.waitForTimeout(250)
}
const shot = async (name) => {
  await cleanScroll()
  await page.screenshot({ path: join(OUT, name) })
  console.log('[shots]', name)
}

/** 命中测试采样：找「最上层就是它」的点，避免点到重叠的其它衣物 */
async function clickHotspot(slot) {
  const pt = await page.evaluate((want) => {
    const el = document.querySelector(`.hotspot[data-hot="${want}"]`)
    if (!el) return null
    const b = el.getBoundingClientRect()
    let best = null
    for (let y = 0.05; y < 1; y += 0.1) {
      for (let x = 0.05; x < 1; x += 0.1) {
        const px = b.x + b.width * x
        const py = b.y + b.height * y
        if (document.elementFromPoint(px, py)?.closest('.hotspot')?.dataset.hot !== want) continue
        const d = (x - 0.5) ** 2 + (y - 0.5) ** 2
        if (!best || d < best.d) best = { px, py, d }
      }
    }
    return best
  }, slot)
  if (!pt) throw new Error(`热点 ${slot} 被完全遮挡`)
  await page.mouse.click(pt.px, pt.py)
  await page.waitForTimeout(600)
}

await page.goto(`${BASE}/?plan=${planId}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#stage-img:not([hidden])', { timeout: 20000 })
await page.waitForTimeout(1600)

/* 01 默认场景 */
await shot('scene-default.png')

/* 02 热点：悬停出标签 + 选中后右栏详情 */
await clickHotspot('outerwear')
await page.hover('.hotspot[data-hot="outerwear"]').catch(() => {})
await page.waitForTimeout(400)
await shot('scene-hotspot-select.png')

/* 03 场景选择面板 */
await page.click('#btn-scene-switch')
await page.waitForTimeout(700)
await shot('scene-picker.png')

/* 04 切到雨天夜景（Mode A：只换背景） */
const night = await post(`/api/plans/${planId}/scene`, { place: 'tokyo-street', season: 'autumn', time: 'night', weather: 'rain' })
await page.click('#btn-picker-close').catch(() => {})
await page.waitForTimeout(1500)
await shot('scene-switched-night.png')
console.log('[shots] 切到', night.spec?.label, night.status)

/* 05 换件 → 旧图标注「搭配已更新」（不假装重画） */
// 重新载入：清掉上一次选中（再点同一条会取消选中），模拟用户切完场景后的正常操作
await page.goto(`${BASE}/?plan=${planId}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#stage-img:not([hidden])')
await page.waitForTimeout(1300)
await clickHotspot('outerwear')
await page.click('#selection [data-act="swap"]')
await page.waitForSelector('.cand', { timeout: 20000 })
await page.waitForTimeout(800)
await shot('scene-swap-candidates.png')
await page.locator('.cand').first().click()
await page.waitForSelector('#btn-confirm-swap', { timeout: 8000 })
await page.click('#btn-confirm-swap')
await page.waitForTimeout(2000)
await shot('scene-after-swap-stale.png')

/* 06 未配置图像服务：如实报状态 + 配置指引，不用静态图冒充 */
await post(`/api/plans/${planId}/scene`, { custom: '京都哲学之道', season: 'autumn', time: 'afternoon', weather: 'clear' })
await page.goto(`${BASE}/?plan=${planId}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
const unc = await api(`/api/plans/${planId}`)
console.log('[shots] 自定义场景状态', unc.sceneView?.status, '| 缺配置', (unc.sceneView?.provider?.missing ?? []).join(','))
await shot('scene-unconfigured.png')

/* 复原 */
const vm1 = await api(`/api/plans/${planId}`)
const idx = vm1.slots.findIndex((s) => s.slot === 'outerwear')
await post(`/api/plans/${planId}/swap`, { slot: 'outerwear', productId: ids0[idx], by: 'ui' })
if (scene0) {
  const { place, season, time, weather, custom } = scene0
  await post(`/api/plans/${planId}/scene`, custom ? { custom, time, season, weather } : { place, season, time, weather })
}

/* 06 多场景对比：同一套衣服、不同地点/时间/天气 */
const scenes = [
  { label: '东京街头 · 秋下午', q: { place: 'tokyo-street', season: 'autumn', time: 'afternoon', weather: 'clear' } },
  { label: '东京街头 · 秋夜晚 · 雨天', q: { place: 'tokyo-street', season: 'autumn', time: 'night', weather: 'rain' } },
  { label: '巴黎咖啡馆 · 春上午', q: { place: 'paris-cafe', season: 'spring', time: 'morning', weather: 'clear' } },
  { label: '海边度假 · 夏下午', q: { place: 'seaside', season: 'summer', time: 'afternoon', weather: 'clear' } },
  { label: '公园 · 秋上午 · 雨天', q: { place: 'park', season: 'autumn', time: 'morning', weather: 'rain' } },
  { label: '纽约通勤 · 冬上午 · 多云', q: { place: 'nyc-commute', season: 'winter', time: 'morning', weather: 'overcast' } },
]
const cards = []
for (const s of scenes) {
  const v = await post(`/api/plans/${planId}/scene`, s.q)
  if (v.status === 'ready') cards.push({ label: s.label, image: v.image })
}
console.log('[shots] 可用场景图', cards.length)
await post(`/api/plans/${planId}/scene`, { place: 'tokyo-street', season: 'autumn', time: 'afternoon', weather: 'clear' })

const grid = async (name, list, cols, w) => {
  const p2 = await browser.newPage({ viewport: { width: w, height: 1000 }, deviceScaleFactor: 1 })
  await p2.setContent(`<html><body style="margin:0;background:#0e0e11;font:13px/1.4 -apple-system,'Segoe UI',sans-serif;color:#e8e8ea">
  <div style="padding:18px 20px;font-size:15px;font-weight:600">同一套方案，${list.length} 个真实生成的场景（衣物与商品一一对应）</div>
  <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:14px;padding:0 20px 20px">
  ${list
    .map(
      (c) => `<figure style="margin:0;background:#17171b;border-radius:10px;overflow:hidden">
      <img src="${BASE}${c.image}" style="width:100%;display:block;aspect-ratio:2/3;object-fit:cover">
      <figcaption style="padding:8px 10px;color:#c9c9cf">${c.label}<span style="float:right;color:#7d7d86">AI 模拟</span></figcaption>
    </figure>`,
    )
    .join('')}
  </div></body></html>`)
  await p2.waitForTimeout(1200)
  await p2.screenshot({ path: join(OUT, name), fullPage: true })
  console.log('[shots]', name)
  await p2.close()
}
await grid('scene-multi-compare.png', cards, 3, 1320)

/* 07 切换前后对比（详情页细看差异） */
await grid('scene-before-after.png', cards.slice(0, 2), 2, 1000)

/* 08 移动端 */
await page.goto(`${BASE}/?plan=${planId}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#stage-img:not([hidden])')
await page.setViewportSize({ width: 390, height: 844 })
await page.waitForTimeout(900)
await page.click('[data-tab="plan"]')
await page.waitForTimeout(900)
await page.screenshot({ path: join(OUT, 'scene-mobile.png'), fullPage: true })
console.log('[shots] scene-mobile.png')
await page.setViewportSize({ width: 390, height: 844 })
await clickHotspot('outerwear')
await page.waitForTimeout(400)
await page.screenshot({ path: join(OUT, 'scene-mobile-select.png'), fullPage: true })
console.log('[shots] scene-mobile-select.png')

await browser.close()

const back = await api(`/api/plans/${planId}`)
console.log(
  '[shots] 复原检查：',
  JSON.stringify(back.slots.map((s) => s.item?.productId ?? null)) === JSON.stringify(ids0) ? '商品一致 ✅' : '商品不一致 ⚠️',
  '| 场景',
  back.sceneView?.spec?.label,
)
