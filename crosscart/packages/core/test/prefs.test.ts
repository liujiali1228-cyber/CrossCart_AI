/**
 * 偏好纯函数的守门测试（Phase 5 F0）。
 *
 * 只测「数据怎么裁决」，不测排序是否受偏好影响（那是 F2 的事）。
 * 每条用例都对应 Phase 5A 审查里发现的一个真实缺陷，改回去就会红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveAttr,
  resolveAll,
  upsertPref,
  normalizeAttr,
  normalizePref,
  isCanonicalAttr,
  isPrefActive,
  prefsOverview,
  prefsBrief,
  type PrefRecord,
} from '../dist/index.js'

let n = 0
function rec(over: Partial<PrefRecord> = {}): PrefRecord {
  n += 1
  return {
    id: over.id ?? `t_${n}`,
    attr: 'palette',
    value: 'light',
    scope: 'profile',
    confidence: 'stated',
    confirmedByUser: true,
    createdAt: over.createdAt ?? `2026-11-18T10:00:${String(n).padStart(2, '0')}.000Z`,
    ...over,
  }
}

// ------------------------------------------------- A7-① 同属性二次写入必须生效

test('upsertPref：同 attr + 同 scope 覆盖，生效的是最新那条（不是第一条）', () => {
  let prefs: PrefRecord[] = []
  prefs = upsertPref(prefs, rec({ id: 'p1', value: 'light', createdAt: '2026-11-18T10:00:00.000Z' }))
  prefs = upsertPref(prefs, rec({ id: 'p2', value: 'dark', createdAt: '2026-11-18T10:01:00.000Z' }))

  const r = resolveAttr(prefs, 'palette', 'any')
  assert.equal(r.value, 'dark', '用户改成 dark 后必须生效 dark')
  assert.equal(r.winner?.id, 'p2')
  assert.equal(prefs.length, 2, '旧记录保留（历史不删除）')
  assert.equal(prefs[0].supersededBy, 'p2', '旧记录被标为已被取代')
})

test('upsertPref：写三次 走 light→dark→light，只有最后一条生效且链完整', () => {
  let prefs: PrefRecord[] = []
  prefs = upsertPref(prefs, rec({ id: 'a', value: 'light', createdAt: '2026-11-18T10:00:00.000Z' }))
  prefs = upsertPref(prefs, rec({ id: 'b', value: 'dark', createdAt: '2026-11-18T10:01:00.000Z' }))
  prefs = upsertPref(prefs, rec({ id: 'c', value: 'light', createdAt: '2026-11-18T10:02:00.000Z' }))

  assert.equal(resolveAttr(prefs, 'palette', 'any').value, 'light')
  assert.equal(resolveAttr(prefs, 'palette', 'any').winner?.id, 'c')
  assert.deepEqual(
    prefs.map((p) => [p.id, p.supersededBy ?? null]),
    [
      ['a', 'b'],
      ['b', 'c'],
      ['c', null],
    ],
  )
})

test('upsertPref：profile 与 task 是两个槽位，不会互相取代', () => {
  let prefs: PrefRecord[] = []
  prefs = upsertPref(prefs, rec({ id: 'prof', scope: 'profile', value: 'light' }))
  prefs = upsertPref(prefs, rec({ id: 'task', scope: 'task', taskKey: 'pln_020', value: 'dark' }))
  assert.equal(prefs.filter((p) => !p.supersededBy).length, 2, '两条都应存活')
  assert.equal(resolveAttr(prefs, 'palette', 'any', { taskKey: 'pln_020' }).value, 'dark')
  assert.equal(resolveAttr(prefs, 'palette', 'any').value, 'light')
})

test('upsertPref：不同 taskKey 的两次「本次」也各占一个槽位', () => {
  let prefs: PrefRecord[] = []
  prefs = upsertPref(prefs, rec({ id: 'k1', scope: 'task', taskKey: 'pln_020', value: 'dark' }))
  prefs = upsertPref(prefs, rec({ id: 'k2', scope: 'task', taskKey: 'pln_040', value: 'mid' }))
  assert.equal(prefs.filter((p) => p.supersededBy).length, 0)
  assert.equal(resolveAttr(prefs, 'palette', 'any', { taskKey: 'pln_020' }).value, 'dark')
  assert.equal(resolveAttr(prefs, 'palette', 'any', { taskKey: 'pln_040' }).value, 'mid')
})

// ------------------------------------------------- A7-② task 作用域不能永不过期

test('带 taskKey 的 task 记录：上下文不匹配时失效，回落到长期偏好', () => {
  const prefs = [
    rec({ id: 'prof', scope: 'profile', value: 'light' }),
    rec({ id: 'trip', scope: 'task', taskKey: 'pln_020', value: 'dark' }),
  ]
  assert.equal(resolveAttr(prefs, 'palette', 'any', { taskKey: 'pln_020' }).value, 'dark', '本方案内 task 压过 profile')
  assert.equal(resolveAttr(prefs, 'palette', 'any', { taskKey: 'pln_040' }).value, 'light', '换个方案，上次的「本次」不再生效')
  assert.equal(resolveAttr(prefs, 'palette', 'any').value, 'light', '没给上下文时不生效（宁可不用，也不让它永久生效）')
})

test('旧的无 taskKey 的 task 记录保持原语义（无条件压过 profile）', () => {
  const prefs = [
    rec({ id: 'prof', scope: 'profile', value: 'light' }),
    rec({ id: 'legacy', scope: 'task', value: 'dark' }),
  ]
  const r = resolveAttr(prefs, 'palette', 'any', { taskKey: 'pln_999' })
  assert.equal(r.value, 'dark')
  assert.equal(r.overridden.length, 1)
  assert.equal(r.overridden[0].value, 'light', '被覆盖的长期偏好必须可查证')
})

// ------------------------------------------------- 删除 / 未确认 / 已取代

test('软删的记录不参与解析（用户的删除不能「复活」）', () => {
  const prefs = [
    rec({ id: 'p', value: 'light', deletedAt: '2026-11-18T11:00:00.000Z' }),
    rec({ id: 'q', value: 'dark', createdAt: '2026-11-18T09:00:00.000Z' }),
  ]
  assert.equal(resolveAttr(prefs, 'palette', 'any').value, 'dark', '被删的 newer 记录不能让旧值重新生效')
  assert.equal(isPrefActive(prefs[0]), false)
})

test('未确认（inferred / confirmedByUser:false）不参与解析，且软删优先判定', () => {
  const prefs = [
    rec({ id: 'guess', value: 'dark', confidence: 'inferred', confirmedByUser: false }),
    rec({ id: 'prof', value: 'light' }),
  ]
  const r = resolveAttr(prefs, 'palette', 'any')
  assert.equal(r.value, 'light')
  assert.equal(r.winner?.id, 'prof')
})

test('已取代的记录不参与解析，即使它有更新的 createdAt', () => {
  const prefs = [
    rec({ id: 'old', value: 'dark', createdAt: '2026-11-18T12:00:00.000Z', supersededBy: 'newer' }),
    rec({ id: 'newer', value: 'light', createdAt: '2026-11-18T11:00:00.000Z' }),
  ]
  assert.equal(resolveAttr(prefs, 'palette', 'any').value, 'light')
})

// ------------------------------------------------- 词表归一（三套词表收敛）

test('normalizeAttr：别名一律收敛到 canonical，大小写与空格容错', () => {
  assert.equal(normalizeAttr('color_family'), 'palette')
  assert.equal(normalizeAttr('color.like'), 'palette')
  assert.equal(normalizeAttr('  COLOR  '), 'palette')
  assert.equal(normalizeAttr('budget'), 'budget_habit')
  assert.equal(normalizeAttr('brand'), 'brand_prefer')
  assert.equal(normalizeAttr('size_shoes'), 'size_shoes')
  assert.equal(normalizeAttr('避开豹纹'), '避开豹纹', '认不出的自定义键原样保留，不静默丢弃')
})

test('normalizePref：统一 attr，同时保留 attrRaw 供追溯', () => {
  const out = normalizePref(rec({ attr: 'color_family' }))
  assert.equal(out.attr, 'palette')
  assert.equal(out.attrRaw, 'color_family')
  const same = normalizePref(rec({ attr: 'palette' }))
  assert.equal(same.attrRaw, undefined, '本来就是 canonical 时不留多余字段')
})

test('isCanonicalAttr：认识 9 个 canonical，自定义键为 false', () => {
  for (const attr of ['palette', 'style', 'avoid', 'size_top', 'size_bottom', 'size_shoes', 'brand_prefer', 'brand_avoid', 'budget_habit']) {
    assert.equal(isCanonicalAttr(attr), true, `${attr} 应该是 canonical`)
  }
  assert.equal(isCanonicalAttr('color_family'), true, '别名归一后也算 canonical')
  assert.equal(isCanonicalAttr('mood'), false)
})

test('resolveAll：批量解析把 overridden 汇成证据列表，且忽略已删/已取代', () => {
  const prefs = [
    rec({ id: 'p1', attr: 'palette', scope: 'profile', value: 'light' }),
    rec({ id: 't1', attr: 'palette', scope: 'task', taskKey: 'pln_020', value: 'dark' }),
    rec({ id: 'p2', attr: 'avoid', scope: 'profile', value: 'heels', deletedAt: '2026-11-18T11:00:00.000Z' }),
  ]
  const out = resolveAll(prefs, { palette: 'any', avoid: null }, { taskKey: 'pln_020' })
  assert.equal(out.values.palette, 'dark')
  assert.equal(out.values.avoid, null, '已删除的 avoid 不生效')
  assert.deepEqual(out.overridden.map((r) => r.id), ['p1'])
})

// ------------------------------------------------- 只读投影（给 UI / 工具）

test('prefsOverview：按属性分组并标注 active / superseded / deleted / unconfirmed / inactive', () => {
  const prefs = [
    rec({ id: 'a', scope: 'profile', value: 'light', createdAt: '2026-11-18T10:00:00.000Z' }),
    rec({ id: 'b', scope: 'profile', value: 'dark', createdAt: '2026-11-18T10:01:00.000Z', supersededBy: 'c' }),
    rec({ id: 'c', scope: 'profile', value: 'mid', createdAt: '2026-11-18T10:02:00.000Z' }),
    rec({ id: 'd', scope: 'task', taskKey: 'pln_020', value: 'dark', createdAt: '2026-11-18T10:03:00.000Z' }),
    rec({ id: 'e', attr: 'avoid', scope: 'profile', value: 'heels', deletedAt: '2026-11-18T11:00:00.000Z' }),
    rec({ id: 'f', attr: 'style', scope: 'profile', value: 'minimal', confirmedByUser: false }),
  ]
  const groups = prefsOverview(prefs, { taskKey: 'pln_040' })
  const palette = groups.find((g) => g.attr === 'palette')
  assert.ok(palette)
  assert.equal(palette.winner?.id, 'c', '生效的是最新未取代的那条')
  const status = Object.fromEntries(palette.records.map((r) => [r.id, r.status]))
  assert.equal(status.a, 'overridden')
  assert.equal(status.b, 'superseded')
  assert.equal(status.c, 'active')
  assert.equal(status.d, 'inactive', '不属于当前方案的 task 记录标为已失效')
  assert.equal(groups.find((g) => g.attr === 'avoid')?.records[0].status, 'deleted')
  assert.equal(groups.find((g) => g.attr === 'style')?.records[0].status, 'unconfirmed')
})

// ------------------------------------------------- F1：生效偏好 → 上下文（≤6 行）

test('prefsBrief：没有任何生效偏好时返回空文本，不编造"无偏好"这一事实', () => {
  const b = prefsBrief([], {})
  assert.deepEqual(b.lines, [])
  assert.equal(b.text, '')
  const onlyDead = prefsBrief(
    [
      rec({ id: 'a', deletedAt: '2026-11-18T11:00:00.000Z' }),
      rec({ id: 'b', attr: 'style', confirmedByUser: false }),
    ],
    {},
  )
  assert.equal(onlyDead.text, '', '删除/未确认的记录一条都不能出现在上下文里')
})

test('prefsBrief：一条长期偏好 = 一行，含人话标签与作用域', () => {
  const b = prefsBrief([rec({ value: 'light' })], {})
  assert.equal(b.lines.length, 1)
  assert.match(b.lines[0], /颜色偏好/)
  assert.match(b.lines[0], /light/)
  assert.match(b.lines[0], /长期/)
})

test('prefsBrief：同一属性只出现一行，且是被取代后的最新值', () => {
  let prefs: PrefRecord[] = []
  prefs = upsertPref(prefs, rec({ id: 'p1', value: 'light', createdAt: '2026-11-18T10:00:00.000Z' }))
  prefs = upsertPref(prefs, rec({ id: 'p2', value: 'dark', createdAt: '2026-11-18T10:01:00.000Z' }))
  const b = prefsBrief(prefs, {})
  assert.equal(b.lines.length, 1, '改主意后不能同时出现 light 和 dark')
  assert.match(b.lines[0], /dark/)
  assert.doesNotMatch(b.lines[0], /light/)
})

test('prefsBrief：本方案偏好压过长期，并写明长期值；别的方案看不到它', () => {
  const prefs = [
    rec({ id: 'p1', value: 'light', createdAt: '2026-11-18T10:00:00.000Z' }),
    rec({ id: 't1', scope: 'task', taskKey: 'pln_020', value: 'dark', createdAt: '2026-11-18T10:02:00.000Z' }),
  ]
  const here = prefsBrief(prefs, { taskKey: 'pln_020' })
  assert.equal(here.lines.length, 1)
  assert.match(here.lines[0], /dark/)
  assert.match(here.lines[0], /仅本方案/)
  assert.match(here.lines[0], /长期为 light/)
  const elsewhere = prefsBrief(prefs, { taskKey: 'pln_040' })
  assert.match(elsewhere.lines[0], /light/, '换方案后应回落到长期偏好')
})

test('prefsBrief：最多 6 行，被省略的数量如实说明', () => {
  const prefs = [
    rec({ id: 'a', attr: 'palette', value: 'light' }),
    rec({ id: 'b', attr: 'style', value: 'minimal' }),
    rec({ id: 'c', attr: 'avoid', value: 'heels' }),
    rec({ id: 'd', attr: 'size_top', value: 'M' }),
    rec({ id: 'e', attr: 'size_bottom', value: '28' }),
    rec({ id: 'f', attr: 'size_shoes', value: '38' }),
    rec({ id: 'g', attr: 'brand_prefer', value: 'COS' }),
    rec({ id: 'h', attr: 'brand_avoid', value: 'Shein' }),
  ]
  const b = prefsBrief(prefs, {})
  assert.equal(b.lines.length, 6, '行数上限必须硬性生效')
  assert.equal(b.omitted, 3)
  assert.match(b.lines.at(-1) ?? '', /另有 3 项/)
  assert.ok(b.attrs.length <= 5, '省略说明行不算一条偏好')
})

test('prefsBrief：值可读化（数组 / 布尔 / 超长截断），空值跳过', () => {
  const prefs = [
    rec({ id: 'a', attr: 'palette', value: ['深色', '墨黑'] }),
    rec({ id: 'b', attr: 'style', value: 'minimal-very-long-style-tag-that-keeps-going-and-going' }),
    rec({ id: 'c', attr: 'avoid', value: '' }),
    rec({ id: 'd', attr: 'size_top', value: [] }),
    rec({ id: 'e', attr: 'brand_prefer', value: 'COS' }),
  ]
  const b = prefsBrief(prefs, {}, { valueMaxChars: 12 })
  const joined = b.lines.join('\n')
  assert.match(joined, /深色、墨黑/)
  assert.match(joined, /…/, '超长值应截断而不是撑爆上下文')
  assert.doesNotMatch(joined, /要避开/, '空值不能占一行')
  assert.doesNotMatch(joined, /上装尺码/, '空数组不能占一行')
})

test('prefsBrief：确定性——同样的记录必然产出同样的文本', () => {
  const prefs = [
    rec({ id: 'a', attr: 'style', value: 'minimal' }),
    rec({ id: 'b', attr: 'palette', value: 'light' }),
  ]
  assert.equal(prefsBrief(prefs, {}).text, prefsBrief([...prefs], {}).text)
  assert.match(prefsBrief(prefs, {}).lines[0], /颜色偏好/, 'canonical 顺序固定，不随写入顺序抖动')
})
