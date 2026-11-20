/**
 * 给模型的上下文快照（每轮对话前注入）。
 *
 * 两件事：
 *  1. 方案快照：让模型和页面读到同一份数字，不用靠聊天文字同步（原逻辑，逐字保留）。
 *  2. 生效偏好摘要：把 confirmed + 当前上下文有效的偏好压成 ≤6 行注入。
 *
 * 偏好这里只做「读得到」。是否采纳由模型判断，硬约束（预算/到货/收货地/类目）
 * 永远优先；偏好真正影响候选集在后续阶段由确定性代码保证，不靠这段文字。
 * 0 次额外模型调用：只是把已有数据拼进本轮 prompt。
 */
import { prefsBrief } from '../../core/dist/index.js'

const PREF_RULE =
  '偏好使用规则：这些偏好只用于软性选品（颜色/风格/品牌倾向），**不能覆盖预算、到货时间、收货地、类目等硬约束**；' +
  '与用户这句话里的当前要求冲突时，以当前要求为准，并说明差异。不得因为偏好而声称某个金额、汇率或到货时间。'

/**
 * 偏好段。没有生效偏好时返回 []（不注入空段落，避免模型把"没有偏好"当成事实）。
 * @param {object} ws
 * @param {string|null} planId
 */
export function prefSection(ws, planId) {
  const taskKey = planId && planId !== '__none__' ? String(planId) : null
  const brief = prefsBrief(ws?.prefs ?? [], { taskKey })
  if (!brief.lines.length) return []
  return ['用户偏好（用户自己设置或已确认，按「长期 / 仅本方案」标注）：', ...brief.lines, PREF_RULE]
}

/**
 * @param {object} ws
 * @param {string} planId  '__none__' 表示当前没有方案
 */
export function planContext(ws, planId) {
  try {
    const plan = ws.getPlan(planId)
    const vm = ws.viewModel(plan)
    const b = vm.cost.breakdown
    const buy = vm.purchases
    const toBuy = vm.slots.filter((s) => s.status === 'to_buy' && s.item)
    // P9：owned 不再只看 s.item —— 用户说「我有白鞋」时没有商品快照，
    // 之前这种槽位在上下文与提示词里双双消失，模型就当成「没有鞋」自由发挥。
    const owned = vm.slots.filter((s) => s.status === 'owned')
    // 只有用户明确声明过的「已有」才算事实；示例方案 / 修复前遗留的 owned 一律不当真。
    // 这是「已拥有深色牛仔裤」串到每一份新方案里的第二条通路（第一条是建方案工具的示例参数）。
    //
    // 第三层（P5「新开聊天」）：声明还必须是**这段对话**里说的。
    // 新开聊天后，之前记下的 ownedClaim 只作历史展示，不能当成用户这次说过的话——
    // 否则模型会把上一段的「我有一条牛仔裤」直接搬进一份全新的方案。
    const epoch = ws?.chatEpochStart ?? null
    const inThisChat = (s) => !epoch || String(s.ownedClaim?.at ?? '') >= epoch
    const isClaim = (s) => Boolean(s.ownedClaim?.quote) && !/^示例/.test(String(s.ownedClaim.quote))
    const claimed = owned.filter((s) => isClaim(s) && inThisChat(s))
    const sample = owned.filter((s) => !claimed.includes(s))
    const rows = toBuy.map((s) => {
      const it = s.item
      const ship = it.shipping.fee == null ? '运费待确认' : `运费 $${it.shipping.fee}（估算）`
      const eta = it.shipping.etaLatest ? `最晚 ${it.shipping.etaLatest}` : '到货待确认'
      return `- ${s.label}：${it.title} · ${it.vendor} · $${it.price.amount} · ${ship} · ${eta}${s.locked ? ' · 已锁定' : ''}`
    })
    const ownedRows = claimed.map((s) => {
      const what = s.item ? s.item.title : s.ownedClaim?.label || '具体款式未知'
      const quote = s.ownedClaim?.quote ?? ''
      // 抽象自有要写清「没有商品 ID」：否则模型会以为库里有这件，或者干脆再推荐一双鞋
      const tail = s.item ? '' : '（用户自己的东西，系统里没有具体商品/链接，不要编一款商品代替，也不要在图里换掉）'
      return `- ${s.label}：${what}（用户声明已有：「${quote}」，不计入支出）${tail}`
    })
    const sampleNote = sample.length
      ? `（这份方案里的「已有」是示例数据、或上一段对话里留下的记录，不代表用户这段对话里说过自己拥有：${sample
          .map((s) => `${s.label} ${s.item?.title ?? s.ownedClaim?.label ?? '未说明'}`)
          .join('、')}。新建方案时不要自动沿用，除非用户这次明确说了自己有）`
      : null
    return [
      '<crosscart-context>',
      `当前方案：${vm.planId}「${vm.label}」rev ${vm.revision}。这是最新状态，用户可能刚在页面上改过，请以此为准，不要沿用你记忆里的旧数字。`,
      `场景：${vm.scene.destination} · ${vm.scene.days} 天；收货地 ${vm.constraints.shipTo}（旅行目的地不等于收货地址，若不确定必须问）。最晚到货 ${vm.constraints.arrivalBy}。`,
      ...prefSection(ws, planId),
      '待买：',
      ...(rows.length ? rows : ['- （没有待买单品）']),
      ...(ownedRows.length ? ['已有（用户明确说过）：', ...ownedRows] : []),
      sampleNote,
      `费用：商品小计 $${b.itemSubtotal}；已知运费 $${b.shippingKnown}；可计算总额 $${b.knownTotal}；预算 $${b.budgetLimit}；${
        b.verdict === 'over_budget' ? `已超 $${b.overBy}` : `还剩 $${b.remaining}`
      }。关税/进口税未确认，不得称为最终到手价。`,
      `到货判断：${vm.arrival.label}${vm.arrival.latest ? `（最晚 ${vm.arrival.latest}）` : ''}。`,
      `购买入口：${buy.buyableCount} 件有可核实的商家详情页，${buy.missingLinkCount} 件没有；没有链接的不要编造链接。`,
      vm.sceneView
        ? `当前场景：${vm.sceneView.spec.label}（${vm.sceneView.status === 'ready' ? '场景图已生成' : vm.sceneView.status === 'generating' ? '场景图生成中' : '场景图未生成'}）。${vm.sceneView.adaptation?.needed ? `注意：${vm.sceneView.adaptation.hints.join('；')}——只给建议，未经用户确认不要换商品。` : ''}`
        : null,
      '工具约定：读方案用 crosscart_plan_state，换件用 crosscart_swap_item（一次只改一个搭配位），创建方案用 crosscart_create_plan，**切换场景用 crosscart_set_scene**（只改背景，绝不动商品；用户说「换个场景看看/放到某地看看」就用它）。',
      '选品规则：优先选真实店铺商品（catalog 中标「真实店铺」、带商品页链接的）；只有当真实商品确实没有合适候选时，才用演示数据，并且必须说明这件是演示数据、没有可核实的购买链接。',
      '已有单品规则：用户说自己已经有某件东西（「我有白色的鞋子」「包我自己有」）时，那个搭配位默认按 owned 处理，不要再推荐重复购买同类别；商品库里没有对应的具体商品时，slots 里写 {"slot":"shoes","status":"owned","ownedLabel":"白色运动鞋"}，并在 ownedClaims 里带上 {slot, label, quote}（quote 必须是用户这句原话），**绝不要为了填满搭配位而编一个具体商品**。用户后来说「鞋子也重新帮我挑」时，把这个位置改回 to_buy 正常推荐。',
      '判定规则：用户描述的是**新的出行需求**（目的地/天数/预算与上面这个方案明显不同，例如换城市、换预算档）时，用 crosscart_create_plan 新建方案，不要改旧方案；只有用户要求「换掉/调整某一件」时才动当前方案。',
      '说话方式：像一个懂搭配的朋友在聊天，用自然口语中文。先说这次搭了什么、为什么适合这个场合；再顺口说一句花了多少、离预算还有多少（金额带「估算」字样）；到货或费用拿不准时如实说，不要为了顺口把估算说成确定。',
      '不要写成业务汇报：不要分点罗列、不要套「改了什么 + 金额 + 到货 + 结论」的固定三段式、不要把工具结果或商品清单复述一遍（页面右侧已经有全部明细）。',
      '**不要在回复里写任何链接、URL 或方案编号**。用户就在页面上，导航由界面负责；分享也有页面自己的入口。',
      '不要用内部用语：「槽位」「链路」「已拥有状态」「页面空位」「执行完成」「系统识别」「写入成功」都不要出现在回复里，换成用户能懂的说法（「鞋这一项」「你自己那双白鞋」）。',
      '长度以说清为准，通常两三句话；不需要每次都以提问结尾，也不要反复确认同一件事。',
      '</crosscart-context>',
    ]
      .filter(Boolean)
      .join('\n')
  } catch {
    return [
      '<crosscart-context>',
      '当前还没有购物方案；如果用户描述了需求，请用 crosscart_create_plan 建方案。',
      ...prefSection(ws, null),
      '</crosscart-context>',
    ]
      .filter(Boolean)
      .join('\n')
  }
}
