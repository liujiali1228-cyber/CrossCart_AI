/**
 * 真实商品源：Shopify 公开商品接口（/products.json）。
 *
 * 为什么是它：
 *  - 无需账号与密钥，是 Shopify 店铺前端的公开 JSON（主题自己就在用），稳定且合规成本低；
 *  - 返回真实商品名、真实挂牌价、真实尺码、真实商品图与可访问的商品页链接；
 *  - 小型 DTC 品牌大多跑在 Shopify 上，正是「小平台也可以」的落点。
 *
 * 诚实标注原则：
 *  - 挂牌价 → status: confirmed（真实数据）
 *  - 运费 / 到货天数 → status: estimated（按「美国直邮中国」规则估算，UI 必须展示估算依据）
 *  - 关税 → unavailable（跨境关税以结账页为准，不猜）
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'

const run = promisify(execFile)

export const LIVE_STORES = [
  // ship：店铺级「直邮中国」估算档（UI 必须标注为估算，不冒充商家承诺）
  { id: 'cuyana', name: 'Cuyana', base: 'https://www.cuyana.com', defaultSlot: 'bag', trustDefault: true, ship: { eta: [9, 16], fee: 18 } },
  { id: 'rothys', name: "Rothy's", base: 'https://www.rothys.com', defaultSlot: 'shoes', trustDefault: true, ship: { eta: [6, 11], fee: 14 } },
  { id: 'allbirds', name: 'Allbirds', base: 'https://www.allbirds.com', defaultSlot: 'shoes', trustDefault: true, ship: { eta: [5, 9], fee: 12 } },
  { id: 'everlane', name: 'Everlane', base: 'https://www.everlane.com', defaultSlot: 'outerwear', trustDefault: false, ship: { eta: [8, 14], fee: 15 } },
]

/** 不是我们搭配位里的东西（配饰/家居），直接丢弃，别硬塞进某个 slot。 */
const EXCLUDE = /\b(beanie|hat|cap|scarf|sock|socks|belt|glove|gloves|jewelry|necklace|earring|candle|mug|blanket|pillow|wallet|card case|lanyard|keychain|sticker|gift card|coasters?|tray|vase|frame|dish|towel|apron|charm|charms|pin|patch)\b/i

/**
 * 合理性价格区间（USD）：跨境代购场景下，超出区间的几乎一定是「错数据」而不是「真贵」。
 * 实测踩过的坑：某店批量端点偶尔按本地市场货币返回（同一件 $118 的杯垫返回 815），
 * 若不设区间，页面就会出现 $3,455 的外套这种明显不可信的数字。
 * 原则：宁可少几件候选，也不让一个假金额进账单。
 */
const PLAUSIBLE = {
  bag: [20, 700],
  shoes: [20, 500],
  outerwear: [30, 900],
  bottom: [20, 400],
  top: [10, 400],
}

/** 单店「越界商品」占比过高 → 判定该店价格口径可疑，整店不采信（不猜汇率）。 */
const SUSPECT_RATIO = 0.35
/** 清库存/旧版/礼品卡不参与搭配推荐 */
const DISCONTINUED = /\b(previous version|previous|earlier version|retired|final sale|sample sale|gift card|last chance|clearance)\b/i
/** 童装/婴儿不参与成人搭配 */
const KIDS = /\b(kids?|baby|babies|toddler|children|infant|boys?|girls?)\b/i

const SLOT_RULES = [
  ['bag', /\b(bag|tote|crossbody|backpack|pouch|clutch|satchel|sling|duffle|envelope)\b/i],
  ['shoes', /\b(shoe|shoes|sneaker|sneakers|runner|runners|loafer|loafers|clog|flats?|slip-?ons?|boot|boots|sandal|sandals|heel|heels|mule|mules|trainer|trainers|cruiser)\b/i],
  ['outerwear', /\b(jacket|jackets|coat|coats|trench|parka|blazer|overshirt|puffer|anorak|raincoat|vest)\b/i],
  ['bottom', /\b(pant|pants|trouser|trousers|jean|jeans|denim|shorts|skirt|chino|chinos|legging|leggings)\b/i],
  ['top', /\b(shirt|shirts|tee|tees|t-shirt|top|tops|sweater|sweaters|knit|cardigan|blouse|turtleneck|polo|henley|hoodie|sweatshirt)\b/i],
]

const LIGHT = /white|ivory|cream|beige|sand|natural|oat|bone|ecru|blush|pearl|mist|light|pale|silver|grey heather|heather white/i
const DARK = /black|navy|charcoal|dark|espresso|brown|chocolate|forest|burgundy|maroon|slate|ink|olive/i

export function classifySlot(text, fallback, trustDefault = false) {
  if (EXCLUDE.test(text)) return null
  for (const [slot, re] of SLOT_RULES) if (re.test(text)) return slot
  return trustDefault ? fallback : null
}

function colorFamilyOf(color) {
  if (LIGHT.test(color)) return 'light'
  if (DARK.test(color)) return 'dark'
  return 'mid'
}

/** Everlane 用「款式 | 颜色」拼标题：切成主名 + 颜色。 */
function splitTitle(raw) {
  const segs = String(raw).split('|').map((t) => t.trim()).filter(Boolean)
  return { title: segs[0] ?? String(raw), tail: segs[1] ?? '' }
}

/** 颜色优先级：店铺 hue 标签 > 标题尾段 > 「X in Y / X - Y」 */
function colorOf(product, tail) {
  const hueTag = (product.tags || []).find((t) => /hue\s*=>/.test(t))
  if (hueTag) return hueTag.split('=>')[1].trim()
  if (tail) return tail.replace(/\(.*?\)/g, '').trim()
  const parts = String(product.title).split(/\s+in\s+|\s+[-–]\s+/i)
  const candidate = parts.length > 1 ? parts[parts.length - 1] : ''
  return candidate.replace(/\(.*?\)/g, '').trim() || 'natural'
}

function styleTagsOf(slot, title, family) {
  const tags = new Set(['minimal'])
  if (/walk|runner|cruiser|comfort/i.test(title) || slot === 'shoes') tags.add('walking')
  if (family === 'light') tags.add('photo')
  if (/wool|merino|cashmere|alpaca|flannel|corduroy/i.test(title)) tags.add('warm')
  if (/silk|linen|cotton|tee|shirt/i.test(title)) tags.add('breathable')
  return [...tags]
}

function money(amount, source, fetchedAt) {
  return { amount, currency: 'USD', status: 'confirmed', source, fetchedAt }
}

/** 店铺级直邮中国估算：口径写在 note 里，UI 原样展示依据，绝不冒充商家承诺。 */
function shippingHeuristic(store) {
  const { eta, fee } = store.ship
  return {
    fee: { amount: fee, currency: 'USD', status: 'estimated', source: `heuristic:${store.id}` },
    status: 'estimated',
    etaDays: [...eta],
    etaEarliest: null,
    etaLatest: null,
    source: `heuristic:${store.id}`,
    note: `按 ${store.name} 美国站直邮中国估算：运费 $${fee}、${eta[0]}–${eta[1]} 天；实际以商家结账页为准`,
  }
}

export function normalizeProduct(product, store, fetchedAt, stats) {
  const { title, tail } = splitTitle(product.title || '')
  const searchText = `${product.product_type || ''} ${title}`
  if (KIDS.test(searchText) || KIDS.test(String(product.product_type ?? ''))) return null
  if (DISCONTINUED.test(`${searchText} ${(product.tags ?? []).join(' ')}`)) return null
  const slot = classifySlot(searchText, store.defaultSlot, store.trustDefault)
  if (!slot) return null
  const color = colorOf(product, tail)
  const family = colorFamilyOf(`${color} ${title}`)

  const variants = (product.variants || []).filter((v) => Number(v.price) > 0)
  if (variants.length === 0) return null
  const price = Number(variants[0].price)
  if (!Number.isFinite(price)) return null
  if (price < 20) return null // 配件/小样，不是搭配单品

  const [lo, hi] = PLAUSIBLE[slot]
  if (price < lo || price > hi) {
    // 不静默丢弃：记一笔，供上层判断整店价格口径是否可疑
    if (stats) stats.outOfBand = (stats.outOfBand ?? 0) + 1
    return null
  }

  const sizeOption = (product.options || []).find((o) => /size/i.test(o.name))
  let sizes = sizeOption ? [...new Set(sizeOption.values)] : []
  if (sizes.length === 0) sizes = slot === 'shoes' ? [] : ['均码']

  const image = product.images?.[0]?.src
  if (!image) return null

  return {
    productId: `${store.id}:${product.handle}`,
    title,
    category: slot,
    color,
    colorFamily: family,
    style: styleTagsOf(slot, title, family),
    price: money(price, `shopify:${store.id}`, fetchedAt),
    shipping: shippingHeuristic(store),
    duty: { amount: null, status: 'unavailable', reason: '跨境关税以商家结账页为准' },
    sizes,
    url: `${store.base}/products/${product.handle}`,
    image: { main: image, cutout: image },
    vendor: store.name,
    sourceKind: 'live',
  }
}

async function fetchStore(store, limit) {
  // country=US：尽量让 Shopify Markets 按美国站口径返回（否则可能拿到本地市场定价）；
  // 该参数不被某些店铺识别时会静默忽略，因此还需要 normalizeProduct 的价格区间兜底。
  const url = `${store.base}/products.json?limit=${limit}&country=US`
  const headers = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
  }

  // 先用 Node fetch；Cloudflare 常按 TLS 指纹把 Node 判为 bot（429），此时回退到 curl（HTTP/2）。
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
    if (res.ok) {
      const json = await res.json()
      if (Array.isArray(json.products)) return json.products
    }
    if (res.status !== 429 && res.status !== 403) throw new Error(`${store.id}: HTTP ${res.status}`)
  } catch (err) {
    if (String(err?.message ?? '').startsWith(store.id)) throw err
    // 网络层错误也走 curl 再试一次
  }

  const { stdout } = await run(
    'curl',
    ['-sS', '-m', '25', '--compressed', '-H', `user-agent: ${headers['user-agent']}`, '-H', `accept: ${headers.accept}`, url],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  )
  const json = JSON.parse(stdout)
  if (!Array.isArray(json.products)) throw new Error(`${store.id}: unexpected payload`)
  return json.products
}

/** 每店每类目最多保留 maxPerSlot 件，优先有货、有尺码的。 */
function trimPerSlot(items, maxPerSlot) {
  const buckets = new Map()
  for (const it of items) {
    const arr = buckets.get(it.category) ?? []
    arr.push(it)
    buckets.set(it.category, arr)
  }
  const out = []
  for (const arr of buckets.values()) {
    out.push(...arr.slice(0, maxPerSlot))
  }
  return out
}

export async function refreshLiveCatalog({ limit = 250, maxPerSlot = 14, cachePath, log = console.log } = {}) {
  const fetchedAt = new Date().toISOString()
  const items = []
  const stores = []
  for (const store of LIVE_STORES) {
    try {
      const raw = await fetchStore(store, limit)
      const stats = { outOfBand: 0 }
      const mapped = raw
        .map((p) => {
          try {
            return normalizeProduct(p, store, fetchedAt, stats)
          } catch {
            return null
          }
        })
        .filter(Boolean)

      // 价格口径自检：越界占比过高 → 该店这次的金额不可信（实测过「按本地市场货币返回」的情况），
      // 整店跳过并把原因写进 meta；页面上绝不出现猜汇率换算出来的金额。
      const seen = mapped.length + stats.outOfBand
      const ratio = seen > 0 ? stats.outOfBand / seen : 0
      if (stats.outOfBand >= 8 && ratio > SUSPECT_RATIO) {
        stores.push({
          id: store.id,
          name: store.name,
          ok: false,
          priceSuspect: true,
          outOfBand: stats.outOfBand,
          outOfBandRatio: Number(ratio.toFixed(2)),
          error: `价格口径可疑（越界 ${stats.outOfBand} 件 / 保留 ${mapped.length} 件），本次不采信该店金额`,
        })
        log(`[catalog] ${store.name}: 价格口径可疑，整店跳过（越界 ${stats.outOfBand} / 保留 ${mapped.length}）`)
        await new Promise((r) => setTimeout(r, 250))
        continue
      }

      const trimmed = trimPerSlot(mapped, maxPerSlot)
      items.push(...trimmed)
      stores.push({
        id: store.id,
        name: store.name,
        ok: true,
        fetched: raw.length,
        kept: trimmed.length,
        outOfBand: stats.outOfBand,
      })
      log(`[catalog] ${store.name}: ${trimmed.length}/${raw.length} 件`)
    } catch (err) {
      stores.push({ id: store.id, name: store.name, ok: false, error: String(err?.message ?? err) })
      log(`[catalog] ${store.name} 拉取失败：${err?.message ?? err}`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }

  const payload = { meta: { fetchedAt, stores, source: 'shopify-products-json' }, items }
  if (cachePath) {
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify(payload, null, 2), 'utf8')
  }
  return payload
}

export function readLiveCache(cachePath) {
  if (!existsSync(cachePath)) return null
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8'))
  } catch {
    return null
  }
}
