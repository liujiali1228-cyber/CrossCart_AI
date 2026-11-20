import { chromium } from 'playwright-core'
const b = await chromium.launch({ channel: 'msedge', headless: true })
const p = await b.newPage({ viewport: { width: 390, height: 844 } })
await p.goto('http://127.0.0.1:8790/?plan=pln_001', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(1800)
await p.click('[data-tab="plan"]')
await p.waitForTimeout(1000)
// 按旧版参数复现：stage 固定 56dvh，画框按高度倒推宽度（314×471），AI 标识压回图上
await p.addStyleTag({ content: `
  #stage { height: 472px !important; display: grid !important; place-items: center !important; }
  #stage-frame { width: 314px !important; height: 471px !important; }
  #stage-caption { position: absolute; left: 0; top: 0; z-index: 6; padding: 6px 8px; }
  .stage { position: relative; }
`})
await p.evaluate(() => {
  const cap = document.querySelector('#stage-caption')
  const frame = document.querySelector('#stage-frame')
  if (cap && frame) frame.appendChild(cap)
})
await p.waitForTimeout(600)
await p.screenshot({ path: 'shots/fix/390-before-repro.png' })
await b.close()
