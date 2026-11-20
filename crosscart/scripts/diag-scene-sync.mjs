import { chromium } from 'playwright-core'
const B = 'http://127.0.0.1:8790'
const post = async (p, b) => {
  const r = await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) })
  return { status: r.status, body: await r.json() }
}
const api = async (p) => (await fetch(B + p)).json()

const dup = (await post('/api/plans/pln_020/duplicate', {})).body
const id = dup.planId
console.log('副本', id, '初始场景', (await api(`/api/plans/${id}`)).sceneView.spec.sceneId)

const b = await chromium.launch({ channel: 'msedge', headless: true })
const p = await b.newPage({ viewport: { width: 1440, height: 1040 } })
await p.goto(`${B}/?plan=${id}`, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(2000)
const read = () => p.evaluate(() => ({
  name: document.querySelector('#scene-name')?.innerText,
  src: document.querySelector('#stage-img')?.getAttribute('src'),
  url: location.search,
}))
console.log('初始页面', await read())

const target = { place: 'tokyo-street', season: 'autumn', time: 'night', weather: 'rain' }
const r = await post(`/api/plans/${id}/scene`, target)
console.log('切场景响应', r.status, 'view.status', r.body.view?.status, 'image', r.body.view?.image, 'cached', r.body.cached)
for (const ms of [400, 1000, 2000]) {
  await p.waitForTimeout(ms === 400 ? 400 : ms - 400)
  console.log(`+${ms}ms 页面`, await read())
}
await b.close()
