/** 价格 / 运费 / 到货的三态。凡是补算出来的，一律不是 confirmed。 */
export type Status = 'confirmed' | 'estimated' | 'unavailable'

export type SlotId = 'outerwear' | 'top' | 'bottom' | 'shoes' | 'bag'
export type SlotStatus = 'owned' | 'to_buy' | 'empty'
export type ColorFamily = 'light' | 'mid' | 'dark'

export interface Money {
  amount: number | null
  currency: string
  status: Status
  source?: string
  fetchedAt?: string
}

export interface Shipping {
  /** 运费。null 表示没有报价。 */
  fee: Money | null
  status: Status
  /** 种子数据里的物流天数区间；快照阶段会换算成具体日期。 */
  etaDays: [number, number] | null
  etaEarliest: string | null
  etaLatest: string | null
  source: string
  note?: string
}

export interface Duty {
  amount: number | null
  currency?: string
  status: Status
  reason?: string
}

export interface ProductImage {
  /** 商家白底原图（详情页用） */
  main: string
  /** 去背景图（拼搭画布用） */
  cutout: string
}

/** 目录项与方案内单品同构：进入方案时做一次快照（含换算后的 ETA 日期）。 */
export interface Item {
  productId: string
  title: string
  category: SlotId
  color: string
  colorFamily: ColorFamily
  style: string[]
  price: Money
  shipping: Shipping
  duty: Duty
  sizes: string[]
  url: string
  image: ProductImage
  /** 店铺名（真实商品来自 Shopify 店铺；种子数据没有） */
  vendor?: string
  /** 数据来源：live = 真实店铺实时抓取，seed = 演示种子数据 */
  sourceKind?: 'live' | 'seed'
}

export type CatalogItem = Item

export interface CostLinePart {
  item: number
  shipping: number | null
  duty: number | null
}

export interface CostLine {
  label: string
  amount: number
  currency: string
  status: Status
  parts: CostLinePart
}

export interface Budget {
  limit: number
  currency: string
  basis: 'new_items_only'
}

export interface ArrivalConstraint {
  date: string
  timezone?: string
}

export interface PlanCost {
  currency: string
  lines: CostLine[]
  newItemsTotal: { amount: number; currency: string; status: Status }
  budget: {
    limit: number
    remaining: number
    status: Status
    verdict: 'within_budget' | 'over_budget'
    /** 有不可用的费用项（运费/关税待确认）时为 true，预算结论最多只能算 estimated */
    risky: boolean
  }
}

export type ArrivalVerdict = 'on_time' | 'at_risk' | 'late' | 'unknown'

export interface PlanArrival {
  verdict: ArrivalVerdict
  earliest: string | null
  latest: string | null
  deadline: string
  blocking: string[]
}

export interface Scene {
  type: string
  destination: string
  days: number
  /** 计算基准日（ISO）。所有 ETA 日期都由它 + etaDays 得出，保证评测可复现。 */
  today: string
}

export interface Slot {
  slot: SlotId
  status: SlotStatus
  locked: boolean
  reason?: string
  item: Item | null
  /**
   * 「已拥有」的来源凭证：只有用户在对话里明确说过自己拥有这件商品，才允许 status=owned。
   * 没有 claim 的 owned 只可能是修复前遗留的数据 —— 界面照实显示，但不得在新方案里继承，
   * 也不得在给模型的上下文里当成「用户已有」作事实。
   *
   * P9：用户说的是「我有白色的鞋子」这种**没有具体商品**的话时，item 为 null，
   * 靠 label / color 记住他描述的东西（「用户自有白鞋，款式未知」）。
   * 这种情况绝不能为了填满槽位去虚构一款具体商品，也不能因为 item=null 就把它从
   * 生图提示词里漏掉 —— 漏掉正是「用户说白鞋、图上却是黑靴」的直接原因。
   */
  ownedClaim?: {
    quote: string
    at: string
    /** 用户自己的说法（中文原话片段，如「白色的鞋子」）；抽象已有必须有 */
    label?: string
    /** 从 label 解析出的颜色词（英文，写进生图提示词用）；解析不出为 null */
    color?: string | null
  }
  /**
   * 换件前的上一件（快照）。只为一件事存在：**回滚不能依赖商品是否还在售**。
   * 店铺下架或抓取口径变化会让某个 productId 从目录里消失，用户想换回原来那件时，
   * 目录里查不到也得能换回——否则方案会被永久锁在一个不想要的状态。
   */
  previousItem?: Item | null
}

export type OpType = 'swap_item' | 'remove_item' | 'lock' | 'unlock' | 'update_constraints'

export interface PlanOp {
  opId: string
  type: OpType
  slot: SlotId | null
  from?: string | null
  to?: string | null
  strategy?: string
  score?: number
  at: string
  note?: string
}

export interface OutfitPlan {
  planId: string
  revision: number
  label: string
  scene: Scene
  constraints: {
    budget: Budget
    arrivalBy: ArrivalConstraint
    shipTo: string
    /**
     * 本方案**一次性**破例的硬性偏好（用户在本轮对话中明确授权）。
     *
     * 为什么不改偏好本身：破例是「这套方案这次要用」，不是「以后都不介意」。
     * 记在方案上 + 保留用户原话，既能继续建方案，也不会悄悄削弱长期偏好；
     * 方案详情里会如实展示，可随时复核。
     */
    prefExceptions?: Array<{ rule: string; quote: string; at: string }>
  }
  slots: Slot[]
  cost: PlanCost
  arrival: PlanArrival
  ops: PlanOp[]
}

export interface PlanDiff {
  changedSlots: SlotId[]
  swap?: {
    slot: SlotId
    fromTitle: string | null
    toTitle: string | null
    priceDelta: number | null
  }
  costFrom: number
  costTo: number
  arrivalFrom: ArrivalVerdict
  arrivalTo: ArrivalVerdict
  budgetRemainingTo: number
  budgetStatusTo: Status
  summary: string
}

export const SLOT_LABEL: Record<SlotId, string> = {
  outerwear: '外套',
  top: '上衣',
  bottom: '裤装',
  shoes: '鞋',
  bag: '包',
}

export const SLOT_ORDER: SlotId[] = ['outerwear', 'top', 'bottom', 'shoes', 'bag']
