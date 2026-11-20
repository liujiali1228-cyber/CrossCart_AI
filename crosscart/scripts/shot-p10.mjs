/**
 * P10 交付截图（真实实例 8790，零生成费用）：
 *   1) 正常方案页（确认「没有任何弹窗」）
 *   2) 换件后的轻量提示条（1440 / 390）
 * 做法：复制基线 pln_020 → 在副本上换件 → 截图 → 删掉副本。基线一行不改，也不触发任何生图。
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8790'
const OUT = join(process.cwd(), 'shots', 'p10')
mkdirSync(OUT, { recursive: true })
const api = async (p, o = {}) => (await fetch(`${BASE}${p}`, { headers: { 'content-type': 'application/json' }, ...o })).json()
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b ?? {}) })

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))

const copy = await post('/api/plans/pln_020/duplicate')
const planId = copy.planId
console.log('副本方案', planId)

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/?plan=${planId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#stage')
  await page
    .waitForFunction(
      () => {
        const t = document.querySelector('#plan-title')?.textContent ?? ''
        const img = document.querySelector('#stage-img')
        return t && !t.includes('加载中') && img && !img.hidden && img.naturalWidth > 0
      },
      { timeout: 60000 },
    )
    .catch(() => console.log('⚠ 场景图未就绪（截图会显示真实状态）'))
  await page.waitForTimeout(900)
  const dialogs = await page.evaluate(() => ({
    modal: !!document.querySelector('#confirm-modal'),
    overlayHidden: document.querySelector('#stage-overlay')?.hidden,
    overlayText: document.querySelector('#stage-overlay')?.innerText ?? '',
  }))
  console.log('正常态：', JSON.stringify(dialogs))
  await page.screenshot({ path: join(OUT, 'plan-clean-1440.png') })

  // 换一件（只改清单，不生图）
  const vm = await api(`/api/plans/${planId}`)
  const slot = vm.slots.find((s) => s.item && !s.locked)?.slot ?? 'shoes'
  const sw = await post(`/api/plans/${planId}/swap`, { slot, strategy: 'cheaper', by: 'ui' })
  console.log('换件', slot, '→', sw.slots?.find((s) => s.slot === slot)?.item?.title)
  await page.waitForFunction(() => /搭配已更新/.test(document.querySelector('#stage-overlay')?.innerText ?? ''), { timeout: 20000 })
  await page.waitForTimeout(500)
  const strip = await page.evaluate(() => {
    const el = document.querySelector('#stage-overlay')
    const b = el?.querySelector('button')?.getBoundingClientRect()
    return { cls: el?.className, text: el?.innerText, hidden: el?.hidden, btn: b ? { w: Math.round(b.width), h: Math.round(b.height) } : null }
  })
  console.log('提示条：', JSON.stringify(strip))
  await page.screenshot({ path: join(OUT, 'plan-stale-1440.png') })

  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const m = await mctx.newPage()
  await m.goto(`${BASE}/?plan=${planId}`, { waitUntil: 'domcontentloaded' })
  await m.waitForSelector('#stage', { state: 'attached' })
  // 移动端默认停在第 1 个页签：点底部的「搭配」才看得到图与提示条
  // 会话记录加载完会把页签复位到「对话」，所以先等它渲染完再切
  await m.waitForTimeout(2500)
  await m.click('#tabbar [data-tab="plan"]')
  await m.waitForTimeout(1800)
  console.log(
    '390 状态：',
    JSON.stringify(
      await m.evaluate(() => ({
        tab: document.querySelector('#tabbar .active')?.dataset.tab ?? null,
        stageBox: (() => {
          const b = document.querySelector('#stage')?.getBoundingClientRect()
          return b ? { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) } : null
        })(),
        imgHidden: document.querySelector('#stage-img')?.hidden ?? null,
        strip: document.querySelector('#stage-overlay')?.innerText ?? '',
      })),
    ),
  )
  await m.screenshot({ path: join(OUT, 'plan-stale-390.png') })
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  console.log('390 横向溢出', overflow, 'px')
} finally {
  await browser.close()
  await fetch(`${BASE}/api/plans/${planId}`, { method: 'DELETE' }).catch(() => {})
  console.log('已删除副本方案', planId)
}
