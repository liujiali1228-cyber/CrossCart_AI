/**
 * Phase 5 F1 验收：生效偏好是否真的进了模型上下文。
 *
 * 不起服务、不调模型、不花钱 —— 直接构造 Workspace（隔离数据目录），
 * 断言 planContext() 的输出文本。因为 POST /api/chat 就是把这个字符串
 * 当作第二个 text block 发给模型（chat.mjs:422-423），所以「字符串对」
 * 等价于「模型读得到」。
 *
 *   node scripts/check-prefs-context.mjs
 */
import { mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { Workspace } from '../packages/bridge/src/state.mjs'
import { readLiveCache } from '../packages/bridge/src/live-catalog.mjs'
import { planContext, prefSection } from '../packages/bridge/src/plan-context.mjs'

const TMP = '.tmp/f1ctx'
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
copyFileSync('data/state.json', `${TMP}/state.json`)

const live = readLiveCache('data/live/catalog.json')
const ws = new Workspace({ root: process.cwd(), dataDir: TMP, live })
ws.prefs = [] // 从零开始，不继承真实数据里的历史偏好

const results = []
const ok = (name, extra = '') => {
  results.push(true)
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`)
}
const bad = (name, extra = '') => {
  results.push(false)
  console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
}
const PLAN = 'pln_020'

console.log('\n[1] 没有偏好时：不注入偏好段')
{
  const text = planContext(ws, PLAN)
  text.includes('用户偏好（') ? bad('无偏好却注入了偏好段') : ok('无偏好时上下文干净')
  ;/当前方案：pln_020/.test(text) ? ok('方案快照仍在') : bad('方案快照丢了')
  ;/工具约定：读方案用 crosscart_plan_state/.test(text) && /选品规则：优先选真实店铺商品/.test(text)
    ? ok('既有约定文案逐字保留')
    : bad('既有约定文案被改动')
  ;/<\/crosscart-context>/.test(text) ? ok('标签闭合') : bad('标签未闭合')
}

console.log('\n[2] 一条长期偏好 → 一行，进的是同一次请求')
{
  ws.savePref({ attr: 'palette', value: 'light', scope: 'profile', source: 'user_form' })
  const text = planContext(ws, PLAN)
  ;/用户偏好（用户自己设置或已确认/.test(text) ? ok('出现偏好段标题') : bad('偏好段没出现')
  ;/- 颜色偏好：light（长期）/.test(text) ? ok('格式与作用域正确') : bad('行内容不对', text.split('\n').find((l) => l.includes('light')))
  ;/偏好使用规则：/.test(text) && /不能覆盖预算、到货时间、收货地、类目等硬约束/.test(text)
    ? ok('硬约束优先的规则随偏好一起下发')
    : bad('缺少硬约束规则')
  text.indexOf('场景：') < text.indexOf('- 颜色偏好') && text.indexOf('- 颜色偏好') < text.indexOf('待买：')
    ? ok('插在场景与待买之间（结构位置正确）')
    : bad('插入位置异常')
  text.split('\n').length === planContext(ws, PLAN).split('\n').length ? ok('确定性：两次调用行数一致') : bad('输出不稳定')
}

console.log('\n[3] 本方案偏好覆盖长期，换方案回落到长期')
{
  ws.savePref({ attr: 'palette', value: 'dark', scope: 'task', taskKey: PLAN })
  const here = planContext(ws, PLAN)
  ;/- 颜色偏好：dark（仅本方案；长期为 light）/.test(here) ? ok('本方案上下文显示 dark 并注明长期 light') : bad('task 覆盖未生效')
  const other = planContext(ws, 'pln_040')
  ;/- 颜色偏好：light（长期）/.test(other) ? ok('换到 pln_040 回落到长期 light') : bad('过期 task 偏好仍在生效')
  const none = planContext(ws, '__none__')
  ;/用户偏好（/.test(none) && /- 颜色偏好：light（长期）/.test(none) ? ok('没有方案时也带长期偏好（建方案路径读得到）') : bad('无方案分支丢了长期偏好')
  ;/^- .*（仅本方案/m.test(none) ? bad('没有方案时不该出现 task 偏好', none.split('\n').filter((l) => l.includes('dark')).join(' ')) : ok('没有方案时不注入带方案的临时偏好')
}

console.log('\n[4] 未确认 / 已删除 / 被取代 —— 一条都不许进上下文')
{
  const pending = ws.savePref({
    attr: 'avoid',
    value: 'heels',
    scope: 'profile',
    source: 'ai',
    confidence: 'inferred',
    confirmedByUser: false,
  })
  const text = planContext(ws, PLAN)
  ;/heels/.test(text) ? bad('AI 推断未确认却进了上下文') : ok('未确认偏好被挡住')
  ws.confirmPref(pending.id)
  ;/要避开：heels（长期）/.test(planContext(ws, PLAN)) ? ok('用户确认后才出现') : bad('确认后仍不出现')
  ws.deletePref(pending.id)
  ;/heels/.test(planContext(ws, PLAN)) ? bad('删除后仍在上下文里') : ok('删除后立刻消失')
}

console.log('\n[5] 行数上限：超过 6 项必须截断并如实说明')
{
  ws.prefs = []
  for (const [attr, value] of [
    ['palette', 'light'],
    ['style', 'minimal'],
    ['avoid', 'heels'],
    ['size_top', 'M'],
    ['size_bottom', '28'],
    ['size_shoes', '38'],
    ['brand_prefer', 'COS'],
    ['brand_avoid', 'Shein'],
  ]) {
    ws.savePref({ attr, value, scope: 'profile' })
  }
  const section = prefSection(ws, PLAN)
  const prefLines = section.filter((l) => l.startsWith('- '))
  prefLines.length === 6 ? ok('偏好行恰好 6 行', prefLines.length) : bad('行数不符', String(prefLines.length))
  ;/另有 3 项偏好未在此列出/.test(section.join('\n')) ? ok('省略数量如实标明') : bad('缺少省略说明')
  ;/crosscart_list_prefs/.test(section.join('\n')) ? ok('给出可查证的入口') : bad('没有查证入口')
}

console.log('\n[6] 真实基线数据：pln_020 的方案快照与金额一字未动')
{
  ws.prefs = []
  const text = planContext(ws, PLAN)
  const checks = [
    [/当前方案：pln_020/, '方案号'],
    [/费用：商品小计 \$/, '费用行'],
    [/关税\/进口税未确认，不得称为最终到手价/, '金额诚实声明'],
    [/购买入口：\d+ 件有可核实的商家详情页/, '购买入口'],
    [/到货判断：/, '到货判断'],
  ]
  for (const [re, label] of checks) (re.test(text) ? ok(`${label}仍在`) : bad(`${label}丢失`))
}

rmSync(TMP, { recursive: true, force: true })
const pass = results.filter(Boolean).length
console.log(`\n通过 ${pass} 项，失败 ${results.length - pass} 项`)
process.exit(pass === results.length ? 0 : 1)
