/**
 * 场景图生成：provider 可插拔 + 内容寻址缓存 + 费用闸门 + 生成后自动识别热点。
 *
 * 四条铁律：
 *  1. 没配置图像服务时状态就是「unconfigured」，如实说怎么配，绝不拿静态图冒充。
 *  2. 缓存键 = 方案签名（槽位 productId+颜色）+ 场景 ID；换一件或换场景就失效。
 *  3. 付费调用前必须**估价并过预算闸门**；预算用完就拒绝，不在后台偷偷花钱。
 *     （P10 起界面不再弹「确认生成」：用户动作本身就是授权，钱由服务端闸门守。）
 *  4. 生成完自动识别衣物区域（本地算法，零成本）；识别不可靠的槽位标 low，不参与点击。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
// Node 内置 fetch 不认 dispatcher（只有 undici 自己的 fetch 认），代理模式下必须用 undici 的 fetch。
// undici 这个版本是 CJS，只能从默认导出解构。
import undici from 'undici'

const { ProxyAgent, fetch: ufetch, FormData: UFormData } = undici
import { resolveScene, buildScenePrompt, sceneCacheKey, checkAdaptation, DETECTOR_ID, ownedConstraints, slotNoun } from '../../core/dist/index.js'
import { detectSceneHotspots, manualHotspot, checkOwnedMatch } from './hotspots.mjs'
import { ensureWebVariant, hasWebVariant, webPathFor } from './image-web.mjs'
import { CostLedger } from './cost.mjs'


/** 自动生成的防抖窗口：连续换三件只在停下来后生成一次。 */
const DEFAULT_AUTO_DEBOUNCE_MS = 1600

/**
 * 防抖窗口按调用时读，不在模块加载时冻结：
 * 模块级常量会让 env 在 import 之后才生效——单测改 env 改了没用，服务侧调参也要重启。
 */
function autoDebounceMs() {
  const v = Number(process.env.SCENEGEN_AUTO_DEBOUNCE_MS)
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_AUTO_DEBOUNCE_MS
}

/**
 * 「用户自有的东西被画错了要不要重画一次」。
 * 默认开：一次重画成本是有上限的（只重画 1 次），而画错的图会直接毁掉用户对整件事的信任。
 * 想省钱可以设 SCENEGEN_OWNED_RETRY=0 关掉。
 */
function ownedRetryEnabled() {
  const v = String(process.env.SCENEGEN_OWNED_RETRY ?? '1').toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off')
}

/**
 * 这张图的热点是否必须重算？
 *  - 没有元数据            → 要（第二阶段的图只有 regions，没有 hotspots）
 *  - detector 不是当前版本 → 要（最坑的一种：旧图带着固定坐标，界面却显示「全部可信」）
 *  - 有任何一个槽位是人工修正 → 不要（人改过的就是权威，别用算法覆盖）
 */
function hotspotsNeedRedetect(meta) {
  if (!meta) return true
  const slots = Object.values(meta.slots ?? {})
  if (slots.some((s) => s?.method === 'manual')) return false
  if (meta.detector !== DETECTOR_ID) return true
  return slots.length === 0
}

function readJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 配置文件位置：既接受数据目录（里面有 scenegen.config.json），也接受仓库根（data/scenegen.config.json）。
 * 后者是为了兼容已有脚本；验收用隔离数据目录时传前者。
 */
function configPath(base) {
  const direct = join(base, 'scenegen.config.json')
  return existsSync(direct) ? direct : join(base, 'data', 'scenegen.config.json')
}

/** 图像生成 provider 配置：环境变量优先，其次 scenegen.config.json。 */
export function resolveProviderConfig(base) {
  const file = readJson(configPath(base), {})
  const p = file.provider ?? {}
  const cfg = {
    baseUrl: (process.env.SCENEGEN_BASE_URL || p.baseUrl || '').replace(/\/+$/, ''),
    apiKey: process.env.SCENEGEN_API_KEY || p.apiKey || '',
    model: process.env.SCENEGEN_MODEL || p.model || '',
    size: process.env.SCENEGEN_SIZE || p.size || '1024x1536',
    /** low/medium/high：控制成本（high 约为 medium 的 4 倍）；null = 不传，用服务默认 */
    quality: process.env.SCENEGEN_QUALITY || p.quality || 'medium',
    /** none = 只发提示词；doubao = 参考图 URL 放 image 字段；openai = images/edits multipart 上传参考图 */
    refsMode: process.env.SCENEGEN_REFS || p.refsMode || 'none',
    /** 出网代理（Node 的 fetch 默认不读 HTTP_PROXY；留空=直连）。形如 http://127.0.0.1:7897 */
    proxy: process.env.SCENEGEN_PROXY || p.proxy || '',
    timeoutMs: Number(process.env.SCENEGEN_TIMEOUT_MS || p.timeoutMs || 180000),
  }
  const missing = []
  if (!cfg.baseUrl) missing.push('SCENEGEN_BASE_URL')
  if (!cfg.apiKey) missing.push('SCENEGEN_API_KEY')
  if (!cfg.model) missing.push('SCENEGEN_MODEL')
  return {
    ...cfg,
    available: missing.length === 0,
    missing,
    setup:
      '配置图像生成服务后可用（任一 OpenAI 兼容图像 API）：' +
      missing.map((k) => `${k}=...`).join(' '),
  }
}

/**
 * 视觉模型配置（可选）：配了就用它识别衣物区域（精度更好），没配就用本地算法。
 * 当前项目的 key 只有图像模型权限，所以默认空；这里保留标准钩子，
 * 配了 VISIION_* 就能无缝切过去，不用改调用方。
 */
export function resolveVisionConfig(base) {
  const file = readJson(configPath(base), {})
  const v = file.vision ?? {}
  const cfg = {
    baseUrl: (process.env.SCENEGEN_VISION_BASE_URL || v.baseUrl || '').replace(/\/+$/, ''),
    apiKey: process.env.SCENEGEN_VISION_API_KEY || v.apiKey || '',
    model: process.env.SCENEGEN_VISION_MODEL || v.model || '',
    proxy: process.env.SCENEGEN_VISION_PROXY || v.proxy || process.env.SCENEGEN_PROXY || '',
    timeoutMs: Number(process.env.SCENEGEN_VISION_TIMEOUT_MS || v.timeoutMs || 60000),
  }
  return { ...cfg, available: !!(cfg.baseUrl && cfg.apiKey && cfg.model) }
}

/** 代理 dispatcher 复用一个实例（每个代理地址一个），避免每次请求新建连接池。 */
const AGENTS = new Map()
function agentFor(proxy) {
  if (!proxy) return undefined
  if (!AGENTS.has(proxy)) AGENTS.set(proxy, new ProxyAgent(proxy))
  return AGENTS.get(proxy)
}

/** 免费自检：只列模型，不产生图像费用。返回 { ok, status, models, error } */
export async function checkProvider(cfg) {
  const net = cfg.proxy ? { dispatcher: agentFor(cfg.proxy) } : {}
  try {
    const res = await ufetch(`${cfg.baseUrl}/models`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(30000),
      ...net,
    })
    const body = await res.json().catch(() => ({}))
    const models = (body.data ?? []).map((m) => m.id)
    return { ok: res.ok, status: res.status, models, error: res.ok ? null : (body.error?.message ?? `HTTP ${res.status}`) }
  } catch (e) {
    return { ok: false, status: 0, models: [], error: String(e.message ?? e) }
  }
}

/**
 * 调图像服务。refs = { urls: string[], files: [{name, mime, buffer}] }。
 * 返回 { buffer, usage, ms } —— usage 用来记账，不写进日志正文。
 * signal 用于「停止等待」：真的 abort 请求，但服务端是否已计费无法保证，调用方要如实说。
 */
export async function callImageApi(cfg, prompt, refs, log, signal) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs)
  const combined = signal ? AbortSignal.any([ctl.signal, signal]) : ctl.signal
  const startedAt = Date.now()
  const dispatcher = agentFor(cfg.proxy)
  const net = dispatcher ? { dispatcher } : {}
  const finish = async (res) => {
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`图像服务 ${res.status}：${text.slice(0, 300)}`)
    }
    const data = await res.json()
    const first = data?.data?.[0]
    let buf = null
    if (first?.b64_json) buf = Buffer.from(first.b64_json, 'base64')
    else if (first?.url) {
      const img = await ufetch(first.url, net)
      if (!img.ok) throw new Error(`下载生成图失败 ${img.status}`)
      buf = Buffer.from(await img.arrayBuffer())
    } else throw new Error('图像服务返回里没有可用的图片（既没有 b64_json 也没有 url）')
    const usage = data?.usage ?? null
    const ms = Date.now() - startedAt
    const u = usage ?? {}
    log?.(
      'scenegen',
      `${cfg.model} ${(ms / 1000).toFixed(1)}s，` +
        `输入 image:${u.input_tokens_details?.image_tokens ?? 0} + text:${u.input_tokens_details?.text_tokens ?? 0}，输出 ${u.output_tokens ?? '?'} tokens`,
    )
    return { buffer: buf, usage, ms }
  }
  try {
    if (cfg.refsMode === 'openai' && refs.files.length) {
      // OpenAI 图像编辑：参考图 multipart 上传（image[] 可多张）
      const form = new UFormData()
      form.append('model', cfg.model)
      form.append('prompt', prompt)
      form.append('size', cfg.size)
      if (cfg.quality) form.append('quality', cfg.quality)
      // 注意：gpt-image-2.6-sunburst 不接受 input_fidelity（只有部分型号支持），默认不发
      if (cfg.inputFidelity) form.append('input_fidelity', cfg.inputFidelity)
      for (const f of refs.files) form.append('image[]', new File([f.buffer], f.name, { type: f.mime }))
      return await finish(
        await ufetch(`${cfg.baseUrl}/images/edits`, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.apiKey}` },
          body: form,
          signal: combined,
          ...net,
        }),
      )
    }
    const body = {
      model: cfg.model,
      prompt,
      size: cfg.size,
      response_format: 'b64_json',
    }
    if (cfg.quality) body.quality = cfg.quality
    if (cfg.refsMode === 'doubao' && refs.urls.length) {
      // 豆包 Seedream 系列：image 字段接受参考图 URL
      body.image = refs.urls
      delete body.response_format
    }
    return await finish(
      await ufetch(`${cfg.baseUrl}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: combined,
        ...net,
      }),
    )
  } finally {
    clearTimeout(timer)
  }
}

export class SceneGen {
  constructor({ root, log, dir, debounceMs, dataDir }) {
    this.root = root
    this.log = log ?? (() => {})
    // 数据目录可注入：验收实例用临时目录，绝不污染基线的场景缓存与额度记录
    this.dataDir = dataDir ?? join(root, 'data')
    this.dir = dir ?? join(this.dataDir, 'scenes')
    // 防抖窗口也可注入（单测跑 180ms，生产默认 1600ms）
    this.debounceOverride = Number.isFinite(debounceMs) ? debounceMs : null
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    this.indexPath = join(this.dir, 'index.json')
    this.index = readJson(this.indexPath, { entries: {} })
    /** key → Promise（生成中的任务，防并发重复生成） */
    this.jobs = new Map()
    /** planId → {timer, running, pending, cancelled, controller, startedAt} */
    this.planJobs = new Map()
    this.listeners = new Set()
    this.ledger = new CostLedger({ dataDir: this.dataDir, log: this.log })
    /** planId → 最新方案对象（state 注入）。排队任务执行时据此取当前搭配，不用过期快照 */
    this.planResolver = null
    // 历史图补小图：老数据只有 3MB 原图，公网下会「一直在加载」。
    // 后台补，不阻塞启动；失败静默（前端回退原图）。
    void this.backfillWebVariants()
  }

  /** 给所有 ready 的旧图补网页版小图（幂等，已存在的跳过）。 */
  async backfillWebVariants() {
    const ready = Object.values(this.index.entries ?? {}).filter((e) => e?.status === 'ready' && e.file)
    if (ready.length === 0) return 0
    let made = 0
    for (const e of ready) {
      if (hasWebVariant(this.dir, e.file)) continue
      const out = await ensureWebVariant(this.dir, e.file)
      if (out) made += 1
    }
    if (made > 0) this.log('scenegen', `已为 ${made} 张历史场景图生成网页小图（原图保留）`)
    return made
  }

  debounceMs() {
    return this.debounceOverride != null ? this.debounceOverride : autoDebounceMs()
  }

  onUpdate(fn) { this.listeners.add(fn) }
  emit(payload) { for (const fn of this.listeners) fn(payload) }

  persist() {
    writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2))
  }

  provider() { return resolveProviderConfig(this.dataDir) }
  vision() { return resolveVisionConfig(this.dataDir) }

  /** 服务状态（不含任何凭证）：给 /api/demo 与体验说明用，只回答「能不能生成、还剩多少额度」。 */
  status() {
    const p = this.provider()
    return {
      available: p.available,
      missing: p.missing,
      model: p.model || null,
      setup: p.setup,
      budget: this.ledger.status(),
    }
  }

  /** 某个场景在缓存里的状态（生成前估价要用） */
  cacheOf(plan, spec) {
    const key = sceneCacheKey(plan, spec)
    const entry = this.index.entries[key] ?? null
    return { key, entry, cached: entry?.status === 'ready' }
  }

  /**
   * 「最近一张给这个方案看过的、真的能看的图」。
   *
   * 先看 sceneChoice.lastKey（切场景/换件时会写），没有再按 planId 找最近一次成功生成的：
   * 生成失败、进程重启后 lastKey 可能缺失，但「上一张有效图」绝不能因此丢掉（需求 I）。
   */
  lastReadyEntry(plan) {
    const byKey = this.index.entries[plan.sceneChoice?.lastKey ?? ''] ?? null
    if (byKey?.status === 'ready') return byKey
    let best = null
    for (const e of Object.values(this.index.entries)) {
      if (e.status !== 'ready' || e.planId !== plan.planId) continue
      if (!best || (Date.parse(e.createdAt ?? '') || 0) > (Date.parse(best.createdAt ?? '') || 0)) best = e
    }
    return best
  }

  /** 方案当前的场景状态（视图模型用，纯读；legacy 图会顺手补一次热点识别，零成本） */
  /** 注入「按 planId 取最新方案」的函数（见 state.setScenegen 里的说明） */
  setPlanResolver(fn) {
    this.planResolver = fn
  }

  /** 拿到该方案当下的版本：排队/补排时绝不能再用几秒前的快照 */
  livePlan(plan) {
    const fresh = this.planResolver?.(plan?.planId)
    return fresh ?? plan
  }

  viewFor(plan) {
    const choice = plan.sceneChoice ?? { place: this.defaultPlace(plan) }
    let spec
    try {
      spec = resolveScene(choice)
    } catch {
      spec = resolveScene({ place: this.defaultPlace(plan) })
    }
    const key = sceneCacheKey(plan, spec)
    const entry = this.index.entries[key] ?? null
    // 最近一次给这个方案看过的图：搭配变了就标 stale，别悄悄继续用旧图冒充新搭配
    const last = this.lastReadyEntry(plan)
    const adaptation = checkAdaptation(plan, spec)
    const p = this.provider()
    const job = this.planJobs.get(plan.planId)

    // 热点必须由「当前检测器」产出：第二阶段留下的固定坐标也有 hotspots 字段，
    // 但它只说明「有坐标」，不说明「坐标对得上衣服」——对这类旧数据必须重算，否则界面会显示
    // 「4/4 可信」而实际点不准（真实踩过的坑）。人工修正过的图不动，尊重人的判断。
    const source = entry?.status === 'ready' ? entry : last?.status === 'ready' ? last : null
    if (source && hotspotsNeedRedetect(source.hotspots)) {
      this.ensureHotspots(source, plan)
    }

    const regions = source?.regions ?? null
    const hotspotMeta = source?.hotspots ?? null
    return {
      spec,
      cacheKey: key,
      prompt: buildScenePrompt(plan, spec),
      status: this.jobs.has(key) || job?.running
        ? 'generating'
        : entry?.status === 'ready'
          ? 'ready'
          : entry?.status === 'error'
            ? 'error'
            : p.available
              ? 'missing'
              : 'unconfigured',
      // image 就是「页面要显示的那张图」：有小图给小图（900px WebP，约 180KB），
      // 没有就退回原图。原图另放在 imageOriginal —— 2.9MB 的 PNG 直接当页面图，
      // 窄带下会一直转圈，舞台看起来像空的（这是公网实测踩到的真问题）。
      image: this.displayUrl(entry?.status === 'ready' ? entry : last?.status === 'ready' ? last : null),
      imageOriginal: this.originalUrl(entry?.status === 'ready' ? entry : last?.status === 'ready' ? last : null),
      // 兼容字段：小图存在时与 image 相同，不存在时为 null
      imageWeb: this.webUrl(entry?.status === 'ready' ? entry : last?.status === 'ready' ? last : null),
      stale: entry?.status === 'ready' ? false : !!last,
      regions,
      hotspots: hotspotMeta,
      provider: { available: p.available, missing: p.missing, model: p.model || null, setup: p.setup },
      vision: { available: this.vision().available, model: this.vision().model || null },
      adaptation,
      // 用户明确说过「我有白鞋 / 棕包」时，这张图有没有照做。
      // null = 没检查（没有抽象自有 / 解码失败），false = 明显不符（界面必须如实说，不能装作满足）。
      ownedCheck: entry?.status === 'ready' ? (entry.ownedCheck ?? null) : null,
      ownedWanted: ownedConstraints(plan),
      generatedAt: entry?.createdAt ?? null,
      model: entry?.model ?? null,
      // 自动更新模式与「正在等下一次生成」的提示（timer=已排队，pending=这轮跑完要补一次）
      auto: { enabled: !!plan.sceneAuto?.enabled, pending: !!(job?.timer || job?.pending), debounceMs: this.debounceMs() },
      lastError: entry?.status === 'error' ? (entry.error ?? '生成失败') : (entry?.lastError ?? null),
      budget: this.ledger.status(),
      cache: { hit: !!entry && entry.status === 'ready', key },
    }
  }

  /** 网页版小图 URL：存在才返回，不存在返回 null（前端回退原图）。 */
  webUrl(entry) {
    if (!entry?.file) return null
    if (!hasWebVariant(this.dir, entry.file)) return null
    return `/scenes/${basename(webPathFor(this.dir, entry.file))}?v=${Date.parse(entry.createdAt ?? '') || 0}`
  }

  /** 原图 URL（PNG/原始文件）。 */
  originalUrl(entry) {
    if (!entry?.file) return null
    return `/scenes/${entry.file}?v=${Date.parse(entry.createdAt ?? '') || 0}`
  }

  /** 页面显示用 URL：小图优先，原图兜底。 */
  displayUrl(entry) {
    return this.webUrl(entry) ?? this.originalUrl(entry)
  }

  defaultPlace(plan) {
    const d = plan.scene?.destination ?? ''
    if (/东京|tokyo/i.test(d)) return 'tokyo-street'
    if (/纽约|new york/i.test(d)) return 'nyc-commute'
    if (/巴黎|paris/i.test(d)) return 'paris-cafe'
    if (/伦敦|london/i.test(d)) return 'london-autumn'
    if (/首尔|seoul/i.test(d)) return 'seoul-fashion'
    if (/上海|shanghai/i.test(d)) return 'shanghai-walk'
    return 'tokyo-street'
  }

  /** 给已有图片补热点（无 API 成本）。legacy 索引兼容用。 */
  ensureHotspots(entry, plan) {
    const file = join(this.dir, entry.file)
    if (!existsSync(file)) return null
    try {
      const { regions, meta } = detectSceneHotspots({ file, plan, log: this.log })
      entry.regions = regions
      entry.hotspots = meta
      this.persist()
      return meta
    } catch (e) {
      this.log('hotspots', `补算失败：${e.message}`)
      return null
    }
  }

  /** 外部把生成好的图登记进缓存（脚本/迁移用）。 */
  register({ planId, plan, spec, file, regions, model }) {
    const key = sceneCacheKey(plan, spec)
    const entry = {
      key,
      planId,
      sceneId: spec.sceneId,
      label: spec.label,
      status: 'ready',
      file,
      prompt: buildScenePrompt(plan, spec),
      provider: 'workbuddy-session',
      model: model ?? 'imagegen',
      regions: regions ?? null,
      createdAt: new Date().toISOString(),
    }
    this.index.entries[key] = entry
    this.ensureHotspots(entry, plan)
    this.persist()
    void ensureWebVariant(this.dir, file)
    this.emit({ type: 'scene.updated', planId, key, status: 'ready' })
    return entry
  }

  /**
   * 切场景（Mode A：只改看法，不动商品）。
   *
   * P10 起没有再「先估价、界面确认」这一步：用户选好场景点应用，就是要看这个场景，
   * 直接开始生成。成本保护不靠这一步——generate() 里仍有预算闸门，超了直接 blocked。
   * 命中缓存则立刻可用、不花钱。
   */
  choose(plan, query, { confirm = true } = {}) {
    const spec = resolveScene(query)
    const { key, cached } = this.cacheOf(plan, spec)
    plan.sceneChoice = { ...query, lastKey: key }
    const cfg = this.provider()
    const estimate = this.ledger.estimate({
      model: cfg.model,
      quality: cfg.quality,
      kind: plan.sceneAuto?.enabled ? 'scene-swap' : 'scene-scene',
      cached,
    })
    const budget = this.ledger.status()
    const blocked = cfg.available && !cached && confirm && !this.ledger.canSpend(estimate)

    if (cfg.available && !cached && confirm && !blocked) {
      this.generate(plan, { kind: 'scene-scene', trigger: 'scene' }).catch((e) => this.log('scenegen', e.message))
    }
    return { view: this.viewFor(plan), estimate, cached, blocked, budget }
  }

  /** 只估价不生成（界面/脚本想知道这次会不会花钱、能不能花时调用）。 */
  quote(plan, query) {
    let spec
    try {
      spec = resolveScene(query ?? plan.sceneChoice ?? { place: this.defaultPlace(plan) })
    } catch {
      spec = resolveScene({ place: this.defaultPlace(plan) })
    }
    const { key, cached } = this.cacheOf(plan, spec)
    const cfg = this.provider()
    return {
      key,
      scene: spec,
      cached,
      available: cfg.available,
      providerSetup: cfg.setup,
      estimate: this.ledger.estimate({
        model: cfg.model,
        quality: cfg.quality,
        kind: 'scene-new',
        cached,
      }),
      budget: this.ledger.status(),
    }
  }

  /**
   * 组装参考图。
   *  - doubao：只传商品图 URL（服务端自己去拉）
   *  - openai：下载成 multipart 文件——有旧场景图放第一张（保人物/构图），
   *    真实商品图在后（还原料）。全部失败就静默降级为纯提示词。
   */
  async buildRefs(cfg, plan) {
    const refs = { urls: [], files: [] }
    if (cfg.refsMode === 'none') return refs
    const cutouts = plan.slots
      .filter((s) => s.item?.image?.cutout && /^https?:/.test(s.item.image.cutout))
      .map((s) => ({ slot: s.slot, url: s.item.image.cutout }))
    if (cfg.refsMode === 'doubao') {
      refs.urls = cutouts.map((c) => c.url)
      return refs
    }
    if (cfg.refsMode !== 'openai') return refs
    // 底图用「上一张有效图」而不是死看 lastKey：换件后 lastKey 可能已经指向新键，
    // 拿它当底图会把人物丢掉；这里永远是当前方案真正显示在图上的那一张。
    const last = this.lastReadyEntry(plan)
    if (last) {
      const p = join(this.dir, last.file)
      if (existsSync(p)) refs.files.push({ role: 'base', name: 'base.png', mime: 'image/png', buffer: readFileSync(p) })
    }
    for (const c of cutouts.slice(0, 6)) {
      try {
        const net = cfg.proxy ? { dispatcher: agentFor(cfg.proxy) } : {}
        const r = await ufetch(c.url, net)
        if (!r.ok) continue
        const mime = r.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
        refs.files.push({ role: 'product', name: `${c.slot}.${mime.includes('png') ? 'png' : 'jpg'}`, mime, buffer: Buffer.from(await r.arrayBuffer()) })
      } catch {
        this.log('scenegen', `参考图下载失败，跳过：${c.url}`)
      }
    }
    return refs
  }

  async generate(plan, { force = false, kind = 'scene-new', trigger = 'manual' } = {}) {
    // 排队到执行的这段时间里方案可能又变了：一律按最新搭配算缓存键，
    // 否则会去生成一张「旧搭配」的图，最新搭配反而没有图。
    plan = this.livePlan(plan)
    const spec = resolveScene(plan.sceneChoice ?? { place: this.defaultPlace(plan) })
    const key = sceneCacheKey(plan, spec)
    const existing = this.index.entries[key]
    if (!force && existing?.status === 'ready') return { key, cached: true }
    if (this.jobs.has(key)) return this.jobs.get(key)
    const cfg = this.provider()
    if (!cfg.available) {
      const err = new Error(`图像生成未配置：${cfg.setup}`)
      err.code = 'SCENEGEN_UNCONFIGURED'
      throw err
    }
    // 预算闸门：付费调用前必须过；缓存命中不进这里
    const estimate = this.ledger.estimate({ model: cfg.model, quality: cfg.quality, kind })
    if (!this.ledger.canSpend(estimate)) {
      const err = new Error(this.ledger.status().note)
      err.code = 'BUDGET_BLOCKED'
      err.estimate = estimate
      err.budget = this.ledger.status()
      throw err
    }

    const slot = this.planJobs.get(plan.planId) ?? {}
    const controller = new AbortController()
    this.planJobs.set(plan.planId, { ...slot, running: true, startedAt: Date.now(), controller, cancelled: false })
    this.log('scenegen', `开始生成 ${plan.planId} key=${key} trigger=${trigger}`)
    const startedAt = new Date().toISOString()

    const job = (async () => {
      try {
        this.emit({ type: 'scene.updated', planId: plan.planId, key, status: 'generating', trigger })
        const refs = await this.buildRefs(cfg, plan)
        let prompt = buildScenePrompt(plan, spec)
        if (cfg.refsMode === 'openai' && refs.files.length) {
          const base = refs.files[0]?.role === 'base'
          prompt =
            (base
              ? 'Use the first reference image as the base: keep the same woman — identical face, pose, body proportions and framing. ' +
                'Change only what the description below implies (garments or environment); preserve everything else. '
              : '') +
            (refs.files.some((f) => f.role === 'product')
              ? 'The product reference images show the actual items she must be wearing — match their color, material and style precisely. '
              : '') +
            prompt
        }
        let call = await callImageApi(cfg, prompt, refs, this.log, controller.signal)
        let ownedCheck = checkOwnedMatch(call.buffer, plan)
        let retried = false
        // 用户明确说过的东西被画错（白鞋→黑靴这一级），在费用可控的范围内纠正一次。
        // 只重画一次，且必须还过得下预算闸门；不做「无限重试直到满意」。
        if (ownedCheck.ok === false && ownedConstraints(plan).length && ownedRetryEnabled() && this.ledger.canSpend(estimate)) {
          const wanted = ownedConstraints(plan)
          const correction = wanted
            .map((c) => `${c.label} (${c.color ?? c.family ?? ''} ${slotNoun(c.slot)})`.replace(/\s+/g, ' ').trim())
            .join(', ')
          const harder =
            `${prompt}, CRITICAL CORRECTION: the previous render got the wearer's own items wrong. ` +
            `She must be wearing exactly these: ${correction}. Do not replace them with any other item, ` +
            `do not change their color, keep them clearly visible in the frame.`
          try {
            const second = await callImageApi(cfg, harder, refs, this.log, controller.signal)
            retried = true
            this.ledger.record({
              at: new Date().toISOString(), kind, operation: `${trigger}:owned-retry`, model: cfg.model, quality: cfg.quality,
              startedAt, finishedAt: new Date().toISOString(), ms: second.ms, usage: second.usage, ok: true,
            })
            call = second
            ownedCheck = { ...checkOwnedMatch(second.buffer, plan), retried: true, first: ownedCheck }
          } catch (e) {
            this.log('scenegen', `按约束重画失败，保留第一版：${e.message}`)
            ownedCheck = { ...ownedCheck, retryError: String(e.message ?? e) }
          }
        }
        const { buffer: buf, usage, ms } = call
        const file = `${key}.png`
        // 覆盖前归档旧图：人工标注过热点的图不能悄悄被新图顶掉
        const prev = this.index.entries[key]
        if (prev?.status === 'ready' && prev.file && existsSync(join(this.dir, prev.file))) {
          this.index.archived = this.index.archived ?? []
          this.index.archived.push({ ...prev, archivedAt: new Date().toISOString() })
          try {
            renameSync(join(this.dir, prev.file), join(this.dir, `${key}-${Date.now()}.png`))
          } catch {
            /* 归档失败不阻塞生成 */
          }
        }
        writeFileSync(join(this.dir, file), buf)
        // 顺手压一份网页小图（~180KB）。失败不影响生成结果，前端会回退原图。
        await ensureWebVariant(this.dir, file)

        const entry = {
          key, planId: plan.planId, sceneId: spec.sceneId, label: spec.label,
          status: 'ready', file, prompt: buildScenePrompt(plan, spec),
          provider: cfg.baseUrl, model: cfg.model,
          revision: plan.revision,
          regions: null,
          createdAt: new Date().toISOString(),
          // 用户自有的东西有没有被画错：ok / false / null（没做成）。界面据此如实提示，不假装满足。
          ownedCheck,
          retried,
        }
        // 生成后立刻识别热点（本地算法，零成本），人手不用动
        const hot = detectSceneHotspots({ file: join(this.dir, file), plan, log: this.log })
        entry.regions = hot.regions
        entry.hotspots = { ...hot.meta, trigger }

        this.index.entries[key] = entry
        this.persist()
        this.ledger.record({
          at: new Date().toISOString(), kind, operation: trigger, model: cfg.model, quality: cfg.quality,
          startedAt, finishedAt: new Date().toISOString(), ms, usage, ok: true,
        })
        this.emit({ type: 'scene.updated', planId: plan.planId, key, status: 'ready', trigger, hotspots: entry.hotspots })
        return { key, cached: false, hotspots: entry.hotspots }
      } catch (e) {
        const aborted = e?.name === 'AbortError' || controller.signal.aborted
        const cancelled = this.planJobs.get(plan.planId)?.cancelled
        const message = aborted ? (cancelled ? '已停止等待（服务商可能仍在计费）' : '超时中止') : String(e.message ?? e)
        const prevEntry = this.index.entries[key]
        if (prevEntry?.status === 'ready') {
          // 同一个键重生成失败：原来的图还能用，绝不能把它覆盖成 error（需求 I）
          this.index.entries[key] = { ...prevEntry, lastError: message, lastErrorAt: new Date().toISOString() }
        } else {
          this.index.entries[key] = {
            key, planId: plan.planId, sceneId: spec.sceneId,
            status: 'error',
            error: message,
            createdAt: new Date().toISOString(),
          }
        }
        this.persist()
        this.ledger.record({
          at: new Date().toISOString(), kind, operation: trigger, model: cfg.model, quality: cfg.quality,
          startedAt, finishedAt: new Date().toISOString(), ok: false, error: e.message,
        })
        this.emit({ type: 'scene.updated', planId: plan.planId, key, status: 'error', error: message, trigger })
        throw e
      } finally {
        this.jobs.delete(key)
        const cur = this.planJobs.get(plan.planId) ?? {}
        // 这一轮结束了：running 必须立刻归零。
        // 否则会死锁（真踩过）：连续换件时防抖窗口比换件间隔短 → 窗口到期看到 running=true
        // → 只标 pending 就返回；上一轮 finally 又只排下一次生成、不清 running → 新窗口到期
        // 仍然看到 running=true → 再标 pending……「正在更新穿搭图」永远挂着，一张图都出不来。
        this.planJobs.set(plan.planId, { ...cur, running: false, timer: null, controller: null })
        // 自动模式：如果这轮生成期间方案又变了，等防抖窗口结束后再补一次。
        // 这里必须重新取最新方案 —— 用本轮生成时的那份快照排队，算出来的键是旧的，
        // 会直接命中缓存、什么也不生成（最新搭配永远没图，实测就是这个）。
        if (cur?.pending) {
          this.log('scenegen', `结束 ${plan.planId} key=${key}，生成期间又改过，排队补一次`)
          this.scheduleRegen(this.livePlan(plan), { reason: 'coalesced' })
        } else {
          this.log('scenegen', `结束 ${plan.planId} key=${key}，无待办`)
        }
      }
    })()
    this.jobs.set(key, job)
    return job
  }

  /**
   * 自动更新模式：换件后延迟合并生成。
   * 连续换三件只生成一次；生成期间又改了就排到下一轮（旧结果按缓存键落库，不会覆盖新方案）。
   */
  scheduleRegen(plan, { reason = 'swap' } = {}) {
    if (!plan.sceneAuto?.enabled) return { scheduled: false, reason: 'auto-off' }
    const cur = this.planJobs.get(plan.planId) ?? {}
    clearTimeout(cur.timer)
    this.log('scenegen', `排队 ${plan.planId}（${reason}）：running=${!!cur.running} pending=${!!cur.pending} 窗口=${this.debounceMs()}ms`)
    const timer = setTimeout(() => {
      const state = this.planJobs.get(plan.planId) ?? {}
      if (state.running) {
        // 正在生成：标记 pending，等这轮结束再排
        this.log('scenegen', `窗口到期 ${plan.planId}，但这轮还在跑 → 标记 pending`)
        this.planJobs.set(plan.planId, { ...state, pending: true, timer: null })
        return
      }
      this.log('scenegen', `窗口到期 ${plan.planId}，开始生成`)
      this.planJobs.set(plan.planId, { ...state, timer: null, pending: false })
      // 防抖窗口里可能又换了几件：用最新方案，不是排队时那份快照
      const current = this.livePlan(plan)
      const spec = resolveScene(current.sceneChoice ?? { place: this.defaultPlace(current) })
      const { cached } = this.cacheOf(current, spec)
      if (cached) {
        this.emit({ type: 'scene.updated', planId: current.planId, key: sceneCacheKey(current, spec), status: 'ready', cached: true })
        return
      }
      this.generate(current, { kind: 'scene-swap', trigger: `auto:${reason}` }).catch((e) => this.log('scenegen', `自动生成失败：${e.message}`))
    }, this.debounceMs())
    this.planJobs.set(plan.planId, { ...cur, timer })
    const queued = this.livePlan(plan)
    this.emit({ type: 'scene.updated', planId: plan.planId, key: sceneCacheKey(queued, resolveScene(queued.sceneChoice ?? { place: this.defaultPlace(queued) })), status: 'queued' })
    return { scheduled: true, debounceMs: this.debounceMs() }
  }

  /**
   * 停止等待：取消防抖 + 中止请求。
   * 说明（必须如实）：本地立即停止展示等待；服务商侧可能已经把这次请求计费，无法撤回。
   */
  cancelWait(planId, plan) {
    const cur = this.planJobs.get(planId) ?? {}
    clearTimeout(cur.timer)
    try {
      cur.controller?.abort()
    } catch {
      /* ignore */
    }
    this.planJobs.set(planId, { ...cur, timer: null, pending: false, cancelled: true })
    this.emit({ type: 'scene.updated', planId, key: plan ? sceneCacheKey(plan, resolveScene(plan.sceneChoice ?? { place: this.defaultPlace(plan) })) : null, status: 'cancelled' })
    return { ok: true, note: '已停止等待；若请求已发出，服务商可能仍会计费，以账单为准' }
  }

  setAuto(plan, enabled) {
    plan.sceneAuto = { enabled: !!enabled, at: new Date().toISOString() }
    if (!enabled) {
      const cur = this.planJobs.get(plan.planId) ?? {}
      clearTimeout(cur.timer)
      this.planJobs.set(plan.planId, { ...cur, timer: null, pending: false })
    }
    return { enabled: !!plan.sceneAuto.enabled }
  }

  /** 人工修正某个槽位的热点（按缓存键存，图片不变就一直有效）。 */
  correctHotspot(plan, slot, region) {
    const choice = plan.sceneChoice ?? { place: this.defaultPlace(plan) }
    const spec = resolveScene(choice)
    const key = sceneCacheKey(plan, spec)
    const entry = this.index.entries[key] ?? this.index.entries[plan.sceneChoice?.lastKey ?? '']
    if (!entry) {
      const err = new Error('当前还没有可修正的图片')
      err.code = 'NO_SCENE_IMAGE'
      throw err
    }
    if (!['outerwear', 'top', 'bottom', 'shoes', 'bag'].includes(slot)) {
      const err = new Error(`未知搭配位：${slot}`)
      err.code = 'SLOT_NOT_FOUND'
      throw err
    }
    entry.regions = { ...(entry.regions ?? {}), [slot]: manualHotspot(region) }
    entry.hotspots = {
      ...(entry.hotspots ?? {}),
      at: new Date().toISOString(),
      slots: {
        ...(entry.hotspots?.slots ?? {}),
        [slot]: { status: 'ok', confidence: 1, method: 'manual', reason: '人工修正', colorUsed: null },
      },
    }
    this.persist()
    this.emit({ type: 'scene.updated', planId: plan.planId, key: entry.key, status: 'ready', hotspots: entry.hotspots })
    return this.viewFor(plan)
  }

  /** 重新识别（图片不变时不花钱）。 */
  recomputeHotspots(plan) {
    const choice = plan.sceneChoice ?? { place: this.defaultPlace(plan) }
    const spec = resolveScene(choice)
    const key = sceneCacheKey(plan, spec)
    const entry = this.index.entries[key] ?? this.index.entries[plan.sceneChoice?.lastKey ?? '']
    if (!entry?.file) {
      const err = new Error('当前还没有可识别的图片')
      err.code = 'NO_SCENE_IMAGE'
      throw err
    }
    const meta = this.ensureHotspots(entry, plan)
    this.emit({ type: 'scene.updated', planId: plan.planId, key: entry.key, status: 'ready', hotspots: meta })
    return this.viewFor(plan)
  }

  usage() {
    return { budget: this.ledger.status(), log: this.ledger.tail(12) }
  }
}
