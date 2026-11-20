import type { Item, OutfitPlan, PlanArrival, PlanCost, ArrivalVerdict, Status } from './types.js'
import { weakest } from './status.js'

/** ISO 日期工具：所有日期运算集中在这里，别处不做时间算术。 */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`)
  const b = Date.parse(`${toIso}T00:00:00Z`)
  return Math.round((b - a) / 86400000)
}

/**
 * 单件到手价：只累计"已知"部分。
 * 状态由 商品价+运费 决定；关税在 v1 恒为不可用，不参与状态合并（否则每行都变「待确认」，
 * 淹没真实信号），而是通过 note 明示「不含目的国关税」。
 */
export function itemLine(item: Item) {
  const price = item.price
  const shippingKnown =
    item.shipping.status !== 'unavailable' && item.shipping.fee ? (item.shipping.fee.amount ?? 0) : 0
  const dutyKnown = item.duty.status !== 'unavailable' && item.duty.amount ? item.duty.amount : 0
  const status = weakest(price.status, item.shipping.status)
  return {
    label: item.title,
    amount: (price.amount ?? 0) + shippingKnown + dutyKnown,
    currency: price.currency,
    status,
    parts: {
      item: price.amount ?? 0,
      shipping: shippingKnown > 0 ? shippingKnown : null,
      duty: dutyKnown > 0 ? dutyKnown : null,
    } as { item: number; shipping: number | null; duty: number | null },
  }
}

export function computeCost(plan: OutfitPlan): PlanCost {
  const currency = plan.constraints.budget.currency
  const lines = plan.slots
    .filter((s) => s.status === 'to_buy' && s.item)
    .map((s) => itemLine(s.item as Item))

  const total = lines.reduce((acc, l) => acc + l.amount, 0)
  const totalStatus: Status = lines.length
    ? lines.reduce((acc, l) => weakest(acc, l.status), 'confirmed' as Status)
    : 'confirmed'
  // 有任何待确认费用项时，金额是"已知部分"，预算结论最多只能算 estimated
  const risky = lines.some((l) => l.status === 'unavailable')
  const limit = plan.constraints.budget.limit
  const remaining = limit - total
  const verdict = total > limit ? 'over_budget' : 'within_budget'

  return {
    currency,
    lines,
    newItemsTotal: { amount: total, currency, status: totalStatus },
    budget: {
      limit,
      remaining,
      status: risky ? weakest(totalStatus, 'estimated') : totalStatus,
      verdict,
      risky,
    },
  }
}

/** 到货判定：任一待买单品运费不可用 → unknown；否则按最晚 ETA 与截止日比较。 */
export function computeArrival(plan: OutfitPlan): PlanArrival {
  const deadline = plan.constraints.arrivalBy.date
  const toBuy = plan.slots.filter(
    (s): s is typeof s & { item: Item } => s.status === 'to_buy' && s.item !== null,
  )

  const blocking = toBuy
    .filter((s) => s.item.shipping.status === 'unavailable')
    .map((s) => `${s.item.title} 运费与时效未确认`)

  if (blocking.length > 0) {
    return { verdict: 'unknown', earliest: null, latest: null, deadline, blocking }
  }

  const etas = toBuy
    .map((s) => s.item.shipping)
    .filter((sh) => sh.etaLatest !== null) as { etaEarliest: string; etaLatest: string }[]
  if (etas.length === 0) {
    return { verdict: 'unknown', earliest: null, latest: null, deadline, blocking: [] }
  }

  const earliest = etas.reduce((min, e) => (e.etaEarliest < min ? e.etaEarliest : min), etas[0].etaEarliest)
  const latest = etas.reduce((max, e) => (e.etaLatest > max ? e.etaLatest : max), etas[0].etaLatest)
  const late = daysBetween(deadline, latest)

  let verdict: ArrivalVerdict
  if (late <= 0) verdict = 'on_time'
  else if (late <= 3) verdict = 'at_risk'
  else verdict = 'late'

  return { verdict, earliest, latest, deadline, blocking: [] }
}

export const ARRIVAL_LABEL: Record<ArrivalVerdict, string> = {
  on_time: '能赶上',
  at_risk: '可能赶不上',
  late: '赶不上',
  unknown: '到货时间待确认',
}
