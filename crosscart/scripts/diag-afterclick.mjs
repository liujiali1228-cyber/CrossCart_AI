import { chromium } from 'playwright-core'
const b = await chromium.launch({ channel: 'msedge', headless: true })
const p = await b.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
p.on('pageerror', (e) => console.log('PAGEERROR', String(e)))
await p.goto('http://127.0.0.1:8790/?plan=pln_001', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(1500)
await p.click('[data-tab="plan"]')
await p.waitForTimeout(1000)
const dump = (label) => p.evaluate((l) => {
  const f = document.querySelector('#stage-frame')
  const fr = f.getBoundingClientRect()
  const nodes = [...document.querySelectorAll('#hotspots .hotspot')].map((e) => ({
    k: e.dataset.hot ?? e.dataset.unsure,
    inline: e.getAttribute('style'),
    rect: (() => { const r = e.getBoundingClientRect(); return `${Math.round(r.width)}×${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}` })(),
  }))
  return { l, frameHidden: f.hidden, frame: `${Math.round(fr.width)}×${Math.round(fr.height)}@${Math.round(fr.x)},${Math.round(fr.y)}`, stage: (() => { const r = document.querySelector('#stage').getBoundingClientRect(); return `${Math.round(r.width)}×${Math.round(r.height)}` })(), paneScroll: document.querySelector('#pane-plan').scrollTop, nodes }
}, label)
console.log(JSON.stringify(await dump('初始'), null, 1))
await p.evaluate(() => {
  const el = document.querySelector('.hotspot[data-hot="outerwear"]')
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  window.__pt = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})
const pt = await p.evaluate(() => window.__pt)
await p.mouse.click(pt.x, pt.y)
await p.waitForTimeout(900)
console.log(JSON.stringify(await dump('点完外套'), null, 1))
await b.close()
