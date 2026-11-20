/**
 * CrossCart 工作台前端。
 *
 * 只做三件事：
 *  1. 渲染 bridge 的只读视图（金额、到货、购买入口都由服务端算好，页面不重算）；
 *  2. 把用户操作打回 bridge（确定性端点：swap / lock / constraints / fit-budget）；
 *  3. 显示 AI 对话（bridge 托管 dsh SDK 会话，事件经 SSE 推过来）。
 */

const $ = (id) => document.getElementById(id)

const STATUS = { confirmed: '已确认', estimated: '估算', unavailable: '待确认' }
const STRATEGIES = [
  ['similar', '同风格'],
  ['cheaper', '更便宜'],
  ['faster', '更快到'],
  ['lighter', '浅色系'],
]
const SHIP_LABEL = { CN: '中国大陆', US: '美国', JP: '日本', GB: '英国' }

const state = {
  plan: null,
  plans: [],
  chat: null,
  chatSig: '',
  selected: null,
  slot: null,
  strategy: 'similar',
  sort: 'recommended',
  candidates: [],
  pick: null,
  tab: 'chat',
  shopView: 'list',
  /** 中间主视觉：scene = AI 场景图；board = 真实商品组合视图 */
  view: 'scene',
  pickerTab: 'suggested',
  scenes: null,
  suggestedScenes: [],
  pickerQuery: { time: 'afternoon', season: 'autumn', weather: 'clear' },
  busy: false,
  ignorePlanEventsUntil: 0,
  pollTimer: null,
  /** 用户关掉的快捷建议（本次会话内保持，刷新页面用 sessionStorage 恢复） */
  dismissedSuggestions: new Set(readDismissed()),
  /** 聊天开始后建议默认收起，这里记「用户主动要再看」 */
  suggestPinned: false,
}

function readDismissed() {
  try {
    return JSON.parse(sessionStorage.getItem('cc.dismissedSuggestions') ?? '[]')
  } catch {
    return []
  }
}
function saveDismissed() {
  try {
    sessionStorage.setItem('cc.dismissedSuggestions', JSON.stringify([...state.dismissedSuggestions]))
  } catch {
    /* 隐私模式下不可写，忽略即可（关闭仍在内存里生效） */
  }
}

/* ------------------------------------------------------------------ utils */

const money = (n) => `$${Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const statusText = (s) => STATUS[s] ?? ''

/** 同一轮里同一个工具可能被连续调用多次，折叠成「工具 ×N」，避免聊天被技术噪音刷屏 */
function dedupeTools(tools) {
  const map = new Map()
  for (const t of tools) {
    const hit = map.get(t.label)
    if (hit) {
      hit.count += 1
      if (t.ok === false) hit.ok = false
      else if (hit.ok !== false && t.ok === null) hit.ok = null
    } else {
      map.set(t.label, { label: t.label, ok: t.ok, count: 1 })
    }
  }
  return [...map.values()]
}
const shortTime = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 图片失败一律显示占位，绝不留下破图或编造图片 */
window.__imgFail = (el) => {
  const box = document.createElement('div')
  box.className = 'img-ph'
  box.textContent = '图片加载失败'
  el.replaceWith(box)
}
const img = (src, alt, extra = '') =>
  `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" onerror="window.__imgFail(this)" ${extra} />`

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`)
    err.code = data.code
    err.hint = data.hint
    err.retryAfter = data.retryAfter
    throw err
  }
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

/** 够用就好的 markdown：粗体、行内代码、链接、列表、表格、代码块 */
function md(src) {
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n')
  let html = ''
  let list = null
  let table = null
  const closeList = () => {
    if (list) {
      html += `</${list}>`
      list = null
    }
  }
  const closeTable = () => {
    if (table) {
      html += '</tbody></table>'
      table = null
    }
  }
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^```/.test(line)) {
      closeList()
      closeTable()
      if (!md._code) {
        md._code = true
        html += '<pre><code>'
      } else {
        md._code = false
        html += '</code></pre>'
      }
      continue
    }
    if (md._code) {
      html += `${esc(line)}\n`
      continue
    }
    if (!line.trim()) {
      closeList()
      closeTable()
      continue
    }
    const isTable = /^\|.*\|$/.test(line.trim())
    if (isTable) {
      closeList()
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim())
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue
      if (!table) {
        table = true
        html += `<table><thead><tr>${cells.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`
      } else {
        html += `<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`
      }
      continue
    }
    closeTable()
    const ul = /^[-*]\s+(.*)$/.exec(line)
    const ol = /^\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol'
      if (list !== want) {
        closeList()
        list = want
        html += `<${want}>`
      }
      html += `<li>${inline((ul ?? ol)[1])}</li>`
      continue
    }
    closeList()
    if (/^#{1,3}\s+/.test(line)) {
      html += `<p><strong>${inline(line.replace(/^#{1,3}\s+/, ''))}</strong></p>`
      continue
    }
    html += `<p>${inline(line)}</p>`
  }
  closeList()
  closeTable()
  if (md._code) html += '</code></pre>'
  md._code = false
  return html
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  bindStatic()
  const params = new URLSearchParams(location.search)
  await Promise.all([refreshPlans(), loadChat()])
  const wanted = params.get('plan')
  const pick = state.plans.find((p) => p.planId === wanted) ?? state.plans[0]
  if (pick) await loadPlan(pick.planId)
  else renderNoPlan()
  connectSSE()
  setTab(window.innerWidth < 1024 ? 'chat' : state.tab)
  // 从首页建完方案跳过来：只做提示，不自动触发任何付费生成
  if (params.get('welcome') === '1' && state.plan) {
    toast(`方案已生成：${state.plan.label}。右侧「更换单品」可以随时换`)
  }
}

function bindStatic() {
  // 用户是否停在聊天底部：只有停着的时候才自动贴底，往上翻历史时不要抢他的位置
  const msgBox = $('messages')
  if (msgBox) {
    state.chatStick = true
    msgBox.addEventListener(
      'scroll',
      () => {
        state.chatStick = msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 64
      },
      { passive: true },
    )
  }
  $('plan-select').addEventListener('change', (e) => loadPlan(e.target.value))
  $('btn-duplicate').addEventListener('click', duplicatePlan)
  $('btn-duplicate-2').addEventListener('click', duplicatePlan)
  $('btn-share').addEventListener('click', sharePlan)
  $('btn-edit-plan').addEventListener('click', () => {
    const bar = $('constraint-bar')
    const open = bar.hidden
    bar.hidden = !open
    $('btn-edit-plan').setAttribute('aria-expanded', String(open))
    if (open) {
      $('budget-input').focus()
      $('budget-input').select?.()
    }
  })
  $('btn-open-swap').addEventListener('click', () => {
    setTab('shop')
    $('slot-chips').scrollIntoView({ block: 'nearest' })
  })
  $('btn-fit').addEventListener('click', fitBudget)
  $('btn-channels').addEventListener('click', openChannels)
  $('channels-close').addEventListener('click', () => ($('channels').hidden = true))
  $('channels').addEventListener('click', (e) => {
    if (e.target === $('channels')) $('channels').hidden = true
  })
  $('btn-chat-reset').addEventListener('click', resetChat)
  $('btn-send').addEventListener('click', (e) => {
    e.preventDefault()
    send()
  })
  $('btn-stop').addEventListener('click', stopChat)
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault()
    send()
  })
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    }
  })
  $('btn-swap-close').addEventListener('click', closeSwap)
  $('btn-scene-switch').addEventListener('click', openScenePicker)
  $('auto-toggle').addEventListener('change', (e) => toggleAuto(e.target.checked))
  $('btn-picker-close').addEventListener('click', () => ($('scene-picker').hidden = true))
  $('scene-picker').addEventListener('click', (e) => {
    if (e.target === $('scene-picker')) $('scene-picker').hidden = true
  })
  $('view-seg').querySelectorAll('[data-v]').forEach((b) =>
    b.addEventListener('click', () => {
      state.view = b.dataset.v
      $('view-seg').querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('active', x === b))
      renderStage()
    }),
  )
  $('sort-select').addEventListener('change', (e) => {
    state.sort = e.target.value
    loadCandidates()
  })
  $('shop-view').querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      state.shopView = b.dataset.view
      $('shop-view').querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('active', x === b))
      renderShop()
    }),
  )
  $('tabbar').querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)))
  $('lightbox-close').addEventListener('click', () => ($('lightbox').hidden = true))
  $('lightbox').addEventListener('click', (e) => {
    if (e.target === $('lightbox')) $('lightbox').hidden = true
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('lightbox').hidden) $('lightbox').hidden = true
      else if (!$('channels').hidden) $('channels').hidden = true
      else if (!$('scene-picker').hidden) $('scene-picker').hidden = true
      else if (!$('swap').hidden) closeSwap()
    }
  })
  for (const id of ['budget-input', 'arrival-input', 'ship-input']) {
    $(id).addEventListener('change', applyConstraints)
  }
}

function setTab(tab) {
  state.tab = tab
  requestAnimationFrame(fitStageFrame)
  $('tabbar').querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  for (const [pane, id] of [
    ['chat', 'pane-chat'],
    ['plan', 'pane-plan'],
    ['shop', 'pane-shop'],
  ]) {
    $(id).classList.toggle('active', window.innerWidth < 1024 ? pane === tab : true)
  }
}

/* ------------------------------------------------------------------ plans */

async function refreshPlans() {
  const data = await api('/api/plans')
  state.plans = data.plans
  const sel = $('plan-select')
  // 下拉里只显示方案名（+ 超预算提醒）。pln_xxx 是内部编号，消费者界面不展示；
  // 切换方案用的是 option 的 value，跟文案无关。
  sel.innerHTML = state.plans.length
    ? state.plans
        .map(
          (p) =>
            `<option value="${esc(p.planId)}"${p.planId === state.plan?.planId ? ' selected' : ''}>${esc(p.label)}${
              p.budget?.verdict === 'over_budget' ? '（超预算）' : ''
            }</option>`,
        )
        .join('')
    : '<option value="">（还没有方案）</option>'
}

async function loadPlan(planId, opts = {}) {
  if (!planId) return renderNoPlan()
  state.plan = await api(`/api/plans/${encodeURIComponent(planId)}`)
  window.history.replaceState(null, '', `?plan=${encodeURIComponent(planId)}`)
  syncConstraintInputs()
  renderPlan()
  if (state.slot && !$('swap').hidden) loadCandidates()
  if (!opts.silent) $('plan-select').value = planId
}

function renderNoPlan() {
  state.plan = null
  $('plan-title').textContent = '还没有购物方案'
  $('plan-sub').textContent = '在左边告诉 AI 你要去哪、几天、预算多少，它会用工具建方案。'
  $('btn-create-demo').hidden = false
  $('btn-create-demo').onclick = async () => {
    const vm = await post('/api/plans/demo')
    await refreshPlans()
    await loadPlan(vm.planId)
  }
  $('stage-board').innerHTML = '<div class="canvas-empty">方案会出现在这里</div>'
  $('stage-board').hidden = false
  $('stage-img').hidden = true
  $('hotspots').innerHTML = ''
  $('stage-overlay').hidden = true
  $('slot-chips').innerHTML = ''
  $('scene-name').textContent = '—'
  $('adaptation').hidden = true
  $('risk-banner').hidden = true
  $('shop-list').innerHTML = '<p class="muted">还没有可购买的清单。</p>'
  $('selection').hidden = true
  $('quick-actions').innerHTML = ''
  $('advisor-actions').innerHTML = ''
}

function syncConstraintInputs() {
  const p = state.plan
  if (!p) return
  $('budget-input').value = p.constraints.budgetLimit
  $('arrival-input').value = p.constraints.arrivalBy
  if (![...$('ship-input').options].some((o) => o.value === p.constraints.shipTo)) {
    const opt = document.createElement('option')
    opt.value = p.constraints.shipTo
    opt.textContent = `${p.constraints.shipTo}（当前）`
    $('ship-input').appendChild(opt)
  }
  $('ship-input').value = p.constraints.shipTo
  // revision 是内部版本号（并发改动的对比基准），消费者不需要看到，界面上不再展示
}

/* ------------------------------------------------------------------ render */

function renderPlan() {
  const p = state.plan
  if (!p) return renderNoPlan()
  document.title = `${p.label} · CrossCart`
  $('btn-create-demo').hidden = true
  $('plan-title').textContent = p.label
  // 方案基本信息一行说清：目的地 / 天数 / 收货地 / 预算 / 最晚到货。
  // 预算与到货默认就在这一行，不必展开「调整约束」才知道。
  const b = p.cost.breakdown
  $('plan-sub').textContent = `${p.scene.destination} · ${p.scene.days} 天 · 发往 ${
    SHIP_LABEL[p.constraints.shipTo] ?? p.constraints.shipTo
  } · 预算 ${money(p.constraints.budgetLimit)}${b.verdict === 'over_budget' ? `（已超 ${money(b.overBy)}）` : ''} · 最晚 ${p.constraints.arrivalBy} 到`

  renderRiskBanner()
  renderStage()
  renderSlotChips()
  renderSuggestions()
  renderAdaptation()
  renderCost()
  renderArrival()
  renderShop()
  renderSelection()
  renderSaveLine()
}

function renderRiskBanner() {
  const p = state.plan
  const banner = $('risk-banner')
  const hard = p.risks.find((r) => r.level === 'high')
  const soft = p.risks.find((r) => r.level === 'mid')
  const pick = hard ?? soft
  if (!pick) {
    banner.hidden = true
    return
  }
  banner.hidden = false
  banner.className = `risk-banner ${hard ? 'high' : ''}`
  banner.innerHTML = `<span>${esc(pick.text)}</span>${
    pick.code === 'over_budget' ? '<button class="btn small primary" data-fit>调整至预算内</button>' : ''
  }`
  banner.querySelector('[data-fit]')?.addEventListener('click', fitBudget)
}

/* --------------------------------------------------------- 主视觉：场景舞台 */

const shortVendor = (item) => {
  const v = item.vendor ?? ''
  return v.length > 14 ? `${v.slice(0, 13)}…` : v
}

function selectSlot(slotId) {
  state.selected = state.selected === slotId ? null : slotId
  renderStage()
  renderSlotChips()
  renderShop()
  renderSelection()
  if (state.selected && window.innerWidth < 1024) setTab('shop')
  if (state.selected) $('selection').scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

function renderStage() {
  _renderStage()
  requestAnimationFrame(fitStageFrame)
}

function _renderStage() {
  const p = state.plan
  const sv = p?.sceneView
  const imgEl = $('stage-img')
  const board = $('stage-board')
  const overlay = $('stage-overlay')
  const hotspots = $('hotspots')
  const badges = $('stage-badges')

  $('scene-name').textContent = sv ? sv.spec.label : '—'
  $('scene-hint').textContent = state.view === 'scene' ? '右侧「更换单品」可直接换' : '点商品看详情 · 右侧可换'

  // 自动更新开关：状态永远和 bridge 一致，不在前端猜。
  // 图像生成额度是内部运营信息，不再显示数字；只有「这阵子生成不了」时才用一句话提示。
  const autoOn = !!sv?.auto?.enabled
  $('auto-toggle').checked = autoOn
  $('auto-flag').classList.toggle('on', autoOn)
  const b = sv?.budget
  const quotaOut = b?.level === 'blocked'
  $('budget-chip').hidden = !quotaOut
  $('budget-chip').textContent = quotaOut ? '暂时无法生成新图' : ''
  $('budget-chip').classList.toggle('blocked', quotaOut)
  $('budget-chip').title = quotaOut ? '生成次数已达上限，稍后再试' : ''

  // —— 商品图（组合视图）：真实商品原图，永远是真实数据 ——
  if (state.view === 'board') {
    $('stage-frame').hidden = true
    imgEl.hidden = true
    hotspots.innerHTML = ''
    overlay.hidden = true
    board.hidden = false
    badges.innerHTML = sv?.status === 'ready' ? '' : ''
    board.innerHTML = p.slots
      .map((s) => {
        if (!s.item) {
          // 自有但没商品快照：显示用户自己的说法，而不是一个「＋ 添加」的空位
          if (s.status === 'owned') {
            return `<div class="canvas-empty-slot owned" data-select="${s.slot}">自有<br>${esc(
              s.ownedClaim?.label ?? s.label,
            )}</div>`
          }
          return `<div class="canvas-empty-slot" data-open-swap="${s.slot}">＋<br>${esc(s.label)}</div>`
        }
        const owned = s.status === 'owned'
        const sel = state.selected === s.slot ? 'selected' : ''
        return `<div class="canvas-item ${s.item.sourceKind === 'live' ? 'live' : ''} ${owned ? 'owned' : ''} ${sel}" data-select="${s.slot}">
          <span class="canvas-badge">${owned ? '已有' : esc(money(s.item.price.amount))}</span>
          ${s.item.sourceKind === 'live' ? '' : '<span class="canvas-badge demo">演示</span>'}
          <div class="canvas-media">${img(s.item.image.cutout, s.item.title)}</div>
          <div class="canvas-caption"><b>${esc(s.label)}</b>${esc(shortVendor(s.item))}</div>
        </div>`
      })
      .join('')
    board.querySelectorAll('[data-select]').forEach((el) => el.addEventListener('click', () => selectSlot(el.dataset.select)))
    board.querySelectorAll('[data-open-swap]').forEach((el) => el.addEventListener('click', () => openSwap(el.dataset.openSwap)))
    return
  }

  // —— 场景图模式 ——
  board.hidden = true
  $('stage-frame').hidden = false
  const status = sv?.status ?? 'missing'

  // 诚信标识不压在图上：一律放到图片正下方一行小字。
  // 图上只保留「确实需要在画面内定位」的东西（stale 遮罩由 overlay 负责）。
  const captionEl = $('stage-caption')
  const caps = []
  if (sv?.image) caps.push('<span class="cap-ai">AI 模拟穿搭 · 仅供效果参考</span>')
  // 「图还是上一版」由图片角上的轻量状态条说明（P10-2），这里不重复一遍
  // 用户明确说过「我有白鞋」这类事情时，如果复检发现图上明显不符，必须如实说。
  // 说不出来比说错好：这张图不会被描述成「已经照你说的画了」。
  if (sv?.ownedCheck?.ok === false && sv.image) {
    const labels = (sv.ownedCheck.checks ?? []).filter((c) => c.verdict === 'mismatch').map((c) => c.label)
    caps.push(`<span class="cap-warn">图里的${labels.join('、') || '自有单品'}和你说的颜色对不上，可以再生成一次</span>`)
  }
  captionEl.innerHTML = caps.join('<span class="cap-sep">·</span>')
  captionEl.hidden = caps.length === 0
  // 模型名/识别算法属于内部信息，一律不上画面
  badges.innerHTML = ''

  if (sv?.image && status !== 'generating') {
    // sv.image 已是「页面要显示的那张」：有小图给小图（900px WebP，约 180KB），没有就是原图。
    // 原图 3MB，窄带下会长时间空着舞台，所以加载失败时优先再试一次原图（imageOriginal）。
    const shown = sv.image
    const fallbackSrc = sv.imageOriginal && sv.imageOriginal !== shown ? sv.imageOriginal : null
    // 新图先预加载，避免「旧图忽然消失又没有新图」的闪断
    if (imgEl.getAttribute('src') !== shown) {
      const pre = new Image()
      pre.onload = () => {
        imgEl.src = shown
        imgEl.hidden = false
        hotspots.classList.add('fade-in')
      }
      pre.onerror = () => {
        if (!fallbackSrc) {
          imgEl.hidden = true
          renderStageOverlay('error', '场景图加载失败', '重新生成')
          return
        }
        const raw = new Image()
        raw.onload = () => {
          imgEl.src = fallbackSrc
          imgEl.hidden = false
          hotspots.classList.add('fade-in')
        }
        raw.onerror = () => {
          imgEl.hidden = true
          renderStageOverlay('error', '场景图加载失败', '重新生成')
        }
        raw.src = fallbackSrc
      }
      pre.src = shown
    }
    imgEl.hidden = false
    imgEl.onerror = () => {
      imgEl.hidden = true
      renderStageOverlay('error', '场景图加载失败', '重新生成')
    }
    renderHotspots(sv.regions, sv.hotspots)
    // 识别结论、置信度、修正入口都是内部信息，消费者页面不展示
    $('hotspot-note').hidden = true
    $('hotspot-note').innerHTML = ''
    overlay.hidden = true
    overlay.className = 'stage-overlay'
    if (sv.stale) {
      // P10-2：这里以前是一张压在图上、带两个按钮的卡片（「更新穿搭图 / 先看这张」），
      // 读起来就是在问「要不要生成」。现在改成图片左上角的一条轻量提示：
      // 不压暗画面、不挡点击、不需要用户先做选择；点其中的文字按钮才算「我要更新」。
      const waiting = autoOn && (sv.auto?.pending || sv.status === 'queued' || sv.status === 'generating')
      if (waiting) {
        renderStrip('搭配已更新，正在换图…')
        return
      }
      renderStrip('搭配已更新，图还是上一版', { kind: 'regen', label: '更新穿搭图', onClick: regenerateScene })
    }
    return
  }

  imgEl.hidden = true
  hotspots.innerHTML = ''
  $('hotspot-note').hidden = true
  if (status === 'generating') {
    // 有上一版图就留着（用户能继续看清单、对着旧图聊），只在角上说明「正在换」。
    if (sv?.image) {
      imgEl.src = sv.image
      imgEl.hidden = false
      renderStrip('正在更新穿搭图…', { kind: 'cancel', label: '停止等待', onClick: cancelWait })
      return
    }
    renderStageOverlay('generating', '正在生成场景图…', null, '人物 + 当前搭配 + 场景，通常 10–45 秒')
    // 停止等待：只停本地等待，服务商是否已计费无法撤回，文案上不骗人
    overlay.querySelector('.ov-card')?.insertAdjacentHTML(
      'beforeend',
      '<button class="btn ghost small" data-cancel-wait>停止等待</button>',
    )
    overlay.querySelector('[data-cancel-wait]')?.addEventListener('click', cancelWait)
  } else if (status === 'error') {
    renderStageOverlay('error', '上次生成失败了', '重试生成', sv?.lastError ?? undefined)
  } else if (status === 'unconfigured') {
    renderStageOverlay(
      'unconfigured',
      '图像生成服务未配置',
      null,
      `${sv.provider.setup}。配置前可切到「商品图」查看真实商品，或点「切换场景」浏览场景库。`,
    )
  } else {
    renderStageOverlay(
      'missing',
      '这个「方案 + 场景」还没有生成图',
      '生成场景图',
      sv?.provider?.available ? '按当前搭配生成一张人物场景图，通常几十秒' : sv?.provider?.setup,
    )
  }
}

/** 画框按 2:3 等比适配容器：图不被裁、热点与像素对齐 */
function fitStageFrame() {
  const stage = $('stage')
  const frame = $('stage-frame')
  if (!stage || !frame || frame.hidden) return
  const RATIO = 2 / 3
  // 以「栏宽」为唯一基准：舞台高度跟随图片走。
  // 旧实现 Math.min(w, h * RATIO) 是拿被挤扁的剩余高度反推宽度，
  // 结果主图只剩 100~250px 宽、两侧大片留白（这是主图不可用的根因）。
  const avail = stage.clientWidth - 2
  if (!avail || avail < 40) return
  const MAX_W = 820 // 超宽屏上限：再宽就失去人像比例感，超出部分留白居中
  let fw = Math.min(avail, MAX_W)
  let fh = fw / RATIO

  // 高度不超过一屏：目标是「从头顶到鞋」首屏就能看全，且图下的诚信标识与自动开关
  // 也留在首屏（换装入口已搬到右栏，不再占图下空间）。
  const pane = stage.closest('.pane')
  if (pane) {
    const offset = stage.getBoundingClientRect().top - pane.getBoundingClientRect().top
    const room = pane.clientHeight - offset - stageReserve() - 12
    if (room > 340 && fh > room) {
      fh = room
      fw = fh * RATIO
    }
  }
  // 兜底：任何情况下都不把主图压回「不可用」的宽度（宁可让这一栏轻微滚动）
  if (fw < 300) {
    fw = Math.min(300, avail)
    fh = fw / RATIO
  }
  frame.style.width = `${Math.round(fw)}px`
  frame.style.height = `${Math.round(fh)}px`

  // 命中区的小目标放大依赖「真实像素高度」，必须等画框尺寸落定后再算一次。
  // 只改 style 不重建 DOM，否则元素会在点击过程中被替换掉。
  applyHitAreas()
  syncStripBox()
}

/**
 * P10-2：轻量状态条要贴在「图片」上，而不是贴在整栏上。
 * #stage-overlay 是 #stage 的子元素（DOM 契约不动），比图片宽，所以按画框的实际位置对齐。
 */
function syncStripBox() {
  const overlay = $('stage-overlay')
  if (!overlay || overlay.hidden || !overlay.classList.contains('strip')) return
  const stage = $('stage')
  const frame = $('stage-frame')
  if (!stage || !frame || frame.hidden) return
  const sr = stage.getBoundingClientRect()
  const fr = frame.getBoundingClientRect()
  if (!fr.width || !fr.height) return
  overlay.style.left = `${Math.round(fr.left - sr.left)}px`
  overlay.style.top = `${Math.round(fr.top - sr.top)}px`
  overlay.style.width = `${Math.round(fr.width)}px`
  overlay.style.height = `${Math.round(fr.height)}px`
}

/** 图下方必须与图片同时可见的高度（诚信标识 / 自动开关） */
function stageReserve() {
  let h = 0
  for (const id of ['stage-caption', 'stage-foot']) {
    const el = $(id)
    if (!el || el.hidden || !el.offsetHeight) continue
    h += el.offsetHeight + 11
  }
  return h || 40
}

/**
 * P10-2：场景图区的「轻量状态条」。
 *
 * 换件后图过期、正在重画、重画失败——这三种情况以前都会盖一张卡片在图上，
 * 让人以为要先回答「要不要生成」。现在只留图片左上角一条提示：
 * 不压暗画面、不挡热点点击、不要求先做选择；只有一个文字按钮可点。
 */
function renderStrip(text, action) {
  const overlay = $('stage-overlay')
  overlay.hidden = false
  overlay.className = 'stage-overlay strip'
  overlay.innerHTML = `<div class="stale-strip"><span>${esc(text)}</span>${
    action
      ? `<button type="button" class="strip-btn" ${
          action.kind === 'regen' ? 'data-regen' : 'data-cancel-wait'
        }>${esc(action.label)}</button>`
      : ''
  }</div>`
  if (action) overlay.querySelector('button')?.addEventListener('click', action.onClick)
  syncStripBox()
}

function renderStageOverlay(kind, title, actionLabel, note) {
  const overlay = $('stage-overlay')
  overlay.style.left = overlay.style.top = overlay.style.width = overlay.style.height = ''
  overlay.hidden = false
  overlay.className = `stage-overlay ${kind}`
  overlay.innerHTML = `<div class="ov-card ${kind}">
    ${kind === 'generating' ? '<div class="ov-spinner"><i></i><i></i><i></i></div>' : ''}
    <b>${esc(title)}</b>
    ${note ? `<p>${esc(note)}</p>` : ''}
    ${actionLabel ? `<button class="btn primary" data-regen>${esc(actionLabel)}</button>` : ''}
    ${kind === 'unconfigured' ? '<button class="btn ghost" data-to-board>切到商品图</button>' : ''}
  </div>`
  overlay.querySelector('[data-regen]')?.addEventListener('click', regenerateScene)
  overlay.querySelector('[data-to-board]')?.addEventListener('click', () => {
    state.view = 'board'
    $('view-seg').querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('active', x.dataset.v === 'board'))
    renderStage()
  })
}

/**
 * 热点：只把「可信」的区域画成可点按钮。
 * 低置信度的画成虚线提示，pointer-events:none —— 不会因为坐标不准就换错衣服。
 */
/**
 * 小目标（主要是鞋）在真实显示尺寸下可能只有 20~35px 高，手指根本点不中。
 * 按「最小命中高度」把区域向外扩，但只往画面内侧扩、且不横跨到别的槽位。
 * 视觉上框会略大一圈，换来的是真的能点中——这是手机上鞋类能不能换装的关键。
 */
function hitArea(r, frameH) {
  const MIN_PX = 46
  if (!frameH) return r
  const pxH = r.h * frameH
  if (pxH >= MIN_PX) return r
  const need = (MIN_PX - pxH) / frameH
  // 优先向下扩（鞋底下是地面，不会盖到别的衣物），贴到底再向上补
  const down = Math.min(need, Math.max(0, 1 - (r.y + r.h)))
  const up = Math.min(need - down, Math.max(0, r.y))
  return { x: r.x, y: r.y - up, w: r.w, h: r.h + down + up }
}

/**
 * 热点 = 隐形命中区。消费者看到的是干净的穿搭图；
 * 「点人物身上的衣物」仍然可用（这是习惯性的操作），但不再出现框、标签、置信度。
 */
function renderHotspots(regions, hotspots) {
  const p = state.plan
  const box = $('hotspots')
  const worn = p.slots.filter((s) => s.item)
  const slotMeta = hotspots?.slots ?? {}
  const frameH = $('stage-frame')?.clientHeight ?? 0
  // 面积大的先渲染、小的后渲染：DOM 后出现的在上层，于是重叠区点到的是面积小的那件
  // （和后端 pickRegion 的「小目标优先」保持一致；否则点包会命中外套）。
  const ordered = [...worn].sort((a, b) => {
    const ra = regions?.[a.slot]
    const rb = regions?.[b.slot]
    return (rb ? rb.w * rb.h : 0) - (ra ? ra.w * ra.h : 0)
  })
  box.innerHTML = ordered
    .map((s) => {
      const r0 = regions?.[s.slot]
      if (!r0) return ''
      const r = hitArea(r0, frameH)
      const status = slotMeta[s.slot]?.status ?? 'low'
      const selected = state.selected === s.slot ? 'selected' : ''
      const style = `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`
      if (status !== 'ok') {
        // 识别没把握：完全不出现，也不可点 —— 用户用右栏分类换装
        return `<div class="hotspot unsure" data-unsure="${s.slot}" style="${style}" aria-hidden="true"></div>`
      }
      return `<button class="hotspot ${selected}" data-hot="${s.slot}" style="${style}"
        aria-label="选中${esc(s.label)}：${esc(s.item.title)}"></button>`
    })
    .join('')
  // 记下「真实衣物区域」，命中区放大只改 style，不重建 DOM。
  // 重建会让正在进行的点击/悬停丢失目标（Playwright 会报 element is not visible）。
  worn.forEach((s) => {
    const el = box.querySelector(`[data-hot="${s.slot}"],[data-unsure="${s.slot}"]`)
    if (el && regions?.[s.slot]) el.__baseRegion = regions[s.slot]
  })
  applyHitAreas()
  box.querySelectorAll('[data-hot]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      selectSlot(el.dataset.hot)
    }),
  )
}

/** 只调整已有热点的命中区（小目标放大），不碰 DOM 结构。 */
function applyHitAreas() {
  const frameH = $('stage-frame')?.clientHeight ?? 0
  if (!frameH) return
  document.querySelectorAll('#hotspots .hotspot').forEach((el) => {
    const base = el.__baseRegion
    if (!base) return
    const r = hitArea(base, frameH)
    el.style.left = `${r.x * 100}%`
    el.style.top = `${r.y * 100}%`
    el.style.width = `${r.w * 100}%`
    el.style.height = `${r.h * 100}%`
  })
}

/**
 * 右栏顶部的换装入口：五个类目，一眼看到「这件多少钱 / 已有 / 还没加」。
 * 点一下 = 选中该类 + 打开候选抽屉（只读候选，不调图像 API）。
 * 空位显示「添加」，不显示让人猜的「空位」。
 */
function renderSlotChips() {
  const p = state.plan
  if (!p) return
  $('slot-chips').innerHTML = p.slots
    .map((s) => {
      const sel = state.selected === s.slot ? 'selected' : ''
      const empty = !s.item && s.status !== 'owned'
      // 自有（哪怕是「白鞋，款式未知」）不算空位：写「自有」比写「添加」诚实
      const second = empty ? '添加' : s.status === 'owned' ? (s.item ? '已有' : '自有') : money(s.item.price.amount)
      const tip = s.item
        ? `${s.label}：${s.item.title}（点一下看可换的候选）`
        : s.status === 'owned'
          ? `${s.label}：${s.ownedClaim?.label ?? '你自己的单品'}（你自己的东西，不计入支出）`
          : `${s.label}还没有单品，点一下挑一件`
      return `<button class="slot-chip ${sel} ${empty ? 'is-empty' : ''}" data-select="${s.slot}"
        title="${esc(tip)}">
        <b>${esc(s.label)}</b><span>${esc(second)}</span>
      </button>`
    })
    .join('')
  $('slot-chips').querySelectorAll('[data-select]').forEach((el) =>
    el.addEventListener('click', () => openSlot(el.dataset.select)),
  )
}

/**
 * 分类按钮的主交互：选中该类 + 立即给出候选，一步到位。
 * - 只读候选，不调用图像 API、不改方案、不动 revision；真正替换仍要在抽屉里确认。
 * - 已拥有 / 锁定 / 空位没有可换的候选，改为只展示详情并说明原因。
 */
function openSlot(slotId) {
  const p = state.plan
  if (!p) return
  const slot = p.slots.find((s) => s.slot === slotId)
  if (!slot) return
  state.selected = slotId
  renderStage()
  renderSlotChips()
  renderShop()
  renderSelection()
  if (window.innerWidth < 1024) setTab('shop')

  if (slot.status === 'owned') {
    toast('这件是「已有」，不计入支出；不需要购买')
    return
  }
  if (slot.locked) {
    toast('这个位置已锁定，先解锁才能换')
    return
  }
  openSwap(slotId)
}

/* ------------------------------------------------------------ 快捷建议（P4） */

function suggestionsFor(plan) {
  const over = plan.cost.breakdown.verdict === 'over_budget'
  const list = []
  if (over) list.push({ id: 'fit', label: '压回预算', text: `这套超预算 ${money(plan.cost.breakdown.overBy)}，帮我压回预算内` })
  const emptySlot = plan.slots.find((s) => !s.item && s.status === 'empty')
  if (emptySlot) list.push({ id: `add-${emptySlot.slot}`, label: `加一件${emptySlot.label}`, text: `帮我加一件${emptySlot.label}，和现在这套搭得上` })
  list.push({ id: 'scene', label: '换个场景', text: '换个场景看看这套衣服' })
  list.push({ id: 'cheaper', label: '外套换便宜', text: '帮我换一件更便宜的外套，只改外套' })
  return list.slice(0, 3)
}

/**
 * 建议区：最多 3 条，一行装完，每条可单独关闭；关掉后本次会话不再出现。
 * 聊天一开始（有用户消息）就自动收起，只在输入框上方留一个「建议」链接。
 */
function renderSuggestions(forceOpen = false) {
  const p = state.plan
  const qa = $('quick-actions')
  const aa = $('advisor-actions')
  if (!p) {
    qa.innerHTML = ''
    aa.innerHTML = ''
    return
  }
  const all = suggestionsFor(p)
  const alive = all.filter((s) => !state.dismissedSuggestions.has(s.id))
  const started = (state.chat?.messages ?? []).some((m) => m.role === 'user')
  const collapsed = started && !state.suggestPinned && !forceOpen

  // 本来就没有可建议的事：整块不占位，也不要留一个「显示建议」却点不出东西的入口
  if (all.length === 0) {
    qa.innerHTML = ''
    aa.innerHTML = ''
    $('suggest').hidden = true
    return
  }
  $('suggest').hidden = false

  if (collapsed || alive.length === 0) {
    qa.innerHTML = ''
    // 一个恢复入口：收起的和被逐条关掉的，都能从这里再打开
    aa.innerHTML = `<button type="button" class="suggest-toggle" data-suggest-toggle>显示建议</button>`
    aa.querySelector('[data-suggest-toggle]').addEventListener('click', () => {
      state.dismissedSuggestions = new Set()
      saveDismissed()
      state.suggestPinned = true
      renderSuggestions(true)
    })
    return
  }

  aa.innerHTML = ''
  qa.innerHTML = alive
    .map(
      (s) => `<span class="qa-chip">
        <button type="button" class="qa-text" data-qa="${esc(s.id)}">${esc(s.label)}</button>
        <button type="button" class="qa-x" data-dismiss="${esc(s.id)}" aria-label="关闭这条建议">×</button>
      </span>`,
    )
    .join('')
  qa.querySelectorAll('[data-qa]').forEach((b) => {
    const hit = alive.find((s) => s.id === b.dataset.qa)
    b.addEventListener('click', () => hit && send(hit.text))
  })
  qa.querySelectorAll('[data-dismiss]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      state.dismissedSuggestions.add(b.dataset.dismiss)
      saveDismissed()
      renderSuggestions()
    }),
  )
}

/** Mode B 入口：场景不适配时提示，但绝不擅自改商品 */
function renderAdaptation() {
  const p = state.plan
  const sv = p?.sceneView
  const el = $('adaptation')
  if (!sv?.adaptation?.needed) {
    el.hidden = true
    return
  }
  el.hidden = false
  el.innerHTML = `<span>⚠ ${esc(sv.adaptation.hints.join('；'))}</span>
    <button class="btn small" data-ask-adapt>让 AI 建议调整</button>
    <button class="btn small ghost" data-dismiss-adapt>知道了，不用改</button>`
  el.querySelector('[data-ask-adapt]').addEventListener('click', () => {
    send(`当前场景是「${sv.spec.label}」，${sv.adaptation.hints.join('，')}。请先给我 2–3 个调整建议（换哪件、为什么、多少钱），先不要改方案，等我确认。`)
    if (window.innerWidth < 1024) setTab('chat')
  })
  el.querySelector('[data-dismiss-adapt]').addEventListener('click', () => (el.hidden = true))
}

/* ---------------------------------------------------- 生图入口（无二次确认） */

/**
 * P10：删掉「确认生成 / 先不生成」这个弹层。
 *
 * 它问的事，用户刚刚已经用动作回答过了：
 *   · 勾「自动更新穿搭图」= 授权以后换件就出图；
 *   · 点「更新穿搭图」= 明确要求重画这一张；
 *   · 选好场景点应用 = 明确要求看这个场景。
 * 再弹一次只是把同一个问题问第二遍，还挡住刚换好的搭配。
 *
 * 成本保护没被拆掉，也不靠前端：服务端仍有预算闸门（用完返回 402 BUDGET_BLOCKED）、
 * 每小时调用限额、缓存命中不收费、并发合并与防抖。这里只如实显示状态和失败出口。
 */

/** 自动更新开关：它本身就是唯一开关，拨动即生效。 */
async function toggleAuto(enabled) {
  const p = state.plan
  if (!p) return
  try {
    const res = await post(`/api/plans/${encodeURIComponent(p.planId)}/scene/auto`, { enabled })
    const actual = res?.enabled === undefined ? enabled : res.enabled === true
    if (actual !== enabled) {
      // 服务端没接受：把开关拨回去，不装作已经打开
      $('auto-toggle').checked = actual
      $('auto-flag').classList.toggle('on', actual)
      toast('这个开关现在改不了，稍后再试', true)
    } else {
      toast(actual ? '已开启：换件后会自动更新穿搭图' : '已关闭：换件后只更新清单与金额')
    }
    await loadPlan(p.planId, { silent: true })
  } catch (e) {
    $('auto-toggle').checked = !enabled
    $('auto-flag').classList.toggle('on', !enabled)
    toast(e.message, true)
  }
}

function cancelWait() {
  const p = state.plan
  if (!p) return
  post(`/api/plans/${encodeURIComponent(p.planId)}/scene/cancel`)
    .then((r) => {
      toast(r.note ?? '已停止等待')
      clearInterval(state.scenePoll)
      return loadPlan(p.planId, { silent: true })
    })
    .catch((e) => toast(e.message, true))
}

/** 手动更新：点一下就开始，不再确认。失败时旧图仍在，重试就是再点一次。 */
async function regenerateScene() {
  const p = state.plan
  if (!p) return
  try {
    const res = await post(`/api/plans/${encodeURIComponent(p.planId)}/scene/regenerate`, {})
    applySceneResponse(res)
  } catch (e) {
    handleSceneError(e)
  }
}

function applySceneResponse(res) {
  const view = res?.view ?? res
  if (view?.cacheKey) {
    // 连续换装时的乱序保护：这个响应属于某个旧的方案签名时，绝不能把它贴到当前界面上。
    // 只认「键和当前方案一致」的响应，其余一律重读方案（以服务端为准）。
    const cur = state.plan?.sceneView?.cacheKey
    if (cur && view.cacheKey !== cur) {
      loadPlan(state.plan.planId, { silent: true })
      return
    }
    state.plan.sceneView = view
    renderStage()
  }
  if (res?.budget) syncBudget(res.budget)
  if (view?.status === 'generating') {
    toast('正在生成，失败会保留上一版图片')
    startScenePoll()
  } else if (view?.status === 'ready') toast('场景图已更新')
}

function handleSceneError(e) {
  if (e.code === 'BUDGET_BLOCKED') toast('这阵子的生成次数用完了，过一会儿再试', true)
  else if (e.code === 'RATE_LIMITED') toast(e.retryAfter ? `生成太频繁，约 ${e.retryAfter} 秒后再试` : '生成太频繁，稍后再试', true)
  else if (e.code === 'SCENEGEN_UNCONFIGURED') toast('现在还不能生成穿搭图，可以先看商品图', true)
  else toast(e.message, true)
  renderStage()
}

/** 额度状态同步：界面只关心「还能不能生成」，不显示内部数字 */
function syncBudget(budget) {
  if (!budget || !state.plan?.sceneView) return
  state.plan.sceneView.budget = budget
  const out = budget.level === 'blocked'
  $('budget-chip').hidden = !out
  $('budget-chip').textContent = out ? '暂时无法生成新图' : ''
  $('budget-chip').classList.toggle('blocked', out)
  $('budget-chip').title = out ? '生成次数已达上限，稍后再试' : ''
}

/* 热点识别本身仍在服务端运行（换件、点击命中都要用），
   但「重新识别 / 拖框修正 / 可信度」这些是开发者入口，消费者页面不提供。 */

/** 生成中轮询（SSE 是主通道，轮询兜底） */
function startScenePoll() {
  clearInterval(state.scenePoll)
  state.scenePoll = setInterval(async () => {
    if (!state.plan) return clearInterval(state.scenePoll)
    try {
      const vm = await api(`/api/plans/${encodeURIComponent(state.plan.planId)}`)
      const st = vm.sceneView?.status
      if (st !== 'generating') {
        clearInterval(state.scenePoll)
        state.plan = vm
        renderPlan()
        if (st === 'ready') toast('场景图已生成')
        if (st === 'error') toast('生成失败，可点重新生成', true)
      }
    } catch {
      /* ignore */
    }
  }, 2000)
}

/* -------------------------------------------------------------- 场景选择器 */

const PTAB_LABEL = { suggested: '推荐', city: '城市生活', travel: '旅行度假', daily: '日常生活', event: '活动场景', custom: '自定义' }
const TIME_OPTS = [['dawn', '清晨'], ['morning', '上午'], ['afternoon', '下午'], ['dusk', '黄昏'], ['night', '夜晚']]
const SEASON_OPTS = [['spring', '春'], ['summer', '夏'], ['autumn', '秋'], ['winter', '冬']]
const WEATHER_OPTS = [['clear', '晴朗'], ['overcast', '多云'], ['rain', '雨天'], ['snow', '雪天'], ['indoor', '室内']]

async function openScenePicker() {
  const p = state.plan
  if (!p) return
  $('scene-picker').hidden = false
  if (!state.scenes) {
    try {
      const data = await api(`/api/scenes?planId=${encodeURIComponent(p.planId)}`)
      state.scenes = data.scenes
      state.suggestedScenes = data.suggested
    } catch (e) {
      toast('场景库加载失败：' + e.message, true)
      return
    }
  }
  renderPicker()
}

function renderPicker() {
  const tabs = $('picker-tabs')
  tabs.querySelectorAll('[data-ptab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.ptab === state.pickerTab)
    b.onclick = () => {
      state.pickerTab = b.dataset.ptab
      renderPicker()
    }
  })

  const body = $('picker-body')
  const foot = $('picker-foot')
  const q = state.pickerQuery

  if (state.pickerTab === 'custom') {
    body.innerHTML = `
      <div class="picker-custom">
        <textarea id="picker-custom-text" rows="3" placeholder="描述你想要的场景，例如：雨后傍晚的代官山小巷，霓虹刚亮起来"></textarea>
        ${pickerControls()}
      </div>`
    bindPickerControls(body)
    foot.innerHTML = `<button class="btn primary" id="btn-picker-apply">用这个场景</button>`
    $('btn-picker-apply').addEventListener('click', () => {
      const custom = $('picker-custom-text').value.trim()
      if (!custom) return toast('先写一句场景描述', true)
      chooseScene({ custom, time: q.time, season: q.season, weather: q.weather })
    })
    return
  }

  const list = state.pickerTab === 'suggested'
    ? state.suggestedScenes
    : (state.scenes ?? []).filter((s) => s.category === state.pickerTab)
  body.innerHTML = `<div class="picker-grid">
      ${list
        .map(
          (s) => `<button class="scene-card" data-scene="${esc(s.place)}" data-scene-id="${esc(s.sceneId.split('.')[0])}">
            <span class="scene-card-place">${esc(s.label.split(' · ')[0])}</span>
            <span class="scene-card-meta">${esc(PTAB_LABEL[s.category] ?? '')}</span>
          </button>`,
        )
        .join('') || '<p class="muted">这个分类下暂时没有场景</p>'}
    </div>
    <div class="picker-controls">${pickerControls()}</div>`
  bindPickerControls(body)
  body.querySelectorAll('[data-scene-id]').forEach((b) =>
    b.addEventListener('click', () => {
      chooseScene({ place: b.dataset.sceneId, time: q.time, season: q.season, weather: q.weather })
    }),
  )
  foot.innerHTML = `<p class="footnote" style="margin:0">选了地点后，可以用上方的时间 / 季节 / 天气微调氛围；同一个地点在雨夜和晴午是两幅完全不同的画面。</p>`
}

function pickerControls() {
  const q = state.pickerQuery
  const sel = (name, opts) =>
    `<label class="chip-ctl"><span>${name}</span><select data-q="${name}">${opts
      .map(([v, l]) => `<option value="${v}"${q[opts === TIME_OPTS ? 'time' : opts === SEASON_OPTS ? 'season' : 'weather'] === v ? ' selected' : ''}>${l}</option>`)
      .join('')}</select></label>`
  return `<div class="picker-ctl-row">${sel('时间', TIME_OPTS)}${sel('季节', SEASON_OPTS)}${sel('天气', WEATHER_OPTS)}</div>`
}

function bindPickerControls(root) {
  root.querySelectorAll('select[data-q]').forEach((sel) =>
    sel.addEventListener('change', () => {
      const map = { 时间: 'time', 季节: 'season', 天气: 'weather' }
      state.pickerQuery[map[sel.dataset.q]] = sel.value
    }),
  )
}

/** Mode A：只切场景。断言由服务端做；点「应用」就是明确要切，直接开始生成。 */
async function chooseScene(query) {
  const p = state.plan
  if (!p) return
  try {
    const res = await post(`/api/plans/${encodeURIComponent(p.planId)}/scene`, query)
    $('scene-picker').hidden = true
    // 先把场景名与状态刷成最新（商品一个都没动）
    if (res?.view) {
      state.plan = await api(`/api/plans/${encodeURIComponent(p.planId)}`)
      state.plan.sceneView = res.view
      state.view = 'scene'
      $('view-seg').querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('active', x.dataset.v === 'scene'))
      renderPlan()
    }
    if (res?.blocked) {
      // 额度用完：场景名已切，但图不会重画。如实说，不留「正在生成」的假象。
      toast('这阵子的生成次数用完了，场景先按原图显示', true)
      syncBudget(res.budget)
      return
    }
    const view = res?.view ?? res
    if (view?.status === 'ready') toast(`已切到「${view.spec.label}」`)
    else if (view?.status === 'generating') {
      toast(`「${view.spec.label}」正在生成…`)
      startScenePoll()
    } else if (view?.status === 'unconfigured') toast('现在还不能生成场景图，可以先看商品图', true)
    else toast(`已切到「${view?.spec?.label ?? ''}」，场景图待生成`)
    if (res?.budget) syncBudget(res.budget)
  } catch (e) {
    toast(e.message, true)
  }
}

function renderCost() {
  const p = state.plan
  const b = p.cost.breakdown
  const over = b.verdict === 'over_budget'
  $('money-total').innerHTML = `${money(b.knownTotal)}<small>当前可计算总额 · ${
    b.knownTotalStatus === 'confirmed' ? '已确认' : b.knownTotalStatus === 'estimated' ? '含估算' : '含待确认'
  }</small>`

  const pill = $('budget-pill')
  pill.textContent = over ? `超预算 ${money(b.overBy)}` : b.risky ? '预算内 · 含估算' : '预算内'
  pill.className = `pill ${over ? 'over' : b.risky ? 'estimated' : 'confirmed'}`

  const pct = b.budgetLimit > 0 ? Math.min(100, (b.knownTotal / b.budgetLimit) * 100) : 100
  const fill = $('budget-fill')
  fill.style.width = `${pct}%`
  fill.className = `bar-fill ${over ? 'over' : b.risky ? 'warn' : ''}`

  $('budget-line').innerHTML = over
    ? `预算 <b>${money(b.budgetLimit)}</b> · 已超 <b>${money(b.overBy)}</b>（不含未确认费用）`
    : `预算 <b>${money(b.budgetLimit)}</b> · 还剩 <b>${money(b.remaining)}</b>`

  $('fit-cta').hidden = !over

  const rows = [
    ['商品小计', money(b.itemSubtotal), statusText(b.itemStatus), ''],
    [
      b.shippingUnknownCount > 0 ? '已知运费（部分待确认）' : '运费',
      b.shippingKnown > 0 ? money(b.shippingKnown) : '—',
      statusText(b.shippingStatus),
      '',
    ],
    ['已确认的其他费用', money(b.otherConfirmed), '已确认', ''],
  ]
  const unknownRows = b.unknownFees.map((f) => [f.label, '未计入', '待确认', 'unknown'])
  $('cost-lines').innerHTML = [...rows, ...unknownRows]
    .map(
      ([label, amount, status, cls]) =>
        `<li class="${cls}"><span>${esc(label)}<span class="st">${esc(status)}</span></span><span class="amt">${esc(
          amount,
        )}</span></li>`,
    )
    .join('')

  $('cost-note').textContent =
    '总额只包含商品价与已知运费。关税/进口税与待确认运费没有计入，也不是 0 —— 最终到手价必须看商家结账页。'
}

function renderArrival() {
  const p = state.plan
  const a = p.arrival
  const pill = $('arrival-pill')
  pill.textContent = a.label
  pill.className = `pill ${a.verdict === 'on_time' ? 'confirmed' : a.verdict === 'unknown' ? '' : 'estimated'}`
  $('arrival-main').textContent =
    a.verdict === 'unknown' ? '无法确认' : a.latest ? `${a.earliest ?? '?'} → ${a.latest}` : '—'
  $('arrival-sub').innerHTML =
    a.verdict === 'unknown'
      ? '有单品缺少运费/时效信息，不能判断能否按时送达'
      : `目标 ${a.deadline}${a.blocking?.length ? ` · 影响：${a.blocking.join('、')}` : ''}`
  $('arrival-sub').insertAdjacentHTML(
    'beforeend',
    `<br><span class="muted">可信度：店铺级时效估算（estimated），不是商家承诺；下单后以物流为准。</span>`,
  )
  // 偏好相关提示复用「到货与风险」列表：不新增面板，也不改既有 id
  const RULE_LABEL = {
    brand_avoid: '避开品牌',
    avoid: '避开词',
    size_top: '上装尺码',
    size_bottom: '裤装尺码',
    size_shoes: '鞋码',
  }
  const prefRisks = [
    ...(p.prefExceptions ?? []).map((e) => ({
      level: 'mid',
      text: `本方案破例：${RULE_LABEL[e.rule] ?? e.rule} —— 依据你的原话「${e.quote}」。只对这套方案生效，长期偏好没有被放宽。`,
    })),
    ...(p.prefConflicts ?? []).map((c) => ({
      level: 'high',
      text: `${c.title} 与你的偏好冲突（${(c.reasons ?? []).join('；')}）—— 偏好是在这套方案创建之后改的，换掉它或调整偏好都可以。`,
    })),
  ]
  $('risks').innerHTML = [...p.risks, ...prefRisks].map((r) => `<li class="${r.level}">${esc(r.text)}</li>`).join('')
}

function buyMarkup(line) {
  const b = line.buy
  if (b.state === 'buyable') {
    return `<a class="buy-link" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer" title="${esc(
      b.note,
    )}">前往 ${esc(b.store)} →</a>`
  }
  // 不可购买就明说，但不摆一段开发式解释（原因放进 title，需要的人能看到）
  const label = b.state === 'owned' ? '已有' : '无购买页'
  return `<span class="shop-buy off" title="${esc(b.note)}">${label}</span>`
}

/**
 * 「查看购买渠道」：逐条列出真实商家页面。
 * 没有购物车、没有代下单、没有支付 —— 每一行只是商品数据里带的 url。
 */
function openChannels() {
  const p = state.plan
  if (!p) return
  const rows = p.purchases.lines.map((line) => {
    const kind = line.buy?.state ?? 'no_link'
    return `<li>
      <div class="what">
        <b>${esc(line.title)}</b>
        <span>${esc(line.vendor)} · ${esc(line.slotLabel)} · ${money(line.price)}${
          line.shippingFee == null ? ' + 运费待确认' : ` + 运费 ${money(line.shippingFee)}`
        }</span>
      </div>
      ${
        kind === 'buyable' && line.buy?.url
          ? `<a class="buy-link" href="${esc(line.buy.url)}" target="_blank" rel="noopener noreferrer">前往 ${esc(
              line.buy.store,
            )} →</a>`
          : `<span class="shop-buy off">${kind === 'no_link' ? '无购买页' : '链接待核实'}</span>`
      }
    </li>`
  })
  const ownedRows = p.slots
    .filter((s) => s.status === 'owned' && s.item)
    .map(
      (s) => `<li>
        <div class="what"><b>${esc(s.item.title)}</b><span>${esc(s.label)} · 已有</span></div>
        <span class="shop-buy off">无需购买</span>
      </li>`,
    )
  $('channel-list').innerHTML =
    [...rows, ...ownedRows].join('') || '<li><div class="what"><b>清单里还没有可购买的商品</b></div></li>'
  $('channel-list')
    .querySelectorAll('a.buy-link')
    .forEach((a) =>
      a.addEventListener('click', () => toast('已在新标签页打开商家页面：结账以商家页面为准')),
    )
  $('channels').hidden = false
}

function renderShop() {
  const p = state.plan
  // P9：没有商品快照的「自有」也要列出来（用户说「我有白鞋」，清单里不能当它不存在）
  const owned = p.slots.filter((s) => s.status === 'owned')
  const lines = p.purchases.lines
  const el = $('shop-list')

  if (lines.length === 0 && owned.length === 0) {
    el.innerHTML = '<p class="muted">清单还是空的：告诉 AI 你想买什么，或在右上方点类目挑一件。</p>'
    $('shop-note').textContent = ''
    return
  }

  // 精简：图 / 品牌 · 类目 / 名称 / 到手价 / 购买入口。
  // 尺码、运费时效、数据来源放进「费用明细」「到货与风险」两个折叠区。
  const itemRow = (line) => {
    const sel = state.selected === line.slot ? 'selected' : ''
    const src = p.slots.find((s) => s.slot === line.slot)?.item
    return `<div class="shop-item ${src?.sourceKind === 'live' ? 'live' : ''} ${sel}">
      <div class="shop-thumb" data-select="${line.slot}">${img(src?.image.cutout, line.title)}</div>
      <div class="shop-body">
        <div class="shop-meta">
          <span>${esc(line.vendor)}</span>
          <span>${esc(line.slotLabel)}</span>
        </div>
        <div class="shop-title" data-select="${line.slot}">${esc(line.title)}</div>
        <div class="shop-line">
          <span class="shop-price">${money(line.price)}${
            line.shippingFee == null ? '<span class="muted"> + 运费待确认</span>' : `<span class="muted"> + 运费 ${money(line.shippingFee)}</span>`
          }</span>
          <span class="shop-buy">${buyMarkup(line)}</span>
        </div>
      </div>
    </div>`
  }

  if (state.shopView === 'store') {
    const groups = p.purchases.groups
    el.innerHTML = groups
      .map(
        (g) => `<div class="store-group">
          <div class="store-head"><b>${esc(g.vendor)}</b><span>${g.lines.length} 件 · 商品 $${g.subtotal}</span></div>
          <div class="store-items">${g.lines.map(itemRow).join('')}</div>
        </div>`,
      )
      .join('')
  } else {
    el.innerHTML = lines.map(itemRow).join('')
  }

  if (owned.length) {
    el.insertAdjacentHTML(
      'beforeend',
      `<div class="store-head">
        <b>已有</b><span>${owned.length} 件 · 不计入支出</span>
      </div>
      ${owned
        .map((s) => {
          // 来源必须可辨：用户自己说过 / 示例方案假设 / 早期数据。不把示例当成用户的衣橱。
          const quote = s.ownedClaim?.quote ?? ''
          const sample = /^示例/.test(quote)
          const tag = sample ? '示例假设' : quote ? '你说过已有' : '历史数据'
          // 没有商品快照的自有单品：只有用户的一句描述，如实显示成「自有」，
          // 不给商品名、不给图、不给价格 —— 我们确实不知道具体是哪一款。
          if (!s.item) {
            return `<div class="shop-item owned-abstract">
              <div class="shop-thumb placeholder" data-select="${s.slot}">自有</div>
              <div class="shop-body">
                <div class="shop-meta"><span>${esc(s.label)}</span><span>${esc(tag)}</span></div>
                <div class="shop-title">${esc(s.ownedClaim?.label ?? '你自己的单品')}</div>
                <div class="shop-line"><span class="shop-price">不计入</span><span class="shop-buy off" title="${esc(
                  quote || '这件被标记为已有，但系统里没有你当时的原话',
                )}">自有</span></div>
              </div>
            </div>`
          }
          return `<div class="shop-item">
            <div class="shop-thumb" data-select="${s.slot}">${img(s.item.image.cutout, s.item.title)}</div>
            <div class="shop-body">
              <div class="shop-meta"><span>${esc(s.label)}</span><span>${esc(tag)}</span></div>
              <div class="shop-title" data-select="${s.slot}">${esc(s.item.title)}</div>
              <div class="shop-line"><span class="shop-price">不计入</span><span class="shop-buy off" title="${esc(
                quote || '这件被标记为已有，但系统里没有你当时的原话',
              )}">已有</span></div>
            </div>
          </div>`
        })
        .join('')}`,
    )
  }

  el.querySelectorAll('[data-select]').forEach((n) => n.addEventListener('click', () => selectSlot(n.dataset.select)))
  el.querySelectorAll('a.buy-link').forEach((a) =>
    a.addEventListener('click', () => toast('已在新标签页打开商家页面：结账以商家页面为准')),
  )
  $('shop-note').textContent = `打开商家页面不等于完成购买；颜色、尺码、运费与关税以结账页为准${
    p.purchases.missingLinkCount ? `（${p.purchases.missingLinkCount} 件暂无可核实的购买页，已如实标注）` : ''
  }。`
}

function renderSelection() {
  const p = state.plan
  const slot = p?.slots.find((s) => s.slot === state.selected)
  const box = $('selection')
  if (!slot?.item) {
    box.hidden = true
    return
  }
  const it = slot.item
  const owned = slot.status === 'owned'
  box.hidden = false
  box.dataset.slot = slot.slot
  box.innerHTML = `
    <div class="selection-media" data-zoom>${img(it.image.main, it.title)}</div>
    <div class="selection-body">
      <h3 class="selection-title">${esc(it.title)}</h3>
      <div class="selection-meta">${esc(slot.label)} · ${esc(it.vendor)}${it.color ? ` · ${esc(it.color)}` : ''}</div>
      <div class="selection-meta">${owned ? '已有，不计入支出' : `${money(it.price.amount)}（${esc(statusText(it.price.status))}）· ${
        it.shipping.fee == null ? '运费待确认' : `运费 ${money(it.shipping.fee)}（估算）`
      }`}</div>
      <div class="selection-meta">${
        it.sizes.length ? `尺码 ${esc(it.sizes.slice(0, 6).join('/'))}` : '尺码待确认'
      } · 关税待确认</div>
    </div>
    <div class="selection-actions">
      ${owned ? '' : `<button class="btn small primary" data-act="swap">换一件</button>`}
      ${
        it.buy?.state === 'buyable'
          ? `<a class="buy-link" href="${esc(it.buy.url)}" target="_blank" rel="noopener noreferrer">前往 ${esc(
              it.buy.store,
            )} 购买</a>`
          : `<span class="muted">${esc(it.buy?.note ?? '没有可核实的购买链接')}</span>`
      }
      <button class="btn small ghost" data-act="zoom">看大图</button>
      <button class="btn small ghost" data-act="close">关闭</button>
    </div>`
  box.querySelector('[data-act="swap"]')?.addEventListener('click', () => openSwap(slot.slot))
  box.querySelector('[data-act="close"]').addEventListener('click', () => {
    state.selected = null
    renderSelection()
    renderStage()
    renderSlotChips()
  })
  box.querySelector('[data-act="zoom"]').addEventListener('click', () => openLightbox(it.image.main, it.title))
  box.querySelector('[data-zoom]').addEventListener('click', () => openLightbox(it.image.main, it.title))
}

function openLightbox(src, alt) {
  $('lightbox-img').src = src
  $('lightbox-img').alt = alt ?? ''
  $('lightbox').hidden = false
}

function renderSaveLine() {
  const p = state.plan
  $('save-state').textContent = `已自动保存 · ${shortTime(p.updatedAt)}`
}

/* ------------------------------------------------------------------ plan ops */

async function toggleLock(slot, locked) {
  try {
    state.ignorePlanEventsUntil = Date.now() + 1200
    const vm = await post(`/api/plans/${encodeURIComponent(state.plan.planId)}/lock`, { slot, locked: !locked, by: 'ui' })
    state.plan = vm
    renderPlan()
    toast(locked ? '已解锁' : '已锁定：之后的推荐和调整都不会动它')
  } catch (e) {
    toast(e.message, true)
  }
}

async function applyConstraints() {
  const p = state.plan
  if (!p) return
  const body = {
    budgetLimit: Number($('budget-input').value),
    arrivalBy: $('arrival-input').value,
    shipTo: $('ship-input').value,
  }
  if (!Number.isFinite(body.budgetLimit) || body.budgetLimit < 0) return toast('预算必须是不小于 0 的数字', true)
  try {
    state.ignorePlanEventsUntil = Date.now() + 1200
    const vm = await post(`/api/plans/${encodeURIComponent(p.planId)}/constraints`, body)
    state.plan = vm
    renderPlan()
    // 改完就收起，别让设置面板一直占着人物图上方的位置
    $('constraint-bar').hidden = true
    $('btn-edit-plan').setAttribute('aria-expanded', 'false')
    toast('已更新预算 / 收货要求，金额与到货已按新约束重算')
  } catch (e) {
    toast(e.message, true)
  }
}

async function fitBudget() {
  const p = state.plan
  if (!p) return
  const btn = $('btn-fit')
  btn.disabled = true
  try {
    state.ignorePlanEventsUntil = Date.now() + 1600
    const vm = await post(`/api/plans/${encodeURIComponent(p.planId)}/fit-budget`)
    state.plan = vm
    renderPlan()
    if (vm.fit?.ok) toast(vm.fit.changes.length ? `已调整：${vm.fit.changes.map((c) => c.slotLabel).join('、')} → 预算内` : '已经在预算内')
    else toast(vm.fit?.reason || '换不到预算内，请调高预算或移除一件', true)
  } catch (e) {
    toast(e.message, true)
  } finally {
    btn.disabled = false
  }
}

async function duplicatePlan() {
  if (!state.plan) return
  try {
    const vm = await post(`/api/plans/${encodeURIComponent(state.plan.planId)}/duplicate`)
    await refreshPlans()
    state.suggestPinned = false
    await loadPlan(vm.planId)
    toast(`已另存为 ${vm.planId}，可以在这份上继续改`)
  } catch (e) {
    toast(e.message, true)
  }
}

/* ------------------------------------------------------------------ swap */

/**
 * 分享：复制当前方案的链接。
 *
 * 为什么放在顶栏而不是聊天里：链接是「页面能力」，不该由模型在回复里贴出来。
 * 演示环境若带访问口令（?t=…），一并带上，否则对方打开会 401。
 */
async function sharePlan() {
  const p = state.plan
  if (!p) return
  const url = new URL(location.origin + '/')
  url.searchParams.set('plan', p.planId)
  const t = new URLSearchParams(location.search).get('t')
  if (t) url.searchParams.set('t', t)
  const link = url.toString()
  try {
    await navigator.clipboard.writeText(link)
    toast('方案链接已复制，可以发给朋友了')
  } catch {
    toast(`方案链接：${link}`)
  }
}

async function openSwap(slotId) {
  if (!state.plan) return
  const slot = state.plan.slots.find((s) => s.slot === slotId)
  if (!slot) return
  state.slot = slotId
  state.pick = null
  state.strategy = 'similar'
  state.sort = 'recommended'
  $('sort-select').value = 'recommended'
  $('swap').hidden = false
  $('swap-title').textContent = slot.item ? `换一件：${slot.label}` : `挑一件：${slot.label}`
  $('swap-sub').textContent = slot.item
    ? `当前：${slot.item.title} · ${money(slot.item.price.amount)} · ${slot.item.vendor}`
    : '从可购买的商品里挑一件'
  $('strategies').innerHTML = STRATEGIES.map(
    ([id, label]) => `<button class="strategy ${id === state.strategy ? 'active' : ''}" data-strategy="${id}">${label}</button>`,
  ).join('')
  $('strategies').querySelectorAll('[data-strategy]').forEach((b) =>
    b.addEventListener('click', () => {
      state.strategy = b.dataset.strategy
      state.pick = null
      $('strategies').querySelectorAll('[data-strategy]').forEach((x) => x.classList.toggle('active', x === b))
      loadCandidates()
    }),
  )
  await loadCandidates()
}

async function loadCandidates() {
  const q = new URLSearchParams({ slot: state.slot, strategy: state.strategy, includeUnconfirmed: '1', sort: state.sort })
  $('candidates').innerHTML = '<p class="swap-empty">正在找候选…</p>'
  try {
    const data = await api(`/api/plans/${encodeURIComponent(state.plan.planId)}/candidates?${q}`)
    state.candidates = data.candidates
    state.candidatesExcluded = data.excluded ?? []
    state.candidatesApplied = data.applied ?? []
    state.candidatesUnmapped = data.unmapped ?? []
    state.candidatesRelaxed = data.relaxed ?? []
    state.candidatesBlocked = data.blockedBy ?? []
    renderCandidates()
  } catch (e) {
    $('candidates').innerHTML = `<p class="swap-empty">候选加载失败：${esc(e.message)}</p>`
  }
}

function renderCandidates() {
  const list = state.candidates
  const excluded = state.candidatesExcluded ?? []
  const applied = state.candidatesApplied ?? []
  const unmapped = state.candidatesUnmapped ?? []
  const relaxed = state.candidatesRelaxed ?? []
  const blocked = state.candidatesBlocked ?? []
  const prefHead = applied.length || excluded.length || relaxed.length
    ? `<div class="cand-prefnote">${
        applied.length ? `偏好参与排序：${esc(applied.join('；'))}` : ''
      }${
        excluded.length
          ? `<span class="cand-prefnote-line">已排除 ${excluded.length} 件：${esc(
              excluded.slice(0, 3).map((e) => e.title).join('、'),
            )}${excluded.length > 3 ? ' 等' : ''}</span>`
          : ''
      }${relaxed.length ? `<span class="cand-prefnote-line muted">${esc(relaxed.join('；'))}</span>` : ''}</div>`
    : ''
  const unmappedNote = unmapped.length
    ? `<div class="cand-prefnote"><span class="cand-prefnote-line muted">这些偏好还无法自动匹配商品：${esc(
        unmapped.map((u) => u.value).join('、'),
      )}</span></div>`
    : ''

  if (list.length === 0) {
    $('candidates').innerHTML = `${prefHead}${unmappedNote}<p class="swap-empty">${
      blocked.length
        ? `${esc(blocked[0])}。明确排除不会自动放宽 —— 请到首页改掉这条偏好，或手动指定一件。`
        : excluded.length
          ? `按你的偏好排除后没有可选商品（排除 ${excluded.length} 件）—— 可以在首页改掉这条偏好，或换个策略再试。`
          : '没有符合条件的替代商品 —— 原方案保持不变。换个策略、放宽预算或先解除锁定再试。'
    }</p>`
    renderSwapFoot()
    return
  }
  $('candidates').innerHTML = prefHead + unmappedNote + list
    .slice(0, 20)
    .map((c) => {
      const delta = c.priceDelta ?? 0
      const deltaText = delta === 0 ? '' : `${delta < 0 ? '−' : '+'}${money(Math.abs(delta))}`
      const eta = c.etaDays ? `${c.etaDays[0]}–${c.etaDays[1]} 天到（估算）` : '到货待确认'
      const picked = state.pick === c.productId ? 'style="border-color:var(--primary);box-shadow:0 0 0 2px rgba(47,74,63,.16)"' : ''
      // 用 div 而不是 button：Chromium 里 button 作为列向 flex 容器时，
      // 内部 padding-top 撑高的图片盒不计入按钮自身高度（候选会只剩文字）。
      return `<div class="cand ${c.sourceKind === 'live' ? 'live' : ''}" data-pick="${esc(c.productId)}"
        role="button" tabindex="0" aria-label="${esc(c.title)}" ${picked}>
        <div class="cand-media">${img(c.image, c.title)}</div>
        <div class="cand-body">
          <div class="cand-title">${esc(c.title)}</div>
          <div class="cand-price">${money(c.lineTotal)}<span class="delta ${delta < 0 ? 'down' : 'up'}">${deltaText}</span></div>
          <div class="cand-meta">${esc(c.vendor)} · ${esc(eta)}</div>
          ${c.withinBudget ? '' : `<div class="cand-flag over">超预算 ${money(c.overBy)}</div>`}
          <div class="cand-flag ${c.buy?.state === 'buyable' ? '' : 'nolink'}">${
            c.buy?.state === 'buyable' ? '有真实购买入口' : '无可核实链接'
          }</div>
          ${c.whys?.length ? `<div class="cand-meta">${esc(c.whys.slice(0, 2).join(' · '))}</div>` : ''}
          ${
            c.prefBonus
              ? `<div class="cand-flag pref">${esc(
                  c.prefWhys?.[0] ?? `偏好加分 +${Number(c.prefBonus).toFixed(2)}`,
                )}</div>`
              : ''
          }
        </div>
      </div>`
    })
    .join('')

  $('candidates').querySelectorAll('[data-pick]').forEach((b) =>
    b.addEventListener('click', () => {
      state.pick = state.pick === b.dataset.pick ? null : b.dataset.pick
      renderCandidates()
    }),
  )
  renderSwapFoot()
}

function renderSwapFoot() {
  const p = state.plan
  const slot = p.slots.find((s) => s.slot === state.slot)
  if (!slot) return
  if (!state.pick) {
    $('swap-foot').innerHTML = `<p class="footnote" style="border:0;padding:0;margin:0">点一件候选选中，再确认替换 —— 只改「${esc(
      slot.label,
    )}」这一个搭配位，其他单品、锁定位和 revision 之外的记录都不动。价格为到手价（商品 + 估算运费）。</p>`
    return
  }
  const c = state.candidates.find((x) => x.productId === state.pick)
  $('swap-foot').innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <span style="font-size:12.5px">确认把「${esc(slot.label)}」换成 <b>${esc(c?.title ?? '')}</b>（${money(
      c?.lineTotal ?? 0,
    )}）？</span>
    <button class="btn small primary" id="btn-confirm-swap" style="margin-left:auto">确认替换</button>
    <button class="btn small ghost" id="btn-cancel-pick">取消</button>
  </div>`
  $('btn-confirm-swap').addEventListener('click', () => doSwap(state.pick))
  $('btn-cancel-pick').addEventListener('click', () => {
    state.pick = null
    renderCandidates()
  })
}

async function doSwap(productId) {
  if (state.busy || !state.plan) return
  state.busy = true
  $('btn-confirm-swap').disabled = true
  try {
    state.ignorePlanEventsUntil = Date.now() + 1500
    const vm = await post(`/api/plans/${encodeURIComponent(state.plan.planId)}/swap`, {
      slot: state.slot,
      productId,
      by: 'ui',
    })
    const label = vm.slots.find((s) => s.slot === state.slot)?.label
    state.plan = vm
    state.pick = null
    renderPlan()
    await refreshPlans()
    closeSwap()
    // 自动更新开着就不问第二遍：换完直接进入「正在更新」，由服务端合并、出图后推回来
    const autoOn = vm.sceneView?.auto?.enabled === true
    toast(autoOn ? `已换「${label}」，正在更新穿搭图…` : `已换「${label}」这一件，其他位置未改动`)
    if (autoOn) startScenePoll()
  } catch (e) {
    toast(e.message + (e.hint ? `（${e.hint}）` : ''), true)
    $('btn-confirm-swap').disabled = false
  } finally {
    state.busy = false
  }
}

function closeSwap() {
  $('swap').hidden = true
  state.slot = null
  state.pick = null
  state.candidates = []
}

/* ------------------------------------------------------------------ chat */

async function loadChat() {
  state.chat = await api('/api/chat')
  renderChat()
}

/**
 * 展示层兜底：把「方案链接 / 内部编号」从回复里去掉。
 *
 * 源头已经改了两处（插件不再把页面地址写进工具结果、上下文也禁止贴链接），
 * 但模型仍可能自己拼一个出来 —— 界面上多一条 http://…/?plan=pln_006 就足够让人
 * 觉得这是个开发工作台。这里只处理**展示**，不动历史记录，也不影响页面自己的导航与分享。
 */
function cleanReply(text) {  let s = String(text ?? '')
  // markdown 链接形式：[方案：打开查看](http://…/?plan=pln_006)
  // 链接文字本身就是「方案 / 打开 / 查看」这类指路词的，整段删掉（用户已经在这个页面上了，
  // 再给一个「打开查看」只会像内部调试链接）；正文里的自然链接只保留文字。
  s = s.replace(/\[([^\]]*)\]\(\s*https?:\/\/[^\s)]*[?&]plan=[^\s)]*\)/g, (m, label) =>
    /方案|打开|查看|点这里|链接/i.test(label) ? '' : label,
  )
  // 裸链接：http://…/?plan=pln_006（含只有域名+plan 参数的情况）
  s = s.replace(/https?:\/\/[^\s)]*[?&]plan=[^\s)]*/g, '')
  // 「方案链接：」这类残留标签
  s = s.replace(/^\s*(方案链接|方案地址|查看方案|页面链接)\s*[：:]\s*$/gm, '')
  s = s.replace(/(方案链接|方案地址|页面链接)\s*[：:]\s*/g, '')
  // 链接被上面删掉后只剩一个「方案：」标签的行（历史消息里就是这样）——没有内容就一起清掉
  s = s.replace(/^\s*方案\s*[：:]\s*$/gm, '')
  s = s.replace(/[；;，,、]?\s*方案\s*[：:]\s*$/, '')
  // 内部 plan id 不出现在聊天里（页面自己的状态栏显示方案名就够了）
  s = s.replace(/\bpln_\d{3,}\b/g, '').replace(/[ \t]{2,}/g, ' ')
  // 清掉因上面替换而变空的行与多余空行
  s = s.replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
  return s
}

// 验收脚本要能直接验证这段清洗逻辑（不靠「界面上没有」这种间接证据）
window.__ccCleanReply = cleanReply

function renderChat() {
  const snap = state.chat
  if (!snap) return
  const sig = JSON.stringify({ m: snap.messages, r: snap.running, p: snap.phase, e: snap.error })
  if (sig === state.chatSig) {
    syncComposer()
    return
  }
  state.chatSig = sig

  const box = $('messages')
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120
  const msgs = snap.messages ?? []

  if (msgs.length === 0) {
    box.innerHTML = `<div class="chat-empty">
      <b>说一句就开工。</b><br>
      例如：「我要去东京玩三天，预算 200 美元，帮我搭一套」<br>
      中间会出穿搭图，右边是可直接下单的商品与真实到手价。
    </div>`
  } else {
    const lastIdx = msgs.length - 1
    box.innerHTML = msgs
      .map((m, i) => {
        if (m.role === 'user') {
          return `<div class="msg msg-user"><div class="bubble">${md(m.text)}</div></div>`
        }
        if (m.role === 'system') {
          return `<div class="msg msg-system"><div class="bubble">${esc(m.text)}</div></div>`
        }
        // 工具名是内部实现，只在「这一轮还在跑」时作为进度提示；跑完就不在历史里留噪音
        const tools =
          snap.running && i === lastIdx
            ? dedupeTools(m.tools ?? [])
                .map(
                  (t) =>
                    `<span class="tool-pill ${t.ok === false ? 'bad' : t.ok === null ? 'running' : ''}">${esc(t.label)}${
                      t.count > 1 ? ` ×${t.count}` : ''
                    } ${t.ok === false ? '✕' : t.ok === null ? '…' : '✓'}</span>`,
                )
                .join('')
            : ''
        const canRetry = i === lastIdx && !state.chat.running
        return `<div class="msg msg-assistant">
          ${tools ? `<div class="tool-row">${tools}</div>` : ''}
          ${m.text ? `<div class="bubble">${md(cleanReply(m.text))}</div>` : ''}
          ${m.error ? `<div class="bubble" style="background:#fbe9e2;border-color:#f0cbbd;color:#8d3b1c;font-size:12.5px">${esc(
            m.error,
          )}</div>` : ''}
          ${canRetry ? '<div class="msg-actions"><button class="btn link" data-retry title="把上一句再发一次，会新增一轮回答">重新提问</button></div>' : ''}
        </div>`
      })
      .join('')
    box.querySelectorAll('[data-retry]').forEach((b) =>
      b.addEventListener('click', () => {
        const lastUser = [...state.chat.messages].reverse().find((m) => m.role === 'user')
        if (lastUser) send(lastUser.text)
      }),
    )
  }

  if (snap.running) {
    box.insertAdjacentHTML(
      'beforeend',
      `<div class="msg msg-assistant" id="typing"><div class="bubble" style="padding:8px 12px"><span class="typing"><i></i><i></i><i></i></span> <span class="muted">${
        snap.phase === 'tools' ? '正在调用工具…' : snap.phase === 'writing' ? '正在写…' : '思考中…'
      }</span></div></div>`,
    )
  }

  $('chat-error').hidden = !snap.error
  if (snap.error) $('chat-error').textContent = snap.error

  if (nearBottom) {
    state.chatStick = true
    syncComposer()
    renderSuggestions()
    pinChatBottom(box)
    return
  }
  state.chatStick = false
  syncComposer()
  // 用户开始聊天后，建议默认收起，把空间还给对话记录
  renderSuggestions()
}

/**
 * 聊天区贴底。
 *
 * 两个真踩过的坑：
 *  1) `.messages` 有 scroll-behavior:smooth，直接赋 scrollTop 会「设了目标停在半路」
 *     （实测 1440 差 45px），所以程序化贴底一律瞬时；
 *  2) 贴底之后内容还会再长高（字体、建议栏、重试按钮），没人继续贴就会把最后一句的结尾裁掉。
 *     用 ResizeObserver 盯住最后一条消息，用户没往上滚就一直贴着。
 */
function pinChatBottom(box = $('messages')) {
  const jump = () => {
    const prev = box.style.scrollBehavior
    box.style.scrollBehavior = 'auto'
    box.scrollTop = box.scrollHeight
    box.style.scrollBehavior = prev
  }
  jump()
  requestAnimationFrame(() => {
    jump()
    requestAnimationFrame(jump)
  })
  if (!('ResizeObserver' in window)) return
  if (state.chatPinObs) state.chatPinObs.disconnect()
  state.chatPinObs = new ResizeObserver(() => {
    if (state.chatStick === false) return
    jump()
  })
  // 两个方向都要盯：最后一条长高（字体/按钮）、或者容器自己变矮（建议栏收放、视口变化）
  state.chatPinObs.observe(box)
  if (box.lastElementChild) state.chatPinObs.observe(box.lastElementChild)
}

function syncComposer() {
  const running = !!state.chat?.running
  $('btn-send').hidden = running
  $('btn-stop').hidden = !running
  $('chat-state').textContent = running ? '回复中…' : state.chat?.ready ? '就绪' : '待启动'
  $('chat-state').classList.toggle('busy', running)
  $('composer-hint').textContent = running ? 'AI 正在回复，可随时停止' : 'Enter 发送 · Shift+Enter 换行'
}

async function send(textOverride) {
  const input = $('chat-input')
  const text = (typeof textOverride === 'string' ? textOverride : input.value).trim()
  if (!text) return
  if (state.chat?.running) return toast('AI 还在回复，先等它说完或点停止', true)
  if (typeof textOverride !== 'string') input.value = ''
  $('chat-error').hidden = true
  try {
    const snap = await post('/api/chat', { text, planId: state.plan?.planId ?? null })
    state.chat = snap
    renderChat()
    startChatPoll()
  } catch (e) {
    toast(e.message, true)
    $('chat-error').hidden = false
    $('chat-error').textContent = e.message
    if (typeof textOverride !== 'string') input.value = text
  }
}

async function stopChat() {
  try {
    state.chat = await post('/api/chat/stop')
    renderChat()
  } catch (e) {
    toast(e.message, true)
  }
}

async function resetChat() {
  try {
    state.chat = await post('/api/chat/reset')
    state.chatSig = ''
    renderChat()
    toast('已开始新对话（方案状态不变）')
  } catch (e) {
    toast(e.message, true)
  }
}

/** SSE 之外的兜底轮询：只在 AI 回复期间开启，避免漏事件导致界面卡在「回复中」 */
function startChatPoll() {
  clearInterval(state.pollTimer)
  state.pollTimer = setInterval(async () => {
    try {
      const snap = await api('/api/chat')
      state.chat = snap
      renderChat()
      if (!snap.running) {
        clearInterval(state.pollTimer)
        state.pollTimer = null
      }
    } catch {
      /* ignore */
    }
  }, 1600)
}

/* ------------------------------------------------------------------ sse */

function connectSSE() {
  const es = new EventSource('/api/events')
  es.addEventListener('hello', () => setSync(true))
  es.onopen = () => setSync(true)
  es.onerror = () => setSync(false)

  es.addEventListener('chat', (e) => {
    state.chat = JSON.parse(e.data)
    renderChat()
    if (state.chat.running) startChatPoll()
  })

  es.addEventListener('plan.updated', async (e) => {
    const data = JSON.parse(e.data)
    if (Date.now() < state.ignorePlanEventsUntil) return
    if (data.planId === state.plan?.planId) {
      await loadPlan(data.planId, { silent: true })
      // 只有「真的改了方案」且不是本页自己操作时才提示。
      // 切场景 / 开关自动更新也会广播 plan.updated，但它们没有 diff，
      // 以前会弹出一句「AI 更新了方案：」把刚发生的事盖掉（还冒充成 AI 干的）。
      if (data.by !== 'ui' && data.diff) toast(`AI 更新了方案：${data.diff}`)
    }
    refreshPlans()
  })

  es.addEventListener('plan.created', async (e) => {
    const data = JSON.parse(e.data)
    await refreshPlans()
    // 只在「当前还没打开任何方案」时自动进入新方案。
    // 别的窗口 / 后台任务 / 验收脚本建副本时，绝不能把用户正在看的方案顶掉——
    // 真实踩到过：页面 URL 被悄悄改成另一个 planId，用户点「切换场景」看起来毫无反应。
    if (data.planId && !state.plan) {
      await loadPlan(data.planId)
      toast(`新方案已就绪：${data.planId}`)
    }
  })

  es.addEventListener('catalog.updated', () => toast('商品目录已更新'))

  es.addEventListener('scene.updated', async (e) => {
    const data = JSON.parse(e.data)
    if (data.planId !== state.plan?.planId) return
    // 旧图（属于上一套搭配）完成时不要报「已生成」，也不要动界面 —— 只重读当前状态
    const curKey = state.plan?.sceneView?.cacheKey
    const staleEvent = data.key && curKey && data.key !== curKey
    if (data.status === 'ready' || data.status === 'error') {
      await loadPlan(data.planId, { silent: true })
      if (staleEvent) return
      if (data.status === 'ready') {
        toast('穿搭图已更新')
      } else toast('这次没画成功，先保留上一版图片，可以点重试', true)
    } else if (data.status === 'generating') {
      if (staleEvent) return
      if (state.plan) {
        state.plan.sceneView = { ...state.plan.sceneView, status: 'generating' }
        renderStage()
      }
    } else if (data.status === 'queued') {
      // 自动模式排队中：界面上那行「正在更新穿搭图…」就够了，不再弹提示
      if (staleEvent) return
      state.plan.sceneView = { ...state.plan.sceneView, auto: { ...(state.plan.sceneView?.auto ?? {}), pending: true } }
      renderStage()
    } else if (data.status === 'cancelled') {
      await loadPlan(data.planId, { silent: true })
    }
  })
}

function setSync(on) {
  $('sync').classList.toggle('off', !on)
  $('sync-text').textContent = on ? '与 AI 实时同步' : '同步断开，重连中…'
}

const stageEl = document.getElementById('stage')
if (stageEl) new ResizeObserver(() => fitStageFrame()).observe(stageEl)
window.addEventListener('resize', () => {
  if (window.innerWidth >= 1024) {
    for (const id of ['pane-chat', 'pane-plan', 'pane-shop']) $(id).classList.add('active')
  } else {
    setTab(state.tab)
  }
})

boot().catch((err) => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<pre style="color:#7e2f14;padding:16px;background:#fff">启动失败：${esc(err.message)}</pre>`,
  )
})
