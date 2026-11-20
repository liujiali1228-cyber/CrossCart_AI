import { chromium } from 'playwright-core'
const b = await chromium.launch({ channel: 'msedge', headless: true })
const p = await b.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
await p.goto('http://127.0.0.1:8790/?plan=pln_001', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(1500)
await p.click('[data-tab="plan"]')
await p.waitForTimeout(1200)
for (const slot of ['bottom', 'shoes']) {
  try {
    await p.locator(`.hotspot[data-hot="${slot}"]`).click({ timeout: 4000 })
    console.log(slot, 'OK')
  } catch (e) {
    console.log(`--- ${slot} FAIL:/n` + String(e.message).split('\n').slice(0, 14).join('\n'))
  }
}
await b.close()
