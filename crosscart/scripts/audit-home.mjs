/**
 * Phase 4.1-A · 首页现状量测（只读）
 * 量 Hero 容器/图片实际尺寸与裁切、首屏与灵感区的关系、溢出与输入框尺寸。
 * 只读：不点击、不提交、不调用任何写接口。
 */
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8790'
const OUT = 'shots/audit-home'
mkdirSync(OUT, { recursive: true })

const VIEWPORTS = [
  { name: 'home-audit-1440', viewport: { width: 1440, height: 900 } },
  { name: 'home-audit-1280', viewport: { width: 1280, height: 800 } },
  { name: 'home-audit-390', viewport: { width: 390, height: 844 } },
]

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const errors = []
const report = []

for (const { name, viewport } of VIEWPORTS) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => errors.push(`${name} · pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} · console: ${m.text()}`) })
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  const m = await page.evaluate(() => {
    const r = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
        bottom: Math.round(b.bottom), right: Math.round(b.right),
      }
    }
    const q = (s) => document.querySelector(s)
    const heroMedia = q('#hero-media')
    const img = q('#hero-media img')
    const ib = img ? img.getBoundingClientRect() : null
    // 图片按 object-fit: cover 实际可见区域（容器内）与原始比例
    const nat = img ? { w: img.naturalWidth, h: img.naturalHeight } : null
    const boxRatio = ib ? +(ib.width / ib.height).toFixed(3) : null
    const natRatio = nat ? +(nat.w / nat.h).toFixed(3) : null
    const insp = [...document.querySelectorAll('.insp')].map((el) => r(el))
    return {
      vw: innerWidth,
      vh: innerHeight,
      navH: r(q('.topbar'))?.h,
      hero: r(q('.hero')),
      heroCopy: r(q('.hero-copy')),
      h1: r(q('.hero h1')),
      h1Font: q('.hero h1') ? getComputedStyle(q('.hero h1')).fontSize : null,
      heroMedia: r(heroMedia),
      heroMediaClass: heroMedia?.className ?? null,
      heroImg: ib ? { ...r(img), objectFit: getComputedStyle(img).objectFit, objectPosition: getComputedStyle(img).objectPosition } : null,
      heroImgSrc: img?.getAttribute('src') ?? null,
      heroImgNat: nat,
      heroImgBoxRatio: boxRatio,
      heroImgNatRatio: natRatio,
      heroFigcaption: q('#hero-media figcaption')?.textContent?.trim() ?? null,
      ask: r(q('#ask')),
      chips: r(q('#hero-chips')),
      chipCount: document.querySelectorAll('#hero-chips button').length,
      discover: r(q('#discover')),
      discoverHead: r(q('#discover .section-head')),
      inspCount: insp.length,
      insp,
      inspGridCols: q('#insp-grid') ? getComputedStyle(q('#insp-grid')).gridTemplateColumns : null,
      plans: r(q('#plans')),
      prefs: r(q('#prefs')),
      docScrollH: document.documentElement.scrollHeight,
      overflowX: document.documentElement.scrollWidth - innerWidth,
      heroBottomToFold: r(q('.hero')) ? Math.round(r(q('.hero')).bottom - innerHeight) : null,
      discoverTopFromFold: r(q('#discover')) ? Math.round(r(q('#discover')).y - innerHeight) : null,
      firstInspVisiblePx: insp[0] ? Math.max(0, Math.min(innerHeight, insp[0].bottom) - insp[0].y) : 0,
    }
  })

  await page.screenshot({ path: join(OUT, `${name}.png`) })
  // 首屏截图（不滚动）与整页
  report.push({ name, viewport, ...m })
  await page.close()
}

await browser.close()
writeFileSync(join(OUT, 'audit.json'), JSON.stringify({ report, errors }, null, 1))
console.log(JSON.stringify(report.map((r) => ({
  name: r.name,
  vw: r.vw, vh: r.vh, navH: r.navH,
  hero: r.hero, heroMedia: r.heroMedia, h1: r.h1, h1Font: r.h1Font,
  imgNat: r.heroImgNat, imgBox: r.heroImg, boxRatio: r.heroImgBoxRatio, natRatio: r.heroImgNatRatio,
  ask: r.ask, discover: r.discover, inspCount: r.inspCount, insp0: r.insp[0],
  inspGridCols: r.inspGridCols, docScrollH: r.docScrollH, overflowX: r.overflowX,
  discoverTopFromFold: r.discoverTopFromFold, firstInspVisiblePx: r.firstInspVisiblePx,
})), null, 1))
if (errors.length) console.log('ERRORS:', errors)
