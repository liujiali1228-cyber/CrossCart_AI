import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPlan,
  applySwap,
  removeSlotItem,
  setSlotLock,
  diffPlan,
  PlanError,
  weakest,
  computeCost,
  computeArrival,
  resolveAttr,
  rankCandidates,
  type CatalogItem,
  type OutfitPlan,
} from '../dist/index.js'

// ---------------------------------------------------------------- 固定测试夹具
const TODAY = '2026-11-16'
const DEADLINE = '2026-11-22'

function mkItem(over: Partial<CatalogItem> & { productId: string; category: CatalogItem['category'] }): CatalogItem {
  return {
    title: over.productId,
    color: 'ivory',
    colorFamily: 'light',
    style: ['minimal'],
    price: { amount: 50, currency: 'USD', status: 'confirmed', source: 'seed', fetchedAt: TODAY },
    shipping: {
      fee: { amount: 10, currency: 'USD', status: 'estimated', source: 'rule' },
      status: 'estimated',
      etaDays: [3, 5],
      etaEarliest: null,
      etaLatest: null,
      source: 'rule:std',
    },
    duty: { amount: null, status: 'unavailable', reason: 'v1 不估算关税' },
    sizes: ['S', 'M'],
    url: 'https://example.com/p',
    image: { main: `assets/main/${over.productId}.svg`, cutout: `assets/cutout/${over.productId}.svg` },
    ...over,
  } as CatalogItem
}

const catalog: CatalogItem[] = [
  mkItem({ productId: 'ow_a', category: 'outerwear', title: 'Ivory Trench', colorFamily: 'light', price: mkPrice(89), shipping: mkShip([5, 9], 12) }),
  mkItem({ productId: 'ow_b', category: 'outerwear', title: 'Black Trench', color: 'black', colorFamily: 'dark', price: mkPrice(95), shipping: mkShip([4, 7], 12) }),
  mkItem({ productId: 'ow_c', category: 'outerwear', title: 'Denim Jacket', color: 'denim', colorFamily: 'mid', price: mkPrice(68), shipping: mkShip([3, 5], 8) }),
  mkItem({ productId: 'ow_d', category: 'outerwear', title: 'Beige Raincoat', colorFamily: 'light', price: mkPrice(75), shipping: mkShip(null, null, 'unavailable') }),
  mkItem({ productId: 'top_a', category: 'top', title: 'Cream Tee', colorFamily: 'light', price: mkPrice(25), shipping: mkShip([3, 6], 6) }),
  mkItem({ productId: 'top_b', category: 'top', title: 'Black Turtleneck', color: 'black', colorFamily: 'dark', price: mkPrice(45), shipping: mkShip([3, 6], 6) }),
  mkItem({ productId: 'bot_a', category: 'bottom', title: 'Charcoal Trousers', color: 'charcoal', colorFamily: 'dark', price: mkPrice(52), shipping: mkShip([4, 8], 8) }),
  mkItem({ productId: 'shoe_a', category: 'shoes', title: 'Beige Walking Shoes', colorFamily: 'light', price: mkPrice(69), shipping: mkShip([8, 12], 8) }),
  mkItem({ productId: 'shoe_b', category: 'shoes', title: 'White Sneakers', colorFamily: 'light', price: mkPrice(59), shipping: mkShip([3, 6], 7) }),
  mkItem({ productId: 'bag_a', category: 'bag', title: 'Canvas Tote', colorFamily: 'mid', price: mkPrice(32), shipping: mkShip([3, 5], 6) }),
]

function mkPrice(amount: number) {
  return { amount, currency: 'USD', status: 'confirmed', source: 'seed', fetchedAt: TODAY }
}
function mkShip(etaDays: [number, number] | null, fee: number | null, status = 'estimated') {
  return {
    fee: fee === null ? null : { amount: fee, currency: 'USD', status, source: 'rule' },
    status,
    etaDays,
    etaEarliest: null,
    etaLatest: null,
    source: 'rule:std',
  }
}

const ownedJeans = mkItem({
  productId: 'own_jeans',
  category: 'bottom',
  title: '深色直筒牛仔裤',
  colorFamily: 'dark',
  price: mkPrice(0),
})

function buildPlan(): OutfitPlan {
  return createPlan({
    label: '东京 3 天 · 方案 A',
    scene: { type: 'travel', destination: 'Tokyo', days: 3, today: TODAY },
    budget: { limit: 200, currency: 'USD', basis: 'new_items_only' },
    arrivalBy: { date: DEADLINE },
    shipTo: 'CN',
    catalog,
    ownedItems: [ownedJeans],
    slots: [
      { slot: 'outerwear', status: 'to_buy', productId: 'ow_a', reason: '浅色风衣，拍照出片' },
      { slot: 'top', status: 'to_buy', productId: 'top_a' },
      { slot: 'bottom', status: 'owned', productId: 'own_jeans', reason: '已有' },
      { slot: 'shoes', status: 'to_buy', productId: 'shoe_a' },
      { slot: 'bag', status: 'empty' },
    ],
  })
}

// ---------------------------------------------------------------- 三态合并
test('weakest：unavailable 向上传染，任何缺项都压垮整体状态', () => {
  assert.equal(weakest('confirmed', 'estimated'), 'estimated')
  assert.equal(weakest('estimated', 'unavailable'), 'unavailable')
  assert.equal(weakest('confirmed', 'confirmed'), 'confirmed')
})

test('运费不可用时：金额只算已知部分，状态为 unavailable，到货 unknown（评测三问之 C）', () => {
  const plan = createPlan({
    label: '缺运费场景',
    scene: { type: 'travel', destination: 'Tokyo', days: 3, today: TODAY },
    budget: { limit: 200, currency: 'USD', basis: 'new_items_only' },
    arrivalBy: { date: DEADLINE },
    shipTo: 'CN',
    catalog,
    slots: [{ slot: 'outerwear', status: 'to_buy', productId: 'ow_d' }],
  })
  const line = plan.cost.lines[0]
  assert.equal(line.status, 'unavailable')
  assert.equal(line.amount, 75) // 只有已知商品价，运费没报价就不计入
  assert.equal(plan.cost.budget.risky, true)
  assert.equal(plan.cost.budget.status, 'unavailable')
  assert.equal(plan.arrival.verdict, 'unknown')
  assert.ok(plan.arrival.blocking.length > 0, 'blocking 里必须写明缺什么')
})

// ---------------------------------------------------------------- 评测三问之 A：换一件只改一件
test('换外套后：changedSlots 只有 outerwear，其他单品字段零变化，revision +1', () => {
  const plan = buildPlan()
  const before = JSON.stringify(plan.slots.filter((s) => s.slot !== 'outerwear'))

  const { plan: next, diff } = applySwap(plan, catalog, {
    slot: 'outerwear',
    revision: plan.revision,
    strategy: 'lighter',
    at: '2026-11-16T10:00:00Z',
  })

  assert.deepEqual(diff.changedSlots, ['outerwear'], '只许改一个搭配位')
  assert.equal(next.revision, plan.revision + 1)
  assert.notEqual(
    next.slots.find((s) => s.slot === 'outerwear')?.item?.productId,
    plan.slots.find((s) => s.slot === 'outerwear')?.item?.productId,
  )
  const after = JSON.stringify(next.slots.filter((s) => s.slot !== 'outerwear'))
  assert.equal(after, before, '其他 slot 必须逐字节一致')
  assert.equal(next.cost.newItemsTotal.amount, next.cost.lines.reduce((a, l) => a + l.amount, 0))
})

test('版本号不匹配（并发点击/旧页面）必须被拒绝', () => {
  const plan = buildPlan()
  assert.throws(
    () => applySwap(plan, catalog, { slot: 'shoes', revision: plan.revision + 5, strategy: 'cheaper' }),
    (e: unknown) => (e as PlanError).code === 'STALE_REVISION',
  )
})

test('锁定与已有单品的保护', () => {
  const plan = buildPlan()
  const locked = setSlotLock(plan, 'top', true).plan
  assert.throws(
    () => applySwap(locked, catalog, { slot: 'top', revision: locked.revision, strategy: 'similar' }),
    (e: unknown) => (e as PlanError).code === 'SLOT_LOCKED',
  )
  assert.throws(
    () => applySwap(locked, catalog, { slot: 'bottom', revision: locked.revision, strategy: 'similar' }),
    (e: unknown) => (e as PlanError).code === 'OWNED_SLOT',
  )
})

test('换上后更贵且仍超预算：保留原方案并给出可操作提示', () => {
  // 当前已经超支（107 / 80），similar 的首选会比现在更贵 —— 这种「让方案变差」的换件必须拒绝
  const tight = createPlan({
    label: '超预算守卫',
    scene: { type: 'travel', destination: 'Tokyo', days: 3, today: TODAY },
    budget: { limit: 80, currency: 'USD', basis: 'new_items_only' },
    arrivalBy: { date: DEADLINE },
    shipTo: 'CN',
    catalog,
    slots: [
      { slot: 'outerwear', status: 'to_buy', productId: 'ow_c' },
      { slot: 'top', status: 'to_buy', productId: 'top_a' },
    ],
  })
  const before = JSON.stringify(tight)
  assert.throws(
    () => applySwap(tight, catalog, { slot: 'outerwear', revision: tight.revision, strategy: 'similar' }),
    (e: unknown) => {
      const err = e as PlanError
      return err.code === 'NO_CANDIDATE' && /超出预算/.test(err.message)
    },
  )
  assert.equal(JSON.stringify(tight), before, '失败时方案必须原样回滚')
})

test('cheaper 策略：真的更便宜，且预算硬过滤生效', () => {
  const plan = buildPlan()
  const cands = rankCandidates(plan, 'shoes', catalog, 'cheaper')
  const top = cands[0]
  assert.equal(top.item.productId, 'shoe_b') // $66 vs 当前 $77
  const currentLine = 69 + 8
  assert.ok(top.lineTotal < currentLine)
  const { plan: next } = applySwap(plan, catalog, { slot: 'shoes', revision: plan.revision, strategy: 'cheaper' })
  assert.equal(next.slots.find((s) => s.slot === 'shoes')?.item?.productId, 'shoe_b')
  assert.equal(next.cost.newItemsTotal.amount, 198) // 101 + 31 + 66
  assert.equal(next.cost.budget.verdict, 'within_budget')
})

test('faster 策略：到货从 late 修到 on_time（评测三问之 C 的正向路径）', () => {
  const plan = buildPlan()
  assert.equal(plan.arrival.verdict, 'late', '初始方案因鞋的 ETA 到 11-28，判定为赶不上')
  const { plan: next, diff } = applySwap(plan, catalog, { slot: 'shoes', revision: plan.revision, strategy: 'faster' })
  assert.equal(diff.arrivalFrom, 'late')
  assert.equal(diff.arrivalTo, 'at_risk', '外套 11-25 仍是风险项')
  const { plan: next2, diff: diff2 } = applySwap(next, catalog, { slot: 'outerwear', revision: next.revision, strategy: 'faster' })
  assert.equal(next2.slots.find((s) => s.slot === 'outerwear')?.item?.productId, 'ow_c')
  assert.equal(diff2.arrivalTo, 'on_time')
  assert.ok(diff2.summary.includes('能赶上'))
})

// ---------------------------------------------------------------- 评测三问之 B：本次要求覆盖长期偏好
test('task 作用域压过 profile，且被覆盖记录可查证', () => {
  const records = [
    { attr: 'color.like', value: 'light', scope: 'profile', confidence: 'stated', confirmedByUser: true },
    { attr: 'color.like', value: 'black', scope: 'task', confidence: 'stated', confirmedByUser: true },
  ]
  const r = resolveAttr(records, 'color.like', 'any')
  assert.equal(r.value, 'black')
  assert.equal(r.winner?.scope, 'task')
  assert.equal(r.overridden.length, 1)
  assert.equal(r.overridden[0].value, 'light')
})

test('未确认的记录（模型自作主张记住的）不参与解析', () => {
  const records = [
    { attr: 'color.like', value: 'black', scope: 'task', confidence: 'inferred', confirmedByUser: false },
  ]
  const r = resolveAttr(records, 'color.like', 'light')
  assert.equal(r.value, 'light')
  assert.equal(r.winner, null)
})

// ---------------------------------------------------------------- 其他守门
test('跨类目指定会被拒绝（把鞋塞进外套位）', () => {
  const plan = buildPlan()
  assert.throws(
    () => applySwap(plan, catalog, { slot: 'outerwear', revision: plan.revision, productId: 'shoe_b' }),
    (e: unknown) => (e as PlanError).code === 'CATEGORY_MISMATCH',
  )
})

test('移除后 slot 为 empty，预算回到不含该件的状态；撤销（换回原品）可逆', () => {
  const plan = buildPlan()
  const { plan: removed } = removeSlotItem(plan, 'shoes', plan.revision)
  const shoe = removed.slots.find((s) => s.slot === 'shoes')
  assert.equal(shoe?.status, 'empty')
  assert.ok(removed.cost.newItemsTotal.amount < plan.cost.newItemsTotal.amount)

  const { plan: restored } = applySwap(removed, catalog, {
    slot: 'shoes',
    revision: removed.revision,
    productId: 'shoe_a',
  })
  assert.equal(restored.slots.find((s) => s.slot === 'shoes')?.item?.productId, 'shoe_a')
  assert.equal(restored.cost.newItemsTotal.amount, plan.cost.newItemsTotal.amount)
})

test('商品从目录下架后，仍能换回换件前那件（回滚不依赖在售状态）', () => {
  const plan = buildPlan()
  const before = plan.slots.find((s) => s.slot === 'outerwear')?.item?.productId
  const { plan: swapped } = applySwap(plan, catalog, { slot: 'outerwear', revision: plan.revision, strategy: 'cheaper' })
  const after = swapped.slots.find((s) => s.slot === 'outerwear')
  assert.notEqual(after?.item?.productId, before, '策略换件应当换了商品')
  assert.equal(after?.previousItem?.productId, before, '换件前的商品必须被记下来')

  // 原商品从店铺目录里消失（下架 / 抓取口径变化）
  const shrunk = catalog.filter((c) => c.productId !== before)
  const { plan: rolledBack } = applySwap(swapped, shrunk, {
    slot: 'outerwear',
    revision: swapped.revision,
    productId: before!,
  })
  const back = rolledBack.slots.find((s) => s.slot === 'outerwear')
  assert.equal(back?.item?.productId, before, '下架商品也要能换回来')
  assert.match(back?.reason ?? '', /不在店铺目录/, '文案必须说明这件当前不在目录里')
  assert.equal(rolledBack.cost.newItemsTotal.amount, plan.cost.newItemsTotal.amount, '回滚后金额回到最初')
})

test('diffPlan 对锁定变化不计入 changedSlots', () => {
  const plan = buildPlan()
  const { plan: locked } = setSlotLock(plan, 'top', true)
  const diff = diffPlan(plan, locked)
  assert.deepEqual(diff.changedSlots, [])
})

test('成本与到货重算是纯函数：同输入同输出', () => {
  const a = computeCost(buildPlan())
  const b = computeCost(buildPlan())
  assert.deepEqual(a, b)
  assert.deepEqual(computeArrival(buildPlan()), computeArrival(buildPlan()))
})

test('策略候选默认排除「运费待确认」的商品；手动列表才允许出现（知情选择）', () => {
  const plan = buildPlan()
  const strat = rankCandidates(plan, 'outerwear', catalog, 'lighter')
  assert.ok(!strat.some((c) => c.item.productId === 'ow_d'), '策略推荐不该推一件到货都判断不了的商品')
  const manual = rankCandidates(plan, 'outerwear', catalog, 'lighter', { includeUnconfirmed: true })
  assert.ok(manual.some((c) => c.item.productId === 'ow_d'), '手动挑选时用户可以知情选择')
})

test('已超预算时：更便宜的换件允许执行，但必须如实标注仍超预算', () => {
  const plan = buildPlan()
  const tight = { ...plan, constraints: { ...plan.constraints, budget: { ...plan.constraints.budget, limit: 120 } } }
  const res = applySwap(tight, catalog, { slot: 'outerwear', revision: tight.revision, strategy: 'cheaper' })
  assert.equal(res.plan.slots.find((s) => s.slot === 'outerwear')?.item?.productId, 'ow_c')
  assert.ok(res.plan.cost.newItemsTotal.amount < tight.cost.newItemsTotal.amount, '总额必须下降')
  assert.equal(res.plan.cost.budget.verdict, 'over_budget')
  assert.match(res.diff.summary, /仍超预算/, '必须明说还超着，不能假装已达预算')
  assert.deepEqual(res.diff.changedSlots, ['outerwear'])
})
