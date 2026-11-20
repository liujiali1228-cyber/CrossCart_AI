/**
 * CrossCart Bridge：状态服务 + Studio 静态站点。
 *
 * 端口 8790（可用 CROSSCART_PORT 覆盖）。
 * 两个客户端共用这一份状态：
 *   - dsh 插件（工具调用，服务端 fetch）
 *   - Studio 页面（浏览器，REST + SSE）
 */
import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual, randomBytes } from 'node:crypto'
import { Workspace, loadSeed, assetUrl } from './state.mjs'
import { refreshLiveCatalog, readLiveCache, LIVE_STORES, classifySlot } from './live-catalog.mjs'
import { ChatRuntime } from './chat.mjs'
import { planContext } from './plan-context.mjs'
import { SceneGen } from './scenegen.mjs'
import { listScenes, suggestScenes, resolveScene, prefsBrief } from '../../core/dist/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
/**
 * 数据目录（state.json / 场景缓存 / 图像配置 / 额度记录）可被 CROSSCART_DATA_DIR 覆盖。
 * 用途：验收起一个隔离实例——真实的代码与商品数据，临时的状态与缓存，绝不改基线数据。
 */
const DATA = process.env.CROSSCART_DATA_DIR ? resolve(process.env.CROSSCART_DATA_DIR) : join(ROOT, 'data')
/**
 * 托管平台（Render / Railway / 内置 App Publishing）会给一个 PORT 并要求监听 0.0.0.0。
 * 本机开发仍然只监听 127.0.0.1（不要把开发实例暴露到局域网/公网）。
 */
const PORT = Number(process.env.PORT ?? process.env.CROSSCART_PORT ?? 8790)
const HOST = process.env.CROSSCART_HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1')
const CACHE = join(DATA, 'live', 'catalog.json')
/** 仓库里那份「真实商品」缓存只作为只读回退：隔离实例没网也能立刻跑起来。 */
const SEED_CACHE = join(ROOT, 'data', 'live', 'catalog.json')
const STUDIO = join(ROOT, 'studio')
const LOG = (...a) => console.log('[bridge]', ...a)

/**
 * 公网测试版的访问保护（F4.5）。
 *
 * 为什么不只藏入口：状态是全局单机的，任何人拿到 URL 都能改偏好/建方案。
 * 设了 CROSSCART_ACCESS_TOKEN 后，所有请求都必须带同一个口令：
 *   - 浏览器：?t=<token> 首次进入 → 种 HttpOnly Cookie → 302 去掉 URL 里的 token
 *   - 脚本：请求头 x-cc-token
 * 没设 token 时行为与本地开发完全一致（不引入登录负担）。
 */
const ACCESS_TOKEN = String(process.env.CROSSCART_ACCESS_TOKEN ?? '').trim()
const DEMO_MODE = process.env.CROSSCART_DEMO_MODE === '1'
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * 公开模式（P10）：由 `npm run serve:public` / Dockerfile / render.yaml 设为 1。
 * 它只决定「哪些东西不该对陌生人开放」，不引入账号体系：
 *   - 管理 / 调试接口默认关闭（配了 CROSSCART_ADMIN_TOKEN 才可用）；
 *   - 健康检查只回最小信息；
 *   - 打开按 IP 的限流。
 */
const PUBLIC_MODE = process.env.CROSSCART_PUBLIC === '1'
/** 只有明确部署在反向代理/平台后面才信任 X-Forwarded-For，否则任何人都能伪造来源绕过限流。 */
const TRUST_PROXY = process.env.CROSSCART_TRUST_PROXY === '1'
const ADMIN_TOKEN = String(process.env.CROSSCART_ADMIN_TOKEN ?? '').trim()

/**
 * 限流：进程内滑动窗口，重启即清零。
 * 分两层 —— 全实例额度（防止一个人把整月额度刷光）与按 IP 额度（防止单个来源高频打接口）。
 * 付费路径（AI 对话 / 生图）两层都要过；普通 API 只过 IP 频率。
 */
const RATE_LIMITS = {
  chat: Number(process.env.CROSSCART_RATE_CHAT_PER_HOUR ?? (DEMO_MODE ? 40 : 0)),
  image: Number(process.env.CROSSCART_RATE_IMAGE_PER_HOUR ?? (DEMO_MODE ? 6 : 0)),
  chatIp: Number(process.env.CROSSCART_RATE_CHAT_PER_IP_PER_HOUR ?? (PUBLIC_MODE ? 12 : 0)),
  imageIp: Number(process.env.CROSSCART_RATE_IMAGE_PER_IP_PER_HOUR ?? (PUBLIC_MODE ? 3 : 0)),
  /** 任意 /api 请求：每分钟每 IP 上限 */
  apiIp: Number(process.env.CROSSCART_RATE_API_PER_IP_PER_MIN ?? (PUBLIC_MODE ? 90 : 0)),
  /** 写操作（POST/PATCH/DELETE）：每分钟每 IP 上限，挡住连点与重复提交 */
  writeIp: Number(process.env.CROSSCART_RATE_WRITE_PER_IP_PER_MIN ?? (PUBLIC_MODE ? 30 : 0)),
}
const rateHits = new Map()
function checkRate(key, limit, windowMs = 3600_000) {
  if (!limit || limit <= 0) return { ok: true, remaining: null }
  const now = Date.now()
  const since = now - windowMs
  const list = (rateHits.get(key) ?? []).filter((t) => t > since)
  if (list.length >= limit) {
    rateHits.set(key, list)
    return { ok: false, remaining: 0, limit, retryAfter: Math.ceil((list[0] + windowMs - now) / 1000) }
  }
  list.push(now)
  rateHits.set(key, list)
  return { ok: true, remaining: limit - list.length, limit }
}
// 定期清掉过期桶，避免长期运行时 Map 无限增长（unref：不阻止进程退出）
const rateSweep = setInterval(() => {
  const now = Date.now()
  for (const [k, list] of rateHits) if (!list.some((t) => t > now - 3600_000)) rateHits.delete(k)
}, 10 * 60_000)
rateSweep.unref?.()

/** 请求来源：只有在显式信任代理时才读转发头，避免伪造。 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')[0]
      .trim()
    if (xff) return xff
    const real = req.headers['x-real-ip']
    if (real) return String(real).trim()
  }
  return String(req.socket?.remoteAddress ?? 'unknown')
}

/** 会花钱的入口：AI 对话、手动重画、切场景（可能生成）、自动模式下的换件。 */
function paidKindOf(method, pathname, bodyAuto = false) {
  if (method === 'POST' && pathname === '/api/chat') return 'chat'
  if (method !== 'POST') return null
  if (/^\/api\/plans\/[^/]+\/scene\/regenerate$/.test(pathname)) return 'image'
  if (/^\/api\/plans\/[^/]+\/scene$/.test(pathname)) return 'image'
  if (/^\/api\/plans\/[^/]+\/swap$/.test(pathname) && bodyAuto) return 'image'
  return null
}

/**
 * 管理 / 调试接口：公开模式下不给陌生人。
 * 包括内部额度记录、目录刷新、热点重算与人工修正（开发者工具，不是消费者功能）。
 */
function isAdminPath(method, pathname) {
  if (method === 'POST' && pathname === '/api/catalog/refresh') return true
  if (method === 'GET' && pathname === '/api/scenes/budget') return true
  if (method === 'POST' && /^\/api\/plans\/[^/]+\/scene\/hotspots(\/correct)?$/.test(pathname)) return true
  return false
}
function adminAllowed(req, url) {
  if (!PUBLIC_MODE) return true
  if (!ADMIN_TOKEN) return false
  const provided = req.headers['x-cc-admin'] ?? url.searchParams.get('admin') ?? ''
  return Boolean(provided) && safeEqual(provided, ADMIN_TOKEN)
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

function cookieOf(req, name) {
  const raw = req.headers.cookie ?? ''
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

const LOGIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>CrossCart AI · 测试版</title>
<style>
  :root{color-scheme:light}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1ea;color:#1c1a17;
       font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .card{width:min(92vw,380px);background:#fffdf9;border:1px solid #ded7c9;border-radius:16px;padding:32px}
  h1{font-size:19px;margin:0 0 6px;font-weight:600;letter-spacing:-.01em}
  p{color:#6b6459;font-size:13px;margin:0 0 20px}
  label{display:block;font-size:12px;color:#6b6459;margin-bottom:6px}
  input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #ded7c9;border-radius:9px;font-size:14px;background:#fff}
  button{width:100%;margin-top:12px;padding:11px 12px;border:0;border-radius:9px;background:#1c1a17;color:#fff;font-size:14px;cursor:pointer}
  .err{margin-top:12px;font-size:12.5px;color:#b4322a}
  footer{margin-top:22px;font-size:11.5px;color:#9b9284}
</style></head>
<body><form class="card" method="GET" action="/__login">
  <h1>CrossCart AI · 内部测试版</h1>
  <p>这是一个受保护的测试环境。输入访问口令后即可体验 AI 搭配、换件与偏好管理。</p>
  <label for="t">访问口令</label>
  <input id="t" name="t" type="password" autocomplete="current-password" placeholder="由项目负责人提供" required />
  <button type="submit">进入测试版</button>
  __ERROR__
  <footer>数据为独立演示副本；刷新不会丢，但测试环境可能随时重启。</footer>
</form></body></html>`

function loginPage(res, error = '') {
  res.writeHead(error ? 401 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(LOGIN_HTML.replace('__ERROR__', error ? `<div class="err">口令不正确，请重试。</div>` : ''))
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

const ws = new Workspace({ root: ROOT, dataDir: DATA })
// 先吃掉上一次缓存，再在后台刷新（数据目录优先；隔离实例回退到仓库里的那份）
const cached = readLiveCache(CACHE) ?? (CACHE !== SEED_CACHE ? readLiveCache(SEED_CACHE) : null)
if (cached) ws.setLive(cached)

const sseClients = new Set()

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(frame)
    } catch {
      sseClients.delete(res)
    }
  }
}

/**
 * AI 对话：由 bridge 托管一个 dsh SDK 运行时。
 * 模型调用、工具循环、会话持久化都在 dsh 里；这里只负责转发与广播。
 */
const chat = new ChatRuntime({
  // 演示时把 agent 的工作目录挪到数据目录：模型上下文里就不会出现项目路径
  cwd: process.env.CROSSCART_AGENT_CWD || ROOT,
  patch: join(ROOT, 'packages', 'dsh-plugin', 'cordis.yml'),
  // 跟着 DATA 走：CROSSCART_DATA_DIR 起隔离实例时，验收对话不能写进真实会话记录
  transcriptPath: join(DATA, 'chat.json'),
  log: LOG,
  onUpdate: (snap) => broadcast('chat', snap),
})

/** 场景图生成：provider 可插拔（env 或 data/scenegen.config.json），缓存内容寻址。 */
const scenegen = new SceneGen({ root: ROOT, dataDir: DATA, log: LOG })
ws.setScenegen(scenegen)
scenegen.onUpdate((ev) => broadcast('scene.updated', ev))

/**
 * 「这段对话里用户说过什么」——只给「抽象已有」的来源校验用。
 *
 * 为什么不把整段历史给它：用户说「我有白鞋」必须来自**当前这段对话**，
 * 上一段对话的声明在 markNewChat() 之后就不再算数，否则新开聊天也会自动继承。
 */
ws.setUserTextSource(() => {
  const epoch = ws.chatEpochStart
  return (chat.state?.messages ?? [])
    .filter((m) => m.role === 'user' && (!epoch || String(m.at ?? '') >= epoch))
    .map((m) => String(m.text ?? ''))
    .join('\n')
})

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body)
  const payload = isJson ? JSON.stringify(body) : body
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/** 演示方案：真实商品 + 已有牛仔裤，故意留一个「贵且慢」的初始状态好演示换件 */
function createDemoPlan() {
  const catalog = ws.catalog.filter((c) => c.shipping.status !== 'unavailable')
  // 优先真实商品；真实商品里先挑浅色、便宜的
  const preferLive = (list) => {
    const live = list.filter((c) => c.sourceKind === 'live')
    return (live.length ? live : list).sort((a, b) => a.price.amount - b.price.amount)
  }
  const pick = (predicate) => preferLive(catalog.filter(predicate))[0] ?? null

  const outerwear =
    pick((c) => c.category === 'outerwear' && c.colorFamily === 'light' && c.price.amount <= 220) ??
    pick((c) => c.category === 'outerwear' && c.price.amount <= 220) ??
    pick((c) => c.category === 'outerwear')
  // 上衣换一家店、换个颜色，别整套都是同一件米色针织
  const top =
    pick((c) => c.category === 'top' && c.colorFamily === 'light' && c.price.amount <= 70 && c.vendor !== outerwear?.vendor) ??
    pick((c) => c.category === 'top' && c.price.amount <= 70) ??
    pick((c) => c.category === 'top')
  const shoes =
    pick((c) => c.category === 'shoes' && c.colorFamily === 'light' && c.price.amount <= 140) ??
    pick((c) => c.category === 'shoes' && c.price.amount <= 140) ??
    pick((c) => c.category === 'shoes')

  const slots = []
  if (outerwear) slots.push({ slot: 'outerwear', status: 'to_buy', productId: outerwear.productId, reason: '浅色外套，拍照出片' })
  if (top) slots.push({ slot: 'top', status: 'to_buy', productId: top.productId, reason: '基础色内搭' })
  slots.push({ slot: 'bottom', status: 'owned', productId: 'own_dark_jeans', reason: '已有单品' })
  if (shoes) slots.push({ slot: 'shoes', status: 'to_buy', productId: shoes.productId, reason: '好走路的平底' })
  slots.push({ slot: 'bag', status: 'empty' })

  const today = ws.today
  const deadline = new Date(Date.parse(today) + 12 * 86400000).toISOString().slice(0, 10)
  return ws.createPlan({
    label: '东京 3 天 · 方案 A',
    scene: { type: 'travel', destination: 'Tokyo', days: 3 },
    budgetLimit: 320,
    arrivalBy: deadline,
    shipTo: 'CN',
    slots,
    // 示例方案也要走同一条规矩：这条「已有」是**示例设定**，不是用户说的。
    // 写进 ownedClaims 是为了让页面能如实标成「示例假设」，而不是伪装成用户的衣橱。
    ownedClaims: [{ productId: 'own_dark_jeans', quote: '示例方案：假设你已有一条深色直筒牛仔裤' }],
  })
}

const routes = {
  'GET /api/health': () =>
    PUBLIC_MODE
      ? // 公网：只回答「我还活着」，不回方案列表与会话 id（那些是内部状态）
        { ok: true, version: VERSION }
      : {
          ok: true,
          catalog: {
            live: ws.liveItems.length,
            seed: ws.seed.items.length,
            meta: ws.liveMeta,
          },
          plans: [...ws.plans.keys()],
          chat: { ready: chat.ready, running: chat.state.running, sessionId: chat.state.sessionId },
        },

  /**
   * 环境自述：版本、能力和限制。只返回非敏感信息（不含密钥、绝对路径、用户偏好）。
   * 公开模式下把「额度 / 预算 / 配置缺口」这类内部运营信息从响应里摘掉。
   */
  'GET /api/demo': () => {
    const sg = scenegen.status()
    return {
      ok: true,
      demo: DEMO_MODE,
      version: VERSION,
      authRequired: Boolean(ACCESS_TOKEN),
      dataIsolated: DATA !== join(ROOT, 'data'),
      limits: {
        chatPerHour: RATE_LIMITS.chat || null,
        imagePerHour: RATE_LIMITS.image || null,
        chatPerHourPerVisitor: RATE_LIMITS.chatIp || null,
        imagePerHourPerVisitor: RATE_LIMITS.imageIp || null,
      },
      catalog: { live: ws.liveItems.length, seed: ws.seed.items.length, fetchedAt: ws.liveMeta?.fetchedAt ?? null },
      sceneGen: PUBLIC_MODE ? { available: sg.available, model: sg.model ?? null } : sg,
      chatModel: process.env.CROSSCART_LLM_MODEL ?? 'deepseek-chat',
      knownLimits: [
        '只有一个共享的测试数据副本：所有人看到同一份方案与偏好，请不要填真实个人信息',
        '商品图来自真实店铺 CDN，个别图片可能加载失败（会有占位）',
        '关税无法估算，始终保持「未知」，不当成 0',
        'AI 推断的偏好必须由使用者确认后才会生效',
      ],
    }
  },

  // chatEpochStart：这段对话从什么时候开始（新开聊天会刷新）。
  // 前端不用它，但「哪句声明算这段对话里说的」必须可查，否则无法验收 P5。
  'GET /api/chat': () => ({ ...chat.snapshot(), chatEpochStart: ws.chatEpochStart ?? null }),

  'POST /api/chat': async (req) => {
    const body = (await readBody(req)) ?? {}
    const text = String(body.text ?? '').trim()
    if (!text) return send(req.res, 400, { error: '消息不能为空', code: 'EMPTY' })
    const planId = body.planId ?? [...ws.plans.keys()].at(-1) ?? null
    try {
      return await chat.send(text, planId ? planContext(ws, planId) : planContext(ws, '__none__'))
    } catch (e) {
      return send(req.res, e.code === 'BUSY' ? 409 : 500, { error: e.message, code: e.code ?? 'CHAT_ERROR' })
    }
  },

  'POST /api/chat/stop': async () => chat.stop(),

  // 新开聊天同时划一条时间线：之前记下的「已拥有」声明降级为历史，
  // 不再作为「用户这次说过」注入上下文（P5「新开聊天」用例）。
  'POST /api/chat/reset': async () => {
    ws.markNewChat()
    const snap = await chat.reset()
    return { ...snap, chatEpochStart: ws.chatEpochStart ?? null }
  },

  /* ------------------------------------------------ 场景图（Mode A/B 的载体） */

  /** 场景库 + 当前方案的推荐场景 */
  'GET /api/scenes': (req, url) => {
    const planId = url.searchParams.get('planId')
    const suggested = planId ? suggestScenes(ws.getPlan(planId), 6) : []
    return { scenes: listScenes(), suggested }
  },

  /** 图像额度（月度预算 + 最近调用日志，日志里没有任何凭证） */
  'GET /api/scenes/budget': () => scenegen.usage(),

  /** 生成前估价：不产生费用，只回答「要不要花钱、花多少、能不能花」 */
  'GET /api/scenes/quote': (req, url) => {
    const planId = url.searchParams.get('planId')
    const plan = ws.getPlan(planId)
    const query = url.searchParams.get('place')
      ? {
          place: url.searchParams.get('place'),
          time: url.searchParams.get('time') ?? undefined,
          season: url.searchParams.get('season') ?? undefined,
          weather: url.searchParams.get('weather') ?? undefined,
        }
      : url.searchParams.get('custom')
        ? { custom: url.searchParams.get('custom') }
        : null
    return scenegen.quote(plan, query)
  },

  'GET /api/catalog': (req, url) => {
    const q = url.searchParams
    let items = ws.catalog
    const category = q.get('category')
    const family = q.get('colorFamily')
    const maxPrice = Number(q.get('maxPrice') ?? NaN)
    const search = (q.get('q') ?? '').toLowerCase()
    if (category) items = items.filter((c) => c.category === category)
    if (family) items = items.filter((c) => c.colorFamily === family)
    if (Number.isFinite(maxPrice)) items = items.filter((c) => (c.price.amount ?? 0) <= maxPrice)
    if (search) items = items.filter((c) => `${c.title} ${c.color}`.toLowerCase().includes(search))
    const limit = Number(q.get('limit') ?? 60)
    // 已有单品的「占位条目」：只有 productId，价格 0、无物流。
    // 单独一个字段，不混进 items（它不是可买商品，混进去会被排序/预算逻辑当成候选）。
    // 注意措辞：它是**示例占位**，不代表用户真的拥有 —— 只有用户自己说过才成立。
    const ownedItems = ws.owned
      .filter((c) => !category || c.category === category)
      .map((c) => ({
        productId: c.productId,
        title: c.title,
        category: c.category,
        color: c.color,
        colorFamily: c.colorFamily,
        sizes: c.sizes,
        note: '示例已有单品占位',
      }))
    return {
      total: items.length,
      owned: ownedItems,
      items: items.slice(0, limit).map((c) => ({
        productId: c.productId,
        title: c.title,
        category: c.category,
        color: c.color,
        colorFamily: c.colorFamily,
        vendor: c.vendor ?? '种子目录',
        sourceKind: c.sourceKind ?? 'seed',
        sizes: c.sizes,
        price: c.price.amount,
        currency: c.price.currency,
        shipping: c.shipping.fee?.amount ?? null,
        shippingStatus: c.shipping.status,
        etaDays: c.shipping.etaDays,
        note: c.shipping.note ?? null,
        url: c.url || null,
        image: assetUrl(c.image.cutout),
      })),
    }
  },

  'POST /api/catalog/refresh': async () => {
    const live = await refreshLiveCatalog({ cachePath: CACHE, log: LOG })
    ws.setLive(live)
    broadcast('catalog.updated', { live: live.items.length, meta: live.meta })
    return { ok: true, live: live.items.length, meta: live.meta }
  },

  'GET /api/plans': () => ({
    plans: [...ws.plans.values()].map((p) => {
      const vm = ws.viewModel(p)
      return {
        planId: p.planId,
        label: p.label,
        revision: p.revision,
        updatedAt: vm.updatedAt,
        total: vm.cost.newItemsTotal,
        budget: vm.cost.budget,
        arrival: vm.arrival,
        buyableCount: vm.purchases.buyableCount,
        slots: vm.slots,
        // 首页封面用：只读派生字段，不参与业务判断
        scene: {
          status: vm.sceneView?.status ?? 'missing',
          image: vm.sceneView?.image ?? null,
          imageOriginal: vm.sceneView?.imageOriginal ?? null,
          label: vm.sceneView?.spec?.label ?? null,
          destination: vm.sceneView?.spec?.destination ?? null,
        },
      }
    }),
  }),

  'POST /api/plans': async (req) => {
    const body = await readBody(req)
    if (!body) return send(req.res, 400, { error: 'invalid json' })
    // 硬冲突会在这里抛 PREF_CONFLICT（422），方案不会落库
    const plan = ws.createPlan(body)
    broadcast('plan.created', { planId: plan.planId })
    // 建方案路径不重排候选，但要如实告诉调用方：哪些商品被豁免、预算/到货/收货地是什么结论。
    const pref = ws.planValidation(plan)
    return {
      ...ws.viewModel(plan),
      prefConflicts: pref.violations,
      prefExempt: pref.exempt,
      prefApplied: pref.applied,
      prefUnmapped: pref.unmapped,
      prefChecks: pref.checks,
      prefExceptions: plan.constraints.prefExceptions ?? [],
    }
  },

  'POST /api/plans/demo': () => {
    const plan = createDemoPlan()
    broadcast('plan.created', { planId: plan.planId })
    return ws.viewModel(plan)
  },
}

function planRoute(method, pathname, req, url) {
  const m = pathname.match(/^\/api\/plans\/([^/]+)(?:\/(candidates|swap|lock|remove))?$/)
  if (!m) return null
  const planId = decodeURIComponent(m[1])
  const action = m[2]
  if (method === 'DELETE' && !action) {
    // 演示环境清理：删掉方案本身，不动偏好与场景图缓存
    const res = ws.removePlan(planId)
    broadcast('plan.deleted', { planId })
    return res
  }
  if (method === 'GET' && !action) {
    const plan = ws.getPlan(planId)
    const pref = ws.planValidation(plan)
    // 偏好后来改了，老方案也可能出现新冲突 —— 如实显示，不因为「建的时候没冲突」就一直报平安
    return {
      ...ws.viewModel(plan),
      prefConflicts: pref.violations,
      prefExempt: pref.exempt,
      prefApplied: pref.applied,
      prefUnmapped: pref.unmapped,
      prefChecks: pref.checks,
      prefExceptions: plan.constraints.prefExceptions ?? [],
    }
  }
  if (method === 'GET' && action === 'candidates') {
    const slot = url.searchParams.get('slot')
    const strategy = url.searchParams.get('strategy') ?? 'similar'
    const includeUnconfirmed = url.searchParams.get('includeUnconfirmed') === '1'
    const sort = url.searchParams.get('sort') ?? 'recommended'
    const view = ws.candidateView(planId, slot, strategy, { includeUnconfirmed, sort })
    // excluded / relaxed / applied / unmapped：偏好为什么改了这个列表，逐项可查
    return {
      candidates: view.views,
      excluded: view.excluded,
      relaxed: view.relaxed,
      blockedBy: view.blockedBy,
      applied: view.applied,
      unmapped: view.unmapped,
    }
  }
  return null
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const pathname = decodeURIComponent(url.pathname)
  const method = req.method ?? 'GET'
  req.res = res

  if (method === 'OPTIONS') return send(res, 204, '')

  try {
    /* ---------------------------------------------------- 访问保护 / 限流 */
    if (ACCESS_TOKEN) {
      if (pathname === '/__login') {
        const t = url.searchParams.get('t') ?? ''
        if (!safeEqual(t, ACCESS_TOKEN)) return loginPage(res, 'bad')
        res.writeHead(302, {
          location: '/',
          'set-cookie': `cc_access=${encodeURIComponent(ACCESS_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
          'cache-control': 'no-store',
        })
        return res.end()
      }
      const provided = url.searchParams.get('t') ?? req.headers['x-cc-token'] ?? cookieOf(req, 'cc_access')
      if (!provided || !safeEqual(provided, ACCESS_TOKEN)) {
        // 健康检查是插件的「桥是否活着」探针：允许匿名，但只回最小信息
        if (pathname === '/api/health') return send(res, 200, { ok: true, authRequired: true })
        if (pathname.startsWith('/api/')) {
          return send(res, 401, { error: '这个测试环境需要访问口令', code: 'UNAUTHORIZED' })
        }
        return loginPage(res)
      }
      // 用 URL 里的口令打开页面：种 cookie 后 302，别把口令留在地址栏与浏览历史里
      if (url.searchParams.get('t')) {
        const clean = new URL(url.toString())
        clean.searchParams.delete('t')
        res.writeHead(302, {
          location: `${clean.pathname}${clean.search}`,
          'set-cookie': `cc_access=${encodeURIComponent(ACCESS_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
          'cache-control': 'no-store',
        })
        return res.end()
      }
    }

    /* 限流：先按来源频率，再按付费入口的两层额度（全实例 + 单 IP）。
       超限只回一句人话，不暴露内部费用与额度数字。
       /api/health 例外：它是平台探针，被限流掉会让平台误判实例已死。 */
    if (pathname.startsWith('/api/') && pathname !== '/api/health') {
      const ip = clientIp(req)
      const tooFrequent = () =>
        send(res, 429, { error: '请求有点频繁，请稍后再试', code: 'RATE_LIMITED', retryAfter: 60 })

      if (RATE_LIMITS.apiIp > 0) {
        const r = checkRate(`api:${ip}`, RATE_LIMITS.apiIp, 60_000)
        if (!r.ok) return tooFrequent()
      }
      if (RATE_LIMITS.writeIp > 0 && method !== 'GET' && method !== 'OPTIONS') {
        const r = checkRate(`write:${ip}`, RATE_LIMITS.writeIp, 60_000)
        if (!r.ok) return tooFrequent()
      }

      // 自动模式下的换件会在服务端直接排队出图，也计入生图频次
      let autoOn = false
      if (method === 'POST' && /^\/api\/plans\/[^/]+\/swap$/.test(pathname)) {
        try {
          autoOn = ws.getPlan(decodeURIComponent(pathname.split('/')[3]))?.sceneAuto?.enabled === true
        } catch {
          autoOn = false
        }
      }
      const kind = paidKindOf(method, pathname, autoOn)
      if (kind) {
        const label = kind === 'chat' ? 'AI 对话' : '穿搭图生成'
        const hit = (key, limit) => (limit > 0 ? checkRate(key, limit) : { ok: true })
        const total = hit(kind, RATE_LIMITS[kind])
        const perIp = total.ok ? hit(`${kind}:${ip}`, RATE_LIMITS[`${kind}Ip`]) : total
        const over = !total.ok ? total : !perIp.ok ? perIp : null
        if (over) {
          const mins = Math.max(1, Math.ceil((over.retryAfter ?? 60) / 60))
          return send(res, 429, {
            error: `${label}有点频繁，请 ${mins} 分钟后再试`,
            code: 'RATE_LIMITED',
            retryAfter: over.retryAfter ?? 60,
          })
        }
      }
    }

    /* 管理 / 调试接口：公开模式下默认不存在（配了 admin token 才放行） */
    if (isAdminPath(method, pathname) && !adminAllowed(req, url)) {
      LOG('admin blocked', method, pathname, clientIp(req))
      return send(res, 404, { error: `no route ${method} ${pathname}` })
    }

    // SSE
    if (pathname === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      })
      res.write(`event: hello\ndata: ${JSON.stringify({ plans: [...ws.plans.keys()] })}\n\n`)
      sseClients.add(res)
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          /* ignore */
        }
      }, 20000)
      req.on('close', () => {
        clearInterval(ping)
        sseClients.delete(res)
      })
      return
    }

    // 动态 plan 路由
    const planLike = planRoute(method, pathname, req, url)
    if (planLike !== null && planLike !== undefined) return send(res, 200, planLike)

    /* Mode A：只切场景，不动商品（有断言守着）。
       P10：点「应用」就是明确要切这个场景，服务端不再返回「请确认生成」——
       预算闸门仍在 choose() 里：额度用完时 blocked=true，一张图也不画。 */
    if (method === 'POST' && /^\/api\/plans\/[^/]+\/scene$/.test(pathname)) {
      const planId = decodeURIComponent(pathname.split('/')[3])
      const body = (await readBody(req)) ?? {}
      const idsBefore = ws.getPlan(planId).slots.map((s) => s.item?.productId ?? null)
      const result = ws.setSceneChoice(planId, body, { confirm: true })
      const idsAfter = ws.getPlan(planId).slots.map((s) => s.item?.productId ?? null)
      if (JSON.stringify(idsBefore) !== JSON.stringify(idsAfter)) {
        throw Object.assign(new Error('切场景不允许改动商品'), { code: 'SCENE_MUTATED_PLAN' })
      }
      broadcast('plan.updated', { planId, reason: 'scene' })
      broadcast('scene.updated', { planId, key: result.view.cacheKey, status: result.view.status })
      return send(res, 200, result)
    }

    /* 自动更新开关：复选框就是唯一开关，拨动即生效，不再二次确认。
       生图的实际花费仍由服务端预算闸门与限流控制。 */
    if (method === 'POST' && /^\/api\/plans\/[^/]+\/scene\/auto$/.test(pathname)) {
      const planId = decodeURIComponent(pathname.split('/')[3])
      const body = (await readBody(req)) ?? {}
      const state = ws.setSceneAuto(planId, !!body.enabled)
      broadcast('plan.updated', { planId, reason: 'scene-auto' })
      return send(res, 200, { ...state, budget: scenegen.ledger.status() })
    }

    /* 手动重新生成：用户主动点的按钮，直接执行。
       额度 / 限流仍在 generate() 之前判定，超限返回 402/429，不会静默扣费。 */
    if (method === 'POST' && /^\/api\/plans\/[^/]+\/scene\/regenerate$/.test(pathname)) {
      const planId = decodeURIComponent(pathname.split('/')[3])
      const body = (await readBody(req)) ?? {}
      const plan = ws.getPlan(planId)
      try {
        await scenegen.generate(plan, { force: body.force === true, kind: 'scene-new', trigger: 'manual' })
        return send(res, 200, { view: scenegen.viewFor(plan), budget: scenegen.ledger.status() })
      } catch (e) {
        if (e.code === 'BUDGET_BLOCKED') {
          return send(res, 402, { error: e.message, code: 'BUDGET_BLOCKED', estimate: e.estimate, budget: e.budget })
        }
        if (e.code === 'SCENEGEN_UNCONFIGURED') return send(res, 503, { error: e.message, code: e.code })
        return send(res, 502, { error: `生成失败：${e.message}`, code: 'SCENEGEN_ERROR' })
      }
    }

    // 重新识别热点（图片不变，零成本）
    if (method === 'POST' && /^\/api\/plans\/[^/]+\/scene\/hotspots$/.test(pathname)) {
      const planId = decodeURIComponent(pathname.split('/')[3])
      const view = scenegen.recomputeHotspots(ws.getPlan(planId))
      return send(res, 200, { view })
    }

    // 人工修正某个槽位的热点区域
    if (method === 'POST' && /^\/api\/plans\/[^/]+\/scene\/hotspots\/correct$/.test(pathname)) {
      const planId = decodeURIComponent(pathname.split('/')[3])
      const body = (await readBody(req)) ?? {}
      const view = scenegen.correctHotspot(ws.getPlan(planId), body.slot, body.region ?? {})
      broadcast('plan.updated', { planId, reason: 'hotspot' })
      return send(res, 200, { view })
    }

    // 停止等待（如实说明服务商可能仍在计费）
    if (method === 'POST' && /^\/api\/plans\/[^/]+\/scene\/cancel$/.test(pathname)) {
      const planId = decodeURIComponent(pathname.split('/')[3])
      const plan = ws.getPlan(planId)
      const result = scenegen.cancelWait(planId, plan)
      return send(res, 200, { ...result, view: scenegen.viewFor(plan) })
    }

    if (method === 'POST' && /^\/api\/plans\/[^/]+\/(swap|lock|remove|constraints|fit-budget|duplicate)$/.test(pathname)) {
      const [, , , id, action] = pathname.split('/')
      const planId = decodeURIComponent(id)
      const body = (await readBody(req)) ?? {}
      let plan
      let swapPrefs = null
      if (action === 'swap') {
        const result = ws.swap(planId, {
          slot: body.slot,
          strategy: body.strategy,
          productId: body.productId,
        })
        plan = result.plan
        swapPrefs = {
          applied: result.applied ?? [],
          excluded: result.excluded ?? [],
          relaxed: result.relaxed ?? [],
          blockedBy: result.blockedBy ?? [],
          unmapped: result.unmapped ?? [],
          picked: result.picked ?? null,
        }
        broadcast('plan.updated', { planId, diff: result.diff.summary, changed: result.diff.changedSlots, by: body.by ?? 'ui' })
      } else if (action === 'lock') {
        plan = ws.lock(planId, body.slot, body.locked !== false)
        broadcast('plan.updated', { planId, diff: `${body.locked === false ? '解除锁定' : '锁定'} ${body.slot}`, changed: [body.slot], by: 'ui' })
      } else if (action === 'remove') {
        plan = ws.remove(planId, body.slot)
        broadcast('plan.updated', { planId, diff: `移除 ${body.slot}`, changed: [body.slot], by: 'ui' })
      } else if (action === 'constraints') {
        const patched = ws.setConstraints(planId, {
          budgetLimit: typeof body.budgetLimit === 'number' ? body.budgetLimit : undefined,
          arrivalBy: body.arrivalBy,
          shipTo: body.shipTo,
        })
        plan = patched.plan
        if (patched.changed) broadcast('plan.updated', { planId, diff: '更新方案约束', changed: [], by: 'ui' })
      } else if (action === 'fit-budget') {
        const fit = ws.fitToBudget(planId)
        plan = fit.plan
        const vm = ws.viewModel(plan)
        if (fit.changed) {
          broadcast('plan.updated', {
            planId,
            diff: fit.ok
              ? `已调整至预算内（${fit.changes.map((c) => c.slotLabel).join('、')}）`
              : `已换成更便宜的选项，仍超 $${vm.cost.breakdown.overBy}`,
            changed: fit.changes.map((c) => c.slot),
            by: 'ui',
          })
        }
        return send(res, 200, { ...vm, fit: { ok: fit.ok, reason: fit.reason, changes: fit.changes } })
      } else {
        plan = ws.duplicate(planId)
        broadcast('plan.created', { planId: plan.planId, from: planId })
      }
      return send(res, 200, swapPrefs ? { ...ws.viewModel(plan), prefRanking: swapPrefs } : ws.viewModel(plan))
    }

    // 偏好：GET 返回生效值 + 覆盖关系 + 状态计数（含 ?planId 用于判定「本次」是否还成立）
    if (pathname === '/api/prefs' && method === 'GET') {
      const taskKey = url.searchParams.get('planId') ?? null
      // brief = 下一轮对话会注入 prompt 的原文（同一份数据，便于验收；不参与任何模型判断）
      const brief = prefsBrief(ws.prefs, { taskKey })
      return send(res, 200, { ...ws.prefsView({ taskKey }), brief })
    }
    // AI 提议偏好：只写待确认，不参与推荐（F3）
    if (pathname === '/api/prefs/propose' && method === 'POST') {
      const body = (await readBody(req)) ?? {}
      const result = ws.proposePref({
        attr: body.attr,
        value: body.value,
        scope: body.scope ?? 'profile',
        taskKey: body.taskKey ?? body.planId ?? null,
        evidence: body.evidence,
        confidence: body.confidence,
      })
      if (result.changed) {
        broadcast('prefs.proposed', {
          id: result.record?.id ?? null,
          attr: result.record?.attr ?? body.attr,
          action: result.action,
        })
      }
      return send(res, 200, result)
    }
    if (method === 'PATCH' && /^\/api\/prefs\/[^/]+\/reject$/.test(pathname)) {
      const id = decodeURIComponent(pathname.split('/')[3])
      const body = (await readBody(req)) ?? {}
      const rec = ws.rejectPref(id, body.reason)
      broadcast('prefs.updated', { prefs: ws.prefs.length, id: rec.id, rejected: true })
      return send(res, 200, rec)
    }
    if (pathname === '/api/prefs' && method === 'POST') {
      const body = (await readBody(req)) ?? {}
      const rec = ws.savePref({
        attr: body.attr,
        value: body.value,
        scope: body.scope ?? 'profile',
        taskKey: body.taskKey ?? body.planId ?? null,
        source: body.source ?? 'user_form',
        confidence: body.confidence,
        confirmedByUser: body.confirmedByUser,
        turnId: body.turnId,
        sessionId: body.sessionId,
        evidence: body.evidence,
      })
      broadcast('prefs.updated', { prefs: ws.prefs.length, id: rec.id, attr: rec.attr, scope: rec.scope })
      return send(res, 200, rec)
    }
    if (method === 'PATCH' && /^\/api\/prefs\/[^/]+\/confirm$/.test(pathname)) {
      const id = decodeURIComponent(pathname.split('/')[3])
      const body = (await readBody(req)) ?? {}
      const rec = ws.confirmPref(id, { value: body.value })
      broadcast('prefs.updated', { prefs: ws.prefs.length, id: rec.id, confirmed: true })
      return send(res, 200, rec)
    }
    if (method === 'DELETE' && /^\/api\/prefs\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.split('/')[3])
      const rec = ws.deletePref(id)
      broadcast('prefs.updated', { prefs: ws.prefs.length, id: rec.id, deleted: true })
      return send(res, 200, rec)
    }

    const handler = routes[`${method} ${pathname}`]
    if (handler) {
      const result = await handler(req, url)
      if (!res.writableEnded) send(res, 200, result)
      return
    }

    if (pathname.startsWith('/api/')) return send(res, 404, { error: `no route ${method} ${pathname}` })

    // 静态：Studio
    if (method === 'GET') return serveStatic(pathname, res, url)
    return send(res, 405, { error: 'method not allowed' })
  } catch (err) {
    const code = err?.code ?? 'ERROR'
    const status =
      code === 'SLOT_LOCKED' || code === 'OWNED_SLOT' || code === 'STALE_REVISION' || code === 'CATEGORY_MISMATCH'
        ? 409
        : code === 'NO_CANDIDATE' || code === 'SLOT_NOT_FOUND' || code === 'PREF_CONFLICT' || code === 'OWNED_UNDECLARED'
          ? 422
          : 500
    LOG('error', code, err?.message)
    return send(res, status, {
      error: err?.message ?? String(err),
      code,
      hint: err?.hint ?? null,
      // 结构化详情（冲突商品 / 规则 / 可执行动作）：只含商品与偏好，不含密钥或用户隐私
      details: err?.details ?? null,
    })
  }
})

async function serveStatic(pathname, res, url) {
  let target
  // 两个页面共用一个服务：
  //   /             → AI 购物首页（消费者入口）
  //   /?plan=<id>   → 场景购物页（深链、验收脚本、历史方案链接都走这里）
  //   /app          → 场景购物页的显式别名
  if (pathname === '/') target = join(STUDIO, url?.searchParams?.get('plan') ? 'index.html' : 'home.html')
  else if (pathname === '/home') target = join(STUDIO, 'home.html')
  else if (pathname === '/index.html' || pathname === '/app') target = join(STUDIO, 'index.html')
  else if (pathname.startsWith('/data/seed/')) target = join(ROOT, pathname)
  else if (pathname.startsWith('/scenes/')) target = join(DATA, pathname.replace(/^\/scenes\//, 'scenes/'))
  else target = join(STUDIO, pathname)

  const safe = normalize(target)
  // 只允许三类目录：Studio 前端、种子素材、场景图缓存。
  // 不能因为「路径在仓库内」就放行 —— state.json / chat.json 也在这里。
  const allowedRoots = [STUDIO, join(ROOT, 'data', 'seed'), join(DATA, 'scenes')]
  const within = (base) => safe === base || safe.startsWith(base + sep)
  if (!allowedRoots.some(within)) return send(res, 403, 'forbidden')
  if (!existsSync(safe)) return send(res, 404, 'not found')
  const info = await stat(safe)
  if (info.isDirectory()) return send(res, 404, 'not found')
  res.writeHead(200, {
    'content-type': MIME[extname(safe).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': safe.includes('data/seed') || safe.includes('data/scenes') || safe.includes('data\\scenes') ? 'public, max-age=600' : 'no-store',
    'access-control-allow-origin': '*',
  })
  createReadStream(safe).pipe(res)
}

server.listen(PORT, HOST, async () => {  LOG(`listening http://${HOST}:${PORT}`)
  LOG(`data    ${DATA}`)
  LOG(`studio  http://${HOST}:${PORT}/`)

  // 目录数据：缓存太旧或为空 → 先刷新，再建演示方案（避免用不到真实商品）
  const fetchedAt = ws.liveMeta?.fetchedAt ? Date.parse(ws.liveMeta.fetchedAt) : 0
  const stale = Date.now() - fetchedAt > 6 * 3600 * 1000
  if (ws.liveItems.length === 0 || stale) {
    LOG(stale ? '真实商品缓存过期，刷新中…' : '首次启动，拉取真实商品…')
    try {
      const live = await refreshLiveCatalog({ cachePath: CACHE, log: LOG })
      ws.setLive(live)
      LOG(`真实商品就绪：${live.items.length} 件`)
      broadcast('catalog.updated', { live: live.items.length, meta: live.meta })
    } catch (e) {
      LOG('刷新失败（保留缓存/种子数据）：', e?.message ?? e)
    }
  }

  // 空工作区给一个可直接看的演示方案（真实商品 + 已有牛仔裤）
  if (ws.plans.size === 0) {
    try {
      const plan = createDemoPlan()
      LOG(`已创建演示方案 ${plan.planId}（${plan.label}）`)
    } catch (e) {
      LOG('演示方案创建失败：', e?.message ?? e)
    }
  }
})

// 退出时把 dsh 子进程一起收掉，别留孤儿进程占着 ~/.dsh
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try {
      await chat.killChild()
    } catch {
      /* ignore */
    }
    process.exit(0)
  })
}

export { server, ws, chat }
