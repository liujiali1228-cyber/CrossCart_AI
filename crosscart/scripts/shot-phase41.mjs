/**
 * Phase 4.1-B · 首页改版截图 + 几何量测（只读，不提交、不生成图片）
 * B 版：1440×900 / 1280×800 / 390×844
 * A 版对照：/?hero=a @1440×900
 * 另外记录本轮前后的图像预算快照，用于证明零增量。
 */
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8790'
const OUT = 'shots/phase41'
mkdirSync(OUT, { recursive: true })

const budget = async () => (await fetch(`${BASE}/api/scenes/budget`)).json()

const before = await budget()

const TARGETS = [
  { name: 'B-home-1440', path: '/', viewport: { width: 1440, height: 900 } },
  { name: 'B-home-1280', path: '/', viewport: { width: 1280, height: 800 } },
  { name: 'B-home-390', path: '/', viewport: { width: 390, height: 844 } },
  { name: 'A-home-1440', path: '/?hero=a', viewport: { width: 1440, height: 900 } },
]

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const errors = []
const report = []

async function measure(page) {
  return page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
        bottom: Math.round(b.bottom), right: Math.round(b.right),
      }
    }
    const img = document.querySelector('#hero-media img')
    const ib = img?.getBoundingClientRect()
    const insp = [...document.querySelectorAll('.insp')].map((el) => {
      const b = el.getBoundingClientRect()
      return { y: Math.round(b.y), bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }
    })
    return {
      vw: innerWidth,
      vh: innerHeight,
      navH: box('.topbar')?.h,
      hero: box('.hero'),
      heroCopy: box('.hero-copy'),
      h1: box('.hero h1'),
      h1Font: document.querySelector('.hero h1') && getComputedStyle(document.querySelector('.hero h1')).fontSize,
      heroMedia: box('#hero-media'),
      img: ib
        ? {
            ...box('#hero-media img'),
            nat: { w: img.naturalWidth, h: img.naturalHeight },
            fit: getComputedStyle(img).objectFit,
            pos: getComputedStyle(img).objectPosition,
            src: (img.currentSrc || img.src).replace(location.origin, ''),
            renderedRatio: +(ib.width / ib.height).toFixed(3),
            naturalRatio: +(img.naturalWidth / img.naturalHeight).toFixed(3),
          }
        : null,
      ask: box('.ask'),
      askInput: (() => {
        const el = document.querySelector('#ask-input')
        return el ? { scrollW: el.scrollWidth, clientW: el.clientWidth } : null
      })(),
      chips: box('#hero-chips'),
      discover: box('#discover'),
      inspCount: insp.length,
      insp0: insp[0] ?? null,
      inspVisible: insp[0] ? Math.max(0, Math.round(Math.min(innerHeight, insp[0].bottom) - insp[0].y)) : 0,
      inspCols: getComputedStyle(document.querySelector('#insp-grid')).gridTemplateColumns,
      plans: box('#plans'),
      plansInfo: {
        cards: document.querySelectorAll('.plan-card').length,
        pending: document.querySelectorAll('#pending-list li').length,
        copiesShown: [...document.querySelectorAll('.plan-card h3')].filter((h) => /副本/.test(h.textContent)).length,
        count: document.querySelector('#plans-count')?.textContent.trim() ?? '',
      },
      inspTitles: [...document.querySelectorAll('.insp-cap b')].map((b) => b.textContent.trim()),
      proto: box('#proto'),
      prefs: box('#prefs'),
      docScrollH: document.documentElement.scrollHeight,
      overflowX: document.documentElement.scrollWidth - innerWidth,
    }
  })
}

for (const t of TARGETS) {
  const page = await browser.newPage({ viewport: t.viewport, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => errors.push(`${t.name} · pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${t.name} · console: ${m.text()}`) })
  await page.goto(BASE + t.path, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2600)
  const m = await measure(page)
  await page.screenshot({ path: join(OUT, `${t.name}.png`) })

  // 首屏 + 编辑精选 + 我的方案：滚动到 #discover 再截一张，便于单独审图
  if (t.name === 'B-home-1440' || t.name === 'B-home-1280') {
    await page.evaluate(() => document.querySelector('#discover').scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(OUT, `${t.name}-insp.png`) })
    if (t.name === 'B-home-1440') {
      await page.evaluate(() => document.querySelector('#plans').scrollIntoView({ block: 'start' }))
      await page.waitForTimeout(900)
      await page.screenshot({ path: join(OUT, 'B-home-1440-plans.png') })
      await page.evaluate(() => document.querySelector('#proto').scrollIntoView({ block: 'end' }))
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(OUT, 'B-home-1440-footer.png') })
    }
  }
  if (t.name === 'B-home-390') {
    await page.evaluate(() => document.querySelector('#discover').scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(OUT, 'B-home-390-insp.png') })
  }

  report.push({ name: t.name, path: t.path, viewport: t.viewport, ...m })
  await page.close()
}

await browser.close()
const after = await budget()

const summary = {
  budget: {
    spentBefore: before.budget?.spent,
    spentAfter: after.budget?.spent,
    delta: +(after.budget?.spent - before.budget?.spent).toFixed(4),
    logBefore: before.log?.length,
    logAfter: after.log?.length,
  },
  report,
  errors,
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(summary, null, 1))

for (const r of report) {
  console.log(`=== ${r.name} ${r.vw}x${r.vh}`)
  console.log(`  hero ${r.hero?.w}x${r.hero?.h} bottom=${r.hero?.bottom} | media ${r.heroMedia?.w}x${r.heroMedia?.h} bottom=${r.heroMedia?.bottom}`)
  console.log(`  img nat ${r.img?.nat?.w}x${r.img?.nat?.h} -> render ${r.img?.w}x${r.img?.h} ratio ${r.img?.renderedRatio} vs ${r.img?.naturalRatio} fit=${r.img?.fit} pos=${r.img?.pos}`)
  console.log(`  h1 ${r.h1Font} y=${r.h1?.y} | ask ${r.ask?.w}x${r.ask?.h} inputScroll ${r.askInput?.scrollW}/${r.askInput?.clientW}`)
  console.log(`  discover y=${r.discover?.y} (fold ${r.vw}x${r.vh}) | insp0 y=${r.insp0?.y} visible=${r.inspVisible}px cols=${r.inspCols}`)
  console.log(`  docH=${r.docScrollH} overflowX=${r.overflowX}`)
}
console.log('budget', JSON.stringify(summary.budget))
if (errors.length) console.log('ERRORS', errors)
