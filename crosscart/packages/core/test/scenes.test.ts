import test from 'node:test'
import assert from 'node:assert/strict'
import {
  listScenes,
  resolveScene,
  suggestScenes,
  buildScenePrompt,
  sceneCacheKey,
  checkAdaptation,
  hitRegion,
  DEFAULT_REGIONS,
  stableHash,
  type SceneSpec,
} from '../dist/index.js'
import { createPlan, type CatalogItem, type OutfitPlan } from '../dist/index.js'

const TODAY = '2026-11-16'

function mkItem(over: Partial<CatalogItem> & { productId: string; category: CatalogItem['category'] }): CatalogItem {
  return {
    title: over.productId,
    color: 'Snow',
    colorFamily: 'light',
    style: ['minimal'],
    price: { amount: 50, currency: 'USD', status: 'confirmed', source: 'seed', fetchedAt: TODAY },
    shipping: { fee: { amount: 10, currency: 'USD', status: 'estimated', source: 'rule' }, status: 'estimated', etaDays: [3, 5], etaEarliest: null, etaLatest: null, source: 'rule:std' },
    duty: { amount: null, status: 'unavailable', reason: 'v1' },
    sizes: ['S', 'M'],
    url: 'https://www.everlane.com/products/x',
    image: { main: 'm.svg', cutout: 'c.svg' },
    ...over,
  } as CatalogItem
}

function mkPlan(): OutfitPlan {
  return createPlan({
    label: 'T',
    scene: { type: 'travel', destination: 'Tokyo', days: 3, today: TODAY },
    budget: { limit: 300, currency: 'USD', basis: 'new_items_only' },
    arrivalBy: { date: '2026-11-22' },
    shipTo: 'CN',
    catalog: [mkItem({ productId: 'ow1', category: 'outerwear' }), mkItem({ productId: 'sh1', category: 'shoes', color: 'White' })],
    ownedItems: [],
    slots: [
      { slot: 'outerwear', status: 'to_buy', productId: 'ow1' },
      { slot: 'shoes', status: 'to_buy', productId: 'sh1' },
    ],
  })
}

test('场景解析：同一组合永远得到同一个 sceneId（确定性）', () => {
  const a = resolveScene({ place: 'tokyo-street', season: 'autumn', time: 'dusk', weather: 'clear' })
  const b = resolveScene({ place: 'tokyo-street', season: 'autumn', time: 'dusk', weather: 'clear' })
  const c = resolveScene({ place: 'tokyo-street', season: 'winter', time: 'night', weather: 'rain' })
  assert.equal(a.sceneId, b.sceneId)
  assert.notEqual(a.sceneId, c.sceneId)
  assert.ok(a.label.includes('东京'))
  assert.ok(c.prompt.includes('wet pavement'), '雨天的提示词必须体现湿地面')
  assert.ok(c.prompt.includes('night'), '夜晚必须在提示词里')
})

test('场景解析：未知地点抛错，不悄悄换成默认', () => {
  assert.throws(() => resolveScene({ place: 'atlantis' }), /未知场景地点/)
})

test('场景解析：自定义描述生成稳定 ID，并保留适配标记', () => {
  const a = resolveScene({ custom: '雨后傍晚的代官山', weather: 'rain' })
  const b = resolveScene({ custom: '雨后傍晚的代官山', weather: 'rain' })
  assert.equal(a.sceneId, b.sceneId)
  assert.deepEqual(a.requiresAdaptation, ['waterproof'])
})

test('场景库：四个分类都有内容，且同一地点不同时间提示词不同', () => {
  const all = listScenes()
  const cats = new Set(all.map((s) => s.category))
  assert.deepEqual([...cats].sort(), ['city', 'daily', 'event', 'travel'])
  assert.ok(all.length >= 20)
  const day = resolveScene({ place: 'seaside', time: 'afternoon' })
  const night = resolveScene({ place: 'seaside', time: 'night' })
  assert.notEqual(day.prompt, night.prompt)
})

test('提示词：从结构化槽位构建，含真实颜色与类目，不含聊天文本', () => {
  const plan = mkPlan()
  const spec = resolveScene({ place: 'paris-cafe' })
  const p = buildScenePrompt(plan, spec)
  assert.ok(/snow/i.test(p), '外套颜色必须进提示词')
  assert.ok(p.includes('jacket'))
  assert.ok(/white/i.test(p), '鞋子颜色必须进提示词')
  assert.ok(p.includes('full-body'), '必须全身构图')
  assert.ok(p.includes('Parisian corner café') || p.includes('Paris'), '场景要进提示词')
})

test('缓存键：换一件商品 → 键变化；换场景 → 键变化；都不变 → 键不变', () => {
  const plan = mkPlan()
  const spec = resolveScene({ place: 'tokyo-street' })
  const k0 = sceneCacheKey(plan, spec)
  const plan2 = { ...plan, slots: plan.slots.map((s) => (s.slot === 'shoes' ? { ...s, item: mkItem({ productId: 'sh2', category: 'shoes', color: 'Black' }) } : s)) }
  assert.notEqual(sceneCacheKey(plan2, spec), k0, '换鞋必须换缓存键')
  const spec2 = resolveScene({ place: 'seaside' })
  assert.notEqual(sceneCacheKey(plan, spec2), k0, '换场景必须换缓存键')
  assert.equal(sceneCacheKey(plan, spec), k0, '同方案同场景必须命中同一缓存')
})

test('场景适配：防雨外套不提示、非防雨外套提示、没外套也提示；提示绝不改方案', () => {
  const rainy = resolveScene({ place: 'park', weather: 'rain' })
  const plan = mkPlan()
  // 测试外套标题是 'ow1'（不含防雨词）→ 应提示
  assert.equal(checkAdaptation(plan, rainy).needed, true, '非防雨外套在雨天要提示')
  // 换成防雨外套 → 不提示
  const dry = {
    ...plan,
    slots: plan.slots.map((s) =>
      s.slot === 'outerwear' ? { ...s, item: { ...s.item, title: 'Storm Rain Anorak' } as typeof s.item } : s,
    ),
  }
  assert.equal(checkAdaptation(dry, rainy).needed, false, '防雨外套不需要提示')
  const bare = { ...plan, slots: plan.slots.map((s) => (s.slot === 'outerwear' ? { ...s, item: null, status: 'empty' as const } : s)) }
  const need = checkAdaptation(bare, rainy)
  assert.equal(need.needed, true)
  assert.ok(need.hints[0].includes('外套'))
  assert.equal(bare.revision, plan.revision, '适配检查绝不能改方案')
})

test('热点命中：重叠区域取面积最小者（鞋子比外套优先）', () => {
  // 外套区域 (0.24,0.12,0.52,0.42) 与上衣 (0.35,0.22,0.3,0.24) 重叠：点正中应命中上衣
  assert.equal(hitRegion(DEFAULT_REGIONS, 0.5, 0.3), 'top')
  // 鞋子区域独占用最下方
  assert.equal(hitRegion(DEFAULT_REGIONS, 0.5, 0.88), 'shoes')
  // 完全不在任何区域 → null，界面必须回退到名称选择
  assert.equal(hitRegion(DEFAULT_REGIONS, 0.02, 0.02), null)
})

test('推荐场景：目的地能命中场景库（东京 → 东京街头排第一）', () => {
  const plan = mkPlan()
  const list = suggestScenes(plan, 3)
  assert.equal(list[0].place, '东京')
})

test('稳定哈希：同样的输入永远同样的输出，不同输入几乎必不同', () => {
  assert.equal(stableHash('abc'), stableHash('abc'))
  assert.notEqual(stableHash('abc'), stableHash('abd'))
  assert.match(stableHash('abc'), /^[0-9a-z]+$/)
})

test('场景解析结果结构完整（供缓存与 UI 使用）', () => {
  const spec: SceneSpec = resolveScene({ place: 'nyc-commute', season: 'winter', time: 'morning', weather: 'snow' })
  assert.ok(spec.requiresAdaptation.includes('warm'))
  assert.ok(spec.label.includes('冬'))
  assert.ok(spec.label.includes('雪'))
})
