/**
 * 场景验收（确定性部分）：对应交付要求里的 A–F。
 * 这些断言不依赖网络、不依赖模型，跑一次就能确认「换一件不误改其他」「未知不冒充已确认」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createPlan,
  applySwap,
  setSlotLock,
  PlanError,
  type CatalogItem,
  type Item,
  type OutfitPlan,
  type SlotId,
} from '../dist/index.js'

const seed = JSON.parse(readFileSync(join(process.cwd(), 'data', 'seed', 'catalog.json'), 'utf8'))
const catalog = seed.items as CatalogItem[]
const owned = seed.owned as Item[]
const TODAY = seed.meta.today as string
const DEADLINE = '2026-11-28'

function tokyoPlan(overrides: Partial<Parameters<typeof createPlan>[0]> = {}): OutfitPlan {
  return createPlan({
    planId: 'pln_scenario',
    label: '东京 3 天 · 方案 A',
    scene: { type: 'travel', destination: 'Tokyo', days: 3, today: TODAY },
    budget: { limit: 300, currency: 'USD', basis: 'new_items_only' },
    arrivalBy: { date: DEADLINE },
    shipTo: 'CN',
    catalog,
    ownedItems: owned,
    slots: [
      { slot: 'outerwear', status: 'to_buy', productId: 'ow_ivory_trench', reason: '浅色外套' },
      { slot: 'top', status: 'to_buy', productId: 'top_cream_tee' },
      { slot: 'bottom', status: 'owned', productId: 'own_dark_jeans', reason: '已有' },
      { slot: 'shoes', status: 'to_buy', productId: 'shoe_beige_slipon' },
      { slot: 'bag', status: 'empty' },
    ],
    ...overrides,
  })
}

const ids = (plan: OutfitPlan) =>
  Object.fromEntries(plan.slots.map((s) => [s.slot, s.item?.productId ?? null])) as Record<SlotId, string | null>

// ---------------------------------------------------------------- A 方案创建
test('A 方案创建：五个搭配位、已有/待买区分、金额与到货都有确定结论', () => {
  const plan = tokyoPlan()

  assert.equal(plan.slots.length, 5)
  const bottom = plan.slots.find((s) => s.slot === 'bottom')
  assert.equal(bottom?.status, 'owned')
  assert.equal(bottom?.item?.price.amount, 0, '已有单品不计入新增支出')

  const toBuy = plan.slots.filter((s) => s.status === 'to_buy')
  assert.equal(toBuy.length, 3)
  for (const s of toBuy) {
    assert.ok(s.item?.productId, `${s.slot} 必须有商品 ID`)
    assert.ok(s.item?.image.cutout, `${s.slot} 必须有商品图`)
    assert.ok(s.item?.url !== undefined, `${s.slot} 应该有来源字段`)
  }

  // 金额 = 各待买件到手价之和，且状态取最弱者
  const sum = toBuy.reduce((acc, s) => acc + (s.item?.price.amount ?? 0) + (s.item?.shipping.fee?.amount ?? 0), 0)
  assert.equal(plan.cost.newItemsTotal.amount, sum)
  assert.equal(plan.cost.budget.remaining, plan.cost.budget.limit - sum)
  assert.ok(['confirmed', 'estimated', 'unavailable'].includes(plan.cost.newItemsTotal.status))

  // 到货必须给出明确结论或 unknown，不允许空着
  assert.ok(['on_time', 'at_risk', 'late', 'unknown'].includes(plan.arrival.verdict))
  assert.equal(plan.arrival.deadline, DEADLINE)
  assert.equal(plan.revision, 0)
})

// ---------------------------------------------------------------- B 单件隔离
test('B 点击换件：只改目标搭配位，其余商品 ID 与数量完全不变', () => {
  const before = tokyoPlan()
  const beforeIds = ids(before)

  const { plan: after, diff } = applySwap(before, catalog, {
    slot: 'outerwear',
    revision: before.revision,
    strategy: 'cheaper',
  })

  assert.deepEqual(diff.changedSlots, ['outerwear'])
  const afterIds = ids(after)
  for (const slot of Object.keys(beforeIds) as SlotId[]) {
    if (slot === 'outerwear') continue
    assert.equal(afterIds[slot], beforeIds[slot], `${slot} 不应被改动`)
  }
  assert.notEqual(afterIds.outerwear, beforeIds.outerwear, '外套必须换掉')
  assert.equal(after.revision, before.revision + 1)
  assert.equal(after.slots.length, before.slots.length, '搭配位数量不变')
})

// ---------------------------------------------------------------- C 预算变化
test('C 预算：更便宜后总额下降；超预算的手动选择会被标记为超支', () => {
  const start = tokyoPlan()
  const cheaper = applySwap(start, catalog, { slot: 'shoes', revision: start.revision, strategy: 'cheaper' })
  assert.ok(
    cheaper.plan.cost.newItemsTotal.amount <= start.cost.newItemsTotal.amount,
    '「更便宜」不应让总额上升',
  )
  assert.ok(cheaper.plan.cost.budget.remaining >= start.cost.budget.remaining)

  // 手动指定一件贵的：允许（知情选择），但必须准确报超支
  const expensive = catalog
    .filter((c) => c.category === 'bag')
    .sort((a, b) => b.price.amount! - a.price.amount!)[0]
  const { plan: over } = applySwap(cheaper.plan, catalog, {
    slot: 'bag',
    revision: cheaper.plan.revision,
    productId: expensive.productId,
  })
  if (over.cost.newItemsTotal.amount > over.cost.budget.limit) {
    assert.equal(over.cost.budget.verdict, 'over_budget')
    assert.ok(over.cost.budget.remaining < 0, '超支时剩余预算必须为负，不能截断成 0')
  }
})

test('C2 预算：策略换件在超预算时直接拒绝，并保持原方案不变', () => {
  const tight = tokyoPlan({ budget: { limit: 40, currency: 'USD', basis: 'new_items_only' } })
  const beforeIds = ids(tight)

  assert.throws(
    () => applySwap(tight, catalog, { slot: 'outerwear', revision: tight.revision, strategy: 'similar' }),
    (err: unknown) => err instanceof PlanError && err.code === 'NO_CANDIDATE',
  )

  const unchanged = ids(tight)
  assert.deepEqual(unchanged, beforeIds, '被拒绝后方案不能有任何改动')
  assert.equal(tight.revision, 0)
})

// ---------------------------------------------------------------- D 配送变化
test('D 配送：换成更快到的候选后，最晚到货日不会变晚', () => {
  const start = tokyoPlan()
  const { plan: after } = applySwap(start, catalog, {
    slot: 'outerwear',
    revision: start.revision,
    strategy: 'faster',
  })
  assert.ok(after.arrival.latest, '换到更快到的商品后必须能算出到货日')
  if (start.arrival.latest && after.arrival.latest) {
    assert.ok(after.arrival.latest <= start.arrival.latest, '「更快到」不应让到货变晚')
  }
})

test('D2 配送：运费不可用的商品把到货降级为 unknown，绝不假装能赶上', () => {
  const withUnknown = applySwap(tokyoPlan(), catalog, {
    slot: 'outerwear',
    revision: 0,
    productId: 'ow_beige_raincoat', // 运费 unavailable
  })
  assert.equal(withUnknown.plan.arrival.verdict, 'unknown')
  assert.deepEqual(withUnknown.plan.arrival.blocking.length > 0, true)
  assert.equal(withUnknown.plan.cost.budget.risky, true, '含待确认费用时预算结论必须降级')
})

// ---------------------------------------------------------------- E 状态可读（页面/对话共用的同一份对象语义）
test('E 状态同步：方案经 JSON 往返（页面/服务重启）后仍可继续确定性变更', () => {
  const start = tokyoPlan()
  const swapped = applySwap(start, catalog, { slot: 'shoes', revision: 0, strategy: 'cheaper' }).plan

  const roundTrip = JSON.parse(JSON.stringify(swapped)) as OutfitPlan
  assert.deepEqual(ids(roundTrip), ids(swapped))

  const again = applySwap(roundTrip, catalog, { slot: 'top', revision: roundTrip.revision, strategy: 'cheaper' })
  assert.deepEqual(again.diff.changedSlots, ['top'])
  assert.equal(again.plan.revision, swapped.revision + 1)
})

// ---------------------------------------------------------------- F 无候选 / 锁定
test('F 无候选：抛出 NO_CANDIDATE，原方案与 revision 都不变', () => {
  const plan = tokyoPlan()
  const beforeIds = ids(plan)
  const beforeRev = plan.revision

  // 目录里没有包 → 空位补货必须明确失败
  const noBag = catalog.filter((c) => c.category !== 'bag')
  assert.throws(
    () => applySwap(plan, noBag, { slot: 'bag', revision: plan.revision, strategy: 'similar' }),
    (err: unknown) => err instanceof PlanError && (err.code === 'NO_CANDIDATE' || err.code === 'SLOT_NOT_FOUND'),
  )
  assert.deepEqual(ids(plan), beforeIds)
  assert.equal(plan.revision, beforeRev)
})

test('F2 锁定：被锁定的搭配位拒绝替换，且方案不变', () => {
  const plan = tokyoPlan()
  const locked = setSlotLock(plan, 'shoes', true).plan
  const before = ids(locked)

  assert.throws(
    () => applySwap(locked, catalog, { slot: 'shoes', revision: locked.revision, strategy: 'cheaper' }),
    (err: unknown) => err instanceof PlanError && err.code === 'SLOT_LOCKED',
  )
  assert.deepEqual(ids(locked), before)
})

test('F3 已有单品：不参与替换（不是「换成更便宜的鞋」能动的）', () => {
  const plan = tokyoPlan()
  assert.throws(
    () => applySwap(plan, catalog, { slot: 'bottom', revision: plan.revision, strategy: 'cheaper' }),
    (err: unknown) => err instanceof PlanError && err.code === 'OWNED_SLOT',
  )
})
