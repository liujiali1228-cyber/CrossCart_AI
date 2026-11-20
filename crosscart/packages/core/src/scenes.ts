/**
 * 场景系统：场景库、场景解析、提示词构建、热点区域。
 *
 * 设计原则：
 *  - 纯函数、零 IO：场景不是「几张固定背景图」，而是「地点 × 时间 × 季节 × 天气 × 镜头」的组合，
 *    同名地点在不同时间/天气下产生不同 sceneId 与不同提示词。
 *  - 提示词只从结构化方案（slot → item 的颜色/类目/廓形）构建，绝不解析聊天文本。
 *  - Mode A（仅换场景）与 Mode B（场景适配建议）在这里只是数据差异：
 *    `requiresAdaptation` 标记由界面/AI 用来提示，是否真的改商品由既有确定性换件决定。
 */
import type { ColorFamily, Item, OutfitPlan, SlotId } from './types.js'

export type SceneCategory = 'city' | 'travel' | 'daily' | 'event'
export type SceneTime = 'dawn' | 'morning' | 'afternoon' | 'dusk' | 'night'
export type SceneSeason = 'spring' | 'summer' | 'autumn' | 'winter'
export type SceneWeather = 'clear' | 'overcast' | 'rain' | 'snow' | 'indoor'

export interface SceneSpec {
  /** 确定性 ID：地点 × 时间 × 季节 × 天气。同一组合永远是同一个场景。 */
  sceneId: string
  category: SceneCategory
  label: string
  place: string
  time: SceneTime
  season: SceneSeason
  weather: SceneWeather
  /** 英文场景片段（进提示词） */
  prompt: string
  /** 镜头/构图片段 */
  camera: string
  /** 触发「场景适配建议」的标签：rain 要防雨、snow 要保暖、formal 要正式…… */
  requiresAdaptation: string[]
}

export const CATEGORY_LABEL: Record<SceneCategory, string> = {
  city: '城市生活',
  travel: '旅行度假',
  daily: '日常生活',
  event: '活动场景',
}

export const TIME_LABEL: Record<SceneTime, string> = {
  dawn: '清晨',
  morning: '上午',
  afternoon: '下午',
  dusk: '黄昏',
  night: '夜晚',
}
export const SEASON_LABEL: Record<SceneSeason, string> = {
  spring: '春',
  summer: '夏',
  autumn: '秋',
  winter: '冬',
}
export const WEATHER_LABEL: Record<SceneWeather, string> = {
  clear: '晴朗',
  overcast: '多云',
  rain: '雨天',
  snow: '雪天',
  indoor: '室内',
}

/** 天气需要的服装能力 → 没有覆盖到就提示适配（Mode B 的输入） */
export const WEATHER_NEEDS: Record<SceneWeather, string[]> = {
  clear: [],
  overcast: [],
  rain: ['waterproof'],
  snow: ['warm'],
  indoor: [],
}

/* ------------------------------------------------------------------ 场景库 */

interface SceneSeed {
  id: string
  category: SceneCategory
  label: string
  place: string
  prompt: string
  camera: string
  /** 默认氛围词（时间/天气还会叠加） */
  vibes: string[]
  /** 这个地点天然合理的天气（自定义时做合理性检查，但不强制） */
  typicalWeather: SceneWeather[]
}

const SEEDS: SceneSeed[] = [
  // —— 城市生活 ——
  { id: 'tokyo-street', category: 'city', label: '东京街头', place: '东京', prompt: 'a quiet side street in Shimokitazawa, Tokyo, small storefronts and vending machines, utility poles', camera: 'eye-level full-body street photography, 35mm', vibes: ['editorial street style'], typicalWeather: ['clear', 'overcast', 'rain', 'snow'] },
  { id: 'nyc-commute', category: 'city', label: '纽约通勤', place: '纽约', prompt: 'a crosswalk in Midtown Manhattan, yellow cabs and steam vents in the background', camera: 'slightly low angle full-body, 50mm', vibes: ['busy morning energy'], typicalWeather: ['clear', 'overcast', 'rain', 'snow'] },
  { id: 'paris-cafe', category: 'city', label: '巴黎咖啡馆', place: '巴黎', prompt: 'on the terrace of a Parisian corner café, rattan chairs and a zinc bar visible through the window', camera: 'eye-level, 50mm, shallow depth of field', vibes: ['soft lifestyle editorial'], typicalWeather: ['clear', 'overcast', 'rain'] },
  { id: 'london-autumn', category: 'city', label: '伦敦秋冬街道', place: '伦敦', prompt: 'a brick townhouse street in Notting Hill, wet pavement, bicycles by railings', camera: 'eye-level full-body, 35mm', vibes: ['moody editorial'], typicalWeather: ['overcast', 'rain', 'clear'] },
  { id: 'seoul-fashion', category: 'city', label: '首尔时尚街区', place: '首尔', prompt: 'Seongsu-dong warehouse district with minimalist concrete cafés and neon signage', camera: 'eye-level full-body, 35mm', vibes: ['clean k-fashion editorial'], typicalWeather: ['clear', 'overcast', 'rain', 'snow'] },
  { id: 'shanghai-walk', category: 'city', label: '上海城市漫步', place: '上海', prompt: 'Wukang Road plane-tree avenue in Shanghai, low-rise historical facades', camera: 'eye-level full-body, 35mm', vibes: ['quiet city walk'], typicalWeather: ['clear', 'overcast', 'rain'] },
  // —— 旅行度假 ——
  { id: 'seaside', category: 'travel', label: '海边度假', place: '海边', prompt: 'a wooden boardwalk by the sea, dunes and distant white parasols', camera: 'eye-level full-body, bright natural light', vibes: ['relaxed vacation editorial'], typicalWeather: ['clear', 'overcast'] },
  { id: 'tropical-island', category: 'travel', label: '热带海岛', place: '海岛', prompt: 'a shaded veranda overlooking turquoise water and palm trees', camera: 'eye-level full-body, warm sunlight', vibes: ['tropical resort editorial'], typicalWeather: ['clear', 'overcast', 'rain'] },
  { id: 'airport', category: 'travel', label: '机场出行', place: '机场', prompt: 'a bright airport terminal with floor-to-ceiling windows and a rolling suitcase nearby', camera: 'eye-level full-body, natural window light', vibes: ['travel day'], typicalWeather: ['indoor'] },
  { id: 'city-travel', category: 'travel', label: '城市旅行', place: '城市', prompt: 'an old town square with café umbrellas and pigeons', camera: 'eye-level full-body, 35mm', vibes: ['city break'], typicalWeather: ['clear', 'overcast', 'rain'] },
  { id: 'mountain', category: 'travel', label: '山间度假', place: '山间', prompt: 'a cabin porch in the mountains, layered blue ridges behind', camera: 'eye-level full-body, crisp mountain light', vibes: ['alpine retreat'], typicalWeather: ['clear', 'overcast', 'snow'] },
  { id: 'lakeside', category: 'travel', label: '湖边休闲', place: '湖边', prompt: 'a wooden jetty on a calm lake with reeds and a rowing boat', camera: 'eye-level full-body, soft reflected light', vibes: ['quiet lakeside'], typicalWeather: ['clear', 'overcast'] },
  // —— 日常生活 ——
  { id: 'cafe', category: 'daily', label: '咖啡馆', place: '咖啡馆', prompt: 'inside a sunlit specialty coffee bar, wood counter and hanging plants', camera: 'eye-level, 50mm, window light', vibes: ['slow morning'], typicalWeather: ['indoor'] },
  { id: 'bookstore', category: 'daily', label: '书店', place: '书店', prompt: 'between tall wooden bookshelves in an independent bookstore', camera: 'eye-level, warm tungsten light', vibes: ['quiet browsing'], typicalWeather: ['indoor'] },
  { id: 'gallery', category: 'daily', label: '美术馆', place: '美术馆', prompt: 'a white-walled contemporary art gallery with one large abstract canvas', camera: 'eye-level full-body, museum lighting', vibes: ['minimal gallery'], typicalWeather: ['indoor'] },
  { id: 'park', category: 'daily', label: '公园', place: '公园', prompt: 'a gravel path in a city park with open lawn and mature trees', camera: 'eye-level full-body, open shade', vibes: ['weekend stroll'], typicalWeather: ['clear', 'overcast', 'rain', 'snow'] },
  { id: 'shopping-street', category: 'daily', label: '商业街', place: '商业街', prompt: 'a pedestrian shopping street with glass storefronts and awnings', camera: 'eye-level full-body, 35mm', vibes: ['casual shopping'], typicalWeather: ['clear', 'overcast', 'rain'] },
  { id: 'home', category: 'daily', label: '室内生活', place: '家', prompt: 'a calm living room with linen sofa, bookshelf and a large window', camera: 'eye-level, soft window light', vibes: ['at-home comfort'], typicalWeather: ['indoor'] },
  // —— 活动场景 ——
  { id: 'business', category: 'event', label: '商务通勤', place: '商务区', prompt: 'a modern office lobby with marble floor and glass elevators', camera: 'eye-level full-body, architectural light', vibes: ['sharp business casual'], typicalWeather: ['indoor', 'clear'] },
  { id: 'formal-dinner', category: 'event', label: '正式晚餐', place: '餐厅', prompt: 'an intimate fine-dining restaurant with candlelit tables', camera: 'eye-level, warm low light', vibes: ['elegant evening'], typicalWeather: ['indoor'] },
  { id: 'friends', category: 'event', label: '朋友聚会', place: '聚会', prompt: 'a cozy wine bar with string lights and a shared table', camera: 'eye-level, warm ambient light', vibes: ['easy social evening'], typicalWeather: ['indoor', 'clear'] },
  { id: 'date', category: 'event', label: '周末约会', place: '街区', prompt: 'a leafy side street with a small bistro terrace', camera: 'eye-level full-body, golden light', vibes: ['romantic casual'], typicalWeather: ['clear', 'overcast'] },
  { id: 'shopping-day', category: 'event', label: '休闲购物', place: '商场', prompt: 'a bright modern shopping arcade with skylights', camera: 'eye-level full-body', vibes: ['weekend shopping'], typicalWeather: ['indoor', 'clear'] },
  { id: 'outdoor', category: 'event', label: '户外活动', place: '户外', prompt: 'a trailhead clearing with grass and distant hills', camera: 'eye-level full-body, fresh daylight', vibes: ['light outdoor activity'], typicalWeather: ['clear', 'overcast'] },
]

const TIME_PROMPT: Record<SceneTime, string> = {
  dawn: 'early dawn, cool soft light, empty street',
  morning: 'mid-morning, clean daylight',
  afternoon: 'afternoon sun with defined shadows',
  dusk: 'dusk, golden hour glow',
  night: 'night, city lights and neon reflections, warm street lamps',
}

const SEASON_PROMPT: Record<SceneSeason, string> = {
  spring: 'spring, fresh foliage',
  summer: 'summer, bright and warm',
  autumn: 'autumn, scattered fallen leaves',
  winter: 'winter, bare branches and cold air',
}

const WEATHER_PROMPT: Record<SceneWeather, string> = {
  clear: 'clear sky',
  overcast: 'overcast sky, diffused light',
  rain: 'just after rain, wet pavement with reflections, a few umbrellas in the distance',
  snow: 'light snow falling, thin snow on the ground',
  indoor: '',
}

/** 稳定哈希（FNV-1a），用于自定义场景与缓存键。不要换成随机数。 */
export function stableHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

export interface SceneQuery {
  /** 场景库地点 id（如 'tokyo-street'）或中文名（如 '巴黎咖啡馆'） */
  place?: string
  time?: SceneTime
  season?: SceneSeason
  weather?: SceneWeather
  /** 自由描述，如「雨后傍晚的代官山」。与 place 二选一，自由描述优先。 */
  custom?: string
}

function clampEnum<T extends string>(v: string | undefined, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(v ?? '') ? (v as T) : fallback
}

const TIMES = Object.keys(TIME_LABEL) as SceneTime[]
const SEASONS = Object.keys(SEASON_LABEL) as SceneSeason[]
const WEATHERS = Object.keys(WEATHER_LABEL) as SceneWeather[]

/** 目的地/活动 → 场景库地点的启发式匹配（确定性，无模型）。 */
export function suggestScenes(plan: Pick<OutfitPlan, 'scene'>, limit = 6): SceneSpec[] {
  const dest = plan.scene.destination.toLowerCase()
  const scored = SEEDS.map((s) => {
    let score = 0
    if (dest && (s.place.includes(plan.scene.destination) || s.prompt.toLowerCase().includes(dest))) score += 10
    if (s.category === 'city') score += 1
    return { s, score }
  }).sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(({ s }) => resolveScene({ place: s.id }))
}

/** 解析一个场景。自由描述优先；地点不存在时抛错而不是悄悄换成默认场景。 */
export function resolveScene(q: SceneQuery): SceneSpec {
  if (q.custom && q.custom.trim()) {
    const custom = q.custom.trim()
    const season = clampEnum(q.season, SEASONS, 'autumn')
    const time = clampEnum(q.time, TIMES, 'afternoon')
    const weather = clampEnum(q.weather, WEATHERS, 'clear')
    const sceneId = `custom.${stableHash([custom, time, season, weather].join('|'))}`
    return {
      sceneId,
      category: 'daily',
      label: custom.length > 12 ? `${custom.slice(0, 12)}…` : custom,
      place: custom,
      time,
      season,
      weather,
      prompt: custom,
      camera: 'eye-level full-body, 35mm',
      requiresAdaptation: WEATHER_NEEDS[weather],
    }
  }
  const placeKey = (q.place ?? 'tokyo-street').trim()
  const seed = SEEDS.find((s) => s.id === placeKey) ?? SEEDS.find((s) => s.label === placeKey)
  if (!seed) throw new Error(`未知场景地点：${placeKey}`)
  const season = clampEnum(q.season, SEASONS, 'autumn')
  const time = clampEnum(q.time, TIMES, 'afternoon')
  const weather = clampEnum(q.weather, WEATHERS, seed.typicalWeather[0] ?? 'clear')
  const sceneId = `${seed.id}.${season}.${time}.${weather}`
  return {
    sceneId,
    category: seed.category,
    label: `${seed.label} · ${SEASON_LABEL[season]}${TIME_LABEL[time]}${weather === 'clear' ? '' : ` · ${WEATHER_LABEL[weather]}`}`,
    place: seed.place,
    time,
    season,
    weather,
    prompt: [seed.prompt, SEASON_PROMPT[season], TIME_PROMPT[time], WEATHER_PROMPT[weather]].filter(Boolean).join(', '),
    camera: seed.camera,
    requiresAdaptation: WEATHER_NEEDS[weather],
  }
}

/** 场景库列表（选择面板用）。每个地点给一个「默认氛围」版本。 */
export function listScenes(): SceneSpec[] {
  return SEEDS.map((s) => resolveScene({ place: s.id }))
}

/* -------------------------------------------------------------- 提示词构建 */

const GARMENT_NOUN: Record<SlotId, string> = {
  outerwear: 'jacket',
  top: 'top',
  bottom: 'pants',
  shoes: 'shoes',
  bag: 'bag',
}

/** 类目名词（P9：抽象「已有」也要用它写提示词，所以导出）。 */
export function slotNoun(slot: SlotId): string {
  return GARMENT_NOUN[slot]
}

/**
 * 用户口语里的颜色 → 英文颜色词。
 *
 * 为什么需要：用户说「我有白色的鞋子」时没有商品 ID，也就没有 color 字段，
 * 提示词只能用这句话本身。把中文颜色词解析成英文，模型更容易照做；
 * 解析不出来就返回 null（宁可不写，也不要猜一个颜色）。
 */
const CN_COLOR: Array<[RegExp, string]> = [
  [/奶白|米白|象牙|纯白|白色|白/, 'white'],
  [/棕|咖|驼|焦糖|栗/, 'brown'],
  [/黑|墨/, 'black'],
  [/深蓝|藏青|牛仔蓝|蓝色|蓝/, 'blue'],
  [/灰|银/, 'grey'],
  [/米色|杏色|卡其|燕麦|裸色|驼色/, 'beige'],
  [/红|酒红|枣红/, 'red'],
  [/绿|墨绿|橄榄/, 'green'],
  [/粉|藕粉/, 'pink'],
  [/紫|梅子/, 'purple'],
  [/黄|姜黄|鹅黄/, 'yellow'],
]

export function parseOwnedColor(text: string | null | undefined): string | null {
  const s = String(text ?? '').trim()
  if (!s) return null
  for (const [re, word] of CN_COLOR) if (re.test(s)) return word
  return null
}

/** 颜色词 → 明暗档（结果校验用：说白鞋却画出黑鞋，就是 dark 与 light 的冲突）。 */
export function colorFamilyOf(word: string | null | undefined): ColorFamily | null {
  const w = String(word ?? '').toLowerCase()
  if (!w) return null
  if (/white|ivory|cream|beige|light|silver|pastel/.test(w)) return 'light'
  if (/black|dark|navy|brown|charcoal|burgundy/.test(w)) return 'dark'
  if (/grey|gray|blue|mid|denim|green|red|olive|khaki/.test(w)) return 'mid'
  return null
}

/** 从商家标题提取材质/版型关键词，让提示词贴近真实商品（不整段照搬标题）。 */
const MATERIAL_WORDS = [
  'cashmere', 'merino', 'wool', 'silk', 'silky', 'cotton', 'denim', 'fleece', 'canvas',
  'leather', 'linen', 'knit', 'corduroy', 'nylon', 'tweed', 'satin', 'alpaca',
  'zip-up', 'crewneck', 'turtleneck', 'v-neck', 'button', 'barrel', 'pleated', 'wide-leg',
  'backpack', 'tote', 'crossbody', 'shoulder', 'sneaker', 'sneakers', 'loafer', 'boot', 'boots',
  'slip-on', 'flat', 'flats', 'coat', 'anorak', 'cardigan', 'vest', 'blazer', 'shirt', 'dress',
  'puffer', 'parka', 'jacket', 'hoodie', 'sweater', 'pant', 'pants', 'jeans', 'skirt',
]

const COLOR_WORD: Record<ColorFamily, string> = {
  light: 'light-toned',
  mid: 'mid-toned',
  dark: 'dark-toned',
}

/** 把结构化单品翻成提示词短语：颜色 + 材质/版型关键词 + 类目名词。只用结构化字段。 */
export function garmentPhrase(item: Item): string {
  const rawColor = item.color && /^[\x20-\x7e]+$/.test(item.color) ? item.color : COLOR_WORD[item.colorFamily]
  const color = rawColor.toLowerCase().replace(/ stripe$/, ' striped')
  const titleWords = item.title.toLowerCase()
  const noun = GARMENT_NOUN[item.category]
  const hits = MATERIAL_WORDS.filter((w) => titleWords.includes(w))
  // 去掉与类目名词重复、以及被更长关键词包含的词（silk/silky、pant/pants、backpack/bag）
  const kws = hits
    .filter((w) => w !== noun && w !== `${noun}s` && noun !== `${w}s`)
    .filter((w) => !hits.some((o) => o !== w && o.includes(w)))
    .slice(0, 3)
  return [color, ...kws, noun].join(' ')
}

/**
 * 由方案 + 场景生成图像提示词。输入全是结构化字段：
 * 换了商品 → 短语变化 → 提示词变化 → 缓存键变化；纯文本聊天记录不参与。
 *
 * P9 修正（用户说白鞋、图上却是黑靴）：原来的实现只遍历 `slots.filter(s => s.item)`，
 * 也就是只画「从商品库选进来」的东西。用户口头声明的「已有白鞋 / 棕色包」没有 productId，
 * item 为 null，于是**整条从提示词里消失**，脚上那双鞋就交给模型自由发挥 —— 它画了黑靴。
 * 现在抽象「已有」单独成句，并且写成硬约束（must / do not substitute），
 * 而不是夹在 wearing 列表里当可选形容词。
 */
export function buildScenePrompt(plan: OutfitPlan, spec: SceneSpec): string {
  const worn = plan.slots.filter((s) => s.item).map((s) => garmentPhrase(s.item as Item))
  const own = plan.slots
    .filter((s) => s.status === 'owned' && !s.item && s.ownedClaim?.label)
    .map((s) => ({ slot: s.slot, phrase: ownedPhrase(s) }))
  const outfit = [...worn, ...own.map((o) => o.phrase)].join(', ') || 'simple casual outfit'

  // 抽象「已有」是硬约束：颜色 / 类目 / 不许替换，一句话一条，避免模型只取其中一半。
  const ownRules = own.length
    ? [
        `the wearer's own ${own.map((o) => o.phrase).join(' and ')} — these are the user's own items and must appear exactly as described`,
        `do not substitute any of them: ${own
          .map((o) => `the ${GARMENT_NOUN[o.slot]} must stay ${o.phrase}`)
          .join('; ')}, no other ${[...new Set(own.map((o) => GARMENT_NOUN[o.slot]))].join(' or ')}`,
      ]
    : []

  return [
    'photorealistic lifestyle photograph of a young East Asian woman with natural skin texture and realistic body proportions',
    `wearing ${outfit}`,
    ...ownRules,
    'full-body composition, standing relaxed, feet fully visible, facing the camera slightly angled, hands natural',
    `scene: ${spec.prompt}`,
    spec.camera,
    'consistent light direction between subject and environment, natural ground contact and shadows, realistic fabric drape and texture',
    'editorial street-style quality, shot on 35mm film look, no plastic skin, no over-smoothing, no watermark, no text',
  ].join(', ')
}

/** 抽象「已有」单品的提示词短语：「white leather sneakers (the wearer's own)」。 */
export function ownedPhrase(slot: { slot: SlotId; ownedClaim?: { label?: string; color?: string | null } }): string {
  const claim = slot.ownedClaim ?? {}
  const color = claim.color ?? parseOwnedColor(claim.label)
  const noun = GARMENT_NOUN[slot.slot]
  // label 是用户自己的中文说法，模型对中文名词的响应不如英文类目词稳，所以两者都给
  return [color, noun].filter(Boolean).join(' ')
}

/** 缓存键输入：方案签名（各槽位 productId + 颜色 + 口头声明的自有单品）+ 场景 ID。 */export function sceneCacheKey(plan: OutfitPlan, spec: SceneSpec): string {
  const sig = plan.slots
    .filter((s) => s.item)
    .map((s) => `${s.slot}:${(s.item as Item).productId}:${(s.item as Item).color}`)
    .sort()
    .join('|')
  // 抽象「已有」也进签名：用户把「白鞋」改成「黑靴」时必须换一张图，
  // 否则缓存会命中旧图，看起来像「改了没生效」。
  const ownedSig = plan.slots
    .filter((s) => s.status === 'owned' && !s.item && s.ownedClaim)
    .map((s) => `${s.slot}:owned:${ownedPhrase(s)}:${s.ownedClaim?.label ?? ''}`)
    .sort()
    .join('|')
  return stableHash(`${sig}${ownedSig ? `|${ownedSig}` : ''}#${spec.sceneId}`)
}

/** 生成签名：同一份方案 + 同一场景 + 同一 provider，命中同一缓存。 */
export function sceneSignature(plan: OutfitPlan, spec: SceneSpec): string {
  return sceneCacheKey(plan, spec)
}

/* -------------------------------------------------------- 已有单品的硬约束 */

export interface OwnedConstraint {
  slot: SlotId
  /** 用户自己的说法（中文） */
  label: string
  /** 解析出的英文颜色词；解析不出为 null */
  color: string | null
  /** 明暗档；只有它能被像素级检查（颜色语义检查需要视觉模型，不能假装做了） */
  family: ColorFamily | null
}

/**
 * 从方案里取出「用户自有、没有商品快照」的单品。
 *
 * 这些是生图的硬约束，也是结果校验的输入：用户说白鞋，图里就必须是白的。
 * 只返回抽象自有 —— 有商品快照的用商品图/商品颜色，本来就走另一条路。
 */
export function ownedConstraints(plan: OutfitPlan): OwnedConstraint[] {
  return plan.slots
    .filter((s) => s.status === 'owned' && !s.item && s.ownedClaim?.label)
    .map((s) => {
      const color = s.ownedClaim?.color ?? parseOwnedColor(s.ownedClaim?.label)
      return { slot: s.slot, label: String(s.ownedClaim?.label), color, family: colorFamilyOf(color) }
    })
}

/* -------------------------------------------------------------- 场景适配 */

export interface AdaptationCheck {
  needed: boolean
  tags: string[]
  /** 人类可读的缺口说明，给界面和 AI 用 */
  hints: string[]
}

/** 确定性适配检查：雨天要防雨外套、雪天要保暖。只看结构化字段，不替用户改方案。 */
export function checkAdaptation(plan: OutfitPlan, spec: SceneSpec): AdaptationCheck {
  const tags = spec.requiresAdaptation
  const hints: string[] = []
  const find = (slot: SlotId) => plan.slots.find((s) => s.slot === slot && s.item)?.item ?? null
  const outer = find('outerwear')
  for (const tag of tags) {
    if (tag === 'waterproof') {
      if (!outer) hints.push('雨天场景：当前没有外套')
      else if (!/rain|waterproof|anorak|parka|shell|trench/i.test(outer.title)) {
        hints.push(`雨天场景：当前外套（${outer.title.slice(0, 24)}）不是防雨材质`)
      }
    }
    if (tag === 'warm') {
      if (!outer) hints.push('雪天场景：当前没有外套，不够保暖')
      else if (!/wool|cashmere|puffer|parka|down|fleece|coat|quilted/i.test(outer.title)) {
        hints.push('雪天场景：当前外套偏薄')
      }
      if (!find('bottom')) hints.push('雪天场景：当前没有裤装')
    }
  }
  return { needed: hints.length > 0, tags, hints }
}

/* ---------------------------------------------------------------- 热点区域 */

export interface Region {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 默认全身构图的热点（归一化坐标）。提示词固定了「全身居中、脚可见」，
 * 所以默认区域大致可用；已生成图片可以在缓存索引里写入逐图精调的热点。
 * 区域故意留重叠：外套盖住上衣的一部分，点击命中顺序由界面按「小区域优先」决定。
 */
export const DEFAULT_REGIONS: Record<SlotId, Region> = {
  shoes: { x: 0.3, y: 0.8, w: 0.4, h: 0.18 },
  bottom: { x: 0.34, y: 0.46, w: 0.32, h: 0.34 },
  bag: { x: 0.62, y: 0.3, w: 0.26, h: 0.3 },
  top: { x: 0.35, y: 0.22, w: 0.3, h: 0.24 },
  outerwear: { x: 0.24, y: 0.12, w: 0.52, h: 0.42 },
}

/** 命中测试：面积最小的区域优先（鞋子 > 上衣 > 外套）。 */
export function hitRegion(regions: Partial<Record<SlotId, Region>>, px: number, py: number): SlotId | null {
  const hits = (Object.entries(regions) as [SlotId, Region][])
    .filter(([, r]) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h)
    .sort((a, b) => a[1].w * a[1].h - b[1].w * b[1].h)
  return hits[0]?.[0] ?? null
}
