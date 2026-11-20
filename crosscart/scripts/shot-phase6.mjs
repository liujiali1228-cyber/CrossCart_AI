/**
 * Phase 6 · 消费者端体验改造：首屏与关键页面截图（只读，不建方案、不调图像 API）
 *
 * 输出 shots/phase6/：
 *   1440x900 / 1366x768 / 1920x1080 的方案页首屏 + 偏好页
 *   390x844 移动端三个 tab
 *   report.json：首屏可见性、横向溢出、JS 错误
 */
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8790'
const PLAN = process.argv[3] ?? 'pln_020'
const OUT = 'shots/phase6'
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))

const report = { base: BASE, plan: PLAN, shots: [], errors: [], checks: {} }
const browser = await chromium.launch({ executablePath: EDGE, headless: true })

const probe = () => {
  const r = (sel) => {
    const el = document.querySelector(sel)
    if (!el || el.hidden || el.offsetParent === null) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }
  }
  return {
    viewport: { w: innerWidth, h: innerHeight },
    overflowX: document.documentElement.scrollWidth - innerWidth,
    pageScrollY: Math.round(scrollY),
    title: document.querySelector('#plan-title')?.innerText ?? null,
    sub: document.querySelector('#plan-sub')?.innerText ?? null,
    composer: r('#composer'),
    chatInput: r('#chat-input'),
    messages: r('#messages'),
    stage: r('#stage-frame'),
    chips: [...document.querySelectorAll('.slot-chip')].map((el) => ({
      text: el.innerText.replace(/\n/g, ' '),
      ...r(`.slot-chip[data-select="${el.dataset.select}"]`),
    })),
    chipsBox: r('#slot-chips'),
    shopFirst: r('#shop-list .shop-item'),
    money: r('#money-total'),
    channels: r('#btn-channels'),
    constraintBtn: r('#btn-edit-plan'),
    budgetChip: (() => {
      const el = document.querySelector('#budget-chip')
      return el ? { hidden: el.hidden, text: el.innerText } : null
    })(),
    hotspotNote: (() => {
      const el = document.querySelector('#hotspot-note')
      return el ? { hidden: el.hidden, text: el.innerText } : null
    })(),
    hotspots: [...document.querySelectorAll('.hotspot')].map((el) => ({
      op: getComputedStyle(el).opacity,
      label: el.innerText,
      border: getComputedStyle(el).borderTopWidth,
    })),
    quick: [...document.querySelectorAll('.qa-chip')].map((el) => el.innerText.replace(/\n/g, ' ')),
    suggestToggle: !!document.querySelector('[data-suggest-toggle]'),
  }
}

/* ---------- 桌面三档 ---------- */
for (const [w, h] of [
  [1440, 900],
  [1366, 768],
  [1920, 1080],
]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  page.on('pageerror', (e) => report.errors.push(`plan ${w} pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(`plan ${w} console: ${m.text()}`)
  })
  await page.goto(`${BASE}/?plan=${PLAN}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#stage-img:not([hidden])', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1600)
  const data = await page.evaluate(probe)
  await page.screenshot({ path: join(OUT, `plan-${w}x${h}.png`) })
  report.shots.push(`plan-${w}x${h}.png`)
  report.checks[`plan-${w}x${h}`] = data

  // 展开「调整约束」，确认面板不遮挡人物图
  await page.click('#btn-edit-plan')
  await page.waitForTimeout(350)
  const open = await page.evaluate(() => {
    const bar = document.querySelector('#constraint-bar')
    const stage = document.querySelector('#stage-frame').getBoundingClientRect()
    return {
      visible: !bar.hidden,
      barBottom: Math.round(bar.getBoundingClientRect().bottom),
      stageTop: Math.round(stage.top),
      expanded: document.querySelector('#btn-edit-plan').getAttribute('aria-expanded'),
    }
  })
  await page.screenshot({ path: join(OUT, `plan-${w}x${h}-constraints.png`) })
  report.checks[`plan-${w}x${h}-constraints`] = open
  await page.close()
}

/* ---------- 首页（我的方案 + 我的偏好） ---------- */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => report.errors.push(`home pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(`home console: ${m.text()}`)
  })
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  await page.locator('#plans').scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 'home-plans-1440.png') })
  const prefs = await page.evaluate(() => {
    const box = document.querySelector('#prefs')
    return {
      text: box.innerText.replace(/\s+/g, ' ').slice(0, 400),
      hasHistory: !!document.querySelector('#pref-history'),
      hasMechanism: /可以在对话|变更记录|写进方案状态|确认后才会参与推荐/.test(box.innerText),
      height: Math.round(box.getBoundingClientRect().height),
    }
  })
  report.checks.homePrefs = prefs
  await page.locator('#prefs').scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 'home-prefs-1440.png') })
  report.shots.push('home-prefs-1440.png')
  await page.close()
}

/* ---------- 390 移动端 ---------- */
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.on('pageerror', (e) => report.errors.push(`390 pageerror: ${e.message}`))
  await page.goto(`${BASE}/?plan=${PLAN}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#stage-img:not([hidden])', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1500)
  const plan = await page.evaluate(probe)
  await page.screenshot({ path: join(OUT, 'plan-390x844.png') })
  report.checks['plan-390x844'] = plan
  await page.click('[data-tab="shop"]')
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(OUT, 'shop-390x844.png') })
  const shop = await page.evaluate(probe)
  report.checks['shop-390x844'] = shop
  await page.close()
}

await browser.close()
report.shots.push('plan-390x844.png', 'shop-390x844.png')
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1))
console.log(JSON.stringify({ errors: report.errors, checks: Object.keys(report.checks) }, null, 1))
