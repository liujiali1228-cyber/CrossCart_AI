/**
 * 偏好带作用域：task（本次）> profile（长期）> default。
 *
 * 不参与解析的四类记录（全部由代码裁决，不靠模型自觉）：
 *   1. confirmedByUser !== true（模型推断但用户没确认）
 *   2. deletedAt 有值（软删；用户删掉的偏好不能"复活"）
 *   3. supersededBy 有值（被同 attr + 同 scope 的新记录取代，历史保留）
 *   4. scope=task 且带 taskKey，但当前上下文不是那个任务（过去的"本次"不能永久生效）
 */
export type PrefScope = 'profile' | 'task'

/** 写入来源：用户表单 / AI 经工具写入 / 迁移前的老数据 */
export type PrefSource = 'user_form' | 'ai' | 'legacy'

export interface PrefRecord {
  id?: string
  attr: string
  /** 归一化前的原始键名（别名映射后仍保留，便于追溯与迁移） */
  attrRaw?: string
  value: unknown
  scope: PrefScope
  confidence: 'stated' | 'inferred'
  confirmedByUser: boolean
  /** 覆盖式写入：被哪条新记录取代（链式，历史不删除） */
  supersededBy?: string
  /** 软删时间；有值即视为已删除 */
  deletedAt?: string
  /** task 作用域归属（planId 或会话 id）；有键的 task 只在同一上下文中生效 */
  taskKey?: string
  source?: PrefSource
  evidence?: PrefEvidence
  createdAt?: string
  /** 待确认提议被更新时的时间（值变了但仍是同一条提议） */
  updatedAt?: string
  confirmedAt?: string
  /**
   * 用户明确拒绝的时间。
   * 与 deletedAt 的区别：删除是「不要这条了」，拒绝是「AI 别这么猜」——
   * 后者会阻止同 attr + 同值的提议再次出现（F3 要求 3）。
   */
  rejectedAt?: string
  /** 拒绝时用户给的原因（可选，便于回溯「为什么这条不该提议」） */
  rejectReason?: string
}

/** 偏好依据的类型。没有依据的推断不允许写库。 */
export type PrefBasis = 'swap' | 'selection' | 'chat' | 'form'

/**
 * 一条偏好的形成依据。
 *
 * 这里只做「格式 + 锚点」校验：服务端另校验 ref 指向的方案/会话真实存在。
 * 引述内容是否真的说过，代码无法判断 —— 所以界面上必须标明「AI 推断」，
 * 由用户决定是否采纳，绝不因为「AI 说你说过」就当成事实。
 */
export interface PrefEvidence {
  basis: PrefBasis
  /** 锚点：换件/选择填 planId，对话填会话或轮次 id */
  ref?: string
  /** 用户原话或操作摘要（非空；≤200 字） */
  quote?: string
  slot?: string
  productId?: string
  at?: string
}

export const PREF_BASES: readonly PrefBasis[] = ['swap', 'selection', 'chat', 'form']

export interface EvidenceCheck {
  ok: boolean
  evidence?: PrefEvidence
  error?: string
}

/** 校验并规整依据。宁可拒绝写入，也不接受「没有出处的偏好」。 */
export function validateEvidence(raw: unknown): EvidenceCheck {
  if (raw == null || typeof raw !== 'object') {
    return { ok: false, error: '缺少依据（evidence）：AI 推断必须写明来自哪次换件/选择/对话' }
  }
  const ev = raw as Record<string, unknown>
  const basis = String(ev.basis ?? '').trim() as PrefBasis
  if (!PREF_BASES.includes(basis)) {
    return { ok: false, error: `依据类型 basis 必须是 ${PREF_BASES.join(' / ')}` }
  }
  const quote = typeof ev.quote === 'string' ? ev.quote.replace(/\s+/g, ' ').trim() : ''
  if (quote.length < 2) {
    return { ok: false, error: '依据缺少原话或操作摘要（quote），不能凭印象记偏好' }
  }
  const ref = typeof ev.ref === 'string' ? ev.ref.trim() : undefined
  if ((basis === 'swap' || basis === 'selection') && !ref && !ev.productId) {
    return { ok: false, error: '换件/选择类依据必须带 ref（方案 ID）或 productId' }
  }
  return {
    ok: true,
    evidence: {
      basis,
      ...(ref ? { ref } : {}),
      quote: quote.length > 200 ? `${quote.slice(0, 200)}…` : quote,
      ...(typeof ev.slot === 'string' && ev.slot ? { slot: ev.slot } : {}),
      ...(typeof ev.productId === 'string' && ev.productId ? { productId: ev.productId } : {}),
      ...(typeof ev.at === 'string' && ev.at ? { at: ev.at } : {}),
    },
  }
}

export interface ResolvedPref<T> {
  value: T
  winner: PrefRecord | null
  overridden: PrefRecord[]
}

/** 解析上下文：task 记录必须带同一个 taskKey 才算"本次" */
export interface PrefContext {
  taskKey?: string | null
}

/**
 * canonical 属性表。别名一律映射到这里，避免三套词表（插件 / 首页 / 单测）各说各话。
 * 认不出的自定义键原样保留（不静默丢弃、不假装认识）。
 */
export const CANONICAL_ATTRS = [
  'palette',
  'style',
  'avoid',
  'size_top',
  'size_bottom',
  'size_shoes',
  'brand_prefer',
  'brand_avoid',
  'budget_habit',
] as const

export const ATTR_ALIASES: Record<string, string> = {
  palette: 'palette',
  color: 'palette',
  colors: 'palette',
  color_family: 'palette',
  'color.family': 'palette',
  'color.like': 'palette',
  colours: 'palette',
  style: 'style',
  'style.like': 'style',
  avoid: 'avoid',
  'avoid.like': 'avoid',
  dislike: 'avoid',
  size_top: 'size_top',
  size_bottom: 'size_bottom',
  size_shoes: 'size_shoes',
  brand_prefer: 'brand_prefer',
  brand: 'brand_prefer',
  brand_avoid: 'brand_avoid',
  budget: 'budget_habit',
  budget_habit: 'budget_habit',
}

/** 键名归一：小写、去空格；命中别名表用 canonical，否则原样返回（标明是自定义键）。 */
export function normalizeAttr(attr: string): string {
  const key = String(attr ?? '').trim().toLowerCase()
  return ATTR_ALIASES[key] ?? key
}

/** 是否是核心认识的 canonical 属性（自定义键返回 false，调用方决定怎么处理） */
export function isCanonicalAttr(attr: string): boolean {
  return (CANONICAL_ATTRS as readonly string[]).includes(normalizeAttr(attr))
}

/** 写库前把一条记录规整成合法形状：补 id / 补 attrRaw / 归一 attr。纯函数，不改入参。 */
export function normalizePref(rec: PrefRecord): PrefRecord {
  const canonical = normalizeAttr(rec.attr)
  return {
    ...rec,
    attr: canonical,
    attrRaw: rec.attrRaw ?? (canonical === String(rec.attr) ? undefined : rec.attr),
  }
}

/**
 * 该记录现在是否应该参与解析。
 * 注意 taskKey 语义：带键但调用方没给上下文 → 视为不生效（宁可不用，也不让"上次旅行"永久生效）。
 */
export function isPrefActive(rec: PrefRecord, ctx: PrefContext = {}): boolean {
  if (!rec) return false
  if (rec.deletedAt) return false
  if (rec.rejectedAt) return false
  if (rec.supersededBy) return false
  if (rec.scope !== 'task') return true
  if (!rec.taskKey) return true
  if (!ctx.taskKey) return false
  return rec.taskKey === ctx.taskKey
}

/** 同槽位判定：同 attr（归一后）+ 同 scope + 同 taskKey，且自己还活着 */
function isSameSlot(r: PrefRecord, rec: PrefRecord): boolean {
  if (!r || r.deletedAt || r.supersededBy) return false
  if (normalizeAttr(r.attr) !== normalizeAttr(rec.attr)) return false
  if (r.scope !== rec.scope) return false
  return (r.taskKey ?? null) === (rec.taskKey ?? null)
}

/** 供上层（确认/覆盖写入）复用同一套槽位判定，避免各处再写一遍规则 */
export function isSamePrefSlot(a: PrefRecord, b: PrefRecord): boolean {
  return isSameSlot(a, b)
}

/**
 * 覆盖式写入：同槽位的旧记录标 supersededBy（历史保留），新记录追加在末尾。
 * 这是「用户改主意」能真正生效的唯一保证 —— 之前只 push + find 第一条，改完还是旧值。
 *
 * F3 边界（最重要的一条）：**未确认的提议不得取代已确认的偏好**。
 * 用户已经确认 palette=light，AI 推断出 palette=dark 时只追加一条待确认记录，
 * light 继续生效；只有用户确认 dark 之后，light 才会被标为已取代。
 */
export function upsertPref(records: PrefRecord[], rec: PrefRecord): PrefRecord[] {
  const next = normalizePref(rec)
  const supersedesConfirmed = next.confirmedByUser === true && !next.deletedAt && !next.rejectedAt
  return [
    ...records.map((r) => {
      if (!isSameSlot(r, next)) return r
      // 待确认提议只能顶掉同槽位的其他待确认记录，绝不把已确认的长期偏好标成"已取代"
      if (!supersedesConfirmed && r.confirmedByUser) return r
      return { ...r, supersededBy: next.id ?? 'superseded' }
    }),
    next,
  ]
}

/** 值比较：数组逐项、字符串去空白小写；对象按键排序后比较。 */
export function samePrefValue(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown => {
    if (v == null) return null
    if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim().toLowerCase()
    if (Array.isArray(v)) return v.map(canon)
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>
      return Object.keys(o)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => ((acc[k] = canon(o[k])), acc), {})
    }
    return v
  }
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}

export type ProposalReason = 'new' | 'same_slot_same_value' | 'rejected_before' | 'same_slot_pending'

export interface ProposalPlan {
  /** create：新增；update_pending：更新已有待确认提议；skip_*：不写库 */
  action: 'create' | 'update_pending' | 'skip_duplicate' | 'skip_rejected'
  reason: ProposalReason
  /** update_pending 时指向被更新的记录；skip_* 时指向命中的那条 */
  targetId?: string
  /** 给人看的一句话说明 */
  note: string
}

/**
 * 写库前的判重决策（纯函数，可单测）。
 *
 * 规则顺序：
 *  1. 同槽位已有「同值且已确认」的记录 → 已经是长期偏好，不必再提议；
 *  2. 同值被用户拒绝过 → 不再重复提议（F3 要求 3）；
 *  3. 同槽位已有待确认提议：同值跳过，不同值就地更新（不新增第二条）；
 *  4. 其余情况新增（包括与已确认偏好值不同 —— 那是「冲突提议」，允许存在，但不会覆盖）。
 */
export function planProposal(records: PrefRecord[], rec: PrefRecord): ProposalPlan {
  const next = normalizePref(rec)
  const sameSlot = (records ?? []).filter(
    (r) =>
      r &&
      !r.supersededBy &&
      normalizeAttr(r.attr) === next.attr &&
      r.scope === next.scope &&
      (r.taskKey ?? null) === (next.taskKey ?? null),
  )

  const rejected = sameSlot.find((r) => r.rejectedAt && samePrefValue(r.value, next.value))
  if (rejected) {
    return {
      action: 'skip_rejected',
      reason: 'rejected_before',
      targetId: rejected.id,
      note: '同一条推断你之前拒绝过，不再重复提议',
    }
  }

  const confirmedSame = sameSlot.find(
    (r) => r.confirmedByUser && !r.deletedAt && !r.rejectedAt && samePrefValue(r.value, next.value),
  )
  if (confirmedSame) {
    return {
      action: 'skip_duplicate',
      reason: 'same_slot_same_value',
      targetId: confirmedSame.id,
      note: '这条已经是生效的长期偏好，不需要再确认',
    }
  }

  const pending = sameSlot.find((r) => !r.confirmedByUser && !r.deletedAt && !r.rejectedAt)
  if (pending) {
    if (samePrefValue(pending.value, next.value)) {
      return {
        action: 'skip_duplicate',
        reason: 'same_slot_same_value',
        targetId: pending.id,
        note: '相同的待确认提议已经存在，未重复新增',
      }
    }
    return {
      action: 'update_pending',
      reason: 'same_slot_pending',
      targetId: pending.id,
      note: '已有一条待确认提议，更新为新值（仍是待确认，未参与推荐）',
    }
  }

  return { action: 'create', reason: 'new', note: '已记录为待确认，等你决定是否长期生效' }
}

/** 同 attr 的多条里取最新一条（createdAt 越大越新；同一毫秒取数组靠后的，即后写入的）。 */
function latestOf(list: PrefRecord[]): PrefRecord | undefined {
  let best: PrefRecord | undefined
  for (const r of list) {
    if (!best) {
      best = r
      continue
    }
    const a = Date.parse(r.createdAt ?? '') || 0
    const b = Date.parse(best.createdAt ?? '') || 0
    if (a >= b) best = r
  }
  return best
}

/**
 * 解析单个属性。规则（由代码裁决，不靠模型自觉）：
 * 1. 只有 active + confirmedByUser 的记录参与。
 * 2. task 作用域无条件压过 profile（但必须属于当前任务上下文）。
 * 3. 被压过的记录写进 overridden —— 这是「本次要求覆盖长期偏好」的机器可验证证据。
 */
export function resolveAttr<T>(
  records: PrefRecord[],
  attr: string,
  fallback: T,
  ctx: PrefContext = {},
): ResolvedPref<T> {
  const key = normalizeAttr(attr)
  const eligible = (records ?? []).filter(
    (r) => r && r.confirmedByUser && isPrefActive(r, ctx) && normalizeAttr(r.attr) === key,
  )
  const task = latestOf(eligible.filter((r) => r.scope === 'task'))
  const profile = latestOf(eligible.filter((r) => r.scope === 'profile'))

  if (task) {
    const overridden = profile && profile.value !== task.value ? [profile] : []
    return { value: task.value as T, winner: task, overridden }
  }
  if (profile) return { value: profile.value as T, winner: profile, overridden: [] }
  return { value: fallback, winner: null, overridden: [] }
}

/** 批量解析：把 overridden 汇成方案里的 constraints.overrides 证据列表。 */
export function resolveAll(
  records: PrefRecord[],
  defaults: Record<string, unknown>,
  ctx: PrefContext = {},
): { values: Record<string, unknown>; overridden: PrefRecord[] } {
  const values: Record<string, unknown> = {}
  const overridden: PrefRecord[] = []
  for (const key of Object.keys(defaults)) {
    const r = resolveAttr(records, key, defaults[key], ctx)
    values[key] = r.value
    overridden.push(...r.overridden)
  }
  return { values, overridden }
}

/** attr 的人话标签。自定义键不在此表 → 直接用键名，不假装认识。 */
export const ATTR_LABEL: Record<string, string> = {
  palette: '颜色偏好',
  style: '风格偏好',
  avoid: '要避开',
  size_top: '上装尺码',
  size_bottom: '下装尺码',
  size_shoes: '鞋码',
  brand_prefer: '偏好品牌',
  brand_avoid: '避开品牌',
  budget_habit: '预算习惯',
}

/** 把任意偏好值压成一行人话；空值返回空串（由调用方跳过，绝不输出"空偏好"）。 */
function readableValue(v: unknown, maxChars: number): string {
  let text: string
  if (v == null) return ''
  if (Array.isArray(v)) {
    text = v
      .filter((x) => x != null && String(x).trim() !== '')
      .map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)))
      .join('、')
  } else if (typeof v === 'object') {
    text = JSON.stringify(v)
  } else if (typeof v === 'boolean') {
    text = v ? '是' : '否'
  } else {
    text = String(v)
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

export interface PrefBriefOptions {
  /** 最多几行（含"还有 N 项未列出"那行），默认 6 */
  maxLines?: number
  /** 单值最大字符，默认 40 */
  valueMaxChars?: number
}

export interface PrefBrief {
  /** 每行一条偏好，可直接拼进 prompt；没有任何生效偏好时为空数组 */
  lines: string[]
  /** 本次列出的 attr（canonical 名） */
  attrs: string[]
  /** 因为行数上限被省略的 attr 数量 */
  omitted: number
  /** lines.join('\n')，空数组时为 '' */
  text: string
}

/**
 * 生效偏好 → ≤maxLines 行纯文本。
 *
 * 只输出「用户确认过 + 当前上下文有效」的记录（resolveAttr 裁决），所以：
 *   - 未确认的 AI 推断不会污染上下文；
 *   - 已删除 / 被取代 / 过期 task 偏好不会出现；
 *   - 同一 attr 只出现一行，且是真正生效的那条。
 * 不做任何模型判断，纯函数 —— 同样的记录必然产出同样的文本。
 */
export function prefsBrief(
  records: PrefRecord[],
  ctx: PrefContext = {},
  opts: PrefBriefOptions = {},
): PrefBrief {
  const maxLines = Math.max(1, opts.maxLines ?? 6)
  const valueMaxChars = Math.max(8, opts.valueMaxChars ?? 40)
  const all = (records ?? []).filter(Boolean)

  // 候选 attr：至少有一条「确认 + 有效」的记录，且值非空
  const seen: string[] = []
  for (const r of all) {
    const attr = normalizeAttr(r.attr)
    if (!seen.includes(attr)) seen.push(attr)
  }
  const canonIndex = (attr: string) => {
    const i = (CANONICAL_ATTRS as readonly string[]).indexOf(attr)
    return i === -1 ? CANONICAL_ATTRS.length + seen.indexOf(attr) : i
  }

  const rows: Array<{ attr: string; text: string }> = []
  for (const attr of [...seen].sort((a, b) => canonIndex(a) - canonIndex(b))) {
    const resolved = resolveAttr<unknown>(all, attr, undefined, ctx)
    if (!resolved.winner) continue
    const value = readableValue(resolved.value, valueMaxChars)
    if (!value) continue
    const label = ATTR_LABEL[attr] ?? attr
    const isTask = resolved.winner.scope === 'task'
    const overridden = resolved.overridden
      .map((r) => readableValue(r.value, valueMaxChars))
      .filter(Boolean)
    const note = isTask
      ? overridden.length
        ? `仅本方案；长期为 ${overridden[0]}`
        : '仅本方案'
      : '长期'
    rows.push({ attr, text: `- ${label}：${value}（${note}）` })
  }

  if (rows.length <= maxLines) {
    const lines = rows.map((r) => r.text)
    return { lines, attrs: rows.map((r) => r.attr), omitted: 0, text: lines.join('\n') }
  }
  const shown = rows.slice(0, maxLines - 1)
  const omitted = rows.length - shown.length
  const lines = [...shown.map((r) => r.text), `- 另有 ${omitted} 项偏好未在此列出（用 crosscart_list_prefs 查看）`]
  return { lines, attrs: shown.map((r) => r.attr), omitted, text: lines.join('\n') }
}

/**
 * 更新一条已有待确认提议（值或依据变了，但仍是同一条提议）。
 * 不新增记录，避免「每换一次件就多一条 pending」。
 */
export function updateProposal(
  records: PrefRecord[],
  id: string,
  patch: Partial<Pick<PrefRecord, 'value' | 'evidence' | 'confidence'>>,
): PrefRecord[] {
  const at = new Date().toISOString()
  return (records ?? []).map((r) =>
    r.id === id
      ? {
          ...r,
          ...(patch.value !== undefined ? { value: patch.value } : {}),
          ...(patch.evidence !== undefined ? { evidence: patch.evidence } : {}),
          ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
          updatedAt: at,
        }
      : r,
  )
}

/**
 * 待确认提议（未生效、未删除、未被取代、未被拒绝）。
 *
 * 上下文策略：待确认记录尚未参与任何推荐，展示出来是安全的；首页没有「当前方案」，
 * 所以不传 ctx 时连 task 提议一起列（界面会标「仅本方案」），由用户决定要不要留。
 */
export function prefsPending(records: PrefRecord[], ctx: PrefContext = {}): PrefRecord[] {
  return (records ?? [])
    .filter((r) => {
      if (!r || isPrefConfirmed(r) || r.deletedAt || r.rejectedAt || r.supersededBy) return false
      if (r.scope !== 'task') return true
      if (!ctx.taskKey) return true
      return (r.taskKey ?? '') === ctx.taskKey
    })
    .slice()
    .sort((a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0))
}

/** 是否已经是「用户确认过」的偏好（待确认记录一律 false）。 */
export function isPrefConfirmed(rec: PrefRecord | null | undefined): boolean {
  return Boolean(rec && rec.confirmedByUser === true && !rec.deletedAt && !rec.rejectedAt && !rec.supersededBy)
}

/** 同 prefsBrief，只取文本（没有生效偏好时返回 ''）。 */
export function prefsBriefText(
  records: PrefRecord[],
  ctx: PrefContext = {},
  opts: PrefBriefOptions = {},
): string {
  return prefsBrief(records, ctx, opts).text
}

export type PrefStatus = 'active' | 'overridden' | 'superseded' | 'deleted' | 'rejected' | 'unconfirmed' | 'inactive'

/** 给 UI / 工具用的只读投影：按 attr 分组，标注生效中 / 被本次覆盖 / 待确认 / 已拒绝 / 已失效。 */
export function prefsOverview(
  records: PrefRecord[],
  ctx: PrefContext = {},
): Array<{
  attr: string
  canonical: boolean
  winner: PrefRecord | null
  overridden: PrefRecord[]
  /** 该 attr 是否有一条待用户确认的提议（与 winner 并存：原偏好继续生效） */
  pending: PrefRecord | null
  records: Array<PrefRecord & { status: PrefStatus }>
}> {
  const all = (records ?? []).filter(Boolean)
  const attrs = [...new Set(all.map((r) => normalizeAttr(r.attr)))]
  return attrs.map((attr) => {
    const r = resolveAttr(records, attr, null, ctx)
    const group = (records ?? []).filter((x) => normalizeAttr(x.attr) === attr)
    const pending = group.find((x) => !isPrefConfirmed(x) && !x.deletedAt && !x.rejectedAt && !x.supersededBy) ?? null
    return {
      attr,
      canonical: isCanonicalAttr(attr),
      winner: r.winner,
      overridden: r.overridden,
      pending,
      records: group.map((rec) => {
        const status: PrefStatus = rec.rejectedAt
          ? 'rejected'
          : rec.deletedAt
            ? 'deleted'
            : rec.supersededBy
              ? 'superseded'
              : !rec.confirmedByUser
                ? 'unconfirmed'
                : !isPrefActive(rec, ctx)
                  ? 'inactive'
                  : r.winner === rec
                    ? 'active'
                    : 'overridden'
        return { ...rec, status }
      }),
    }
  })
}
