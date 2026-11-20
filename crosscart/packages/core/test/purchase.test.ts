import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPlan,
  updateConstraints,
  duplicatePlan,
  fitBudget,
  rankCandidates,
  buyInfo,
  purchaseLines,
  purchaseGroups,
  costBreakdown,
  buyableCount,
  type CatalogItem,
  type OutfitPlan,
} from '../dist/index.js'

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
  mkItem({
    productId: 'live_ow',
    category: 'outerwear',
    vendor: 'Cuyana',
    sourceKind: 'live',
    price: { amount: 180, currency: 'USD', status: 'confirmed' },
    url: 'https://www.cuyana.com/products/long-anorak',
  }),
  mkItem({
    productId: 'seed_top',
    category: 'top',
    sourceKind: 'seed',
    price: { amount: 40, currency: 'USD', status: 'confirmed' },
    url: 'https://example.com/p/seed_top',
  }),
  mkItem({
    productId: 'cheap_ow',
    category: 'outerwear',
    vendor: 'Everlane',
    sourceKind: 'live',
    price: { amount: 25, currency: 'USD', status: 'confirmed' },
    url: 'https://www.everlane.com/products/cheap-coat',
  }),
  mkItem({
    productId: 'mid_ow',
    category: 'outerwear',
    vendor: 'Everlane',
    sourceKind: 'live',
    price: { amount: 60, currency: 'USD', status: 'confirmed' },
    url: 'https://www.everlane.com/products/mid-coat',
  }),
  mkItem({
    productId: 'cheap_top',
    category: 'top',
    vendor: 'Everlane',
    sourceKind: 'live',
    price: { amount: 10, currency: 'USD', status: 'confirmed' },
    url: 'https://www.everlane.com/products/cheap-tee',
  }),
  mkItem({
    productId: 'no_ship_ow',
    category: 'outerwear',
    vendor: 'Everlane',
    sourceKind: 'live',
    price: { amount: 30, currency: 'USD', status: 'confirmed' },
    shipping: {
      fee: null,
      status: 'unavailable',
      etaDays: null,
      etaEarliest: null,
      etaLatest: null,
      source: 'none',
      note: '运费未知',
    },
    url: 'https://www.everlane.com/products/no-ship',
  }),
]

const owned = mkItem({
  productId: 'own_jeans',
  category: 'bottom',
  title: '已有牛仔裤',
  price: { amount: 0, currency: 'USD', status: 'confirmed' },
  shipping: { fee: null, status: 'unavailable', etaDays: null, etaEarliest: null, etaLatest: null, source: 'none' },
  url: '',
  sizes: ['已有'],
})

function buildPlan(budget = 200): OutfitPlan {
  return createPlan({
    label: '测试方案',
    scene: { type: 'travel', destination: 'Tokyo', days: 3, today: TODAY },
    budget: { limit: budget, currency: 'USD', basis: 'new_items_only' },
    arrivalBy: { date: DEADLINE },
    shipTo: 'CN',
    catalog,
    ownedItems: [owned],
    slots: [
      { slot: 'outerwear', status: 'to_buy', productId: 'live_ow' },
      { slot: 'top', status: 'to_buy', productId: 'seed_top' },
      { slot: 'bottom', status: 'owned', productId: 'own_jeans' },
      { slot: 'shoes', status: 'empty' },
      { slot: 'bag', status: 'empty' },
    ],
  })
}

/* ---------------------------------------------------------------- 购买入口 */

test('购买入口：只有已核实店铺的 /products/<handle> 才可买', () => {
  const live = buyInfo(catalog[0], 'to_buy')
  assert.equal(live.state, 'buyable')
  assert.equal(live.url, 'https://www.cuyana.com/products/long-anorak')
  assert.equal(live.store, 'Cuyana')

  const seed = buyInfo(catalog[1], 'to_buy')
  assert.notEqual(seed.state, 'buyable', 'example.com 占位链接不能变成购买按钮')
  assert.equal(seed.state, 'no_link')
  assert.equal(seed.url, null)

  const http = buyInfo(mkItem({ productId: 'x', category: 'top', url: 'http://www.cuyana.com/products/x' }), 'to_buy')
  assert.equal(http.state, 'untrusted', '非 https 不给入口')

  const collection = buyInfo(
    mkItem({ productId: 'y', category: 'top', url: 'https://www.cuyana.com/collections/women' }),
    'to_buy',
  )
  assert.equal(collection.state, 'untrusted', '分类页不是商品详情页')

  const empty = buyInfo(mkItem({ productId: 'z', category: 'top', url: '' }), 'to_buy')
  assert.equal(empty.state, 'no_link')
  assert.equal(empty.url, null)

  const own = buyInfo(owned, 'owned')
  assert.equal(own.state, 'owned')
  assert.equal(own.url, null)
})

test('购物清单：按店铺汇总，种子商品不计入可购买数量', () => {
  const plan = buildPlan()
  const lines = purchaseLines(plan)
  assert.equal(lines.length, 2)
  assert.equal(buyableCount(plan), 1)

  const groups = purchaseGroups(plan)
  const byVendor = Object.fromEntries(groups.map((g) => [g.vendor, g]))
  assert.equal(byVendor['Cuyana'].subtotal, 180)
  assert.equal(byVendor['Cuyana'].buyableCount, 1)
  assert.equal(byVendor['未标注店铺'].buyableCount, 0, '种子数据没有店铺也没有链接')
})

/* ---------------------------------------------------------------- 费用拆分 */

test('费用拆分：商品小计/运费分开，关税始终列为未确认且不计入总额', () => {
  const plan = buildPlan()
  const b = costBreakdown(plan)
  assert.equal(b.itemSubtotal, 220)
  assert.equal(b.shippingKnown, 20)
  assert.equal(b.knownTotal, 240, '可计算总额 = 商品 + 已知运费')
  assert.equal(b.verdict, 'over_budget')
  assert.equal(b.overBy, 40)
  assert.ok(b.unknownFees.some((f) => f.label.includes('关税')), '关税必须显式列为未确认费用')
  assert.notEqual(b.knownTotalStatus, 'confirmed', '含估算运费时不能自称已确认到手价')
})

/* ---------------------------------------------------------------- 约束调整 */

test('改预算只重算派生金额，不动任何单品，revision +1', () => {
  const plan = buildPlan(200)
  const before = plan.slots.map((s) => s.item?.productId ?? null)
  const { plan: next } = updateConstraints(plan, { budgetLimit: 300, shipTo: 'US' })
  assert.equal(next.revision, plan.revision + 1)
  assert.equal(next.constraints.budget.limit, 300)
  assert.equal(next.constraints.shipTo, 'US')
  assert.equal(next.cost.budget.verdict, 'within_budget')
  assert.deepEqual(next.slots.map((s) => s.item?.productId ?? null), before, '改约束不许换单品')
  assert.equal(next.ops.at(-1)?.type, 'update_constraints')
})

test('另存为新方案：新 ID、revision 归零、金额不变', () => {
  const plan = buildPlan()
  const copy = duplicatePlan(plan, 'pln_copy')
  assert.equal(copy.planId, 'pln_copy')
  assert.equal(copy.revision, 0)
  assert.equal(copy.ops.length, 0)
  assert.equal(copy.cost.newItemsTotal.amount, plan.cost.newItemsTotal.amount)
  assert.deepEqual(copy.slots.map((s) => s.item?.productId), plan.slots.map((s) => s.item?.productId))
})

/* ---------------------------------------------------------------- 预算内调整 */

test('调整至预算内：逐位换便宜货，每次只改一个搭配位', () => {
  const tight = buildPlan(60) // 240 总额 vs 60 预算
  const res = fitBudget(tight, catalog)
  assert.equal(res.ok, true, res.reason)
  assert.ok(res.plan.cost.newItemsTotal.amount <= 60)
  assert.equal(res.changes.length, 2, '两个待买位各换一次')
  assert.deepEqual(
    res.changes.map((c) => c.slot),
    ['outerwear', 'top'],
    '先动最贵的那一位',
  )
  // 每一步都只改一个搭配位：最终单品集合里至少保留一件原商品以外的合法商品
  for (const s of res.plan.slots) {
    assert.ok(s.item === null || catalog.concat([owned]).some((c) => c.productId === s.item!.productId))
  }
})

test('调整至预算内：锁定的位置不动，换不动就如实说明', () => {
  const tight = buildPlan(10)
  const plan = {
    ...tight,
    slots: tight.slots.map((s) => (s.slot === 'outerwear' ? { ...s, locked: true } : s)),
  }
  const res = fitBudget(plan, catalog)
  assert.equal(res.ok, false)
  assert.ok(res.reason.includes('仍超'), res.reason)
  assert.deepEqual(res.changes.map((c) => c.slot), ['top'], '锁定的外套不动，只换没锁的上衣')
  assert.equal(res.plan.slots.find((s) => s.slot === 'outerwear')?.item?.productId, 'live_ow')
})

/* ------------------------------------------------- 推荐池：真实商品优先 */

test('候选推荐：本类目有真实可购买候选时，不把演示数据推给用户', () => {
  const seedBag = mkItem({
    productId: 'seed_bag',
    category: 'bag',
    sourceKind: 'seed',
    price: { amount: 20, currency: 'USD', status: 'confirmed', source: 'seed' },
    url: 'https://example.com/p/seed_bag',
  })
  const liveBag = mkItem({
    productId: 'live_bag',
    category: 'bag',
    vendor: 'Cuyana',
    sourceKind: 'live',
    price: { amount: 90, currency: 'USD', status: 'confirmed' },
    url: 'https://www.cuyana.com/products/live-bag',
  })
  const baseBag = mkItem({
    productId: 'base_bag',
    category: 'bag',
    vendor: 'Cuyana',
    sourceKind: 'live',
    price: { amount: 150, currency: 'USD', status: 'confirmed' },
    url: 'https://www.cuyana.com/products/base-bag',
  })
  const c2 = [...catalog, seedBag, liveBag, baseBag]
  const plan = createPlan({
    label: '推荐池',
    scene: { type: 'travel', destination: 'Tokyo', days: 3, today: TODAY },
    budget: { limit: 500, currency: 'USD', basis: 'new_items_only' },
    arrivalBy: { date: DEADLINE },
    shipTo: 'CN',
    catalog: c2,
    ownedItems: [owned],
    slots: [
      { slot: 'outerwear', status: 'empty' },
      { slot: 'top', status: 'empty' },
      { slot: 'bottom', status: 'owned', productId: 'own_jeans' },
      { slot: 'shoes', status: 'empty' },
      { slot: 'bag', status: 'to_buy', productId: 'base_bag' },
    ],
  })
  const list = rankCandidates(plan, 'bag', c2, 'cheaper')
  assert.ok(list.length > 0)
  assert.ok(
    list.every((c) => c.item.sourceKind === 'live'),
    '演示件比真实件便宜，但不能出现在推荐里',
  )
  assert.equal(list[0].item.productId, 'live_bag')
})

test('候选推荐：本类目确实没有真实候选时，回退演示数据（否则离线演示就空了）', () => {
  const onlySeed = mkItem({
    productId: 'seed_bag2',
    category: 'bag',
    sourceKind: 'seed',
    price: { amount: 20, currency: 'USD', status: 'confirmed', source: 'seed' },
    url: 'https://example.com/p/seed_bag2',
  })
  const baseBag = mkItem({
    productId: 'base_bag2',
    category: 'bag',
    vendor: 'Cuyana',
    sourceKind: 'live',
    price: { amount: 150, currency: 'USD', status: 'confirmed' },
    url: 'https://www.cuyana.com/products/base-bag2',
  })
  const c3 = catalog.filter((c) => c.category !== 'bag').concat([onlySeed, baseBag])
  const plan = createPlan({
    label: '回退',
    scene: { type: 'travel', destination: 'Tokyo', days: 3, today: TODAY },
    budget: { limit: 500, currency: 'USD', basis: 'new_items_only' },
    arrivalBy: { date: DEADLINE },
    shipTo: 'CN',
    catalog: c3,
    ownedItems: [owned],
    slots: [
      { slot: 'outerwear', status: 'empty' },
      { slot: 'top', status: 'empty' },
      { slot: 'bottom', status: 'owned', productId: 'own_jeans' },
      { slot: 'shoes', status: 'empty' },
      { slot: 'bag', status: 'to_buy', productId: 'base_bag2' },
    ],
  })
  const list = rankCandidates(plan, 'bag', c3, 'cheaper')
  assert.deepEqual(list.map((c) => c.item.productId), ['seed_bag2'])
  assert.equal(buyInfo(list[0].item, 'to_buy').state, 'no_link', '回退时界面必须标成没有购买链接')
})
