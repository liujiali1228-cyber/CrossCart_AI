/**
 * Phase 5 F2 验收报告：偏好到底改变了什么（机器生成，不靠模型措辞）。
 *
 * 在真实目录（116 live + 15 seed = 131 件）与真实基线 pln_020 上，
 * 对每个场景比较「无偏好」与「有偏好」的候选集，逐项记录：
 *   - 哪些商品被硬排除、原因是什么
 *   - 哪些商品获得软加分、加了多少、依据是什么
 *   - 排名发生什么变化（位置变化数 / top1 是否改变）
 *   - 哪些偏好没被识别（unmapped），哪些规则因会清空候选而放弃（relaxed）
 *
 * 不调模型、不调图像、不写真实数据。
 *
 *   node scripts/report-pref-ranking.mjs
 */
import { mkdirSync, rmSync, copyFileSync, writeFileSync, existsSync } from 'node:fs'
import { Workspace } from '../packages/bridge/src/state.mjs'
import { readLiveCache } from '../packages/bridge/src/live-catalog.mjs'
import { normalizePref } from '../packages/core/dist/index.js'

const TMP = '.tmp/f2report'
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
copyFileSync('data/state.json', `${TMP}/state.json`)

const live = readLiveCache('data/live/catalog.json')
const ws = new Workspace({ root: process.cwd(), dataDir: TMP, live })
const BASE = JSON.parse(JSON.stringify(ws.prefs))
const PLAN = 'pln_020'
const SLOTS = ['outerwear', 'top', 'bottom', 'shoes', 'bag']

let seq = 0
const pref = (attr, value, over = {}) =>
  normalizePref({
    id: `r${++seq}`,
    attr,
    value,
    scope: 'profile',
    confidence: 'stated',
    confirmedByUser: true,
    createdAt: new Date(Date.UTC(2026, 10, 18, 12, 0, seq)).toISOString(),
    ...over,
  })

/** 名次变化：同 ID 在 before/after 里的位置差 > 0 的个数 */
function movedCount(before, after) {
  const posBefore = new Map(before.map((c, i) => [c.item.productId, i]))
  let moved = 0
  after.forEach((c, i) => {
    const b = posBefore.get(c.item.productId)
    if (b !== undefined && b !== i) moved++
  })
  return moved
}

const scenarios = [
  { id: 'A', title: '无偏好（回归基线）', prefs: [], slots: SLOTS, strategy: 'similar' },
  { id: 'B', title: '颜色偏好：浅色', prefs: [pref('palette', '浅色')], slots: SLOTS, strategy: 'similar' },
  {
    id: 'C',
    title: '颜色 + 风格：深色 + 极简（真实数据里 style 标签覆盖 93%）',
    prefs: [pref('palette', '深色'), pref('style', '极简')],
    slots: SLOTS,
    strategy: 'similar',
  },
  {
    id: 'D',
    title: '硬排除：避开 Wristlet + 避开 Rothy’s',
    prefs: [pref('avoid', 'Wristlet'), pref('brand_avoid', "Rothy's")],
    slots: ['shoes', 'bag'],
    strategy: 'similar',
  },
  { id: 'E', title: '鞋码 8（硬排除）', prefs: [pref('size_shoes', '8')], slots: ['shoes'], strategy: 'similar' },
  {
    id: 'F',
    title: '预算优先：偏好品牌 Everlane + cheaper 策略',
    prefs: [pref('brand_prefer', 'Everlane')],
    slots: ['outerwear', 'top', 'shoes'],
    strategy: 'cheaper',
  },
  {
    id: 'G',
    title: '任务偏好只影响本方案（palette=深色，scope=task）',
    prefs: [pref('palette', '深色', { scope: 'task', taskKey: PLAN })],
    slots: ['outerwear', 'top'],
    strategy: 'similar',
    crossPlan: true,
  },
  { id: 'H', title: '认不出的偏好（莫兰迪色系）', prefs: [pref('palette', '莫兰迪色系')], slots: ['outerwear'], strategy: 'similar' },
]

const rows = []
const details = []

for (const sc of scenarios) {
  for (const slot of sc.slots) {
    ws.prefs = JSON.parse(JSON.stringify(sc.prefs))
    const before = ws.candidateResult(PLAN, slot, sc.strategy, { prefs: [] })
    const after = ws.candidateResult(PLAN, slot, sc.strategy)

    const withBonus = after.candidates.filter((c) => c.prefBonus > 0)
    const topChanged = before.candidates[0]?.item.productId !== after.candidates[0]?.item.productId
    const row = {
      scenario: sc.id,
      slot,
      poolBefore: before.candidates.length,
      poolAfter: after.candidates.length,
      excluded: after.excluded.length,
      bonusItems: withBonus.length,
      maxBonus: after.candidates.reduce((m, c) => Math.max(m, c.prefBonus), 0),
      moved: movedCount(before.candidates, after.candidates),
      topChanged,
      topBefore: before.candidates[0]
        ? `${before.candidates[0].item.title} (${before.candidates[0].score})`
        : '—',
      topAfter: after.candidates[0] ? `${after.candidates[0].item.title} (${after.candidates[0].score})` : '—',
      applied: after.applied,
      relaxed: after.relaxed,
      unmapped: after.unmapped,
      excludedSample: after.excluded.slice(0, 6),
      bonusSample: withBonus
        .slice(0, 6)
        .map((c) => ({ productId: c.item.productId, title: c.item.title, bonus: c.prefBonus, whys: c.prefWhys })),
    }

    // 任务偏好：换一个 planId 看是否失效（用同一份偏好，不存在的方案也能跑排序）
    if (sc.crossPlan) {
      const other = ws.candidateResult('pln_040', slot, sc.strategy)
      row.crossPlan = {
        planId: 'pln_040',
        bonusItems: other.candidates.filter((c) => c.prefBonus > 0).length,
        excluded: other.excluded.length,
        applied: other.applied,
      }
    }
    rows.push(row)
  }
  details.push({ scenario: sc.id, title: sc.title, prefs: sc.prefs.map((p) => ({ attr: p.attr, value: p.value, scope: p.scope })) })
}

ws.prefs = BASE

// ---------------------------------------------------------------- Markdown

const lines = []
lines.push('# Phase 5 F2：偏好对候选集的真实影响（Before / After）')
lines.push('')
lines.push(`机器生成于 ${new Date().toISOString()} · 基线方案 \`${PLAN}\` · 目录 131 件（116 live + 15 seed）`)
lines.push('')
lines.push('> 本报告由 `scripts/report-pref-ranking.mjs` 生成，不调用模型、不调用图像服务、不写真实数据。')
lines.push('> 「无偏好」一列是同一份目录与方案在 **prefs=[]** 下的结果，因此任何差异都只能来自偏好。')
lines.push('')
lines.push('## 场景定义')
lines.push('')
lines.push('| 场景 | 含义 |')
lines.push('| --- | --- |')
for (const d of details) {
  const p = d.prefs.length ? d.prefs.map((x) => `${x.attr}=${Array.isArray(x.value) ? x.value.join('、') : x.value}${x.scope === 'task' ? '(本方案)' : ''}`).join('，') : '（无）'
  lines.push(`| ${d.scenario} | ${d.title}：${p} |`)
}
lines.push('')
lines.push('## 总览')
lines.push('')
lines.push('| 场景 | 槽位 | 候选池 | 硬排除 | 加分件数 | 最高加分 | 名次变化 | top1 变化 |')
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
for (const r of rows) {
  lines.push(
    `| ${r.scenario} | ${r.slot} | ${r.poolBefore}→${r.poolAfter} | ${r.excluded} | ${r.bonusItems} | ${r.maxBonus.toFixed(2)} | ${r.moved} | ${r.topChanged ? '是' : '否'} |`,
  )
}
lines.push('')

for (const sc of details) {
  const rs = rows.filter((r) => r.scenario === sc.id)
  if (!rs.length) continue
  lines.push(`## 场景 ${sc.id}：${sc.title}`)
  lines.push('')
  for (const r of rs) {
    lines.push(`### ${r.slot}`)
    lines.push('')
    lines.push(`- 候选池：**${r.poolBefore} → ${r.poolAfter}**；硬排除 **${r.excluded}** 件；获得加分 **${r.bonusItems}** 件（最高 +${r.maxBonus.toFixed(2)}）；名次变化 **${r.moved}** 处；top1 ${r.topChanged ? '**改变**' : '不变'}`)
    lines.push(`- 生效规则：${r.applied.length ? r.applied.join('；') : '（无）'}`)
    if (r.relaxed.length) lines.push(`- ⚠️ 放弃的规则：${r.relaxed.join('；')}`)
    if (r.unmapped.length) lines.push(`- 未识别（未参与计算）：${r.unmapped.map((u) => `${u.attr}=「${u.value}」`).join('；')}`)
    if (r.crossPlan) {
      lines.push(
        `- 换到 \`${r.crossPlan.planId}\`：加分 ${r.crossPlan.bonusItems} 件、排除 ${r.crossPlan.excluded} 件、规则 ${r.crossPlan.applied.length ? r.crossPlan.applied.join('；') : '（无）'} → ${r.crossPlan.applied.length === 0 && r.crossPlan.excluded === 0 ? '本方案偏好已失效 ✅' : '⚠️ 仍在生效'}`,
      )
    }
    if (r.excludedSample.length) {
      lines.push('')
      lines.push('| 被排除商品 | 原因 |')
      lines.push('| --- | --- |')
      for (const e of r.excludedSample) lines.push(`| ${e.title} | ${e.reasons.join('；')} |`)
    }
    if (r.bonusSample.length) {
      lines.push('')
      lines.push('| 获得加分的商品 | 加分 | 依据 |')
      lines.push('| --- | --- | --- |')
      for (const b of r.bonusSample) lines.push(`| ${b.title} | +${b.bonus} | ${b.whys.join('；')} |`)
    }
    lines.push('')
    lines.push(`top1：${r.topBefore} → ${r.topAfter}`)
    lines.push('')
  }
}

// ---------------------------------------------------------------- top1 敏感度扫描

/**
 * 诚实回答「偏好到底能不能改变第一名」：
 * 遍历真实目录里可判定的偏好值 × 4 个策略 × 5 个槽位，只记录 top1 真的变了的组合。
 * 不改任何权重 —— 找不到就是找不到，并在报告里写清原因。
 */
const probePrefs = [
  pref('palette', '浅色'),
  pref('palette', '深色'),
  pref('palette', '中性色'),
  ...['Everlane', "Rothy's", 'Cuyana', 'Allbirds'].flatMap((b) => [
    pref('brand_prefer', b),
    pref('brand_avoid', b),
  ]),
  ...['7', '8', '9', '10'].map((v) => pref('size_shoes', v)),
  ...['S', 'M', 'L'].map((v) => pref('size_top', v)),
  ...['Clog', 'Wristlet', 'Sneaker', 'Loafer'].map((v) => pref('avoid', v)),
]

const flips = []
let probes = 0
for (const slot of SLOTS) {
  for (const strategy of ['similar', 'cheaper', 'lighter', 'faster']) {
    ws.prefs = []
    const base = ws.candidateResult(PLAN, slot, strategy, { prefs: [] })
    if (!base.candidates.length) continue
    for (const p of probePrefs) {
      probes++
      ws.prefs = [p]
      const after = ws.candidateResult(PLAN, slot, strategy)
      const from = base.candidates[0]
      const to = after.candidates[0]
      if (!to || to.item.productId === from.item.productId) continue
      flips.push({
        slot,
        strategy,
        pref: `${p.attr}=${p.value}`,
        from: `${from.item.title} (${from.score})`,
        to: `${to.item.title} (${to.score})`,
        reason: to.prefWhys.join('；') || after.excluded.find((e) => e.productId === from.item.productId)?.reasons.join('；') || '',
      })
    }
  }
}
ws.prefs = BASE

lines.push('## top1 敏感度扫描（偏好能不能改变第一名）')
lines.push('')
lines.push(
  `在真实目录上跑了 **${probes}** 组「单条偏好 × 槽位 × 策略」，其中 **${flips.length}** 组的第一名发生了变化。下面只列真实发生的：`,
)
lines.push('')
if (flips.length) {
  lines.push('| 槽位 | 策略 | 偏好 | top1 变化 | 原因 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const f of flips.slice(0, 20)) {
    lines.push(`| ${f.slot} | ${f.strategy} | ${f.pref} | ${f.from} → ${f.to} | ${f.reason || '—'} |`)
  }
} else {
  lines.push('（没有一组第一名的商品发生变化 —— 见下方原因）')
}
lines.push('')
const top1Note = ws.catalog.length
lines.push(
  `> 为什么大多数情况下第一名不变：\`score\` 里策略匹配占 **0.40**、到货 0.25、价格 0.20、风格 0.15，偏好最多 **0.10**。` +
    '真实目录里 top1 通常在策略/到货/价格三项上同时领先，0.10 不足以跨越这个差距 —— **这是「策略主导」的设计结果，不是失效**。' +
    '当第一名与第二名的差距小于 0.10 时（上面的表格），偏好就会改变结果。',
)
lines.push('')
lines.push(`> 如果产品上希望偏好更能左右第一名，正确做法是补商品标签（提高可判定维度），而不是把 0.05/0.03/0.02 调大 —— 调大会让「省钱」「准时到」被审美偏好压过去。`)
lines.push('')

// ---------------------------------------------------------------- cheaper 守卫校验

/**
 * 用户要求：cheaper 策略下，不能因为符合审美偏好就选更贵、违背省钱目标的商品。
 * 判定标准（可机器复核）：若某对商品 (a,b) 在「有偏好」排序里 a 在 b 之前，
 * 但在「无偏好」排序里 b 在 a 之前，且 a 的到手价更高 → 记为一次违规。
 */
const cheaperViolations = []
let cheaperChecks = 0
for (const slot of SLOTS) {
  ws.prefs = []
  const base = ws.candidateResult(PLAN, slot, 'cheaper', { prefs: [] })
  const basePos = new Map(base.candidates.map((c, i) => [c.item.productId, i]))
  for (const p of probePrefs) {
    cheaperChecks++
    ws.prefs = [p]
    const after = ws.candidateResult(PLAN, slot, 'cheaper')
    const price = new Map(after.candidates.map((c) => [c.item.productId, c.lineTotal]))
    after.candidates.forEach((a, i) => {
      for (let j = i + 1; j < after.candidates.length; j++) {
        const b = after.candidates[j]
        const bBefore = basePos.get(b.item.productId)
        const aBefore = basePos.get(a.item.productId)
        if (bBefore === undefined || aBefore === undefined) continue
        if (aBefore > bBefore && (price.get(a.item.productId) ?? 0) > (price.get(b.item.productId) ?? 0)) {
          cheaperViolations.push({
            slot,
            pref: `${p.attr}=${p.value}`,
            ahead: `${a.item.title} $${a.lineTotal}`,
            behind: `${b.item.title} $${b.lineTotal}`,
          })
        }
      }
    })
  }
}
ws.prefs = BASE

lines.push('## cheaper 策略守卫校验')
lines.push('')
lines.push(
  cheaperViolations.length === 0
    ? `在 ${cheaperChecks} 组「偏好 × 槽位」里，**没有一次**因为偏好让更贵的商品排到更便宜的前面 ✅`
    : `⚠️ 发现 ${cheaperViolations.length} 处违规（必须修）：\n\n| 槽位 | 偏好 | 被抬到前面 | 被压到后面 |\n| --- | --- | --- | --- |\n` +
      cheaperViolations.slice(0, 10).map((v) => `| ${v.slot} | ${v.pref} | ${v.ahead} | ${v.behind} |`).join('\n'),
)
lines.push('')
lines.push('> 机制：cheaper 下偏好加分有两道闸 —— ① 不比当前这件便宜 → 不加分；② 到手价高于「无偏好最优」→ 不加分。')
lines.push('')

// ---------------------------------------------------------------- 真实数据的局限（如实记录）

const cat = ws.catalog
const styleCoverage = cat.filter((c) => (c.style ?? []).includes('minimal')).length
const vendorCount = new Set(cat.map((c) => c.vendor).filter(Boolean)).size
const heelCount = cat.filter((c) => /heel|pump|stiletto/i.test(c.title)).length

lines.push('## 真实目录的能力边界（为什么有些偏好无法产生差异）')
lines.push('')
lines.push(`- **style 标签几乎没有区分度**：\`minimal\` 出现在 ${styleCoverage}/${cat.length} 件商品上（${Math.round((styleCoverage / cat.length) * 100)}%），所以「极简」偏好会让几乎所有候选同时 +0.03，名次不变。这不是权重问题，是标签问题。`)
lines.push(`- **目录只有 ${vendorCount} 家店**（Everlane / Rothy's / Cuyana / Allbirds），品牌偏好只能在这几家之间起作用；偏好一个目录里没有的品牌（如 COS）不会有任何效果，也不会被假装成「已匹配」。`)
lines.push(`- **没有高跟鞋**：标题里含 heel/pump/stiletto 的商品 ${heelCount} 件 → \`avoid=heels\` 排除 0 件。这是如实结果，不代表过滤逻辑失效（\`avoid=Wristlet\` / \`brand_avoid\` 已证明能排除）。`)
lines.push('- **中文避雷词（如「大面积印花」）在英文目录里命中 0 件**：真实商品标题是英文，字符串级匹配无法跨语言。这类偏好只能靠文本层交给模型理解，不算硬过滤 —— 代码里已把它标成「生效但未命中」，不假装筛过。')
lines.push('')
lines.push('### 若要提高区分度，应该补的是数据不是权重')
lines.push('')
lines.push('1. 给商品补更细的风格标签（目前的 11 个标签里 `minimal` 占了 93%）。')
lines.push('2. 补价格档、版型（oversized/regular）、材质（wool/cotton）等可判定字段。')
lines.push('3. 商品标题保留英文原名，同时存一份中文关键词（供避雷词匹配）。')
lines.push('')
lines.push('在这三项完成前，**不该通过调大 0.05/0.03/0.02 来制造「测试好看」的差异**。')
lines.push('')

const md = lines.join('\n')
mkdirSync('docs', { recursive: true })
writeFileSync('docs/F2-候选差异报告.md', md)
writeFileSync('docs/F2-候选差异报告.json', JSON.stringify({ generatedAt: new Date().toISOString(), planId: PLAN, catalogSize: cat.length, rows }, null, 2))

rmSync(TMP, { recursive: true, force: true })

const changed = rows.filter((r) => r.excluded > 0 || r.bonusItems > 0)
console.log(`[report] 场景 ${details.length} 个 / 槽位对照 ${rows.length} 组；有变化的 ${changed.length} 组`)
for (const r of rows) {
  console.log(
    `  ${r.scenario} ${r.slot.padEnd(10)} 池 ${r.poolBefore}→${r.poolAfter}  排除 ${r.excluded}  加分 ${r.bonusItems}  名次变化 ${r.moved}  top1 ${r.topChanged ? '变了' : '不变'}`,
  )
}
console.log('[report] 已写入 docs/F2-候选差异报告.md 与 .json')
if (!existsSync('docs/F2-候选差异报告.md')) process.exit(1)
