/**
 * Phase 6 · P5：「已拥有」状态必须来自用户声明。
 *
 * 背景（真实 bug）：每份新方案都会凭空多出一条「已拥有：深色直筒牛仔裤」。
 * 两条通路：① 建方案工具的示例参数里就写了 status=owned + own_dark_jeans，
 *          ② 上一份方案的「已有」被注入下一轮上下文，越滚越像真的。
 *
 * 这里验的不是「界面藏没藏标签」，而是数据层到底认不认这件事：
 *   A 用户没说过 → 建方案直接 422，且不落库
 *   B 用户说过   → 允许 owned，并记下原话
 *   C 新建另一方案不继承上一份的 owned
 *   D 新开聊天不继承（聊天状态不是所有权来源）
 *   E 返回历史方案：数据不清除，但上下文/界面都不把它当成用户真的拥有
 *   F 旧 Demo seed / 历史遗留的 owned 不污染新方案
 *
 * 全程跑在 mkdtemp 副本上，不碰真实 data/。不需要模型，零费用。
 *   node scripts/check-p6-owned.mjs
 *   KEEP_P6_OWNED=1 node scripts/check-p6-owned.mjs   # 保留隔离数据
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../packages/bridge/src/state.mjs'
import { planContext } from '../packages/bridge/src/plan-context.mjs'

const REPO = process.cwd()
const PORT = 8798
const BASE = `http://127.0.0.1:${PORT}`
const JEANS = 'own_dark_jeans'
const QUOTE = '我有一条深色直筒牛仔裤，不用再买'

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

function makeDataDir() {
  const data = mkdtempSync(join(tmpdir(), 'cc-p6own-'))
  cpSync(join(REPO, 'data', 'state.json'), join(data, 'state.json'))
  if (existsSync(join(REPO, 'data', 'live'))) cpSync(join(REPO, 'data', 'live'), join(data, 'live'), { recursive: true })
  if (existsSync(join(REPO, 'data', 'scenes'))) cpSync(join(REPO, 'data', 'scenes'), join(data, 'scenes'), { recursive: true })
  return data
}

let CHILD = null
let DATA = null
async function startInstance(data) {
  DATA = data
  CHILD = spawn(process.execPath, [join(REPO, 'packages', 'bridge', 'src', 'server.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      CROSSCART_PORT: String(PORT),
      CROSSCART_DATA_DIR: data,
      CROSSCART_BRIDGE_URL: BASE,
      SCENEGEN_AUTO_DEBOUNCE_MS: '999999',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  CHILD.stdout.on('data', () => {})
  CHILD.stderr.on('data', (d) => {
    const line = String(d).trim()
    if (line) log(`[instance] ${line.slice(0, 160)}`)
  })
  for (let i = 0; i < 80; i++) {
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
const planCount = async () => ((await api('/api/plans')).body.plans ?? []).length

/** 直接读隔离目录的最新状态 —— 用来断言「上下文里到底怎么写的」。 */
async function ctxFor(planId) {
  const ws = new Workspace({ dataDir: DATA })
  // 「这段对话从什么时候开始」是内存态，必须从运行中的实例取，否则会误判成「永不重置」
  ws.chatEpochStart = (await api('/api/chat')).body.chatEpochStart ?? null
  return planContext(ws, planId)
}
function planOnDisk(planId) {
  const st = JSON.parse(readFileSync(join(DATA, 'state.json'), 'utf8'))
  return (st.plans ?? []).find((p) => p.planId === planId) ?? null
}

function basePayload(extra = {}) {
  return {
    label: 'P5 验收 · 东京 3 天',
    scene: { type: 'travel', destination: 'Tokyo', days: 3 },
    budgetLimit: 400,
    arrivalBy: '2026-12-20',
    ...extra,
  }
}

async function main() {
  await startInstance(makeDataDir())
  const items = (await api('/api/catalog?limit=400')).body.items ?? []
  const coat = items.find((c) => c.category === 'outerwear' && c.sourceKind !== 'seed') ?? items.find((c) => c.category === 'outerwear')
  const top = items.find((c) => c.category === 'top' && c.sourceKind !== 'seed') ?? items.find((c) => c.category === 'top')
  expect(Boolean(coat && top), '目录里取到真实商品用于建方案', `${coat?.productId} / ${top?.productId}`)

  /* ============================================================ A */
  section('[A] 用户没说过「已有」→ 建方案必须被拒，且不落库')
  const before = await planCount()
  const noClaim = await post(
    '/api/plans',
    basePayload({
      slots: [
        { slot: 'outerwear', status: 'to_buy', productId: coat.productId },
        { slot: 'bottom', status: 'owned', productId: JEANS },
      ],
    }),
  )
  expect(noClaim.status === 422, '未声明 owned → HTTP 422', String(noClaim.status))
  expect(noClaim.body.code === 'OWNED_UNDECLARED', '错误码是 OWNED_UNDECLARED', noClaim.body.code)
  expect(/没有说过|没说过/.test(String(noClaim.body.error)), '错误信息说清「用户这次没说过」', String(noClaim.body.error).slice(0, 60))
  expect(
    /ownedClaims/.test(String(noClaim.body.hint)) && /to_buy|empty/.test(String(noClaim.body.hint)),
    'hint 给出了可执行的补救路径（带 ownedClaims，或改 to_buy/empty）',
    String(noClaim.body.hint).slice(0, 56),
  )
  expect(noClaim.body.details?.slot === 'bottom', 'details 指出具体是哪个搭配位', JSON.stringify(noClaim.body.details))
  const after = await planCount()
  expect(after === before, '方案数量没变（没有偷偷落库）', `${before} → ${after}`)
  // 只要 claim 存在就放行的宽松实现也是错的：claim 必须对上同一个商品
  const wrongClaim = await post(
    '/api/plans',
    basePayload({
      slots: [{ slot: 'bottom', status: 'owned', productId: JEANS }],
      ownedClaims: [{ productId: 'cuyana:something-else', quote: '我有一条别的裤子' }],
    }),
  )
  expect(wrongClaim.status === 422, 'claim 对上商品才算数（错商品仍 422）', String(wrongClaim.status))
  // 空原话也不算声明
  const emptyQuote = await post(
    '/api/plans',
    basePayload({
      slots: [{ slot: 'bottom', status: 'owned', productId: JEANS }],
      ownedClaims: [{ productId: JEANS, quote: ' ' }],
    }),
  )
  expect(emptyQuote.status === 422, '空原话不算声明（quote 必填）', String(emptyQuote.status))

  /* ============================================================ B */
  section('[B] 用户明确说过 → 允许 owned，并把原话记在槽位上')
  const declared = await post(
    '/api/plans',
    basePayload({
      slots: [
        { slot: 'outerwear', status: 'to_buy', productId: coat.productId },
        { slot: 'bottom', status: 'owned', productId: JEANS },
      ],
      ownedClaims: [{ productId: JEANS, quote: QUOTE }],
    }),
  )
  expect(declared.status === 200, '声明后建方案成功', String(declared.status))
  const claimedId = declared.body.planId
  const claimedSlot = (declared.body.slots ?? []).find((s) => s.slot === 'bottom')
  expect(claimedSlot?.status === 'owned', '裤装状态是 owned', claimedSlot?.status)
  expect(claimedSlot?.ownedClaim?.quote === QUOTE, '槽位上记着用户原话', claimedSlot?.ownedClaim?.quote)
  expect(Boolean(claimedSlot?.ownedClaim?.at), '记了声明时间（可审计）', claimedSlot?.ownedClaim?.at)
  expect(declared.body.cost?.breakdown?.itemSubtotal === declared.body.slots.find((s) => s.slot === 'outerwear')?.item?.price?.amount, '已有单品不计入商品小计', String(declared.body.cost?.breakdown?.itemSubtotal))
  const ctxClaimed = await ctxFor(claimedId)
  expect(ctxClaimed.includes('用户声明已有'), '上下文里标成「用户声明已有」', '命中')
  expect(ctxClaimed.includes(QUOTE), '上下文里带上原话（可追溯）')
  expect(ctxClaimed.includes('已有（用户明确说过）'), '上下文有明确的「已有」段落')

  /* ============================================================ C */
  section('[C] 新建另一方案 → 不继承上一份的 owned')
  const second = await post(
    '/api/plans',
    basePayload({
      label: 'P5 验收 · 大阪 4 天',
      scene: { type: 'travel', destination: 'Osaka', days: 4 },
      budgetLimit: 300,
      arrivalBy: '2026-12-28',
      slots: [
        { slot: 'outerwear', status: 'to_buy', productId: coat.productId },
        { slot: 'bottom', status: 'owned', productId: JEANS },
      ],
    }),
  )
  expect(second.status === 422, '第二份方案没提「已有」→ 同样被拒（不继承）', String(second.status))
  const plain = await post(
    '/api/plans',
    basePayload({
      label: 'P5 验收 · 首尔 2 天',
      scene: { type: 'travel', destination: 'Seoul', days: 2 },
      budgetLimit: 260,
      slots: [
        { slot: 'outerwear', status: 'to_buy', productId: coat.productId },
        { slot: 'top', status: 'to_buy', productId: top.productId },
      ],
    }),
  )
  expect(plain.status === 200, '完全不提 owned 的新方案正常创建', String(plain.status))
  const plainOwned = (plain.body.slots ?? []).filter((s) => s.status === 'owned')
  expect(plainOwned.length === 0, '新方案里没有任何 owned 槽位', `owned=${plainOwned.length}`)
  const ctxPlain = await ctxFor(plain.body.planId)
  expect(!ctxPlain.includes('已有（用户明确说过）'), '新方案上下文没有「已有」段')
  expect(!ctxPlain.includes(JEANS) && !ctxPlain.includes('牛仔裤'), '新方案上下文没有凭空出现牛仔裤')

  /* ============================================================ D */
  section('[D] 新开聊天 → 不继承（聊天状态不是所有权来源）')
  const ctxBeforeReset = await ctxFor(claimedId)
  expect(ctxBeforeReset.includes('用户声明已有'), '重置前：这份方案的「已有」算这段对话里说的', '有')
  const reset = await post('/api/chat/reset', {})
  expect(reset.status === 200 || reset.status === 204, '聊天已重置', String(reset.status))
  const ctxAfterReset = await ctxFor(claimedId)
  expect(
    !ctxAfterReset.includes('用户声明已有') && !ctxAfterReset.includes('已有（用户明确说过）'),
    '重置后：同一份方案的「已有」不再算「用户这次说过」',
  )
  expect(ctxAfterReset.includes('上一段对话'), '重置后：它被标成「上一段对话里留下的记录」')
  const ctxNone = await ctxFor('__none__')
  expect(!ctxNone.includes('已有'), '无方案时的上下文完全不提「已有」')
  expect(!ctxNone.includes('牛仔裤'), '无方案时不带任何历史商品痕迹')
  const afterReset = await post(
    '/api/plans',
    basePayload({
      label: 'P5 验收 · 重置后新方案',
      slots: [{ slot: 'bottom', status: 'owned', productId: JEANS }],
    }),
  )
  expect(afterReset.status === 422, '重置聊天后仍要求声明（不因 history 放行）', String(afterReset.status))

  /* ============================================================ E */
  section('[E] 返回历史方案 → 数据不删，但不当成用户真的拥有')
  const st = JSON.parse(readFileSync(join(DATA, 'state.json'), 'utf8'))
  const legacy = (st.plans ?? []).find(
    (p) => p.planId !== claimedId && (p.slots ?? []).some((s) => s.status === 'owned' && !s.ownedClaim),
  )
  expect(Boolean(legacy), '隔离副本里存在「修复前遗留」的 owned 方案', legacy?.planId)
  if (legacy) {
    const vm = (await api(`/api/plans/${legacy.planId}`)).body
    const ownedSlot = (vm.slots ?? []).find((s) => s.status === 'owned')
    expect(vm.planId === legacy.planId, '历史方案照常读得到（没有为了「修 bug」清历史）', legacy.planId)
    expect(ownedSlot?.status === 'owned', '历史方案的既有状态如实显示，没有被改写')
    expect(ownedSlot?.ownedClaim == null, '历史槽位没有声明凭证（可据此标「历史数据」）')
    const ctxLegacy = await ctxFor(legacy.planId)
    expect(ctxLegacy.includes('不代表用户'), '上下文明确警告「示例/历史记录不代表用户真的拥有」')
    expect(!ctxLegacy.includes('已有（用户明确说过）'), '历史「已有」没被当成用户声明')
    expect(/不要.*沿用/.test(ctxLegacy), '上下文明确要求不要沿用', '有')
  }

  /* ============================================================ F */
  section('[F] Demo seed / 历史数据不污染新方案')
  const demo = await post('/api/plans/demo', {})
  expect(demo.status === 200, '示例方案可以创建（不是禁用功能）', String(demo.status))
  const demoOwned = (demo.body.slots ?? []).find((s) => s.status === 'owned')
  expect(Boolean(demoOwned), '示例方案保留它自己的「已有」演示位', demoOwned?.label)
  expect(/^示例/.test(String(demoOwned?.ownedClaim?.quote ?? '')), '示例方案的 owned 带「示例」声明（合规走同一条规则）', demoOwned?.ownedClaim?.quote)
  const ctxDemo = await ctxFor(demo.body.planId)
  expect(ctxDemo.includes('不代表用户'), '示例方案的上下文被标成示例，而非用户声明')
  expect(!ctxDemo.includes('已有（用户明确说过）'), '示例方案的「已有」不进「用户明确说过」段落')
  const afterDemo = await post(
    '/api/plans',
    basePayload({
      label: 'P5 验收 · 示例之后的新方案',
      scene: { type: 'travel', destination: 'Bangkok', days: 3 },
      budgetLimit: 220,
      slots: [
        { slot: 'outerwear', status: 'to_buy', productId: coat.productId },
        { slot: 'bottom', status: 'owned', productId: JEANS },
      ],
    }),
  )
  expect(afterDemo.status === 422, '跑过示例方案后，新方案仍不能凭空 owned', String(afterDemo.status))

  section('[F2] 落盘数据自检：本轮新建的方案里 owned 必须都有凭证')
  const finalState = JSON.parse(readFileSync(join(DATA, 'state.json'), 'utf8'))
  const createdThisRun = (finalState.plans ?? []).filter((p) =>
    [claimedId, plain.body.planId, demo.body.planId].filter(Boolean).includes(p.planId),
  )
  const bad = createdThisRun.flatMap((p) =>
    (p.slots ?? []).filter((s) => s.status === 'owned' && !s.ownedClaim?.quote).map((s) => `${p.planId}/${s.slot}`),
  )
  expect(bad.length === 0, '新建方案的每个 owned 槽位都有原话凭证', bad.join(',') || '全部有')
  const legacyKept = (finalState.plans ?? []).filter((p) => (p.slots ?? []).some((s) => s.status === 'owned')).length
  expect(legacyKept >= 31, '历史方案数量没减少（bug 不是靠删数据修的）', `${legacyKept} 份带 owned`)

  console.log(`\n[p6-owned] 通过 ${pass} 项，失败 ${fail} 项`)
  if (fail) console.log(`失败项：${failures.join(' / ')}`)
  if (process.env.KEEP_P6_OWNED === '1') console.log(`隔离数据保留在 ${DATA}`)
}

main()
  .catch((e) => {
    fail += 1
    console.error('\n[p6-owned] 异常：', e)
  })
  .finally(() => {
    if (CHILD) CHILD.kill()
    setTimeout(() => process.exit(fail ? 1 : 0), 300)
  })
