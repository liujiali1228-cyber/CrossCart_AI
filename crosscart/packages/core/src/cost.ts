/**
 * 图像调用计费与预算：纯函数，零 IO、注入时钟，方便单测。
 *
 * 原则（和金额一样诚实）：
 *  - 有 usage 就按 token 算「估算」，没有就按尺寸/质量档位估，并在记录里写清来源；
 *  - 估价永远标 `estimated`，不许当账单；缓存命中记 0；
 *  - 预算只约束**付费调用**，不影响看图/选品/对话。
 */
export type CallKind = 'scene-new' | 'scene-swap' | 'scene-scene' | 'hotspot-vision' | 'other'
export type CostBasis = 'usage' | 'price-table' | 'cache-hit' | 'unknown'

export interface CostEstimate {
  amount: number | null
  currency: 'USD'
  status: 'estimated' | 'unavailable'
  basis: CostBasis
  note: string
}

/**
 * 价格表（USD）。这些是**本项目的实测/参考单价**，不是 OpenAI 官方账单：
 *  gpt-image 系列按输出图数量与质量档计费，这里用实测均值，够做预算约束。
 * 单位：每张图。
 */
export const PRICE_TABLE: Record<string, { quality: Record<string, number>; default: number }> = {
  'gpt-image': { quality: { low: 0.011, medium: 0.042, high: 0.167 }, default: 0.042 },
  'gpt-image-2': { quality: { low: 0.012, medium: 0.048, high: 0.17 }, default: 0.048 },
  default: { quality: { low: 0.015, medium: 0.05, high: 0.17 }, default: 0.05 },
}

/** 不同操作的经验系数：换件/换场景是 edits，输入图更多，单价略高于纯生成。 */
const KIND_FACTOR: Record<CallKind, number> = {
  'scene-new': 1,
  'scene-swap': 0.85,
  'scene-scene': 0.8,
  'hotspot-vision': 0.05,
  other: 1,
}

/**
 * 只给「认识前缀」的模型估价。认不出的模型返回 null → 界面显示「费用待确认」，
 * 而不是拿一个通用价硬套出看起来精确的假数字。
 */
function priceFor(model: string, quality: string): number | null {
  const m = model.toLowerCase()
  const key = Object.keys(PRICE_TABLE)
    .filter((k) => k !== 'default')
    .sort((a, b) => b.length - a.length)
    .find((k) => m.includes(k))
  if (!key) return null
  const table = PRICE_TABLE[key]
  const q = table.quality[quality] ?? table.default
  return Number.isFinite(q) ? q : null
}

/** 生成前的估价：能给出数字就给，给不出就如实 unavailable。 */
export function estimateCost(opts: { model?: string; quality?: string; kind?: CallKind; cached?: boolean }): CostEstimate {
  if (opts.cached) {
    return { amount: 0, currency: 'USD', status: 'estimated', basis: 'cache-hit', note: '命中缓存，不产生费用' }
  }
  const model = opts.model ?? ''
  const quality = opts.quality ?? 'medium'
  const unit = priceFor(model, quality)
  if (unit == null) {
    return { amount: null, currency: 'USD', status: 'unavailable', basis: 'unknown', note: '这个模型没有可用单价，费用待确认' }
  }
  const factor = KIND_FACTOR[opts.kind ?? 'scene-new'] ?? 1
  return {
    amount: Number((unit * factor).toFixed(3)),
    currency: 'USD',
    status: 'estimated',
    basis: 'price-table',
    note: `按 ${model || '默认模型'} / ${quality} 档估算（每张约 $${unit}），实际以服务商账单为准`,
  }
}

export interface UsageLike {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { image_tokens?: number; text_tokens?: number }
  total_tokens?: number
}

/**
 * 用 API 返回的 usage 反推花费。图像 API 的 usage 只给 token 数，没有单价时
 * 明确返回 unknown —— 不拿别处的单价硬套，避免「看起来很精确」的假数字。
 *
 * 下限规则（真实踩过）：实测一次 medium 生成是 input 9k + output 1.1k tokens，
 * 若按 output/4200 线性折算只有 $0.024，而档位单价是 $0.048 —— 低报一半会让
 * 月度预算闸门失守。所以拿「档位单价」当下限，token 明显超出时才按比例上浮。
 */
export function costFromUsage(usage: UsageLike | null | undefined, opts: { model?: string; quality?: string }): CostEstimate {
  if (!usage || (!usage.output_tokens && !usage.input_tokens && !usage.total_tokens)) {
    return estimateCost({ model: opts.model, quality: opts.quality })
  }
  const unit = priceFor(opts.model ?? '', opts.quality ?? 'medium')
  if (unit == null) {
    return { amount: null, currency: 'USD', status: 'unavailable', basis: 'unknown', note: '有 usage 但没有单价，费用待确认' }
  }
  const output = usage.output_tokens ?? 0
  // 4200 输出 token ≈ 一次 medium 生成；只有明显更多时才上浮，且最多 2 倍
  const scale = output > 0 ? Math.min(2, Math.max(1, output / 4200)) : 1
  return {
    amount: Number((unit * scale).toFixed(3)),
    currency: 'USD',
    status: 'estimated',
    basis: 'usage',
    note: `按 usage（输入 ${usage.input_tokens ?? '?'} / 输出 ${output || '?'} tokens）折算，且不低于档位单价；实际以服务商账单为准`,
  }
}

export interface BudgetConfig {
  limit: number
  currency: 'USD'
}

export interface SpendRecord {
  at: string
  month: string
  kind: CallKind
  amount: number
  currency: 'USD'
  basis: CostBasis
  model: string | null
  ok: boolean
  cached: boolean
}

export interface BudgetStatus {
  month: string
  limit: number
  spent: number
  remaining: number
  currency: 'USD'
  /** 已用比例 0–1+ */
  ratio: number
  level: 'ok' | 'warn' | 'blocked'
  note: string
}

export const DEFAULT_MONTHLY_BUDGET = 8

export function monthOf(iso: string): string {
  return String(iso).slice(0, 7)
}

/** 月度预算状态：80% 预警，100% 阻止新的付费任务。 */
export function budgetStatus(records: SpendRecord[], cfg: BudgetConfig, nowIso: string): BudgetStatus {
  const month = monthOf(nowIso)
  const spent = records
    .filter((r) => r.month === month && !r.cached)
    .reduce((sum, r) => sum + (Number.isFinite(r.amount) ? r.amount : 0), 0)
  const limit = cfg.limit
  const remaining = Math.max(0, limit - spent)
  const ratio = limit > 0 ? spent / limit : 1
  const level = ratio >= 1 ? 'blocked' : ratio >= 0.8 ? 'warn' : 'ok'
  return {
    month,
    limit,
    spent: Number(spent.toFixed(3)),
    remaining: Number(remaining.toFixed(3)),
    currency: cfg.currency,
    ratio: Number(ratio.toFixed(3)),
    level,
    note:
      level === 'blocked'
        ? `本月图像预算已用完（$${spent.toFixed(2)} / $${limit}），新的付费生成被阻止；已有图片与选品不受影响`
        : level === 'warn'
          ? `本月图像预算快用完了（$${spent.toFixed(2)} / $${limit}），建议只生成必要的场景`
          : `本月已用 $${spent.toFixed(2)} / $${limit}`,
  }
}

/** 能否再花这笔钱：预算不可用（估价未知）时放行但要求用户确认，不静默扣费。 */
export function canAfford(status: BudgetStatus, estimate: CostEstimate): boolean {
  if (estimate.basis === 'cache-hit') return true
  if (estimate.amount == null) return status.level !== 'blocked'
  return status.spent + estimate.amount <= status.limit + 1e-9
}
