/**
 * 热点识别（bridge 侧）：读图 → 调 core 的确定性检测 → 落进场景索引。
 *
 * 单独成文件，不混进 scenegen：图像生成和「图上找衣服」是两种能力，
 * 前者可能接不同 provider，后者未来也可能换成视觉模型。
 */
import { readFileSync } from 'node:fs'
import { decodePng, downscale } from './png.mjs'
import { detectGarments, CONFIDENT, DEFAULT_REGIONS, ownedConstraints } from '../../core/dist/index.js'

/** 分析分辨率：320 宽足够定位人体框，再大只是浪费 CPU。 */
const ANALYSIS_WIDTH = 320

/**
 * 跑一次识别。返回：
 *  - regions: 每个槽位一个归一化矩形（低置信度的也要存，界面标黄但不可点）
 *  - meta: 识别来源/置信度/坐标体系/图片尺寸，供界面与验收核对
 */
export function detectSceneHotspots({ file, plan, log }) {
  const t0 = Date.now()
  const buf = readFileSync(file)
  const full = decodePng(buf)
  const small = downscale(full, ANALYSIS_WIDTH)
  const result = detectGarments(small, plan.slots ?? [])
  const regions = {}
  const slotMeta = {}
  for (const s of result.slots) {
    if (!s.region) continue
    regions[s.slot] = s.region
    slotMeta[s.slot] = {
      status: s.status,
      confidence: s.confidence,
      method: s.method,
      reason: s.reason ?? null,
      colorUsed: s.colorUsed ?? null,
    }
  }
  const okCount = Object.values(slotMeta).filter((m) => m.status === 'ok').length
  const meta = {
    detector: result.detector,
    coordinateSpace: 'normalized',
    sourceWidth: full.width,
    sourceHeight: full.height,
    analysisWidth: small.width,
    subject: result.subject,
    slots: slotMeta,
    okCount,
    total: result.slots.length,
    ms: Date.now() - t0,
    at: new Date().toISOString(),
  }
  log?.('hotspots', `${meta.detector} ${meta.okCount}/${meta.total} 项可信，${meta.ms}ms`)
  return { regions, meta }
}

/**
 * 人工修正后的热点：来源改成 manual、置信度按「用户亲手框的」记 1，
 * 但仍旧保存坐标体系，方便复算缓存键时报清楚。
 */
export function manualHotspot(region) {
  const x = Math.min(1, Math.max(0, Number(region.x)))
  const y = Math.min(1, Math.max(0, Number(region.y)))
  const w = Math.min(1 - x, Math.max(0.01, Number(region.w)))
  const h = Math.min(1 - y, Math.max(0.01, Number(region.h)))
  return { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)), w: Number(w.toFixed(4)), h: Number(h.toFixed(4)) }
}

export { CONFIDENT }

/* ---------------------------------------------------- 已有单品的像素级复检 */

/** 区域内的亮度分位数（0–1）。只做灰阶统计，不判断「这是不是鞋」。 */
function regionLuma(img, region) {
  const x0 = Math.max(0, Math.floor(region.x * img.width))
  const y0 = Math.max(0, Math.floor(region.y * img.height))
  const x1 = Math.min(img.width, Math.ceil((region.x + region.w) * img.width))
  const y1 = Math.min(img.height, Math.ceil((region.y + region.h) * img.height))
  const vals = []
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4
      if (img.data[i + 3] < 32) continue
      vals.push((0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]) / 255)
    }
  }
  if (!vals.length) return null
  vals.sort((a, b) => a - b)
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))]
  return { p50: q(0.5), p90: q(0.9), n: vals.length }
}

/**
 * 复检「用户自有的东西」有没有被画成别的颜色。
 *
 * 能做什么 / 不能做什么（必须说清楚，别把它当成视觉理解）：
 *  - 能：在默认热点区域做灰阶统计，发现**量级上的矛盾** —— 用户说白鞋、画面上那块整体是深色。
 *  - 不能：判断「那是不是鞋」「是不是白」，也不认颜色语义。
 * 所以阈值取得很保守，只在「明显违背」时才判失败；判失败也只重画一次。
 */
export function checkOwnedMatch(buf, plan) {
  const wanted = ownedConstraints(plan).filter((c) => c.family === 'light' || c.family === 'dark')
  if (!wanted.length) return { ok: true, method: 'pixel-luma', checks: [], at: new Date().toISOString() }
  let img
  try {
    img = downscale(decodePng(buf), ANALYSIS_WIDTH)
  } catch (e) {
    // 解不出来就如实说「没做成」，不要默认通过
    return { ok: null, method: 'pixel-luma', error: `图像解码失败：${e.message}`, checks: [], at: new Date().toISOString() }
  }
  const checks = wanted.map((c) => {
    const region = DEFAULT_REGIONS[c.slot]
    const stat = region ? regionLuma(img, region) : null
    let verdict = 'unknown'
    if (stat) {
      if (c.family === 'light') verdict = stat.p90 >= 0.55 ? 'ok' : 'mismatch'
      else verdict = stat.p50 <= 0.72 ? 'ok' : 'mismatch'
      // 中间地带（不是极端矛盾）不判失败：宁可放过，也不要为了「更严」反复重画烧钱
      if (verdict === 'mismatch' && c.family === 'light' && stat.p90 >= 0.42) verdict = 'unclear'
      if (verdict === 'mismatch' && c.family === 'dark' && stat.p50 <= 0.82) verdict = 'unclear'
    }
    return { slot: c.slot, label: c.label, expected: c.family, seen: stat, verdict }
  })
  const bad = checks.filter((c) => c.verdict === 'mismatch')
  return {
    ok: bad.length === 0,
    method: 'pixel-luma',
    // 只用于「重画时把话说得更死」，不写进用户界面
    correction: bad.map((c) => `${c.label} (${c.slot})`).join(', '),
    checks,
    at: new Date().toISOString(),
  }
}
