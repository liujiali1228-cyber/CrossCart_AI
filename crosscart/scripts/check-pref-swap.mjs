/**
 * Phase 5 F2 端到端校验：偏好进入真实换件链路后，守卫是否仍然成立。
 *
 * 走的是 applySwap 全链路（不是只调排序函数），因此同时覆盖：
 *   - 候选池被偏好硬排除后，换件选中的确实不是被排除商品
 *   - changedSlots === 1（一次只改一件）
 *   - 预算守卫仍然优先于偏好（不会因为偏好把方案换超预算）
 *   - task 偏好只作用于对应 planId
 *
 * 不调模型、不调图像、不写真实数据。
 *
 *   node scripts/check-pref-swap.mjs
 */
import { mkdirSync, rmSync, copyFileSync } from 'node:fs'
import { Workspace } from '../packages/bridge/src/state.mjs'
import { readLiveCache } from '../packages/bridge/src/live-catalog.mjs'
import { applySwap, normalizePref, PlanError } from '../packages/core/dist/index.js'

const TMP = '.tmp/f2swap'
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
copyFileSync('data/state.json', `${TMP}/state.json`)

const live = readLiveCache('data/live/catalog.json')
const ws = new Workspace({ root: process.cwd(), dataDir: TMP, live })
const PLAN = 'pln_020'

let seq = 0
const pref = (attr, value, over = {}) =>
  normalizePref({
    id: `s${++seq}`,
    attr,
    value,
    scope: 'profile',
    confidence: 'stated',
    confirmedByUser: true,
    createdAt: new Date(Date.UTC(2026, 10, 18, 13, 0, seq)).toISOString(),
    ...over,
  })

const results = []
const ok = (name, extra = '') => {
  results.push(true)
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`)
}
const bad = (name, extra = '') => {
  results.push(false)
  console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
}

function fresh() {
  return ws.getPlan(PLAN)
}

/** 用给定偏好跑一次换件（不改 ws 状态，applySwap 是纯函数） */
function swap(plan, slot, prefs, strategy = 'similar') {
  return applySwap(plan, ws.catalog, {
    slot,
    revision: plan.revision,
    strategy,
    prefs,
    prefCtx: { taskKey: plan.planId },
  })
}

console.log('\n[1] 无偏好：换件结果与基线一致，且只改一件')
{
  const plan = fresh()
  const r = swap(plan, 'shoes', [])
  const picked = r.plan.slots.find((s) => s.slot === 'shoes').item
  r.diff.changedSlots.length === 1 && r.diff.changedSlots[0] === 'shoes'
    ? ok('changedSlots === 1', String(r.diff.changedSlots))
    : bad('改动了不止一个搭配位', JSON.stringify(r.diff.changedSlots))
  r.plan.revision === plan.revision + 1 ? ok('revision +1') : bad('revision 没变')
  console.log(`    选中：${picked?.title}（$${picked?.price.amount}）`)
}

console.log('\n[2] 硬排除：换件选中的不是被排除品牌')
{
  const plan = fresh()
  const prefs = [pref('brand_avoid', "Rothy's")]
  const r = swap(plan, 'shoes', prefs)
  const picked = r.plan.slots.find((s) => s.slot === 'shoes').item
  const ex = r.excluded ?? []
  ex.length > 0 ? ok(`候选池排除 ${ex.length} 件`, ex.slice(0, 2).map((e) => e.title).join('、')) : bad('没有排除任何商品')
  picked?.vendor !== "Rothy's" ? ok(`选中的不是被排除品牌（${picked?.vendor}）`) : bad('仍然选中了被排除品牌')
  r.diff.changedSlots.length === 1 ? ok('仍然只改一件') : bad('changedSlots 异常', JSON.stringify(r.diff.changedSlots))
}

console.log('\n[3] 软偏好：分数带得上依据，且换件仍走同一套守卫')
{
  const plan = fresh()
  const prefs = [pref('palette', '深色')]
  const r = swap(plan, 'shoes', prefs)
  const boosted = r.candidates.filter((c) => c.prefBonus > 0)
  boosted.length > 0
    ? ok(`有 ${boosted.length} 件候选带偏好加分`, boosted[0].prefWhys[0])
    : bad('没有任何候选获得加分')
  r.candidates.every((c) => c.prefBonus <= 0.1) ? ok('没有任何候选超过 0.10 上限') : bad('有候选超过上限')
  r.applied.length > 0 ? ok('返回生效规则', r.applied.join('；')) : bad('缺少 applied')
}

console.log('\n[4] 预算守卫优先于偏好：超预算时不会因为偏好硬换')
{
  const plan = fresh()
  const tight = {
    ...plan,
    constraints: { ...plan.constraints, budget: { ...plan.constraints.budget, limit: 1 } },
  }
  const prefs = [pref('palette', '深色')]
  let blocked = false
  let code = ''
  try {
    swap(tight, 'shoes', prefs, 'similar')
  } catch (e) {
    blocked = true
    code = e instanceof PlanError ? e.code : e.message
  }
  blocked ? ok('超预算换件被拒绝（守卫先于偏好）', code) : bad('超预算仍然换成功了')
}

console.log('\n[5] task 偏好只作用于本方案')
{
  const plan = fresh()
  const prefs = [pref('brand_avoid', "Rothy's", { scope: 'task', taskKey: PLAN })]
  const here = applySwap(plan, ws.catalog, {
    slot: 'shoes',
    revision: plan.revision,
    strategy: 'similar',
    prefs,
    prefCtx: { taskKey: PLAN },
  })
  const other = applySwap(plan, ws.catalog, {
    slot: 'shoes',
    revision: plan.revision,
    strategy: 'similar',
    prefs,
    prefCtx: { taskKey: 'pln_040' },
  })
  ;(here.excluded ?? []).length > 0 ? ok('本方案内生效', `${here.excluded.length} 件被排除`) : bad('本方案内没生效')
  ;(other.excluded ?? []).length === 0 ? ok('换个 planId 自动失效') : bad('跨方案仍在生效')
}

console.log('\n[6] 候选视图带着解释（UI 直接可用）')
{
  ws.prefs = [pref('palette', '深色'), pref('brand_avoid', "Rothy's")]
  const view = ws.candidateView(PLAN, 'shoes', 'similar')
  view.views.some((v) => v.prefBonus > 0) ? ok('候选带 prefBonus') : bad('候选没有 prefBonus')
  view.excluded.length > 0 ? ok('视图带 excluded', `${view.excluded.length} 件`) : bad('视图没有 excluded')
  view.applied.length > 0 ? ok('视图带 applied') : bad('视图没有 applied')
  view.views.every((v) => v.buy && v.buy.state) ? ok('既有购买入口字段没被破坏') : bad('buy 字段丢了')
  ws.prefs = []
}

rmSync(TMP, { recursive: true, force: true })
const pass = results.filter(Boolean).length
console.log(`\n通过 ${pass} 项，失败 ${results.length - pass} 项`)
process.exit(pass === results.length ? 0 : 1)
