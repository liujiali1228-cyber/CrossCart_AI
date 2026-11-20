import {
  createPlan, applySwap, removeSlotItem, setSlotLock, rankCandidates,
  PlanError, STRATEGY_LABEL, STATUS_LABEL, ARRIVAL_LABEL, SLOT_LABEL,
} from '../packages/core/dist/index.js'

// ---------------------------------------------------------------- 情景与布局
const SCENE = {
  type: 'travel', destination: 'Tokyo', days: 3, today: '2026-11-16',
}
const BUDGET = { limit: 200, currency: 'USD', basis: 'new_items_only' }
const ARRIVE_BY = { date: '2026-11-22' }
const INIT_SLOTS = [
  { slot: 'outerwear', status: 'to_buy', productId: 'ow_ivory_trench', reason: '浅色风衣，拍照出片' },
  { slot: 'top', status: 'to_buy', productId: 'top_cream_tee' },
  { slot: 'bottom', status: 'owned', productId: 'own_dark_jeans', reason: '已有' },
  { slot: 'shoes', status: 'to_buy', productId: 'shoe_beige_slipon' },
  { slot: 'bag', status: 'empty' },
]

// flat-lay 模板：归一化热区 [x, y, w, h]（0-1），画布任意缩放都不需要重算
const HOTSPOTS = {
  outerwear: [6, 4, 88, 34],
  top: [6, 42, 42, 26],
  bottom: [52, 42, 42, 26],
  shoes: [6, 72, 42, 22],
  bag: [52, 72, 42, 22],
}
const STRATEGIES = ['lighter', 'similar', 'cheaper', 'faster']

// ---------------------------------------------------------------- 全局状态
let seed = null
let plan = null
let selectedSlot = null
let prevPlan = null // 用于撤销上一步换件

const $ = (id) => document.getElementById(id)

// ---------------------------------------------------------------- 工具函数
const fmtDate = (iso) => (iso ? iso.slice(5).replace('-', '/') : '—')
const money = (n) => `$${n}`
const assetUrl = (p) => `/data/seed/${p}`
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function statusChip(status) {
  return `<span class="status-chip s-${status}">${STATUS_LABEL[status]}</span>`
}
function arrivalClass(verdict) {
  return { on_time: 'ok', at_risk: 'risk', late: 'bad', unknown: 'unknown' }[verdict]
}
function etaText(shipping) {
  if (shipping.status === 'unavailable') return '到货时间待确认'
  if (!shipping.etaDays) return '到货时间待确认'
  return `约 ${shipping.etaDays[0]}–${shipping.etaDays[1]} 天`
}

// ---------------------------------------------------------------- 初始化
async function init() {
  const res = await fetch('/data/seed/catalog.json')
  seed = await res.json()
  SCENE.today = seed.meta.today

  plan = createPlan({
    planId: 'pln_demo_a',
    label: '东京 3 天 · 方案 A',
    scene: SCENE,
    budget: BUDGET,
    arrivalBy: ARRIVE_BY,
    shipTo: 'CN',
    catalog: seed.items,
    ownedItems: seed.owned,
    slots: INIT_SLOTS,
  })

  renderAll()
  bindGlobal()

  // 演示/自测钩子：?swap=shoes:cheaper 或 ?swap=bag:bag_drawstring（便于截图与回归）
  const swap = new URLSearchParams(location.search).get('swap')
  if (swap) {
    const [slot, how] = swap.split(':')
    setTimeout(() => {
      const strategy = STRATEGIES.includes(how) ? how : undefined
      doSwap({ slot, strategy, productId: strategy ? undefined : how })
    }, 60)
  }
}

// ---------------------------------------------------------------- 渲染
function renderAll() {
  renderCanvas()
  renderFoot()
  renderPanel()
}

function renderCanvas() {
  const wrap = $('slots')
  wrap.innerHTML = ''
  for (const slot of plan.slots) {
    wrap.appendChild(renderSlotEl(slot))
  }
  $('revision').textContent = `rev ${plan.revision}`
}

function renderSlotEl(slot) {
  const [x, y, w, h] = HOTSPOTS[slot.slot]
  const btn = document.createElement('button')
  btn.className = 'slot'
  btn.dataset.slot = slot.slot
  btn.style.left = `${x}%`
  btn.style.top = `${y}%`
  btn.style.width = `${w}%`
  btn.style.height = `${h}%`

  if (slot.status === 'empty') {
    btn.classList.add('slot--empty')
    btn.setAttribute('aria-label', `${SLOT_LABEL[slot.slot]}：空，点击添加`)
    btn.addEventListener('click', (e) => { e.stopPropagation(); selectSlot(slot.slot) })
    return btn
  }

  const item = slot.item
  btn.classList.add(slot.status === 'owned' ? 'slot--owned' : 'slot--buy')
  if (slot.locked) {
    const b = document.createElement('span')
    b.className = 'lock-badge'
    b.textContent = '已锁定'
    btn.appendChild(b)
  }
  const img = document.createElement('img')
  img.src = assetUrl(item.image.cutout)
  img.alt = item.title
  btn.appendChild(img)

  if (slot.status === 'to_buy') {
    const st = worstStatus(item)
    const badge = document.createElement('span')
    badge.className = `buy-badge s-${st}`
    badge.textContent = `待买 · ${STATUS_LABEL[st]}`
    btn.appendChild(badge)
  }

  btn.setAttribute(
    'aria-label',
    `${SLOT_LABEL[slot.slot]}：${item.title}，${slot.status === 'owned' ? '已有' : money(item.price.amount)}，${slot.locked ? '已锁定' : ''}`,
  )
  btn.addEventListener('click', (e) => { e.stopPropagation(); selectSlot(slot.slot) })
  return btn
}

function worstStatus(item) {
  const order = { unavailable: 0, estimated: 1, confirmed: 2 }
  // 关税在 v1 恒不可用，不参与状态合并（否则每件都显示"待确认"），详情页单独标注
  return [item.price.status, item.shipping.status]
    .reduce((a, b) => (order[a] <= order[b] ? a : b))
}

const productTitle = (id) => {
  if (!id) return '空'
  const all = [...seed.items, ...seed.owned]
  return all.find((x) => x.productId === id)?.title ?? id
}

function renderFoot() {
  const total = plan.cost.newItemsTotal
  $('total').textContent = money(total.amount)
  $('total-status').outerHTML = `<span class="status-chip s-${total.status}" id="total-status">${STATUS_LABEL[total.status]}</span>`
  $('buy-count').textContent = plan.cost.lines.length

  const a = plan.arrival
  const row = $('arrival-row')
  row.className = `arrival-row ${arrivalClass(a.verdict)}`
  const range = a.latest ? `（预计 ${fmtDate(a.earliest)} – ${fmtDate(a.latest)}，截止 ${fmtDate(a.deadline)}）` : ''
  row.textContent = `到货判断：${ARRIVAL_LABEL[a.verdict]}${range}`
}

function renderPanel() {
  // —— 预算 ——
  const b = plan.cost.budget
  const total = plan.cost.newItemsTotal.amount
  const fill = $('budget-fill')
  fill.style.width = `${Math.min(100, (total / b.limit) * 100)}%`
  fill.className = `budget-fill${b.verdict === 'over_budget' ? ' over' : b.risky ? ' risky' : ''}`
  $('budget-text').innerHTML = b.remaining >= 0
    ? `<span>已知支出 <b>${money(total)}</b> / ${money(b.limit)}</span><span>还剩 ${money(b.remaining)} ${statusChip(b.status)}</span>`
    : `<span>已知支出 <b>${money(total)}</b> / ${money(b.limit)}</span><span style="color:var(--bad)">超支 ${money(-b.remaining)}</span>`
  $('budget-hint').textContent = b.risky
    ? '有费用项待确认（运费/关税），实际支出可能上浮。'
    : b.verdict === 'over_budget'
      ? '已超预算：点一件单品选「找更便宜的」，或移除一件。'
      : '运费与关税为规则估算，下单前以商家页面为准。'

  // —— 到货 ——
  const a = plan.arrival
  const sub = a.verdict === 'unknown'
    ? a.blocking.map((s) => `· ${s}`).join('<br>')
    : `预计 ${fmtDate(a.earliest)} – ${fmtDate(a.latest)} · 截止 ${fmtDate(a.deadline)}`
  $('arrival-detail').innerHTML =
    `<div class="big ${arrivalClass(a.verdict)}">${ARRIVAL_LABEL[a.verdict]}</div><div class="sub">${sub}</div>`

  // —— 清单 ——
  const lines = $('lines')
  lines.innerHTML = ''
  for (const slot of plan.slots) {
    if (!slot.item) continue
    const li = document.createElement('li')
    if (slot.status === 'owned') {
      li.className = 'owned'
      li.innerHTML = `<span class="li-title">${esc(slot.item.title)}</span><span>已有 · $0</span>`
    } else {
      const line = plan.cost.lines.find((l) => l.label === slot.item.title)
      li.innerHTML =
        `<span class="li-title">${esc(slot.item.title)}</span>` +
        `<span class="li-amount">${line ? money(line.amount) : ''}</span>` +
        (line ? statusChip(line.status) : '')
    }
    lines.appendChild(li)
  }

  // —— 变更记录 ——
  const ops = $('ops')
  ops.innerHTML = ''
  $('op-count').textContent = plan.ops.length ? `(${plan.ops.length})` : ''
  if (plan.ops.length === 0) {
    ops.innerHTML = '<li>暂无变更。点任意单品试试「换一件」。</li>'
    return
  }
  for (const op of [...plan.ops].reverse()) {
    const li = document.createElement('li')
    const label = {
      swap_item: '换', remove_item: '移除', lock: '锁定', unlock: '解锁',
    }[op.type]
    const detail = op.type === 'swap_item'
      ? `${productTitle(op.from)} → ${productTitle(op.to)}${op.strategy ? `（${STRATEGY_LABEL[op.strategy]}）` : ''}`
      : ''
    li.textContent = `${op.opId} ${label} ${SLOT_LABEL[op.slot]} ${detail}`
    ops.appendChild(li)
  }
}

// ---------------------------------------------------------------- 选中与浮层
function selectSlot(slotId) {
  selectedSlot = slotId
  document.querySelectorAll('.slot').forEach((el) => {
    el.classList.toggle('is-selected', el.dataset.slot === slotId)
  })
  $('canvas-wrap').classList.add('has-selection')
  showPopover(slotId)
}

function clearSelection() {
  selectedSlot = null
  document.querySelectorAll('.slot').forEach((el) => el.classList.remove('is-selected'))
  $('canvas-wrap').classList.remove('has-selection')
  $('popover').hidden = true
}

function showPopover(slotId) {
  const slot = plan.slots.find((s) => s.slot === slotId)
  const pop = $('popover')
  pop.innerHTML = popoverHtml(slot)
  pop.hidden = false
  wirePopover(slot)
}

const apHead = (title, sub) => `
  <div class="ap-head">
    <div class="ap-title"><h3>${title}</h3><div class="pv-sub">${sub}</div></div>
    <button class="ap-close" data-act="close" aria-label="关闭">×</button>
  </div>`

function popoverHtml(slot) {
  const id = slot.slot
  const label = SLOT_LABEL[id]
  if (slot.status === 'owned') {
    return `${apHead(`${label} · ${esc(slot.item.title)}`, '你的已有单品 · 不计入新增支出 · 不参与替换')}
      <div class="pv-actions">
        <button class="pv-btn" data-act="detail" data-slot="${id}">看详情</button>
      </div>`
  }
  if (slot.status === 'empty') {
    const cands = rankCandidates(plan, id, seed.items, 'similar', { includeUnconfirmed: true })
    const budgetLeft = Math.max(0, plan.cost.budget.limit -
      plan.slots.filter((s) => s.status === 'to_buy' && s.item && s.slot !== id)
        .reduce((acc, s) => acc + (plan.cost.lines.find((l) => l.label === s.item.title)?.amount ?? 0), 0))
    return `${apHead(`${label} · 挑一件`, `预算余量约 ${money(budgetLeft)}${plan.cost.budget.risky ? '（含待确认项）' : ''}`)}
      <div class="pv-section-label">候选（含运费待确认的商品，会明确标注）</div>
      <div class="pv-list">${cands.map(candidateHtml).join('')}</div>`
  }

  const item = slot.item
  const strategies = STRATEGIES.map((st) => {
    const cands = rankCandidates(plan, id, seed.items, st)
    const top = cands[0]
    const hint = top
      ? `${esc(top.item.title)} ${money(top.lineTotal)}${top.withinBudget ? '' : ` · 会超 $${top.overBy}`}`
      : '无候选'
    return `<button class="pv-strategy" data-strategy="${st}" data-slot="${id}">
      <span>${STRATEGY_LABEL[st]}</span><span class="pv-hint">${hint}</span></button>`
  }).join('')

  const cands = rankCandidates(plan, id, seed.items, 'similar', { includeUnconfirmed: true })
  return `${apHead(
    `${label} · ${esc(item.title)}`,
    `${money(item.price.amount)} · ${etaText(item.shipping)} · ${statusChip(worstStatus(item))}`,
  )}
    <div class="pv-section-label">怎么换？（只动这一件，其他单品保持不变）</div>
    <div class="pv-strategies">${strategies}</div>
    <div class="pv-section-label">或手动挑一件</div>
    <div class="pv-list">${cands.map(candidateHtml).join('')}</div>
    <div class="pv-actions">
      ${slot.locked
        ? `<button class="pv-btn" data-act="unlock" data-slot="${id}">解除锁定</button>`
        : `<button class="pv-btn" data-act="lock" data-slot="${id}">锁定这件</button>`}
      <button class="pv-btn danger" data-act="remove" data-slot="${id}">移除</button>
      <button class="pv-btn" data-act="detail" data-slot="${id}">看详情</button>
    </div>`
}

function candidateHtml(c) {
  const flag = !c.withinBudget
    ? `<span class="pv-over">超 $${c.overBy}</span>`
    : c.item.shipping.status === 'unavailable'
      ? `<span class="pv-over">到货待确认</span>`
      : ''
  return `<button class="pv-item" data-pick="${c.item.productId}" data-slot="${c.item.category}">
    <img src="${assetUrl(c.item.image.cutout)}" alt="" />
    <span class="pv-title">${esc(c.item.title)}</span>
    <span class="pv-price">${money(c.lineTotal)}</span>
    ${flag}
  </button>`
}

function wirePopover(slot) {
  const pop = $('popover')
  pop.querySelectorAll('[data-strategy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      doSwap({ slot: btn.dataset.slot, strategy: btn.dataset.strategy })
    })
  })
  pop.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      doSwap({ slot: btn.dataset.slot, productId: btn.dataset.pick })
    })
  })
  pop.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { act, slot: id } = btn.dataset
      if (act === 'close') {
        clearSelection()
      } else if (act === 'lock' || act === 'unlock') {
        plan = setSlotLock(plan, id, act === 'lock').plan
        renderAll()
        selectSlot(id)
        toast(act === 'lock' ? `已锁定「${SLOT_LABEL[id]}」，之后的推荐不会动它` : `已解除「${SLOT_LABEL[id]}」的锁定`)
      } else if (act === 'remove') {
        prevPlan = plan
        plan = removeSlotItem(plan, id, plan.revision).plan
        renderAll()
        clearSelection()
        toast(`已移除「${SLOT_LABEL[id]}」`, true)
      } else if (act === 'detail') {
        openDrawer(id)
      }
    })
  })
}

// ---------------------------------------------------------------- 换件闭环
function doSwap({ slot: slotId, strategy, productId }) {
  const btn = document.querySelector(`.slot[data-slot="${slotId}"]`)
  try {
    prevPlan = plan
    const { plan: next, diff } = applySwap(plan, seed.items, {
      slot: slotId, revision: plan.revision, strategy, productId,
    })
    plan = next

    // 局部刷新：只动这一格 + 底部结论 + 右侧面板
    if (btn) btn.classList.add('is-swapping')
    setTimeout(() => {
      const slotsWrap = $('slots')
      const old = slotsWrap.querySelector(`.slot[data-slot="${slotId}"]`)
      const fresh = renderSlotEl(plan.slots.find((s) => s.slot === slotId))
      fresh.classList.add('just-changed')
      if (old) slotsWrap.replaceChild(fresh, old)
      renderFoot()
      renderPanel()
      clearSelection()
    }, 180)

    toast(diff.summary, true, diff.budgetRemainingTo < 0)
  } catch (err) {
    if (err instanceof PlanError) {
      toast(err.hint ? `${err.message}。${err.hint}` : err.message, false, true)
    } else {
      throw err
    }
  }
}

// ---------------------------------------------------------------- Toast / 撤销
let toastTimer = null
let undoDeadline = null
function toast(msg, withUndo = false, isError = false) {
  const el = $('toast')
  clearTimeout(toastTimer)
  clearInterval(undoDeadline)
  el.className = `toast${isError ? ' error' : ''}`
  el.innerHTML = `<span>${esc(msg)}</span>`
  if (withUndo && prevPlan) {
    const btn = document.createElement('button')
    btn.className = 'undo'
    btn.textContent = '撤销（5s）'
    let left = 5
    undoDeadline = setInterval(() => {
      left -= 1
      if (left <= 0) { clearInterval(undoDeadline); hideToast() }
      else btn.textContent = `撤销（${left}s）`
    }, 1000)
    btn.addEventListener('click', () => {
      clearInterval(undoDeadline)
      plan = prevPlan
      prevPlan = null
      renderAll()
      hideToast()
      toast('已撤销，恢复到上一步')
    })
    el.appendChild(btn)
  } else {
    prevPlan = withUndo ? prevPlan : null
  }
  el.hidden = false
  toastTimer = setTimeout(hideToast, withUndo ? 6000 : 3600)
}
function hideToast() { $('toast').hidden = true }

// ---------------------------------------------------------------- 详情抽屉
function openDrawer(slotId) {
  const slot = plan.slots.find((s) => s.slot === slotId)
  if (!slot || !slot.item) return
  const item = slot.item
  const shippingFee = item.shipping.fee?.amount ?? null
  $('drawer').innerHTML = `
    <button class="close pv-btn" id="drawer-close">关闭</button>
    <h3>${esc(item.title)}</h3>
    <div class="pv-sub">${SLOT_LABEL[slot.slot]} · ${esc(item.color)} · ${item.style.join(' / ')}</div>
    <img class="dr-img" src="${assetUrl(item.image.main)}" alt="${esc(item.title)}（商家白底原图）" />
    <div class="dr-line"><span>商品价</span><span>${money(item.price.amount)} ${statusChip(item.price.status)}</span></div>
    <div class="dr-line"><span>运费（${etaText(item.shipping)}）</span>
      <span>${shippingFee !== null ? money(shippingFee) + ' ' : ''}${statusChip(item.shipping.status)}</span></div>
    <div class="dr-line"><span>目的国关税</span><span>${statusChip(item.duty.status)}</span></div>
    <div class="dr-line"><span>合计（已知部分）</span><span>${money(
      (item.price.amount ?? 0) + (shippingFee ?? 0),
    )}</span></div>
    <div class="sizes">${item.sizes.map((s) => `<span>${esc(s)}</span>`).join('')}</div>
    <a class="dr-link" href="${esc(item.url)}" target="_blank" rel="noopener">去商家页面核实价格与库存 ↗</a>
    <div class="dr-note">
      价格采集于 ${esc(item.price.fetchedAt ?? '')}，超过 24 小时请在下单前核实。
      ${item.shipping.note ? esc(item.shipping.note) + '。' : ''}
      ${item.duty.reason ? esc(item.duty.reason) + '。' : ''}
    </div>`
  $('drawer').hidden = false
  $('drawer-backdrop').hidden = false
  $('drawer-close').addEventListener('click', closeDrawer)
}
function closeDrawer() {
  $('drawer').hidden = true
  $('drawer-backdrop').hidden = true
}

// ---------------------------------------------------------------- 全局事件
function bindGlobal() {
  document.addEventListener('click', (e) => {
    const pop = $('popover')
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.slot')) clearSelection()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('drawer').hidden) closeDrawer()
      else clearSelection()
    }
  })
  $('drawer-backdrop').addEventListener('click', closeDrawer)
}

init()
