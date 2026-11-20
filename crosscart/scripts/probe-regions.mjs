/**
 * 调参工具：对 data/scenes 里的真实场景图跑一遍热点识别，输出数字 + 可视化叠图。
 * 不改任何状态、不调任何图像 API。用来人工核对「框到底压没压对」。
 *
 * 用法：node scripts/probe-regions.mjs [key...]
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { decodePng, downscale } from '../packages/bridge/src/png.mjs'
import { detectGarments } from '../packages/core/dist/index.js'

const ROOT = process.cwd()
const SCENES = join(ROOT, 'data', 'scenes')
const INDEX = JSON.parse(readFileSync(join(SCENES, 'index.json'), 'utf8'))
const STATE = JSON.parse(readFileSync(join(ROOT, 'data', 'state.json'), 'utf8'))
const OUT = join(ROOT, 'shots', 'regions')
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const only = process.argv.slice(2)
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))

const SLOT_COLOR = {
  outerwear: '#e0533d',
  top: '#2f6fd0',
  bottom: '#7b4fd0',
  shoes: '#12855f',
  bag: '#c99a06',
}

const entries = Object.values(INDEX.entries).filter((e) => e.status === 'ready')
const targets = only.length ? entries.filter((e) => only.some((k) => e.key.startsWith(k))) : entries

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1024, height: 1536 } })

const report = []
for (const e of targets) {
  const plan = STATE.plans.find((p) => p.planId === e.planId)
  if (!plan) {
    console.log(`- ${e.key}: 找不到方案 ${e.planId}，跳过`)
    continue
  }
  const file = join(SCENES, e.file)
  if (!existsSync(file)) {
    console.log(`- ${e.key}: 图片不存在 ${e.file}`)
    continue
  }
  const t0 = Date.now()
  const full = decodePng(readFileSync(file))
  const small = downscale(full, 320)
  const t1 = Date.now()
  const result = detectGarments(small, plan.slots)
  const t2 = Date.now()

  console.log(
    `\n=== ${e.key} ${e.label} (${plan.planId}) ${full.width}x${full.height} 解码 ${t1 - t0}ms 识别 ${t2 - t1}ms`,
  )
  console.log(`  subject ${JSON.stringify(result.subject)}`)
  for (const s of result.slots) {
    const r = s.region
    console.log(
      `  ${s.slot.padEnd(9)} ${s.status.padEnd(7)} conf=${String(s.confidence).padEnd(5)} ${s.method.padEnd(10)} ` +
        (r ? `x${r.x.toFixed(3)} y${r.y.toFixed(3)} w${r.w.toFixed(3)} h${r.h.toFixed(3)}` : 'region=null') +
        (s.reason ? `  // ${s.reason}` : ''),
    )
  }

  const regions = result.slots
    .filter((s) => s.region)
    .map((s) => {
      const r = s.region
      const color = SLOT_COLOR[s.slot] ?? '#000'
      return `<div style="position:absolute;left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%;
        border:3px ${s.status === 'ok' ? 'solid' : 'dashed'} ${color};box-sizing:border-box">
        <span style="position:absolute;left:0;top:0;background:${color};color:#fff;font:600 20px/1.2 system-ui;padding:3px 8px">
        ${s.slot} ${s.status} ${Math.round(s.confidence * 100)}</span></div>`
    })
    .join('')
  const sb = result.subject
  const subjBox = sb
    ? `<div style="position:absolute;left:${sb.x * 100}%;top:${sb.y * 100}%;width:${sb.w * 100}%;height:${sb.h * 100}%;
        border:2px dotted #00d0ff;box-sizing:border-box"></div>`
    : ''
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#111">
    <div style="position:relative;width:1024px;height:1536px">
      <img src="file:///${file.replace(/\\/g, '/')}" style="width:100%;height:100%;display:block">
      ${subjBox}${regions}
    </div></body>`
  const pageFile = join(OUT, `${e.key}.html`)
  writeFileSync(pageFile, html)
  await page.goto(`file:///${pageFile.replace(/\\/g, '/')}`)
  await page.waitForTimeout(250)
  const shot = join(OUT, `${e.key}.png`)
  await page.screenshot({ path: shot })
  report.push({ key: e.key, planId: plan.planId, label: e.label, subject: result.subject, slots: result.slots, shot })
}

await browser.close()
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(`\n叠图已写到 ${OUT}`)
