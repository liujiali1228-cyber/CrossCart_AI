/**
 * 场景生成链路的行为测试：**全部用本地 mock 图像服务**，不调用真实 API、不产生费用。
 * 覆盖：缓存命中不重复付费、换件失效缓存、预算闸门、失败保留旧图、自动模式合并、人工修正、日志不含密钥。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SceneGen } from '../src/scenegen.mjs'

/** 1x1 透明 PNG：mock 服务返回它，够验证「拿到图并落盘」这条链路 */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function startMock({ fail = false, delay = 0 } = {}) {
  const state = { calls: 0, fail, delay, lastBody: null }
  const server = http.createServer((req, res) => {
    if (req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }))
      return
    }
    if (req.url === '/images/edits' || req.url === '/images/generations') {
      state.calls += 1
      const reply = () => {
        if (state.fail) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'mock upstream exploded' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [{ b64_json: TINY_PNG }],
            usage: { output_tokens: 4200, input_tokens: 900, total_tokens: 5100 },
          }),
        )
      }
      if (state.delay > 0) setTimeout(reply, state.delay)
      else reply()
      return
    }
    res.writeHead(404)
    res.end('no route')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.baseUrl = `http://127.0.0.1:${server.address().port}`
      state.close = () => new Promise((r) => server.close(r))
      resolve(state)
    })
  })
}

function makePlan(overrides = {}) {
  const slots = [
    { slot: 'outerwear', status: 'to_buy', locked: false, item: item('everlane:f-swtr', 'outerwear', 'Snow', 'mid', 'https://example.test/a.jpg') },
    { slot: 'top', status: 'to_buy', locked: false, item: item('everlane:f-btdn', 'top', 'Italian Straw Stripe', 'mid', 'https://example.test/b.jpg') },
    { slot: 'bottom', status: 'to_buy', locked: false, item: item('everlane:m-btm', 'bottom', 'Vintage Heather Grey', 'mid', 'https://example.test/c.jpg') },
    { slot: 'shoes', status: 'to_buy', locked: false, item: item('allbirds:shoes', 'shoes', 'white', 'light', 'https://example.test/d.jpg') },
    { slot: 'bag', status: 'to_buy', locked: false, item: item('everlane:bag', 'bag', 'Navy Blazer', 'dark', 'https://example.test/e.jpg') },
  ]
  return {
    planId: 'pln_test',
    revision: 1,
    label: '测试方案',
    scene: { type: 'travel', destination: 'Tokyo', days: 3, today: '2026-11-17' },
    constraints: { budget: { limit: 400, currency: 'USD', basis: 'new_items_only' }, arrivalBy: { date: '2026-11-30' }, shipTo: 'CN' },
    slots,
    sceneChoice: { place: 'tokyo-street', time: 'afternoon', season: 'autumn', weather: 'clear', lastKey: '' },
    sceneAuto: { enabled: false },
    ...overrides,
  }
}

function item(productId, category, color, colorFamily, cutout) {
  return {
    productId,
    title: `${color} ${category}`,
    category,
    color,
    colorFamily,
    style: [],
    price: { amount: 100, currency: 'USD', status: 'confirmed' },
    shipping: { fee: { amount: 10, currency: 'USD', status: 'estimated' }, status: 'estimated', etaDays: [5, 8], etaEarliest: null, etaLatest: null, source: 'test' },
    duty: { amount: null, status: 'unavailable' },
    sizes: ['M'],
    url: 'https://everlane.com/products/x',
    image: { main: cutout, cutout },
    vendor: 'everlane',
    sourceKind: 'live',
  }
}

async function withSceneGen(fn, { fail = false, budget, debounceMs, delay = 0, unconfigured = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cc-scene-'))
  const dir = join(root, 'scenes')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(root, 'data'), { recursive: true })
  const mock = await startMock({ fail, delay })
  if (!unconfigured) {
    writeFileSync(
      join(root, 'data', 'scenegen.config.json'),
      JSON.stringify({
        provider: {
          baseUrl: mock.baseUrl,
          apiKey: 'sk-test-DO-NOT-LEAK',
          // 用真实型号名：mock 服务不校验它，但价格表要靠前缀认出来才能估价。
          // 换成编造的名字会走「费用待确认」分支（amount=null 时按设计放行），测不准预算闸门。
          model: 'gpt-image-2',
          size: '1024x1536',
          quality: 'medium',
          refsMode: 'none',
          proxy: '',
        },
      }),
    )
  }
  if (budget != null) {
    writeFileSync(
      join(root, 'data', 'scenegen.usage.json'),
      JSON.stringify({
        budget: { limit: budget, currency: 'USD' },
        records: [],
      }),
    )
  }
  const gen = new SceneGen({ root, dir, log: () => {}, debounceMs })
  try {
    await fn({ gen, root, dir, mock })
  } finally {
    await mock.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test('同输入第二次不重复调用（缓存命中，零费用）', async () => {
  await withSceneGen(async ({ gen, mock }) => {
    const plan = makePlan()
    await gen.generate(plan)
    assert.equal(mock.calls, 1)
    const again = await gen.generate(plan)
    assert.equal(again.cached, true)
    assert.equal(mock.calls, 1, '命中缓存后不许再调 API')
  })
})

test('换一件商品 → 缓存键变化 → 必须重新生成', async () => {
  await withSceneGen(async ({ gen, mock }) => {
    const plan = makePlan()
    await gen.generate(plan)
    const key1 = gen.viewFor(plan).cacheKey
    plan.slots[0].item = item('everlane:f-swtr2', 'outerwear', 'Black', 'dark', 'https://example.test/a2.jpg')
    const key2 = gen.viewFor(plan).cacheKey
    assert.notEqual(key1, key2, '换商品必须换缓存键')
    await gen.generate(plan)
    assert.equal(mock.calls, 2)
  })
})

test('生成后自动识别热点（本地算法，结果落进索引）', async () => {
  await withSceneGen(async ({ gen }) => {
    const plan = makePlan()
    await gen.generate(plan)
    const key = gen.viewFor(plan).cacheKey
    const entry = gen.index.entries[key]
    assert.ok(entry.hotspots, '必须带识别元数据')
    assert.match(entry.hotspots.detector, /body-box/)
    assert.equal(entry.hotspots.coordinateSpace, 'normalized')
  })
})

test('预算用完：拒绝新的付费生成，且一次都不调 API', async () => {
  await withSceneGen(
    async ({ gen, mock }) => {
      const plan = makePlan()
      await assert.rejects(() => gen.generate(plan), (e) => e.code === 'BUDGET_BLOCKED')
      assert.equal(mock.calls, 0, '被预算拦住时绝不能发出请求')
    },
    { budget: 0.01 },
  )
})

test('生成失败：保留上一张图（标 stale），购物方案不受影响', async () => {
  await withSceneGen(async ({ gen, mock }) => {
    const plan = makePlan()
    await gen.generate(plan)
    const okView = gen.viewFor(plan)
    assert.equal(okView.status, 'ready')

    // 换一件 → 新键没有图；把 mock 切成失败
    plan.slots[1].item = item('everlane:f-btdn2', 'top', 'Black', 'dark', 'https://example.test/b2.jpg')
    mock.fail = true
    await assert.rejects(() => gen.generate(plan))
    const failed = gen.viewFor(plan)
    assert.equal(failed.status, 'error')
    assert.equal(failed.stale, true, '旧图必须留在画面上并标记为上一版')
    assert.ok(failed.image, '失败不能把已有图片弄丢')
    assert.ok(failed.lastError)
    // 商品数据没有被生成流程改动
    assert.equal(plan.slots[1].item.productId, 'everlane:f-btdn2')
  })
})

test('自动模式：连续换三件只生成一次（防抖合并）', async () => {
  await withSceneGen(
    async ({ gen, mock }) => {
      const plan = makePlan({ sceneAuto: { enabled: true } })
      gen.setAuto(plan, true)
      const res = gen.scheduleRegen(plan, { reason: 'swap' })
      assert.equal(res.scheduled, true)
      // 窗口内再改两次
      plan.slots[0].item = item('everlane:x1', 'outerwear', 'Black', 'dark', 'https://example.test/x1.jpg')
      gen.scheduleRegen(plan, { reason: 'swap' })
      plan.slots[2].item = item('everlane:x2', 'bottom', 'Black', 'dark', 'https://example.test/x2.jpg')
      gen.scheduleRegen(plan, { reason: 'swap' })
      await new Promise((r) => setTimeout(r, 900))
      assert.equal(mock.calls, 1, `三次换件应合并成一次生成（实际 ${mock.calls} 次）`)
    },
    { debounceMs: 180 },
  )
})

test('自动模式关闭时不排队生成（默认省钱）', async () => {
  await withSceneGen(async ({ gen, mock }) => {
    const plan = makePlan({ sceneAuto: { enabled: false } })
    const res = gen.scheduleRegen(plan)
    assert.equal(res.scheduled, false)
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(mock.calls, 0)
  })
})

test('人工修正热点：写回索引、方法标 manual、置信度 1', async () => {
  await withSceneGen(async ({ gen }) => {
    const plan = makePlan()
    await gen.generate(plan)
    const view = gen.correctHotspot(plan, 'shoes', { x: 0.3, y: 0.82, w: 0.2, h: 0.1 })
    assert.deepEqual(view.regions.shoes, { x: 0.3, y: 0.82, w: 0.2, h: 0.1 })
    assert.equal(view.hotspots.slots.shoes.method, 'manual')
    assert.equal(view.hotspots.slots.shoes.confidence, 1)
  })
})

test('费用日志：记录金额与耗时，但绝不写 apiKey', async () => {
  await withSceneGen(async ({ gen, root }) => {
    const plan = makePlan()
    await gen.generate(plan)
    const ledger = JSON.parse(readFileSync(join(root, 'data', 'scenegen.usage.json'), 'utf8'))
    assert.equal(ledger.records.length, 1)
    const rec = ledger.records[0]
    assert.equal(rec.ok, true)
    assert.ok(rec.amount >= 0, '应该记了金额')
    assert.equal(rec.cached, false)
    assert.ok(rec.usage?.output_tokens === 4200, '要留 usage 便于核对')
    const raw = JSON.stringify(ledger)
    assert.ok(!raw.includes('sk-test-DO-NOT-LEAK'), '日志里不能出现密钥')
    assert.ok(!/authorization/i.test(raw))
  })
})

test('估价：没缓存要花钱、有缓存标 0', async () => {
  await withSceneGen(async ({ gen }) => {
    const plan = makePlan()
    const before = gen.quote(plan)
    assert.equal(before.cached, false)
    assert.ok(before.estimate.amount > 0)
    await gen.generate(plan)
    const after = gen.quote(plan)
    assert.equal(after.cached, true)
    assert.equal(after.estimate.amount, 0)
    assert.equal(after.estimate.basis, 'cache-hit')
  })
})

test('停止等待：排队会被取消，且如实说明服务商可能仍计费', async () => {
  await withSceneGen(async ({ gen }) => {
    const plan = makePlan({ sceneAuto: { enabled: true } })
    gen.setAuto(plan, true)
    gen.scheduleRegen(plan)
    const r = gen.cancelWait(plan.planId, plan)
    assert.equal(r.ok, true)
    assert.match(r.note, /可能仍会计费/)
  })
})

test('生成中换件：旧结果只落到自己的缓存键，不把新方案顶成「已更新」', async () => {
  await withSceneGen(
    async ({ gen }) => {
      const plan = makePlan()
      await gen.generate(plan)

      // 换一件 → 键变了，开始生成（mock 故意慢 300ms，制造「生成中」窗口）
      plan.slots[0].item = item('everlane:slow', 'outerwear', 'Black', 'dark', 'https://example.test/s.jpg')
      const slowKey = gen.viewFor(plan).cacheKey
      const job = gen.generate(plan)
      await new Promise((r) => setTimeout(r, 60))

      // 生成还没回来，方案又改了 → 键再次变化
      plan.slots[2].item = item('everlane:newer', 'bottom', 'Black', 'dark', 'https://example.test/n.jpg')
      const latestKey = gen.viewFor(plan).cacheKey
      assert.notEqual(latestKey, slowKey)

      await job
      // 旧任务的结果落在它自己的键上（不丢，可以回看），但不能让新方案看起来已经配好了图
      assert.equal(gen.index.entries[slowKey].status, 'ready')
      const view = gen.viewFor(plan)
      assert.equal(view.cacheKey, latestKey, '视图必须跟着最新方案走')
      assert.equal(gen.index.entries[latestKey], undefined, '新键不该被旧任务写入')
      assert.equal(view.stale, true, '新方案的图还没生成，必须标成上一版')
      // 商品数据完全没被生成流程改动
      assert.equal(plan.slots[2].item.productId, 'everlane:newer')
    },
    { delay: 300 },
  )
})

test('没配图像服务：明确报 unconfigured，不发请求、不假装有图', async () => {
  await withSceneGen(
    async ({ gen, mock }) => {
      const plan = makePlan()
      const view = gen.viewFor(plan)
      assert.equal(view.status, 'unconfigured')
      assert.equal(view.image, null, '没有图就是没有图，不许拿静态图冒充')
      assert.ok(view.provider.setup.length > 0, '要告诉用户怎么配')
      await assert.rejects(() => gen.generate(plan), (e) => e.code === 'SCENEGEN_UNCONFIGURED')
      assert.equal(mock.calls, 0)
    },
    { unconfigured: true },
  )
})
