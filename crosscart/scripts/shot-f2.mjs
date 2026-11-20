/**
 * F2 视觉验收：候选项里的「偏好为什么推荐它」。
 *
 * 需要先起一个隔离实例（不污染真实数据）：
 *   CROSSCART_DATA_DIR=.tmp/f2ui CROSSCART_PORT=8791 node packages/bridge/src/server.mjs
 *   node scripts/shot-f2.mjs http://127.0.0.1:8791
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8791'
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))

mkdirSync('shots/f2', { recursive: true })
const browser = await chromium.launch({ executablePath: EDGE, headless: true })

for (const [w, h, tag] of [
  [1440, 900, 'desktop'],
  [390, 844, 'mobile'],
]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${BASE}/?plan=pln_020`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#stage', { state: 'attached', timeout: 25000 })
  await page.waitForTimeout(1800)

  if (w < 720) {
    await page.click('[data-tab="plan"]')
    await page.waitForTimeout(800)
    // 移动端类目行可能在首屏之外，直接触发（布局不动，只点按钮）
    await page.evaluate(() => document.querySelector('[data-select="shoes"]')?.click())
  } else {
    await page.click('[data-select="shoes"]')
  }
  await page.waitForSelector('#swap:not([hidden])', { timeout: 10000 })
  await page.waitForSelector('#candidates .cand', { timeout: 15000 })
  await page.waitForTimeout(600)

  await page.screenshot({ path: `shots/f2/swap-${tag}.png` })
  const drawer = await page.$('#swap')
  if (drawer) await drawer.screenshot({ path: `shots/f2/drawer-${tag}.png` })

  const info = await page.evaluate(() => ({
    prefNote: document.querySelector('.cand-prefnote')?.innerText?.replace(/\n/g, ' | ') ?? null,
    prefFlags: [...document.querySelectorAll('.cand-flag.pref')].slice(0, 4).map((e) => e.textContent.trim()),
    cands: document.querySelectorAll('#candidates .cand').length,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  console.log(tag, JSON.stringify(info), 'jsErrors=', errors.length)
  await page.close()
}

await browser.close()
console.log('shots → shots/f2/')
