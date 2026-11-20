/**
 * Phase 6 · 消费者端 UI 验收（只读，不建方案、不调图像 API、不点任何付费动作）。
 *
 * 验的是「消费者能不能顺利把这套东西用起来」，不是「DOM 里有没有这个 id」：
 *  P1 偏好区去工作台化：没有变更记录/机制说明/大空块，素材归属仍在
 *  P2 类目按钮在右栏顶部、首屏可达、点得进换装
 *  P3 没有「技术信息」；「调整约束」是默认收起的轻入口，展开不压住人物图
 *  P4 建议 ≤3 条、可逐条关闭、关掉后刷新不回来、能再打开
 *  P6 清单一行一个单品，金额块在首屏，没有开发者的「演示数据」段落
 *  P7 热点不可见、无识别说明，点击仍能命中（点测在 verify:stage3 的 B 段）
 *  P8 界面不出现 AI 生成成本/额度数字
 *
 *   node scripts/check-p6-ui.mjs                       # 默认打 8790 + pln_020
 *   node scripts/check-p6-ui.mjs http://127.0.0.1:8796 pln_001   # 打演示实例
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8790'
const PLAN = process.argv[3] ?? 'pln_020'
const OUT = join('shots', 'phase6')
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))
if (!EDGE) {
  console.error('找不到 Edge/Chrome，无法跑 UI 验收')
  process.exit(1)
}

let pass = 0
let fail = 0
const failures = []
const report = { base: BASE, plan: PLAN, checks: {}, errors: [] }
function expect(ok, label, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}
const section = (t) => console.log(`\n${t}`)

const box = (sel) => {
  const el = document.querySelector(sel)
  if (!el || el.hidden || el.offsetParent === null) return null
  const b = el.getBoundingClientRect()
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom), right: Math.round(b.right) }
}
const overlaps = (a, b) => Boolean(a && b && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom)

const browser = await chromium.launch({ executablePath: EDGE, headless: true })

/* ============================================================ 桌面两档 */
for (const [w, h] of [
  [1440, 900],
  [1366, 768],
]) {
  const tag = `${w}×${h}`
  section(`[${tag}] 首屏：不滚动就能换装、看清单、看金额`)
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e.message)))
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text())
  })
  await page.goto(`${BASE}/?plan=${encodeURIComponent(PLAN)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#stage-img:not([hidden])', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1800)

  const geo = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel)
      if (!el || el.hidden || el.offsetParent === null) return null
      const b = el.getBoundingClientRect()
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom), right: Math.round(b.right) }
    }
    return {
      vw: innerWidth,
      vh: innerHeight,
      overflowX: document.documentElement.scrollWidth - innerWidth,
      chipsInShop: !!document.querySelector('#slot-chips')?.closest('#pane-shop'),
      chipsInStage: !!document.querySelector('#slot-chips')?.closest('.stage-wrap, #stage-frame, #pane-plan'),
      chips: [...document.querySelectorAll('.slot-chip')].map((el) => ({
        slot: el.dataset.select,
        text: el.innerText.replace(/\n/g, ' ').trim(),
        ...rect(`.slot-chip[data-select="${el.dataset.select}"]`),
      })),
      chipsBox: rect('#slot-chips'),
      shopFirst: rect('#shop-list .shop-item'),
      money: rect('#money-total'),
      moneyText: document.querySelector('#money-total')?.innerText ?? '',
      budgetLine: document.querySelector('#budget-line')?.innerText ?? '',
      composer: rect('#composer'),
      input: rect('#chat-input'),
      stage: rect('#stage-frame'),
      trackUnderStage: !!document.querySelector('#stage-frame')?.parentElement?.querySelector('#slot-chips'),
    }
  })

  expect(geo.overflowX <= 1, `无横向溢出（${geo.overflowX}px）`)
  expect(geo.chipsInShop && !geo.chipsInStage && !geo.trackUnderStage, '类目按钮在右栏顶部，图下没有旧的那一行')
  expect(geo.chips.length === 5, `5 个类目入口（${geo.chips.map((c) => c.text.split(' ')[0]).join('/')}）`)
  expect(
    geo.chips.every((c) => ['outerwear', 'top', 'bottom', 'shoes', 'bag'].includes(c.slot) && c.h > 20),
    '每个类目按钮都有真实尺寸',
  )
  expect(geo.chipsBox && geo.chipsBox.bottom < geo.vh, `类目按钮在首屏内（底边 ${geo.chipsBox?.bottom} / ${geo.vh}）`)
  expect(geo.shopFirst && geo.shopFirst.y < geo.vh, `清单第一行首屏可见（y=${geo.shopFirst?.y}）`)
  expect(geo.money && geo.money.bottom <= geo.vh, `金额块首屏可见（底边 ${geo.money?.bottom} / ${geo.vh}）`)
  expect(/\$\d/.test(geo.moneyText), `金额块显示总额（${geo.moneyText.replace(/\n/g, ' ')}）`)
  expect(/预算/.test(geo.budgetLine), `金额块同时给出预算口径（${geo.budgetLine.replace(/\n/g, ' ').slice(0, 40)}）`)
  expect(geo.composer && geo.composer.bottom <= geo.vh && geo.input && geo.input.h > 24, '输入框固定在首屏底部')

  /* ---- P2：点一下真的进换装 ---- */
  const firstChip = geo.chips[0]
  if (firstChip) {
    await page.click(`.slot-chip[data-select="${firstChip.slot}"]`)
    await page.waitForTimeout(1200)
    const swap = await page.evaluate(() => ({
      open: !document.querySelector('#swap')?.hidden,
      selected: document.querySelector('.slot-chip.selected')?.dataset.select ?? null,
      cands: document.querySelectorAll('#swap .cand').length,
    }))
    expect(swap.selected === firstChip.slot, `点「${firstChip.text}」→ 选中该槽位（${swap.selected}）`)
    expect(swap.open && swap.cands > 0, `同时打开候选抽屉（${swap.cands} 个候选）`)
    await page.evaluate(() => document.querySelector('#swap [data-act="close"]')?.click())
    await page.waitForTimeout(300)
  }

  /* ---- P3：调整约束 ---- */
  const cons = await page.evaluate(() => ({
    tech: !!document.querySelector('#btn-tech'),
    techText: /技术信息/.test(document.body.innerText),
    barHidden: document.querySelector('#constraint-bar')?.hidden,
    expanded: document.querySelector('#btn-edit-plan')?.getAttribute('aria-expanded'),
  }))
  expect(!cons.tech && !cons.techText, '「技术信息」入口已移除')
  expect(cons.barHidden === true && cons.expanded === 'false', '「调整约束」默认收起')
  await page.click('#btn-edit-plan')
  await page.waitForTimeout(400)
  const opened = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel)
      if (!el || el.hidden) return null
      const b = el.getBoundingClientRect()
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom), right: Math.round(b.right) }
    }
    return {
      bar: rect('#constraint-bar'),
      stage: rect('#stage-frame'),
      composer: rect('#composer'),
      expanded: document.querySelector('#btn-edit-plan')?.getAttribute('aria-expanded'),
      fields: ['#budget-input', '#arrival-input', '#ship-input'].filter((s) => document.querySelector(s)),
    }
  })
  const hitStage = overlaps(opened.bar, opened.stage)
  const hitChat = overlaps(opened.bar, opened.composer)
  expect(opened.expanded === 'true' && Boolean(opened.bar), '展开后能改约束（预算/到货/收货地）')
  expect(opened.fields.length >= 2, `约束面板有真实可改字段（${opened.fields.join(' ')}）`)
  expect(!hitStage && !hitChat, `展开不遮挡人物图与对话（图 ${opened.stage ? hitStage : 'n/a'} / 输入框 ${hitChat}）`)
  await page.screenshot({ path: join(OUT, `constraints-${w}x${h}.png`) })
  await page.click('#btn-edit-plan')
  await page.waitForTimeout(300)

  /* ---- P4：建议 ---- */
  const sug0 = await page.evaluate(() => ({
    chips: document.querySelectorAll('.qa-chip').length,
    toggle: !!document.querySelector('[data-suggest-toggle]'),
    chipTexts: [...document.querySelectorAll('.qa-chip')].map((e) => e.innerText.replace(/\n/g, ' ').trim()),
  }))
  if (sug0.chips === 0 && sug0.toggle) {
    // 已经聊过天 → 自动收起，这是设计的默认行为
    expect(true, '已经聊过天的方案里，建议自动收起了', '只有「显示建议」入口')
    await page.click('[data-suggest-toggle]')
    await page.waitForTimeout(300)
  }
  const sug1 = await page.evaluate(() => ({
    chips: [...document.querySelectorAll('.qa-chip')].map((e) => e.innerText.replace(/\n/g, ' ').trim()),
    withX: document.querySelectorAll('.qa-chip .qa-x').length,
  }))
  expect(sug1.chips.length >= 1 && sug1.chips.length <= 3, `建议条数 ≤3（${sug1.chips.length} 条：${sug1.chips.join(' | ')}）`)
  expect(sug1.withX === sug1.chips.length, `每条建议都有独立的关闭按钮（${sug1.withX}/${sug1.chips.length}）`)
  if (sug1.chips.length) {
    await page.click('.qa-chip .qa-x')
    await page.waitForTimeout(250)
    const afterOne = await page.evaluate(() => document.querySelectorAll('.qa-chip').length)
    expect(afterOne === sug1.chips.length - 1, `关掉一条后少一条（${sug1.chips.length} → ${afterOne}）`)
    // 全部关掉 → 只剩恢复入口
    for (let i = 0; i < 4; i++) {
      const n = await page.evaluate(() => document.querySelectorAll('.qa-chip').length)
      if (!n) break
      await page.click('.qa-chip .qa-x')
      await page.waitForTimeout(200)
    }
    const allGone = await page.evaluate(() => ({
      chips: document.querySelectorAll('.qa-chip').length,
      toggle: !!document.querySelector('[data-suggest-toggle]'),
    }))
    expect(allGone.chips === 0 && allGone.toggle, '全部关掉后只留一个「显示建议」轻入口')
    // 刷新后不再出现（本次会话记住）
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    const afterReload = await page.evaluate(() => document.querySelectorAll('.qa-chip').length)
    expect(afterReload === 0, `刷新后关掉的建议不再回来（${afterReload} 条）`)
    const toggleAfterReload = await page.evaluate(() => !!document.querySelector('[data-suggest-toggle]'))
    expect(toggleAfterReload, '刷新后仍可从这里恢复')
    if (toggleAfterReload) {
      await page.click('[data-suggest-toggle]')
      await page.waitForTimeout(300)
      const restored = await page.evaluate(() => document.querySelectorAll('.qa-chip').length)
      expect(restored >= 1, `点「显示建议」能恢复（${restored} 条）`)
    }
  }

  /* ---- P7 / P8：不该出现的东西 ---- */
  const hidden = await page.evaluate(() => ({
    hotspots: [...document.querySelectorAll('.hotspot')].map((el) => ({
      op: Number(getComputedStyle(el).opacity),
      text: (el.innerText ?? '').trim(),
      title: el.getAttribute('title') ?? '',
    })),
    note: (() => {
      const el = document.querySelector('#hotspot-note')
      if (!el) return { hidden: true, text: '' }
      const cs = getComputedStyle(el)
      return { hidden: el.hidden || cs.display === 'none', text: (el.innerText ?? '').trim() }
    })(),
    bodyText: document.body.innerText,
    budgetChip: (() => {
      const el = document.querySelector('#budget-chip')
      return el ? { hidden: el.hidden, text: el.innerText, title: el.title } : null
    })(),
  }))
  expect(hidden.hotspots.length > 0, `热点热区仍在（${hidden.hotspots.length} 个，换装命中靠它）`)
  expect(
    hidden.hotspots.every((h) => h.op < 0.05 && !h.text && !h.title),
    '热点对消费者不可见（无描边、无标签、无 tooltip）',
  )
  expect(hidden.note.hidden || !hidden.note.text, '没有「已自动识别热点」这类机制说明')
  const forbidden = ['修正热点', '重新识别', '可信度', 'body-box', '置信度', '技术信息', '图像 $', '额度', '/ $8', '$0.29']
  const leaked = forbidden.filter((t) => hidden.bodyText.includes(t))
  expect(leaked.length === 0, '界面没有成本/额度/识别过程等开发者信息', leaked.join('、') || '无')
  expect(!hidden.budgetChip || hidden.budgetChip.hidden, '额度没用完时不出现任何额度提示')

  /* ---- P6：清单与措辞 ---- */
  const shop = await page.evaluate(() => {
    const pane = document.querySelector('#pane-shop')
    return {
      text: pane?.innerText ?? '',
      rows: [...document.querySelectorAll('#shop-list .shop-item')].map((el) => el.innerText.replace(/\s+/g, ' ').trim()),
      thumbOk: [...document.querySelectorAll('#shop-list .shop-thumb')].every((el) => el.getBoundingClientRect().width > 30),
    }
  })
  expect(shop.rows.length >= 3, `清单一行一个单品（${shop.rows.length} 行）`)
  expect(shop.rows.every((t) => /\$|已有|无购买页/.test(t)), '每行都有到手价或如实的不可买说明')
  expect(shop.thumbOk, '每行都有商品缩略图')
  expect(!/演示数据/.test(shop.text), '清单里没有「演示数据」这种开发者标签')

  expect(errs.length === 0, `无 JS / console 报错${errs.length ? `（${errs.join(' | ').slice(0, 80)}）` : ''}`)
  await page.screenshot({ path: join(OUT, `ui-${w}x${h}.png`) })
  report.checks[tag] = geo
  report.errors.push(...errs.map((e) => `${tag}: ${e}`))
  await page.close()
}

/* ============================================================ 390 移动端 */
section('[390×844] 移动端：清单与类目入口都在手边')
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e.message)))
  await page.goto(`${BASE}/?plan=${encodeURIComponent(PLAN)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#stage-img:not([hidden])', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1500)
  const m0 = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - innerWidth,
    tabs: [...document.querySelectorAll('[data-tab]')].length,
    swapBtn: (() => {
      const el = document.querySelector('#btn-open-swap')
      if (!el) return null
      const cs = getComputedStyle(el)
      const b = el.getBoundingClientRect()
      return { shown: cs.display !== 'none' && b.width > 0, y: Math.round(b.y), h: Math.round(b.height) }
    })(),
  }))
  expect(m0.overflowX <= 1, `无横向溢出（${m0.overflowX}px）`)
  await page.click('[data-tab="shop"]')
  await page.waitForTimeout(700)
  const m1 = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel)
      if (!el || el.hidden || el.offsetParent === null) return null
      const b = el.getBoundingClientRect()
      return { y: Math.round(b.y), h: Math.round(b.height), bottom: Math.round(b.bottom), w: Math.round(b.width) }
    }
    return {
      paneShop: rect('#pane-shop'),
      chips: rect('#slot-chips'),
      chipCount: document.querySelectorAll('.slot-chip').length,
      first: rect('#shop-list .shop-item'),
      money: rect('#money-total'),
      docScroll: document.documentElement.scrollHeight,
      innerH: innerHeight,
    }
  })
  expect(m1.paneShop && m1.chips && m1.chipCount === 5, `移动端清单页有 5 个类目入口（${m1.chipCount}）`)
  expect(m1.chips && m1.chips.bottom < m1.innerH, `类目入口在首屏（底边 ${m1.chips?.bottom} / ${m1.innerH}）`)
  expect(m1.first && m1.first.y < m1.innerH, `清单第一行在首屏（y=${m1.first?.y}）`)
  expect(m1.money && m1.money.bottom <= m1.innerH, `金额块在首屏（底边 ${m1.money?.bottom} / ${m1.innerH}）`)
  expect(m0.swapBtn && m0.swapBtn.shown === false, '移动端不重复显示「更换单品」（类目入口已在手边）')
  await page.screenshot({ path: join(OUT, 'ui-390-shop.png') })
  await page.click('[data-tab="plan"]')
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(OUT, 'ui-390-plan.png') })
  expect(errs.length === 0, '移动端无 JS 报错')
  report.checks['390x844'] = m1
  await page.close()
}

/* ============================================================ P1 首页偏好区 */
section('[首页] 我的偏好：像消费者页面，不像控制台')
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e.message)))
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text())
  })
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  const home = await page.evaluate(() => {
    const prefs = document.querySelector('#prefs')
    const text = prefs?.innerText ?? ''
    const b = prefs?.getBoundingClientRect()
    return {
      hasHistory: !!document.querySelector('#pref-history') || !!document.querySelector('#history-list'),
      text,
      height: Math.round(b?.height ?? 0),
      mechanism: /可在对话中读取|变更记录|写进方案状态|保存后会|参与推荐|任务级|workbench/i.test(text),
      pendingHead: document.querySelector('#plan-pending .section-title, #plan-pending h2, #plan-pending h3')?.innerText ?? '',
      pendingText: document.querySelector('#plan-pending')?.innerText.slice(0, 80) ?? '',
      hasForm: !!document.querySelector('#pref-form') && !!document.querySelector('#pref-value'),
      attrCount: document.querySelectorAll('#prefs-list > *').length,
      footer: document.querySelector('#proto')?.innerText.replace(/\s+/g, ' ') ?? '',
    }
  })
  expect(!home.hasHistory, '变更记录块已移除')
  expect(!/待生成场景图/.test(home.pendingText), `方案区不再出现「待生成场景图」（${home.pendingText.replace(/\s+/g, ' ').slice(0, 24)}…）`)
  expect(!home.mechanism, '偏好区没有机制说明/内部字段名')
  expect(home.hasForm, '仍然可以直接加一条偏好')
  expect(home.height > 0 && home.height < 460, `偏好区没有留大空块（高 ${home.height}px，${home.attrCount} 条生效）`)
  expect(/素材|未获授权|Sources\.md/i.test(home.footer), '素材归属说明仍保留（合规不能删）')
  await page.locator('#prefs').scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.locator('#prefs').screenshot({ path: join(OUT, 'ui-home-prefs.png') })
  expect(errs.length === 0, '首页无 JS 报错')
  report.checks.home = home
  await page.close()
}

await browser.close()
writeFileSync(join(OUT, 'check-ui.json'), JSON.stringify(report, null, 1))
console.log(`\n[p6-ui] 通过 ${pass} 项，失败 ${fail} 项`)
if (fail) {
  console.log(`失败项：${failures.join(' / ')}`)
  process.exit(1)
}
