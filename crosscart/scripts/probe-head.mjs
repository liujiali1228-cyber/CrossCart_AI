import { chromium } from 'playwright-core'
const b = await chromium.launch({ channel: 'msedge', headless: true })
const p = await b.newPage({ viewport: { width: 1440, height: 1040 } })
await p.goto('http://127.0.0.1:8790/?plan=pln_001', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(1800)
const rows = await p.evaluate(() => {
  const pane = document.querySelector('#pane-plan')
  return [...pane.children].map((el) => {
    const r = el.getBoundingClientRect()
    return { tag: el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ')[0] : ''), y: Math.round(r.y), h: Math.round(r.height), text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 60) }
  })
})
console.log(JSON.stringify(rows, null, 1))
await b.close()
