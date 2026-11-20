/**
 * P9 交付截图（只读：不建方案、不调图像 API）
 *
 * 输出 shots/p9/：
 *   home-1440.png / home-390.png          首页（含灵感外链）
 *   plan-1440.png / plan-390.png          购物页首屏（聊天字号 / 舞台）
 *   plan-390-shop.png                     移动端清单视图
 *   report.json                           字号、溢出、JS 报错、外链
 *
 * 用法：node scripts/shot-p9.mjs [base] [planId]
 */
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8790'
const PLAN = process.argv[3] ?? 'pln_020'
const OUT = 'shots/p9'
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))

const report = { base: BASE, plan: PLAN, shots: [], errors: [], checks: {} }
const browser = await chromium.launch({ executablePath: EDGE, headless: true })

/** 等图真的画出来（空数组也会 every(complete)=true，所以必须同时要求张数） */
async function waitImages(page, min = 1) {
  await page
    .waitForFunction(
      (n) => {
        const imgs = [...document.images].filter((i) => i.offsetParent !== null)
        return imgs.length >= n && imgs.every((i) => i.complete && i.naturalWidth > 0)
      },
      min,
      { timeout: 25000 },
    )
    .catch(() => {})
  await page.waitForTimeout(600)
}

const probe = (label) => ({
  label,
  viewport: { w: innerWidth, h: innerHeight },
  overflowX: document.documentElement.scrollWidth - innerWidth,
  bubble: (() => {
    const el = document.querySelector('.bubble.assistant') ?? document.querySelector('.bubble')
    if (!el) return null
    const cs = getComputedStyle(el)
    return { fontSize: cs.fontSize, lineHeight: cs.lineHeight, padding: cs.padding }
  })(),
  input: (() => {
    const el = document.querySelector('#chat-input')
    if (!el) return null
    const cs = getComputedStyle(el)
    return { fontSize: cs.fontSize, lineHeight: cs.lineHeight }
  })(),
  stageImg: (() => {
    const el = document.querySelector('#stage-img')
    if (!el || el.hidden) return null
    const b = el.getBoundingClientRect()
    return { src: (el.getAttribute('src') ?? '').split('/').pop(), w: Math.round(b.width), h: Math.round(b.height) }
  })(),
  share: !!document.querySelector('#btn-share'),
})

/* ---------------------------------------------------------------- 首页 */
for (const vp of [
  { w: 1440, h: 900, name: '1440' },
  { w: 390, h: 844, name: '390' },
]) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } })
  page.on('pageerror', (e) => report.errors.push(`home-${vp.name}: ${e}`))
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await waitImages(page, 1)
  const info = await page.evaluate(
    (name) => ({
      label: `home-${name}`,
      viewport: { w: innerWidth, h: innerHeight },
      overflowX: document.documentElement.scrollWidth - innerWidth,
      hero: (() => {
        const img = document.querySelector('.hero-media img')
        if (!img) return null
        return { currentSrc: (img.currentSrc || '').split('/').pop(), natural: [img.naturalWidth, img.naturalHeight] }
      })(),
      chips: [...document.querySelectorAll('.chip-pair')].map((el) => ({
        word: el.querySelector('[data-preset]')?.innerText?.trim() ?? '',
        href: el.querySelector('a.inspo')?.href ?? null,
      })),
    }),
    vp.name,
  )
  report.checks[`home-${vp.name}`] = info
  await page.screenshot({ path: join(OUT, `home-${vp.name}.png`), fullPage: false })
  report.shots.push(`home-${vp.name}.png`)
  await page.close()
}

/* -------------------------------------------------------------- 购物页 */
for (const vp of [
  { w: 1440, h: 900, name: '1440' },
  { w: 390, h: 844, name: '390' },
]) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } })
  page.on('pageerror', (e) => report.errors.push(`plan-${vp.name}: ${e}`))
  await page.goto(`${BASE}/?plan=${PLAN}`, { waitUntil: 'domcontentloaded' })
  // 移动端默认停在对话 tab，舞台是隐藏的：切到「搭配」才看得到图和热点
  // （必须等 boot() 里的 setTab 跑完再点，否则点了会被它覆盖回 chat）
  if (vp.name === '390') {
    await page.waitForTimeout(1800)
    await page.click('[data-tab="plan"]').catch(() => {})
    await page.waitForTimeout(600)
  }
  await page.waitForSelector('#stage-img:not([hidden])', { timeout: 25000 }).catch(() => {})
  await waitImages(page, 2)
  report.checks[`plan-${vp.name}`] = await page.evaluate(probe, `plan-${vp.name}`)
  await page.screenshot({ path: join(OUT, `plan-${vp.name}.png`) })
  report.shots.push(`plan-${vp.name}.png`)

  if (vp.name === '390') {
    await page.click('[data-tab="shop"]').catch(() => {})
    await page.waitForTimeout(800)
    await waitImages(page, 2)
    report.checks['plan-390-shop'] = await page.evaluate(probe, 'plan-390-shop')
    await page.screenshot({ path: join(OUT, 'plan-390-shop.png') })
    report.shots.push('plan-390-shop.png')
  }
  await page.close()
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(`[shot:p9] 截图 ${report.shots.length} 张 → ${OUT}/`)
console.log(`[shot:p9] JS 报错 ${report.errors.length} 条 ${report.errors.slice(0, 3).join(' | ')}`)
for (const [k, v] of Object.entries(report.checks)) console.log(`  · ${k} overflow=${v.overflowX} bubble=${v.bubble?.fontSize ?? '-'} input=${v.input?.fontSize ?? '-'}`)
await browser.close()
