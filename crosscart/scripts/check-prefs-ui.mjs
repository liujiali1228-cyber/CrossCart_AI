/**
 * 偏好写读的界面自检（Phase 5 F0 验收，不产生任何模型 / 图像费用）。
 *
 * 前提：起一个实例，默认跑在隔离实例上（CROSSCART_DATA_DIR + CROSSCART_PORT=8791），
 * 这样验证「首页保存偏好 → 覆盖旧值 → 列表只显示生效的一条」时不会污染真实偏好。
 *
 *   CROSSCART_DATA_DIR=.tmp/f0 CROSSCART_PORT=8791 node packages/bridge/src/server.mjs
 *   node scripts/check-prefs-ui.mjs http://127.0.0.1:8791
 */
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8791'
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))

const results = []
const ok = (name, extra = '') => {
  results.push(true)
  console.log(`✅ ${name}${extra ? `（${extra}）` : ''}`)
}
const bad = (name, extra = '') => {
  results.push(false)
  console.log(`❌ ${name}${extra ? `（${extra}）` : ''}`)
}

if (!EDGE) {
  console.log('❌ 找不到可用的浏览器（Edge / Chrome）')
  process.exit(1)
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(e.message))

// 界面显示中文标签（F3），匹配用 data-attr；老版本没有 data-attr 时退回读 .k 文本
const rowsOf = async (attr) =>
  page.$$eval('.pref-row', (els, a) =>
    els
      .filter((e) => (e.dataset.attr ?? e.querySelector('.k')?.textContent?.trim()) === a)
      .map((e) => e.querySelector('.v')?.textContent?.trim()),
    attr,
  )

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#pref-form', { timeout: 15000 })
  await page.waitForTimeout(800)

  const before = await page.$$eval('.pref-row', (els) => els.length)
  ok('首页偏好区渲染成功', `已有 ${before} 条`)

  await page.selectOption('#pref-attr', 'palette')
  await page.fill('#pref-value', '浅色、奶油白')
  await page.click('#pref-form button[type=submit]')
  await page.waitForFunction(() => !document.getElementById('toast')?.hidden, null, { timeout: 8000 })
  const toast1 = (await page.textContent('#toast'))?.trim()
  toast1?.includes('已保存') ? ok('保存后给出「已保存」提示', toast1) : bad('保存提示不正确', toast1)

  await page.waitForTimeout(600)
  const first = await rowsOf('palette')
  first.length === 1 ? ok('新属性只出现一行', first.join(' | ')) : bad('新属性行数异常', `rows=${JSON.stringify(first)}`)
  first[0]?.includes('浅色') ? ok('显示刚写入的值') : bad('显示的不是刚写入的值', String(first[0]))

  // 同一个属性再写一次 = 用户改主意 → 必须只剩一行，且是新值
  await page.fill('#pref-value', '深色、墨黑')
  await page.click('#pref-form button[type=submit]')
  await page.waitForTimeout(900)
  const second = await rowsOf('palette')
  second.length === 1 ? ok('二次写入是覆盖，不是追加', `rows=${second.length}`) : bad('二次写入产生了多行（upsert 失效）', `rows=${JSON.stringify(second)}`)
  second[0]?.includes('深色') ? ok('覆盖后显示最新值', String(second[0])) : bad('覆盖后仍是旧值', String(second[0]))

  // 落库内容：应该同时留有被取代的旧记录（历史不丢），但界面只显示生效的一条
  const api = await page.evaluate(async () => {
    const r = await fetch('/api/prefs')
    return r.json()
  })
  const palette = api.groups?.find((g) => g.attr === 'palette')
  const supersededRecords = (palette?.records ?? [])
    .filter((r) => r.status === 'superseded')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  // 同一数据目录会反复跑这个脚本，历史链会越来越长（每条旧值都该留着）。
  // 所以不数「恰好 1 条」，而是验真正的要求：旧值没被删掉、并且被标成已取代，
  // 且最近被取代的那条就是这次刚改掉的旧值。
  supersededRecords.length >= 1
    ? ok('旧记录被标为已取代（历史保留）', `${supersededRecords.length} 条历史`)
    : bad('旧记录没有被标记', `superseded=${supersededRecords.length}`)
  const latestSuperseded = supersededRecords[0]?.value ?? ''
  const keptOld = /浅色/.test(latestSuperseded)
  keptOld
    ? ok('最近被取代的是本次改掉的旧值', latestSuperseded)
    : bad('历史链里找不到刚被取代的旧值', `latest=${latestSuperseded || '-'}`)
  api.counts?.active === (await page.$$eval('.pref-row', (e) => e.length))
    ? ok('界面行数 = 生效记录数', `${api.counts.active}`)
    : bad('界面行数与生效记录数不一致', `ui vs api: ${await page.$$eval('.pref-row', (e) => e.length)} / ${api.counts.active}`)

  jsErrors.length === 0 ? ok('页面无 JS 报错') : bad('页面有 JS 报错', jsErrors.join(' ; '))
} catch (e) {
  bad('自检异常中断', e.message)
} finally {
  await browser.close()
}

const pass = results.filter(Boolean).length
console.log(`\n通过 ${pass} 项，失败 ${results.length - pass} 项`)
process.exit(pass === results.length ? 0 : 1)
