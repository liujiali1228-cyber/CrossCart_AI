/**
 * 在开发实例上跑一次真实对话建方案（P9-1 验收用例），并生成一张真实穿搭图。
 *
 * 这不是测试脚本，是为了「交付截图用一份干净的方案」：
 * 老方案（pln_020）的聊天记录里还留着上一版格式的旧消息，不适合当成品截图。
 *
 * 用法：node scripts/make-p9-demo-plan.mjs [base] [text]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:8790'
const TEXT =
  process.argv[3] ??
  '我打算去纽约玩一天，请帮我搭配一身。预算300美元，我有白色的鞋子和棕色的包包，其它的你看着搭配。'

const api = async (p, o = {}) => {
  const res = await fetch(`${BASE}${p}`, { headers: { 'content-type': 'application/json' }, ...o })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

const before = new Set(((await api('/api/plans')).body.plans ?? []).map((p) => p.planId))
console.log(`[demo] 现有方案 ${before.size} 个，开始对话…`)
const t0 = Date.now()
const started = await api('/api/chat', { method: 'POST', body: JSON.stringify({ text: TEXT }) })
if (started.status !== 200) {
  console.error('[demo] 发送失败', started.status, JSON.stringify(started.body).slice(0, 200))
  process.exit(1)
}

let planId = null
for (let i = 0; i < 90 && !planId; i += 1) {
  await new Promise((r) => setTimeout(r, 2000))
  const now = ((await api('/api/plans')).body.plans ?? []).map((p) => p.planId)
  planId = now.find((id) => !before.has(id)) ?? null
  if (i % 5 === 0) console.log(`[demo] 等待中 ${Math.round((Date.now() - t0) / 1000)}s`)
}
if (!planId) {
  console.error('[demo] 150s 内没有建出新方案')
  process.exit(1)
}
const created = Math.round((Date.now() - t0) / 1000)
console.log(`[demo] 新方案 ${planId}（${created}s）`)

// 等方案内容稳定（AI 可能还在补场景 / 图片）
let vm = null
for (let i = 0; i < 20; i += 1) {
  vm = (await api(`/api/plans/${planId}`)).body
  if ((vm.slots ?? []).length) break
  await new Promise((r) => setTimeout(r, 1500))
}
const reply = (vm.chat?.messages ?? []).filter((m) => m.role === 'assistant').at(-1)?.text ?? ''
console.log(`[demo] 槽位：${vm.slots.map((s) => `${s.slot}=${s.status}${s.ownedClaim?.label ? `(${s.ownedClaim.label})` : ''}`).join(' ')}`)
console.log(`[demo] 预算：${vm.constraints?.budget?.amount ?? '-'} / 合计 ${vm.cost?.breakdown?.knownTotal ?? '-'}`)
console.log(`[demo] 回复：${reply.replace(/\s+/g, ' ').slice(0, 200)}`)

const gen = await api(`/api/plans/${planId}/scene/regenerate`, {
  method: 'POST',
  body: JSON.stringify({ confirm: true, force: true }),
})
console.log(`[demo] 生成：${gen.status}`)
if (gen.status !== 200) {
  console.error('[demo] 生成失败', JSON.stringify(gen.body).slice(0, 300))
  process.exit(1)
}
const sv = gen.body.view ?? {}
console.log(`[demo] 图：${sv.image} 自检 ${JSON.stringify(sv.ownedCheck?.checks?.map((c) => `${c.slot}:${c.verdict}`) ?? null)}`)
console.log(`PLAN_ID=${planId}`)
