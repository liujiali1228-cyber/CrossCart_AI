import { chromium } from 'playwright-core'

const plan = process.argv[2] ?? 'pln_001'
const b = await chromium.launch({ channel: 'msedge', headless: true })
let pass = 0
let fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

for (const vp of [{ width: 1440, height: 1040, n: '桌面 1440' }, { width: 390, height: 844, n: '移动 390' }]) {
  console.log(`\n=== ${vp.n}`)
  const p = await b.newPage({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.width < 1024 })
  await p.goto(`http://127.0.0.1:8790/?plan=${plan}`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1800)
  if (vp.width < 1024) { await p.click('[data-tab="plan"]'); await p.waitForTimeout(1200) }
  // 等 toast 浮层消失，否则它盖住画面底部（正是鞋子所在位置）
  await p.waitForFunction(() => document.querySelector('#toast')?.hidden !== false, { timeout: 8000 }).catch(() => {})

  const slots = await p.evaluate(() => [...document.querySelectorAll('.hotspot[data-hot]')].map((el) => {
    const r = el.getBoundingClientRect()
    return { slot: el.dataset.hot, x: r.x, y: r.y, w: r.width, h: r.height }
  }))
  console.log('  可点区域:', slots.map((s) => `${s.slot} ${Math.round(s.w)}×${Math.round(s.h)}`).join(' | '))

  for (const s of slots) {
    const loc = p.locator(`.hotspot[data-hot="${s.slot}"]`)
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
    await p.waitForTimeout(150)
    // 取「最上层就是它自己」的一个点：这才代表用户真的能点到这件衣物
    const pt = await p.evaluate((want) => {
      const el = document.querySelector(`.hotspot[data-hot="${want}"]`)
      if (!el) return null
      const r = el.getBoundingClientRect()
      let best = null
      for (let gy = 0.2; gy <= 0.85; gy += 0.05) {
        for (let gx = 0.2; gx <= 0.85; gx += 0.05) {
          const px = r.x + r.width * gx
          const py = r.y + r.height * gy
          if (px < 1 || py < 1 || px > innerWidth - 2 || py > innerHeight - 2) continue
          const top = document.elementFromPoint(px, py)?.closest('.hotspot')
          if (top?.dataset.hot === want) {
            const d = (gx - 0.5) ** 2 + (gy - 0.5) ** 2
            if (!best || d < best.d) best = { px, py, d }
          }
        }
      }
      return best
    }, s.slot)
    if (!pt) {
      fail++
      const why = await p.evaluate((want) => {
        const el = document.querySelector(`.hotspot[data-hot="${want}"]`)
        const r = el.getBoundingClientRect()
        const mid = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return `rect=${Math.round(r.width)}×${Math.round(r.height)}@${Math.round(r.y)} 中心最上层=${mid?.tagName}.${String(mid?.className).slice(0, 24)}`
      }, s.slot)
      console.log(`  ❌ ${s.slot} 无可点位置（${why}）`)
      continue
    }
    await p.mouse.click(pt.px, pt.py)
    await p.waitForTimeout(420)
    const sel = await p.evaluate(() => ({
      chip: document.querySelector('.slot-chip.selected')?.dataset.select ?? null,
      panel: (document.querySelector('#selection')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 40),
    }))
    ok(sel.chip === s.slot, `点 ${s.slot} @(${Math.round(pt.px)},${Math.round(pt.py)}) → 选中 ${sel.chip ?? '（无）'}`)
    // 移动端：选中衣物会自动跳到「购物」页看商品（设计如此），继续测之前得先切回穿搭页
    if (vp.width < 1024) {
      await p.click('[data-tab="plan"]')
      await p.waitForTimeout(500)
    } else {
      await p.mouse.click(pt.px, pt.py) // 桌面端再点一次取消选中
      await p.waitForTimeout(220)
    }
  }
  await p.screenshot({ path: `shots/fix/click-${vp.width}.png` })
  await p.close()
}
await b.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
process.exit(fail ? 1 : 0)
