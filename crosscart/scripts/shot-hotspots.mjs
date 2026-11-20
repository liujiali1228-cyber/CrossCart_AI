import { chromium } from 'playwright-core'
const plan = process.argv[2] ?? 'pln_001'
const tag = process.argv[3] ?? 'after'
const b = await chromium.launch({ channel: 'msedge', headless: true })
for (const vp of [{ width: 1440, height: 1040, n: '1440' }, { width: 390, height: 844, n: '390' }]) {
  const p = await b.newPage({ viewport: { width: vp.width, height: vp.height } })
  await p.goto(`http://127.0.0.1:8790/?plan=${plan}`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1800)
  if (vp.width < 1024) { await p.click('[data-tab="plan"]'); await p.waitForTimeout(1000) }
  // 让热点常显 + 标注槽位名，便于肉眼核对框是否压在衣服上
  await p.addStyleTag({ content: `
    .hotspot { border: 2px solid #ff2d55 !important; background: rgba(255,45,85,.10) !important; }
    .hotspot .hot-label { opacity: 1 !important; background: #ff2d55 !important; }
    .hotspot.unsure { border-color: #ff9f0a !important; background: rgba(255,159,10,.12) !important; }
  `})
  await p.evaluate(() => {
    document.querySelectorAll('.hotspot').forEach((el) => el.classList.add('force-show'))
  })
  const geo = await p.evaluate(() => {
    const frame = document.querySelector('#stage-frame').getBoundingClientRect()
    return [...document.querySelectorAll('.hotspot')].map((el) => {
      const r = el.getBoundingClientRect()
      return {
        slot: el.dataset.hot,
        cls: el.className,
        rel: { x: +( (r.x - frame.x) / frame.width ).toFixed(3), y: +((r.y - frame.y) / frame.height).toFixed(3), w: +(r.width / frame.width).toFixed(3), h: +(r.height / frame.height).toFixed(3) },
        px: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      }
    })
  })
  console.log(vp.n, JSON.stringify(geo, null, 1))
  await p.screenshot({ path: `shots/fix/${vp.n}-hotspots-${tag}.png` })
  await p.close()
}
await b.close()
