/**
 * Phase 4.1-B · 首页交互与素材自检（只读，不提交表单、不建方案、不调图像 API）
 * 检查：主视觉加载、编辑精选点击填入需求、锚点导航、移动端说明行位置、JS 错误。
 */
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8790'
const OUT = 'shots/phase41'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const results = []
const errors = []
const ok = (name, pass, detail) => results.push({ name, pass, detail })

// ---------- 1440：交互 ----------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => errors.push(`1440 pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`1440 console: ${m.text()}`) })
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  const hero = await page.evaluate(() => {
    const img = document.querySelector('#hero-media img')
    return img ? { src: img.getAttribute('src'), w: img.naturalWidth, h: img.naturalHeight, complete: img.complete } : null
  })
  ok('主视觉已解码', !!hero && hero.complete && hero.w > 0, JSON.stringify(hero))

  const inspCount = await page.locator('.insp').count()
  ok('编辑精选 4 张', inspCount === 4, `count=${inspCount}`)

  const hasPrice = await page.evaluate(() => /[$¥€]\s?\d/.test(document.querySelector('#insp-grid').innerText))
  ok('编辑精选不含价格', !hasPrice, hasPrice ? '出现金额字样' : 'ok')

  await page.click('.insp[data-insp="0"]')
  await page.waitForTimeout(500)
  const inputVal = await page.inputValue('#ask-input')
  ok('点击灵感填入需求', inputVal.includes('城市秋日') && inputVal.length > 8, inputVal)

  const focused = await page.evaluate(() => document.activeElement?.id)
  ok('填词后输入框获得焦点', focused === 'ask-input', `active=${focused}`)

  // 主视觉区不得出现开发说明（来源/授权移到页面底部原型说明与 SOURCES.md）
  const heroText = await page.evaluate(() => document.querySelector('.hero').innerText.replace(/\s+/g, ''))
  ok('Hero 不含开发说明', !/临时素材|内部视觉验证|授权/.test(heroText), heroText.slice(0, 40))

  // 文本列垂直居中：以首末可见子元素计，上下留白差不超过 24px（此前左下角空出 458px）
  const balance = await page.evaluate(() => {
    const media = document.querySelector('#hero-media').getBoundingClientRect()
    const kids = [...document.querySelector('.hero-copy').children].filter((c) => c.offsetHeight > 0)
    const first = kids[0].getBoundingClientRect()
    const last = kids[kids.length - 1].getBoundingClientRect()
    return {
      top: Math.round(first.top - media.top),
      bottom: Math.round(media.bottom - last.bottom),
    }
  })
  ok('文本列上下留白对称', Math.abs(balance.top - balance.bottom) <= 24, JSON.stringify(balance))

  // 锚点导航（不触发建方案）
  await page.click('.topnav a[href="#plans"]')
  await page.waitForTimeout(900)
  const plansTop = await page.evaluate(() => Math.round(document.querySelector('#plans').getBoundingClientRect().top))
  ok('我的方案锚点可用', Math.abs(plansTop) < 120, `top=${plansTop}`)

  // 真实方案区仍然有价格与到货
  const planMeta = await page.evaluate(() => {
    const el = document.querySelector('.plan-card .meta')
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : null
  })
  ok('我的方案保留真实价格', !!planMeta && /[$]\d/.test(planMeta), planMeta ?? 'no plan card')

  // 方案区：有封面的优先；无封面的收成文字行；副本默认隐藏但可展开
  const plansInfo = await page.evaluate(() => ({
    cards: document.querySelectorAll('.plan-card').length,
    emptyThumbs: [...document.querySelectorAll('.plan-card .thumb')].filter((t) => !t.querySelector('img')).length,
    pending: document.querySelectorAll('#pending-list li').length,
    pendingHidden: document.querySelector('#plan-pending').hidden,
    count: document.querySelector('#plans-count').textContent.trim(),
    toggleHidden: document.querySelector('#toggle-copies').hidden,
    copyCards: [...document.querySelectorAll('.plan-card h3')].filter((h) => /副本/.test(h.textContent)).length,
  }))
  ok('方案卡都有真实封面', plansInfo.emptyThumbs === 0, JSON.stringify(plansInfo))
  ok('无封面方案走文字状态', plansInfo.pendingHidden || plansInfo.pending > 0, JSON.stringify(plansInfo))
  ok('副本默认不占主网格', plansInfo.copyCards === 0, JSON.stringify(plansInfo))

  // 原型说明区在页面底部，且不进入首屏
  const proto = await page.evaluate(() => {
    const el = document.querySelector('#proto')
    const r = el.getBoundingClientRect()
    return { y: Math.round(r.y + scrollY), visible: r.top < innerHeight, text: el.innerText.trim().slice(0, 30) }
  })
  ok('原型说明不干扰首屏', proto.y > 900 && !proto.visible && proto.text.length > 0, JSON.stringify(proto))

  await page.close()
}

// ---------- 390：移动端排版 ----------
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.on('pageerror', (e) => errors.push(`390 pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`390 console: ${m.text()}`) })
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  const geo = await page.evaluate(() => {
    const r = (s) => { const el = document.querySelector(s); const b = el.getBoundingClientRect(); return { y: Math.round(b.y + scrollY), bottom: Math.round(b.bottom + scrollY), w: Math.round(b.width) } }
    const img = document.querySelector('#hero-media img')
    return {
      media: r('#hero-media'),
      ask: r('#ask-input'),
      overflowX: document.documentElement.scrollWidth - innerWidth,
      pos: getComputedStyle(img).objectPosition,
      src: img.currentSrc,
      nat: { w: img.naturalWidth, h: img.naturalHeight },
      heroText: document.querySelector('.hero').innerText.replace(/\s+/g, ''),
    }
  })
  ok('移动端无横向溢出', geo.overflowX === 0, `overflowX=${geo.overflowX}`)
  // 移动端必须是独立的单人竖构图素材（不是把桌面多人图再裁一刀）
  // P9：主视觉改成 WebP 多档（srcset），移动端仍必须是那张专用竖构图素材。
  // 旧断言写死 \.jpg 后缀，转码后必然失败；换成「文件名仍是 hero-mobile」+ 后缀 jpg|webp。
  ok('移动端使用专用竖构图素材', /hero-mobile(-\d+)?\.(jpg|webp)$/.test(geo.src), geo.src)
  ok('移动端素材为 9:16 单人竖图', Math.abs(geo.nat.h / geo.nat.w - 16 / 9) < 0.06, `${geo.nat.w}x${geo.nat.h}`)
  ok('移动端取景保留头顶留白', geo.pos.split(' ')[1] === '8%', `object-position=${geo.pos}`)
  ok('移动端 Hero 不含开发说明', !/临时素材|内部视觉验证|授权/.test(geo.heroText), geo.heroText.slice(0, 30))

  await page.evaluate(() => window.scrollTo(0, 470))
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(OUT, 'B-home-390-photo.png') })
  await page.close()
}

await browser.close()
const failed = results.filter((r) => !r.pass)
writeFileSync(join(OUT, 'ux-check.json'), JSON.stringify({ results, errors }, null, 1))
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail ?? ''}`)
console.log(`\n通过 ${results.length - failed.length}/${results.length}，JS 错误 ${errors.length} 条`)
if (errors.length) console.log(errors.join('\n'))
process.exit(failed.length ? 1 : 0)
