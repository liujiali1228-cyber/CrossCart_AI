import type {
  Budget,
  CatalogItem,
  Item,
  OutfitPlan,
  PlanDiff,
  PlanOp,
  Scene,
  Slot,
  SlotId,
  ArrivalVerdict,
  Status,
} from './types.js'
import { SLOT_LABEL, SLOT_ORDER } from './types.js'
import { addDays, computeArrival, computeCost, itemLine, ARRIVAL_LABEL } from './pricing.js'
import { rankCandidates, rankCandidatesDetailed, type Candidate, type ExcludedItem, type Strategy } from './ranking.js'
import { buildPrefRules, prefExclusionHits } from './pref-match.js'
import type { PrefContext, PrefRecord } from './prefs.js'
import { STATUS_LABEL } from './status.js'

export type PlanErrorCode =
  | 'STALE_REVISION'
  | 'SLOT_NOT_FOUND'
  | 'SLOT_LOCKED'
  | 'OWNED_SLOT'
  | 'NO_CANDIDATE'
  | 'CATEGORY_MISMATCH'
  | 'GUARD_VIOLATION'
  /**
   * 建方案时提交的商品违反了用户已确认的硬性偏好（尺码 / 避开品牌 / 避开词）。
   * 与 NO_CANDIDATE 分开：这个错误意味着「方案本身没错，是被你的长期偏好挡住了」，
   * 调用方需要把冲突商品、规则和下一步选项原样告诉用户。
   */
  | 'PREF_CONFLICT'

export class PlanError extends Error {
  code: PlanErrorCode
  hint?: string
  /** 结构化补充（冲突商品、规则、可执行动作）；序列化时原样返回给调用方，便于 UI / 模型继续处理 */
  details?: unknown
  constructor(code: PlanErrorCode, message: string, hint?: string, details?: unknown) {
    super(message)
    this.code = code
    this.hint = hint
    this.details = details
  }
}

export interface PlanInit {
  planId?: string
  label: string
  scene: Scene
  budget: Budget
  arrivalBy: { date: string }
  shipTo: string
  slots: Array<{ slot: SlotId; status: 'owned' | 'to_buy' | 'empty'; productId?: string; reason?: string }>
  catalog: CatalogItem[]
  ownedItems?: Item[]
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}

/** 目录项 → 方案内快照（把 ETA 天数换算成具体日期，保证可复现）。 */
export function snapshot(item: CatalogItem, today: string): Item {
  const snap = clone(item)
  if (snap.shipping.status !== 'unavailable' && snap.shipping.etaDays) {
    snap.shipping.etaEarliest = addDays(today, snap.shipping.etaDays[0])
    snap.shipping.etaLatest = addDays(today, snap.shipping.etaDays[1])
  } else {
    snap.shipping.etaEarliest = null
    snap.shipping.etaLatest = null
  }
  return snap
}

function freshPlan(base: OutfitPlan): OutfitPlan {
  const next = clone(base)
  next.cost = computeCost(next)
  next.arrival = computeArrival(next)
  return next
}

let opSeq = 0
function nextOpId(): string {
  opSeq += 1
  return `op_${String(opSeq).padStart(3, '0')}`
}

export function createPlan(init: PlanInit): OutfitPlan {
  const byId = new Map(init.catalog.map((c) => [c.productId, c]))
  const owned = new Map((init.ownedItems ?? []).map((o) => [o.productId, o]))

  const slots: Slot[] = SLOT_ORDER.map((id) => {
    const spec = init.slots.find((s) => s.slot === id) ?? { slot: id, status: 'empty' as const }
    let item: Item | null = null
    if (spec.productId) {
      const src = byId.get(spec.productId) ?? owned.get(spec.productId)
      if (!src) throw new Error(`product not found: ${spec.productId}`)
      // 类目必须对得上：把「包」放进「鞋」位会让金额/到货/热点全部错位，而且没人会发现
      if (src.category !== id) {
        throw new PlanError(
          'CATEGORY_MISMATCH',
          `${src.title} 属于「${SLOT_LABEL[src.category]}」，不能放进「${SLOT_LABEL[id]}」搭配位`,
          '按商品真实类目重新提交 slots；不要为了凑满搭配而错位',
        )
      }
      item = snapshot(src, init.scene.today)
    }
    return {
      slot: id,
      status: spec.status,
      locked: false,
      reason: spec.reason,
      item,
    }
  })

  const plan: OutfitPlan = {
    planId: init.planId ?? `pln_${Math.random().toString(36).slice(2, 10)}`,
    revision: 0,
    label: init.label,
    scene: init.scene,
    constraints: {
      budget: init.budget,
      arrivalBy: { date: init.arrivalBy.date },
      shipTo: init.shipTo,
    },
    slots,
    cost: {
      currency: init.budget.currency,
      lines: [],
      newItemsTotal: { amount: 0, currency: init.budget.currency, status: 'confirmed' },
      budget: { limit: init.budget.limit, remaining: init.budget.limit, status: 'confirmed', verdict: 'within_budget', risky: false },
    },
    arrival: { verdict: 'unknown', earliest: null, latest: null, deadline: init.arrivalBy.date, blocking: [] },
    ops: [],
  }
  return freshPlan(plan)
}

export interface SwapArgs {
  slot: SlotId
  revision: number
  /** 用户从候选网格里明确指定时传入 */
  productId?: string
  /** 四个策略之一（productId 未传时生效） */
  strategy?: Strategy
  at?: string
  /** 生效偏好（可选；不传 = 与无偏好完全一致） */
  prefs?: PrefRecord[]
  /** task 作用域上下文（默认 taskKey = planId） */
  prefCtx?: PrefContext
}

export interface SwapResult {
  plan: OutfitPlan
  diff: PlanDiff
  candidates: Candidate[]
  /** 因偏好硬性要求被排除的商品（无偏好时为空数组） */
  excluded?: ExcludedItem[]
  /** 软规则因覆盖率过高被停用（如实标注；硬性排除不在此列） */
  relaxed?: string[]
  /** 硬性排除把候选排空时的原因（此时 candidates 为空，不放宽） */
  blockedBy?: string[]
  /** 实际生效的偏好规则（人话） */
  applied?: string[]
  /** 认不出、因此未参与计算的偏好原文 */
  unmapped?: Array<{ attr: string; value: string }>
}

/**
 * 换件：一次只允许改一个 slot。LLM 不在链路里 —— 检索、打分、重算、校验全是确定性代码。
 * 任何断言不过都会抛 PlanError，绝不落库一份改乱了的方案。
 */
export function applySwap(plan: OutfitPlan, catalog: CatalogItem[], args: SwapArgs): SwapResult {
  if (plan.revision !== args.revision) {
    throw new PlanError('STALE_REVISION', '方案已被更新，请刷新后再试')
  }
  const slot = plan.slots.find((s) => s.slot === args.slot)
  if (!slot) throw new PlanError('SLOT_NOT_FOUND', `没有这个搭配位：${args.slot}`)
  if (slot.status === 'owned') {
    throw new PlanError('OWNED_SLOT', `${SLOT_LABEL[args.slot]}是你已有的单品，不参与替换`)
  }
  if (slot.locked) throw new PlanError('SLOT_LOCKED', `${SLOT_LABEL[args.slot]}已锁定`)

  const ranked = rankCandidatesDetailed(plan, args.slot, catalog, args.strategy ?? 'similar', {
    prefs: args.prefs,
    prefCtx: args.prefCtx ?? { taskKey: plan.planId },
  })
  const candidates = ranked.candidates

  let pick: Candidate
  if (args.productId) {
    // 用户明确指定的商品：即使运费待确认也允许（知情选择），但金额与到货会如实降级
    const direct = candidates.find((c) => c.item.productId === args.productId)
    if (direct) {
      pick = direct
    } else {
      // 目录里查不到：允许回滚到「换件前那件」——商品可能已下架，但用户换回来是正当操作
      const prev = slot.previousItem && slot.previousItem.productId === args.productId ? slot.previousItem : null
      const item = catalog.find((c) => c.productId === args.productId) ?? prev
      if (!item) throw new PlanError('NO_CANDIDATE', '指定的商品不可用')
      if (item.category !== args.slot) {
        throw new PlanError('CATEGORY_MISMATCH', `${item.title}不属于「${SLOT_LABEL[args.slot]}」搭配位`)
      }
      const line = itemLine(item)
      const budgetLeft = plan.cost.budget.remaining
      // 用户明确指定时以用户为准；但若与偏好冲突，必须在理由里写出来（不静默违背偏好）
      const hits = prefExclusionHits(item, buildPrefRules(args.prefs ?? [], args.prefCtx ?? {}), args.slot)
      const preferenceNote = hits.length
        ? `注：这件与你的偏好冲突（${[...new Set(hits.map((h) => h.reason))].join('；')}），按你的指定保留`
        : null
      pick = {
        item,
        score: 0,
        whys: [
          prev && !catalog.some((c) => c.productId === args.productId)
            ? '换回换件前那件（该商品当前不在店铺目录里，链接与价格以商家页面为准）'
            : '按你的指定选择',
          ...(preferenceNote ? [preferenceNote] : []),
        ],
        withinBudget: line.amount <= budgetLeft,
        lineTotal: line.amount,
        overBy: Math.max(0, line.amount - budgetLeft),
        prefBonus: 0,
        prefWhys: [],
      }
    }
  } else {
    pick = candidates.find((c) => c.withinBudget)
      ?? candidates[0]
    if (!pick) {
      // F3：明确排除把候选排空时，如实说明挡在哪条要求上，不静默放宽
      throw new PlanError(
        'NO_CANDIDATE',
        ranked.blockedBy[0] ?? '没有满足条件的替代单品',
        ranked.blockedBy.length
          ? '明确排除不会自动放宽；可以改偏好、放宽其中一条，或手动指定一件商品'
          : undefined,
      )
    }
  }

  const next = clone(plan)
  const target = next.slots.find((s) => s.slot === args.slot)
  if (!target) throw new PlanError('SLOT_NOT_FOUND', 'unreachable')
  target.previousItem = target.item ? clone(target.item) : null
  target.item = snapshot(pick.item, next.scene.today)
  target.status = 'to_buy'
  target.reason = pick.whys.length > 0 ? pick.whys.join('，') : undefined

  next.cost = computeCost(next)
  next.arrival = computeArrival(next)

  const diff = diffPlan(plan, next)
  // Guard：这是整条链路的地基 —— 换一件绝不许牵动其他单品
  if (diff.changedSlots.length !== 1 || diff.changedSlots[0] !== args.slot) {
    throw new PlanError('GUARD_VIOLATION', `预期只改 ${SLOT_LABEL[args.slot]}，实际改动 ${diff.changedSlots.join('、')}`)
  }
  /**
   * 预算是硬约束，但「已经超预算」时不能把用户锁死：
   *  - 换完仍在预算外、且比原来更贵 → 拒绝（不让方案变差）
   *  - 换完仍在预算外、但确实更便宜 → 允许，并在文案里如实标注「仍超」
   *  - 换完进预算 → 正常通过
   * 之前这里是「只要没进预算就拒绝」，导致「把外套换便宜点」在超支方案上永远执行不了。
   */
  if (!args.productId) {
    const nextTotal = next.cost.newItemsTotal.amount
    const prevTotal = plan.cost.newItemsTotal.amount
    const stillOver = nextTotal > plan.constraints.budget.limit
    if (stillOver && nextTotal > prevTotal) {
      throw new PlanError(
        'NO_CANDIDATE',
        `会超出预算 $${nextTotal - plan.constraints.budget.limit}，已保留原方案`,
        `最接近的是 ${pick.item.title}（$${pick.lineTotal}），可调高预算或移除一件`,
      )
    }
    if (stillOver) {
      const gap = nextTotal - plan.constraints.budget.limit
      pick.whys.push(`换后仍超预算 $${gap}，但比原来省 $${prevTotal - nextTotal}`)
      target.reason = pick.whys.join('，')
    }
  }

  const op: PlanOp = {
    opId: nextOpId(),
    type: 'swap_item',
    slot: args.slot,
    from: plan.slots.find((s) => s.slot === args.slot)?.item?.productId ?? null,
    to: pick.item.productId,
    strategy: args.strategy,
    score: pick.score,
    at: args.at ?? new Date().toISOString(),
    note: pick.whys.join('、'),
  }
  next.ops = [...next.ops, op]
  next.revision = plan.revision + 1

  return {
    plan: next,
    diff: { ...diff, summary: summarize(diff, pick) },
    candidates,
    excluded: ranked.excluded,
    relaxed: ranked.relaxed,
    blockedBy: ranked.blockedBy,
    applied: ranked.applied,
    unmapped: ranked.unmapped,
  }
}

export function removeSlotItem(plan: OutfitPlan, slotId: SlotId, revision: number): { plan: OutfitPlan } {
  if (plan.revision !== revision) throw new PlanError('STALE_REVISION', '方案已被更新，请刷新后再试')
  const slot = plan.slots.find((s) => s.slot === slotId)
  if (!slot) throw new PlanError('SLOT_NOT_FOUND', '没有这个搭配位')
  if (slot.status === 'owned') throw new PlanError('OWNED_SLOT', '已有单品不能移除')
  const next = clone(plan)
  const target = next.slots.find((s) => s.slot === slotId)
  if (target) {
    target.item = null
    target.status = 'empty'
    target.reason = undefined
  }
  next.cost = computeCost(next)
  next.arrival = computeArrival(next)
  next.ops = [
    ...next.ops,
    { opId: nextOpId(), type: 'remove_item', slot: slotId, at: new Date().toISOString() },
  ]
  next.revision = plan.revision + 1
  return { plan: next }
}

export function setSlotLock(
  plan: OutfitPlan,
  slotId: SlotId,
  locked: boolean,
): { plan: OutfitPlan } {
  const slot = plan.slots.find((s) => s.slot === slotId)
  if (!slot) throw new PlanError('SLOT_NOT_FOUND', '没有这个搭配位')
  const next = clone(plan)
  const target = next.slots.find((s) => s.slot === slotId)
  if (target) target.locked = locked
  next.ops = [
    ...next.ops,
    { opId: nextOpId(), type: locked ? 'lock' : 'unlock', slot: slotId, at: new Date().toISOString() },
  ]
  next.revision = plan.revision + 1
  return { plan: next }
}

/** 对比两份方案：只有单品身份/状态变了才算 changedSlots，锁定不算。 */
export function diffPlan(a: OutfitPlan, b: OutfitPlan): PlanDiff {
  const changed: SlotId[] = []
  for (const id of SLOT_ORDER) {
    const sa = a.slots.find((s) => s.slot === id)
    const sb = b.slots.find((s) => s.slot === id)
    const key = (s?: Slot) => (s ? `${s.status}|${s.item?.productId ?? '-'}` : 'missing')
    if (key(sa) !== key(sb)) changed.push(id)
  }

  let swap: PlanDiff['swap']
  if (changed.length === 1) {
    const id = changed[0]
    const from = a.slots.find((s) => s.slot === id)?.item
    const to = b.slots.find((s) => s.slot === id)?.item
    // 价格差按"到手价行"比较（含运费），这才是用户感知的变化
    const fromLine = from ? itemLine(from).amount : 0
    const toLine = to ? itemLine(to).amount : 0
    swap = {
      slot: id,
      fromTitle: from?.title ?? null,
      toTitle: to?.title ?? null,
      priceDelta: to ? toLine - (from ? fromLine : 0) : null,
    }
  }

  return {
    changedSlots: changed,
    swap,
    costFrom: a.cost.newItemsTotal.amount,
    costTo: b.cost.newItemsTotal.amount,
    arrivalFrom: a.arrival.verdict,
    arrivalTo: b.arrival.verdict,
    budgetRemainingTo: b.cost.budget.remaining,
    budgetStatusTo: b.cost.budget.status,
    summary: '',
  }
}

/** 换件反馈：一句话讲清三件连带变化（换成了什么 / 预算 / 到货），这是评测断言的 UI 侧证据。 */
export function summarize(diff: PlanDiff, pick: Candidate): string {
  const parts: string[] = []
  if (diff.swap) {
    const delta = diff.swap.priceDelta
    const priceText = delta === null ? '' : delta === 0 ? '价格不变' : `${delta > 0 ? '+' : '-'}$${Math.abs(delta)}`
    parts.push(`已把「${SLOT_LABEL[diff.swap.slot]}」换成 ${diff.swap.toTitle}${priceText ? `，${priceText}` : ''}`)
  }
  const budget = diff.budgetRemainingTo
  const budgetStatus: Status = diff.budgetStatusTo
  parts.push(
    budget >= 0
      ? `预算还剩 $${budget}（${STATUS_LABEL[budgetStatus]}）`
      : `已超预算 $${Math.abs(budget)}（${STATUS_LABEL[budgetStatus]}）`,
  )
  parts.push(`到货判断：${ARRIVAL_LABEL[diff.arrivalTo]}`)
  parts.push('其他单品未改动')
  const whys = pick.whys.length > 0 ? `；推荐理由：${pick.whys.join('、')}` : ''
  return `${parts.join('；')}${whys}`
}

export const ARRIVAL_LABEL_REF = ARRIVAL_LABEL

/* ==========================================================================
 * 约束调整 / 复制方案 / 一键回到预算内
 *
 * 这三个操作都不经过模型：页面点一下就得到确定性结果，
 * 且每一次换件仍然走 applySwap（单点改动 + changedSlots 断言），不会重写整份方案。
 * ========================================================================== */

export interface ConstraintPatch {
  budgetLimit?: number
  arrivalBy?: string
  shipTo?: string
}

/** 改预算 / 最晚到货日 / 收货地：只重算派生金额与到货，不动任何单品。 */
export function updateConstraints(plan: OutfitPlan, patch: ConstraintPatch): { plan: OutfitPlan } {
  const next = clone(plan)
  const notes: string[] = []
  if (typeof patch.budgetLimit === 'number') {
    if (!Number.isFinite(patch.budgetLimit) || patch.budgetLimit < 0) {
      throw new PlanError('GUARD_VIOLATION', '预算必须是不小于 0 的数字')
    }
    if (patch.budgetLimit !== plan.constraints.budget.limit) {
      notes.push(`预算 $${plan.constraints.budget.limit} → $${patch.budgetLimit}`)
      next.constraints.budget.limit = patch.budgetLimit
    }
  }
  if (patch.arrivalBy && /^\d{4}-\d{2}-\d{2}$/.test(patch.arrivalBy)) {
    if (patch.arrivalBy !== plan.constraints.arrivalBy.date) {
      notes.push(`最晚到货 ${plan.constraints.arrivalBy.date} → ${patch.arrivalBy}`)
      next.constraints.arrivalBy = { date: patch.arrivalBy }
    }
  }
  if (patch.shipTo && patch.shipTo !== plan.constraints.shipTo) {
    notes.push(`收货地 ${plan.constraints.shipTo} → ${patch.shipTo}`)
    next.constraints.shipTo = patch.shipTo
  }
  if (notes.length === 0) return { plan }

  next.cost = computeCost(next)
  next.arrival = computeArrival(next)
  next.ops = [
    ...next.ops,
    {
      opId: nextOpId(),
      type: 'update_constraints',
      slot: null,
      at: new Date().toISOString(),
      note: notes.join('；'),
    },
  ]
  next.revision = plan.revision + 1
  return { plan: next }
}

/** 另存为新方案：深拷贝 + 新 ID，历史清空但单品与金额保持一致。 */
export function duplicatePlan(plan: OutfitPlan, planId: string, label?: string): OutfitPlan {
  const next = clone(plan)
  next.planId = planId
  next.label = label ?? `${plan.label} · 副本`
  next.revision = 0
  next.ops = []
  return next
}

export interface FitChange {
  slot: SlotId
  slotLabel: string
  fromTitle: string
  toTitle: string
  priceDelta: number
}

export interface FitResult {
  plan: OutfitPlan
  ok: boolean
  changes: FitChange[]
  /** 说明为什么没能回到预算内（ok=true 时为空） */
  reason: string
}

/**
 * 「调整至预算内」：确定性贪心 —— 从最贵的待买位开始，逐个换成更便宜的候选，
 * 每换一件都校验 changedSlots 恰好 1，直到总额进预算或没有可换的了。
 * 换不动就如实说明，绝不把估算说成已经达标，也不动已锁定/已拥有的位置。
 */
export function fitBudget(plan: OutfitPlan, catalog: CatalogItem[]): FitResult {
  let current = plan
  const changes: FitChange[] = []
  const overBy = () => current.cost.newItemsTotal.amount - current.constraints.budget.limit

  if (overBy() <= 0) return { plan, ok: true, changes, reason: '' }

  const order = current.slots
    .filter((s) => s.status === 'to_buy' && s.item && !s.locked)
    .map((s) => ({ slot: s.slot, line: itemLine(s.item as Item).amount }))
    .sort((a, b) => b.line - a.line)

  for (const { slot } of order) {
    if (overBy() <= 0) break
    const target = current.slots.find((s) => s.slot === slot)
    if (!target?.item) continue
    const currentLine = itemLine(target.item).amount
    const pool = rankCandidates(current, slot, catalog, 'cheaper', { includeUnconfirmed: false })
      .filter((c) => c.lineTotal < currentLine)
      .sort((a, b) => a.lineTotal - b.lineTotal)
    if (pool.length === 0) continue
    // 优先挑「换完立刻进预算」的那一件；都进不去就取最便宜的，至少把差额压低
    const pick = pool.find((c) => overBy() - currentLine + c.lineTotal <= 0) ?? pool[0]
    const res = applySwap(current, catalog, { slot, revision: current.revision, productId: pick.item.productId })
    changes.push({
      slot,
      slotLabel: SLOT_LABEL[slot],
      fromTitle: target.item.title,
      toTitle: pick.item.title,
      priceDelta: pick.lineTotal - currentLine,
    })
    current = res.plan
  }

  const left = overBy()
  if (left > 0) {
    const freezable = current.slots.filter((s) => s.status === 'to_buy' && s.item && s.locked).length
    return {
      plan: current,
      ok: false,
      changes,
      reason:
        `已把 ${changes.length} 个可换的搭配位换成更便宜的选项，仍超 $${left}` +
        (freezable ? `（有 ${freezable} 个位置已锁定，未参与调整）` : '') +
        '；可以调高预算、解除锁定或移除一件单品。',
    }
  }
  return { plan: current, ok: true, changes, reason: '' }
}

