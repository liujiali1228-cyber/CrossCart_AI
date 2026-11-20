/**
 * Phase 9 · 回归：已有单品进生图 / 自动更新不再二次确认 / 聊天不出现方案链接 / 首页灵感外链。
 *
 * 这个脚本只做**确定性**验证（不调模型、不调图像 API，零费用）：
 *   A 抽象「已有」：用户说「我有白色的鞋子」但没有商品 ID 时，方案怎么记、提示词怎么写
 *   B 来源校验：没说过 / 这段对话没提过 → 一律 422，且不落库
 *   C 改口：白鞋改黑靴 → 提示词与缓存键都要变（否则缓存命中旧图，看起来像没生效）
 *   D 自动更新：开着 = 换件即排队生成；关着 = 只标 stale，不偷偷花钱
 *   E 聊天与排版：回复里的方案链接被清掉、字号/行高达到可读标准
 *   F 首页编辑精选：页头独立灵感行已删，四张卡片箭头各带一条真实外链
 *
 *   node scripts/check-p9.mjs
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../packages/bridge/src/state.mjs'
import { planContext } from '../packages/bridge/src/plan-context.mjs'
import { buildScenePrompt, sceneCacheKey, resolveScene, ownedConstraints } from '../packages/core/dist/index.js'

const REPO = process.cwd()
const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`
const OUTER = 'everlane:womens-oversized-blazer-brown-houndstooth'

let pass = 0
let fail = 0
const failures = []
function expect(ok, label, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}
const section = (t) => console.log(`\n${t}`)
const log = (t) => console.log(`  · ${t}`)

const TODAY = new Date().toISOString().slice(0, 10)
const ARRIVAL = new Date(Date.parse(TODAY) + 10 * 86400000).toISOString().slice(0, 10)

function makeDataDir() {
  const data = mkdtempSync(join(tmpdir(), 'cc-p9-'))
  cpSync(join(REPO, 'data', 'state.json'), join(data, 'state.json'))
  if (existsSync(join(REPO, 'data', 'live'))) cpSync(join(REPO, 'data', 'live'), join(data, 'live'), { recursive: true })
  if (existsSync(join(REPO, 'data', 'scenes'))) cpSync(join(REPO, 'data', 'scenes'), join(data, 'scenes'), { recursive: true })
  // 图像配置也复制：不复制的话实例是 unconfigured，「有没有排队」就验不出真实状态
  for (const f of ['scenegen.config.json', 'scenegen.usage.json']) {
    const src = join(REPO, 'data', f)
    if (existsSync(src)) cpSync(src, join(data, f))
  }
  return data
}

/** 建一份带「抽象已有」的方案；userText 就是「用户这段对话说过什么」 */
/** 隔离实例的 Workspace：必须带上 live 目录缓存，否则真实商品 ID 查不到 */
function makeWs(dataDir) {
  const livePath = join(REPO, 'data', 'live', 'catalog.json')
  const live = existsSync(livePath) ? JSON.parse(readFileSync(livePath, 'utf8')) : null
  return new Workspace({ dataDir, live })
}

function buildOwnedPlan({ userText = '', shoes = null, bag = null, label = 'P9 白鞋棕包' } = {}) {
  const data = makeDataDir()
  const ws = makeWs(data)
  ws.setUserTextSource(() => userText)
  const slots = [{ slot: 'outerwear', status: 'to_buy', productId: OUTER }]
  const claims = []
  if (shoes) {
    slots.push({ slot: 'shoes', status: 'owned', ownedLabel: shoes.label })
    claims.push({ slot: 'shoes', label: shoes.label, color: shoes.color, quote: shoes.quote })
  } else slots.push({ slot: 'shoes', status: 'empty' })
  if (bag) {
    slots.push({ slot: 'bag', status: 'owned', ownedLabel: bag.label })
    claims.push({ slot: 'bag', label: bag.label, color: bag.color, quote: bag.quote })
  } else slots.push({ slot: 'bag', status: 'empty' })
  slots.push({ slot: 'top', status: 'empty' }, { slot: 'bottom', status: 'empty' })
  const plan = ws.createPlan({
    label,
    scene: { type: 'travel', destination: 'New York', days: 1 },
    budgetLimit: 300,
    arrivalBy: ARRIVAL,
    shipTo: 'CN',
    slots,
    ownedClaims: claims,
  })
  return { ws, plan, data }
}

/* ============================================================ A */
section('[A] 用户说「我有白鞋、棕包」但没有商品 ID：方案要记住，提示词要写上')
const WHITE_SHOES_TEXT = '我打算去纽约玩一天，帮我搭配一身。预算300美元，我有白色的鞋子和棕色的包包，其它的你看着搭配。'
let ctxA = null
{
  const { ws, plan } = buildOwnedPlan({
    userText: WHITE_SHOES_TEXT,
    shoes: { label: '白色运动鞋', color: 'white', quote: '我有白色的鞋子' },
    bag: { label: '棕色的包', color: 'brown', quote: '我有棕色的包包' },
  })
  const shoes = plan.slots.find((s) => s.slot === 'shoes')
  const bag = plan.slots.find((s) => s.slot === 'bag')
  expect(shoes?.status === 'owned', '鞋位记为「已有」', shoes?.status)
  expect(shoes?.item === null, '没有为了填槽位去虚构一款商品（item 为 null）', String(shoes?.item))
  expect(shoes?.ownedClaim?.label === '白色运动鞋', '记下用户自己的说法', shoes?.ownedClaim?.label)
  expect(shoes?.ownedClaim?.color === 'white', '解析出颜色词', String(shoes?.ownedClaim?.color))
  expect(bag?.ownedClaim?.color === 'brown', '棕包同样记下颜色', String(bag?.ownedClaim?.color))

  const vm = ws.viewModel(plan)
  const vmShoes = vm.slots.find((s) => s.slot === 'shoes')
  expect(vmShoes?.item === null && vmShoes?.ownedClaim?.label === '白色运动鞋', '视图模型带着来源与描述，界面才能如实显示')

  const spec = resolveScene({ place: 'nyc-commute' })
  const prompt = buildScenePrompt(plan, spec)
  log(`prompt 片段：${prompt.slice(0, 150)}…`)
  expect(/white shoes/.test(prompt), '提示词里写上了「white shoes」')
  expect(/brown bag/.test(prompt), '提示词里写上了「brown bag」')
  expect(/must appear exactly as described/.test(prompt), '写成硬约束，而不是可选形容词')
  expect(/do not substitute/.test(prompt), '明确禁止替换（黑靴就是这么冒出来的）')

  // 只有一件待买时金额只算那一件：自有不计入支出
  expect(vm.cost.newItemsTotal > 0, '待买的还在算钱', `$${vm.cost.newItemsTotal}`)
  expect(
    plan.slots.filter((s) => s.status === 'owned').every((s) => s.item === null),
    '自有单品没有价格快照，不可能被算进总额',
  )

  ctxA = planContext(ws, plan.planId)
  expect(/白色运动鞋/.test(ctxA), '上下文里也告诉模型「用户自己有白鞋」')
  expect(/不要编一款商品代替/.test(ctxA), '上下文明确不许编一款商品冒充')
}

/* ============================================================ B */
section('[B] 来源校验：没说过的「已有」进不来')
{
  const data = makeDataDir()
  const ws = makeWs(data)
  ws.setUserTextSource(() => WHITE_SHOES_TEXT)
  const base = {
    label: 'x',
    scene: { type: 'travel', destination: 'Tokyo', days: 2 },
    budgetLimit: 200,
    arrivalBy: ARRIVAL,
    shipTo: 'CN',
  }
  const mk = (slots, claims) => () => ws.createPlan({ ...base, slots, ownedClaims: claims })

  let code = null
  try {
    mk([{ slot: 'shoes', status: 'owned', ownedLabel: '白色运动鞋' }], [])()
  } catch (e) {
    code = e.code
  }
  expect(code === 'OWNED_UNDECLARED', '有描述但没有原话 → 422', String(code))

  code = null
  try {
    mk([{ slot: 'shoes', status: 'owned', ownedLabel: '白色运动鞋' }], [{ productId: 'own_dark_jeans', quote: '我有一条牛仔裤' }])()
  } catch (e) {
    code = e.code
  }
  expect(code === 'OWNED_UNDECLARED', '原话对不上这个搭配位 → 422', String(code))

  // 这段对话没有提过鞋：不能因为上一份方案/示例数据里有，就当成用户有
  const ws2 = makeWs(makeDataDir())
  ws2.setUserTextSource(() => '我想去巴黎待两天，预算 200 美元，帮我配一套')
  let code2 = null
  try {
    ws2.createPlan({
      ...base,
      slots: [{ slot: 'shoes', status: 'owned', ownedLabel: '白色运动鞋' }],
      ownedClaims: [{ slot: 'shoes', label: '白色运动鞋', quote: '我有白色的鞋子' }],
    })
  } catch (e) {
    code2 = e.code
  }
  expect(code2 === 'OWNED_UNDECLARED', '这段对话没提过鞋 → 422（不从历史推断）', String(code2))

  // 新开聊天：之前那段对话说过，重置后不算数
  const ws3 = makeWs(makeDataDir())
  ws3.setUserTextSource(() => '帮我搭一套大阪的穿搭，预算 300 美元')
  ws3.markNewChat()
  let code3 = null
  try {
    ws3.createPlan({
      ...base,
      slots: [{ slot: 'shoes', status: 'owned', ownedLabel: '白色运动鞋' }],
      ownedClaims: [{ slot: 'shoes', label: '白色运动鞋', quote: '我有白色的鞋子' }],
    })
  } catch (e) {
    code3 = e.code
  }
  expect(code3 === 'OWNED_UNDECLARED', '新开聊天后不自动继承（即使服务端还记得原话）', String(code3))
}

/* ============================================================ C */
section('[C] 用户改口：白鞋 → 黑靴，提示词与缓存键都要变')
{
  const white = buildOwnedPlan({
    userText: WHITE_SHOES_TEXT,
    shoes: { label: '白色运动鞋', color: 'white', quote: '我有白色的鞋子' },
  })
  const black = buildOwnedPlan({
    userText: '我有一双黑色长靴，别的你看着搭',
    shoes: { label: '黑色长靴', color: 'black', quote: '我有一双黑色长靴' },
  })
  const spec = resolveScene({ place: 'nyc-commute' })
  const pw = buildScenePrompt(white.plan, spec)
  const pb = buildScenePrompt(black.plan, spec)
  expect(/white shoes/.test(pw) && !/black shoes/.test(pw), '白鞋方案的提示词里没有黑鞋')
  expect(/black shoes/.test(pb) && !/white shoes/.test(pb), '黑靴方案的提示词里没有白鞋')
  const kw = sceneCacheKey(white.plan, spec)
  const kb = sceneCacheKey(black.plan, spec)
  expect(kw !== kb, '缓存键跟着变（否则会直接复用旧图）', `${kw} vs ${kb}`)
  // 没有抽象自有时缓存键保持原样：老图不会因为这次改动全部失效
  const plain = buildOwnedPlan({ userText: WHITE_SHOES_TEXT })
  const kp = sceneCacheKey(plain.plan, spec)
  const ownedOnly = sceneCacheKey(
    { ...plain.plan, slots: plain.plan.slots.map((s) => (s.status === 'owned' ? { ...s, status: 'empty' } : s)) },
    spec,
  )
  expect(kp === ownedOnly, '没有自有单品时缓存键不变（老缓存不失效）', `${kp} / ${ownedOnly}`)
  expect(ownedConstraints(white.plan).length === 1, 'ownedConstraints 只取抽象自有', String(ownedConstraints(white.plan).length))
}

/* ============================================================ D */
section('[D] 自动更新：开着换件就排队生成，关着只标「上一版」')
const CHILD = { proc: null }
let DATA = null
async function startInstance(data) {
  DATA = data
  CHILD.proc = spawn(process.execPath, [join(REPO, 'packages', 'bridge', 'src', 'server.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      CROSSCART_PORT: String(PORT),
      CROSSCART_DATA_DIR: data,
      CROSSCART_BRIDGE_URL: BASE,
      // 防抖窗口拉到很大：只验证「有没有排队」，绝不在测试里真的调图像 API
      SCENEGEN_AUTO_DEBOUNCE_MS: '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  CHILD.proc.stdout.on('data', () => {})
  CHILD.proc.stderr.on('data', (d) => {
    const line = String(d).trim()
    if (line) log(`[instance] ${line.slice(0, 140)}`)
  })
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('隔离实例没能启动')
}

/** 停掉实例并等端口真的释放：否则下一个实例会撞 EADDRINUSE，请求可能打到旧进程上。 */
async function stopInstance() {
  try {
    CHILD.proc?.kill()
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(`${BASE}/api/health`)
      await new Promise((r) => setTimeout(r, 200))
    } catch {
      return
    }
  }
}

const api = async (path, opts = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

try {
  await startInstance(makeDataDir())
  const plans = (await api('/api/plans')).body.plans ?? []
  const target = plans.find((p) => p.planId === 'pln_020') ?? plans.at(-1)
  const planId = target.planId
  const before = (await api(`/api/plans/${planId}`)).body
  const slot = before.slots.find((s) => s.item && s.status === 'to_buy')
  const cands = (await api(`/api/plans/${planId}/candidates?slot=${slot.slot}&strategy=similar`)).body
  const next = (cands.items ?? cands.candidates ?? []).find((c) => c.productId !== slot.item.productId)
  expect(Boolean(next), '找到一件可替换的候选', next?.title ?? '（无）')

  // 开自动更新（拨动开关即生效，不再二次确认）
  const on = await api(`/api/plans/${planId}/scene/auto`, { method: 'POST', body: { enabled: true } })
  expect(on.body.enabled === true, '自动更新已打开', String(on.body.enabled))

  const swappedOn = await api(`/api/plans/${planId}/swap`, { method: 'POST', body: { slot: slot.slot, productId: next.productId, by: 'ui' } })
  expect(swappedOn.status === 200, '换件成功', String(swappedOn.status))
  const svOn = swappedOn.body.sceneView
  expect(svOn?.auto?.enabled === true, '换件后仍处于自动模式')
  expect(svOn?.auto?.pending === true, '换件后自动排队生成（不需要用户再点一次）', `status=${svOn?.status}`)
  expect(!swappedOn.body.requiresConfirm && !svOn?.requiresConfirm, '换件的响应里没有「请确认生成」')

  // 关掉自动更新：换件只更新清单，图保持上一版并如实标 stale
  await api(`/api/plans/${planId}/scene/auto`, { method: 'POST', body: { enabled: false } })
  const slot2 = (await api(`/api/plans/${planId}`)).body.slots.find((s) => s.item && s.status === 'to_buy')
  const cands2 = (await api(`/api/plans/${planId}/candidates?slot=${slot2.slot}&strategy=similar`)).body
  const next2 = (cands2.items ?? cands2.candidates ?? []).find((c) => c.productId !== slot2.item.productId)
  const swappedOff = await api(`/api/plans/${planId}/swap`, { method: 'POST', body: { slot: slot2.slot, productId: next2.productId, by: 'ui' } })
  const svOff = swappedOff.body.sceneView
  expect(svOff?.auto?.enabled === false, '自动更新已关闭')
  expect(svOff?.auto?.pending === false, '关着时不会排队生成', `status=${svOff?.status}`)
  expect(svOff?.stale === true || svOff?.status !== 'generating', '图明确标成「上一版」而不是继续冒充当前搭配')
  expect(svOff?.status !== 'generating', '关着时没有偷偷在后台画图', String(svOff?.status))

  // P10：手动重新生成不再「先确认」。服务端成本闸门仍在（预算 + 频率），但不再有确认步骤。
  // 具体契约放到 [D2] 用「没有图像配置」的副本验证：既证明没有确认步骤，也不会真的花钱。
} finally {
  await stopInstance()
}

/* ============================================================ D2 */
section('[D2] 生图入口不再有「请确认生成」这一步（零费用副本）')
try {
  const bare = makeDataDir()
  rmSync(join(bare, 'scenegen.config.json'), { force: true })
  await startInstance(bare)
  const plans = (await api('/api/plans')).body.plans ?? []
  const pid = plans.at(-1)?.planId
  expect(Boolean(pid), '副本里读到方案', pid ?? '（空）')
  const first = await api(`/api/plans/${pid}/scene/regenerate`, { method: 'POST', body: { force: true } })
  expect(
    first.status === 503 && first.body.code === 'SCENEGEN_UNCONFIGURED',
    '不带 confirm 直接执行；未配置就如实 503（不是回一句「请确认」）',
    `${first.status} ${first.body.code ?? ''}`,
  )
  expect(!('requiresConfirm' in first.body), '响应里没有 requiresConfirm 字段')
  const auto = await api(`/api/plans/${pid}/scene/auto`, { method: 'POST', body: { enabled: true } })
  expect(auto.status === 200 && auto.body.enabled === true, '自动更新开关直接生效（不再要求 confirmBudget）', String(auto.body.enabled))
  expect(!('requiresConfirm' in auto.body), '开关响应里也没有 requiresConfirm')
} finally {
  await stopInstance()
}

/* ============================================================ E + F（真浏览器，只读） */
section('[E] 聊天展示与排版：不出现方案链接，正文 16px 起')
{
  const { chromium } = await import('playwright-core')
  const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  const browser = await chromium.launch({ executablePath: EDGE, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto('http://127.0.0.1:8790/?plan=pln_020', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2200)

    const clean = await page.evaluate(() => {
      const fn = window.__ccCleanReply
      if (!fn) return null
      return {
        md: fn('搭配好了，很衬你。\n\n方案链接：https://example.com/?plan=pln_006\n'),
        bare: fn('看这里 https://x.trycloudflare.com/?plan=pln_012 就好'),
        inline: fn('已经建好「纽约 1 天」pln_031，随时可以改。'),
        money: fn('新买的衣服大约 $222，预算 $300，还剩 $78。'),
        // 历史消息里真实出现过的写法（原文是：段落结尾一个「方案：」标签 + 一个链接）
        anchor: fn('已按你的要求换了外套。\n\n这件更轻，适合看展室内；建议加围巾。方案：\n[方案：打开查看](http://127.0.0.1:8790/?plan=pln_020)'),
      }
    })
    expect(Boolean(clean), '清洗函数在页面上可用（暴露给验收脚本）')
    expect(clean && !/https?:\/\//.test(clean.md), 'markdown 方案链接被清掉', JSON.stringify(clean?.md))
    expect(clean && !/https?:\/\//.test(clean.bare), '裸链接被清掉', JSON.stringify(clean?.bare))
    expect(clean && !/pln_\d+/.test(clean.inline), '内部方案编号不出现', JSON.stringify(clean?.inline))
    expect(clean && /\$222/.test(clean.money), '金额原样保留（清洗不能连数字一起吞）', JSON.stringify(clean?.money))
    expect(
      clean && !/打开查看|方案：|https?:\/\//.test(clean.anchor) && /换了外套/.test(clean.anchor),
      '「[方案：打开查看](…?plan=)」这类历史链接整段清掉、正文保留',
      JSON.stringify(clean?.anchor),
    )

    const type = await page.evaluate(() => {
      const b = document.querySelector('.msg-assistant .bubble, .msg-user .bubble')
      const ta = document.querySelector('#chat-input')
      const cs = b ? getComputedStyle(b) : null
      return {
        size: cs ? parseFloat(cs.fontSize) : null,
        lh: cs ? parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) : null,
        input: ta ? parseFloat(getComputedStyle(ta).fontSize) : null,
        share: !!document.querySelector('#btn-share'),
      }
    })
    expect(type.size === null || type.size >= 15.5, '聊天正文 ≥ 15.5px', `${type.size}px`)
    expect(type.lh === null || type.lh >= 1.5, '行高 ≥ 1.5', `${type.lh?.toFixed(2)}`)
    expect(type.input >= 15, '输入框文字同步放大', `${type.input}px`)
    expect(type.share === true, '顶栏有分享入口（链接能力留在页面里）')

    // 内部编号不该出现在任何「人看到的文字」里：聊天、方案切换下拉、标题
    const idLeak = await page.evaluate(() => {
      const texts = []
      for (const el of document.querySelectorAll('#plan-select option, #plan-title, #plan-sub, .msg-assistant .bubble')) {
        const t = (el.textContent ?? '').trim()
        if (t) texts.push(t)
      }
      return texts.filter((t) => /pln_\d+/.test(t))
    })
    expect(idLeak.length === 0, '页面文字里没有内部方案编号（pln_xxx）', idLeak.slice(0, 2).join(' | '))

    // 最后一条回复不能「露一半」：既不能被容器裁掉，也不能停在半路
    const pin = await page.evaluate(() => {
      const box = document.querySelector('#messages')
      const last = [...document.querySelectorAll('.msg-assistant .bubble')].at(-1)
      if (!box || !last) return null
      const bb = box.getBoundingClientRect()
      const lb = last.getBoundingClientRect()
      return {
        gap: Math.round(bb.bottom - lb.bottom),
        atBottom: box.scrollHeight - box.scrollTop - box.clientHeight <= 2,
      }
    })
    expect(!pin || (pin.gap >= 0 && pin.atBottom), '最后一条回复完整可见（1440）', JSON.stringify(pin))

    // 390 窄屏：正文同样不能缩水
    const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await m.goto('http://127.0.0.1:8790/?plan=pln_020', { waitUntil: 'domcontentloaded' })
    await m.waitForTimeout(1600)
    const small = await m.evaluate(() => {
      const b = document.querySelector('.msg-assistant .bubble, .msg-user .bubble')
      const cs = b ? getComputedStyle(b) : null
      const box = document.querySelector('#messages')
      const last = [...document.querySelectorAll('.msg-assistant .bubble')].at(-1)
      const pin =
        box && last
          ? {
              gap: Math.round(box.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom),
              atBottom: box.scrollHeight - box.scrollTop - box.clientHeight <= 2,
            }
          : null
      return {
        size: cs ? parseFloat(cs.fontSize) : null,
        overflowX: document.documentElement.scrollWidth - innerWidth,
        pin,
      }
    })
    expect(small.size === null || small.size >= 15.5, '移动端正文同样 ≥ 15.5px', `${small.size}px`)
    expect(small.overflowX <= 1, '移动端没有横向溢出', `${small.overflowX}px`)
    expect(!small.pin || (small.pin.gap >= 0 && small.pin.atBottom), '最后一条回复完整可见（390）', JSON.stringify(small.pin))
    await m.close()
  } finally {
    await browser.close()
  }
}

section('[F] 首页：独立灵感行已删除，四张编辑精选卡片各带一条真实外链')
{
  const { chromium } = await import('playwright-core')
  const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  const browser = await chromium.launch({ executablePath: EDGE, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto('http://127.0.0.1:8790/', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1400)

    const oldRow = await page.evaluate(() => ({
      inspo: document.querySelectorAll('#hero-chips .inspo').length,
      heroText: document.querySelector('#hero-chips')?.innerText ?? '',
    }))
    expect(oldRow.inspo === 0, '页头那排「灵感 ↗」外链已彻底删除', `count=${oldRow.inspo}`)
    expect(!/灵感/.test(oldRow.heroText), '页头不再出现「灵感」字样（只留风格词与偏好入口）', oldRow.heroText.replace(/\s+/g, ' '))

    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('#insp-grid .insp')].map((el) => {
        const a = el.querySelector('a.insp-go')
        const b = el.querySelector('.insp-cap b')
        const r = a?.getBoundingClientRect()
        return {
          title: b?.textContent?.trim() ?? '',
          href: a?.getAttribute('href') ?? null,
          target: a?.getAttribute('target') ?? null,
          rel: a?.getAttribute('rel') ?? null,
          label: a?.getAttribute('aria-label') ?? '',
          text: a?.textContent?.trim() ?? '',
          box: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
        }
      }),
    )
    expect(cards.length === 4, '四张编辑精选卡片都在', String(cards.length))
    expect(cards.every((c) => c.href && /^https:\/\//.test(c.href)), '每张卡片都有一条 https 外链', cards.map((c) => c.href).join(' | '))
    expect(
      cards.every((c) => c.target === '_blank' && /noopener/.test(c.rel ?? '')),
      '外链都在新标签页打开且带 noopener',
    )
    expect(
      cards.every((c) => /^https:\/\/(www\.)?(vogue\.com|harpersbazaar\.com)\//.test(c.href ?? '')),
      '来源是 Vogue / Harper\'s BAZAAR 的具体页面',
      cards.map((c) => c.href).join(' | '),
    )
    expect(
      cards.every((c) => (c.href ?? '').replace(/^https:\/\/[^/]+/, '').length > 8),
      '指向具体栏目/文章，不是站点首页',
      cards.map((c) => c.href).join(' | '),
    )
    expect(
      cards.every((c) => c.label.length > 6 && /新标签页/.test(c.label)),
      '箭头有可读的说明（屏幕阅读器知道这是外链）',
      cards[0]?.label,
    )
    // 命中区：视觉还是小箭头，但点击区域不小于 30×30
    expect(
      cards.every((c) => c.box && c.box.w >= 30 && c.box.h >= 30),
      '箭头命中区已扩大（≥30×30）',
      cards.map((c) => (c.box ? `${c.box.w}×${c.box.h}` : 'n/a')).join(' '),
    )
    expect(cards.every((c) => c.text === '↗'), '箭头视觉仍是极简的 ↗', cards.map((c) => c.text).join('|'))

    // 点箭头：真的开新标签页，页面本身不跳走
    const beforeUrl = page.url()
    const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 8000 }), page.click('#insp-grid .insp:first-child a.insp-go')])
    expect(Boolean(popup), '点箭头打开了新标签页')
    await popup.close()
    expect(page.url() === beforeUrl, '原页面没有被替换（不打断站内操作）', page.url())

    // 卡片本身的站内行为不能丢：点图片/标题仍然把需求填进输入框
    await page.click('#insp-grid .insp[data-insp="2"] .insp-media')
    const filled = await page.inputValue('#ask-input')
    expect(/周末/.test(filled), '点卡片仍然填入需求（外链没有覆盖原功能）', filled.slice(0, 30))
    await page.click('#hero-chips [data-preset="0"]')
    const filled2 = await page.inputValue('#ask-input')
    expect(/东京/.test(filled2), '风格词点击仍然填写需求', filled2.slice(0, 30))

    // 390 窄屏：箭头不能溢出卡片，也不能压住标题
    const m = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await m.goto('http://127.0.0.1:8790/', { waitUntil: 'domcontentloaded' })
    await m.waitForTimeout(1200)
    const mobile = await m.evaluate(() => {
      const out = [...document.querySelectorAll('#insp-grid .insp')].map((el) => {
        const a = el.querySelector('a.insp-go')?.getBoundingClientRect()
        const b = el.querySelector('.insp-cap b')?.getBoundingClientRect()
        return {
          arrowRight: a ? Math.round(a.right) : null,
          titleRight: b ? Math.round(b.right) : null,
          cardRight: Math.round(el.getBoundingClientRect().right),
          overlap: a && b ? a.top < b.bottom && a.left < b.right : null,
        }
      })
      return { out, overflowX: document.documentElement.scrollWidth - window.innerWidth }
    })
    expect(mobile.overflowX <= 1, '390px 没有横向溢出', `${mobile.overflowX}px`)
    expect(
      mobile.out.every((x) => x.arrowRight !== null && x.arrowRight <= x.cardRight + 10),
      '窄屏箭头没有跑出卡片',
      mobile.out.map((x) => `${x.arrowRight}/${x.cardRight}`).join(' '),
    )
    expect(mobile.out.every((x) => x.overlap === false), '窄屏箭头没有压住标题文字')
    // 交付截图必须拍到「卡片 + 箭头」本身：只拍页头看不出外链挪到哪了
    for (const [pg, file] of [
      [page, 'shots/p9/home-insp-1440.png'],
      [m, 'shots/p9/home-insp-390.png'],
    ]) {
      await pg.evaluate(() => document.querySelector('#insp-grid')?.scrollIntoView({ block: 'center' }))
      await pg
        .waitForFunction(() => {
          const imgs = [...document.querySelectorAll('#insp-grid img')]
          return imgs.length >= 4 && imgs.every((i) => i.complete && i.naturalWidth > 0)
        }, { timeout: 20000 })
        .catch(() => {})
      await pg.waitForTimeout(500)
      await pg.screenshot({ path: file })
    }
    await m.close()
  } finally {
    await browser.close()
  }
}

console.log(`\n===== check:p9 ${pass}/${pass + fail} =====`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(` - ${f}`)
  process.exit(1)
}
