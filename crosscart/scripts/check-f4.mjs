/**
 * Phase 5 F4 端到端验收：建方案硬约束 + 解释链路。
 *
 * 为什么要独立脚本：
 *  - F4 的核心变化是「建方案会拒绝落库」，这必须用真实 HTTP + 真实目录验证，
 *    单测只能证明纯函数对，证明不了接口没留下脏数据。
 *  - 全程隔离数据目录（mkdtemp + 复制 live/scenes），真实 state.json 与 chat.json 不动。
 *
 * 覆盖（对应用户 A1–A3 要求）：
 *  A 无偏好            → 正常建方案，约束检查齐全
 *  B 已确认避开品牌     → 422 PREF_CONFLICT，且**没有落库**
 *  C 授权不匹配         → 仍然拒绝（不能糊弄过去）
 *  D 非法破例           → 拒绝（未知规则 / 缺原话）
 *  E 用户明确破例       → 成功且记录原话；长期偏好没有被放宽
 *  F 尺码不符           → 拒绝
 *  G 待确认/已删除/跨方案 → 不阻断
 *  H 类目错位           → 409，不落库
 *  I 换件路径保持一致     → 候选排除 + 解释字段（加分/名次变化）
 *  J 预算/到货           → 如实报告 violated / unverified（不静默通过）
 *  K 旧页面契约           → Studio 仍能打开、候选抽屉仍可用
 *
 *   node scripts/check-f4.mjs
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.cwd()
const PORT = 8794
const BASE = `http://127.0.0.1:${PORT}`
const OUT = join(REPO, 'shots', 'f4')
mkdirSync(OUT, { recursive: true })
const OBS = { startedAt: new Date().toISOString(), steps: [], plans: {}, ui: {} }
let BROWSER = null

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))

let pass = 0
let fail = 0
const failures = []
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
const log = (t) => console.log(`  · ${t}`)

/* --------------------------------------------------------------- 隔离实例 */

function makeDataDir() {
  const data = mkdtempSync(join(tmpdir(), 'cc-f4-'))
  cpSync(join(REPO, 'data', 'state.json'), join(data, 'state.json'))
  if (existsSync(join(REPO, 'data', 'live'))) cpSync(join(REPO, 'data', 'live'), join(data, 'live'), { recursive: true })
  if (existsSync(join(REPO, 'data', 'scenes'))) cpSync(join(REPO, 'data', 'scenes'), join(data, 'scenes'), { recursive: true })
  const st = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
  st.prefs = []
  writeFileSync(join(data, 'state.json'), JSON.stringify(st, null, 2))
  return data
}

let CHILD = null
let DATA = null
async function startInstance(data) {
  DATA = data
  CHILD = spawn(process.execPath, [join(REPO, 'packages', 'bridge', 'src', 'server.mjs')], {
    cwd: REPO,
    env: { ...process.env, CROSSCART_PORT: String(PORT), CROSSCART_DATA_DIR: data, SCENEGEN_AUTO_DEBOUNCE_MS: '999999' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  CHILD.stdout.on('data', () => {})
  CHILD.stderr.on('data', (d) => log(`[instance] ${String(d).trim().slice(0, 160)}`))
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('隔离实例启动超时')
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'content-type': 'application/json' }, ...opts })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b ?? {}) })
const patch = (p, b) => api(p, { method: 'PATCH', body: JSON.stringify(b ?? {}) })
const del = (p) => api(p, { method: 'DELETE' })

const statePlans = () =>
  (JSON.parse(readFileSync(join(DATA, 'state.json'), 'utf8')).plans ?? []).map((p) => p.planId)

let seq = 0
function planBody(over = {}) {
  seq += 1
  return {
    label: `F4 验收 ${seq}`,
    scene: { type: 'travel', destination: 'Tokyo', days: 3 },
    budgetLimit: 600,
    arrivalBy: '2026-12-20',
    slots: [],
    ...over,
  }
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  await startInstance(makeDataDir())

  // 从真实目录里挑三件商品：一件 Rothy's 鞋、一件非 Rothy's 鞋、一件外套
  const all = (await api('/api/catalog?limit=400')).body.items ?? []
  const rothyShoe = all.find((c) => c.category === 'shoes' && /Rothy/i.test(c.vendor ?? ''))
  const otherShoe = all.find((c) => c.category === 'shoes' && !/Rothy/i.test(c.vendor ?? ''))
  const coat = all.find((c) => c.category === 'outerwear')
  expect(Boolean(rothyShoe && otherShoe && coat), '目录里有可用于验证的鞋 / 外套', `${all.length} 件`)

  /* ---------------------------------------------------------------- A */
  section('[A] 无偏好：正常建方案，约束检查齐全')
  const a = await post('/api/plans', planBody({ slots: [{ slot: 'shoes', status: 'to_buy', productId: otherShoe.productId }] }))
  expect(a.status === 200, '建方案成功', `${a.status}`)
  expect(Boolean(a.body.planId), '返回 planId')
  const checkIds = (a.body.prefChecks ?? []).map((c) => c.id).sort()
  expect(JSON.stringify(checkIds) === JSON.stringify(['arrival', 'budget', 'shipTo']), '返回预算/到货/收货地三项检查', checkIds.join(','))
  expect((a.body.prefConflicts ?? []).length === 0, '无冲突')
  OBS.plans.noPref = { planId: a.body.planId, checks: a.body.prefChecks }

  /* ---------------------------------------------------------------- B */
  section('[B] 已确认「避开 Rothy\'s」→ 建方案被拒绝，且不落库')
  const before = statePlans()
  const prefB = await post('/api/prefs', {
    attr: 'brand_avoid',
    value: "Rothy's",
    scope: 'profile',
    quote: '我以后都不想买 Rothy\'s 的鞋',
  })
  expect(prefB.status === 200, '用户确认一条 brand_avoid')
  const rejectId = `pln_reject_${Date.now()}`
  const b = await post(
    '/api/plans',
    planBody({ planId: rejectId, slots: [{ slot: 'shoes', status: 'to_buy', productId: rothyShoe.productId }] }),
  )
  expect(b.status === 422 && b.body.code === 'PREF_CONFLICT', '返回 422 PREF_CONFLICT', `${b.status} ${b.body.code ?? ''}`)
  expect(Boolean(b.body.hint), '带可执行的下一步提示')
  const v = b.body.details?.violations?.[0]
  expect(Boolean(v && v.productId === rothyShoe.productId), '指出具体冲突商品', v?.title)
  expect(Boolean(v?.rules?.includes('brand_avoid')), '指出冲突规则', (v?.rules ?? []).join(','))
  expect(Boolean(v?.reasons?.[0]?.includes("Rothy")), '原因是人话', v?.reasons?.[0])
  const afterPlans = statePlans()
  expect(!afterPlans.includes(rejectId) && afterPlans.length === before.length, 'state.json 里没有这条方案（拒绝就是拒绝）', `${before.length} → ${afterPlans.length}`)
  const getB = await api(`/api/plans/${rejectId}`)
  expect(getB.status >= 400, '按 ID 也读不到未创建的方案', String(getB.status))
  OBS.steps.push({ step: 'B.reject', status: b.status, code: b.body.code, violations: b.body.details?.violations, hint: b.body.hint })

  /* ---------------------------------------------------------------- C */
  section('[C] 授权规则不匹配 → 仍然拒绝')
  const c = await post(
    '/api/plans',
    planBody({
      planId: `pln_c_${Date.now()}`,
      slots: [{ slot: 'shoes', status: 'to_buy', productId: rothyShoe.productId }],
      prefOverride: { rules: ['avoid'], quote: '这次就买 Rothy\'s 吧' },
    }),
  )
  expect(c.status === 422, '授权的是 avoid，但冲突是 brand_avoid → 仍然 422', String(c.status))
  expect(!statePlans().some((id) => id.startsWith('pln_c_')), '没有落库')

  /* ---------------------------------------------------------------- D */
  section('[D] 非法破例：未知规则 / 缺少用户原话 → 拒绝')
  const d1 = await post(
    '/api/plans',
    planBody({
      planId: `pln_d_${Date.now()}`,
      slots: [{ slot: 'shoes', status: 'to_buy', productId: rothyShoe.productId }],
      prefOverride: { rules: ['whatever'], quote: '随便' },
    }),
  )
  expect(d1.status === 422 && /不认识/.test(d1.body.error ?? ''), '未知规则被拒', d1.body.error)
  const d2 = await post(
    '/api/plans',
    planBody({
      planId: `pln_d2_${Date.now()}`,
      slots: [{ slot: 'shoes', status: 'to_buy', productId: rothyShoe.productId }],
      prefOverride: { rules: ['brand_avoid'], quote: '' },
    }),
  )
  expect(d2.status === 422 && /原话/.test(d2.body.error ?? ''), '缺原话被拒（不能替用户决定）', d2.body.error)

  /* ---------------------------------------------------------------- E */
  section('[E] 用户明确授权破例 → 方案成功，只对这套方案生效')
  const allowId = `pln_allow_${Date.now()}`
  const e = await post(
    '/api/plans',
    planBody({
      planId: allowId,
      slots: [{ slot: 'shoes', status: 'to_buy', productId: rothyShoe.productId }],
      prefOverride: { rules: ['brand_avoid'], quote: '这次破例，我就想买这双 Rothy\'s' },
    }),
  )
  expect(e.status === 200 && e.body.planId === allowId, '破例授权后建方案成功', `${e.status}`)
  expect((e.body.prefExempt ?? []).length === 1, '响应里标明这件是破例放行')
  expect((e.body.prefExceptions ?? [])[0]?.quote?.includes('这次破例'), '方案上记录了用户原话')
  const getE = await api(`/api/plans/${allowId}`)
  expect((getE.body.prefExceptions ?? []).length === 1, '方案详情可复核破例记录')
  expect(statePlans().includes(allowId), '这次确实落库了')
  // 长期偏好没被放宽：换件候选里 Rothy's 仍然被排除
  const candAfterAllow = await api(`/api/plans/${allowId}/candidates?slot=shoes&strategy=similar`)
  const stillExcluded = (candAfterAllow.body.excluded ?? []).some((x) => /Rothy/i.test(x.vendor ?? '') || x.productId === rothyShoe.productId)
  expect(stillExcluded, '长期偏好没有因为一次破例被放宽（候选里仍排除 Rothy\'s）')
  OBS.steps.push({ step: 'E.allow_once', planId: allowId, exceptions: e.body.prefExceptions, excluded: (candAfterAllow.body.excluded ?? []).length })

  /* ---------------------------------------------------------------- F */
  section('[F] 尺码不符 → 拒绝')
  const f = await post('/api/prefs', { attr: 'size_shoes', value: 'XXL', scope: 'profile', quote: '我穿 XXL 的鞋' })
  expect(f.status === 200, '确认一条 size_shoes=XXL')
  const fRes = await post(
    '/api/plans',
    planBody({ planId: `pln_f_${Date.now()}`, slots: [{ slot: 'shoes', status: 'to_buy', productId: otherShoe.productId }] }),
  )
  expect(fRes.status === 422 && fRes.body.details?.violations?.[0]?.rules?.includes('size_shoes'), '尺码不符被拒', String(fRes.status))
  // 清掉，避免影响后续
  const allPrefs = (await api('/api/prefs')).body.all ?? []
  for (const p of allPrefs) if (!p.deletedAt && p.attr === 'size_shoes') await del(`/api/prefs/${p.id}`)

  /* ---------------------------------------------------------------- G */
  section('[G] 待确认 / 已删除 / 跨方案的偏好不阻断')
  // 先清掉 B 段确认的那条，否则「未确认不阻断」会被已确认的旧值挡住，测的就不是待确认
  for (const p of (await api('/api/prefs')).body.all ?? []) {
    if (!p.deletedAt && p.attr === 'brand_avoid' && p.scope === 'profile' && p.confirmedByUser) await del(`/api/prefs/${p.id}`)
  }
  const gPropose = await post('/api/prefs/propose', {
    attr: 'brand_avoid',
    value: "Rothy's",
    scope: 'profile',
    evidence: { basis: 'chat', quote: '好像不太喜欢这个牌子' },
  })
  expect(gPropose.status === 200 && gPropose.body.action !== 'skip_rejected', '写入一条待确认的避开品牌', gPropose.body.action)
  const g1 = await post(
    '/api/plans',
    planBody({ planId: `pln_g1_${Date.now()}`, slots: [{ slot: 'shoes', status: 'to_buy', productId: rothyShoe.productId }] }),
  )
  expect(g1.status === 200, '未确认的偏好不阻断（它本来就不该生效）', String(g1.status))

  const gOther = await post('/api/prefs', {
    attr: 'brand_avoid',
    value: "Rothy's",
    scope: 'task',
    taskKey: 'pln_some_other_plan',
    quote: '这套方案先用别的牌子',
  })
  expect(gOther.status === 200, '写入一条「别的方案」的临时偏好')
  const g2 = await post(
    '/api/plans',
    planBody({ planId: `pln_g2_${Date.now()}`, slots: [{ slot: 'shoes', status: 'to_buy', productId: rothyShoe.productId }] }),
  )
  expect(g2.status === 200, '别的方案的 task 偏好不影响新方案', String(g2.status))

  // 删除已确认的偏好 → 再建方案应放行（删除只是停止生效，记录仍在历史里）
  const gConf = await post('/api/prefs', { attr: 'brand_avoid', value: "Rothy's", scope: 'profile', quote: '先记一下' })
  expect(gConf.status === 200, '写入一条已确认的 brand_avoid')
  const gBlock = await post(
    '/api/plans',
    planBody({ planId: `pln_g0_${Date.now()}`, slots: [{ slot: 'shoes', status: 'to_buy', productId: rothyShoe.productId }] }),
  )
  expect(gBlock.status === 422, '已确认时确实被拦下（对照组）', String(gBlock.status))
  await del(`/api/prefs/${gConf.body.id}`)
  const g3 = await post(
    '/api/plans',
    planBody({ planId: `pln_g3_${Date.now()}`, slots: [{ slot: 'shoes', status: 'to_buy', productId: rothyShoe.productId }] }),
  )
  expect(g3.status === 200, '删除偏好后可以正常建方案（历史仍可追溯）', String(g3.status))

  /* ---------------------------------------------------------------- H */
  section('[H] 类目错位 → 409，不落库')
  const hId = `pln_h_${Date.now()}`
  const h = await post('/api/plans', planBody({ planId: hId, slots: [{ slot: 'shoes', status: 'to_buy', productId: coat.productId }] }))
  expect(h.status === 409 && h.body.code === 'CATEGORY_MISMATCH', '把外套塞进鞋位被拒', `${h.status} ${h.body.code ?? ''}`)
  expect(!statePlans().includes(hId), '没有落库')

  /* ---------------------------------------------------------------- I */
  section('[I] 换件路径：硬排除 + 解释字段')
  const iPlan = a.body.planId
  // 重新加回 brand_avoid，验证换件仍然排除
  const iPref = await post('/api/prefs', { attr: 'brand_avoid', value: "Rothy's", scope: 'profile', quote: '以后都不买 Rothy\'s' })
  expect(iPref.status === 200, '确认 brand_avoid 用于换件验证')
  const iCand = await api(`/api/plans/${iPlan}/candidates?slot=shoes&strategy=similar`)
  expect((iCand.body.excluded ?? []).length > 0, '换件候选里仍有排除项', `${(iCand.body.excluded ?? []).length} 件`)
  expect((iCand.body.applied ?? []).length > 0, '返回实际生效的规则')
  const iSwap = await post(`/api/plans/${iPlan}/swap`, { slot: 'shoes', strategy: 'similar' })
  expect(iSwap.status === 200, '换件成功', String(iSwap.status))
  const picked = iSwap.body.prefRanking?.picked
  expect(Boolean(picked), '返回 picked 解释（哪件、多少分、名次）')
  expect(typeof picked?.prefBonus === 'number', 'prefBonus 是数字', String(picked?.prefBonus))
  expect(Array.isArray(picked?.prefWhys), 'prefWhys 是数组')
  expect(picked?.rankWithoutPrefs !== undefined, '同时给出「无偏好时名次」，用于区分加分但没改变名次')
  OBS.plans.swap = { picked, applied: iSwap.body.prefRanking?.applied, excluded: (iSwap.body.prefRanking?.excluded ?? []).length }
  // 无偏好基线：删掉偏好后同一策略，picked 名次应与 withPrefs 一致
  const allI = (await api('/api/prefs')).body.all ?? []
  for (const p of allI) if (!p.deletedAt && p.attr === 'brand_avoid') await del(`/api/prefs/${p.id}`)
  const iSwap2 = await post(`/api/plans/${iPlan}/swap`, { slot: 'shoes', strategy: 'similar' })
  const picked2 = iSwap2.body.prefRanking?.picked
  expect(picked2?.prefBonus === 0 && picked2?.rankWithoutPrefs === picked2?.rankWithPrefs, '无偏好时：0 加分、名次相同（解释不会编造影响）', `${picked2?.prefBonus} / ${picked2?.rankWithPrefs}`)

  /* ---------------------------------------------------------------- J */
  section('[J] 预算 / 到货：如实报 violated 或 unverified')
  const j = await post(
    '/api/plans',
    planBody({ planId: `pln_j_${Date.now()}`, budgetLimit: 5, slots: [{ slot: 'shoes', status: 'to_buy', productId: otherShoe.productId }] }),
  )
  expect(j.status === 200, '预算检查不阻断建方案（用户自己的数字，需要可见而不是被隐藏）', String(j.status))
  const jBudget = (j.body.prefChecks ?? []).find((c) => c.id === 'budget')
  expect(jBudget?.status === 'violated', '预算超支如实标 violated', jBudget?.detail)
  const j2 = await post(
    '/api/plans',
    planBody({ planId: `pln_j2_${Date.now()}`, budgetLimit: 5000, slots: [{ slot: 'shoes', status: 'to_buy', productId: otherShoe.productId }] }),
  )
  const j2Budget = (j2.body.prefChecks ?? []).find((c) => c.id === 'budget')
  expect(j2Budget?.status === 'unverified', '关税不可用时预算只能算估算（不能报 ok）', j2Budget?.detail)

  /* ---------------------------------------------------------------- K */
  section('[K] Studio 旧契约：页面能打开，候选抽屉可用')
  if (!EDGE) {
    log('没有 Edge/Chrome，跳过 UI 段')
  } else {
    const browser = await chromium.launch({ executablePath: EDGE, headless: true })
    BROWSER = browser
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(`${BASE}/?plan=${iPlan}`, { waitUntil: 'networkidle' })
    expect(await page.locator('#stage').count() === 1, '方案页 #stage 仍在')
    const prefNote = page.locator('.cand-prefnote')
    await page.locator('button[data-select="shoes"]').first().click()
    await page.waitForTimeout(1200)
    expect(await page.locator('#candidates').count() === 1, '候选抽屉仍能打开')
    OBS.ui.candidatesVisible = await page.locator('#candidates').isVisible()
    OBS.ui.prefNote = (await prefNote.count()) > 0
    await page.screenshot({ path: join(OUT, 'studio-plan-1440.png') })
    // 首页（偏好管理入口）仍然完整
    const home = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await home.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    expect(await home.locator('#prefs-list').count() === 1, '首页 #prefs-list 仍在')
    expect(await home.locator('#prefs-pending').count() === 1, '首页 #prefs-pending 仍在')
    await home.locator('#prefs').evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await home.locator('#prefs').screenshot({ path: join(OUT, 'home-prefs-1440.png') })
    await browser.close()
  }

  /* ---------------------------------------------------------------- 收尾 */
  writeFileSync(join(REPO, 'docs', 'F4-验收证据.json'), JSON.stringify(OBS, null, 2))
  console.log(`\n[f4] 通过 ${pass} 项，失败 ${fail} 项`)
  if (fail) console.log(`失败项：${failures.join(' / ')}`)
}

main()
  .catch((e) => {
    fail += 1
    console.error('\n[f4] 异常：', e)
  })
  .finally(async () => {
    if (BROWSER) await BROWSER.close().catch(() => {})
    if (CHILD) CHILD.kill()
    // Playwright / 子进程有时还挂着句柄，这里显式退出，避免验收脚本假死
    setTimeout(() => process.exit(fail ? 1 : 0), 300)
  })
