/**
 * Phase 5 F4：建方案硬约束守门测试。
 *
 * 每条用例对应一条验收要求：
 *   - 已确认的硬性偏好（尺码 / 避开品牌 / 避开词）在建方案时**阻断**，不是提示
 *   - 只有用户本轮明确授权（allowRules）才放行，且旧值不被改写
 *   - 数据不足的约束标 unverified，绝不冒充「已校验通过」
 *   - 类目错位直接拒绝（否则金额/到货/热点全部错位）
 *   - 无偏好时校验结果为空、预算/到货结论与基线一致
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPlan,
  validatePlanAgainstPrefs,
  normalizePref,
  PlanError,
  type CatalogItem,
  type PrefRecord,
  type SlotId,
} from '../dist/index.js'

const TODAY = '2026-11-16'
const DEADLINE = '2026-11-24'

function mkPrice(amount: number) {
  return { amount, currency: 'USD' as const, status: 'confirmed' as const, source: 'seed', fetchedAt: TODAY }
}
function mkShip(etaDays: [number, number] | null, fee: number | null) {
  return {
    fee: fee === null ? null : { amount: fee, currency: 'USD' as const, status: 'estimated' as const, source: 'rule' },
    status: 'estimated' as const,
    etaDays,
    etaEarliest: null,
    etaLatest: null,
    source: 'rule:std',
  }
}
function mkItem(over: Partial<CatalogItem> & { productId: string; category: SlotId }): CatalogItem {
  return {
    title: over.productId,
    color: 'ivory',
    colorFamily: 'light',
    style: ['minimal'],
    price: mkPrice(50),
    shipping: mkShip([3, 5], 10),
    duty: { amount: null, status: 'unavailable', reason: 'v1 不估算关税' },
    sizes: ['S', 'M', '8'],
    url: `https://example.com/${over.productId}`,
    image: { main: `assets/main/${over.productId}.svg`, cutout: `assets/cutout/${over.productId}.svg` },
    ...over,
  } as CatalogItem
}

const catalog: CatalogItem[] = [
  mkItem({ productId: 'ow_light', category: 'outerwear', title: 'Ivory Trench', price: mkPrice(90) }),
  mkItem({
    productId: 'sh_rothy',
    category: 'shoes',
    title: "Rothy's Point Flat",
    vendor: "Rothy's",
    sizes: ['6', '7', '8'],
    price: mkPrice(120),
  }),
  mkItem({ productId: 'sh_other', category: 'shoes', title: 'Leather Loafer', sizes: ['8', '9'], price: mkPrice(80) }),
]

function buildPlan(slots: Array<{ slot: SlotId; status: 'owned' | 'to_buy' | 'empty'; productId?: string }>, opts: { budget?: number; deadline?: string } = {}) {
  return createPlan({
    planId: 'pln_f4',
    label: 'F4 guard',
    scene: { type: 'travel', destination: 'Tokyo', days: 3, today: TODAY },
    budget: { limit: opts.budget ?? 1000, currency: 'USD', basis: 'new_items_only' },
    arrivalBy: { date: opts.deadline ?? DEADLINE },
    shipTo: 'CN',
    slots,
    catalog,
    ownedItems: [],
  })
}

let seq = 0
function pref(attr: string, value: string, ctx: Partial<PrefRecord> = {}): PrefRecord {
  seq += 1
  return normalizePref({
    id: `t_${seq}`,
    attr,
    value,
    scope: 'profile',
    confidence: 'stated',
    confirmedByUser: true,
    createdAt: new Date(2026, 10, 16, 0, seq).toISOString(),
    ...ctx,
  } as PrefRecord)
}

test('无偏好：不产生任何冲突，预算/到货/收货地都给出可信度结论', () => {
  const plan = buildPlan([{ slot: 'shoes', status: 'to_buy', productId: 'sh_rothy' }])
  const v = validatePlanAgainstPrefs(plan, [])
  assert.equal(v.violations.length, 0)
  assert.equal(v.exempt.length, 0)
  assert.equal(v.applied.length, 0)
  assert.equal(v.unmapped.length, 0)
  const ids = v.checks.map((c) => c.id).sort()
  assert.deepEqual(ids, ['arrival', 'budget', 'shipTo'])
  // 关税 unavailable → 总额只能算估算，预算不能报 ok（不许把估算说成确认）
  const budget = v.checks.find((c) => c.id === 'budget')!
  assert.equal(budget.status, 'unverified')
  assert.match(budget.detail, /估算|未确认/)
  assert.equal(v.checks.find((c) => c.id === 'shipTo')!.status, 'ok')
})

test('避开品牌：建方案时阻断，指明商品与规则', () => {
  const plan = buildPlan([{ slot: 'shoes', status: 'to_buy', productId: 'sh_rothy' }])
  const v = validatePlanAgainstPrefs(plan, [pref('brand_avoid', "Rothy's")])
  assert.equal(v.violations.length, 1)
  assert.equal(v.violations[0].productId, 'sh_rothy')
  assert.deepEqual(v.violations[0].rules, ['brand_avoid'])
  assert.match(v.violations[0].reasons[0], /Rothy/)
  assert.equal(v.exempt.length, 0)
})

test('尺码不符：阻断；没有尺码信息的商品不因尺码被误判', () => {
  const plan = buildPlan([{ slot: 'shoes', status: 'to_buy', productId: 'sh_rothy' }])
  const v = validatePlanAgainstPrefs(plan, [pref('size_shoes', '10')])
  assert.equal(v.violations.length, 1)
  assert.deepEqual(v.violations[0].rules, ['size_shoes'])

  const noSize = mkItem({ productId: 'sh_nosize', category: 'shoes', title: 'Mystery Shoe', sizes: [] })
  const plan2 = createPlan({
    planId: 'pln_f4_ns',
    label: 'no size',
    scene: { type: 'travel', destination: 'Tokyo', days: 3, today: TODAY },
    budget: { limit: 1000, currency: 'USD', basis: 'new_items_only' },
    arrivalBy: { date: DEADLINE },
    shipTo: 'CN',
    slots: [{ slot: 'shoes', status: 'to_buy', productId: 'sh_nosize' }],
    catalog: [noSize],
    ownedItems: [],
  })
  const v2 = validatePlanAgainstPrefs(plan2, [pref('size_shoes', '10')])
  assert.equal(v2.violations.length, 0, '信息不足 ≠ 不符合')
})

test('避开词：命中标题即阻断；认不出的颜色/风格偏好标 unverified，不冒充已校验', () => {
  const plan = buildPlan([{ slot: 'shoes', status: 'to_buy', productId: 'sh_rothy' }])
  const v = validatePlanAgainstPrefs(plan, [pref('avoid', 'flat')])
  assert.equal(v.violations.length, 1)
  assert.deepEqual(v.violations[0].rules, ['avoid'])
  assert.match(v.violations[0].reasons[0], /flat/)

  const v2 = validatePlanAgainstPrefs(plan, [pref('palette', '莫兰迪色系')])
  assert.equal(v2.violations.length, 0)
  assert.ok(v2.unmapped.length >= 1, '认不出的值必须记进 unmapped')
  const ft = v2.checks.find((c) => c.id === 'freetext')
  assert.ok(ft, '认不出的偏好必须单独列一条')
  assert.equal(ft!.status, 'unverified')
})

test('只有用户本轮明确授权才放行：命中规则进 exempt，未授权的规则仍然阻断', () => {
  const plan = buildPlan([{ slot: 'shoes', status: 'to_buy', productId: 'sh_rothy' }])
  const prefs = [pref('brand_avoid', "Rothy's"), pref('size_shoes', '10')]

  const partial = validatePlanAgainstPrefs(plan, prefs, {}, { allowRules: ['brand_avoid'] })
  assert.equal(partial.violations.length, 1, '尺码没被授权，仍然阻断')
  assert.deepEqual(partial.violations[0].rules, ['size_shoes'], '只列未获授权的规则，别让调用方以为授权没生效')
  assert.equal(partial.exempt.length, 0, '只要还剩一条未授权规则，这件就不算破例放行')

  const full = validatePlanAgainstPrefs(plan, prefs, {}, { allowRules: ['brand_avoid', 'size_shoes'] })
  assert.equal(full.violations.length, 0)
  assert.equal(full.exempt.length, 1)
})

test('预算超支与到货赶不上：如实报 violated，不静默通过', () => {
  const over = buildPlan([{ slot: 'shoes', status: 'to_buy', productId: 'sh_rothy' }], { budget: 10 })
  const v = validatePlanAgainstPrefs(over, [])
  const budget = v.checks.find((c) => c.id === 'budget')!
  assert.equal(budget.status, 'violated')
  assert.match(budget.detail, /超过预算/)

  const rush = buildPlan([{ slot: 'shoes', status: 'to_buy', productId: 'sh_rothy' }], { deadline: '2026-11-17' })
  const v2 = validatePlanAgainstPrefs(rush, [])
  const arrival = v2.checks.find((c) => c.id === 'arrival')!
  assert.equal(arrival.status, 'violated')
})

test('类目错位：createPlan 直接拒绝（不能把包塞进鞋位）', () => {
  assert.throws(
    () =>
      createPlan({
        planId: 'pln_bad',
        label: 'bad',
        scene: { type: 'travel', destination: 'Tokyo', days: 3, today: TODAY },
        budget: { limit: 1000, currency: 'USD', basis: 'new_items_only' },
        arrivalBy: { date: DEADLINE },
        shipTo: 'CN',
        slots: [{ slot: 'shoes', status: 'to_buy', productId: 'ow_light' }],
        catalog,
        ownedItems: [],
      }),
    (e: unknown) => e instanceof PlanError && e.code === 'CATEGORY_MISMATCH',
  )
})

test('未确认 / 已删除 / 跨方案的 task 偏好不参与建方案校验', () => {
  const plan = buildPlan([{ slot: 'shoes', status: 'to_buy', productId: 'sh_rothy' }])
  const pending = pref('brand_avoid', "Rothy's", { confirmedByUser: false })
  assert.equal(validatePlanAgainstPrefs(plan, [pending]).violations.length, 0)

  const deleted = pref('brand_avoid', "Rothy's", { deletedAt: new Date().toISOString() })
  assert.equal(validatePlanAgainstPrefs(plan, [deleted]).violations.length, 0)

  const otherTask = pref('brand_avoid', "Rothy's", { scope: 'task', taskKey: 'pln_other' })
  assert.equal(
    validatePlanAgainstPrefs(plan, [otherTask], { taskKey: 'pln_f4' }).violations.length,
    0,
    '别的方案的临时要求不能影响这套方案',
  )
})
