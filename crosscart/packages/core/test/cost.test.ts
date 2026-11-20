/** 图像费用与预算：纯函数单测（没有网络、没有真实账单）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateCost,
  costFromUsage,
  budgetStatus,
  canAfford,
  DEFAULT_MONTHLY_BUDGET,
  type SpendRecord,
} from '../dist/index.js'

const MODEL = 'gpt-image-2.6-sunburst'

test('缓存命中：估价 0，来源标成 cache-hit', () => {
  const e = estimateCost({ model: MODEL, quality: 'medium', cached: true })
  assert.equal(e.amount, 0)
  assert.equal(e.basis, 'cache-hit')
  assert.equal(e.status, 'estimated')
})

test('按模型与质量档估价：high 明显贵于 medium，low 明显便宜', () => {
  const med = estimateCost({ model: MODEL, quality: 'medium', kind: 'scene-new' })
  const high = estimateCost({ model: MODEL, quality: 'high', kind: 'scene-new' })
  const low = estimateCost({ model: MODEL, quality: 'low', kind: 'scene-new' })
  assert.ok(med.amount! > 0, '应该给出正数估价')
  assert.ok(high.amount! > med.amount! * 2, `high 应显著更贵（${high.amount} vs ${med.amount}）`)
  assert.ok(low.amount! < med.amount!, `low 应更便宜（${low.amount} vs ${med.amount}）`)
  assert.equal(med.basis, 'price-table')
  assert.match(med.note, /以服务商账单为准/)
})

test('换件 / 换场景的估价带上操作系数，不会和首次生成一个价', () => {
  const fresh = estimateCost({ model: MODEL, quality: 'medium', kind: 'scene-new' })
  const swap = estimateCost({ model: MODEL, quality: 'medium', kind: 'scene-swap' })
  assert.ok(swap.amount! < fresh.amount!, '换件编辑应略便宜')
})

test('认不出的模型：返回「费用待确认」，不编一个数字', () => {
  const e = estimateCost({ model: 'some-unknown-image-model-v9', quality: 'medium' })
  assert.equal(e.amount, null)
  assert.equal(e.status, 'unavailable')
  assert.equal(e.basis, 'unknown')
})

test('只有 usage、没有单价时也如实标待确认', () => {
  const e = costFromUsage({ output_tokens: 4200 }, { model: 'unknown-model', quality: 'medium' })
  assert.equal(e.amount, null)
  assert.equal(e.status, 'unavailable')
})

test('usage 折算有下限：token 再少也不低于档位单价（否则预算闸门会失守）', () => {
  const table = estimateCost({ model: MODEL, quality: 'medium' })
  const stingy = costFromUsage({ input_tokens: 9000, output_tokens: 1132 }, { model: MODEL, quality: 'medium' })
  assert.equal(stingy.amount, table.amount, `实测 input 9k/output 1.1k 不能低报成半价（${stingy.amount}）`)
  assert.equal(stingy.basis, 'usage')
  const heavy = costFromUsage({ input_tokens: 9000, output_tokens: 12000 }, { model: MODEL, quality: 'medium' })
  assert.ok(heavy.amount! > table.amount!, 'token 明显超出时按比例上浮')
  assert.ok(heavy.amount! <= table.amount! * 2, '上浮有上限，不无限放大')
})

test('预算：只统计本月、跳过缓存命中，80% 预警 / 100% 阻止', () => {
  const mk = (month: string, amount: number, cached = false): SpendRecord => ({
    at: `${month}-05T10:00:00.000Z`,
    month,
    kind: 'scene-new',
    amount,
    currency: 'USD',
    basis: cached ? 'cache-hit' : 'price-table',
    model: MODEL,
    ok: true,
    cached,
  })
  const records = [mk('2026-11', 3), mk('2026-11', 3.6), mk('2026-11', 5, true), mk('2026-10', 7)]
  const s = budgetStatus(records, { limit: DEFAULT_MONTHLY_BUDGET, currency: 'USD' }, '2026-11-17T12:00:00.000Z')
  assert.equal(s.spent, 6.6, '本月累计 3+3.6，缓存那条不算')
  assert.equal(s.month, '2026-11')
  assert.equal(s.level, 'warn')
  assert.ok(s.remaining > 1 && s.remaining < 1.5)

  const blocked = budgetStatus([...records, mk('2026-11', 1.5)], { limit: 8, currency: 'USD' }, '2026-11-17T12:00:00.000Z')
  assert.equal(blocked.level, 'blocked')
  assert.equal(blocked.remaining, 0)
})

test('预算闸门：超出就不能再花钱，但缓存命中永远放行', () => {
  const spent = budgetStatus(
    [{ at: '2026-11-02T00:00:00.000Z', month: '2026-11', kind: 'scene-new', amount: 8, currency: 'USD', basis: 'price-table', model: MODEL, ok: true, cached: false }],
    { limit: 8, currency: 'USD' },
    '2026-11-17T12:00:00.000Z',
  )
  assert.equal(spent.level, 'blocked')
  assert.equal(canAfford(spent, estimateCost({ model: MODEL, quality: 'medium' })), false)
  assert.equal(canAfford(spent, estimateCost({ model: MODEL, cached: true })), true, '缓存命中不花钱，必须放行')
})
