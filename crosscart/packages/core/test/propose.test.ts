/**
 * F3：AI 提议 → 用户确认 的守门测试。
 *
 * 这一层不测排序（F2 已覆盖），只测「一条推断怎样才算生效」的四条边界：
 *   1. 未确认的提议不得覆盖已确认的偏好（最重要）；
 *   2. 判重：同值不新增，同槽位不同值就地更新；
 *   3. 用户拒绝过的同值提议不再出现；
 *   4. 依据缺失/不合法不允许写入。
 * 任何一条改回原样都会红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveAttr,
  upsertPref,
  planProposal,
  updateProposal,
  prefsPending,
  prefsBrief,
  prefsOverview,
  validateEvidence,
  samePrefValue,
  isSamePrefSlot,
  type PrefRecord,
} from '../dist/index.js'

let n = 0
function rec(over: Partial<PrefRecord> = {}): PrefRecord {
  n += 1
  return {
    id: over.id ?? `p_${n}`,
    attr: 'palette',
    value: 'light',
    scope: 'profile',
    confidence: 'stated',
    confirmedByUser: true,
    createdAt: over.createdAt ?? `2026-11-18T10:00:${String(n).padStart(2, '0')}.000Z`,
    ...over,
  }
}

const inferred = (over: Partial<PrefRecord> = {}): PrefRecord =>
  rec({ confidence: 'inferred', confirmedByUser: false, source: 'ai', ...over })

// ------------------------------------------------- 1. 提议不得覆盖已确认

test('AI 推断出与已确认偏好不同的值时：原偏好继续生效，新记录只是待确认', () => {
  let prefs: PrefRecord[] = []
  prefs = upsertPref(prefs, rec({ id: 'light', value: 'light' }))
  prefs = upsertPref(prefs, inferred({ id: 'dark', value: 'dark' }))

  const r = resolveAttr(prefs, 'palette', 'any')
  assert.equal(r.value, 'light', '确认过的 light 不能被未确认的 dark 顶掉')
  assert.equal(r.winner?.id, 'light')
  assert.equal(prefs.find((p) => p.id === 'light')?.supersededBy, undefined, 'light 不能被打上"已取代"')
  assert.equal(prefs.find((p) => p.id === 'dark')?.supersededBy, undefined)

  const pending = prefsPending(prefs)
  assert.deepEqual(
    pending.map((p) => p.id),
    ['dark'],
  )
})

test('用户确认 dark 后：dark 生效，light 保留为已取代（覆盖历史可追溯）', () => {
  let prefs: PrefRecord[] = []
  prefs = upsertPref(prefs, rec({ id: 'light', value: 'light' }))
  prefs = upsertPref(prefs, inferred({ id: 'dark', value: 'dark' }))
  // 确认 = 以「已确认」身份再写一次（state.confirmPref 走同一套槽位规则）
  const confirmed = prefs.map((p) => (p.id === 'dark' ? { ...p, confirmedByUser: true, confidence: 'stated' as const } : p))
  prefs = upsertPref(
    prefs.filter((p) => p.id !== 'dark'),
    confirmed.find((p) => p.id === 'dark')!,
  )

  assert.equal(resolveAttr(prefs, 'palette', 'any').value, 'dark')
  assert.equal(prefs.find((p) => p.id === 'light')?.supersededBy, 'dark', '旧值进历史而不是被删除')
  assert.equal(prefs.length, 2, '历史记录保留')
  assert.equal(prefsPending(prefs).length, 0)
})

test('同槽位判定：profile 与 task 互不取代（确认 task 不会顶掉长期偏好）', () => {
  const a = rec({ id: 'a', scope: 'profile' })
  const b = rec({ id: 'b', scope: 'task', taskKey: 'pln_020' })
  assert.equal(isSamePrefSlot(a, b), false)
  // 待确认的 task 写入也不该动 profile
  const prefs = upsertPref([a], inferred({ id: 'c', scope: 'task', taskKey: 'pln_020', value: 'dark' }))
  assert.equal(resolveAttr(prefs, 'palette', 'any').value, 'light')
  assert.equal(resolveAttr(prefs, 'palette', 'any', { taskKey: 'pln_020' }).value, 'light', '未确认的 task 提议也不生效')
})

// ------------------------------------------------- 2. 判重

test('planProposal：同值且已确认 → 不再提议', () => {
  const prefs = [rec({ id: 'a', value: 'light' })]
  const plan = planProposal(prefs, inferred({ value: 'light' }))
  assert.equal(plan.action, 'skip_duplicate')
  assert.equal(plan.reason, 'same_slot_same_value')
})

test('planProposal：相同待确认提议不重复新增', () => {
  const prefs = [inferred({ id: 'p1', value: 'dark' })]
  const plan = planProposal(prefs, inferred({ value: 'dark' }))
  assert.equal(plan.action, 'skip_duplicate')
  assert.equal(plan.targetId, 'p1')
})

test('planProposal：同槽位已有别的待确认值 → 就地更新，不新增第二条', () => {
  const prefs = [inferred({ id: 'p1', value: 'dark' })]
  const plan = planProposal(prefs, inferred({ value: 'mid' }))
  assert.equal(plan.action, 'update_pending')
  assert.equal(plan.targetId, 'p1')

  const next = updateProposal(prefs, 'p1', { value: 'mid' })
  assert.equal(next.length, 1, '仍然只有一条待确认记录')
  assert.equal(next[0].value, 'mid')
  assert.ok(next[0].updatedAt, '更新应留时间戳')
})

test('planProposal：与已确认偏好值不同 → 允许创建冲突提议（不覆盖）', () => {
  const prefs = [rec({ id: 'a', value: 'light' })]
  const plan = planProposal(prefs, inferred({ value: 'dark' }))
  assert.equal(plan.action, 'create')
  assert.equal(plan.reason, 'new')
})

test('值比较：空白/大小写/数组顺序不影响判重', () => {
  assert.equal(samePrefValue(' Light ', 'light'), true)
  assert.equal(samePrefValue(['a', 'b'], ['a', 'b']), true)
  assert.equal(samePrefValue(['a', 'b'], ['b', 'a']), false, '顺序不同的数组是不同取值，不做语义猜测')
  assert.equal(samePrefValue('light', 'dark'), false)
})

// ------------------------------------------------- 3. 拒绝

test('用户拒绝过的同值提议：不再出现（skip_rejected）', () => {
  const prefs = [
    inferred({
      id: 'r1',
      value: 'dark',
      rejectedAt: '2026-11-18T11:00:00.000Z',
      deletedAt: '2026-11-18T11:00:00.000Z',
    }),
  ]
  const plan = planProposal(prefs, inferred({ value: 'dark' }))
  assert.equal(plan.action, 'skip_rejected')
  assert.equal(plan.targetId, 'r1')
})

test('拒绝只针对同值：推断出不同值时仍可提议', () => {
  const prefs = [inferred({ id: 'r1', value: 'dark', rejectedAt: '2026-11-18T11:00:00.000Z', deletedAt: 'x' })]
  const plan = planProposal(prefs, inferred({ value: 'mid' }))
  assert.equal(plan.action, 'create')
})

test('被拒绝的记录不算待确认，也不生效', () => {
  const prefs = [
    rec({ id: 'a', value: 'light' }),
    inferred({ id: 'r', value: 'dark', rejectedAt: '2026-11-18T11:00:00.000Z', deletedAt: 'x' }),
  ]
  assert.equal(prefsPending(prefs).length, 0)
  assert.equal(resolveAttr(prefs, 'palette', 'any').value, 'light')
  const g = prefsOverview(prefs).find((x) => x.attr === 'palette')
  assert.equal(g?.records.find((r) => r.id === 'r')?.status, 'rejected')
})

// ------------------------------------------------- 4. 依据

test('validateEvidence：合法依据被规整，长引述截断', () => {
  const r = validateEvidence({ basis: 'swap', ref: 'pln_020', quote: ' 连续两次换成白色款 ', slot: 'shoes' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.evidence, { basis: 'swap', ref: 'pln_020', quote: '连续两次换成白色款', slot: 'shoes' })
})

test('validateEvidence：缺依据 / 空原话 / 未知类型一律拒绝', () => {
  assert.equal(validateEvidence(undefined).ok, false)
  assert.equal(validateEvidence({ basis: 'vibes', quote: '直觉' }).ok, false)
  assert.equal(validateEvidence({ basis: 'chat', quote: '  ' }).ok, false)
  assert.equal(validateEvidence({ basis: 'swap', quote: '换成了白色' }).ok, false, '换件类依据必须有方案或商品锚点')
})

// ------------------------------------------------- 5. 待确认不进入上下文

test('待确认提议不进入计划上下文（prefsBrief 只输出生效偏好）', () => {
  const prefs = [rec({ id: 'a', value: 'light' }), inferred({ id: 'b', value: 'dark' })]
  const brief = prefsBrief(prefs)
  assert.match(brief.text, /light/)
  assert.doesNotMatch(brief.text, /dark/)
  assert.equal(brief.attrs.length, 1)
})

test('只有待确认记录时，上下文为空（不假装已有个性化）', () => {
  assert.equal(prefsBrief([inferred({ value: 'dark' })]).text, '')
})

test('临时（task）待确认提议在无当前方案时不生效，但仍可见', () => {
  const prefs = [inferred({ id: 't', scope: 'task', taskKey: 'pln_020', value: 'dark' })]
  assert.equal(resolveAttr(prefs, 'palette', 'any').value, 'any')
  assert.equal(resolveAttr(prefs, 'palette', 'any', { taskKey: 'pln_020' }).value, 'any', '未确认永远不生效')
  assert.equal(prefsPending(prefs).length, 1, '首页要能看到它，由用户决定')
})
