/**
 * Phase 10 · 部署准备验收（确定性，不调模型、不调图像 API，零费用）
 *
 * 验的不是「代码看起来对不对」，而是部署时会真的踩到的几件事：
 *   A 全新目录启动：没有任何 state.json 也能起，工作区从零开始
 *   B 重启恢复：换进程（=容器重启/重新部署）后方案与偏好还在
 *   C 损坏恢复：state.json 被写坏时回退到 .bak，而不是「方案全没了」
 *   D 频率限流：公开模式下高频请求会被 429，且提示里没有内部费用
 *   E 生图入口也受限：未配置 → 503，超过次数 → 429（不再有确认步骤）
 *   F 管理接口：公开模式默认不存在；配了 admin token 才能用
 *   G 密钥不外泄：API Key 不出现在任何响应与日志里
 *
 *   node scripts/check-p10.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.cwd()

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

const PROCS = []
process.on('exit', () => {
  for (const p of PROCS) {
    try {
      p.kill()
    } catch {
      /* ignore */
    }
  }
})

function freshDir(tag) {
  const d = mkdtempSync(join(tmpdir(), `cc-p10-${tag}-`))
  return d
}

/** 起一个隔离实例；data 目录直接指向临时目录（等于「新服务器上的空磁盘」） */
async function start({ port, data, env = {} }) {
  const proc = spawn(process.execPath, [join(REPO, 'packages', 'bridge', 'src', 'server.mjs')], {
    // cwd 故意不用仓库根：验证「换一个运行目录也能起来」，只靠代码自身定位资源
    cwd: tmpdir(),
    env: {
      ...process.env,
      CROSSCART_PORT: String(port),
      CROSSCART_DATA_DIR: data,
      CROSSCART_BRIDGE_URL: `http://127.0.0.1:${port}`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  PROCS.push(proc)
  const logs = []
  proc.stdout.on('data', (d) => logs.push(String(d)))
  proc.stderr.on('data', (d) => logs.push(String(d)))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${base}/api/health`)
      if (r.ok) return { proc, base, logs }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`实例 ${port} 启动超时：${logs.join('').slice(0, 400)}`)
}

async function stop(inst) {
  try {
    inst.proc.kill()
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`${inst.base}/api/health`)
      await new Promise((r) => setTimeout(r, 150))
    } catch {
      return
    }
  }
}

const api = async (base, path, opts = {}) => {
  const r = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await r.text()
  let body = {}
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status: r.status, body, text }
}

/* ============================================================ A 全新目录 */
section('[A] 全新数据目录：没有任何 state.json 也能起，工作区从零开始')
const DATA_A = freshDir('a')
let inst = await start({ port: 8781, data: DATA_A, env: { CROSSCART_DEMO_MODE: '1' } })
{
  const health = await api(inst.base, '/api/health')
  expect(health.status === 200 && health.body.ok === true, '健康检查通过', String(health.status))
  expect(existsSync(join(DATA_A, 'state.json')), 'state.json 在数据目录里被创建（不是写回仓库 data/）')
  const page = await fetch(`${inst.base}/`)
  expect(page.status === 200 && /text\/html/.test(page.headers.get('content-type') ?? ''), '首页可打开', String(page.status))
  const plans = await api(inst.base, '/api/plans')
  expect(plans.status === 200 && Array.isArray(plans.body.plans), '空工作区自动给了一份示例方案', `${plans.body.plans?.length ?? 0} 份`)
}

/* ============================================================ B 重启恢复 */
section('[B] 重启恢复：换一个进程后方案与偏好还在')
let planIdB = null
{
  const created = await api(inst.base, '/api/plans/demo', { method: 'POST', body: {} })
  planIdB = created.body.planId
  expect(created.status === 200 && Boolean(planIdB), '新建一份方案', planIdB ?? '')
  const pref = await api(inst.base, '/api/prefs', {
    method: 'POST',
    body: { attr: 'style', value: '极简', scope: 'profile', confirmedByUser: true },
  })
  expect(pref.status === 200, '保存一条偏好', String(pref.status))
  const before = JSON.parse(readFileSync(join(DATA_A, 'state.json'), 'utf8'))
  expect(before.plans.some((p) => p.planId === planIdB), '落盘文件里已经有这份方案')

  await stop(inst)
  inst = await start({ port: 8781, data: DATA_A, env: { CROSSCART_DEMO_MODE: '1' } })
  const after = await api(inst.base, '/api/plans')
  expect(after.body.plans.some((p) => p.planId === planIdB), '重启后方案还在', planIdB ?? '')
  const prefs = await api(inst.base, '/api/prefs')
  expect((prefs.body.prefs ?? []).some((p) => String(p.value ?? '').includes('极简')), '重启后偏好还在')
}

/* ============================================================ C 损坏恢复 */
section('[C] state.json 被写坏：回退到 .bak，而不是「方案全丢」')
{
  await stop(inst)
  writeFileSync(join(DATA_A, 'state.json'), '{"plans": [ {"planId": "pln_99', 'utf8')
  expect(existsSync(join(DATA_A, 'state.json.bak')), '上一版备份存在（.bak）')
  inst = await start({ port: 8781, data: DATA_A, env: { CROSSCART_DEMO_MODE: '1' } })
  const after = await api(inst.base, '/api/plans')
  expect(after.body.plans.some((p) => p.planId === planIdB), '半截 JSON 被识别，从备份恢复出方案', planIdB ?? '')
  expect(
    inst.logs.join('').includes('回退到 .bak'),
    '日志明确说了发生了回退（可排查，不静默）',
    inst.logs.join('').match(/\[state\][^\n]*/)?.[0] ?? '',
  )
}

/* ============================================================ D 频率限流 */
section('[D] 公开模式：高频请求会被限流，提示里没有内部费用')
const DATA_D = freshDir('d')
const instD = await start({
  port: 8782,
  data: DATA_D,
  env: {
    CROSSCART_PUBLIC: '1',
    CROSSCART_DEMO_MODE: '1',
    CROSSCART_RATE_API_PER_IP_PER_MIN: '6',
    CROSSCART_RATE_WRITE_PER_IP_PER_MIN: '100',
    CROSSCART_RATE_CHAT_PER_HOUR: '0',
    CROSSCART_RATE_IMAGE_PER_HOUR: '0',
  },
})
{
  let last = null
  let limited = 0
  for (let i = 0; i < 12; i += 1) {
    last = await api(instD.base, '/api/plans')
    if (last.status === 429) limited += 1
  }
  expect(limited > 0, `连续请求触发 429（${limited} 次）`, last?.body?.code ?? '')
  expect(last.body.code === 'RATE_LIMITED', '返回结构化错误码 RATE_LIMITED', String(last.body.code))
  expect(!/[$¥]|额度|账单|budget/i.test(last.body.error ?? ''), '提示是自然语言，不含费用/额度信息', last.body.error ?? '')
  const health = await api(instD.base, '/api/health')
  expect(health.status === 200 && !health.body.plans, '公开模式健康检查只回最小信息（不含方案列表）', JSON.stringify(health.body).slice(0, 80))
}

/* ============================================================ E 生图入口 */
section('[E] 生图入口：没有确认步骤；未配置如实 503，超过次数 429')
const DATA_E = freshDir('e')
const instE = await start({
  port: 8783,
  data: DATA_E,
  env: {
    CROSSCART_PUBLIC: '1',
    CROSSCART_RATE_API_PER_IP_PER_MIN: '1000',
    CROSSCART_RATE_WRITE_PER_IP_PER_MIN: '1000',
    CROSSCART_RATE_IMAGE_PER_HOUR: '0',
    CROSSCART_RATE_IMAGE_PER_IP_PER_HOUR: '2',
  },
})
{
  const plans = await api(instE.base, '/api/plans')
  const pid = plans.body.plans?.[0]?.planId
  const first = await api(instE.base, `/api/plans/${pid}/scene/regenerate`, { method: 'POST', body: {} })
  expect(
    first.status === 503 ? first.body.code === 'SCENEGEN_UNCONFIGURED' : first.status === 200,
    '点一次就直接执行（未配置则如实 503，不再回「请确认」）',
    `${first.status} ${first.body.code ?? ''}`,
  )
  expect(!('requiresConfirm' in first.body), '响应里没有 requiresConfirm')
  const second = await api(instE.base, `/api/plans/${pid}/scene/regenerate`, { method: 'POST', body: {} })
  const third = await api(instE.base, `/api/plans/${pid}/scene/regenerate`, { method: 'POST', body: {} })
  expect(second.status === 429 || third.status === 429, '超过单访客次数后返回 429', `${second.status}/${third.status}`)
}

/* ============================================================ F 管理接口 */
section('[F] 管理/调试接口：公开模式默认不存在，配了 token 才能用')
{
  const budgetClosed = await api(instE.base, '/api/scenes/budget')
  expect(budgetClosed.status === 404, '未配 admin token：额度日志接口不存在（不暴露内部费用）', String(budgetClosed.status))
  const refreshClosed = await api(instE.base, '/api/catalog/refresh', { method: 'POST', body: {} })
  expect(refreshClosed.status === 404, '未配 admin token：目录刷新接口不存在', String(refreshClosed.status))

  const instF = await start({
    port: 8784,
    data: freshDir('f'),
    env: { CROSSCART_PUBLIC: '1', CROSSCART_ADMIN_TOKEN: 'test-admin-7c1', CROSSCART_RATE_API_PER_IP_PER_MIN: '0' },
  })
  const noHeader = await api(instF.base, '/api/scenes/budget')
  expect(noHeader.status === 404, '配了 token 但请求没带：仍然 404', String(noHeader.status))
  const withHeader = await api(instF.base, '/api/scenes/budget', { headers: { 'x-cc-admin': 'test-admin-7c1' } })
  expect(withHeader.status === 200 && Boolean(withHeader.body.budget), '带正确 x-cc-admin：可查内部额度', String(withHeader.status))
  await stop(instF)
}

/* ============================================================ G 密钥不外泄 */
section('[G] 密钥：不出现在任何响应与日志里')
const SECRET = 'sk-p10-do-not-leak-4f8c1b'
{
  const DATA_G = freshDir('g')
  const instG = await start({
    port: 8785,
    data: DATA_G,
    env: {
      SCENEGEN_BASE_URL: 'https://example.invalid/v1',
      SCENEGEN_API_KEY: SECRET,
      SCENEGEN_MODEL: 'fake-model',
      DEEPSEEK_API_KEY: 'sk-p10-dialog-do-not-leak-91a2',
    },
  })
  const pid = (await api(instG.base, '/api/plans')).body.plans?.[0]?.planId
  const probes = [
    await api(instG.base, '/api/demo'),
    await api(instG.base, '/api/health'),
    await api(instG.base, '/api/plans'),
    await api(instG.base, `/api/plans/${pid}`),
    await api(instG.base, `/api/scenes/quote?planId=${pid}`),
    await api(instG.base, '/api/catalog?limit=3'),
    await fetch(`${instG.base}/`).then((r) => r.text()),
  ]
  const all = probes.map((p) => (typeof p === 'string' ? p : p.text)).join('\n')
  expect(!all.includes(SECRET), '图像 API Key 不出现在任何接口响应里')
  expect(!all.includes('sk-p10-dialog-do-not-leak-91a2'), '对话 API Key 不出现在任何接口响应里')
  expect(!/authorization|bearer\s+sk-/i.test(all), '响应里没有认证头残留')
  expect(!instG.logs.join('').includes(SECRET), '启动日志里没有密钥')
  await stop(instG)
}

/* ============================================================ H 仓库卫生 */
section('[H] 仓库卫生：密钥不会被打进镜像或提交')
{
  const dockerignore = existsSync(join(REPO, '.dockerignore')) ? readFileSync(join(REPO, '.dockerignore'), 'utf8') : ''
  expect(/^data\/\*\*/m.test(dockerignore), '.dockerignore 排除了 data/ 下的运行文件')
  expect(/^!data\/seed\/\*\*/m.test(dockerignore), '.dockerignore 保留 data/seed 种子素材（镜像里仍可离线跑）')
  const example = existsSync(join(REPO, '.env.example')) ? readFileSync(join(REPO, '.env.example'), 'utf8') : ''
  expect(example.length > 0, '.env.example 存在')
  expect(!/sk-[A-Za-z0-9]{8,}/.test(example), '.env.example 里没有真实密钥')
  expect(/CROSSCART_DATA_DIR/.test(example) && /SCENEGEN_API_KEY/.test(example), '.env.example 覆盖数据目录与图像密钥')
}

await stop(instD)
await stop(instE)
await stop(inst)

console.log(`\n===== check:p10 ${pass}/${pass + fail} =====`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(` - ${f}`)
  process.exit(1)
}
