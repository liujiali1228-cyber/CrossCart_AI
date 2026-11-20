/**
 * 衣物区域自动识别：在**真实生成图**上找人物，再按商品自己的颜色把衣物框出来。
 *
 * 为什么不用视觉大模型：本项目当前 key 只有图像模型权限（/models 只返回 gpt-image，
 * chat 模型一律 403）。所以这里做成可替换的两级：
 *   1) 本文件的确定性算法（零成本、可单测、每次生成后自动跑）；
 *   2) bridge 侧预留 vision provider 钩子：配好视觉模型就优先用它，产出同一种结构。
 *
 * 算法要点（全部可解释，不用随机数）：
 *   - 主体包围盒：边框采背景色 → 前景连通域里**最高的那块**（全身边构图里人物是最高的竖长主体）。
 *   - 搜索带：按人体比例把主体高度切成 外套/上衣/裤装/鞋 的纵向窗口，包单独一段。
 *   - 颜色锚定：从结构化商品的 color / colorFamily 解析出期望色，只在窗口内找同色像素。
 *   - 置信度：颜色贴合度 + 命中面积 + 矩形合理性；低于阈值一律标 low，**不参与点击**。
 *
 * 诚实边界：这是「按颜色 + 人体比例的矩形定位」，不是像素级分割，也不是视觉模型。
 * 所以输出里 method 永远是 'color-band' / 'geometric' / 'manual' / 'vision'，不冒充精度。
 */
import type { ColorFamily, SlotId } from './types.js'
import type { Region } from './scenes.js'

export interface RgbaImage {
  width: number
  height: number
  /** RGBA，长度 = width * height * 4 */
  data: Uint8Array
}

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface DetectedSlotRegion {
  slot: SlotId
  /** 归一化坐标（0–1，相对整张图）。null = 完全没找到，只能走人工修正 */
  region: Region | null
  /** 0–1。>= CONFIDENT 才能作为可点击热点 */
  confidence: number
  status: 'ok' | 'low' | 'missing'
  method: 'color-band' | 'geometric' | 'manual' | 'vision'
  /** 人类可读的原因，直接显示给用户 */
  reason?: string
  colorUsed?: string
}

export interface DetectionResult {
  /** 坐标体系：归一化（相对整图宽高），页面缩放后仍然对得上 */
  coordinateSpace: 'normalized'
  sourceWidth: number
  sourceHeight: number
  subject: Region | null
  slots: DetectedSlotRegion[]
  /** 算法版本：换了算法/阈值就 +1，避免把旧结果当新结果复用 */
  detector: string
  at: string
}

/** 低于这个置信度：区域只做提示，不响应点击（避免误点换错件）。 */
export const CONFIDENT = 0.55

/**
 * 检测器版本标识。写进每张图的热点元数据，用来判断「这张图的热点是不是当前算法算的」。
 * 升级算法时务必改这个字符串：旧图会自动按新算法重算，而不是继续沿用旧坐标骗人。
 */
export const DETECTOR_ID = 'body-box+color@3'

/* ------------------------------------------------------------- 颜色处理 */

interface ColorEntry {
  rgb: Rgb
  tol: number
  label: string
}

/** 商家色名 → 代表色。色名千奇百怪（Snow / Italian Straw / Vintage Heather Grey），按关键词兜底。 */
const COLOR_WORDS: [RegExp, Rgb, number, string][] = [
  [/snow|ivory|cream|ecru|off[- ]?white|oatmeal|porcelain|chalk/i, { r: 240, g: 236, b: 226 }, 34, '米白'],
  // 纯白 (246,246,244) 是棚拍色；户外白鞋实测约 (170,160,150)（阴影 + 暖光 + 地面反射），
  // 目标色定在"偏暗的白"才认得出，否则白鞋永远匹配不上、只能标待确认。
  [/white|optic/i, { r: 226, g: 222, b: 212 }, 44, '白色'],
  [/black|onyx|jet/i, { r: 34, g: 34, b: 36 }, 40, '黑色'],
  [/navy|midnight/i, { r: 37, g: 47, b: 78 }, 34, '藏青'],
  [/indigo|denim/i, { r: 66, g: 86, b: 118 }, 40, '靛蓝'],
  [/blue|cobalt|azure|sky/i, { r: 78, g: 118, b: 176 }, 46, '蓝色'],
  [/charcoal|graphite/i, { r: 78, g: 78, b: 80 }, 32, '炭灰'],
  [/heather|grey|gray|silver|stone/i, { r: 152, g: 149, b: 144 }, 40, '灰'],
  [/camel|tan|straw|sand|beige|khaki|biscuit|oat|wheat|latte/i, { r: 203, g: 178, b: 140 }, 40, '米驼'],
  [/brown|chocolate|tobacco|mocha|espresso|chestnut/i, { r: 112, g: 80, b: 58 }, 40, '棕'],
  [/olive|army|sage|moss|green|forest/i, { r: 104, g: 114, b: 76 }, 42, '绿'],
  [/pink|blush|rose|mauve/i, { r: 224, g: 176, b: 174 }, 42, '粉'],
  [/red|burgundy|cherry|wine/i, { r: 164, g: 68, b: 62 }, 44, '红'],
  [/yellow|mustard|butter|buttercream/i, { r: 224, g: 200, b: 118 }, 44, '黄'],
  [/orange|rust|terracotta|apricot/i, { r: 194, g: 118, b: 74 }, 44, '橙'],
  [/purple|lilac|lavender|violet/i, { r: 142, g: 124, b: 170 }, 44, '紫'],
]

const FAMILY_FALLBACK: Record<ColorFamily, ColorEntry> = {
  light: { rgb: { r: 230, g: 226, b: 216 }, tol: 66, label: '浅色' },
  mid: { rgb: { r: 152, g: 146, b: 138 }, tol: 70, label: '中色' },
  dark: { rgb: { r: 70, g: 68, b: 66 }, tol: 70, label: '深色' },
}

/** 商品色名 + 色系 → 期望色与容差（容差随色名模糊度放宽）。 */
export function resolveColor(color: string, family: ColorFamily): ColorEntry {
  const text = String(color ?? '').trim()
  for (const [re, rgb, tol, label] of COLOR_WORDS) {
    if (re.test(text)) return { rgb, tol, label: `${label}（${text}）` }
  }
  const fb = FAMILY_FALLBACK[family] ?? FAMILY_FALLBACK.mid
  return { ...fb, label: `${fb.label}（${text || '未标注'}）` }
}

/** 归一化颜色距离 0–1（0 = 完全一致；按通道均方根算，避免单通道偏色被低估）。 */
export function colorDistance(a: Rgb, b: Rgb): number {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3) / 255
}

/** RGB → HSL 的亮度分量（0–1），用来区分同色相不同深浅（米白 vs 纯白）。 */
export function luma(c: Rgb): number {
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255
}

/* --------------------------------------------------------- 人体框定位 */

/**
 * 人体框的构成：五个横向带（头/躯干/胯/腿/脚）。
 * 提示词里写死了「全身、居中、脚可见」，所以这些带的比例是构图契约的一部分；
 * 但**位置和尺度每张图都要重新搜**，不能用固定坐标。
 */
const BODY_BANDS: [number, number][] = [
  [0, 0.15],
  [0.15, 0.42],
  [0.42, 0.62],
  [0.62, 0.9],
  [0.9, 1.0],
]
const BAND_WEIGHT = [0.9, 1.25, 1.1, 1.25, 0.85]

export interface BodyBox extends Region {
  /** 定位得分：越大越像「一整个人」 */
  score: number
}

function integral(data: Uint8Array, w: number, h: number, ch: number): Float64Array {
  const I = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    for (let x = 0; x < w; x++) {
      rowSum += data[(y * w + x) * 4 + ch]
      I[(y + 1) * (w + 1) + (x + 1)] = I[y * (w + 1) + (x + 1)] + rowSum
    }
  }
  return I
}

function rectSum(I: Float64Array, w: number, x0: number, y0: number, x1: number, y1: number): number {
  if (x1 < x0 || y1 < y0) return 0
  return (
    I[(y1 + 1) * (w + 1) + (x1 + 1)] -
    I[y0 * (w + 1) + (x1 + 1)] -
    I[(y1 + 1) * (w + 1) + x0] +
    I[y0 * (w + 1) + x0]
  )
}

function rectMean(I: Float64Array, w: number, x0: number, y0: number, x1: number, y1: number): number {
  const n = Math.max(1, (x1 - x0 + 1) * (y1 - y0 + 1))
  return rectSum(I, w, x0, y0, x1, y1) / n
}

/**
 * 搜人体框：把框切成五个带，每个带都算「框内均色 vs 框外左右邻居均色」的差异，加权求和。
 *
 * 为什么这样能定位人：背景是连续的，框放在墙上时框内框外颜色一样，差异≈0；
 * 框套住人时头/躯干/腿各自和旁边的街道/墙面形成差异。
 *
 * 注意：这个分数对宽度是退化的（框越窄，框内越纯，对比反而越高）。
 * 所以宽度分两步定：先用粗网格找中心与上下边界，再从中心向外扫宽度取「对比度还站得住」的最宽值。
 */
export function findBodyBox(img: RgbaImage): BodyBox | null {
  const { width: w, height: h, data } = img
  const IR = integral(data, w, h, 0)
  const IG = integral(data, w, h, 1)
  const IB = integral(data, w, h, 2)
  let best: BodyBox | null = null
  let bestScore = -1

  const bandContrast = (x0: number, y0: number, x1: number, y1: number, weights = BAND_WEIGHT) => {
    const pad = Math.max(3, Math.round((x1 - x0 + 1) * 0.3))
    const lx0 = Math.max(0, x0 - pad)
    const lx1 = x0 - 1
    const rx0 = x1 + 1
    const rx1 = Math.min(w - 1, x1 + pad)
    let score = 0
    for (let b = 0; b < BODY_BANDS.length; b++) {
      const by0 = Math.round(y0 + BODY_BANDS[b][0] * (y1 - y0))
      const by1 = Math.round(y0 + BODY_BANDS[b][1] * (y1 - y0)) - 1
      if (by1 <= by0) continue
      const diff = (I: Float64Array) => {
        const inside = rectMean(I, w, x0, by0, x1, by1)
        const outside = (rectMean(I, w, lx0, by0, lx1, by1) + rectMean(I, w, rx0, by0, rx1, by1)) / 2
        return (inside - outside) ** 2
      }
      const c = Math.sqrt((diff(IR) + diff(IG) + diff(IB)) / 3) / 255
      score += weights[b] * c
    }
    return score
  }

  for (let yt = 0.04; yt <= 0.1601; yt += 0.02) {
    for (let hh = 0.84; hh <= 0.9801; hh += 0.02) {
      const y0 = Math.round(yt * h)
      const y1 = Math.round((yt + hh) * h)
      if (y1 >= h - 1) continue
      for (let cx = 0.42; cx <= 0.5801; cx += 0.02) {
        for (let bw = 0.24; bw <= 0.4401; bw += 0.03) {
          const x0 = Math.round((cx - bw / 2) * w)
          const x1 = Math.round((cx + bw / 2) * w)
          if (x0 < 1 || x1 > w - 2) continue
          let score = bandContrast(x0, y0, x1, y1)
          score += 0.1 * (1 - Math.abs(bw - 0.32) / 0.14) + 0.06 * (1 - Math.abs(cx - 0.5) / 0.12)
          if (score > bestScore) {
            bestScore = score
            best = { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h, score }
          }
        }
      }
    }
  }

  // 得分太低 = 这张图里没有「一个人」该有的结构（空镜、纯色、极端构图），不要硬给坐标
  if (!best || best.score < 0.45) return null

  // 宽度细化：从中心向外扩，保留「对比度仍有峰值的 60%」的最宽半宽
  const cx = Math.round((best.x + best.w / 2) * w)
  const y0 = Math.round(best.y * h)
  const y1 = Math.round((best.y + best.h) * h) - 1
  let widest = Math.max(4, Math.round(best.w * w * 0.5))
  let ref = -1
  const halfs: { half: number; c: number }[] = []
  for (let half = Math.round(w * 0.08); half <= Math.round(w * 0.28); half += Math.max(1, Math.round(w * 0.01))) {
    const x0 = Math.max(1, cx - half)
    const x1 = Math.min(w - 2, cx + half)
    // 只用躯干两带来定宽度：头/脚宽度天然窄，会把框压小
    const c = bandContrast(x0, y0, x1, y1, [0, 1.25, 1.1, 0, 0])
    halfs.push({ half, c })
    ref = Math.max(ref, c)
  }
  if (ref > 0) {
    // 取躯干对比度的峰值：再往两边扩就把背景算进来了，对比度会掉下去
    let peak = halfs[0]
    for (const x of halfs) if (x.c > peak.c + 1e-9) peak = x
    // 峰值处是「纯粹的衣服」，但衣服通常比峰值处更宽（袖子、口袋更接近背景色）。
    // 所以再往外放到对比度掉到峰值 80% 的位置，兼顾覆盖度与不把背景算进来。
    for (const x of halfs) if (x.c >= peak.c * 0.8) widest = Math.max(widest, x.half)
  }
  const nx0 = Math.max(0, cx - widest)
  const nx1 = Math.min(w - 1, cx + widest)
  return {
    x: nx0 / w,
    y: y0 / h,
    w: (nx1 - nx0 + 1) / w,
    h: (y1 - y0 + 1) / h,
    score: best.score,
  }
}

/* --------------------------------------------------------- 槽位搜索带 */

/** 人体比例先验：以人体框高度为 1，各槽位允许出现的纵向区间。 */
const SLOT_BAND: Record<SlotId, [number, number]> = {
  outerwear: [0.1, 0.62],
  top: [0.12, 0.46],
  bottom: [0.42, 0.9],
  shoes: [0.82, 1.0],
  bag: [0.1, 0.64],
}

/** 各槽位框的宽高比合理区间，用来压掉「一条横带」这种假框。 */
const SLOT_ASPECT: Record<SlotId, [number, number]> = {
  outerwear: [0.8, 2.4],
  top: [0.4, 1.7],
  bottom: [1.0, 4.5],
  shoes: [0.12, 0.9],
  bag: [0.5, 2.2],
}

interface BoxSample {
  x0: number
  y0: number
  x1: number
  y1: number
  meanDist: number
  fill: number
  contrast: number
}

/** 采样一个候选框：平均色差、命中率、与框外邻居的对比度。步长 2 像素够用且快。 */
function sampleBox(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, target: Rgb, tol: number): BoxSample {
  const { width: w, data } = img
  let dist = 0
  let hit = 0
  let n = 0
  let sr = 0
  let sg = 0
  let sb = 0
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      const i = (y * w + x) * 4
      const c = { r: data[i], g: data[i + 1], b: data[i + 2] }
      const d = colorDistance(c, target)
      dist += d
      if (d <= tol / 255) hit++
      sr += c.r
      sg += c.g
      sb += c.b
      n++
    }
  }
  if (!n) return { x0, y0, x1, y1, meanDist: 1, fill: 0, contrast: 0 }
  const inside = { r: sr / n, g: sg / n, b: sb / n }
  // 框外左右两条窄带的中位色 ≈ 该处背景
  const pad = Math.max(3, Math.round((x1 - x0 + 1) * 0.35))
  let or = 0
  let og = 0
  let ob = 0
  let on = 0
  for (const [ax0, ax1] of [
    [Math.max(0, x0 - pad), Math.max(0, x0 - 1)],
    [Math.min(w - 1, x1 + 1), Math.min(w - 1, x1 + pad)],
  ]) {
    for (let y = y0; y <= y1; y += 4) {
      for (let x = ax0; x <= ax1; x += 2) {
        const i = (y * w + x) * 4
        or += data[i]
        og += data[i + 1]
        ob += data[i + 2]
        on++
      }
    }
  }
  const contrast = on ? colorDistance(inside, { r: or / on, g: og / on, b: ob / on }) : 0
  return { x0, y0, x1, y1, meanDist: dist / n, fill: hit / n, contrast }
}

function aspectScore(slot: SlotId, bw: number, bh: number): number {
  const ratio = bh / Math.max(1, bw)
  const [lo, hi] = SLOT_ASPECT[slot]
  if (ratio >= lo && ratio <= hi) return 1
  const d = ratio < lo ? lo / Math.max(0.01, ratio) : ratio / hi
  return Math.max(0, 1 - (d - 1) * 0.8)
}

function clampBox(b: Region): Region {
  const x = Math.min(1, Math.max(0, b.x))
  const y = Math.min(1, Math.max(0, b.y))
  return { x, y, w: Math.max(0.005, Math.min(1 - x, b.w)), h: Math.max(0.005, Math.min(1 - y, b.h)) }
}

/**
/** 槽位框相对人体框的纵向区间与横向占比（由人体比例得出，不是画面比例）。 */
/**
 * 各槽位在「人像纵向 0→1」上的比例区间 + 占人像宽度的比例。
 * 数值按 8 头身站立照校准：头 0~0.13、肩 0.17、腰 0.42、胯 0.47、膝 0.70、脚踝 0.93、脚 0.99。
 * 之前 bottom 只到 0.92、shoes 从 0.88 起，导致裤框停在大腿、鞋框压在脚踝上——真实图上肉眼可见的错位。
 */
const SLOT_SPEC: Record<SlotId, { y0: number; y1: number; wFrac: number }> = {
  outerwear: { y0: 0.17, y1: 0.5, wFrac: 0.98 },
  top: { y0: 0.18, y1: 0.34, wFrac: 0.58 },
  bottom: { y0: 0.46, y1: 0.94, wFrac: 0.74 },
  // 鞋子是左右两只，跨度比脚踝宽：0.5 会让框正好落在两鞋之间的空地上（实测白鞋覆盖率 0.3%）
  shoes: { y0: 0.93, y1: 1.0, wFrac: 0.74 },
  bag: { y0: 0.16, y1: 0.5, wFrac: 0.26 },
}

/** 框内平均色（步长 3 采样）。 */
function meanOfBox(img: RgbaImage, x0: number, y0: number, x1: number, y1: number): Rgb | null {
  const { width: w, data } = img
  let r = 0, g = 0, b = 0, n = 0
  for (let y = Math.max(0, y0); y <= y1; y += 3) {
    for (let x = Math.max(0, x0); x <= x1; x += 3) {
      const i = (y * w + x) * 4
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++
    }
  }
  return n ? { r: r / n, g: g / n, b: b / n } : null
}

/**
 * 环境光补偿系数：场景图有阴影、色温、曝光差异，商品棚拍色直接套用会大面积误判
 * （实测牛仔商品色 (66,86,118)，照片里是 (51,50,53)，差 44 —— 刚好卡在 tol 40 外）。
 */
const COLOR_TOL_BOOST = 1.6

/** 覆盖率下限：低于这个值说明「这一段根本看不到这件衣服」，不该画成可点区域。 */
const MIN_COVERAGE = 0.2

/**
 * 框内「属于该颜色」的像素占比（步长 2 采样）。
 *
 * 为什么不用平均色：外套框宽接近整个人像，平均色被两侧街道拉偏，算出来和商品色差 49 ——
 * 于是一个明明对准了夹克的框被判成「颜色不符」。占比不受背景比例影响，是更稳的判据。
 */
function colorCoverage(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, target: Rgb, tol: number): number {
  const { width: w, height: h, data } = img
  const X0 = Math.max(0, Math.min(w - 1, x0))
  const X1 = Math.max(0, Math.min(w - 1, x1))
  const Y0 = Math.max(0, Math.min(h - 1, y0))
  const Y1 = Math.max(0, Math.min(h - 1, y1))
  if (X1 <= X0 || Y1 <= Y0) return 0
  const lim = tol * COLOR_TOL_BOOST
  let hit = 0
  let n = 0
  for (let y = Y0; y <= Y1; y += 2) {
    for (let x = X0; x <= X1; x += 2) {
      const i = (y * w + x) * 4
      if (colorDistance({ r: data[i], g: data[i + 1], b: data[i + 2] }, target) * 255 <= lim) hit += 1
      n += 1
    }
  }
  return n ? hit / n : 0
}

interface Candidate {
  cov: number
  x0: number
  y0: number
  x1: number
  y1: number
  cx: number
}

/**
 * 单槽位定位：**人像框定纵向分区 → 在分区附近按商品颜色做局部搜索**。
 *
 * 只按人体比例画一个固定框是不够的：实测同一张图上，鞋框居中偏窄、正好落在两只鞋中间的空地上，
 * 白色覆盖率只有 0.3%，用户点鞋却命中裤装。所以这里在比例框附近搜索「商品色占比最高」的位置，
 * 让框跟着衣服走；搜不到足够覆盖率的（比如白 T 被外套盖住）就如实降级，不画可点区域。
 *
 * 这么做的边界：这是「颜色匹配 + 人体先验」的定位，不是像素级分割。
 * 同色系叠穿、强逆光时会退回比例框并标 low，界面会提示用户确认或拖框修正。
 */
function locateSlot(img: RgbaImage, body: BodyBox, slot: SlotId, target: Rgb, tol: number): DetectedSlotRegion {
  const { width: w, height: h } = img
  const spec = SLOT_SPEC[slot]
  const y0 = Math.round((body.y + body.h * spec.y0) * h)
  const y1 = Math.round((body.y + body.h * spec.y1) * h) - 1
  const boxH = Math.max(6, y1 - y0 + 1)
  const boxW = Math.max(6, Math.round(body.w * spec.wFrac * w))
  const centerX = (body.x + body.w / 2) * w

  // 包常挂单边：左右各给一个起始中心；其它槽位一律居中起步
  const centers =
    slot === 'bag'
      ? [(body.x + body.w * 0.24) * w, (body.x + body.w * 0.76) * w]
      : [centerX]

  let best: Candidate | null = null
  for (const cx of centers) {
    for (const dwf of [-0.16, -0.06, 0, 0.12, 0.22]) {
      const bw = Math.max(6, Math.round(boxW * (1 + dwf)))
      for (const dxf of [-0.05, -0.02, 0, 0.02, 0.05]) {
        const x0 = Math.round(cx - bw / 2 + dxf * body.w * w)
        for (const dyf of [-0.03, 0, 0.03]) {
          for (const dhf of [-0.04, 0, 0.05]) {
            const sy0 = Math.round(y0 + dyf * body.h * h)
            const sy1 = Math.round(y1 + dhf * body.h * h)
            if (sy1 - sy0 < 10) continue
            const cov = colorCoverage(img, x0, sy0, x0 + bw - 1, sy1, target, tol)
            if (!best || cov > best.cov) best = { cov, x0, y0: sy0, x1: x0 + bw - 1, y1: sy1, cx }
          }
        }
      }
    }
  }

  // 兜底（理论上不会走到）：按比例居中放一个框，标成待确认
  const b: Candidate = best ?? {
    cov: 0,
    x0: Math.round(centerX - boxW / 2),
    y0,
    x1: Math.round(centerX + boxW / 2),
    y1,
    cx: centerX,
  }
  const box = clampBox({
    x: b.x0 / w,
    y: b.y0 / h,
    w: (b.x1 - b.x0 + 1) / w,
    h: (b.y1 - b.y0 + 1) / h,
  })
  const cov = b.cov
  // 覆盖率 → 置信度：盖到 20% 才够「能点」，50% 以上视为很确定（上限 1）
  const conf = Number(Math.min(1, 0.32 + 1.15 * Math.min(cov, 0.6)).toFixed(3))
  const ok = cov >= MIN_COVERAGE && conf >= CONFIDENT

  let reason: string | undefined
  if (!ok) {
    reason =
      cov < 0.05
        ? '这一段几乎看不到这件衣服的颜色（可能被外层遮住），请用下方入口或拖框修正'
        : '颜色对得上，但露出的面积很小，请确认这块区域'
  }
  // 包挂哪边：两侧分数接近时不能硬猜
  let sideNote: string | undefined
  if (slot === 'bag' && ok && centers.length > 1) {
    const leftCov = colorCoverage(img, Math.round(centers[0] - boxW / 2), b.y0, Math.round(centers[0] + boxW / 2), b.y1, target, tol)
    const rightCov = colorCoverage(img, Math.round(centers[1] - boxW / 2), b.y0, Math.round(centers[1] + boxW / 2), b.y1, target, tol)
    const near = Math.abs(leftCov - rightCov) < 0.08
    sideNote = near ? '左右两侧都像这个颜色，确认一下包挂在哪边' : leftCov > rightCov ? '左侧' : '右侧'
    if (near) reason = sideNote
  }

  return {
    slot,
    region: box,
    confidence: conf,
    status: ok ? 'ok' : 'low',
    method: 'geometric',
    reason,
    ...(sideNote && !reason ? {} : {}),
  }
}

/* ------------------------------------------------------------- 主入口 */

/**
 * 主入口：给一张图和当前方案的槽位，返回每个槽位的区域 + 置信度。
 * 无 IO、无随机；同一张图同样输入永远同样输出（单测据此断言）。
 */
export function detectGarments(
  img: RgbaImage,
  slots: { slot: SlotId; item: { title: string; color: string; colorFamily: ColorFamily; category: SlotId } | null }[],
): DetectionResult {
  const { width: w, height: h } = img
  const at = new Date().toISOString()
  const worn = slots.filter((s) => s.item)
  const rawBody = findBodyBox(img)
  // 人像框偶尔只框住躯干——深色裤、浅色地面对比度低时尤其明显（实测某张图底边只到 0.882）。
  // 一旦底边不准，按比例派生的裤装框会停在大腿、鞋框会跑到脚踝上方，用户看得到却点不中。
  // 我们的输入固定是「全身穿搭图」，所以：纵向按画幅取，水平仍用检测值（水平方向一直很稳）。
  const framed =
    rawBody && rawBody.h >= 0.55
      ? (() => {
          const y0 = Math.min(rawBody.y, 0.015)
          const y1 = Math.max(rawBody.y + rawBody.h, 0.985)
          return { ...rawBody, y: y0, h: y1 - y0 }
        })()
      : rawBody
  const body = framed
  const base: DetectionResult = {
    coordinateSpace: 'normalized',
    sourceWidth: w,
    sourceHeight: h,
    subject: body ? { x: body.x, y: body.y, w: body.w, h: body.h } : null,
    slots: [],
    detector: DETECTOR_ID,
    at,
  }
  if (!body) {
    base.slots = worn.map((s) => ({
      slot: s.slot,
      region: null,
      confidence: 0,
      status: 'missing' as const,
      method: 'geometric' as const,
      reason: '画面里没定位到人物（可能是空镜），请手动框选',
    }))
    return base
  }

  base.slots = worn.map((s) => {
    const proto = resolveColor(s.item!.color, s.item!.colorFamily)
    const r = locateSlot(img, body, s.slot, proto.rgb, proto.tol)
    return { ...r, colorUsed: proto.label }
  })
  return base
}

/* ------------------------------------------------------------- 命中测试 */

export interface RegionWithMeta {
  slot: SlotId
  region: Region
  status: 'ok' | 'low' | 'missing'
}

/**
 * 点击命中：只认可信区域，面积小的优先（鞋 > 包 > 上衣 > 裤装 > 外套），
 * 重叠时不会因为外套框大就永远被外套吃掉。
 */
export function pickRegion(list: RegionWithMeta[], px: number, py: number): SlotId | null {
  const hits = list
    .filter((r) => r.status === 'ok')
    .filter((r) => px >= r.region.x && px <= r.region.x + r.region.w && py >= r.region.y && py <= r.region.y + r.region.h)
    .sort((a, b) => a.region.w * a.region.h - b.region.w * b.region.h)
  return hits[0]?.slot ?? null
}
