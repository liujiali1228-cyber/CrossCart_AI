import { chromium } from 'playwright-core'
const b = await chromium.launch({ channel: 'msedge', headless: true })
const p = await b.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
await p.goto('http://127.0.0.1:8790/?plan=pln_001', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(1500)
await p.click('[data-tab="plan"]')
await p.waitForTimeout(1000)
for (const slot of ['outerwear', 'bottom', 'shoes']) {
  const r = await p.evaluate((s) => {
    const el = document.querySelector(`.hotspot[data-hot="${s}"]`)
    if (!el) return { err: 'missing' }
    el.scrollIntoView({ block: 'center' })
    const b = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const px = b.x + b.width / 2
    const py = b.y + b.height / 2
    return {
      slot: s,
      rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      css: { pointerEvents: cs.pointerEvents, display: cs.display, visibility: cs.visibility, opacity: cs.opacity, zIndex: cs.zIndex, overflow: cs.overflow },
      stack: document.elementsFromPoint(px, py).slice(0, 5).map((e) => `${e.tagName}${e.id ? '#' + e.id : ''}.${String(e.className).slice(0, 24)}`),
      parentOverflow: (() => { let n = el.parentElement, out = []; while (n && n !== document.body) { const c = getComputedStyle(n); if (c.overflow !== 'visible') out.push(`${n.id || n.className}:${c.overflow}`); n = n.parentElement } return out })(),
    }
  }, slot)
  console.log(JSON.stringify(r))
}
await b.close()
