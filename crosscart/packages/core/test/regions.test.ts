/**
 * 热点识别单测：全部用**合成图**，不碰网络、不花钱。
 * 思路：画一个确定的人形（外套/上衣/裤/鞋/包各占一个已知矩形），
 * 断言识别出来的框确实落在那块矩形里 —— 而不是「返回了坐标就算过」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectGarments,
  findBodyBox,
  resolveColor,
  colorDistance,
  pickRegion,
  CONFIDENT,
  type RgbaImage,
  type Region,
} from '../dist/index.js'

type Rect = { x0: number; y0: number; x1: number; y1: number }

const W = 200
const H = 300

function blankImage(w = W, h = H): RgbaImage {
  const data = new Uint8Array(w * h * 4)
  // 背景：中性墙色 + 轻微渐变（模拟真实照片里没有纯色背景）
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const v = 150 + Math.round((x / w) * 26) + Math.round((y / h) * 10)
      data[i] = v
      data[i + 1] = v - 2
      data[i + 2] = v - 6
      data[i + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

function fill(img: RgbaImage, r: Rect, color: [number, number, number]) {
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const i = (y * img.width + x) * 4
      img.data[i] = color[0]
      img.data[i + 1] = color[1]
      img.data[i + 2] = color[2]
      img.data[i + 3] = 255
    }
  }
}

const RECTS = {
  outerwear: { x0: 58, y0: 58, x1: 142, y1: 160 },
  top: { x0: 86, y0: 66, x1: 114, y1: 120 },
  bottom: { x0: 68, y0: 152, x1: 132, y1: 262 },
  shoes: { x0: 72, y0: 262, x1: 128, y1: 288 },
  bag: { x0: 52, y0: 74, x1: 82, y1: 140 },
}

/** 画一个「穿着五件衣服、全身居中」的人 */
function personImage(opts: { withPerson?: boolean; wrongColors?: boolean } = {}): RgbaImage {
  const img = blankImage()
  if (opts.withPerson === false) return img
  // 头（肤色）+ 头发，让 body box 有明确的顶端
  fill(img, { x0: 84, y0: 22, x1: 116, y1: 56 }, [196, 154, 124])
  fill(img, { x0: 82, y0: 16, x1: 118, y1: 30 }, [40, 32, 28])
  // 衣服：故意让上衣是深色（和外套浅色形成层次）
  fill(img, RECTS.outerwear, opts.wrongColors ? [30, 60, 160] : [240, 236, 226])
  fill(img, RECTS.top, opts.wrongColors ? [230, 220, 120] : [37, 47, 78])
  fill(img, RECTS.bottom, opts.wrongColors ? [200, 40, 150] : [152, 149, 144])
  fill(img, RECTS.shoes, opts.wrongColors ? [40, 180, 90] : [246, 246, 244])
  fill(img, RECTS.bag, opts.wrongColors ? [250, 200, 60] : [37, 47, 78])
  return img
}

/** 和真实方案同构的槽位输入 */
const SLOTS = [
  { slot: 'outerwear' as const, item: { title: 'Turtleneck Zip-Up Jacket in Midweight Cashmere', color: 'Snow', colorFamily: 'mid' as const, category: 'outerwear' as const } },
  { slot: 'top' as const, item: { title: 'The Box-Cut Tee', color: 'Navy', colorFamily: 'dark' as const, category: 'top' as const } },
  { slot: 'bottom' as const, item: { title: 'Luxe Fleece Seamled Barrel Pant', color: 'Vintage Heather Grey', colorFamily: 'mid' as const, category: 'bottom' as const } },
  { slot: 'shoes' as const, item: { title: "Women's Cruiser Canvas", color: 'white', colorFamily: 'light' as const, category: 'shoes' as const } },
  { slot: 'bag' as const, item: { title: 'ReNew Transit Small Backpack', color: 'Navy Blazer', colorFamily: 'dark' as const, category: 'bag' as const } },
]

function center(r: Region) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}
function insideRegion(img: RgbaImage, region: Region, rect: Rect) {
  const c = center(region)
  const px = c.x * img.width
  const py = c.y * img.height
  return px >= rect.x0 - 2 && px <= rect.x1 + 2 && py >= rect.y0 - 2 && py <= rect.y1 + 2
}

test('定位人体框：合成的全身人像能被找到，且大致覆盖人形', () => {
  const img = personImage()
  const box = findBodyBox(img)
  assert.ok(box, '应该找到人体框')
  assert.ok(box!.y < 0.2, `人体框顶端应该在上面（实际 ${box!.y.toFixed(3)}）`)
  assert.ok(box!.y + box!.h > 0.85, `人体框应该覆盖到脚（实际 ${(box!.y + box!.h).toFixed(3)}）`)
  // 和实际躯干（58–142px）至少有 70% 的水平重叠，而不是只沾一点边
  const bx0 = box!.x * img.width
  const bx1 = (box!.x + box!.w) * img.width
  const overlap = Math.max(0, Math.min(bx1, 142) - Math.max(bx0, 58))
  assert.ok(overlap >= (bx1 - bx0) * 0.7, `人体框应该压在躯干上（重叠 ${overlap.toFixed(0)}px / 宽 ${(bx1 - bx0).toFixed(0)}px）`)
})

test('热点跟着人走：横向随人体框，纵向按全身画幅取满', () => {
  // 同一个画法，整体纵向压到 0.8（模拟人物在画面里更小、离镜头更远）
  const squish = (r: Rect): Rect => ({
    x0: r.x0,
    y0: Math.round(150 + (r.y0 - 150) * 0.8),
    x1: r.x1,
    y1: Math.round(150 + (r.y1 - 150) * 0.8),
  })
  const img = blankImage()
  fill(img, squish({ x0: 84, y0: 22, x1: 116, y1: 56 }), [196, 154, 124])
  fill(img, squish(RECTS.outerwear), [240, 236, 226])
  fill(img, squish(RECTS.top), [37, 47, 78])
  fill(img, squish(RECTS.bottom), [152, 149, 144])
  fill(img, squish(RECTS.shoes), [246, 246, 244])
  fill(img, squish(RECTS.bag), [37, 47, 78])

  const normal = detectGarments(personImage(), SLOTS)
  const smaller = detectGarments(img, SLOTS)
  assert.ok(normal.subject && smaller.subject, '两张图都应该定位到人')
  // 纵向：全身穿搭图一律取满画幅。检测框常常只到小腿（深色裤腿与地面同色），
  // 若照它缩，裤装框会停在大腿、鞋框会飘到脚踝上方 —— 真实图上肉眼可见的错位。
  assert.ok(normal.subject!.h >= 0.9, `全身图纵向应取满画幅（实际 ${normal.subject!.h.toFixed(3)}）`)
  assert.ok(smaller.subject!.h >= 0.9, `压矮后仍取满画幅（实际 ${smaller.subject!.h.toFixed(3)}）`)
  // 横向：必须跟着人物实际位置走，而不是钉在画面中央
  assert.ok(
    Math.abs(smaller.subject!.x - normal.subject!.x) < 0.03,
    `人物横向位置应稳定（${normal.subject!.x.toFixed(3)} vs ${smaller.subject!.x.toFixed(3)}）`,
  )
  assert.ok(normal.subject!.h / normal.subject!.w > 1.6, '全身构图的人体框是竖长的')
})

test('半身构图不强行拉满画幅（否则人物以外的背景会被当成衣服）', () => {
  // 只画上半身：人像纵向占 0.05–0.45，比半画幅还矮 → 不该被扩展成 0.98
  const img = blankImage()
  fill(img, { x0: 84, y0: 20, x1: 116, y1: 52 }, [196, 154, 124])
  fill(img, { x0: 46, y0: 56, x1: 154, y1: 150 }, [240, 236, 226])
  const res = detectGarments(img, SLOTS)
  if (res.subject) {
    assert.ok(res.subject.h < 0.9, `半身图不应拉满画幅（实际 ${res.subject.h.toFixed(3)}）`)
  }
})

test('五类衣物各得一个区域，且落在它自己的位置上', () => {
  const img = personImage()
  const res = detectGarments(img, SLOTS)
  assert.equal(res.coordinateSpace, 'normalized')
  assert.equal(res.sourceWidth, W)
  assert.equal(res.slots.length, 5)
  for (const slot of ['outerwear', 'top', 'bottom', 'shoes', 'bag'] as const) {
    const s = res.slots.find((x) => x.slot === slot)
    assert.ok(s, `${slot} 应该有结果`)
    assert.ok(s!.region, `${slot} 应该有区域`)
    assert.ok(insideRegion(img, s!.region!, RECTS[slot]), `${slot} 的区域应该压在画的矩形上`)
    assert.equal(s!.status, 'ok', `${slot} 应该判定为可信`)
    assert.ok(s!.confidence >= CONFIDENT, `${slot} 置信度应该 >= ${CONFIDENT}`)
  }
})

test('区域坐标永远在 0–1 内（归一化，页面缩放不错位）', () => {
  const res = detectGarments(personImage(), SLOTS)
  for (const s of res.slots) {
    const r = s.region!
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, `${s.slot} 越界: ${JSON.stringify(r)}`)
  }
})

test('画面里没有人：不硬编坐标，全部标 missing', () => {
  const res = detectGarments(personImage({ withPerson: false }), SLOTS)
  assert.equal(res.slots.length, 5)
  for (const s of res.slots) {
    assert.equal(s.status, 'missing')
    assert.equal(s.region, null)
    assert.match(s.reason ?? '', /手动框选/)
  }
})

test('颜色对不上：置信度必须降下来（不能拿错坐标当可信）', () => {
  const ok = detectGarments(personImage(), SLOTS)
  const wrong = detectGarments(personImage({ wrongColors: true }), SLOTS)
  const avg = (r: ReturnType<typeof detectGarments>) =>
    r.slots.reduce((s, x) => s + x.confidence, 0) / r.slots.length
  assert.ok(avg(wrong) < avg(ok), `颜色不符时平均置信度应该更低（${avg(wrong).toFixed(2)} vs ${avg(ok).toFixed(2)}）`)
})

test('颜色解析：商家色名映射到可用的代表色', () => {
  const snow = resolveColor('Snow', 'mid')
  assert.ok(colorDistance(snow.rgb, { r: 240, g: 236, b: 226 }) < 0.02, 'Snow 应该解析成米白')
  const navy = resolveColor('Navy Blazer', 'dark')
  assert.ok(navy.rgb.b > navy.rgb.r + 20, 'Navy 应该偏蓝')
  const grey = resolveColor('Vintage Heather Grey', 'mid')
  assert.ok(Math.abs(grey.rgb.r - grey.rgb.g) < 12, 'Heather Grey 应该接近中性灰')
  const unknown = resolveColor('Mystery Color', 'dark')
  assert.ok(unknown.tol >= 60, '认不出的颜色要放宽容差，而不是硬猜')
})

test('同一张图两次识别结果完全一致（无随机数）', () => {
  const a = detectGarments(personImage(), SLOTS)
  const b = detectGarments(personImage(), SLOTS)
  const strip = (r: typeof a) => r.slots.map((s) => [s.slot, s.status, s.confidence, s.region])
  assert.deepEqual(strip(a), strip(b))
})

test('点击命中：只认可信区域，重叠时小区域优先', () => {
  const list = [
    { slot: 'outerwear' as const, region: { x: 0.2, y: 0.1, w: 0.6, h: 0.5 }, status: 'ok' as const },
    { slot: 'bag' as const, region: { x: 0.22, y: 0.2, w: 0.12, h: 0.2 }, status: 'ok' as const },
    { slot: 'shoes' as const, region: { x: 0.3, y: 0.8, w: 0.2, h: 0.1 }, status: 'low' as const },
  ]
  assert.equal(pickRegion(list, 0.26, 0.3), 'bag', '重叠处应该命中面积更小的包')
  assert.equal(pickRegion(list, 0.6, 0.45), 'outerwear')
  assert.equal(pickRegion(list, 0.35, 0.85), null, '低置信区域不允许触发点击')
})
