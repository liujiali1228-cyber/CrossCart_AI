/** Phase 4.1-A · 补充取证：TOTEME 移动端 + 系列/编辑页 */
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'shots/research'
mkdirSync(OUT, { recursive: true })

const TARGETS = [
  { id: 'toteme-390', url: 'https://toteme.com/en-us', viewport: { width: 390, height: 844 }, mobile: true },
  { id: 'toteme-newin-1440', url: 'https://toteme.com/en-us/collections/new-in', viewport: { width: 1440, height: 900 } },
  { id: 'toteme-journal-1440', url: 'https://toteme.com/en-us/blogs/journal', viewport: { width: 1440, height: 900 } },
]

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-blink-features=AutomationControlled'] })
const out = []

for (const t of TARGETS) {
  const rec = { id: t.id, url: t.url, ok: false, status: null, error: null }
  const ctx = await browser.newContext({
    viewport: t.viewport, deviceScaleFactor: 1, locale: 'en-US',
    isMobile: !!t.mobile, hasTouch: !!t.mobile,
    userAgent: t.mobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  })
  const page = await ctx.newPage()
  try {
    const resp = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    rec.status = resp?.status() ?? null
    await page.waitForTimeout(5000)
    await page.evaluate(() => window.scrollTo(0, 500))
    await page.waitForTimeout(1500)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(1200)
    rec.facts = await page.evaluate(() => {
      const vh = innerHeight, vw = innerWidth
      const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) } }
      const imgs = [...document.querySelectorAll('img')].map((el) => {
        const b = el.getBoundingClientRect()
        return { src: (el.currentSrc || el.src || '').slice(0, 160), alt: el.alt || '', nat: { w: el.naturalWidth, h: el.naturalHeight }, rect: rect(el), fit: getComputedStyle(el).objectFit,
          area: Math.max(0, Math.min(b.bottom, vh) - b.top) * b.width }
      }).filter((i) => i.rect && i.rect.w > 60 && i.rect.h > 60 && i.nat.w > 0).sort((a, b) => b.area - a.area)
      // 图片网格：同一行里等宽的卡片（判断 3/4 列）
      const grids = [...document.querySelectorAll('ul,div')].map((el) => {
        const cs = getComputedStyle(el)
        if (!/grid|flex/.test(cs.display)) return null
        const kids = [...el.children]
        if (kids.length < 3) return null
        const rs = kids.slice(0, 6).map((k) => rect(k)).filter(Boolean)
        return { display: cs.display, cols: cs.gridTemplateColumns, n: kids.length, first: rs[0] }
      }).filter((g) => g && g.first && g.first.w > 100 && g.first.w < 700).slice(0, 4)
      const nav = document.querySelector('header')
      return {
        vw, vh,
        nav: rect(nav),
        navBg: nav ? getComputedStyle(nav).backgroundColor : null,
        imgs: imgs.slice(0, 5),
        grids,
        docScrollH: document.documentElement.scrollHeight,
        textTop: (document.querySelector('h1,h2')?.innerText || '').slice(0, 80),
      }
    })
    rec.ok = true
    await page.screenshot({ path: join(OUT, `${t.id}.png`) })
    await page.screenshot({ path: join(OUT, `${t.id}-full.png`), fullPage: true }).catch(() => {})
  } catch (e) { rec.error = String(e.message).slice(0, 200) }
  await ctx.close()
  out.push(rec)
  console.log(`${t.id}: ok=${rec.ok} status=${rec.status} ${rec.error ?? ''}`)
  if (rec.facts) console.log('   nav', JSON.stringify(rec.facts.nav), 'imgs', rec.facts.imgs.length, 'docH', rec.facts.docScrollH)
}

await browser.close()
writeFileSync(join(OUT, 'brands2.json'), JSON.stringify(out, null, 1))
