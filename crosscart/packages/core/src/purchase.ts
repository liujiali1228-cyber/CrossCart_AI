/**
 * 购买入口与费用拆分的唯一判定处。
 *
 * 为什么单独一个模块：
 *  - 「能不能给用户一个『去商家买』按钮」是诚信问题，不能由界面随手拼 URL；
 *  - 页面（Studio）、AI 工具（dsh 插件）、费用卡必须读到同一份结论；
 *  - 所以规则做成纯函数：证书化的店铺白名单 + 真实商品详情页路径，其余一律不给入口。
 */
import type { Item, OutfitPlan, SlotId, Status } from './types.js'
import { SLOT_LABEL } from './types.js'
import { itemLine } from './pricing.js'
import { weakest } from './status.js'

/** 已核实的店铺：只有这些域名下的 /products/<handle> 才是真实商品详情页。 */
export const TRUSTED_STORES = [
  { id: 'cuyana', name: 'Cuyana', host: 'cuyana.com' },
  { id: 'rothys', name: "Rothy's", host: 'rothys.com' },
  { id: 'allbirds', name: 'Allbirds', host: 'allbirds.com' },
  { id: 'everlane', name: 'Everlane', host: 'everlane.com' },
] as const

export type BuyState = 'buyable' | 'owned' | 'no_link' | 'untrusted'

export interface BuyInfo {
  state: BuyState
  /** 只有在 state === 'buyable' 时非空；其余情况界面必须隐藏购买按钮 */
  url: string | null
  /** 给用户看的说明，不允许留空 */
  note: string
  /** 是否为已核实店铺 */
  trusted: boolean
  store: string | null
}

const VARIANT_NOTE = '颜色与尺码请在商家页面再次核对'

function hostOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return null
    return u.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

function storeOfHost(host: string | null) {
  if (!host) return null
  return TRUSTED_STORES.find((s) => host === s.host || host.endsWith(`.${s.host}`)) ?? null
}

/**
 * 判断一件商品是否可以给出真实购买入口。
 * 只有「https + 已核实店铺域名 + /products/<handle> 详情页路径」三者同时成立才放行；
 * 种子数据里的 example.com 占位链接会被判为不可核实，界面不得展示购买按钮。
 */
export function buyInfo(item: Item | null, slotStatus?: 'owned' | 'to_buy' | 'empty'): BuyInfo {
  if (!item) {
    return { state: 'no_link', url: null, note: '这个搭配位还没有商品', trusted: false, store: null }
  }
  if (slotStatus === 'owned') {
    return { state: 'owned', url: null, note: '已拥有，不计入新增支出，无需购买入口', trusted: false, store: null }
  }
  const raw = (item.url ?? '').trim()
  if (!raw) {
    return { state: 'no_link', url: null, note: '这件商品没有可核实的商品页链接', trusted: false, store: null }
  }
  const host = hostOf(raw)
  const store = storeOfHost(host)
  if (!host || !store) {
    // 演示种子数据里的 example.com 占位链接绝不能变成「去商家购买」
    if (item.sourceKind === 'seed') {
      return {
        state: 'no_link',
        url: null,
        note: '演示数据：没有可核实的商家购买页',
        trusted: false,
        store: null,
      }
    }
    return {
      state: 'untrusted',
      url: null,
      note: '链接不是来自已核实的商家店铺，已隐藏购买入口',
      trusted: false,
      store: null,
    }
  }
  const pathOk = /^\/products\/[^/?#]+/.test(new URL(raw).pathname)
  if (!pathOk) {
    return {
      state: 'untrusted',
      url: null,
      note: '链接不是商品详情页（可能是分类页或活动页），已隐藏购买入口',
      trusted: false,
      store: store.name,
    }
  }
  return { state: 'buyable', url: raw, note: VARIANT_NOTE, trusted: true, store: store.name }
}

export interface PurchaseLine {
  slot: SlotId
  slotLabel: string
  title: string
  vendor: string
  price: number
  priceStatus: Status
  shippingFee: number | null
  shippingStatus: Status
  etaEarliest: string | null
  etaLatest: string | null
  sizes: string[]
  buy: BuyInfo
}

/** 待购买清单（只含 to_buy），按用户视角的顺序输出，不做任何聚合。 */
export function purchaseLines(plan: OutfitPlan): PurchaseLine[] {
  return plan.slots
    .filter((s) => s.status === 'to_buy' && s.item)
    .map((s) => {
      const item = s.item as Item
      return {
        slot: s.slot,
        slotLabel: SLOT_LABEL[s.slot],
        title: item.title,
        vendor: item.vendor ?? '未标注店铺',
        price: item.price.amount ?? 0,
        priceStatus: item.price.status,
        shippingFee: item.shipping.fee?.amount ?? null,
        shippingStatus: item.shipping.status,
        etaEarliest: item.shipping.etaEarliest,
        etaLatest: item.shipping.etaLatest,
        sizes: item.sizes ?? [],
        buy: buyInfo(item, s.status),
      }
    })
}

export interface PurchaseGroup {
  vendor: string
  lines: PurchaseLine[]
  /** 商品价合计（不含运费） */
  subtotal: number
  /** 该店可核实的购买入口数量 */
  buyableCount: number
  /** 是否所有商品都缺运费/时效 */
  missingShipping: boolean
}

/** 按店铺汇总：这是「购物清单」视图的数据源，页面不自己分组。 */
export function purchaseGroups(plan: OutfitPlan): PurchaseGroup[] {
  const map = new Map<string, PurchaseLine[]>()
  for (const line of purchaseLines(plan)) {
    const key = line.vendor
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(line)
  }
  return [...map.entries()].map(([vendor, lines]) => ({
    vendor,
    lines,
    subtotal: lines.reduce((acc, l) => acc + l.price, 0),
    buyableCount: lines.filter((l) => l.buy.state === 'buyable').length,
    missingShipping: lines.every((l) => l.shippingStatus === 'unavailable' || l.shippingFee == null),
  }))
}

export interface CostBreakdown {
  currency: string
  /** 待买商品挂牌价合计（已确认部分） */
  itemSubtotal: number
  itemStatus: Status
  /** 已知运费合计（按估算） */
  shippingKnown: number
  /** 运费状态合并结果 */
  shippingStatus: Status
  /** 有几件运费仍待确认 */
  shippingUnknownCount: number
  /** 已确认的其他费用（v1 没有，显式留 0 并标注为 0 而不是省略） */
  otherConfirmed: number
  /** 不可计算的费用项（关税等）：不得计入总额 */
  unknownFees: Array<{ label: string; reason: string }>
  /** 当前可计算的总额 = 商品 + 已知运费 + 已确认其他费用 */
  knownTotal: number
  knownTotalStatus: Status
  budgetLimit: number
  remaining: number
  verdict: 'within_budget' | 'over_budget'
  overBy: number
  risky: boolean
}

/**
 * 费用拆分：把「能算的」和「算不出的」分开陈列。
 * 绝不把未确认费用当 0 之后宣称这是最终到手价 —— unknownFees 会一直被显示。
 */
export function costBreakdown(plan: OutfitPlan): CostBreakdown {
  const lines = plan.slots.filter((s) => s.status === 'to_buy' && s.item).map((s) => itemLine(s.item as Item))
  const itemSubtotal = lines.reduce((acc, l) => acc + l.parts.item, 0)
  const shippingKnown = lines.reduce((acc, l) => acc + (l.parts.shipping ?? 0), 0)
  // 商品小计的可信度只看挂牌价本身（运费的可信度单独一行展示，别混进来）
  const priceStatuses = plan.slots
    .filter((s) => s.status === 'to_buy' && s.item)
    .map((s) => (s.item as Item).price.status)
  const itemStatus: Status = priceStatuses.length
    ? priceStatuses.reduce((acc, s) => weakest(acc, s), 'confirmed' as Status)
    : 'confirmed'
  const shippingStatuses = plan.slots
    .filter((s) => s.status === 'to_buy' && s.item)
    .map((s) => (s.item as Item).shipping.status)
  const shippingStatus: Status = shippingStatuses.length
    ? shippingStatuses.reduce((acc, s) => weakest(acc, s), 'confirmed' as Status)
    : 'confirmed'
  const shippingUnknownCount = shippingStatuses.filter((s) => s === 'unavailable').length

  const unknownFees: Array<{ label: string; reason: string }> = []
  if (
    plan.slots.some((s) => (s.item as Item | null)?.duty?.status === 'unavailable' && s.status === 'to_buy')
  ) {
    unknownFees.push({ label: '跨境关税/进口税', reason: '以商家结账页与目的国海关实际征收为准，本页不估算' })
  }
  if (shippingUnknownCount > 0) {
    unknownFees.push({ label: `运费（${shippingUnknownCount} 件待确认）`, reason: '商家未公开运费，需在结账页确认' })
  }

  const otherConfirmed = 0
  const knownTotal = itemSubtotal + shippingKnown + otherConfirmed
  const knownTotalStatus: Status =
    shippingUnknownCount > 0 ? 'estimated' : weakest(itemStatus, shippingStatus)
  const limit = plan.constraints.budget.limit
  const remaining = limit - knownTotal

  return {
    currency: plan.cost.currency,
    itemSubtotal,
    itemStatus,
    shippingKnown,
    shippingStatus,
    shippingUnknownCount,
    otherConfirmed,
    unknownFees,
    knownTotal,
    knownTotalStatus,
    budgetLimit: limit,
    remaining,
    verdict: knownTotal > limit ? 'over_budget' : 'within_budget',
    overBy: Math.max(0, knownTotal - limit),
    risky: shippingUnknownCount > 0,
  }
}

/** 可核实购买入口总数：用于「购物清单」页头，也用于验收断言。 */
export function buyableCount(plan: OutfitPlan): number {
  return purchaseLines(plan).filter((l) => l.buy.state === 'buyable').length
}
