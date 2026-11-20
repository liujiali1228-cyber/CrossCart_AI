/** 真实浏览器：首页输入需求 → AI 建方案 → 跳场景页 → 继续对话换件（不触发生成付费） */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8790'
const OUT = 'shots/redesign'
mkdirSync(OUT, { recursive: true })
const before = await (await fetch(`${BASE}/api/scenes/budget`)).json()

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const t0 = Date.now()

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
const PROMPT = process.argv[3] ?? '帮我搭一套日常通勤的穿搭，预算 150 美元，简洁一点'
await page.fill('#ask-input', PROMPT)
await page.screenshot({ path: `${OUT}/flow-1-home-filled.png` })
await page.click('#ask-go')

const phases = []
for (let i = 0; i < 60; i += 1) {
  await page.waitForTimeout(2000)
  const st = await page.evaluate(() => document.querySelector('#hero-status')?.innerText?.trim() ?? '')
  if (st && phases.at(-1) !== st) phases.push(st)
  const url = page.url()
  if (url.includes('plan=')) break
}
const url = page.url()
const elapsed = Math.round((Date.now() - t0) / 1000)
console.log('跳转 URL:', url, '耗时', elapsed, 's')
console.log('状态文案:', JSON.stringify(phases))
if (!url.includes('plan=')) {
  await page.screenshot({ path: `${OUT}/flow-1-home-timeout.png` })
  console.log('❌ 150s 内没有跳转')
  await browser.close()
  process.exit(1)
}
await page.waitForTimeout(2500)
await page.screenshot({ path: `${OUT}/flow-2-scene-created.png` })
const sceneInfo = await page.evaluate(() => ({
  title: document.querySelector('#plan-title')?.innerText,
  scene: document.querySelector('#scene-name')?.innerText,
  cats: [...document.querySelectorAll('.slot-chip')].map((e) => e.innerText.replace(/\n/g, ' ')),
  status: document.querySelector('#stage-overlay')?.innerText?.slice(0, 60) ?? '',
  toast: document.querySelector('#toast')?.innerText ?? '',
}))
console.log('场景页:', JSON.stringify(sceneInfo, null, 1))

// 继续对话：换外套（确定性操作，不调用图像 API）
const planId = new URL(url).searchParams.get('plan')
const rev0 = await (await fetch(`${BASE}/api/plans/${planId}`)).json()
await page.waitForTimeout(1500)
// 另一个窗口/上一轮验收可能仍在占用对话，先确认空闲再发
for (let i = 0; i < 20; i += 1) {
  const st = await (await fetch(`${BASE}/api/chat`)).json()
  if (!st.running) break
  await page.waitForTimeout(3000)
}
await page.fill('#chat-input', '外套换成更便宜的，只改外套')
await page.click('#btn-send')
await page.waitForTimeout(1200)
const sentToast = await page.evaluate(() => document.querySelector('#toast')?.innerText ?? '')
if (/另一|忙|BUSY/i.test(sentToast)) console.log('⚠ 发送被拒（对话占用）:', sentToast)
let rev1 = rev0
for (let i = 0; i < 60; i += 1) {
  await page.waitForTimeout(2000)
  const vm = await (await fetch(`${BASE}/api/plans/${planId}`)).json()
  if (vm.revision > rev0.revision) { rev1 = vm; break }
}
const after = await (await fetch(`${BASE}/api/scenes/budget`)).json()
const total = (v) => v.cost?.newItemsTotal ?? v.total
console.log('对话换件: revision', rev0.revision, '→', rev1.revision, '| 总额', total(rev0), '→', total(rev1))
console.log('图像费用:', before.budget?.spent, '→', after.budget?.spent, '(应不变)')
await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}/flow-3-after-chat.png` })
console.log('JS 错误:', errors.length, errors.slice(0, 2))
await browser.close()
