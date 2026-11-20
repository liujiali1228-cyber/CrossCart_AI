import type { CatalogItem, Item, OutfitPlan, SlotId } from './types.js'
import { itemLine, addDays, daysBetween } from './pricing.js'
import { buyInfo } from './purchase.js'
import type { PrefContext, PrefRecord } from './prefs.js'
import {
  buildPrefRules,
  isEmptyRules,
  prefBonusFor,
  prefCoverage,
  prefExclusionHits,
  type PrefRules,
} from './pref-match.js'

export type Strategy = 'lighter' | 'similar' | 'cheaper' | 'faster'

export const STRATEGY_LABEL: Record<Strategy, string> = {
  lighter: '换成浅色',
  similar: '换相似款',
  cheaper: '找更便宜的',
  faster: '找更快到的',
}

export interface Candidate {
  item: CatalogItem
  score: number
  whys: string[]
  withinBudget: boolean
  lineTotal: number
  overBy: number
  /** 偏好带来的加分（0 = 没有命中任何软偏好）；含在 score 里 */
  prefBonus: number
  /** 加分依据，逐条可复核 */
  prefWhys: string[]
}

/** 因偏好硬性要求被移出候选池的商品（附带可读原因）。 */
export interface ExcludedItem {
  productId: string
  title: string
  vendor: string | null
  reasons: string[]
}

export interface RankOptions {
  /** 手动挑一件时传 true：允许把「运费/时效待确认」的商品列出来（用户知情选择） */
  includeUnconfirmed?: boolean
  /** 生效偏好（原样传入，本层自己用 resolveAttr 裁决；未确认/过期的进不来） */
  prefs?: PrefRecord[]
  /** task 作用域判定上下文（taskKey = planId） */
  prefCtx?: PrefContext
}

export interface RankResult {
  candidates: Candidate[]
  /** 被偏好排除的商品；没有偏好时恒为空 */
  excluded: ExcludedItem[]
  /** 因为「覆盖率过高没有区分度」而停用的软规则（硬性排除不在此列） */
  relaxed: string[]
  /**
   * 硬性排除后没有候选时，说明被哪几条明确要求挡住了。
   * F3 起明确排除（避开品牌/尺码/避开词）不再静默放宽 —— 宁可返回空，让用户自己决定。
   */
  blockedBy: string[]
  /** 实际生效的规则（人话，用于解释与报告） */
  applied: string[]
  /** 认不出、因此未参与计算的偏好原文（不假装已按这些筛选） */
  unmapped: Array<{ attr: string; value: string }>
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  return inter / (sa.size + sb.size - inter)
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function etaScore(item: Item, plan: OutfitPlan): number {
  if (item.shipping.status === 'unavailable') return 0.25
  if (!item.shipping.etaDays) return 0.25
  const latest = addDays(plan.scene.today, item.shipping.etaDays[1])
  const late = daysBetween(plan.constraints.arrivalBy.date, latest)
  if (late <= 0) return 1
  if (late <= 3) return 0.5
  return 0
}

/** 规则 → 人话（只用于解释与报告，不参与计算）。 */
function describeRules(rules: PrefRules, skip: Array<'palette' | 'style' | 'brand'> = []): string[] {
  const out: string[] = []
  if (rules.palette && !skip.includes('palette')) out.push(`颜色偏好：${rules.palette.join('/')} +0.05`)
  if (rules.styles && !skip.includes('style')) out.push(`风格偏好：${rules.styles.join('/')} +0.03`)
  if (rules.brandPrefer && !skip.includes('brand')) out.push(`偏好品牌：${rules.brandPrefer.join('/')} +0.02`)
  if (rules.brandAvoid) out.push(`避开品牌：${rules.brandAvoid.join('/')}（硬排除）`)
  if (rules.avoid) out.push(`避开关键词：${rules.avoid.join('、')}（硬排除）`)
  for (const [slot, size] of Object.entries(rules.sizes)) out.push(`尺码 ${slot}=${size}（硬排除）`)
  return out
}

/**
 * 候选打分：换件策略映射到确定的检索参数，不让模型自由发挥。
 * 权重：策略匹配 0.40 + 到货达标 0.25 + 价格适配 0.20 + 风格契合 0.15
 * 偏好只做两件事：pool 阶段硬排除，打分阶段最多 +0.10（见 PREF_WEIGHTS）。
 *
 * 默认排除 shipping 不可确认的候选 —— 策略推荐的目的是"能落地"，
 * 推一件到最后连到货都判断不了的商品，等于把问题丢回给用户。
 */
export function rankCandidatesDetailed(
  plan: OutfitPlan,
  slotId: SlotId,
  catalog: CatalogItem[],
  strategy: Strategy,
  opts: RankOptions = {},
): RankResult {
  const slot = plan.slots.find((s) => s.slot === slotId)
  if (!slot) throw new Error(`slot not found: ${slotId}`)
  const current = slot.item
  const limit = plan.constraints.budget.limit

  // 换上该候选后不超预算的硬上限：预算 - 其他待买单品的已知总额
  const othersTotal = plan.slots
    .filter((s) => s.status === 'to_buy' && s.item && s.slot !== slotId)
    .reduce((acc, s) => acc + itemLine(s.item as Item).amount, 0)
  const budgetLeft = limit - othersTotal

  const currentLine = current ? itemLine(current) : null

  const pool = catalog.filter(
    (c) =>
      c.category === slotId &&
      c.productId !== current?.productId &&
      c.sizes.length > 0 &&
      (opts.includeUnconfirmed || c.shipping.status !== 'unavailable'),
  )

  // 有「真实可下单」候选时，不把演示数据推给用户。
  // 演示件既没有商家详情页、也不该占用预算；只要本类目还有真实候选，就只在真实候选里选。
  // （没有真实候选的类目仍然回退到演示数据，界面与 AI 都会标明「无购买链接」。）
  const buyablePool = pool.filter((c) => buyInfo(c, 'to_buy').state === 'buyable')
  const effectivePool = buyablePool.length > 0 ? buyablePool : pool

  // —— 硬层：只作用于「最终候选池」，被排除的商品绝不进入候选、也不参与加分 ——
  const rules = buildPrefRules(opts.prefs ?? [], opts.prefCtx ?? {})
  const hasPrefs = !isEmptyRules(rules)
  const relaxed: string[] = []
  const blockedBy: string[] = []
  let excludedList: ExcludedItem[] = []
  let eligible = effectivePool

  if (hasPrefs && effectivePool.length > 0) {
    const perItem = effectivePool.map((c) => ({ item: c, hits: prefExclusionHits(c, rules, slotId) }))

    // F3：明确排除（避开品牌 / 避开词 / 尺码）是用户的硬要求，不再「排空了就悄悄放宽」。
    // 全都排掉时返回空候选 + 原因，由用户决定是换一件还是改偏好。
    const kept: CatalogItem[] = []
    const excluded: ExcludedItem[] = []
    for (const { item, hits } of perItem) {
      if (hits.length === 0) {
        kept.push(item)
      } else {
        excluded.push({
          productId: item.productId,
          title: item.title,
          vendor: item.vendor ?? null,
          reasons: [...new Set(hits.map((h) => h.reason))],
        })
      }
    }

    if (kept.length === 0) {
      const reasons = [...new Set(excluded.flatMap((x) => x.reasons))]
      blockedBy.push(
        `本类目 ${effectivePool.length} 件候选都不符合你的明确要求（${reasons.join('；')}），` +
          '没有可推荐的替代品 —— 需要放宽其中一条才能继续',
      )
      return {
        candidates: [],
        excluded,
        relaxed,
        blockedBy,
        applied: describeRules(rules),
        unmapped: rules.unmapped,
      }
    }
    eligible = kept
    excludedList = excluded
  }

  // 先把「不含偏好」的基础分算出来：一是保证无偏好时结果逐位不变，
  // 二是给 cheaper 策略一个价格基准（偏好不许把比它更贵的商品顶上来）。
  const drafts = eligible.map((c) => {
    const line = itemLine(c)
    const withinBudget = line.amount <= budgetLeft

    // —— 策略分 0.40 ——
    let strategyScore = 0.5
    const whys: string[] = []
    if (strategy === 'lighter') {
      strategyScore = c.colorFamily === 'light' ? 1 : c.colorFamily === 'mid' ? 0.5 : 0
      if (c.colorFamily === 'light') whys.push('浅色系')
    } else if (strategy === 'similar' && current) {
      strategyScore = c.color === current.color ? 1 : c.colorFamily === current.colorFamily ? 0.6 : 0
      if (c.color === current.color) whys.push('同色系')
    } else if (strategy === 'cheaper' && currentLine) {
      strategyScore = clamp01((currentLine.amount - line.amount) / Math.max(currentLine.amount, 1))
      if (line.amount < currentLine.amount) whys.push(`省 $${currentLine.amount - line.amount}`)
    } else if (strategy === 'faster') {
      const s = etaScore(c, plan)
      strategyScore = s
      if (s >= 1) whys.push('可按时到')
    }

    // —— 到货 0.25 / 价格 0.20 / 风格 0.15 ——
    const eta = etaScore(c, plan)
    const price = withinBudget ? clamp01(1 - line.amount / Math.max(budgetLeft, 1)) : 0
    const style = current
      ? jaccard(current.style, c.style)
      : jaccard(['walking', 'photo', 'minimal'], c.style)

    const base = Number((strategyScore * 0.4 + eta * 0.25 + price * 0.2 + style * 0.15).toFixed(3))
    return { c, line, withinBudget, base, whys }
  })

  // cheaper 策略的价格基准 = 无偏好时的最优到手价。比它还贵，偏好一分都不给。
  let cheaperCap: number | null = null
  if (strategy === 'cheaper' && drafts.length) {
    const baseTop = drafts.reduce((best, d) => (d.base > best.base ? d : best), drafts[0])
    cheaperCap = baseTop.line.amount
  }

  // 覆盖率过高的软规则停用：真实目录里 minimal 覆盖 93%，给分等于「人人 +0.03」，
  // 顺序不变却让人以为个性化生效 —— 这类规则如实标注，不用来排序。
  const skip: Array<'palette' | 'style' | 'brand'> = []
  const KIND_LABEL = { palette: '颜色偏好', style: '风格偏好', brand: '偏好品牌' } as const
  if (hasPrefs) {
    const cov = prefCoverage(eligible, rules)
    for (const kind of ['palette', 'style', 'brand'] as const) {
      const c = cov[kind]
      if (c.total >= 5 && c.ratio >= 0.8) {
        skip.push(kind)
        relaxed.push(`${KIND_LABEL[kind]}：${c.hits}/${c.total} 件候选都符合，没有区分度，不用于排序`)
      }
    }
  }
  const applied = hasPrefs ? describeRules(rules, skip) : []

  const candidates: Candidate[] = drafts.map(({ c, line, withinBudget, base, whys }) => {
    // —— 软偏好 0 ~ 0.10 ——
    const pref = hasPrefs ? prefBonusFor(c, rules, skip) : { bonus: 0, whys: [] }
    let prefBonus = pref.bonus
    let prefWhys = pref.whys
    if (prefBonus > 0 && strategy === 'cheaper' && currentLine && line.amount >= currentLine.amount) {
      // 省钱策略下，审美偏好不得把「比当前这件还贵/同价」的商品抬上来
      prefBonus = 0
      prefWhys = ['省钱优先：这件没有比现在更便宜，不因颜色/风格偏好加分']
    } else if (prefBonus > 0 && cheaperCap != null && line.amount > cheaperCap) {
      // 比「无偏好时的最优到手价」更贵 → 偏好不能把它顶到更便宜的前面
      prefBonus = 0
      prefWhys = [`省钱优先：到手价 $${line.amount} 高于无偏好最优 $${cheaperCap}，不因审美偏好加分`]
    }

    const score = Number((base + prefBonus).toFixed(3))

    return {
      item: c,
      score,
      whys,
      withinBudget,
      lineTotal: line.amount,
      overBy: Math.max(0, line.amount - budgetLeft),
      prefBonus,
      prefWhys,
    }
  })

  const sorted = candidates.sort((a, b) => b.score - a.score)

  // 策略无法满足时如实说明，而不是硬凑一个不像的候选
  const best = sorted[0]
  if (best) {
    if (strategy === 'lighter' && best.item.colorFamily !== 'light') {
      best.whys.unshift('暂无浅色可选，已放宽为最接近款')
    }
    if (strategy === 'cheaper' && currentLine && best.lineTotal >= currentLine.amount) {
      best.whys.unshift('没有更便宜的替代，已按最接近推荐')
    }
    if (strategy === 'faster' && etaScore(best.item, plan) < 1) {
      best.whys.unshift('暂无可按时到的替代')
    }
  }
  return { candidates: sorted, excluded: excludedList, relaxed, blockedBy, applied, unmapped: rules.unmapped }
}

/** 兼容原接口：只要候选列表（内部仍走同一套偏好逻辑）。 */
export function rankCandidates(
  plan: OutfitPlan,
  slotId: SlotId,
  catalog: CatalogItem[],
  strategy: Strategy,
  opts: RankOptions = {},
): Candidate[] {
  return rankCandidatesDetailed(plan, slotId, catalog, strategy, opts).candidates
}

/**
 * 建方案路径的偏好冲突检查（F2 要求 5，F4 升级为可阻断）。
 *
 * 只做确定性判断：命中 `prefExclusionHits`（尺码 / 避开品牌 / 避开词）才算冲突。
 * 软偏好（颜色 / 风格 / 偏好品牌）永远不阻断 —— 它们只影响排序。
 */
export interface PlanPrefConflict {
  slot: SlotId
  productId: string
  title: string
  /** 人类可读原因（原文照抄，直接给用户看） */
  reasons: string[]
  /** 命中的规则 ID：size_shoes / brand_avoid / avoid —— 用来判断这条冲突是否被用户本轮明确豁免 */
  rules: string[]
}

/**
 * 建方案前置校验：偏好硬冲突 + 可信度不足的约束（预算 / 到货 / 收货地）。
 *
 * 返回值区分三态，避免「没检查」被说成「检查通过」：
 *  - ok        有可靠数据且满足
 *  - violated  有可靠数据且违反
 *  - unverified 数据不足 / 无法确定性判断（不得当作通过）
 */
export type PlanCheckStatus = 'ok' | 'violated' | 'unverified'

export interface PlanConstraintCheck {
  id: 'budget' | 'arrival' | 'shipTo' | 'freetext'
  status: PlanCheckStatus
  /** 人话结论，直接进 UI / AI 回复 */
  detail: string
}

export interface PlanValidation {
  /** 硬冲突（未被豁免）；非空时调用方必须拒绝提交 */
  violations: PlanPrefConflict[]
  /** 被用户本轮明确授权破例的冲突（仍会展示，便于复核） */
  exempt: PlanPrefConflict[]
  /** 实际参与校验的硬规则（人话） */
  applied: string[]
  /** 认不出、无法确定性校验的偏好原文 */
  unmapped: Array<{ attr: string; value: string }>
  /** 预算 / 到货 / 收货地 / 自由文本的可信度结论 */
  checks: PlanConstraintCheck[]
}

export function checkPlanPrefConflicts(
  slots: Array<{ slot: SlotId; item: Item | null }>,
  prefs: PrefRecord[],
  ctx: PrefContext = {},
  opts: { allowRules?: string[] } = {},
): { conflicts: PlanPrefConflict[]; exempt: PlanPrefConflict[]; applied: string[]; unmapped: Array<{ attr: string; value: string }> } {
  const allow = new Set(opts.allowRules ?? [])
  const rules = buildPrefRules(prefs, ctx)
  if (isEmptyRules(rules)) return { conflicts: [], exempt: [], applied: [], unmapped: rules.unmapped }
  const conflicts: PlanPrefConflict[] = []
  const exempt: PlanPrefConflict[] = []
  for (const s of slots) {
    if (!s.item) continue
    const hits = prefExclusionHits(s.item, rules, s.slot)
    if (!hits.length) continue
    const hitRules = [...new Set(hits.map((h) => h.rule))]
    // 只有「全部命中规则都被明确豁免」才算破例；剩一条没豁免仍然阻断。
    // 阻断条目只列**没被豁免**的规则与原因 —— 否则调用方会以为授权没生效。
    const blocking = hits.filter((h) => !allow.has(h.rule))
    const entry: PlanPrefConflict = {
      slot: s.slot,
      productId: s.item.productId,
      title: s.item.title,
      reasons: [...new Set(hits.map((h) => h.reason))],
      rules: hitRules,
    }
    if (blocking.length === 0) {
      exempt.push(entry)
    } else {
      conflicts.push({
        ...entry,
        reasons: [...new Set(blocking.map((h) => h.reason))],
        rules: [...new Set(blocking.map((h) => h.rule))],
      })
    }
  }
  return { conflicts, exempt, applied: describeRules(rules), unmapped: rules.unmapped }
}

/**
 * 建方案前的完整校验（F4 A1）。
 *
 * `plan` 只需要已经算过成本与到货的部分（`freshPlan` 之后），不需要落库。
 * 预算 / 到货的「三态」判断严格按已有数据：运费或关税不可用时不给 ok，
 * 因为那时总额本身就不是确认值。
 */
export function validatePlanAgainstPrefs(
  plan: {
    slots: Array<{ slot: SlotId; item: Item | null }>
    cost: OutfitPlan['cost']
    arrival: OutfitPlan['arrival']
    constraints: { shipTo: string }
  },
  prefs: PrefRecord[],
  ctx: PrefContext = {},
  opts: { allowRules?: string[]; supportedShipTo?: string[] } = {},
): PlanValidation {
  const pref = checkPlanPrefConflicts(plan.slots, prefs, ctx, opts)
  const checks: PlanConstraintCheck[] = []

  const b = plan.cost.budget
  if (b.verdict === 'over_budget') {
    checks.push({
      id: 'budget',
      status: 'violated',
      detail: `新增支出 $${plan.cost.newItemsTotal.amount} 超过预算 $${b.limit}（超 $${Math.abs(b.remaining)}）`,
    })
  } else if (b.risky || plan.cost.newItemsTotal.status !== 'confirmed') {
    checks.push({
      id: 'budget',
      status: 'unverified',
      detail: `预算结论只能算估算：运费或关税尚未确认，实际新增支出可能高于当前 $${plan.cost.newItemsTotal.amount}`,
    })
  } else {
    checks.push({ id: 'budget', status: 'ok', detail: `新增支出 $${plan.cost.newItemsTotal.amount}，预算 $${b.limit}` })
  }

  const a = plan.arrival
  if (a.verdict === 'late') {
    checks.push({ id: 'arrival', status: 'violated', detail: `按当前物流无法在 ${a.deadline} 前到货` })
  } else if (a.verdict === 'unknown') {
    checks.push({
      id: 'arrival',
      status: 'unverified',
      detail: '缺到货时间数据，无法确认能否在截止日前送达',
    })
  } else if (a.verdict === 'at_risk') {
    checks.push({
      id: 'arrival',
      status: 'unverified',
      detail: `到货时间接近截止日（最晚 ${a.latest ?? '未知'}，截止 ${a.deadline}），存在延误风险`,
    })
  } else {
    checks.push({ id: 'arrival', status: 'ok', detail: `最晚 ${a.latest ?? a.deadline} 到货，满足 ${a.deadline} 截止` })
  }

  const supported = opts.supportedShipTo
  if (supported && supported.length) {
    if (supported.includes(plan.constraints.shipTo)) {
      checks.push({ id: 'shipTo', status: 'ok', detail: `收货地 ${plan.constraints.shipTo}` })
    } else {
      checks.push({
        id: 'shipTo',
        status: 'unverified',
        detail: `收货地 ${plan.constraints.shipTo} 不在已验证的配送范围内（${supported.join(' / ')}），运费与到货可能不准`,
      })
    }
  } else if (plan.constraints.shipTo === 'CN') {
    // 种子/实时运费规则只覆盖「美国店铺 → 中国」这一条链路；CN 是唯一有依据的结论
    checks.push({ id: 'shipTo', status: 'ok', detail: '收货地 CN（运费与时效按美国店铺→中国规则估算）' })
  } else {
    checks.push({
      id: 'shipTo',
      status: 'unverified',
      detail: `没有 ${plan.constraints.shipTo} 的运费与时效数据（现有规则只覆盖美国→中国），无法确认可配送性`,
    })
  }

  if (pref.unmapped.length) {
    checks.push({
      id: 'freetext',
      status: 'unverified',
      detail: `这些偏好无法自动匹配商品、未参与校验：${pref.unmapped.map((u) => u.value).join('、')}`,
    })
  }

  return {
    violations: pref.conflicts,
    exempt: pref.exempt,
    applied: pref.applied,
    unmapped: pref.unmapped,
    checks,
  }
}
