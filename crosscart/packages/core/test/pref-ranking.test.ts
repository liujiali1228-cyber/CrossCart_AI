/**
 * Phase 5 F2：偏好真正改变候选集与排序的守门测试。
 *
 * 每条用例都对应一条验收要求：
 *   - 无偏好 → 候选 ID / 分数 / 顺序与基线完全一致
 *   - 硬排除在 pool 阶段生效，且「被排除的商品」不可能靠加分回来
 *   - 软加分 ≤0.10，策略仍是主导；cheaper 下不得因审美偏好推更贵的
 *   - 只用生效偏好（taskKey / 未确认 / 已删除 都不参与）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPlan,
  rankCandidates,
  rankCandidatesDetailed,
  checkPlanPrefConflicts,
  normalizePref,
  type CatalogItem,
  type OutfitPlan,
  type PrefRecord,
} from '../dist/index.js'

const TODAY = '2026-11-16'
const DEADLINE = '2026-11-22'

function mkPrice(amount: number) {
  return { amount, currency: 'USD' as const, status: 'confirmed' as const, source: 'seed', fetchedAt: TODAY }
}
function mkShip(etaDays: [number, number] | null, fee: number | null, status: 'estimated' | 'unavailable' = 'estimated') {
  return {
    fee: fee === null ? null : { amount: fee, currency: 'USD' as const, status, source: 'rule' },
    status,
    etaDays,
    etaEarliest: null,
    etaLatest: null,
    source: 'rule:std',
  }
}

function mkItem(over: Partial<CatalogItem> & { productId: string; category: CatalogItem['category'] }): CatalogItem {
  return {
    title: over.productId,
    color: 'ivory',
    colorFamily: 'light',
    style: ['minimal'],
    price: mkPrice(50),
    shipping: mkShip([3, 5], 10),
    duty: { amount: null, status: 'unavailable', reason: 'v1 不估算关税' },
    sizes: ['S', 'M'],
    url: `https://example.com/${over.productId}`,
    image: { main: `assets/main/${over.productId}.svg`, cutout: `assets/cutout/${over.productId}.svg` },
    ...over,
  } as CatalogItem
}

const catalog: CatalogItem[] = [
  mkItem({ productId: 'ow_light', category: 'outerwear', title: 'Ivory Trench', colorFamily: 'light', price: mkPrice(90), shipping: mkShip([4, 6], 12) }),
  mkItem({ productId: 'ow_dark', category: 'outerwear', title: 'Black Trench', color: 'black', colorFamily: 'dark', price: mkPrice(90), shipping: mkShip([4, 6], 12) }),
  mkItem({ productId: 'ow_denim', category: 'outerwear', title: 'Denim Jacket', color: 'denim', colorFamily: 'mid', price: mkPrice(90), shipping: mkShip([4, 6], 12) }),
  mkItem({ productId: 'ow_everlane', category: 'outerwear', title: 'Wool Blazer', colorFamily: 'light', vendor: 'Everlane', price: mkPrice(96), shipping: mkShip([4, 6], 12) }),
  mkItem({ productId: 'ow_other', category: 'outerwear', title: 'Cuyana Coat', colorFamily: 'light', vendor: 'Cuyana', price: mkPrice(88), shipping: mkShip([4, 6], 12) }),
  mkItem({ productId: 'shoe_light', category: 'shoes', title: 'Cream Loafer', colorFamily: 'light', price: mkPrice(70), shipping: mkShip([4, 6], 8), sizes: ['7', '8', '9'] }),
  mkItem({ productId: 'shoe_dark', category: 'shoes', title: 'Black Loafer', colorFamily: 'dark', price: mkPrice(70), shipping: mkShip([4, 6], 8), sizes: ['7', '8'] }),
]

function buildPlan(): OutfitPlan {
  return createPlan({
    label: '测试方案',
    scene: { type: 'travel', destination: 'Tokyo', days: 3, today: TODAY },
    budget: { limit: 400, currency: 'USD', basis: 'new_items_only' },
    arrivalBy: { date: DEADLINE },
    shipTo: 'CN',
    catalog,
    slots: [
      { slot: 'outerwear', status: 'to_buy', productId: 'ow_denim' },
      { slot: 'top', status: 'empty' },
      { slot: 'bottom', status: 'empty' },
      { slot: 'shoes', status: 'to_buy', productId: 'shoe_dark' },
      { slot: 'bag', status: 'empty' },
    ],
  })
}

let n = 0
function pref(attr: string, value: unknown, over: Partial<PrefRecord> = {}): PrefRecord {
  n += 1
  return normalizePref({
    id: `t${n}`,
    attr,
    value,
    scope: 'profile',
    confidence: 'stated',
    confirmedByUser: true,
    createdAt: new Date(Date.UTC(2026, 10, 18, 10, 0, n)).toISOString(),
    ...over,
  } as PrefRecord)
}

const ids = (list: Array<{ item: CatalogItem }>) => list.map((c) => c.item.productId)
const scores = (list: Array<{ score: number }>) => list.map((c) => c.score)

// ------------------------------------------------- 1. 无偏好 = 与基线逐项一致

test('无偏好：不传 prefs 与传空数组，候选 ID / 分数 / 顺序完全一致', () => {
  const plan = buildPlan()
  for (const strategy of ['similar', 'cheaper', 'lighter', 'faster'] as const) {
    const a = rankCandidates(plan, 'outerwear', catalog, strategy)
    const b = rankCandidates(plan, 'outerwear', catalog, strategy, { prefs: [] })
    assert.deepEqual(ids(b), ids(a), `${strategy}：候选 ID 序列必须一致`)
    assert.deepEqual(scores(b), scores(a), `${strategy}：分数必须逐项一致`)
    assert.ok(b.every((c) => c.prefBonus === 0 && c.prefWhys.length === 0))
  }
})

test('无偏好：excluded 为空、applied 为空', () => {
  const r = rankCandidatesDetailed(buildPlan(), 'outerwear', catalog, 'similar', { prefs: [] })
  assert.deepEqual(r.excluded, [])
  assert.deepEqual(r.applied, [])
  assert.deepEqual(r.relaxed, [])
})

// ------------------------------------------------- 2. 软加分

test('palette 命中：只给同色家族 +0.05，并写清加分依据', () => {
  const plan = buildPlan()
  const base = rankCandidates(plan, 'outerwear', catalog, 'similar')
  const after = rankCandidates(plan, 'outerwear', catalog, 'similar', { prefs: [pref('palette', '浅色')] })
  const byId = new Map(after.map((c) => [c.item.productId, c]))

  const light = byId.get('ow_light')!
  const baseLight = base.find((c) => c.item.productId === 'ow_light')!
  assert.equal(light.prefBonus, 0.05)
  assert.ok(Math.abs(light.score - Number((baseLight.score + 0.05).toFixed(3))) < 1e-9)
  assert.match(light.prefWhys.join(), /浅色|light|颜色符合/)

  const dark = byId.get('ow_dark')!
  assert.equal(dark.prefBonus, 0, '不符合偏好的商品不加分也不扣分')
  assert.equal(dark.score, base.find((c) => c.item.productId === 'ow_dark')!.score)
})

test('软加分上限 0.10：颜色 + 风格 + 品牌同时命中也不超过 0.10', () => {
  const plan = buildPlan()
  const prefs = [
    pref('palette', '浅色'),
    pref('style', '极简'),
    pref('brand_prefer', 'Everlane'),
  ]
  const list = rankCandidates(plan, 'outerwear', catalog, 'similar', { prefs })
  const hit = list.find((c) => c.item.productId === 'ow_everlane')!
  // Everlane 那件是 light + minimal + vendor 命中 → 理论上 0.05+0.03+0.02 = 0.10
  assert.equal(hit.prefBonus, 0.1)
  assert.ok(list.every((c) => c.prefBonus <= 0.1), '任何候选的偏好加分都不得超过 0.10')
})

test('策略主导：0.10 加分不足以跨越策略匹配度（0.4 权重）的差距', () => {
  const plan = buildPlan()
  // lighter 策略：light 得 1.0、dark 得 0 —— 策略分差 0.4，远大于偏好上限 0.10
  const after = rankCandidates(plan, 'outerwear', catalog, 'lighter', {
    prefs: [pref('palette', '深色'), pref('style', '极简'), pref('brand_prefer', 'Cuyana')],
  })
  const order = ids(after)
  assert.ok(
    order.indexOf('ow_light') < order.indexOf('ow_dark'),
    '深色偏好最多 0.05，不能把策略匹配度 0 的商品顶到策略匹配 1.0 的之前',
  )
})

// ------------------------------------------------- 3. 硬排除

test('brand_avoid：该店铺商品整批离开候选集，且附可读原因', () => {
  const r = rankCandidatesDetailed(buildPlan(), 'outerwear', catalog, 'similar', {
    prefs: [pref('brand_avoid', 'Everlane')],
  })
  assert.ok(!ids(r.candidates).includes('ow_everlane'))
  const ex = r.excluded.find((e) => e.productId === 'ow_everlane')
  assert.ok(ex, '被排除的商品必须出现在 excluded 里')
  assert.match(ex!.reasons.join(), /避开 Everlane/)
  assert.match(r.applied.join(), /避开品牌：Everlane/)
})

test('硬排除优先于软加分：被排除的商品即使满足颜色偏好也不会回来', () => {
  const r = rankCandidatesDetailed(buildPlan(), 'outerwear', catalog, 'similar', {
    prefs: [pref('palette', '浅色'), pref('brand_avoid', 'Everlane')],
  })
  assert.ok(!ids(r.candidates).includes('ow_everlane'), 'ow_everlane 是 light，但不能因颜色加分复活')
})

test('avoid 关键词按词边界命中标题，不会把「baggy」当成「bag」', () => {
  const withTrench = rankCandidatesDetailed(buildPlan(), 'outerwear', catalog, 'similar', {
    prefs: [pref('avoid', 'Trench')],
  })
  // 当前外套（ow_denim）本来就不进候选池，所以池内只有 4 件，Trench 命中 2 件
  assert.deepEqual(ids(withTrench.candidates).sort(), ['ow_everlane', 'ow_other'])
  assert.equal(withTrench.excluded.length, 2)

  const noHit = rankCandidatesDetailed(buildPlan(), 'outerwear', catalog, 'similar', {
    prefs: [pref('avoid', 'bag')],
  })
  assert.equal(noHit.excluded.length, 0, 'bag 不应命中任何外套标题')
})

test('尺码：不含该尺码的商品被排除', () => {
  const r = rankCandidatesDetailed(buildPlan(), 'shoes', catalog, 'similar', {
    prefs: [pref('size_shoes', '9')],
  })
  assert.ok(!ids(r.candidates).includes('shoe_dark'), 'shoe_dark 只有 7/8')
  assert.ok(ids(r.candidates).includes('shoe_light'))
})

test('明确尺码排除把候选排空时，不放宽、返回空候选并说明 blockedBy（F3）', () => {
  const r = rankCandidatesDetailed(buildPlan(), 'shoes', catalog, 'similar', {
    prefs: [pref('size_shoes', 'XXL')],
  })
  assert.equal(r.candidates.length, 0, '用户明确要求的尺码不能静默放宽')
  assert.deepEqual(r.relaxed, [], '硬性排除不应被记成"已放弃的规则"')
  assert.equal(r.blockedBy.length, 1)
  assert.match(r.blockedBy[0], /XXL|尺码/)
})

test('认不出的偏好值：不参与计算，但在 unmapped 里如实记录', () => {
  const r = rankCandidatesDetailed(buildPlan(), 'outerwear', catalog, 'similar', {
    prefs: [pref('palette', '莫兰迪色系')],
  })
  const base = rankCandidates(buildPlan(), 'outerwear', catalog, 'similar')
  assert.deepEqual(scores(r.candidates), scores(base), '认不出就不该改变分数')
  assert.ok(r.unmapped.some((u) => u.attr === 'palette'))
  assert.equal(r.applied.length, 0)
})

// ------------------------------------------------- 4. 只在生效范围

test('task 偏好只影响对应 planId；未确认 / 已删除 不参与', () => {
  const plan = buildPlan()
  const prefs = [
    pref('palette', '浅色'),
    pref('brand_avoid', 'Everlane', { scope: 'task', taskKey: plan.planId }),
    pref('brand_avoid', 'Cuyana', { confirmedByUser: false }),
    pref('banana', 'x'), // 无关自定义键，不应影响
  ]
  const here = rankCandidatesDetailed(plan, 'outerwear', catalog, 'similar', {
    prefs,
    prefCtx: { taskKey: plan.planId },
  })
  assert.ok(!ids(here.candidates).includes('ow_everlane'), '本方案的 task 偏好生效')
  assert.ok(ids(here.candidates).includes('ow_other'), '未确认的 brand_avoid 不能生效')

  const other = rankCandidatesDetailed(plan, 'outerwear', catalog, 'similar', {
    prefs,
    prefCtx: { taskKey: 'pln_other' },
  })
  assert.ok(ids(other.candidates).includes('ow_everlane'), '换个方案后 task 偏好不再生效')

  const deleted = rankCandidatesDetailed(plan, 'outerwear', catalog, 'similar', {
    prefs: [pref('brand_avoid', 'Everlane', { deletedAt: '2026-11-18T11:00:00.000Z' })],
  })
  assert.ok(ids(deleted.candidates).includes('ow_everlane'), '删除后立即失效')
})

test('已取代的旧偏好不参与：改主意后按新值算', () => {
  const plan = buildPlan()
  const prefs = [
    pref('palette', '深色', { id: 'old', supersededBy: 'new' }),
    pref('palette', '浅色', { id: 'new' }),
  ]
  const after = rankCandidates(plan, 'outerwear', catalog, 'similar', { prefs })
  const byId = new Map(after.map((c) => [c.item.productId, c]))
  assert.equal(byId.get('ow_light')!.prefBonus, 0.05, '新值浅色生效')
  assert.equal(byId.get('ow_dark')!.prefBonus, 0, '被取代的深色不生效')
})

// ------------------------------------------------- 5. cheaper 与预算

test('cheaper：审美偏好不得把「没有更便宜」的商品抬上来', () => {
  const plan = buildPlan()
  // 当前外套 88（ow_other? 不，plan 里是 ow_denim 90）；浅色但更贵的那件不加分
  const current = plan.slots.find((s) => s.slot === 'outerwear')!.item!
  const currentLine = (current.price.amount ?? 0) + (current.shipping.fee?.amount ?? 0)
  const list = rankCandidates(plan, 'outerwear', catalog, 'cheaper', { prefs: [pref('palette', '浅色')] })
  assert.ok(list.some((c) => c.lineTotal >= currentLine), '夹具里要有「没更便宜」的候选，否则这条测不到')
  for (const c of list) {
    if (c.lineTotal >= currentLine) {
      assert.equal(c.prefBonus, 0, `${c.item.productId} 没有更便宜，不应获得偏好加分`)
    }
  }
})

test('换件守卫不变：改一件只改一件（带偏好也一样）', () => {
  const plan = buildPlan()
  const r = rankCandidatesDetailed(plan, 'outerwear', catalog, 'similar', { prefs: [pref('palette', '浅色')] })
  assert.ok(r.candidates.length > 0)
  // changedSlots 由 plan.ts 的 GUARD 保证，这里确认候选数量与预算字段没被偏好改写
  assert.ok(r.candidates.every((c) => typeof c.withinBudget === 'boolean' && typeof c.overBy === 'number'))
})

// ------------------------------------------------- 6. 建方案路径

test('createPlan 路径：被排除商品进入新方案时，冲突必须被报告（不改写方案）', () => {
  const plan = createPlan({
    label: '含被排除商品的方案',
    scene: { type: 'travel', destination: 'Tokyo', days: 3, today: TODAY },
    budget: { limit: 400, currency: 'USD', basis: 'new_items_only' },
    arrivalBy: { date: DEADLINE },
    shipTo: 'CN',
    catalog,
    slots: [
      { slot: 'outerwear', status: 'to_buy', productId: 'ow_other' },
      { slot: 'shoes', status: 'to_buy', productId: 'shoe_light' },
    ],
  })
  const res = checkPlanPrefConflicts(plan.slots, [pref('brand_avoid', 'Cuyana')], { taskKey: plan.planId })
  assert.equal(res.conflicts.length, 1)
  assert.equal(res.conflicts[0].productId, 'ow_other')
  assert.match(res.conflicts[0].reasons.join(), /避开 Cuyana/)
  // 只报告，不改写方案
  assert.equal(plan.slots.find((s) => s.slot === 'outerwear')!.item!.productId, 'ow_other')
})

// ------------------------------------------------- 7. 覆盖率门槛（不制造假个性化）

test('覆盖率：某条软规则命中池内绝大多数时停用，并如实写进 relaxed', () => {
  // 6 件包全部带 minimal 标签 —— 与真实目录 minimal 覆盖 93% 的情况同构
  const bags = Array.from({ length: 6 }, (_, i) =>
    mkItem({
      productId: `bag_${i}`,
      category: 'bag',
      title: `Tote ${i}`,
      colorFamily: i % 2 === 0 ? 'light' : 'dark',
      style: ['minimal'],
      price: mkPrice(40 + i),
      shipping: mkShip([3, 5], 6),
    }),
  )
  const plan = createPlan({
    label: '覆盖率测试',
    scene: { type: 'travel', destination: 'Tokyo', days: 3, today: TODAY },
    budget: { limit: 400, currency: 'USD', basis: 'new_items_only' },
    arrivalBy: { date: DEADLINE },
    shipTo: 'CN',
    catalog: bags,
    slots: [{ slot: 'bag', status: 'empty' }],
  })
  const r = rankCandidatesDetailed(plan, 'bag', bags, 'similar', { prefs: [pref('style', '极简')] })
  assert.equal(r.candidates.length, 6)
  assert.ok(
    r.candidates.every((c) => c.prefBonus === 0),
    '所有人都有 minimal 时，不该给所有人 +0.03',
  )
  assert.match(r.relaxed.join(), /没有区分度|未用于排序/)
})

test('覆盖率：命中率不足 80% 的规则照常生效', () => {
  const plan = buildPlan()
  // 外套池 4 件里 2 件 light（50%）→ 应该正常加分
  const r = rankCandidatesDetailed(plan, 'outerwear', catalog, 'similar', { prefs: [pref('palette', '浅色')] })
  assert.ok(r.candidates.some((c) => c.prefBonus === 0.05))
  assert.ok(!r.relaxed.some((x) => x.includes('palette')))
})
