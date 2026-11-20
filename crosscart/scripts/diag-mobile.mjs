import { chromium } from 'playwright-core'
const b = await chromium.launch({ channel: 'msedge', headless: true })
const p = await b.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
await p.goto('http://127.0.0.1:8790/?plan=pln_001', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(1500)
await p.click('[data-tab="plan"]')
await p.waitForTimeout(1200)
const d = await p.evaluate(() => {
  const frame = document.querySelector('#stage-frame').getBoundingClientRect()
  const out = { frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height }, vp: { w: innerWidth, h: innerHeight }, items: [] }
  for (const el of document.querySelectorAll('.hotspot')) {
    const r = el.getBoundingClientRect()
    el.scrollIntoView({ block: 'center' })
    const r2 = el.getBoundingClientRect()
    const px = r2.x + r2.width / 2, py = r2.y + r2.height / 2
    const top = document.elementFromPoint(px, py)
    out.items.push({
      slot: el.dataset.hot ?? el.dataset.unsure,
      rect: { x: Math.round(r2.x), y: Math.round(r2.y), w: Math.round(r2.width), h: Math.round(r2.height) },
      center: { px: Math.round(px), py: Math.round(py) },
      topEl: top ? `${top.tagName}.${String(top.className).slice(0, 30)} data-hot=${top.dataset?.hot ?? ''}` : 'null',
      paneScroll: document.querySelector('#pane-plan')?.scrollTop,
    })
  }
  return out
})
console.log(JSON.stringify(d, null, 1))
await b.close()
