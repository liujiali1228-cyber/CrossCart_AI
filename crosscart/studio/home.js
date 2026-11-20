/**
 * CrossCart · AI 购物首页
 *
 * 只做四件事：
 *  1. 用真实数据渲染「灵感 / 我的方案 / 个人偏好」；
 *  2. 把自然语言需求交给同一个对话引擎（POST /api/chat）；
 *  3. 用「本轮独占的对话回合」把新建方案与这次点击可靠关联，然后进场景购物页；
 *  4. 管偏好：自己写 / 确认或拒绝 AI 的待确认提议 / 删除已生效的（F3）。
 *
 * 不重算金额，不生成图片，不伪造个性化推荐；待确认提议一律标「AI 推断」，绝不假装已生效。
 */

const $ = (id) => document.getElementById(id)

const state = {
  plans: [],
  prefs: [],
  pending: [],
  groups: [],
  submitting: false,
  showCopies: false,
  startedAt: 0,
  baseline: new Set(),
  accepted: false,
  es: null,
  poll: null,
  statusTimer: null,
}

const money = (n) => `$${Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const timeOf = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { code: data.code })
  return data
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

function toast(text, bad = false) {
  const el = $('toast')
  el.textContent = text
  el.classList.toggle('bad', bad)
  el.hidden = false
  clearTimeout(toast._t)
  toast._t = setTimeout(() => (el.hidden = true), 4600)
}

/* ------------------------------------------------------------------ 渲染 */

function withScene(plans) {
  return plans.filter((p) => p.scene?.status === 'ready' && p.scene?.image)
}

/* 主视觉素材（Phase 4.1-B 精修 · 移动端独立取景）
   桌面：16:10 秀场大片 → 4:3 容器（多人行进，横向叙事）
   移动：同一季的 9:16 竖版单人照 → 3:4 容器（窄屏只留一个人，避免左右各半个人）
   两张都是官方为不同设备准备的构图，不做同一张图的强行缩放。
   A 版（仅作对照，?hero=a）：改用自有场景图的原图裁切。
   全部只是展示层，不参与任何业务判断。 */
const HERO_ASSETS = {
  desktop: '/assets/hero-editorial.jpg',
  mobile: '/assets/hero-mobile.jpg',
}

function heroAlt() {
  return new URLSearchParams(location.search).get('hero') === 'a'
}

function bindHeroFallback(box) {
  const img = box.querySelector('img')
  if (!img) return
  const fail = () => {
    box.className = 'hero-media typo'
    box.innerHTML = '<p>挑一件外套，<br />再看它落在哪个街角。</p>'
  }
  // 已经有缓存判定时不能再等 error 事件
  if (img.complete && img.naturalWidth === 0) fail()
  else img.addEventListener('error', fail, { once: true })
}

function renderHero() {
  const box = $('hero-media')
  const alt = heroAlt()
  if (alt) {
    const pick = withScene(state.plans).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
    if (pick) {
      box.className = 'hero-media hero-alt'
      box.innerHTML = `<img src="${esc(pick.scene.image)}" alt="${esc(pick.scene.label ?? '场景穿搭')}" />
        <span class="hero-alt-note">A 版对照 · 自有场景图裁切</span>`
      bindHeroFallback(box)
      return
    }
  }

  /* 消费者页面只放摄影与文案；素材来源与授权状态在页面底部原型说明区与 SOURCES.md 里。

     P9：首屏大图原来是一张 232KB/199KB 的 JPEG，窄屏也要下整张 1600px。
     现在给 WebP 多档 + 分辨率描述，浏览器按视口和 DPR 自己挑最小够用的一张；
     文件更小、看起来一样（只等比缩放，不裁不锐化）。JPEG 留作兜底。 */
  box.className = 'hero-media'
  box.innerHTML = `<picture>
      <source type="image/webp" media="(max-width: 720px)"
        srcset="/assets/hero-mobile-780.webp 780w, /assets/hero-mobile-1080.webp 1080w" sizes="100vw" />
      <source type="image/webp"
        srcset="/assets/hero-editorial-1000.webp 1000w, /assets/hero-editorial-1600.webp 1600w"
        sizes="(max-width: 1279px) 58vw, 760px" />
      <source media="(max-width: 720px)" srcset="${HERO_ASSETS.mobile}" />
      <img src="${HERO_ASSETS.desktop}" alt="CrossCart 秋季场景穿搭主视觉" width="1600" height="1000" fetchpriority="high" />
    </picture>`
  bindHeroFallback(box)
}

/* 编辑精选：四种场景的完整造型，只作为创建需求的起点
   —— 不含商品、不展示价格、不声称可购买。

   P10：原来页头另有一排「东京·秋季 灵感↗ / 巴黎·周末 灵感↗ / 日常通勤 灵感↗」，
   和卡片是两套入口，读者要来回找。现在外链只留在每张卡片标题右侧的箭头上：
   点卡片 = 把这个造型填进需求框（站内），点箭头 = 去对应的时尚杂志栏目看更多（新标签页）。
   链接原则：官方栏目 / 专题文章、内容对得上这张卡的造型、提交前核过 HTTP 200。 */
const EDITORIAL = [
  {
    img: '/assets/insp-1.jpg',
    title: '城市秋日穿搭',
    prompt: '帮我搭一套城市秋日穿搭：深色长外套配长裤，要在城里走一整天，预算 260 美元',
    source: 'Vogue',
    link: 'https://www.vogue.com/article/fall-2026-coat-trends',
    linkText: '今年秋天值得入手的外套趋势',
  },
  {
    img: '/assets/insp-2.jpg',
    title: '都市极简',
    prompt: '帮我搭一套都市极简的穿搭：黑色西装外套配直筒长裤，预算 300 美元',
    source: 'Vogue',
    link: 'https://www.vogue.com/shopping/the-workwear-edit',
    linkText: '西装与直筒裤的通勤穿搭专题',
  },
  {
    img: '/assets/insp-3.jpg',
    title: '轻松周末',
    prompt: '帮我搭一套轻松的周末穿搭：针织上衣配半身裙和短靴，预算 220 美元',
    source: "Harper's BAZAAR",
    link: 'https://www.harpersbazaar.com/fashion/trends/a62652719/best-sweater-dress-outfits/',
    linkText: '针织配短靴的周末造型',
  },
  {
    img: '/assets/insp-4.jpg',
    title: '轻旅行衣橱',
    prompt: '帮我搭一套适合轻旅行的穿搭：一件大衣配牛仔裤，能走一整天，预算 280 美元',
    source: 'Vogue',
    link: 'https://www.vogue.com/article/travel-capsule-wardrobe',
    linkText: '秋季旅行胶囊衣橱清单',
  },
]

function renderInspiration() {
  const grid = $('insp-grid')
  grid.innerHTML = EDITORIAL.map(
    (it, i) => `<div class="insp" data-insp="${i}" data-scene="${esc(it.title)}">
        <button class="insp-hit" type="button" aria-label="用「${esc(it.title)}」这个造型作为需求起点">
          <span class="insp-media"><img src="${esc(it.img)}" alt="${esc(it.title)} 的完整造型" loading="lazy" /></span>
          <span class="insp-cap"><b>${esc(it.title)}</b></span>
        </button>
        <a class="insp-go" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer"
          title="在 ${esc(it.source)} 查看${esc(it.linkText)}（新标签页打开）"
          aria-label="在 ${esc(it.source)} 查看${esc(it.linkText)}（新标签页打开）">↗</a>
      </div>`,
  ).join('')

  grid.querySelectorAll('[data-insp]').forEach((card) =>
    card.querySelector('.insp-hit')?.addEventListener('click', () => {
      const it = EDITORIAL[Number(card.dataset.insp)]
      const input = $('ask-input')
      input.value = it.prompt
      window.scrollTo({ top: 0, behavior: 'smooth' })
      setTimeout(() => input.focus(), 320)
    }),
  )
}


/* 方案区：先给有真实场景封面的，未生成的收成一行行文字状态；
   反复跑验收留下的「…· 副本」默认隐藏（只隐藏展示，不删数据）。 */
const isCopy = (p) => /副本/.test(String(p.label ?? ''))

function planCardHtml(p) {
  const over = p.budget?.verdict === 'over_budget'
  const count = p.slots.filter((s) => s.item).length
  return `<a class="plan-card" href="/?plan=${encodeURIComponent(p.planId)}">
    <span class="thumb"><img src="${esc(p.scene.image)}" alt="${esc(p.label)}" loading="lazy" /></span>
    <h3>${esc(p.label)}</h3>
    <span class="meta">
      <span>${count} 件</span>
      <span>${money(p.total)}</span>
      <span class="${over ? 'over' : ''}">${over ? `超预算 ${money(p.budget?.overBy)}` : '预算内'}</span>
      <span>${esc(p.arrival?.label ?? '')}</span>
    </span>
  </a>`
}

function pendingRowHtml(p) {
  const count = p.slots.filter((s) => s.item).length
  return `<li><a href="/?plan=${encodeURIComponent(p.planId)}">
    <span class="t">${esc(p.label)}</span>
    <span class="m">${count} 件 · ${money(p.total)}</span>
  </a></li>`
}

function renderPlans() {
  const all = [...state.plans].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  const copies = all.filter(isCopy)
  const visible = state.showCopies ? all : all.filter((p) => !isCopy(p))
  const covered = visible.filter((p) => p.scene?.image)
  const pending = visible.filter((p) => !p.scene?.image)
  const grid = $('plan-grid')
  const pendingBox = $('plan-pending')
  const toggle = $('toggle-copies')

  const bits = [`共 ${all.length} 份`]
  if (covered.length) bits.push(`${covered.length} 份已有场景图`)
  if (!state.showCopies && copies.length) bits.push(`已隐藏 ${copies.length} 份测试副本`)
  $('plans-count').textContent = all.length ? bits.join(' · ') : ''

  toggle.hidden = copies.length === 0
  toggle.textContent = state.showCopies ? `隐藏 ${copies.length} 份测试副本` : `显示 ${copies.length} 份测试副本`
  toggle.onclick = () => {
    state.showCopies = !state.showCopies
    renderPlans()
  }

  if (visible.length === 0) {
    grid.innerHTML = `<p class="pref-empty">还没有方案。用上面的输入框说一句要去哪、几天、多少预算，
      AI 会用真实商品建一份；也可以先看一份示例。<br />
      <button class="btn small" id="btn-demo" style="margin-top:12px">生成一份示例方案</button></p>`
    $('btn-demo')?.addEventListener('click', createDemo)
    pendingBox.hidden = true
    return
  }

  grid.innerHTML = covered.slice(0, 6).map(planCardHtml).join('')
  const rest = $('pending-list')
  pendingBox.hidden = pending.length === 0
  const head = pendingBox.querySelector('.pending-head')
  if (head) {
    head.textContent = pending.length > 5 ? `更多方案 · 共 ${pending.length} 份，显示最近 5 份` : '更多方案'
  }
  rest.innerHTML = pending.slice(0, 5).map(pendingRowHtml).join('')
}

/* ------------------------------------------------------------ 个人偏好（F3） */

const ATTR_LABEL = {
  palette: '颜色偏好',
  style: '风格偏好',
  avoid: '要避开',
  size_top: '上装尺码',
  size_bottom: '下装尺码',
  size_shoes: '鞋码',
  brand_prefer: '偏好品牌',
  brand_avoid: '避开品牌',
  budget_habit: '预算习惯',
}
const BASIS_LABEL = { swap: '来自换件', selection: '来自挑选', chat: '来自对话', form: '来自表单' }
const SCOPE_LABEL = { profile: '长期', task: '仅本方案' }

const attrLabel = (a) => ATTR_LABEL[a] ?? a
const valText = (v) =>
  typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => String(x)).join('、') : JSON.stringify(v)
const srcBadge = (p) => {
  if (p.source === 'ai') return '<span class="pref-src is-ai">AI 推断 · 你已确认</span>'
  if (p.source === 'legacy') return '<span class="pref-src">历史记录</span>'
  return '<span class="pref-src is-user">你设置</span>'
}

function renderPrefs() {
  renderPending()
  renderActivePrefs()
}

function renderActivePrefs() {
  const box = $('prefs-list')
  const count = $('prefs-count')
  if (count) count.textContent = state.prefs.length ? `已保存 ${state.prefs.length} 条` : ''
  if (!state.prefs.length) {
    box.innerHTML = `<p class="pref-empty">还没有保存的偏好。</p>`
    return
  }
  box.innerHTML = state.prefs
    .slice()
    .reverse()
    .map(
      (p) => `<div class="pref-row" data-pref-id="${esc(p.id)}" data-attr="${esc(p.attr)}" data-scope="${esc(p.scope)}">
        <span class="k">${esc(attrLabel(p.attr))}</span>
        <span class="v">${esc(valText(p.value))}${p.scope === 'task' ? ` <span class="pref-scope">仅本方案</span>` : ''} ${srcBadge(p)}</span>
        <span class="t"><button type="button" class="pref-act" data-act="delete" data-id="${esc(p.id)}" aria-label="删除这条偏好">删除</button></span>
      </div>`,
    )
    .join('')
}

function renderPending() {
  const wrap = $('prefs-pending')
  // 注意：首页方案区已有一个 #pending-list（待生成场景图），这里必须用独立 id，
  // 否则 getElementById 会拿到前面那个，偏好条目会被写进方案区且点击事件不冒泡到 #prefs。
  const list = $('prefs-pending-list')
  const items = state.pending ?? []
  wrap.hidden = items.length === 0
  if (items.length === 0) {
    list.innerHTML = ''
    return
  }
  list.innerHTML = items
    .map((p) => {
      const ev = p.evidence ?? {}
      const why = ev.quote
        ? `依据：${esc(ev.quote)}${ev.basis ? `（${esc(BASIS_LABEL[ev.basis] ?? ev.basis)}${ev.ref ? ` · ${esc(ev.ref)}` : ''}）` : ''}`
        : '依据未记录'
      return `<li class="pref-prop is-pending" data-pref-id="${esc(p.id)}">
        <div class="pp-main">
          <span class="k">${esc(attrLabel(p.attr))}</span>
          <span class="v">${esc(valText(p.value))}</span>
          <span class="pref-scope">${esc(SCOPE_LABEL[p.scope] ?? p.scope)}</span>
        </div>
        <p class="pp-why">${why}</p>
        <div class="pp-acts">
          <button type="button" class="pref-act is-primary" data-act="confirm" data-id="${esc(p.id)}">确认，以后都参考</button>
          <button type="button" class="pref-act" data-act="reject" data-id="${esc(p.id)}">拒绝</button>
        </div>
      </li>`
    })
    .join('')
}

/** 确认 / 拒绝 / 删除 —— 三条路径都走服务端，改完重新拉取（以服务端为准，不在前端猜状态）。 */
async function prefAction(act, id) {
  if (!id) return
  const base = `/api/prefs/${encodeURIComponent(id)}`
  try {
    if (act === 'confirm') {
      await api(`${base}/confirm`, { method: 'PATCH', body: JSON.stringify({}) })
      toast('已加入长期偏好，之后的推荐会参考它')
    } else if (act === 'reject') {
      await api(`${base}/reject`, { method: 'PATCH', body: JSON.stringify({}) })
      toast('已拒绝，这条不会生效，也不会再自动出现')
    } else if (act === 'delete') {
      await api(base, { method: 'DELETE' })
      toast('已删除，这条偏好不再生效')
    } else return
    await loadPrefs()
  } catch (err) {
    toast(err.message, true)
  }
}

function openPlan(planId) {
  location.href = `/?plan=${encodeURIComponent(planId)}`
}

/* ------------------------------------------------------------ 首页 → 建方案 */

/**
 * 首页风格词：点一下把需求填进输入框（站内行为，保持不变）。
 *
 * P10：这里原来每个词后面还挂一条「灵感 ↗」外链，和下方四张编辑精选卡片的外链重复，
 * 页面上出现两套「去哪里看灵感」。现在外链统一收进卡片标题右侧的箭头，这一排只留
 * 风格词本身和「查看我的偏好」。
 */
const PRESETS = [
  ['东京 · 秋季', '我要去东京玩三天，预算 200 美元，帮我搭一套秋日街头穿搭'],
  ['巴黎 · 周末', '周末去巴黎，预算 300 美元，想搭一套适合咖啡馆和散步的穿搭'],
  ['日常通勤', '帮我搭一套日常通勤的穿搭，预算 150 美元，简洁一点'],
]

function renderChips() {
  const box = $('hero-chips')
  box.innerHTML =
    PRESETS.map(
      ([label], i) => `<span class="chip-pair"><button type="button" data-preset="${i}">${esc(label)}</button></span>`,
    ).join('') + '<button type="button" class="to-prefs" data-goto="prefs">查看我的偏好 →</button>'
  box.querySelectorAll('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      $('ask-input').value = PRESETS[Number(b.dataset.preset)][1]
      $('ask-input').focus()
    }),
  )
  box.querySelector('[data-goto="prefs"]')?.addEventListener('click', () =>
    $('prefs').scrollIntoView({ behavior: 'smooth', block: 'start' }),
  )
}

function setStatus(html, bad = false) {
  const el = $('hero-status')
  if (!html) {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  el.hidden = false
  el.classList.toggle('bad', bad)
  el.innerHTML = html
}

function setBusy(on) {
  state.submitting = on
  $('ask-go').disabled = on
  $('ask-input').readOnly = on
}

function phaseText(snap) {
  if (!snap?.running) return '正在整理结果…'
  if (snap.phase === 'tools') return '正在读取商品目录、比较价格…'
  if (snap.phase === 'writing') return '正在写方案与说明…'
  return '正在理解你的需求…'
}

/** 确保 SSE 已连上（plan.created 是主通道） */
function ensureSSE() {
  if (state.es) return
  const es = new EventSource('/api/events')
  state.es = es
  es.addEventListener('plan.created', (e) => {
    if (!state.submitting) return
    const data = JSON.parse(e.data)
    if (data.from) return // 另存为/复制出来的方案不是本轮需求
    if (state.baseline.has(data.planId)) return
    acceptPlan(data.planId)
  })
  es.addEventListener('chat', (e) => {
    if (!state.submitting) return
    const snap = JSON.parse(e.data)
    if (snap.error) return fail(snap.error)
    if (snap.running) setStatus(`<span class="dots"><i></i><i></i><i></i></span>${esc(phaseText(snap))}`)
  })
  // AI 在别处提议/改了偏好 → 首页实时刷新（不靠用户手动刷新页面）
  es.addEventListener('prefs.proposed', () => schedulePrefsReload())
  es.addEventListener('prefs.updated', () => schedulePrefsReload())
  es.onerror = () => {
    /* 断线由轮询兜底，不打断用户 */
  }
}

let prefsTimer = null
function schedulePrefsReload() {
  clearTimeout(prefsTimer)
  prefsTimer = setTimeout(() => {
    loadPrefs().catch(() => {})
  }, 200)
}

async function acceptPlan(planId) {
  if (!state.submitting || state.accepted) return
  state.accepted = true
  try {
    const vm = await api(`/api/plans/${encodeURIComponent(planId)}`)
    // 关联校验：必须是本轮开始之后仍在更新的方案（防止别的窗口/后台任务抢占）
    if (Date.parse(vm.updatedAt) < state.startedAt - 5000) {
      state.accepted = false
      return
    }
    clearTimeout(state.statusTimer)
    clearInterval(state.poll)
    setStatus('方案已生成，正在打开…')
    location.href = `/?plan=${encodeURIComponent(planId)}&welcome=1`
  } catch {
    state.accepted = false
  }
}

function fail(message) {
  if (!state.submitting) return
  setBusy(false)
  clearInterval(state.poll)
  setStatus(
    `${esc(message)} <button class="btn link retry" type="button" id="btn-retry">重新提交</button>
     <button class="btn link" type="button" id="btn-open-plans">先看我的方案</button>`,
    true,
  )
  $('btn-retry')?.addEventListener('click', () => send($('ask-input').value))
  $('btn-open-plans')?.addEventListener('click', () => $('plans').scrollIntoView({ behavior: 'smooth' }))
}

async function send(text) {
  const value = String(text ?? '').trim()
  if (!value || state.submitting) return
  if (state.es === null || state.es.readyState === 2) {
    state.es = null
    ensureSSE()
  }
  state.accepted = false
  state.startedAt = Date.now()
  state.baseline = new Set(state.plans.map((p) => p.planId))
  setBusy(true)
  setStatus('<span class="dots"><i></i><i></i><i></i></span>正在理解你的需求…')

  try {
    const snap = await post('/api/chat', { text: value, planId: null })
    if (snap?.error) return fail(snap.error)
    if (snap?.running) setStatus(`<span class="dots"><i></i><i></i><i></i></span>${esc(phaseText(snap))}`)
  } catch (e) {
    return fail(e.code === 'BUSY' ? '另一个窗口正在和 AI 对话，等它说完再试。' : e.message)
  }

  // 轮询兜底：SSE 漏事件时也能发现新方案（严格按 baseline + 开始时间判定）
  clearInterval(state.poll)
  state.poll = setInterval(async () => {
    if (!state.submitting) return
    try {
      const chat = await api('/api/chat')
      if (chat.error) return fail(chat.error)
      if (chat.running) setStatus(`<span class="dots"><i></i><i></i><i></i></span>${esc(phaseText(chat))}`)
      const { plans } = await api('/api/plans')
      const fresh = plans.filter((p) => !state.baseline.has(p.planId))
      if (fresh.length) {
        const newest = fresh.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
        if (Date.parse(newest.updatedAt) >= state.startedAt - 5000) return acceptPlan(newest.planId)
      }
      if (!chat.running && !state.accepted) {
        setStatus(
          `AI 这轮没有建方案（可能只是在回答）。<button class="btn link" type="button" id="btn-retry2">换个说法再试</button>`,
          true,
        )
        setBusy(false)
        clearInterval(state.poll)
        $('btn-retry2')?.addEventListener('click', () => $('ask-input').focus())
      }
    } catch {
      /* ignore */
    }
  }, 2500)

  // 上限 150s：不静默卡住，给可操作出口
  clearTimeout(state.statusTimer)
  state.statusTimer = setTimeout(() => {
    if (!state.submitting) return
    setStatus(
      `还在处理。方案可能要 1–2 分钟，也可以先去「我的方案」看看。
       <button class="btn link" type="button" id="btn-stop-wait">停止等待</button>`,
      true,
    )
    $('btn-stop-wait')?.addEventListener('click', async () => {
      try {
        await post('/api/chat/stop')
      } catch {
        /* ignore */
      }
      setBusy(false)
      clearInterval(state.poll)
      setStatus('已停止等待。方案如果已经建好，会出现在「我的方案」里。')
      await loadPlans()
    })
  }, 150000)
}

async function createDemo() {
  try {
    const vm = await post('/api/plans/demo')
    location.href = `/?plan=${encodeURIComponent(vm.planId)}&welcome=1`
  } catch (e) {
    toast(e.message, true)
  }
}

/* ------------------------------------------------------------------ 数据 */

async function loadPlans() {
  const data = await api('/api/plans')
  state.plans = data.plans ?? []
  renderHero()
  renderInspiration()
  renderPlans()
}

async function loadPrefs() {
  const data = await api('/api/prefs')
  state.prefs = data.prefs ?? []
  state.pending = data.pending ?? []
  state.groups = data.groups ?? []
  renderPrefs()
}

/* ------------------------------------------------------------------ boot */

function bind() {
  $('ask').addEventListener('submit', (e) => {
    e.preventDefault()
    send($('ask-input').value)
  })
  $('pref-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const attr = $('pref-attr').value
    const value = $('pref-value').value.trim()
    if (!value) return toast('先写一句偏好内容', true)
    try {
      await post('/api/prefs', { attr, value, scope: 'profile' })
      $('pref-value').value = ''
      await loadPrefs()
      toast('已保存偏好')
    } catch (err) {
      toast(err.message, true)
    }
  })
  $('prefs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]')
    if (!btn || btn.disabled) return
    const act = btn.dataset.act
    if (act !== 'confirm' && act !== 'reject' && act !== 'delete') return
    btn.disabled = true
    prefAction(act, btn.dataset.id).finally(() => {
      btn.disabled = false
    })
  })
  document.querySelectorAll('.topnav a').forEach((a) =>
    a.addEventListener('click', () => {
      document.querySelectorAll('.topnav a').forEach((x) => x.classList.toggle('active', x === a))
    }),
  )
}

async function boot() {
  bind()
  renderChips()
  ensureSSE()
  try {
    await Promise.all([loadPlans(), loadPrefs()])
  } catch (e) {
    setStatus(`首页数据加载失败：${esc(e.message)}`, true)
  }
}

boot()
