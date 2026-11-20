/**
 * Phase 6 · P5 真实对话冒烟：模型会不会又自己填「已拥有」。
 *
 * 这是用户报的那个 bug 的原样复现：只说需求、没提自己有什么，
 * 旧版每份新方案都会多出一条「已拥有：深色直筒牛仔裤」。
 *
 * 两轮，都在隔离实例里：
 *  1 只说需求 → 建出来的方案里不能有任何 owned 槽位
 *  2 明说「我有一条深色牛仔裤」→ 允许 owned，但必须带用户原话（ownedClaims）
 *
 * 需要真实模型（dsh + DeepSeek），会产生少量费用。
 *   node scripts/check-p6-dialog.mjs
 *   KEEP_P6_DLG=1 node scripts/check-p6-dialog.mjs
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.cwd()
const PORT = 8792
const BASE = `http://127.0.0.1:${PORT}`
const OBS = { startedAt: new Date().toISOString(), turns: [] }

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

function makeDataDir() {
  const data = mkdtempSync(join(tmpdir(), 'cc-p6dlg-'))
  cpSync(join(REPO, 'data', 'state.json'), join(data, 'state.json'))
  if (existsSync(join(REPO, 'data', 'live'))) cpSync(join(REPO, 'data', 'live'), join(data, 'live'), { recursive: true })
  if (existsSync(join(REPO, 'data', 'scenes'))) cpSync(join(REPO, 'data', 'scenes'), join(data, 'scenes'), { recursive: true })
  // 故意**不**复制 chat.json：真实聊天记录里用户可能真的说过「我有一条牛仔裤」，
  // 带进来会让第一轮「凭空出现牛仔裤」的判定失真（第一次跑就踩到了）。
  // 这里要验的是「从没说过」的场景，所以从空对话开始。
  const st = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
  st.prefs = []
  writeFileSync(join(data, 'state.json'), JSON.stringify(st, null, 2))
  return data
}

let CHILD = null
let DATA = null
async function startInstance(data) {
  DATA = data
  CHILD = spawn(process.execPath, [join(REPO, 'packages', 'bridge', 'src', 'server.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      CROSSCART_PORT: String(PORT),
      CROSSCART_DATA_DIR: data,
      CROSSCART_BRIDGE_URL: BASE,
      SCENEGEN_AUTO_DEBOUNCE_MS: '999999',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  CHILD.stdout.on('data', () => {})
  CHILD.stderr.on('data', (d) => {
    const line = String(d).trim()
    if (line) log(`[instance] ${line.slice(0, 160)}`)
  })
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('隔离实例启动超时')
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'content-type': 'application/json' }, ...opts })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b ?? {}) })
/** GET /api/plans 返回的是方案对象数组，不是 id 数组（第一次写成 id 数组，断言全打在 404 上） */
const plansNow = async () => (await api('/api/plans')).body.plans ?? []
const planIds = async () => (await plansNow()).map((p) => p.planId)
const toolNames = (msg) => (msg?.tools ?? []).map((t) => t.name)

async function turn(text, timeoutMs = 300000) {
  const t0 = Date.now()
  const sent = await post('/api/chat', { text })
  if (sent.status >= 400) throw new Error(`发送失败：${sent.status} ${sent.body.error ?? ''}`)
  const baseCount = (sent.body.messages ?? []).length
  for (;;) {
    await new Promise((r) => setTimeout(r, 900))
    const snap = await api('/api/chat')
    const msgs = snap.body.messages ?? []
    if (!snap.body.running && msgs.length > baseCount) {
      const msg = [...msgs].reverse().find((m) => m.role === 'assistant')
      return { msg, ms: Date.now() - t0 }
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待模型超时（${Math.round(timeoutMs / 1000)}s）`)
  }
}

/** 本轮新出现的方案 id（不含对话前就有的） */
async function newPlanIds(before) {
  const known = new Set(before)
  return (await planIds()).filter((id) => !known.has(id))
}

/** 某份方案里的 owned 槽位（带来源凭证） */
async function ownedOf(planId) {
  const vm = (await api(`/api/plans/${encodeURIComponent(planId)}`)).body
  return (vm.slots ?? [])
    .filter((s) => s.status === 'owned')
    .map((s) => ({ plan: planId, slot: s.slot, label: s.label, title: s.item?.title, claim: s.ownedClaim?.quote ?? null }))
}

async function main() {
  await startInstance(makeDataDir())
  const before = await planIds()
  const chat0 = await api('/api/chat')
  log(`隔离实例就绪，已有 ${before.length} 份历史方案；对话消息 ${(chat0.body.messages ?? []).length} 条`)
  expect(
    !(chat0.body.messages ?? []).some((m) => m.role === 'user'),
    '从空对话开始（没有历史聊天可继承）',
    `${(chat0.body.messages ?? []).length} 条消息`,
  )

  /* ------------------------------------------------------------ 一 */
  section('[1] 只描述需求、没说自己有什么 → 新方案里不得出现「已拥有」')
  const t1 = await turn('我下周去东京玩三天，预算 200 美元，帮我搭一套适合拍照的衣服。')
  log(`工具调用：${toolNames(t1.msg).join('、') || '（无）'}；耗时 ${(t1.ms / 1000).toFixed(1)}s`)
  log(`回复：${String(t1.msg?.text ?? '').slice(0, 200)}`)
  expect(toolNames(t1.msg).includes('crosscart_create_plan'), '调用了建方案工具', toolNames(t1.msg).join('、'))
  const created1 = await newPlanIds(before)
  expect(created1.length >= 1, '确实建出了方案', created1.join(','))
  let owned1 = []
  for (const id of created1) owned1 = owned1.concat(await ownedOf(id))
  expect(owned1.length === 0, '方案里没有任何 owned 槽位（bug 的主症状）', owned1.map((o) => `${o.label}:${o.title}`).join(' / ') || '0 个')
  // 界面 / 文案也不能替用户声明所有权（数据干净但嘴上说「你的牛仔裤」同样是错的）
  const claimsInReply = String(t1.msg?.text ?? '').match(/你的[^，。；\n]{0,6}(裤|牛仔|外套|鞋|包)/g) ?? []
  expect(claimsInReply.length === 0, '回复里没有替用户声称「你已有某件」', claimsInReply.join(' / ') || '无')
  OBS.turns.push({ scenario: 1, text: '我下周去东京玩三天，预算 200 美元，帮我搭一套适合拍照的衣服。', tools: toolNames(t1.msg), plans: created1, owned: owned1, reply: t1.msg?.text, ms: t1.ms })

  /* ------------------------------------------------------------ 二 */
  section('[2] 明确说自己有一条 → 允许 owned，且必须带用户原话')
  const before2 = await planIds()
  const t2 = await turn('我家里已经有一条深色直筒牛仔裤了，这次不用买裤子，其他帮我配一下。')
  log(`工具调用：${toolNames(t2.msg).join('、') || '（无）'}；耗时 ${(t2.ms / 1000).toFixed(1)}s`)
  log(`回复：${String(t2.msg?.text ?? '').slice(0, 200)}`)
  const created2 = await newPlanIds(before2)
  let owned2 = []
  for (const id of created2) owned2 = owned2.concat(await ownedOf(id))
  // 也可能模型不新建方案，直接改当前这份 —— 两种都合规，都要查
  for (const id of before2.slice(-2)) {
    const found = await ownedOf(id)
    if (found.length) owned2 = owned2.concat(found.filter((f) => !owned2.some((o) => o.plan === f.plan && o.slot === f.slot)))
  }
  if (owned2.length === 0) {
    const asked = toolNames(t2.msg).includes('ask_user_question')
    expect(asked, '没落到 owned 槽位时，至少得是在追问用户（不能嘴上说「已按已有处理」）', toolNames(t2.msg).join('、') || '无工具调用')
    OBS.notes = ['场景二：模型未写入 owned 槽位；正向路径由 check:p6:owned 的确定性用例覆盖']
  } else {
    expect(true, '承认了用户已有的单品', owned2.map((o) => `${o.label}:${o.title}`).join(' / '))
    expect(owned2.every((o) => String(o.claim ?? '').length > 0), '每个 owned 都带用户原话凭证', owned2.map((o) => o.claim ?? '（缺）').join(' / '))
    expect(owned2.every((o) => /牛仔裤|深色/.test(String(o.claim ?? ''))), '凭证确实是这句话里的原话', owned2[0]?.claim)
  }
  OBS.turns.push({ scenario: 2, text: '我家里已经有一条深色直筒牛仔裤了，这次不用买裤子，其他帮我配一下。', tools: toolNames(t2.msg), plans: created2, owned: owned2, reply: t2.msg?.text, ms: t2.ms })

  /* ------------------------------------------------------------ 三 */
  section('[3] 缓冲：新开聊天后再只说需求 → 仍不得自动「已有」')
  await post('/api/chat/reset', {})
  const before3 = await planIds()
  const t3 = await turn('帮我出一个大阪四天的穿搭方案，预算 300 美元。')
  log(`工具调用：${toolNames(t3.msg).join('、') || '（无）'}；耗时 ${(t3.ms / 1000).toFixed(1)}s`)
  const created3 = await newPlanIds(before3)
  let owned3 = []
  for (const id of created3) owned3 = owned3.concat(await ownedOf(id))
  expect(owned3.length === 0, '重置聊天后的新方案同样没有 owned', owned3.map((o) => `${o.label}:${o.title}`).join(' / ') || '0 个')
  OBS.turns.push({ scenario: 3, text: '帮我出一个大阪四天的穿搭方案，预算 300 美元。', tools: toolNames(t3.msg), plans: created3, owned: owned3, reply: t3.msg?.text, ms: t3.ms })

  writeFileSync(join(REPO, 'docs', 'P6-owned-对话记录.json'), JSON.stringify(OBS, null, 2))
  console.log(`\n[p6-dialog] 通过 ${pass} 项，失败 ${fail} 项`)
  if (fail) console.log(`失败项：${failures.join(' / ')}`)
  if (process.env.KEEP_P6_DLG === '1') console.log(`隔离数据保留在 ${DATA}`)
}

main()
  .catch((e) => {
    fail += 1
    console.error('\n[p6-dialog] 异常：', e)
  })
  .finally(() => {
    if (CHILD) CHILD.kill()
    setTimeout(() => process.exit(fail ? 1 : 0), 300)
  })
