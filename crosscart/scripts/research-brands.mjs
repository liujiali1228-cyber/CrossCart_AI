/**
 * Phase 4.1-A · 品牌官网视觉取证（只读，仅用于设计参考）
 * 打开首页 → 截 1440×900 首屏 + 全页 → 抽取导航高度/标题/Hero 图尺寸/字体/配色。
 * 不下载图片到项目内（图片仅以远端 URL 形式记录）。
 */
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'shots/research'
mkdirSync(OUT, { recursive: true })

const TARGETS = [
  { id: 'toteme', url: 'https://toteme.com/', note: '第一优先级' },
  { id: 'cos', url: 'https://www.cos.com/', note: '' },
  { id: 'therow', url: 'https://www.therow.com/', note: '' },
  { id: 'lemaire', url: 'https://www.lemaire.fr/', note: '' },
  { id: 'massimodutti', url: 'https://www.massimodutti.com/', note: '' },
  { id: 'arket', url: 'https://www.arket.com/', note: '' },
  { id: 'netaporter', url: 'https://www.net-a-porter.com/', note: '' },
]

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--disable-blink-features=AutomationControlled'],
})
const results = []

for (const t of TARGETS) {
  const rec = { id: t.id, url: t.url, ok: false, blocked: null, error: null, facts: null }
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  })
  const page = await ctx.newPage()
  try {
    const resp = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    rec.status = resp?.status() ?? null
    rec.finalUrl = page.url()
    await page.waitForTimeout(6000)
    // 轻微滚动触发懒加载，再回到顶部，保证首屏图真的解码出来
    await page.evaluate(() => window.scrollTo(0, 600))
    await page.waitForTimeout(1500)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(1200)

    rec.facts = await page.evaluate(() => {
      const vw = innerWidth
      const vh = innerHeight
      const txt = (el) => (el ? (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160) : null)
      const rect = (el) => {
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }
      }
      // 首屏内面积最大的图片（大概率是 hero）
      const imgs = [...document.querySelectorAll('img, picture img')]
        .map((el) => {
          const b = el.getBoundingClientRect()
          return {
            src: el.currentSrc || el.src,
            alt: el.alt || '',
            nat: { w: el.naturalWidth, h: el.naturalHeight },
            rect: rect(el),
            area: Math.max(0, Math.min(b.bottom, vh) - b.top) * b.width,
            fit: getComputedStyle(el).objectFit,
            pos: getComputedStyle(el).objectPosition,
          }
        })
        .filter((i) => i.rect && i.rect.w > 80 && i.rect.h > 80 && i.nat.w > 0)
        .sort((a, b) => b.area - a.area)
      const hero = imgs[0] ?? null
      const nav = document.querySelector('header, nav, [role="banner"]')
      const navRect = rect(nav)
      const h1 = document.querySelector('h1')
      const bigText = [...document.querySelectorAll('h1,h2,h3,p,span,a')]
        .map((el) => ({ el, fs: parseFloat(getComputedStyle(el).fontSize) }))
        .filter((x) => x.fs >= 24 && x.el.getBoundingClientRect().width > 100)
        .sort((a, b) => b.fs - a.fs)[0]
      const cs = getComputedStyle(document.body)
      const fontOf = (el) => (el ? getComputedStyle(el).fontFamily : null)
      return {
        title: document.title,
        vw, vh,
        bodyFont: cs.fontFamily,
        bodyBg: cs.backgroundColor,
        bodyColor: cs.color,
        navRect,
        navText: txt(nav),
        h1: h1 ? { text: txt(h1), rect: rect(h1), font: fontOf(h1), size: getComputedStyle(h1).fontSize, weight: getComputedStyle(h1).fontWeight, color: getComputedStyle(h1).color } : null,
        biggestText: bigText ? { text: txt(bigText.el), size: getComputedStyle(bigText.el).fontSize, font: fontOf(bigText.el), tag: bigText.el.tagName, rect: rect(bigText.el) } : null,
        hero,
        imgCount: imgs.length,
        topImgs: imgs.slice(0, 4),
        docScrollH: document.documentElement.scrollHeight,
      }
    })
    rec.ok = true
    await page.screenshot({ path: join(OUT, `${t.id}-1440.png`) })
    try {
      await page.screenshot({ path: join(OUT, `${t.id}-full.png`), fullPage: true })
    } catch (e) {
      rec.fullPageError = String(e.message).slice(0, 120)
    }
  } catch (e) {
    rec.error = String(e.message).slice(0, 300)
    if (/403|429|Access Denied|blocked|captcha/i.test(rec.error)) rec.blocked = true
  }
  await ctx.close()
  results.push(rec)
  console.log(`--- ${t.id}: ok=${rec.ok} status=${rec.status ?? '-'} ${rec.error ?? ''}`)
  if (rec.facts) {
    console.log(`    hero=${rec.facts.hero ? `${rec.facts.hero.nat.w}x${rec.facts.hero.nat.h} @${rec.facts.hero.rect.w}x${rec.facts.hero.rect.h} fit=${rec.facts.hero.fit}` : 'none'}`)
    console.log(`    nav=${rec.facts.navRect?.h} h1=${rec.facts.h1?.text?.slice(0, 60) ?? '-'} font=${rec.facts.h1?.font?.slice(0, 50) ?? '-'}`)
  }
}

await browser.close()
writeFileSync(join(OUT, 'brands.json'), JSON.stringify(results, null, 1))
