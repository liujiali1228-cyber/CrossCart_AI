import { chromium } from 'playwright-core'
const tag = process.argv[2] ?? 'after'
const b = await chromium.launch({ channel: 'msedge', headless: true })
for (const vp of [{ width: 1440, height: 1040, n: '1440' }, { width: 1280, height: 900, n: '1280' }, { width: 390, height: 844, n: '390' }]) {
  const p = await b.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 })
  const errs = []
  p.on('pageerror', (e) => errs.push(String(e)))
  await p.goto('http://127.0.0.1:8790/?plan=pln_001', { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1800)
  if (vp.width < 1024) {
    await p.click('[data-tab="plan"]')
    await p.waitForTimeout(1200)
  }
  await p.screenshot({ path: `shots/fix/${vp.n}-${tag}.png` })
  // 顶部头像区（首屏到底看到什么）
  await p.evaluate(() => window.scrollTo(0, 0))
  const m = await p.evaluate(() => {
    const g = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    return { stage: g('#stage'), frame: g('#stage-frame'), caption: g('#stage-caption'), chips: g('#slot-chips'), shop: g('#pane-shop'), scrollH: document.documentElement.scrollHeight }
  })
  console.log(vp.n, JSON.stringify(m), errs.length ? 'ERR ' + errs[0] : 'no-error')
  await p.close()
}
await b.close()
