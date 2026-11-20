/**
 * 偏好 → 确定性匹配规则（Phase 5 F2）。
 *
 * 这一层的唯一职责：把「用户写的偏好值」翻译成**可以逐项复核**的匹配规则，
 * 而不是让模型在选品时自由发挥。两条纪律：
 *
 *  1. 认不出来就不认。自由文本里无法可靠映射的部分放进 `unmapped`，
 *     既不参与硬过滤，也不参与加分 —— 绝不假装「已经按你说的筛过了」。
 *  2. 只用生效偏好。所有读取都走 `resolveAttr`（confirmed + 当前 taskKey），
 *     未确认 / 已删除 / 被取代 / 跨方案失效的记录到这里已经被挡掉。
 *
 * 匹配能力受商品标签限制（真实目录只有 4 家店、11 个 style 标签），
 * 所以这里刻意只做「字符串级」判断：不做同义词推断、不做语义相似度。
 */
import type { ColorFamily, Item, SlotId } from './types.js'
import { resolveAttr, type PrefContext, type PrefRecord } from './prefs.js'

/** 颜色家族的中英文说法。命中多个时全部保留（用户可能写「黑、白」）。 */
const PALETTE_WORDS: Array<[ColorFamily, string[]]> = [
  ['light', ['light', 'white', 'ivory', 'cream', 'beige', '浅色', '浅', '白', '米白', '米色', '奶油', '米']],
  ['dark', ['dark', 'black', 'charcoal', 'navy', '深色', '深', '黑', '墨黑', '墨', '暗', '藏青']],
  ['mid', ['mid', 'grey', 'gray', 'taupe', 'camel', '中性', '中间色', '灰', '驼', '卡其']],
]

/** 商品 style 标签的中英文说法（只映射真实目录里存在的标签）。 */
const STYLE_WORDS: Array<[string, string[]]> = [
  ['minimal', ['minimal', 'minimalist', '极简', '简约', '性冷淡', 'clean']],
  ['photo', ['photo', 'photogenic', '出片', '拍照', '上镜']],
  ['walking', ['walking', '好走', '步行', '走路', '通勤']],
  ['warm', ['warm', '保暖', '暖和']],
  ['breathable', ['breathable', '透气']],
  ['city', ['city', '城市', '都市']],
  ['travel', ['travel', '旅行', '出游']],
  ['rain', ['rain', 'waterproof', '防水', '雨']],
  ['casual', ['casual', '休闲', '随性']],
  ['light', ['lightweight', '轻量', '轻便']],
]

/** 「不要 X」「避开 X」这类前缀在 avoid 里是修饰语，不是要匹配的词本身。 */
const NOISE = /^(不要|不喜欢|不喜|避开|避免|拒绝|别|no|avoid|without)\s*/i

const SPLIT = /[、，,;；/|]+/

function asText(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map((x) => String(x)).join('、')
  return String(v)
}

/** 拆分多值 + 去噪 + 小写 + 去多余空白。 */
function tokens(v: unknown): string[] {
  return asText(v)
    .split(SPLIT)
    .map((s) => s.replace(NOISE, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
}

function hasCJK(s: string): boolean {
  return /[\u4e00-\u9fa5]/.test(s)
}

/**
 * 关键词命中：中文用子串；英文用词边界（避免 bag 命中 baggy）。
 * 英文关键词以非字母结尾（如 "3/4"）时退回子串匹配。
 */
function hit(haystack: string, kw: string): boolean {
  const k = kw.toLowerCase().trim()
  if (!k) return false
  if (hasCJK(k)) return haystack.includes(k)
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!/^[a-z0-9]/.test(k) || !/[a-z0-9]$/.test(k)) return haystack.includes(k)
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack)
}

export interface PrefRules {
  /** 映射成功的颜色家族；null = 没有该偏好或认不出 */
  palette: ColorFamily[] | null
  /** 映射成功的 style 标签 */
  styles: string[] | null
  brandPrefer: string[] | null
  brandAvoid: string[] | null
  /** 硬排除关键词（自由文本，字符串级匹配） */
  avoid: string[] | null
  /** 槽位 → 尺码值 */
  sizes: Partial<Record<SlotId, string>>
  /** 认不出、因此不参与任何计算的偏好原文（用于如实解释） */
  unmapped: Array<{ attr: string; value: string }>
}

/** 上装/外套共用「上装尺码」；包不参与尺码过滤。 */
export const SLOT_SIZE_ATTR: Partial<Record<SlotId, string>> = {
  top: 'size_top',
  outerwear: 'size_top',
  bottom: 'size_bottom',
  shoes: 'size_shoes',
}

function winner(records: PrefRecord[], attr: string, ctx: PrefContext) {
  const r = resolveAttr<unknown>(records, attr, undefined, ctx)
  return r.winner ? r.value : undefined
}

/**
 * 把生效偏好编译成规则。空结果（全 null / 空对象）= 没有任何可用偏好，
 * 调用方必须走「与无偏好完全一致」的路径。
 */
export function buildPrefRules(records: PrefRecord[], ctx: PrefContext = {}): PrefRules {
  const rules: PrefRules = {
    palette: null,
    styles: null,
    brandPrefer: null,
    brandAvoid: null,
    avoid: null,
    sizes: {},
    unmapped: [],
  }

  const paletteRaw = winner(records, 'palette', ctx)
  if (paletteRaw !== undefined) {
    const toks = tokens(paletteRaw)
    const fams: ColorFamily[] = []
    const left: string[] = []
    for (const t of toks) {
      const found = PALETTE_WORDS.find(([, words]) => words.some((w) => hit(t.toLowerCase(), w) || hit(w, t.toLowerCase())))
      if (found) {
        if (!fams.includes(found[0])) fams.push(found[0])
      } else left.push(t)
    }
    if (fams.length) rules.palette = fams
    for (const t of left) rules.unmapped.push({ attr: 'palette', value: t })
    if (!fams.length) rules.unmapped.push({ attr: 'palette', value: asText(paletteRaw) })
  }

  const styleRaw = winner(records, 'style', ctx)
  if (styleRaw !== undefined) {
    const toks = tokens(styleRaw)
    const tags: string[] = []
    const left: string[] = []
    for (const t of toks) {
      const found = STYLE_WORDS.find(([, words]) => words.some((w) => hit(t.toLowerCase(), w) || hit(w, t.toLowerCase())))
      if (found) {
        if (!tags.includes(found[0])) tags.push(found[0])
      } else left.push(t)
    }
    if (tags.length) rules.styles = tags
    for (const t of left) rules.unmapped.push({ attr: 'style', value: t })
  }

  const brandPreferRaw = winner(records, 'brand_prefer', ctx)
  if (brandPreferRaw !== undefined) {
    const toks = tokens(brandPreferRaw).filter(Boolean)
    if (toks.length) rules.brandPrefer = toks
    else rules.unmapped.push({ attr: 'brand_prefer', value: asText(brandPreferRaw) })
  }

  const brandAvoidRaw = winner(records, 'brand_avoid', ctx)
  if (brandAvoidRaw !== undefined) {
    const toks = tokens(brandAvoidRaw).filter(Boolean)
    if (toks.length) rules.brandAvoid = toks
    else rules.unmapped.push({ attr: 'brand_avoid', value: asText(brandAvoidRaw) })
  }

  const avoidRaw = winner(records, 'avoid', ctx)
  if (avoidRaw !== undefined) {
    const toks = tokens(avoidRaw).filter(Boolean)
    if (toks.length) rules.avoid = toks
    else rules.unmapped.push({ attr: 'avoid', value: asText(avoidRaw) })
  }

  for (const [slot, attr] of Object.entries(SLOT_SIZE_ATTR) as Array<[SlotId, string]>) {
    const sizeRaw = winner(records, attr, ctx)
    if (sizeRaw === undefined) continue
    const v = asText(sizeRaw).trim().toUpperCase().replace(/\s+/g, '')
    if (v) rules.sizes[slot] = v
    else rules.unmapped.push({ attr, value: asText(sizeRaw) })
  }

  return rules
}

/** 规则是否为空（= 等于没有偏好）。 */
export function isEmptyRules(rules: PrefRules): boolean {
  return (
    !rules.palette &&
    !rules.styles &&
    !rules.brandPrefer &&
    !rules.brandAvoid &&
    !rules.avoid &&
    Object.keys(rules.sizes).length === 0
  )
}

/** 一件商品的可匹配文本：标题 + 颜色 + 风格标签 + 店铺名。 */
function searchable(item: Item): string {
  return [item.title, item.color, ...(item.style ?? []), item.vendor ?? ''].join(' ')
}

function sizeMatch(item: Item, want: string): boolean {
  const list = (item.sizes ?? []).map((s) => String(s).trim().toUpperCase().replace(/\s+/g, ''))
  if (!list.length) return true // 没有尺码信息时不因尺码排除（信息不足 ≠ 不符合）
  return list.includes(want)
}

function brandMatch(vendor: string | undefined, token: string): boolean {
  if (!vendor) return false
  const a = norm(vendor)
  const b = norm(token)
  if (!a || !b) return false
  return a === b || a.includes(b) || b.includes(a)
}

export interface PrefExclusionHit {
  /** 规则 ID：size_shoes / brand_avoid / avoid —— 用于「全部命中则放弃该规则」的裁决 */
  rule: string
  reason: string
}

/**
 * 硬排除：一件商品是否因偏好必须离开候选池。
 * 只做三件能百分之百复核的事：尺码不含、品牌命中排除名单、标题/颜色/标签含避开词。
 */
export function prefExclusionHits(item: Item, rules: PrefRules, slotId: SlotId): PrefExclusionHit[] {
  const hits: PrefExclusionHit[] = []

  const want = rules.sizes[slotId]
  if (want && !sizeMatch(item, want)) {
    hits.push({ rule: `size_${slotId}`, reason: `没有你的尺码 ${want}` })
  }

  if (rules.brandAvoid) {
    const brand = rules.brandAvoid.find((b) => brandMatch(item.vendor, b))
    if (brand) hits.push({ rule: 'brand_avoid', reason: `你要求避开 ${item.vendor ?? brand}` })
  }

  if (rules.avoid) {
    const text = searchable(item)
    const word = rules.avoid.find((k) => hit(text, k))
    if (word) hits.push({ rule: 'avoid', reason: `你要求避开「${word}」` })
  }

  return hits
}

export interface PrefBonusResult {
  bonus: number
  whys: string[]
}

/** 软加分上限：颜色 0.05 + 风格 0.03 + 偏好品牌 0.02 = 0.10（策略权重 0.40 仍是主导）。 */
export const PREF_WEIGHTS = { palette: 0.05, style: 0.03, brand: 0.02 } as const

export type PrefBonusKind = 'palette' | 'style' | 'brand'

/**
 * 每条软规则在候选池里的覆盖率。
 *
 * 用途：真实目录里 `minimal` 标签覆盖 93% 商品，若照常给分就是「人人 +0.03」——
 * 顺序不变、却让用户以为个性化在起作用。覆盖率过高的规则应当停用并如实说明，
 * 而不是靠调小权重来掩饰标签问题。
 */
export function prefCoverage(
  items: Item[],
  rules: PrefRules,
): Record<PrefBonusKind, { hits: number; total: number; ratio: number }> {
  const total = items.length
  const ratio = (hits: number) => (total === 0 ? 0 : Number((hits / total).toFixed(3)))
  const paletteHits =
    rules.palette && total ? items.filter((c) => rules.palette!.includes(c.colorFamily)).length : 0
  const styleHits =
    rules.styles && total ? items.filter((c) => rules.styles!.some((s) => (c.style ?? []).includes(s))).length : 0
  const brandHits =
    rules.brandPrefer && total ? items.filter((c) => rules.brandPrefer!.some((b) => brandMatch(c.vendor, b))).length : 0
  return {
    palette: { hits: paletteHits, total, ratio: ratio(paletteHits) },
    style: { hits: styleHits, total, ratio: ratio(styleHits) },
    brand: { hits: brandHits, total, ratio: ratio(brandHits) },
  }
}

/**
 * 软加分：只在「同向匹配」时给分，不命中就是 0（不做惩罚，避免把排序翻过来）。
 * 商品缺标签时不给分也不扣分 —— 数据不足不该被当成不符合。
 * skip：覆盖率过高、已判定无区分度的规则（由调用方决定，见 prefCoverage）。
 */
export function prefBonusFor(item: Item, rules: PrefRules, skip: PrefBonusKind[] = []): PrefBonusResult {
  let bonus = 0
  const whys: string[] = []

  if (!skip.includes('palette') && rules.palette && rules.palette.includes(item.colorFamily)) {
    bonus += PREF_WEIGHTS.palette
    whys.push(`颜色符合你的偏好（${item.colorFamily}）+${PREF_WEIGHTS.palette}`)
  }

  if (!skip.includes('style') && rules.styles) {
    const matched = rules.styles.filter((s) => (item.style ?? []).includes(s))
    if (matched.length) {
      bonus += PREF_WEIGHTS.style
      whys.push(`风格符合你的偏好（${matched.join('/')}）+${PREF_WEIGHTS.style}`)
    }
  }

  if (!skip.includes('brand') && rules.brandPrefer) {
    const brand = rules.brandPrefer.find((b) => brandMatch(item.vendor, b))
    if (brand) {
      bonus += PREF_WEIGHTS.brand
      whys.push(`偏好品牌（${item.vendor ?? brand}）+${PREF_WEIGHTS.brand}`)
    }
  }

  return { bonus: Number(bonus.toFixed(3)), whys }
}
