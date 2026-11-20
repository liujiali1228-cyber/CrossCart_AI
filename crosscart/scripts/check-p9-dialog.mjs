/**
 * Phase 9 · P9-1 真实链路验证：用户说「我有白鞋、棕包」，场景图里到底有没有。
 *
 * 这是用户报的那个 bug 的原样复现（截图里人物脚上是黑短靴）。
 * 三轮，都在隔离实例里跑真实模型 + 真实图像 API：
 *   1 直说白鞋棕包 → 方案必须把它们记成「自有」，且不要重复推荐鞋包
 *   2 提示词必须带上白鞋/棕包，并写成硬约束
 *   3 真出一张图，保存到 shots/p9/，并用像素级复检记录它到底像不像
 *
 * 费用：1 次对话 + 1 张图（约 $0.3）。不做无限重试。
 *   node scripts/check-p9-dialog.mjs
 *   KEEP_P9_DLG=1 node scripts/check-p9-dialog.mjs     # 保留隔离数据与图片
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.cwd()
const PORT = 8794
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = join(REPO, 'shots', 'p9')
const TEXT = '我打算去纽约玩一天，请帮我搭配一身。预算300美元，我有白色的鞋子和棕色的包包，其它的你看着搭配。'
const OBS = { startedAt: new Date().toISOString(), text: TEXT, turns: [] }

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
  const data = mkdtempSync(join(tmpdir(), 'cc-p9dlg-'))
  cpSync(join(REPO, 'data', 'state.json'), join(data, 'state.json'))
  if (existsSync(join(REPO, 'data', 'live'))) cpSync(join(REPO, 'data', 'live'), join(data, 'live'), { recursive: true })
  if (existsSync(join(REPO, 'data', 'scenes'))) cpSync(join(REPO, 'data', 'scenes'), join(data, 'scenes'), { recursive: true })
  for (const f of ['scenegen.config.json', 'scenegen.usage.json']) {
    const src = join(REPO, 'data', f)
    if (existsSync(src)) cpSync(src, join(data, f))
  }
  // 从空对话开始：要验的是「用户这次说了什么」，不是历史里说过什么
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
      CROSSCART_PUBLIC_URL: BASE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  CHILD.stdout.on('data', () => {})
  CHILD.stderr.on('data', (d) => {
    const line = String(d).trim()
    if (line) log(`[instance] ${line.slice(0, 160)}`)
  })
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('隔离实例启动超时')
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'content-type': 'application/json' }, ...opts })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b ?? {}) })
const plansNow = async () => (await api('/api/plans')).body.plans ?? []
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

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  await startInstance(makeDataDir())
  const before = (await plansNow()).map((p) => p.planId)
  log(`隔离实例就绪，已有 ${before.length} 份历史方案`)

  /* ------------------------------------------------------------ 一 */
  section('[1] 用户说「我有白色的鞋子和棕色的包包」→ 方案要认这两件事')
  const t1 = await turn(TEXT)
  log(`工具调用：${toolNames(t1.msg).join('、') || '（无）'}；耗时 ${(t1.ms / 1000).toFixed(1)}s`)
  log(`回复：${String(t1.msg?.text ?? '').replace(/\s+/g, ' ').slice(0, 260)}`)
  const created = (await plansNow()).map((p) => p.planId).filter((id) => !before.includes(id))
  expect(created.length >= 1, '确实建出了方案', created.join(','))
  const planId = created.at(-1)
  const vm = (await api(`/api/plans/${planId}`)).body
  const shoes = vm.slots.find((s) => s.slot === 'shoes')
  const bag = vm.slots.find((s) => s.slot === 'bag')
  log(`鞋位：status=${shoes?.status} item=${shoes?.item?.title ?? 'null'} 描述=${shoes?.ownedClaim?.label ?? '无'}`)
  log(`包位：status=${bag?.status} item=${bag?.item?.title ?? 'null'} 描述=${bag?.ownedClaim?.label ?? '无'}`)

  expect(shoes?.status === 'owned', '鞋位被记成「已有」而不是再买一双', shoes?.status)
  expect(bag?.status === 'owned', '包位被记成「已有」而不是再买一个', bag?.status)
  expect(
    /白/.test(`${shoes?.ownedClaim?.label ?? ''}${shoes?.item?.color ?? ''}${shoes?.item?.title ?? ''}`),
    '鞋的颜色是白（来自用户这句话）',
    shoes?.ownedClaim?.label ?? shoes?.item?.color ?? '（无）',
  )
  expect(
    /棕|咖|驼/.test(`${bag?.ownedClaim?.label ?? ''}${bag?.item?.color ?? ''}${bag?.item?.title ?? ''}`),
    '包的颜色是棕',
    bag?.ownedClaim?.label ?? bag?.item?.color ?? '（无）',
  )
  expect(Boolean(shoes?.ownedClaim?.quote || shoes?.item), '鞋的「已有」带用户原话凭证（不是凭空来的）')
  expect(
    vm.slots.filter((s) => s.status === 'to_buy' && ['shoes', 'bag'].includes(s.slot)).length === 0,
    '没有重复推荐鞋/包去购买',
  )
  const prompt = vm.sceneView?.prompt ?? ''
  expect(/white/i.test(prompt), '提示词里写出了白鞋', prompt.slice(0, 90))
  expect(/brown/i.test(prompt), '提示词里写出了棕包')

  /* ------------------------------------------------------------ 二 */
  section('[2] 真出一张图，看它是不是照着这句话画的')
  const t0 = Date.now()
  const gen = await post(`/api/plans/${planId}/scene/regenerate`, { confirm: true, force: true })
  log(`生成接口返回 ${gen.status}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  expect(gen.status === 200, '生成成功（不是 4xx/5xx）', String(gen.status))
  const sv = gen.body.view ?? gen.body.sceneView ?? gen.body
  expect(sv?.status === 'ready', `图已就绪（${sv?.status}）`)
  const ownedCheck = sv?.ownedCheck ?? null
  log(`像素复检：${JSON.stringify(ownedCheck)}`)
  expect(ownedCheck !== null, '做过结果复检（不是只把 prompt 写上就算完）')
  expect(ownedCheck?.ok !== false, '复检没有发现明显违背（白鞋没被画成黑靴这一级）', JSON.stringify(ownedCheck?.checks ?? []))

  // 把图存到仓库里，供报告引用
  const rel = String(sv?.image ?? '').split('?')[0]
  // 图在**隔离实例**的数据目录里（不是仓库的 data/）—— 第一版写错了根目录，图没存下来
  const abs = rel.startsWith('/scenes/') ? join(DATA, 'scenes', rel.replace(/^\/scenes\//, '')) : null
  if (abs && existsSync(abs)) {
    const out = join(SHOTS, `nyc-owned-white-shoes-brown-bag${abs.endsWith('.webp') ? '.webp' : '.png'}`)
    cpSync(abs, out)
    const png = abs.replace(/\.webp$/, '.png')
    if (existsSync(png)) cpSync(png, join(SHOTS, 'nyc-owned-white-shoes-brown-bag.png'))
    log(`图已保存到 shots/p9/`)
  } else log(`没找到图片文件：${abs}`)
  writeFileSync(join(REPO, 'docs', 'P9-真实生图记录.json'), JSON.stringify({ ...OBS, planId, prompt, sceneView: { status: sv?.status, image: sv?.image, ownedCheck } }, null, 2))

  /* ------------------------------------------------------------ 三 */
  section('[3] 回复本身：不能出现方案链接、内部编号或「槽位」这类词')
  const reply = String(t1.msg?.text ?? '')
  expect(!/https?:\/\//.test(reply), '回复里没有 URL', (reply.match(/https?:\/\/\S+/) ?? [''])[0])
  expect(!/pln_\d+/.test(reply), '回复里没有方案编号')
  expect(!/槽位|链路|已拥有状态|执行完成|系统识别/.test(reply), '回复里没有内部用语')
  expect(!/方案链接/.test(reply), '回复里没有「方案链接」字样')
}

try {
  await main()
} catch (e) {
  fail += 1
  failures.push(`异常：${e.message}`)
  console.log(`\n✗ 运行中断：${e.stack ?? e.message}`)
} finally {
  try {
    CHILD?.kill()
  } catch {}
}

console.log(`\n===== check:p9:dialog ${pass}/${pass + fail} =====`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(` - ${f}`)
  process.exit(1)
}
