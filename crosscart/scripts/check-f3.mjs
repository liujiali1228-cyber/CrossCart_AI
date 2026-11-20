/**
 * Phase 5 F3 端到端验收：AI 提议 → 用户确认/拒绝 → 推荐生效/失效。
 *
 * 为什么用隔离实例：
 *  - 真实 data/state.json 里是用户自己的偏好，验收不许改它；
 *  - 隔离目录里从空偏好开始，才能证明「没有任何偏好时，提议不影响推荐」。
 *
 * 覆盖 8 条验收场景（见 docs / HANDOFF §9.10）：
 *  A 推断新偏好      → 待确认，推荐逐位不变
 *  B 与长期偏好冲突  → 原长期继续生效
 *  C 重复推断        → 不产生重复记录（同值跳过 / 不同值就地更新）
 *  D 用户拒绝        → 提议失效，同值不再出现
 *  E 用户确认        → 新值生效，旧值进历史
 *  F 用户删除        → 停止生效，历史可追溯
 *  G 临时换件        → 不自动变成长期偏好
 *  H 明确排除        → 排空候选时不静默放宽
 *  I 首页 UI         → 确认/拒绝/删除真实可点，状态实时刷新
 *
 *   node scripts/check-f3.mjs
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.cwd()
const PORT = 8793
const BASE = `http://127.0.0.1:${PORT}`
const OUT = join(REPO, 'shots', 'f3')
mkdirSync(OUT, { recursive: true })
const OBS = { startedAt: new Date().toISOString(), steps: [], ranking: {}, ui: {} }

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
  const data = mkdtempSync(join(tmpdir(), 'cc-f3-'))
  cpSync(join(REPO, 'data', 'state.json'), join(data, 'state.json'))
  if (existsSync(join(REPO, 'data', 'live'))) cpSync(join(REPO, 'data', 'live'), join(data, 'live'), { recursive: true })
  if (existsSync(join(REPO, 'data', 'scenes'))) cpSync(join(REPO, 'data', 'scenes'), join(data, 'scenes'), { recursive: true })
  // 从「零偏好」开始，才能验证无偏好基线与提议后的推荐完全一致
  const st = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
  st.prefs = []
  writeFileSync(join(data, 'state.json'), JSON.stringify(st, null, 2))
  return data
}

let CHILD = null
async function startInstance(data) {
  CHILD = spawn(process.execPath, [join(REPO, 'packages', 'bridge', 'src', 'server.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      CROSSCART_PORT: String(PORT),
      CROSSCART_DATA_DIR: data,
      SCENEGEN_AUTO_DEBOUNCE_MS: '999999',
    },
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

const PLAN = 'pln_020'
const candUrl = (slot = 'shoes') => `/api/plans/${PLAN}/candidates?slot=${slot}&strategy=similar`
const sig = (body) => (body.candidates ?? []).map((c) => `${c.productId}:${c.score}`)
const sameSig = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const data = makeDataDir()
  await startInstance(data)

  section('[A] AI 推断一条新偏好 → 待确认，推荐逐位不变')
  const base0 = await api(candUrl('shoes'))
  const sig0 = sig(base0.body)
  log(`无偏好基线：${sig0.length} 件，top1 ${sig0[0]}`)

  const p1 = await post('/api/prefs/propose', {
    attr: 'palette',
    value: 'dark',
    scope: 'profile',
    planId: PLAN,
    evidence: { basis: 'swap', ref: PLAN, quote: '连续两次把鞋换成深色', slot: 'shoes' },
  })
  expect(p1.status === 200 && p1.body.action === 'create', '提议写入成功（action=create）', p1.body.action)
  const pid = p1.body.record?.id
  expect(p1.body.record?.confirmedByUser === false, '记录是 confirmedByUser=false')
  expect(p1.body.record?.source === 'ai', '来源记为 ai')
  expect(Boolean(p1.body.record?.evidence?.quote), '依据被保存', p1.body.record?.evidence?.quote)
  OBS.steps.push({ step: 'A.propose', record: p1.body.record })

  const viewA = await api('/api/prefs')
  expect(viewA.body.pending?.length === 1, '待确认列表有 1 条')
  expect((viewA.body.prefs ?? []).length === 0, '生效偏好仍为空（未确认不生效）')
  expect(!viewA.body.brief?.text?.includes('dark'), '计划上下文 brief 不含未确认值')

  const sigA = sig((await api(candUrl('shoes'))).body)
  expect(sameSig(sigA, sig0), '候选 ID/分数/顺序与无偏好基线逐位相同')

  section('[B] 推断与已确认偏好冲突 → 原长期偏好继续生效')
  const saved = await post('/api/prefs', { attr: 'palette', value: 'light', scope: 'profile' })
  expect(saved.status === 200, '用户先确认一条 palette=light')
  const lightView = (await api(candUrl('shoes'))).body
  const sigLight = sig(lightView)
  const lightChanged = !sameSig(sigLight, sig0)
  expect(lightChanged, '已确认偏好确实进入了推荐（基线已变）')
  const lightBonus = (lightView.candidates ?? []).filter((c) => c.prefBonus > 0).length
  log(`light 生效：${lightBonus} 件候选加分（上限 +0.05），top1 ${sigLight[0]}`)
  OBS.ranking.light = sigLight.slice(0, 5)
  OBS.ranking.lightBonus = lightBonus
  OBS.ranking.baseline = sig0.slice(0, 5)

  const p2 = await post('/api/prefs/propose', {
    attr: 'palette',
    value: 'dark',
    scope: 'profile',
    planId: PLAN,
    evidence: { basis: 'swap', ref: PLAN, quote: '这次又把鞋换成了深色款', slot: 'shoes' },
  })
  expect(p2.body.action === 'create', '与已确认值不同 → 新建冲突提议（不覆盖）', p2.body.action)
  const viewB = await api('/api/prefs')
  const lightRec = (viewB.body.all ?? []).find((p) => p.id === saved.body.id)
  expect((viewB.body.prefs ?? []).some((p) => p.value === 'light'), 'light 仍是生效值')
  expect(!lightRec?.supersededBy, 'light 没有被标记为已取代')
  expect(viewB.body.pending.length === 1 && viewB.body.pending[0].value === 'dark', '待确认里是 dark')
  const aPending = (viewB.body.all ?? []).find((p) => p.id === pid)
  expect(Boolean(aPending?.supersededBy), 'A 段的旧提议在用户确认 light 后自动作废（不会同时留两条）')
  expect(viewB.body.brief?.text?.includes('light') && !viewB.body.brief?.text?.includes('dark'), 'brief 只有 light')
  const sigB = sig((await api(candUrl('shoes'))).body)
  expect(sameSig(sigB, sigLight), '推荐结果与只有 light 时完全相同（dark 没生效）')
  OBS.steps.push({ step: 'B.propose_conflict', record: p2.body.record })

  section('[C] 重复推断 → 不产生重复待确认记录')
  const before = (await api('/api/prefs')).body.all.length
  const dup = await post('/api/prefs/propose', {
    attr: 'palette',
    value: 'dark',
    scope: 'profile',
    planId: PLAN,
    evidence: { basis: 'swap', ref: PLAN, quote: '又一次换成深色' },
  })
  expect(dup.body.action === 'skip_duplicate', '同值提议被跳过', dup.body.action)
  const mid = await post('/api/prefs/propose', {
    attr: 'palette',
    value: 'mid',
    scope: 'profile',
    planId: PLAN,
    evidence: { basis: 'selection', ref: PLAN, quote: '在候选里挑了中性色' },
  })
  expect(mid.body.action === 'update_pending', '同槽位新值就地更新', mid.body.action)
  const after = await api('/api/prefs')
  expect(after.body.all.length === before, '记录总数没有增加（不是每次提议都新增）', `${before} → ${after.body.all.length}`)
  expect(after.body.pending.length === 1 && after.body.pending[0].value === 'mid', '待确认仍只有 1 条且值为 mid')

  section('[D] 用户拒绝 → 提议失效，同值不再自动出现')
  const rej = await patch(`/api/prefs/${mid.body.record.id}/reject`, { reason: '我并没有偏好中性色' })
  expect(rej.status === 200 && Boolean(rej.body.rejectedAt), '拒绝成功并留下时间戳')
  const viewD = await api('/api/prefs')
  expect(viewD.body.pending.length === 0, '待确认清空')
  expect((viewD.body.prefs ?? []).some((p) => p.value === 'light'), 'light 不受影响，继续生效')
  const again = await post('/api/prefs/propose', {
    attr: 'palette',
    value: 'mid',
    scope: 'profile',
    planId: PLAN,
    evidence: { basis: 'swap', ref: PLAN, quote: '再观察一次' },
  })
  expect(again.body.action === 'skip_rejected' && again.body.changed === false, '同值不再重复提议', again.body.action)
  expect((await api('/api/prefs')).body.pending.length === 0, '拒绝后确实没有新增待确认')
  const other = await post('/api/prefs/propose', {
    attr: 'palette',
    value: 'dark',
    scope: 'profile',
    planId: PLAN,
    evidence: { basis: 'chat', quote: '我说过这次想试试深色' },
  })
  expect(other.body.action === 'create', '拒绝只封同值：不同值仍可提议', other.body.action)
  OBS.steps.push({ step: 'D.reject', record: rej.body })

  section('[E] 用户确认 → 新偏好生效，旧值进历史')
  const confirmId = other.body.record.id
  const conf = await patch(`/api/prefs/${confirmId}/confirm`, {})
  expect(conf.status === 200 && conf.body.confirmedByUser === true, '确认成功')
  const viewE = await api('/api/prefs')
  const lightAfter = (viewE.body.all ?? []).find((p) => p.id === saved.body.id)
  expect((viewE.body.prefs ?? []).some((p) => p.value === 'dark'), 'dark 成为生效值')
  expect(lightAfter?.supersededBy === confirmId, 'light 被标为已取代（历史保留）', lightAfter?.supersededBy)
  expect((viewE.body.all ?? []).length >= 4, '历史记录没有被删除', `${viewE.body.all.length} 条`)
  expect(viewE.body.brief?.text?.includes('dark'), 'brief 现在注入 dark')
  const sigE = sig((await api(candUrl('shoes'))).body)
  expect(!sameSig(sigE, sigB), '推荐结果随确认而改变（light 的加分被撤掉）')
  const eView = (await api(candUrl('shoes'))).body
  const eApplied = (eView.applied ?? []).join('；')
  expect(/dark/.test(eApplied) && !/light/.test(eApplied), '参与排序的规则换成了 dark（不再是 light）', eApplied)
  const eBonus = (eView.candidates ?? []).filter((c) => c.prefBonus > 0).length
  // 诚实记录：真实目录里鞋类没有深色款时，dark 命中 0 件，分数回到基础分，不是"偏好没生效"
  log(`dark 生效后：加分候选 ${eBonus} 件（鞋类若无深色款则为 0，属商品标签限制）`)
  OBS.ranking.afterConfirm = sigE.slice(0, 5)
  OBS.ranking.afterConfirmBonus = eBonus
  OBS.ranking.afterConfirmApplied = eApplied
  OBS.steps.push({ step: 'E.confirm', record: conf.body })

  section('[F] 用户删除 → 停止生效，历史可追溯')
  const rm = await del(`/api/prefs/${confirmId}`)
  expect(rm.status === 200 && Boolean(rm.body.deletedAt), '删除成功（软删）')
  const viewF = await api('/api/prefs')
  expect((viewF.body.prefs ?? []).length === 0, '没有生效的颜色偏好')
  expect(!viewF.body.brief?.text?.includes('dark'), 'brief 不再注入 dark')
  const sigF = sig((await api(candUrl('shoes'))).body)
  expect(sameSig(sigF, sig0), '推荐回到无该偏好时的结果')
  const hist = (viewF.body.all ?? []).filter((p) => p.deletedAt || p.rejectedAt || p.supersededBy)
  expect(hist.length >= 3, '删除/拒绝/取代记录都可追溯', `${hist.length} 条`)

  section('[G] 临时换件 ≠ 长期偏好')
  const swap = await post(`/api/plans/${PLAN}/swap`, { slot: 'shoes', strategy: 'lighter', by: 'ui' })
  expect(swap.status === 200, '换件成功')
  const viewG = await api('/api/prefs')
  expect(viewG.body.all.length === viewF.body.all.length, '换件本身没有写入任何偏好')
  const taskProposal = await post('/api/prefs/propose', {
    attr: 'style',
    value: 'minimal',
    scope: 'task',
    planId: PLAN,
    evidence: { basis: 'chat', quote: '这次想简单一点' },
  })
  expect(taskProposal.status === 200 && taskProposal.body.record?.scope === 'task', 'task 提议写入待确认')
  const viewG2 = await api(`/api/prefs?planId=${PLAN}`)
  expect(viewG2.body.pending.length === 1, '待确认可见（用户需要决定）')
  expect((viewG2.body.prefs ?? []).length === 0, '但没有任何偏好生效')
  expect(!viewG2.body.brief?.text?.includes('minimal'), 'brief 不含未确认的 task 提议')
  const noPlan = await post('/api/prefs/propose', {
    attr: 'style',
    value: 'minimal',
    scope: 'task',
    evidence: { basis: 'chat', quote: '随便' },
  })
  expect(noPlan.status === 422, 'scope=task 缺 planId 被拒绝', String(noPlan.status))

  section('[H] 明确排除不放宽：候选排空时如实报错')
  const sizeP = await post('/api/prefs', { attr: 'size_shoes', value: 'XXL', scope: 'profile' })
  expect(sizeP.status === 200, '保存一条明确的尺码要求')
  const blocked = await api(candUrl('shoes'))
  expect((blocked.body.candidates ?? []).length === 0, '候选返回空（不放宽）')
  expect((blocked.body.blockedBy ?? []).length === 1, 'blockedBy 说明挡在哪条要求上', blocked.body.blockedBy?.[0])
  expect(!(blocked.body.relaxed ?? []).some((r) => /回退|未执行排除/.test(r)), '没有"已放弃规则"式静默放宽')
  const swapBlocked = await post(`/api/plans/${PLAN}/swap`, { slot: 'shoes', strategy: 'similar' })
  expect(swapBlocked.status === 422, '换件被拒绝（422）', String(swapBlocked.status))
  expect(/不符合|尺码/.test(swapBlocked.body.error ?? ''), '错误文案说明具体原因', swapBlocked.body.error)
  await del(`/api/prefs/${sizeP.body.id}`)

  section('[I] 首页操作：确认 / 拒绝 / 删除 + 状态实时刷新')
  // 前面的 A–H 会留下很多测试记录。UI 截图要展示真实用户的闭环，所以换一个干净的隔离实例重来。
  if (CHILD) CHILD.kill()
  await new Promise((r) => setTimeout(r, 400))
  CHILD = null
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* Windows 句柄偶发占用，不影响新实例 */
  }
  DATA_DIR = makeDataDir()
  await startInstance(DATA_DIR)
  await post('/api/prefs', { attr: 'palette', value: 'light', scope: 'profile' })

  const browser = await chromium.launch({ executablePath: EDGE, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#prefs')
  await page.locator('#prefs').scrollIntoViewIfNeeded()
  // loadPrefs 是异步的：等第一行真正渲染出来再断言，避免拿到空列表当"没有偏好"
  await page.waitForSelector('#prefs-list .pref-row', { timeout: 6000 })

  const initialRows = await page.locator('#prefs-list .pref-row').count()
  expect(initialRows === 1, '首页显示 1 条已生效偏好', `${initialRows} 条：${(await page.locator('#prefs-list').innerText()).replace(/\n/g, ' / ')}`)
  expect(await page.locator('#prefs-pending').isVisible() === false, '没有提议时不显示待确认区')
  await page.locator('#prefs').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: join(OUT, 'home-prefs-1440-before.png'), fullPage: false })
  await page.locator('#prefs').screenshot({ path: join(OUT, 'panel-prefs-1440-before.png') })

  // AI 提议 —— 不刷新页面，靠 SSE 自己出现
  const uiProp = await post('/api/prefs/propose', {
    attr: 'palette',
    value: 'dark',
    scope: 'profile',
    planId: PLAN,
    evidence: { basis: 'swap', ref: PLAN, quote: '你连续两次把鞋换成深色款', slot: 'shoes' },
  })
  const pendingId = uiProp.body.record.id
  await page.waitForSelector('#prefs-pending:not([hidden])', { timeout: 4000 }).catch(() => {})
  expect(await page.locator('#prefs-pending').isVisible(), '无需刷新页面，待确认区自动出现（SSE）')
  const pendingText = await page.locator('#prefs-pending').innerText()
  expect(/AI 推断/.test(pendingText), '标注了「AI 推断」')
  expect(/连续两次把鞋换成深色款/.test(pendingText), '展示了依据原文')
  expect(await page.locator('#prefs-list .pref-row').count() === 1, '待确认没有混进生效列表')
  await page.locator('#prefs').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: join(OUT, 'home-prefs-1440-pending.png'), fullPage: false })
  await page.locator('#prefs').screenshot({ path: join(OUT, 'panel-prefs-1440-pending.png') })

  // 点「确认」
  await page.locator(`#prefs-pending-list [data-act="confirm"][data-id="${pendingId}"]`).click()
  await page.waitForSelector('#prefs-pending[hidden]', { timeout: 4000 }).catch(() => {})
  expect(await page.locator('#prefs-pending').isVisible() === false, '确认后待确认区消失')
  const activeText = await page.locator('#prefs-list').innerText()
  expect(/dark/.test(activeText), '生效列表出现 dark')
  expect(/AI 推断 · 你已确认/.test(activeText), '生效行标明来源是 AI 推断 + 用户确认')
  expect(!/light/.test(activeText), '旧的 light 不再显示为生效值')
  // Phase 6 / P1：「变更记录」是审计用的开发者视图，消费者页面不再展示（数据仍在库里）。
  // 旧断言读 #pref-history / #history-list 的 DOM，按需求移除；替换为两条等价断言：
  //  ① 页面上确实没有这块（不靠隐藏留一个大空块）② 旧值在 API 层仍可追溯（没删数据）
  const histBlock = await page.evaluate(() => {
    const el = document.querySelector('#pref-history')
    return { present: !!el, listPresent: !!document.querySelector('#history-list') }
  })
  expect(!histBlock.present && !histBlock.listPresent, '变更记录已从消费者页面移除（无残留空块）')
  const allPrefs = (await api('/api/prefs')).body.all ?? []
  const lightAudit = allPrefs.find((p) => p.attr === 'palette' && String(p.value).includes('light'))
  expect(Boolean(lightAudit?.supersededBy), '旧值 light 仍留在审计数据里（被取代，不是被删除）', lightAudit?.supersededBy)
  await page.locator('#prefs').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: join(OUT, 'home-prefs-1440-confirmed.png'), fullPage: false })
  await page.locator('#prefs').screenshot({ path: join(OUT, 'panel-prefs-1440-confirmed.png') })

  // AI 再提议 → 点「拒绝」
  const uiProp2 = await post('/api/prefs/propose', {
    attr: 'style',
    value: 'photo',
    scope: 'profile',
    planId: PLAN,
    evidence: { basis: 'selection', ref: PLAN, quote: '你连着挑了两次出片款' },
  })
  await page.waitForSelector('#prefs-pending:not([hidden])', { timeout: 4000 }).catch(() => {})
  await page.locator(`#prefs-pending-list [data-act="reject"][data-id="${uiProp2.body.record.id}"]`).click()
  await page.waitForSelector('#prefs-pending[hidden]', { timeout: 4000 }).catch(() => {})
  expect(await page.locator('#prefs-pending').isVisible() === false, '拒绝后待确认区消失')
  const afterReject = await api('/api/prefs')
  expect((afterReject.body.prefs ?? []).every((p) => p.value !== 'photo'), '被拒绝的提议没有生效')
  expect((afterReject.body.all ?? []).some((p) => p.rejectedAt), '拒绝记录留痕')

  // 删除已生效的 dark
  await page.locator('#prefs-list [data-act="delete"]').first().click()
  await page.waitForSelector('#prefs-list .pref-row', { state: 'detached', timeout: 4000 }).catch(() => {})
  expect(await page.locator('#prefs-list .pref-row').count() === 0, '删除后生效列表清空')
  const afterDelete = await api('/api/prefs')
  expect((afterDelete.body.prefs ?? []).length === 0, '服务端也已停止生效')

  // 390 移动端：操作按钮仍可点
  const m = await browser.newPage({ viewport: { width: 390, height: 844 } })
  m.on('pageerror', (e) => errors.push(String(e)))
  await m.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await m.waitForSelector('#prefs')
  const uiProp3 = await post('/api/prefs/propose', {
    attr: 'brand_prefer',
    value: 'Cuyana',
    scope: 'profile',
    planId: PLAN,
    evidence: { basis: 'chat', quote: '你说过喜欢 Cuyana 的包' },
  })
  await m.locator('#prefs').scrollIntoViewIfNeeded()
  await m.waitForSelector('#prefs-pending:not([hidden])', { timeout: 4000 }).catch(() => {})
  const mBox = await m.locator(`#prefs-pending-list [data-act="confirm"][data-id="${uiProp3.body.record.id}"]`).boundingBox()
  expect(Boolean(mBox && mBox.width > 60), '390px 下确认按钮可见可点', mBox ? `${Math.round(mBox.width)}px` : 'none')
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow <= 0, '移动端没有横向溢出', `${overflow}px`)
  await m.locator('#prefs').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await m.screenshot({ path: join(OUT, 'home-prefs-390-pending.png'), fullPage: false })
  await m.locator('#prefs').screenshot({ path: join(OUT, 'panel-prefs-390-pending.png') })

  expect(errors.length === 0, '页面没有 JS 报错', errors.join(' | '))

  await browser.close()
  OBS.ui = {
    pendingScreenshot: 'shots/f3/home-prefs-1440-pending.png',
    confirmedScreenshot: 'shots/f3/home-prefs-1440-confirmed.png',
    mobileScreenshot: 'shots/f3/home-prefs-390-pending.png',
  }
  OBS.ranking.baseline = sig0.slice(0, 5)

  writeFileSync(join(REPO, 'docs', 'F3-闭环记录.json'), JSON.stringify(OBS, null, 2))
  DATA_DIR = data
}

let DATA_DIR = null

function rmSyncIfWanted() {
  if (!DATA_DIR) return
  if (process.env.KEEP_F3_DATA === '1') {
    console.log(`\n隔离数据保留在 ${DATA_DIR}`)
    return
  }
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* 忽略 Windows 上偶发的占用 */
  }
}

main()
  .catch((e) => {
    console.error(`\n[f3] 失败：${e?.stack ?? e}`)
    fail += 1
  })
  .finally(async () => {
    if (CHILD) CHILD.kill()
    await new Promise((r) => setTimeout(r, 300))
    rmSyncIfWanted()
    console.log(`\n[f3] 通过 ${pass} 项，失败 ${fail} 项`)
    if (fail > 0) {
      console.log(`[f3] 失败项：\n${failures.map((f) => `  - ${f}`).join('\n')}`)
      process.exitCode = 1
    }
  })
