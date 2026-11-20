/**
 * 共享状态服务：方案与偏好的唯一事实源。
 *
 * 为什么需要它：
 *  - dsh 对话侧（工具）与浏览器侧（Studio）必须读写同一份方案，
 *    否则「页面点换件 → AI 还按老方案回答」；
 *  - 状态是结构化对象 + 确定性变更（applySwap），两侧都只是它的客户端。
 *
 * 所有算账、单件隔离、三态合并仍在 @crosscart/core 纯函数里，这里只做装配与持久化。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  createPlan,
  applySwap,
  setSlotLock,
  removeSlotItem,
  rankCandidates,
  rankCandidatesDetailed,
  validatePlanAgainstPrefs,
  updateConstraints,
  duplicatePlan,
  fitBudget,
  itemLine,
  buyInfo,
  purchaseLines,
  purchaseGroups,
  costBreakdown,
  buyableCount,
  PlanError,
  SLOT_LABEL,
  SLOT_ORDER,
  STATUS_LABEL,
  ARRIVAL_LABEL,
  STRATEGY_LABEL,
  parseOwnedColor,
  normalizeAttr,
  normalizePref,
  upsertPref,
  updateProposal,
  planProposal,
  prefsPending,
  prefsOverview,
  validateEvidence,
  isPrefActive,
  isPrefConfirmed,
  isSamePrefSlot,
  isCanonicalAttr,
} from '../../core/dist/index.js'

const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..')

export function repoRoot() {
  return ROOT
}

function readJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 这句话里提到过这个类目吗？（抽象「已有」的来源判据）
 *
 * 用户说「我有白鞋」可能被模型改写为「白色运动鞋」，所以不做字符串相等比较；
 * 只要求这段对话里确实出现过该类目的常见说法。宁可漏放（走 422 让模型重提），
 * 也不要放过「从上一份方案里搬过来」的幻觉所有权。
 */
const SLOT_WORDS = {
  outerwear: /外套|大衣|风衣|夹克|羽绒|棉服|西装|blazer|coat|jacket|parka/i,
  top: /上衣|t恤|T恤|衬衫|毛衣|针织|卫衣|打底|吊带|背心|sweater|shirt|top|knit/i,
  bottom: /裤|裙|牛仔|jeans|pants|trouser|skirt/i,
  shoes: /鞋|靴| sneaker|sneakers|loafer|boots?|flats?|乐福/i,
  bag: /包|袋|bag|tote|backpack|crossbody/i,
}

export function mentionsSlot(text, slot) {
  const re = SLOT_WORDS[slot]
  return re ? re.test(String(text ?? '')) : false
}

export function loadSeed(root = ROOT) {
  return readJson(join(root, 'data', 'seed', 'catalog.json'), { meta: {}, items: [], owned: [] })
}

export function assetUrl(path) {
  if (/^https?:\/\//i.test(path)) return path
  return `/data/seed/${path.replace(/^\/+/, '')}`
}

export class Workspace {
  constructor({ root = ROOT, dataDir, seed = loadSeed(root), live = null } = {}) {
    this.root = root
    // 数据目录可注入：验收跑在临时状态副本上，真实方案不会被改动
    this.dataDir = dataDir ?? join(root, 'data')
    // 种子数据统一打上 sourceKind，界面与购买策略据此区分「真实商品 / 演示数据」
    this.seed = {
      ...seed,
      items: (seed.items ?? []).map((i) => ({ ...i, sourceKind: i.sourceKind ?? 'seed' })),
      owned: (seed.owned ?? []).map((i) => ({ ...i, sourceKind: i.sourceKind ?? 'seed' })),
    }
    this.statePath = join(this.dataDir, 'state.json')
    this.liveMeta = live?.meta ?? null
    this.liveItems = live?.items ?? []
    this.plans = new Map()
    this.prefs = []
    this.prefSeq = 0
    this.seq = 0
    // 「新开聊天」的时间边界：null = 还没重置过，所有声明都算这段对话里说的。
    // 重置后，之前记下的 ownedClaim 就属于「上一段对话」—— 可以展示，但不能当成
    // 用户这次说过的话让模型搬进新方案（P5 的「新开聊天」用例）。
    this.chatEpochStart = null
    this.loadState()
  }

  /** 新开聊天：划一条时间线，之前的「已拥有」声明降级为历史 */
  markNewChat() {
    this.chatEpochStart = new Date().toISOString()
  }

  /** 注入场景生成器（server 启动时挂上）；viewModel 用它投影 sceneView */
  setScenegen(sg) {
    this.scenegen = sg
    // 生成器排队时拿到的是「换件那一刻的方案快照」。连着换几件时快照会过期，
    // 按旧快照算出来的缓存键会命中旧图、什么都不生成（真踩过：最终图一直 missing）。
    // 所以把「按 planId 取最新方案」的能力交给它，排到执行时再取一次。
    sg?.setPlanResolver?.((planId) => this.plans.get(planId) ?? null)
  }

  /**
   * 注入「这段对话里用户说过什么」的读取函数（server 启动时挂上）。
   *
   * 为什么状态层需要它：抽象「已有」（用户说「我有白鞋」但没给商品）没有 productId 可校验，
   * 唯一的来源凭证就是这句话本身。校验必须在落库前完成，而不是等界面去猜。
   */
  setUserTextSource(fn) {
    this.userText = fn
  }

  /**
   * Mode A：只切换场景，绝不改商品。不 bump revision（方案没变，变的是看法），
   * 但持久化 sceneChoice，并广播 plan.updated 让所有客户端重读 sceneView。
   */
  setSceneChoice(planId, query, opts = {}) {
    const plan = this.getPlan(planId)
    const result = this.scenegen.choose(plan, query, opts)
    plan.updatedAt = new Date().toISOString()
    this.persist()
    return result
  }

  /** 自动更新穿搭图开关（关掉时立刻取消排队中的生成）。 */
  setSceneAuto(planId, enabled) {
    const plan = this.getPlan(planId)
    const res = this.scenegen.setAuto(plan, enabled)
    plan.updatedAt = new Date().toISOString()
    this.persist()
    return res
  }

  /** 目录 = 真实商品 + 种子（种子始终在，保证离线可跑、评测可复现） */
  get catalog() {
    return [...this.liveItems, ...this.seed.items]
  }

  get owned() {
    return this.seed.owned ?? []
  }

  get today() {
    return this.seed.meta?.today ?? new Date().toISOString().slice(0, 10)
  }

  setLive(live) {
    this.liveMeta = live?.meta ?? null
    this.liveItems = live?.items ?? []
  }

  loadState() {
    if (!existsSync(this.statePath)) return
    // 服务器被强杀 / 磁盘写满时 state.json 可能是半截 JSON。
    // 这时不能静默从空工作区启动（会看起来像「方案全丢了」），先回退到上一次的完整副本。
    let saved = readJson(this.statePath, null)
    if (!saved || !Array.isArray(saved.plans)) {
      const backup = readJson(`${this.statePath}.bak`, null)
      if (backup && Array.isArray(backup.plans)) {
        console.warn(`[state] ${this.statePath} 读不出来，已回退到 .bak（${backup.plans.length} 份方案）`)
        saved = backup
      } else {
        if (saved) console.warn(`[state] ${this.statePath} 结构不对，且没有可用备份`)
        return
      }
    }
    for (const plan of saved.plans ?? []) {
      this.normalizeSource(plan)
      this.plans.set(plan.planId, plan)
    }
    // 偏好：老数据没有 id / 别名未归一 → 在内存里补齐（不静默丢弃任何一条）
    this.prefs = (saved.prefs ?? []).map((p, i) => this.migratePref(p, i))
    this.prefSeq = this.prefs.reduce((max, p) => {
      const n = Number(String(p.id ?? '').match(/^pref_(\d+)$/)?.[1] ?? 0)
      return Number.isFinite(n) ? Math.max(max, n) : max
    }, 0)
    this.seq = saved.seq ?? this.plans.size
  }

  /** 迁移前的老记录补齐 id / canonical attr / source；幂等，重复调用无副作用。 */
  migratePref(rec, index = 0) {
    const normalized = normalizePref({
      ...rec,
      id: rec.id ?? `legacy_${index + 1}`,
      source: rec.source ?? 'legacy',
    })
    return normalized
  }

  /** 旧方案里的单品快照可能没有 sourceKind：按目录补齐，购买策略与界面据此区分真实/演示。 */
  normalizeSource(plan) {
    for (const slot of plan.slots ?? []) {
      const item = slot?.item
      if (!item || item.sourceKind) continue
      item.sourceKind = this.liveItems.some((c) => c.productId === item.productId) ? 'live' : 'seed'
      if (!item.vendor && item.sourceKind === 'seed') item.vendor = '演示数据'
    }
  }

  /**
   * 落盘：写临时文件 → 留一份上一版 → rename 原子替换。
   *
   * 为什么不能直接 writeFileSync 到 state.json：写到一半进程被杀（容器重启、磁盘满）会留下
   * 半截 JSON，下次启动等于「所有方案消失」。rename 是原子的，读到的要么是旧版、要么是新版。
   */
  persist() {
    const data = { plans: [...this.plans.values()], prefs: this.prefs, seq: this.seq }
    mkdirSync(dirname(this.statePath), { recursive: true })
    const tmp = `${this.statePath}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    if (existsSync(this.statePath)) {
      try {
        copyFileSync(this.statePath, `${this.statePath}.bak`)
      } catch {
        /* 备份失败不影响本次写入 */
      }
    }
    renameSync(tmp, this.statePath)
  }

  nextPlanId() {
    this.seq += 1
    return `pln_${String(this.seq).padStart(3, '0')}`
  }

  getPlan(planId) {
    const plan = this.plans.get(planId)
    if (!plan) {
      const known = [...this.plans.keys()].join(', ') || '（无）'
      throw new PlanError('SLOT_NOT_FOUND', `找不到方案 ${planId}；已有方案：${known}`)
    }
    return plan
  }

  /** productId → 商品名。只做只读查表，查不到返回 null（调用方决定怎么兜底）。 */
  titleOf(productId) {
    if (!productId) return null
    const hit = [...this.catalog, ...this.owned].find((c) => c.productId === productId)
    if (hit) return hit.title
    for (const plan of this.plans.values()) {
      for (const s of plan.slots) if (s.item?.productId === productId) return s.item.title
    }
    return null
  }

  /**
   * 建方案（F4 A1）：**先校验、后落库**。
   *
   * 为什么必须前置：原来的实现先 `this.plans.set()` + `persist()` 再返回 `prefConflicts`，
   * 等于「方案已经存进去了，只是顺口提一句冲突」。用户下次打开首页仍然看到它，
   * 与换件路径「硬排除 = 进不了候选池」完全不一致。
   *
   * 现在的顺序：建内存方案 → 校验硬偏好 / 预算 / 到货 / 收货地 → 有硬冲突就抛
   * `PREF_CONFLICT`（不带任何持久化副作用）→ 只有通过（或用户本轮明确破例）才落库。
   */
  createPlan(payload) {
    for (const s of payload.slots ?? []) {
      if (!SLOT_ORDER.includes(s.slot)) throw new PlanError('SLOT_NOT_FOUND', `非法搭配位 ${s.slot}`)
      if (s.status === 'empty') continue
      if (!s.productId) {
        // P9：用户说「我有白鞋」时没有商品 ID。允许 owned 走「抽象自有」，
        // 但必须有他自己的描述 —— 不能既没商品、又没说法，那等于凭空占位。
        if (s.status === 'owned' && String(s.ownedLabel ?? '').trim()) continue
        throw new PlanError('NO_CANDIDATE', `${SLOT_LABEL[s.slot]} 缺少 productId`)
      }
      if (s.productId && ![...this.catalog, ...this.owned].some((c) => c.productId === s.productId)) {
        throw new PlanError('NO_CANDIDATE', `目录里没有 ${s.productId}`)
      }
    }

    // —— 「已拥有」必须有用户声明（Phase 6 / P5，P9 扩展到「没有商品 ID」的自有单品）——
    //
    // 真实踩过：建方案工具的示例参数里写了 {"slot":"bottom","status":"owned","productId":"own_dark_jeans"}，
    // 模型照着示例填，于是每一份新方案都凭空多出一条「已拥有：深色直筒牛仔裤」，
    // 而且上一份方案的「已有」还会被注入下一轮上下文，越滚越像真的。
    // 现在的规矩：status=owned 必须在同一请求里带上 ownedClaims（商品或类目 + 用户原话），
    // 否则直接 422 且不落库 —— 宁可让模型重提一次，也不写一条用户没说过的所有权。
    const productClaims = new Map()
    const slotClaims = new Map()
    for (const c of payload.ownedClaims ?? []) {
      const quote = String(c?.quote ?? '').trim()
      if (quote.length < 2) continue
      const productId = String(c?.productId ?? '').trim()
      if (productId) productClaims.set(productId, quote)
      const slot = String(c?.slot ?? '').trim()
      if (slot) {
        slotClaims.set(slot, {
          quote,
          label: String(c?.label ?? '').trim(),
          color: c?.color ? String(c.color).trim() : null,
        })
      }
    }
    // 抽象自有还必须是**这段对话**里说过的：新开聊天后不能再把上一段的口头声明搬过来。
    // 判据是「这段对话的用户消息里提到过这个类目」，比字符串相等宽容（模型常改写原话），
    // 但比「模型说是就是」严格得多。
    const saidText = typeof this.userText === 'function' ? String(this.userText() ?? '') : ''
    for (const s of payload.slots ?? []) {
      if (s.status !== 'owned') continue
      if (s.productId) {
        if (!productClaims.has(s.productId)) {
          throw new PlanError(
            'OWNED_UNDECLARED',
            `「${SLOT_LABEL[s.slot]}」被标成「已拥有」，但用户这次没有说过自己拥有它`,
            '只有用户明确说过「我有这件 / 我已经有」时才能标 owned，并在 ownedClaims 里带上他的原话；否则按 to_buy（需要买）或 empty（留空）提交。',
            { slot: s.slot, productId: s.productId },
          )
        }
        continue
      }
      const claim = slotClaims.get(s.slot)
      if (!claim) {
        throw new PlanError(
          'OWNED_UNDECLARED',
          `「${SLOT_LABEL[s.slot]}」被标成「已拥有」，但没有带用户的原话`,
          '用户说了自己有某件东西时，在 ownedClaims 里写 {slot, label: 用户描述, quote: 用户原话}；没说过就把这个搭配位留空或按待买处理。',
          { slot: s.slot },
        )
      }
      if (saidText && !mentionsSlot(saidText, s.slot)) {
        throw new PlanError(
          'OWNED_UNDECLARED',
          `「${SLOT_LABEL[s.slot]}」被标成「已拥有」，但用户这段对话里没提过自己有这样的东西`,
          '不要从历史方案、示例数据或上一段对话推断「已有」。只有用户在这段对话里说过，才可以标 owned，并在空搭配位给出 ownedLabel。',
          { slot: s.slot, quote: claim.quote },
        )
      }
    }

    const plan = createPlan({
      planId: payload.planId ?? this.nextPlanId(),
      label: payload.label,
      scene: {
        type: payload.scene?.type ?? 'travel',
        destination: payload.scene?.destination ?? 'Tokyo',
        days: payload.scene?.days ?? 3,
        today: this.today,
      },
      budget: { limit: payload.budgetLimit, currency: 'USD', basis: 'new_items_only' },
      arrivalBy: { date: payload.arrivalBy },
      shipTo: payload.shipTo ?? this.seed.meta?.shipTo ?? 'CN',
      slots: payload.slots,
      catalog: this.catalog,
      ownedItems: this.owned,
    })

    // 把「用户原话」记在槽位上，供界面标注来源与后续上下文使用（不写进长期偏好）
    for (const slot of plan.slots) {
      if (slot.status !== 'owned') continue
      if (slot.item) {
        const quote = productClaims.get(slot.item.productId)
        if (quote) slot.ownedClaim = { quote, at: new Date().toISOString() }
        continue
      }
      // 抽象自有：没有商品，只有用户描述。颜色优先用模型给的，其次从描述里解析。
      const claim = slotClaims.get(slot.slot)
      if (!claim) continue
      const spec = (payload.slots ?? []).find((s) => s.slot === slot.slot) ?? {}
      const label = String(spec.ownedLabel ?? claim.label ?? '').trim() || SLOT_LABEL[slot.slot]
      slot.ownedClaim = {
        quote: claim.quote,
        at: new Date().toISOString(),
        label,
        color: claim.color || parseOwnedColor(label),
      }
    }

    // —— 硬约束前置校验：冲突则抛错，方案不落库、不广播 ——
    const override = this.parsePrefOverride(payload.prefOverride)
    const validation = validatePlanAgainstPrefs(plan, this.prefs, { taskKey: plan.planId }, {
      allowRules: override.rules,
    })
    if (validation.violations.length) {
      const detail = validation.violations
        .map((v) => `${SLOT_LABEL[v.slot]}「${v.title}」—— ${v.reasons.join('；')}`)
        .join('；')
      throw new PlanError(
        'PREF_CONFLICT',
        `这套方案有 ${validation.violations.length} 件商品与你已确认的偏好冲突：${detail}`,
        '可以：① 换掉冲突商品后重新提交；② 到首页修改或删除对应偏好；③ 如果本次确实要例外，请由用户明确说明后，用 prefOverride 带上规则与原话重新提交（只对这套方案生效）。',
        {
          violations: validation.violations,
          applied: validation.applied,
          unmapped: validation.unmapped,
          checks: validation.checks,
          actions: [
            { action: 'replace_items', label: '换掉冲突商品' },
            { action: 'edit_prefs', label: '修改 / 删除对应偏好' },
            { action: 'allow_once', label: '用户明确授权本方案破例', rules: validation.violations.flatMap((v) => v.rules) },
          ],
        },
      )
    }
    if (override.rules.length) {
      // 只记在这套方案上：一次性破例 ≠ 长期偏好被放宽
      plan.constraints.prefExceptions = override.rules.map((rule) => ({
        rule,
        quote: override.quote,
        at: new Date().toISOString(),
      }))
    }

    this.plans.set(plan.planId, plan)
    plan.updatedAt = new Date().toISOString()
    this.persist()
    return plan
  }

  /**
   * 删除方案（演示环境清理用）。
   *
   * 为什么需要：验收脚本与体验者都会不断建方案，没有删除入口时列表会越堆越乱，
   * 后来的人分不清哪个是"自己的"。只删方案本身，不动偏好与场景图缓存。
   */
  removePlan(planId) {
    if (!this.plans.has(planId)) throw new PlanError('SLOT_NOT_FOUND', `没有方案 ${planId}`)
    this.plans.delete(planId)
    this.persist()
    return { planId }
  }

  /**
   * 解析「本方案破例」授权。只接受用户原话，且规则 ID 必须真实存在 ——
   * 模型自己编一个 rule 名不该能放开任何东西。
   */
  parsePrefOverride(raw) {
    if (!raw) return { rules: [], quote: '' }
    const KNOWN = ['brand_avoid', 'avoid', 'size_top', 'size_bottom', 'size_shoes']
    const rules = Array.isArray(raw.rules) ? raw.rules.map((r) => String(r)) : []
    const quote = String(raw.quote ?? '').trim()
    const bad = rules.filter((r) => !KNOWN.includes(r))
    if (bad.length) {
      throw new PlanError(
        'PREF_CONFLICT',
        `不认识的破例规则：${bad.join('、')}`,
        `只能针对已确认的硬性规则破例（${KNOWN.join(' / ')}）；没有对应偏好时不需要破例。`,
      )
    }
    if (!rules.length) return { rules: [], quote }
    if (quote.length < 4) {
      throw new PlanError(
        'PREF_CONFLICT',
        '破例必须附上用户原话（至少 4 个字）',
        '请先向用户确认「这次要破例」，再把他/她的原话传进 prefOverride.quote；不要替用户决定。',
      )
    }
    return { rules: [...new Set(rules)], quote }
  }

  /** 方案当前的偏好校验结果（可随时重算：偏好改了，老方案也应如实显示新冲突）。 */
  planValidation(plan) {
    const allowRules = (plan.constraints.prefExceptions ?? []).map((e) => e.rule)
    return validatePlanAgainstPrefs(plan, this.prefs, { taskKey: plan.planId }, { allowRules })
  }

  swap(planId, { slot, strategy, productId }) {
    const plan = this.getPlan(planId)
    const result = applySwap(plan, this.catalog, {
      slot,
      revision: plan.revision,
      strategy,
      productId,
      prefs: this.prefs,
      prefCtx: { taskKey: planId },
    })
    result.plan.updatedAt = new Date().toISOString()
    // 解释用：同一套方案、同一策略下「完全不看偏好」时的名次，用来区分
    // 「加分但名次没变」与「因偏好成为首选」—— 这两种情况绝不能混着说。
    result.picked = this.explainPick(plan, slot, strategy, result, productId)
    this.plans.set(plan.planId, result.plan)
    this.persist()
    // 自动更新模式开着才排生成；默认关（省钱），关着就只更新清单，图保持上一版并标 stale
    this.scenegen?.scheduleRegen(result.plan, { reason: 'swap' })
    return result
  }

  /**
   * 这件为什么被选中 / 偏好到底起了什么作用。
   * 只做同一次排序的对照，不引入任何模型判断：
   *  - prefBonus / prefWhys：这件拿了多少软加分、命中哪几条
   *  - rankWithPrefs / rankWithoutPrefs：有偏好 vs 无偏好的名次（1 起）
   */
  explainPick(planBefore, slot, strategy, result, productId) {
    const pickedId = result.plan.slots.find((s) => s.slot === slot)?.item?.productId ?? null
    if (!pickedId) return null
    const withPrefs = result.candidates ?? []
    const idx = withPrefs.findIndex((c) => c.item.productId === pickedId)
    const cand = idx >= 0 ? withPrefs[idx] : null
    let rankWithoutPrefs = null
    if (!productId && strategy) {
      try {
        const base = rankCandidatesDetailed(planBefore, slot, this.catalog, strategy, { prefs: [] })
        const bIdx = base.candidates.findIndex((c) => c.item.productId === pickedId)
        rankWithoutPrefs = bIdx >= 0 ? bIdx + 1 : null
      } catch {
        rankWithoutPrefs = null
      }
    }
    return {
      productId: pickedId,
      title: result.plan.slots.find((s) => s.slot === slot)?.item?.title ?? null,
      prefBonus: cand?.prefBonus ?? 0,
      prefWhys: cand?.prefWhys ?? [],
      score: cand?.score ?? null,
      rankWithPrefs: idx >= 0 ? idx + 1 : null,
      rankWithoutPrefs,
      rankChanged: rankWithoutPrefs != null && idx >= 0 ? rankWithoutPrefs !== idx + 1 : null,
      specified: Boolean(productId),
    }
  }

  /** 改预算 / 最晚到货日 / 收货地。只重算派生金额，不动单品。 */
  setConstraints(planId, patch) {
    const plan = this.getPlan(planId)
    const res = updateConstraints(plan, patch)
    if (res.plan.revision === plan.revision) return { plan, changed: false }
    res.plan.updatedAt = new Date().toISOString()
    this.plans.set(planId, res.plan)
    this.persist()
    return { plan: res.plan, changed: true }
  }

  /** 另存为新方案（演示「保存方案」）：新 ID，历史清零。 */
  duplicate(planId) {
    const plan = this.getPlan(planId)
    const copy = duplicatePlan(plan, this.nextPlanId())
    copy.updatedAt = new Date().toISOString()
    this.plans.set(copy.planId, copy)
    this.persist()
    return copy
  }

  /** 一键调整至预算内：确定性贪心换件，每步仍受单点改动守卫保护。 */
  fitToBudget(planId) {
    const plan = this.getPlan(planId)
    const res = fitBudget(plan, this.catalog)
    if (res.changes.length === 0) return { ...res, plan, changed: false }
    res.plan.updatedAt = new Date().toISOString()
    this.plans.set(planId, res.plan)
    this.persist()
    return { ...res, plan: res.plan, changed: true }
  }

  lock(planId, slot, locked) {
    const plan = this.getPlan(planId)
    const next = setSlotLock(plan, slot, locked).plan
    next.updatedAt = new Date().toISOString()
    this.plans.set(planId, next)
    this.persist()
    return next
  }

  remove(planId, slot) {
    const plan = this.getPlan(planId)
    const next = removeSlotItem(plan, slot, plan.revision).plan
    next.updatedAt = new Date().toISOString()
    this.plans.set(planId, next)
    this.persist()
    return next
  }

  candidates(planId, slot, strategy, { includeUnconfirmed = false, prefs = this.prefs } = {}) {
    const plan = this.getPlan(planId)
    return rankCandidates(plan, slot, this.catalog, strategy, {
      includeUnconfirmed,
      prefs,
      prefCtx: { taskKey: planId },
    })
  }

  /** 候选 + 偏好解释（加分依据 / 被排除商品 / 放弃的规则） */
  candidateResult(planId, slot, strategy, opts = {}) {
    const plan = this.getPlan(planId)
    return rankCandidatesDetailed(plan, slot, this.catalog, strategy, {
      includeUnconfirmed: Boolean(opts.includeUnconfirmed),
      prefs: opts.prefs ?? this.prefs,
      prefCtx: { taskKey: planId },
    })
  }

  /** 建方案路径的偏好冲突检查：只报告，不改写方案（F2 要求 5） */
  /** 兼容旧调用方：只返回冲突列表（不含预算/到货检查）。新代码用 `planValidation()`。 */
  prefConflicts(plan) {
    const v = this.planValidation(plan)
    return { conflicts: v.violations, exempt: v.exempt, applied: v.applied, unmapped: v.unmapped }
  }

  /**
   * 保存偏好（覆盖式）。
   *
   * 三条硬规矩：
   *  - 同 attr + 同 scope + 同 taskKey 视为同一个槽位：旧记录标 supersededBy，新记录生效；
   *    之前只 push，`resolveAttr` 取第一条 → 用户改主意等于没改（Phase 5A 实测缺陷 ①）。
   *  - scope=task 必须带 taskKey（planId / 会话 id），否则「本次」会永久压过长期偏好（缺陷 ②）。
   *  - confirmedByUser 由调用方决定：AI 推断但用户没确认的，写 inferred + false，解析时自动忽略。
   */
  savePref({ attr, value, scope, taskKey = null, source = 'user_form', confidence, confirmedByUser, turnId, sessionId, evidence }) {
    if (!attr || String(attr).trim() === '') throw new PlanError('NO_CANDIDATE', '偏好缺少 attr')
    if (scope !== 'profile' && scope !== 'task') throw new PlanError('NO_CANDIDATE', 'scope 必须是 profile 或 task')
    if (scope === 'task' && !taskKey) {
      throw new PlanError(
        'NO_CANDIDATE',
        'scope=task 的偏好必须带 taskKey（方案 ID），否则「本次」会变成永久生效',
        '改用 scope=profile 记长期偏好，或传 planId 作为 taskKey',
      )
    }
    // 依据可缺省（用户表单本来就没有"出处"），但有就必须合法
    let cleanEvidence
    if (evidence !== undefined) {
      const check = validateEvidence(evidence)
      if (!check.ok) throw new PlanError('NO_CANDIDATE', check.error)
      cleanEvidence = check.evidence
    } else if (turnId || sessionId) {
      cleanEvidence = { basis: 'chat', ...(sessionId ? { ref: sessionId } : {}), quote: '对话中确认' }
    }
    this.prefSeq = (this.prefSeq ?? 0) + 1
    const record = normalizePref({
      id: `pref_${String(this.prefSeq).padStart(3, '0')}`,
      attr,
      value,
      scope,
      taskKey: scope === 'task' ? String(taskKey) : undefined,
      confidence: confidence ?? 'stated',
      confirmedByUser: confirmedByUser ?? true,
      source,
      evidence: cleanEvidence,
      createdAt: new Date().toISOString(),
    })
    this.prefs = upsertPref(this.prefs, record)
    this.persist()
    return record
  }

  /**
   * AI 提议一条偏好（F3）：**只写待确认，绝不直接生效**。
   *
   * 三道闸：
   *  1. 依据必须合法且锚点真实存在（不能编造"用户说过"）；
   *  2. 判重：已确认同值 / 已有同值待确认 → 不新增；同槽位已有其他待确认 → 就地更新；
   *  3. 用户拒绝过的同值提议 → 不再重复出现。
   * 写入的记录 confirmedByUser=false，resolveAttr 自动忽略，因此不影响任何推荐结果。
   */
  proposePref({ attr, value, scope = 'profile', taskKey = null, evidence, confidence = 'inferred' }) {
    if (!attr || String(attr).trim() === '') throw new PlanError('NO_CANDIDATE', '偏好缺少 attr')
    if (scope !== 'profile' && scope !== 'task') throw new PlanError('NO_CANDIDATE', 'scope 必须是 profile 或 task')
    if (scope === 'task' && !taskKey) {
      throw new PlanError('NO_CANDIDATE', 'scope=task 的提议必须带 planId')
    }
    const check = validateEvidence(evidence)
    if (!check.ok) throw new PlanError('NO_CANDIDATE', check.error, '请写明依据（哪次换件/选择/哪句话），不能凭印象推断')
    const ev = check.evidence
    if ((ev.basis === 'swap' || ev.basis === 'selection') && ev.ref && !this.plans.has(ev.ref)) {
      throw new PlanError('SLOT_NOT_FOUND', `依据指向的方案 ${ev.ref} 不存在`, '只能基于真实存在的方案提议偏好')
    }

    const draft = normalizePref({
      id: `pref_${String((this.prefSeq ?? 0) + 1).padStart(3, '0')}`,
      attr,
      value,
      scope,
      taskKey: scope === 'task' ? String(taskKey) : undefined,
      confidence,
      confirmedByUser: false,
      source: 'ai',
      evidence: ev,
      createdAt: new Date().toISOString(),
    })
    const plan = planProposal(this.prefs, draft)

    if (plan.action === 'skip_duplicate' || plan.action === 'skip_rejected') {
      const existing = this.prefs.find((p) => p.id === plan.targetId) ?? null
      return { action: plan.action, reason: plan.reason, note: plan.note, record: existing, changed: false }
    }

    if (plan.action === 'update_pending') {
      this.prefs = updateProposal(this.prefs, plan.targetId, { value, evidence: ev, confidence })
      this.persist()
      return {
        action: 'update_pending',
        reason: plan.reason,
        note: plan.note,
        record: this.prefs.find((p) => p.id === plan.targetId) ?? null,
        changed: true,
      }
    }

    this.prefSeq = (this.prefSeq ?? 0) + 1
    draft.id = `pref_${String(this.prefSeq).padStart(3, '0')}`
    this.prefs = [...this.prefs, draft]
    this.persist()
    return { action: 'create', reason: plan.reason, note: plan.note, record: draft, changed: true }
  }

  findPref(id) {
    const rec = this.prefs.find((p) => p.id === id)
    if (!rec) throw new PlanError('SLOT_NOT_FOUND', `找不到偏好 ${id}`)
    return rec
  }

  /**
   * 用户确认一条 AI 推断的偏好（或修正后确认）。
   *
   * 这是「从提议变成长期记忆」的唯一入口，必须是覆盖式写入：
   * 同槽位其他活记录（包括原来的已确认值）标 supersededBy，历史保留 ——
   * 只改标志位会让新旧两条同时 confirmed，解析时靠 createdAt 撞运气。
   */
  confirmPref(id, patch = {}) {
    const rec = this.findPref(id)
    if (rec.deletedAt) throw new PlanError('SLOT_NOT_FOUND', `偏好 ${id} 已删除，不能再确认`)
    if (rec.rejectedAt) throw new PlanError('STALE_REVISION', `偏好 ${id} 已被拒绝，不能再确认`)
    if (rec.supersededBy) throw new PlanError('STALE_REVISION', `偏好 ${id} 已被新记录取代（${rec.supersededBy}）`)

    const next = {
      ...rec,
      ...(patch.value !== undefined ? { value: patch.value } : {}),
      confidence: 'stated',
      confirmedByUser: true,
      confirmedAt: new Date().toISOString(),
    }
    this.prefs = this.prefs.map((p) => {
      if (p.id === id) return next
      if (!p.supersededBy && !p.deletedAt && !p.rejectedAt && isSamePrefSlot(p, next)) {
        return { ...p, supersededBy: next.id }
      }
      return p
    })
    this.persist()
    return next
  }

  /** 用户拒绝一条提议：保留记录（可追溯），并阻止同值提议再次出现。 */
  rejectPref(id, reason) {
    const rec = this.findPref(id)
    if (rec.rejectedAt) return rec
    if (rec.confirmedByUser && !rec.deletedAt) {
      throw new PlanError('CATEGORY_MISMATCH', `偏好 ${id} 已是生效偏好，请用删除（DELETE）而不是拒绝`)
    }
    const at = new Date().toISOString()
    const next = {
      ...rec,
      confirmedByUser: false,
      rejectedAt: at,
      deletedAt: at,
      ...(reason ? { rejectReason: String(reason).slice(0, 120) } : {}),
    }
    this.prefs = this.prefs.map((p) => (p.id === id ? next : p))
    this.persist()
    return next
  }

  /** 软删：保留记录与时间戳（可追溯），解析时不再参与。 */
  deletePref(id) {
    const rec = this.findPref(id)
    if (rec.deletedAt) return rec
    const next = { ...rec, deletedAt: new Date().toISOString(), confirmedByUser: false }
    this.prefs = this.prefs.map((p) => (p.id === id ? next : p))
    this.persist()
    return next
  }

  /** 给 UI / 工具：生效值 + 待确认提议 + 被覆盖 + 失效原因，全部可查证（不含任何模型判断）。 */
  prefsView(ctx = {}) {
    const pending = prefsPending(this.prefs, ctx)
    return {
      // prefs 只含「用户已确认且当前生效」的记录 —— 待确认的单独放 pending，绝不合在一起
      prefs: this.prefs.filter((p) => isPrefConfirmed(p) && isPrefActive(p, ctx)),
      pending,
      all: this.prefs,
      groups: prefsOverview(this.prefs, ctx),
      canonical: [...new Set(this.prefs.map((p) => normalizeAttr(p.attr)))].map((attr) => ({
        attr,
        canonical: isCanonicalAttr(attr),
      })),
      counts: {
        total: this.prefs.length,
        active: this.prefs.filter((p) => isPrefConfirmed(p) && isPrefActive(p, ctx)).length,
        pending: pending.length,
        superseded: this.prefs.filter((p) => p.supersededBy).length,
        deleted: this.prefs.filter((p) => p.deletedAt && !p.rejectedAt).length,
        rejected: this.prefs.filter((p) => p.rejectedAt).length,
      },
    }
  }

  /** 给 UI 的完整视图：只读投影，绝不参与业务判断 */
  viewModel(plan) {
    const slotViews = SLOT_ORDER.map((id) => {
      const s = plan.slots.find((x) => x.slot === id) ?? { slot: id, status: 'empty', locked: false, item: null }
      const item = s.item ?? null
      return {
        slot: id,
        label: SLOT_LABEL[id],
        status: s.status,
        locked: !!s.locked,
        reason: s.reason ?? null,
        /** 只在用户明确声明过时才有；界面据此区分「你声明已有」与历史示例数据 */
        ownedClaim: s.ownedClaim ?? null,
        item: item
          ? {
              productId: item.productId,
              title: item.title,
              category: item.category,
              color: item.color,
              colorFamily: item.colorFamily,
              vendor: item.vendor ?? (String(item.productId).includes(':') ? String(item.productId).split(':')[0] : '演示数据'),
              sourceKind: item.sourceKind ?? 'seed',
              url: item.url || null,
              sizes: item.sizes ?? [],
              price: { amount: item.price.amount, currency: item.price.currency, status: item.price.status },
              shipping: {
                fee: item.shipping.fee?.amount ?? null,
                status: item.shipping.status,
                etaDays: item.shipping.etaDays ?? null,
                etaEarliest: item.shipping.etaEarliest ?? null,
                etaLatest: item.shipping.etaLatest ?? null,
                note: item.shipping.note ?? null,
              },
              duty: { status: item.duty?.status ?? 'unavailable', amount: item.duty?.amount ?? null, reason: item.duty?.reason ?? null },
              image: { main: assetUrl(item.image.main), cutout: assetUrl(item.image.cutout) },
              // 购买入口只由 core 的可信策略决定：没有可核实的商家详情页就不给按钮
              buy: buyInfo(item, s.status),
            }
          : null,
      }
    })

    const lines = plan.cost.lines.map((l) => ({
      title: l.label,
      item: l.parts.item,
      shipping: l.parts.shipping,
      amount: l.amount,
      status: l.status,
      statusLabel: STATUS_LABEL[l.status],
    }))

    const breakdown = costBreakdown(plan)
    const purchases = purchaseLines(plan)
    const groups = purchaseGroups(plan)

    const risks = []
    if (breakdown.verdict === 'over_budget') {
      risks.push({
        level: 'high',
        code: 'over_budget',
        text: `当前可计算总额 $${breakdown.knownTotal}，超预算 $${breakdown.overBy}`,
        action: { id: 'fit_budget', label: '调整至预算内' },
      })
    }
    if (breakdown.shippingUnknownCount > 0) {
      risks.push({
        level: 'mid',
        code: 'shipping_unknown',
        text: `${breakdown.shippingUnknownCount} 件商品运费待确认，总额只含已知部分`,
      })
    }
    if (breakdown.risky) {
      risks.push({ level: 'mid', code: 'estimated', text: '部分费用（运费）为估算，最终金额以商家结账页为准' })
    }
    risks.push({
      level: 'info',
      code: 'duty_unknown',
      text: '跨境关税/进口税未计入总额，需在商家结账页确认',
    })
    if (plan.arrival.verdict === 'unknown') {
      risks.push({ level: 'mid', code: 'arrival_unknown', text: '存在无法确认的运费/到货信息，不能保证按时送达' })
    }
    if (plan.arrival.verdict === 'late') {
      risks.push({
        level: 'high',
        code: 'arrival_late',
        text: `最晚到货 ${plan.arrival.latest ?? '未知'}，晚于目标 ${plan.constraints.arrivalBy.date}`,
      })
    }
    if (plan.arrival.verdict === 'at_risk') {
      risks.push({
        level: 'mid',
        code: 'arrival_at_risk',
        text: `最晚到货 ${plan.arrival.latest} 贴近截止日 ${plan.constraints.arrivalBy.date}，建议留缓冲`,
      })
    }
    if (risks.filter((r) => r.level !== 'info').length === 0) {
      risks.push({ level: 'ok', code: 'ok', text: '预算与到货都在约束内（金额仍以结账页为准）' })
    }

    const liveCount = slotViews.filter((s) => s.item?.sourceKind === 'live').length

    return {
      planId: plan.planId,
      label: plan.label,
      revision: plan.revision,
      updatedAt: plan.updatedAt ?? null,
      scene: plan.scene,
      /** AI 场景图视图（生成状态 / 图片 / 热点 / 适配提示）；未配置图像服务时如实标 unconfigured */
      sceneView: this.scenegen ? this.scenegen.viewFor(plan) : null,
      constraints: {
        budgetLimit: plan.cost.budget.limit,
        arrivalBy: plan.constraints.arrivalBy.date,
        shipTo: plan.constraints.shipTo,
      },
      slots: slotViews,
      cost: {
        currency: plan.cost.currency,
        lines,
        newItemsTotal: plan.cost.newItemsTotal.amount,
        totalStatus: plan.cost.newItemsTotal.status,
        breakdown,
        budget: {
          limit: plan.cost.budget.limit,
          remaining: breakdown.remaining,
          verdict: breakdown.verdict,
          status: plan.cost.budget.status,
          risky: breakdown.risky,
          overBy: breakdown.overBy,
        },
      },
      purchases: {
        lines: purchases,
        groups,
        buyableCount: buyableCount(plan),
        ownedCount: slotViews.filter((s) => s.status === 'owned').length,
        missingLinkCount: purchases.filter((p) => p.buy.state !== 'buyable').length,
      },
      arrival: {
        verdict: plan.arrival.verdict,
        label: ARRIVAL_LABEL[plan.arrival.verdict],
        earliest: plan.arrival.earliest,
        latest: plan.arrival.latest,
        deadline: plan.arrival.deadline,
        blocking: plan.arrival.blocking ?? [],
      },
      risks,
      history: plan.ops.map((op) => {
        // 变更记录给用户看：不同类型的操作说人话，商品名查不到才退回 id（不猜、不隐藏）
        const fromTitle = this.titleOf(op.from) ?? op.from ?? '—'
        const toTitle = this.titleOf(op.to) ?? op.to ?? '—'
        if (op.type === 'update_constraints') {
          return { slot: '方案约束', slotId: null, from: '—', to: op.note ?? '已更新', fromId: null, toId: null, strategy: '调整约束', at: op.at ?? null }
        }
        if (op.type === 'lock' || op.type === 'unlock') {
          return {
            slot: SLOT_LABEL[op.slot] ?? '搭配位',
            slotId: op.slot,
            from: '—',
            to: op.type === 'lock' ? '锁定' : '解锁',
            fromId: null,
            toId: null,
            strategy: op.type === 'lock' ? '锁定' : '解锁',
            at: op.at ?? null,
          }
        }
        if (op.type === 'remove_item') {
          return {
            slot: SLOT_LABEL[op.slot] ?? '搭配位',
            slotId: op.slot,
            from: fromTitle,
            to: '已移除',
            fromId: op.from ?? null,
            toId: null,
            strategy: '移除单品',
            at: op.at ?? null,
          }
        }
        return {
          slot: SLOT_LABEL[op.slot] ?? '搭配位',
          slotId: op.slot,
          from: fromTitle,
          to: toTitle,
          fromId: op.from ?? null,
          toId: op.to ?? null,
          strategy: op.strategy ? STRATEGY_LABEL[op.strategy] : '指定商品',
          at: op.at ?? null,
        }
      }),
      sources: {
        liveSlots: liveCount,
        seedSlots: slotViews.filter((s) => s.item?.sourceKind === 'seed').length,
        liveStores: this.liveMeta?.stores ?? [],
        liveFetchedAt: this.liveMeta?.fetchedAt ?? null,
      },
    }
  }

  candidateView(planId, slot, strategy, opts = {}) {
    const result = this.candidateResult(planId, slot, strategy, opts)
    const list = result.candidates
    const plan = this.getPlan(planId)
    const current = plan.slots.find((s) => s.slot === slot)?.item
    // 真实店铺会把同款不同色拆成多条，视图层按「店铺 + 主名」去重，避免候选列表被刷屏
    const seen = new Set()
    const deduped = list.filter((c) => {
      const base = String(c.item.title).split('|')[0].split(' in ')[0].trim().toLowerCase()
      const key = `${c.item.vendor ?? 'seed'}::${base}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // 差价的比较基准必须是「当前这件到手价」（商品 + 运费），否则会把当前运费漏算，差价虚高
    const currentLine = current ? itemLine(current).amount : null

    const views = deduped.map((c) => ({
      productId: c.item.productId,
      title: c.item.title,
      vendor: c.item.vendor ?? '演示数据',
      sourceKind: c.item.sourceKind ?? 'seed',
      color: c.item.color,
      colorFamily: c.item.colorFamily,
      sizes: c.item.sizes,
      url: c.item.url || null,
      image: assetUrl(c.item.image.cutout),
      price: c.item.price.amount,
      shipping: c.item.shipping.fee?.amount ?? null,
      shippingStatus: c.item.shipping.status,
      lineTotal: c.lineTotal,
      withinBudget: c.withinBudget,
      overBy: c.overBy ?? 0,
      etaDays: c.item.shipping.etaDays ?? null,
      priceDelta: currentLine == null ? null : c.lineTotal - currentLine,
      score: c.score,
      whys: c.whys ?? [],
      prefBonus: c.prefBonus ?? 0,
      prefWhys: c.prefWhys ?? [],
      buy: buyInfo(c.item, 'to_buy'),
    }))

    // 排序是用户显式选择，不改变推荐集合本身（score 仍由 core 决定）
    const sort = opts.sort ?? 'recommended'
    if (sort === 'price') views.sort((a, b) => (a.lineTotal ?? 0) - (b.lineTotal ?? 0))
    else if (sort === 'delta') views.sort((a, b) => (a.priceDelta ?? 0) - (b.priceDelta ?? 0))
    else if (sort === 'eta') {
      views.sort((a, b) => (a.etaDays?.[1] ?? 999) - (b.etaDays?.[1] ?? 999))
    }
    return {
      views,
      excluded: result.excluded ?? [],
      relaxed: result.relaxed ?? [],
      blockedBy: result.blockedBy ?? [],
      applied: result.applied ?? [],
      unmapped: result.unmapped ?? [],
    }
  }
}
