import { chromium } from 'playwright-core'

const b = await chromium.launch({ channel: 'msedge', headless: true })
for (const vp of [{ width: 1440, height: 1040 }, { width: 1280, height: 900 }]) {
  const page = await b.newPage({ viewport: vp })
  await page.goto('http://127.0.0.1:8790/?plan=pln_001', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#stage-img:not([hidden])', { timeout: 20000 })
  await page.waitForTimeout(1500)
  const info = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        sel,
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        css: {
          width: cs.width, height: cs.height, maxWidth: cs.maxWidth, maxHeight: cs.maxHeight,
          aspectRatio: cs.aspectRatio, objectFit: cs.objectFit, display: cs.display,
          flex: cs.flex, position: cs.position, overflow: cs.overflow,
          padding: cs.padding, margin: cs.margin, minHeight: cs.minHeight,
        },
      }
    }
    return {
      vp: { w: innerWidth, h: innerHeight },
      nodes: ['#stage', '.stage-frame', '#stage-frame', '#stage-img', '.stage-wrap', '#stage-note', '.stage-overlay'].map(pick),
      imgNatural: (() => { const i = document.querySelector('#stage-img'); return i ? { nw: i.naturalWidth, nh: i.naturalHeight, src: i.getAttribute('src'), complete: i.complete } : null })(),
      // 从 #stage 往上找所有祖先的尺寸，定位是谁把高度框死的
      chain: (() => {
        const out = []
        let el = document.querySelector('#stage-frame') ?? document.querySelector('#stage')
        while (el && el !== document.body) {
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          out.push({ tag: el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ').slice(0, 2).join('.') : ''), w: Math.round(r.width), h: Math.round(r.height), display: cs.display, flex: cs.flex, h0: cs.height, ar: cs.aspectRatio })
          el = el.parentElement
        }
        return out
      })(),
    }
  })
  console.log(JSON.stringify(info, null, 2))
  await page.screenshot({ path: `shots/fix/${vp.width}-before.png` })
  await page.close()
}
await b.close()
