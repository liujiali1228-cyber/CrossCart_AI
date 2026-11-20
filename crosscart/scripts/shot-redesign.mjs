/**
 * 改版截图 + 量尺寸：首页 / 场景购物页 / 分类候选抽屉，桌面 + 移动端。
 * 只读：不换件、不切场景、不调用图像 API。
 */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8790'
const PLAN = process.argv[3] ?? 'pln_020'
const OUT = 'shots/redesign'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const errors = []
const report = []

async function shot(name, path, viewport, opts = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => errors.push(`${name} · pageerror: ${e}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${name} · console: ${m.text()}`)
  })
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
  if (opts.tab) {
    await page.click(`[data-tab="${opts.tab}"]`)
    await page.waitForTimeout(1000)
  }
  if (opts.slot) {
    await page.click(`.slot-chip[data-select="${opts.slot}"]`)
    await page.waitForSelector('.cand', { timeout: 20000 })
    await page.waitForTimeout(2600)
  }
  const metrics = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        bottom: Math.round(r.bottom), visible: r.width > 0 && r.height > 0,
      }
    }
    return {
      vw: innerWidth,
      vh: innerHeight,
      frame: box('#stage-frame'),
      chips: box('#slot-chips'),
      title: box('#plan-title'),
      drawer: box('#swap'),
      cats: [...document.querySelectorAll('.slot-chip')].map((el) => Math.round(el.getBoundingClientRect().height)),
      docScrollH: document.documentElement.scrollHeight,
    }
  })
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  await page.close()
  report.push({ name, path, viewport, ...metrics })
  return metrics
}

await shot('home-1440', '/', { width: 1440, height: 900 })
await shot('home-390', '/', { width: 390, height: 844 })
await shot('scene-1440', `/?plan=${PLAN}`, { width: 1440, height: 900 })
await shot('scene-1280', `/?plan=${PLAN}`, { width: 1280, height: 800 })
await shot('scene-390', `/?plan=${PLAN}`, { width: 390, height: 844, isMobile: false }, { tab: 'plan' })
await shot('scene-drawer-1440', `/?plan=${PLAN}`, { width: 1440, height: 900 }, { slot: 'top' })
await shot('scene-drawer-390', `/?plan=${PLAN}`, { width: 390, height: 844 }, { tab: 'plan', slot: 'top' })

await browser.close()
console.log(JSON.stringify({ report, errors }, null, 1))
