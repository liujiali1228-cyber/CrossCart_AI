/**
 * Phase 5 F4 · A4：真实对话验证（真实 DeepSeek + 真实 dsh 工具循环）。
 *
 * 只验三件事，都是「模型会不会按规矩来」而不是「代码能不能跑」：
 *  1 用户明确说「记住」→ 写入偏好（允许 AI 提议或直接保存，但必须有原话依据、不能冒充确认）
 *  2 一次临时换件          → 不得自动变成长期偏好
 *  3 用户改主意            → 新值生效、旧值进历史（不是两条同时生效）
 *
 * 为什么隔离：真实 data/state.json 与 data/chat.json 是用户自己的数据；
 * 这里用 mkdtemp + 独立端口 + 独立 CROSSCART_BRIDGE_URL，全程不碰真实目录。
 *
 *   node scripts/check-f4-dialog.mjs            # 真实模型，会产生少量费用
 *   KEEP_F4_DIALOG=1 node scripts/check-f4-dialog.mjs   # 保留隔离数据以便复查
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.cwd()
const PORT = 8795
const BASE = `http://127.0.0.1:${PORT}`
const OBS = { startedAt: new Date().toISOString(), turns: [], prefsAfter: [], notes: [] }

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
  const data = mkdtempSync(join(tmpdir(), 'cc-f4dlg-'))
  cpSync(join(REPO, 'data', 'state.json'), join(data, 'state.json'))
  if (existsSync(join(REPO, 'data', 'live'))) cpSync(join(REPO, 'data', 'live'), join(data, 'live'), { recursive: true })
  if (existsSync(join(REPO, 'data', 'scenes'))) cpSync(join(REPO, 'data', 'scenes'), join(data, 'scenes'), { recursive: true })
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
      // 插件工具必须打到隔离实例，否则会读写真实 8790 的状态
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

/** 发一句话，等到这一轮真的结束（或超时），返回这一轮的 assistant 消息。 */
async function turn(text, timeoutMs = 240000) {
  const t0 = Date.now()
  const sent = await post('/api/chat', { text })
  if (sent.status >= 400) throw new Error(`发送失败：${sent.status} ${sent.body.error ?? ''}`)
  const baseCount = (sent.body.messages ?? []).length
  for (;;) {
    await new Promise((r) => setTimeout(r, 800))
    const snap = await api('/api/chat')
    const msgs = snap.body.messages ?? []
    const done = !snap.body.running && msgs.length > baseCount
    if (done) {
      const msg = [...msgs].reverse().find((m) => m.role === 'assistant')
      return { msg, ms: Date.now() - t0, snap: snap.body }
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待模型超时（${Math.round(timeoutMs / 1000)}s）`)
  }
}

const toolNames = (msg) => (msg?.tools ?? []).map((t) => t.name)
const prefsNow = async () => (await api('/api/prefs')).body

async function main() {
  await startInstance(makeDataDir())

  // 准备：一条已确认的 palette=light（场景三需要「旧值进历史」）+ 一套有外套的方案
  await post('/api/prefs', { attr: 'palette', value: 'light', scope: 'profile', quote: '我平时喜欢浅色' })
  const items = (await api('/api/catalog?limit=400')).body.items ?? []
  const coat = items.find((c) => c.category === 'outerwear' && c.sourceKind !== 'seed') ?? items.find((c) => c.category === 'outerwear')
  const plan = await post('/api/plans', {
    label: '对话验收 · 东京 3 天',
    scene: { type: 'travel', destination: 'Tokyo', days: 3 },
    budgetLimit: 400,
    arrivalBy: '2026-12-20',
    slots: [{ slot: 'outerwear', status: 'to_buy', productId: coat.productId }],
  })
  expect(plan.status === 200, '准备一套方案（含外套）用于对话', plan.body.planId)

  /* ------------------------------------------------------------ 场景一 */
  section('[1] 用户明确说「记住」→ 写入偏好，且不能冒充用户确认')
  const t1 = await turn('我以后都不喜欢荧光色，帮我记住。')
  const tools1 = toolNames(t1.msg)
  log(`工具调用：${tools1.join('、') || '（无）'}；耗时 ${(t1.ms / 1000).toFixed(1)}s`)
  log(`回复：${String(t1.msg?.text ?? '').slice(0, 180)}`)
  const writeTool = tools1.find((n) => n === 'crosscart_save_pref' || n === 'crosscart_propose_pref')
  expect(Boolean(writeTool), '调用了偏好写入工具', writeTool ?? '没有调用')
  const p1 = await prefsNow()
  const newRec = (p1.all ?? [])
    .filter((p) => !p.deletedAt && (p.evidence?.quote?.includes('荧光') || String(p.value).includes('荧光')))
    .at(-1)
  expect(Boolean(newRec), '有偏好记录落库（值与依据都能对上）', newRec ? `${newRec.attr}=${newRec.value}` : '没找到')
  if (newRec) {
    expect(String(newRec.evidence?.quote ?? '').length > 0, '记录带用户原话依据', newRec.evidence?.quote)
    expect(newRec.source === 'ai', '来源记为 ai（不是 user_form 伪造）', newRec.source)
    const confirmed = Boolean(newRec.confirmedByUser)
    if (confirmed) {
      expect(writeTool === 'crosscart_save_pref', '直接确认只可能来自用户明确要求记住（save_pref）', writeTool)
    } else {
      expect((p1.pending ?? []).some((p) => p.id === newRec.id), '未确认时进入待确认列表，不参与推荐')
    }
    // 不许顺手改掉已确认的浅色偏好
    const light = (p1.all ?? []).find((p) => p.attr === 'palette' && String(p.value).includes('light') && !p.deletedAt)
    expect(Boolean(light) && !light.supersededBy, '场景一的写入没有覆盖 palette=light', light?.supersededBy ?? '未被取代')
  }
  OBS.turns.push({ scenario: 1, text: '我以后都不喜欢荧光色，帮我记住。', tools: tools1, reply: t1.msg?.text, record: newRec, ms: t1.ms })

  /* ------------------------------------------------------------ 场景二 */
  section('[2] 一次临时换件 → 不得变成长期偏好')
  const beforeProfile = (p1.prefs ?? []).filter((p) => p.scope === 'profile').map((p) => `${p.attr}=${p.value}`)
  const t2 = await turn('这次帮我换一件深色外套。')
  const tools2 = toolNames(t2.msg)
  log(`工具调用：${tools2.join('、') || '（无）'}；耗时 ${(t2.ms / 1000).toFixed(1)}s`)
  log(`回复：${String(t2.msg?.text ?? '').slice(0, 180)}`)
  expect(tools2.includes('crosscart_swap_item'), '调用了换件工具', tools2.join('、'))
  const p2 = await prefsNow()
  const profileAfter = (p2.prefs ?? []).filter((p) => p.scope === 'profile').map((p) => `${p.attr}=${p.value}`)
  expect(JSON.stringify(profileAfter) === JSON.stringify(beforeProfile), '长期偏好没有被这次换件改动', profileAfter.join(' / ') || '（空）')
  const taskPrefs = (p2.prefs ?? []).filter((p) => p.scope === 'task')
  const declared = (p2.pending ?? []).filter((p) => p.evidence?.basis === 'swap')
  if (taskPrefs.length || declared.length) {
    log(`如实记录：产生了 ${taskPrefs.length} 条「仅本次」偏好 / ${declared.length} 条待确认提议（不影响长期偏好）`)
  }
  OBS.turns.push({ scenario: 2, text: '这次帮我换一件深色外套。', tools: tools2, reply: t2.msg?.text, taskPrefs, pending: declared, ms: t2.ms })

  /* ------------------------------------------------------------ 场景三 */
  section('[3] 用户改主意 → 新值生效，旧值进历史')
  const t3 = await turn('我以前喜欢浅色，但现在更喜欢深色，以后按深色来。')
  const tools3 = toolNames(t3.msg)
  log(`工具调用：${tools3.join('、') || '（无）'}；耗时 ${(t3.ms / 1000).toFixed(1)}s`)
  log(`回复：${String(t3.msg?.text ?? '').slice(0, 180)}`)
  const p3 = await prefsNow()
  const dark = (p3.prefs ?? []).find((p) => p.attr === 'palette' && String(p.value).toLowerCase().includes('dark'))
  const lightRec = (p3.all ?? []).find((p) => p.attr === 'palette' && String(p.value).includes('light'))
  const darkPending = (p3.pending ?? []).find((p) => p.attr === 'palette' && String(p.value).toLowerCase().includes('dark'))
  if (dark) {
    expect(true, '新值 dark 已生效')
    expect(Boolean(lightRec?.supersededBy), '旧值 light 被标为已被取代（历史保留，不两条同时生效）', lightRec?.supersededBy)
    expect((p3.brief?.text ?? '').includes('dark') && !(p3.brief?.text ?? '').includes('light'), '注入模型的 brief 只有新值')
  } else if (darkPending) {
    expect(true, '模型只写了待确认（未擅自确认）', 'pending ' + darkPending.id)
    expect(!lightRec?.supersededBy, '待确认没有取代已确认的 light')
    OBS.notes.push('场景三：模型选择 propose_pref 而非 save_pref —— 符合「AI 不替用户确认」的边界，但需要用户点确认后才会按深色推荐')
  } else {
    expect(false, '既没有生效也没有待确认的 dark', `${(p3.prefs ?? []).map((p) => p.attr + '=' + p.value).join(',')} | pending ${(p3.pending ?? []).length}`)
  }
  OBS.turns.push({ scenario: 3, text: '我以前喜欢浅色，但现在更喜欢深色，以后按深色来。', tools: tools3, reply: t3.msg?.text, prefs: p3.prefs, pending: p3.pending, ms: t3.ms })

  /* ------------------------------------------------------------ 收尾 */
  OBS.prefsAfter = (await prefsNow()).all
  OBS.counts = (await prefsNow()).counts
  writeFileSync(join(REPO, 'docs', 'F4-对话验收.json'), JSON.stringify(OBS, null, 2))
  console.log(`\n[f4-dialog] 通过 ${pass} 项，失败 ${fail} 项`)
  if (fail) console.log(`失败项：${failures.join(' / ')}`)
  if (process.env.KEEP_F4_DIALOG === '1') console.log(`隔离数据保留在 ${DATA}`)
}

main()
  .catch((e) => {
    fail += 1
    console.error('\n[f4-dialog] 异常：', e)
  })
  .finally(() => {
    if (CHILD) CHILD.kill()
    setTimeout(() => process.exit(fail ? 1 : 0), 300)
  })
