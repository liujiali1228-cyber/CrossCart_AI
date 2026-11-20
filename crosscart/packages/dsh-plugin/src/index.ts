/**
 * CrossCart AI · dsh 插件
 *
 * 六个工具，全部读写 bridge 的同一份方案状态：
 *   - dsh 对话侧（本插件）与浏览器 Studio 页面是两个客户端
 *   - 因此「页面换件 → AI 立刻读到」「AI 换件 → 页面实时刷新」都不依赖提示词
 *
 * 所有金额、到货、单件隔离、三态合并都在 @crosscart/core 纯函数里，
 * bridge 只做装配与持久化，插件只做 HTTP 转发与文案。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { bridge, studioUrl, BRIDGE_URL } from './bridge-client.ts'
import { resolveAttr, SLOT_LABEL, STATUS_LABEL, STRATEGY_LABEL } from '../../core/dist/index.js'

export const name = 'crosscart'
export const inject = ['tools']

const STRATEGIES = ['lighter', 'similar', 'cheaper', 'faster']
const SLOTS = ['outerwear', 'top', 'bottom', 'shoes', 'bag']

/** 卡片用的紧凑投影：图片换成可被浏览器直接访问的绝对地址 */
function cardMeta(vm: any) {
  return {
    kind: 'crosscart.plan',
    planId: vm.planId,
    label: vm.label,
    revision: vm.revision,
    total: vm.cost.newItemsTotal,
    totalStatus: vm.cost.totalStatus,
    budgetLimit: vm.cost.budget.limit,
    remaining: vm.cost.budget.remaining,
    verdict: vm.cost.budget.verdict,
    arrivalLabel: vm.arrival.label,
    arrivalEarliest: vm.arrival.earliest,
    arrivalLatest: vm.arrival.latest,
    deadline: vm.arrival.deadline,
    studioUrl: studioUrl(vm.planId),
    slots: vm.slots.map((s: any) => ({
      slot: s.slot,
      label: s.label,
      status: s.status,
      title: s.item?.title ?? null,
      vendor: s.item?.vendor ?? null,
      price: s.item?.price?.amount ?? null,
      sourceKind: s.item?.sourceKind ?? null,
      image: s.item ? (s.item.image.cutout.startsWith('http') ? s.item.image.cutout : `${BRIDGE_URL}${s.item.image.cutout}`) : null,
    })),
  }
}

function planText(vm: any): string {
  const lines = vm.slots.map((s: any) => {
    if (!s.item) {
      // 抽象「已有」不是空位：用户自己有一双白鞋，说成空位会误导模型再去推荐鞋
      if (s.status === 'owned' && s.ownedClaim?.label) {
        return `${s.label}：${s.ownedClaim.label}（用户自己的，没有商品链接，不计入支出）`
      }
      return `${s.label}：（空位）`
    }
    const tag = s.status === 'owned' ? '已有' : '待买'
    return `${s.label}：${s.item.title}（${tag}${s.locked ? ' · 已锁定' : ''}）`
  })
  const money = (n: number) => `$${n}`
  return [
    `方案 ${vm.planId}「${vm.label}」（rev ${vm.revision}）`,
    ...lines.map((l: string) => `  · ${l}`),
    `新增支出 ${money(vm.cost.newItemsTotal)}（${STATUS_LABEL[vm.cost.totalStatus as keyof typeof STATUS_LABEL]}）/ 预算 ${money(vm.cost.budget.limit)}，${
      vm.cost.budget.verdict === 'over_budget'
        ? `已超 ${money(Math.abs(vm.cost.budget.remaining))}`
        : `剩余 ${money(vm.cost.budget.remaining)}`
    }`,
    `到货：${vm.arrival.label}${vm.arrival.latest ? `（最晚 ${vm.arrival.latest}，截止 ${vm.arrival.deadline}）` : ''}`,
    // 这里以前还输出了「可视化方案：http://…/?plan=pln_006」，
    // 模型就会把这条链接抄进聊天回复，用户看到的是一条开发调试用的 URL。
    // 页面地址仍由 bridge 返回在结构化字段（studioUrl）里，供前端导航/分享使用。
  ].join('\n')
}

export function apply(ctx: Context) {
  ctx.tools.register(
    defineTool({
      name: 'crosscart_list_catalog',
      description:
        '浏览可购商品（真实店铺商品 + 演示种子数据）。可按搭配位类目、色系、到手价上限筛选。' +
        '每件返回：商品 ID、名称、店铺、颜色、挂牌价（已确认）、运费（估算）、到货天数（估算）、尺码、数据来源与商品页链接。' +
        '真实店铺商品带 sourceKind=live 且有商品页链接；演示数据没有可核实的购买链接，只能用于凑搭配、不能当作可购买商品。',
      parameters: {
        category: { type: 'string', description: '搭配位：outerwear 外套 / top 上衣 / bottom 裤装 / shoes 鞋 / bag 包' },
        colorFamily: { type: 'string', description: '色系：light / mid / dark' },
        maxLandedUSD: { type: 'number', description: '到手价上限（美元）' },
        limit: { type: 'number', description: '最多返回几件，默认 20' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, value: any) => {
          const lines = [
            value.items.length === 0
              ? '没有符合条件的商品。'
              : value.items
                  .map(
                    (i: any) =>
                      `${i.productId}｜${i.title}｜${i.vendor}｜${i.category}｜${i.color}｜${
                        i.price == null ? '价格待确认' : `挂牌 $${i.price}`
                      }｜运费 ${i.shipping == null ? '待确认' : `$${i.shipping}（估算）`}｜${
                        i.etaDays ? `${i.etaDays[0]}–${i.etaDays[1]} 天到（估算）` : '到货待确认'
                      }｜尺码 ${(i.sizes ?? []).slice(0, 6).join('/') || '—'}｜${
                        i.sourceKind === 'live' ? `真实店铺 · ${i.url ?? '商品页链接缺失'}` : '演示数据 · 无购买链接'
                      }`,
                  )
                  .join('\n'),
          ]
          // 已有单品的占位条目：**不是事实**，只是可以代表「用户自带的那件」的 ID。
          // 没有这段，模型即使听到用户说「我有一条牛仔裤」也报不出 productId，只能放弃这一位。
          if ((value.owned ?? []).length) {
            lines.push(
              '已有单品占位（**不代表用户真的有**：只有用户这一轮明确说过自己有类似单品时，' +
                '才能把它放进 owned 槽位并在 ownedClaims 里附上他的原话；否则不要用）：\n' +
                value.owned.map((o: any) => `${o.productId}｜${o.title}｜${o.category}｜价格 $0 · 不计入支出`).join('\n'),
            )
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args: any) {
        const q = new URLSearchParams()
        if (args.category) q.set('category', args.category)
        if (args.colorFamily) q.set('colorFamily', args.colorFamily)
        if (typeof args.maxLandedUSD === 'number') q.set('maxPrice', String(args.maxLandedUSD))
        q.set('limit', String(args.limit ?? 20))
        const data = await bridge<any>(`/api/catalog?${q}`)
        return { total: data.total, items: data.items, owned: data.owned ?? [] }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'crosscart_create_plan',
      description:
        '创建一套购物搭配方案，返回方案 ID、费用与到货判断（页面由前端自己展示，不要在回复里贴链接）。' +
        '需要新购用 to_buy；留空用 empty。' +
        '**只有用户在这段对话里明确说过自己已经拥有某件东西时，才允许 status=owned**，并且必须在 ownedClaims 里写下他的原话；' +
        '商品库里没有对应商品时用「抽象自有」（owned + ownedLabel），不要为了填槽位编一款商品。' +
        '用户没说过就一律按 to_buy 处理 —— 别把演示数据或上一份方案里的「已有」当成用户的衣橱。',
      parameters: {
        label: { type: 'string', required: true, description: '方案名，如「东京 3 天 · 方案 A」' },
        destination: { type: 'string', required: true, description: '目的地，如 Tokyo' },
        days: { type: 'number', required: true, description: '出行天数' },
        budgetLimitUSD: { type: 'number', required: true, description: '新增支出预算（美元）' },
        arrivalBy: { type: 'string', required: true, description: '最晚到货日 YYYY-MM-DD' },
        slotsJson: {
          type: 'string',
          required: true,
          description:
            'JSON 数组：每项 {"slot":"outerwear|top|bottom|shoes|bag","status":"to_buy|empty","productId":"商品ID","reason":"可选"}。' +
            '用户说自己已经有某类东西、但商品库里没有对应的具体商品时，用 {"slot":"shoes","status":"owned","ownedLabel":"白色运动鞋","ownedColor":"white"}（ownedLabel 写用户的说法），并配 ownedClaims。' +
            '示例：[{"slot":"outerwear","status":"to_buy","productId":"everlane:wool-double-breasted-blazer"},{"slot":"bag","status":"empty"}]',
        },
        ownedClaims: {
          type: 'string',
          description:
            'JSON 数组，仅在用户本轮明确说过自己已拥有某件东西时填写。两种写法：' +
            '① 有具体商品：[{"productId":"own_dark_jeans","quote":"我有一条深色牛仔裤"}]（productId 用 crosscart_list_catalog 的「已有单品占位」里的 ID）；' +
            '② 没有具体商品：[{"slot":"shoes","label":"白色的鞋子","color":"white","quote":"我有白色的鞋子"}]。' +
            'quote 必须抄用户这句原话里的片段，不要自己编。没说过就不要传，也不要把 slotsJson 里的 status 写成 owned。',
        },
        allowPrefRules: {
          type: 'string',
          description:
            '仅在用户本轮**明确**同意为这套方案破例时才填：用逗号分隔要破例的规则（brand_avoid / avoid / size_top / size_bottom / size_shoes）。' +
            '不填 = 严格遵守已确认的硬性偏好。禁止因为「凑不出搭配」自行放开。',
        },
        allowQuote: {
          type: 'string',
          description: '用户同意破例的原话（与 allowPrefRules 一起用）。必须是他/她真的说过的句子。',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, value: any) => [{ type: 'text', text: value.text }],
        presentationMeta: (_a, value: any) => value.card,
      },
      async execute(args: any) {
        let slots: any[]
        try {
          slots = JSON.parse(args.slotsJson)
        } catch {
          throw new Error('slotsJson 不是合法 JSON 数组')
        }
        const payload: any = {
          label: args.label,
          scene: { type: 'travel', destination: args.destination, days: args.days },
          budgetLimit: args.budgetLimitUSD,
          arrivalBy: args.arrivalBy,
          slots,
        }
        if (args.ownedClaims) {
          try {
            const claims = JSON.parse(args.ownedClaims)
            if (Array.isArray(claims) && claims.length) payload.ownedClaims = claims
          } catch {
            throw new Error('ownedClaims 不是合法 JSON 数组；用户没说过已有商品就不要传这个参数')
          }
        }
        if (args.allowPrefRules) {
          payload.prefOverride = {
            rules: String(args.allowPrefRules)
              .split(/[,，\s]+/)
              .map((r: string) => r.trim())
              .filter(Boolean),
            quote: args.allowQuote ?? '',
          }
        }
        let vm: any
        try {
          vm = await bridge<any>('/api/plans', { method: 'POST', body: JSON.stringify(payload) })
        } catch (e: any) {
          if (e?.code === 'OWNED_UNDECLARED') {
            throw new Error(
              [
                '方案没有创建：有搭配位被标成「已拥有」，但用户这一轮没有说过自己拥有它。',
                '请把这些搭配位改成 to_buy（需要买）或 empty（留空）后重新提交。',
                '只有当用户明确说过「我已经有 / 我有一条…」时，才可以 status=owned，并在 ownedClaims 里写他的原话（有商品写 productId，没商品写 {slot,label,quote}）。',
              ].join('\n'),
            )
          }
          if (e?.code === 'PREF_CONFLICT') {
            const d: any = e.details ?? {}
            const conflicts: any[] = d.violations ?? []
            const lines = conflicts.map(
              (c: any) =>
                `  · ${SLOT_LABEL[c.slot as keyof typeof SLOT_LABEL]}「${c.title}」—— ${(c.reasons ?? []).join('；')}`,
            )
            throw new Error(
              [
                `方案没有创建（未保存任何数据）：${conflicts.length} 件商品违反你已确认的偏好。`,
                ...lines,
                `可以：① 换掉冲突商品重新提交；② 到首页修改或删除对应偏好；③ 如果本次确实要例外，需要用户明确说出「这次破例」后，再用 allowPrefRules + allowQuote 重新提交（只对这套方案生效，不会改长期偏好）。`,
              ].join('\n'),
            )
          }
          throw e
        }
        const conflicts = vm.prefConflicts ?? []
        const exempt = vm.prefExempt ?? []
        const checks: any[] = vm.prefChecks ?? []
        const concern = checks.filter((c) => c.status !== 'ok')
        const noteParts: string[] = []
        if (exempt.length) {
          noteParts.push(
            `⚠️ 本方案破例：${exempt
              .map((c: any) => `${SLOT_LABEL[c.slot as keyof typeof SLOT_LABEL]} ${c.title}（${c.reasons.join('；')}）`)
              .join('；')} —— 按你的明确授权保留，只对这套方案生效。`,
          )
        }
        if (conflicts.length) {
          noteParts.push(
            `⚠️ 偏好冲突（方案已按你的选择保留）：` +
              conflicts
                .map((c: any) => `${SLOT_LABEL[c.slot as keyof typeof SLOT_LABEL]} ${c.title} —— ${c.reasons.join('；')}`)
                .join('；') +
              '。如果这不是你想要的，我可以换掉它。',
          )
        }
        if (concern.length) {
          noteParts.push(
            '约束核查：' +
              concern.map((c) => `${c.status === 'violated' ? '未满足' : '无法确认'} —— ${c.detail}`).join('；'),
          )
        }
        const note = noteParts.length ? `\n${noteParts.join('\n')}` : ''
        return {
          planId: vm.planId,
          revision: vm.revision,
          studioUrl: studioUrl(vm.planId),
          prefConflicts: conflicts,
          prefExempt: exempt,
          prefApplied: vm.prefApplied ?? [],
          prefChecks: checks,
          text: planText(vm) + note,
          card: cardMeta(vm),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'crosscart_swap_item',
      description:
        '替换方案中某一个搭配位的单品，只改这一件，费用与到货由引擎重算。' +
        '策略：lighter 浅色 / similar 相似 / cheaper 更便宜 / faster 更快到；也可用 productId 指定商品。' +
        '超预算、无候选或位置被锁定时不会改动方案，并返回原因。',
      parameters: {
        planId: { type: 'string', required: true, description: '方案 ID' },
        slot: { type: 'string', required: true, description: '搭配位：outerwear / top / bottom / shoes / bag' },
        strategy: { type: 'string', description: 'lighter / similar / cheaper / faster（与 productId 二选一）' },
        productId: { type: 'string', description: '直接指定商品 ID（与 strategy 二选一）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, value: any) => [{ type: 'text', text: value.text }],
        presentationMeta: (_a, value: any) => value.card,
      },
      async execute(args: any) {
        if (!SLOTS.includes(args.slot)) throw new Error(`搭配位必须是 ${SLOTS.join(' / ')} 之一`)
        if (args.strategy && !STRATEGIES.includes(args.strategy)) {
          throw new Error(`strategy 必须是 ${STRATEGIES.join(' / ')} 之一`)
        }
        if (!args.strategy && !args.productId) throw new Error('需要 strategy 或 productId 之一')

        const before = await bridge<any>(`/api/plans/${encodeURIComponent(args.planId)}`)
        const vm = await bridge<any>(`/api/plans/${encodeURIComponent(args.planId)}/swap`, {
          method: 'POST',
          body: JSON.stringify({ slot: args.slot, strategy: args.strategy, productId: args.productId, by: 'ai' }),
        })
        const slotLabel = SLOT_LABEL[args.slot as keyof typeof SLOT_LABEL]
        const beforeItem = before.slots.find((s: any) => s.slot === args.slot)?.item
        const afterItem = vm.slots.find((s: any) => s.slot === args.slot)?.item
        const how = args.strategy ? STRATEGY_LABEL[args.strategy as keyof typeof STRATEGY_LABEL] : '指定商品'
        const text = [
          `已把「${slotLabel}」换成 ${afterItem?.title ?? '空位'}（${how}）；只改动了这一件。`,
          `现在：新增支出 $${vm.cost.newItemsTotal} / 预算 $${vm.cost.budget.limit}，${
            vm.cost.budget.verdict === 'over_budget'
              ? `已超 $${Math.abs(vm.cost.budget.remaining)}`
              : `剩余 $${vm.cost.budget.remaining}`
          }；到货：${vm.arrival.label}${vm.arrival.latest ? `（最晚 ${vm.arrival.latest}）` : ''}`,
          `可视化方案：${studioUrl(vm.planId)}`,
        ].join('\n')
        const ranking = vm.prefRanking ?? { excluded: [], relaxed: [], applied: [], picked: null }
        const picked = ranking.picked ?? null
        const explain = (() => {
          if (!picked) return ''
          if (picked.specified) {
            return picked.prefBonus
              ? `按你指定保留；这件与偏好${picked.prefWhys?.length ? '同向（' + picked.prefWhys.join('；') + '）' : '有加分'}`
              : '按你指定保留（未获得偏好加分）'
          }
          if (picked.prefBonus > 0 && picked.rankChanged === true) {
            return `偏好确实改变了名次：${picked.prefWhys?.join('；') ?? `+${picked.prefBonus}`}；无偏好时第 ${picked.rankWithoutPrefs}，现在第 ${picked.rankWithPrefs}`
          }
          if (picked.prefBonus > 0) {
            return `偏好给这件加了 ${picked.prefBonus}（${picked.prefWhys?.join('；') ?? ''}），但名次没有变化（第 ${picked.rankWithPrefs}）—— 结果主要由策略、价格与到货决定`
          }
          if ((ranking.applied?.length ?? 0) > 0) {
            return `偏好参与了排序（${ranking.applied.join('；')}），但这件本身没有获得加分`
          }
          return '这次没有生效的偏好，结果与无偏好时一致'
        })()
        const prefNote =
          (explain ? `\n偏好说明：${explain}` : '') +
          ((ranking.excluded?.length ?? 0) > 0
            ? `\n（按你的偏好排除了 ${ranking.excluded.length} 件候选：${ranking.excluded
                .slice(0, 3)
                .map((e: any) => e.title)
                .join('、')}${ranking.excluded.length > 3 ? ' 等' : ''}）`
            : '')
        return {
          planId: vm.planId,
          revision: vm.revision,
          prefExcluded: ranking.excluded ?? [],
          prefRelaxed: ranking.relaxed ?? [],
          prefApplied: ranking.applied ?? [],
          prefPicked: picked,
          from: beforeItem?.productId ?? null,
          to: afterItem?.productId ?? null,
          budgetRemaining: vm.cost.budget.remaining,
          arrival: vm.arrival,
          studioUrl: studioUrl(vm.planId),
          text: text + prefNote,
          card: cardMeta(vm),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'crosscart_plan_state',
      description: '查看方案完整状态：每个搭配位的单品、逐项到手价、预算余量、到货判断、风险与变更记录。',
      parameters: { planId: { type: 'string', required: true, description: '方案 ID' } },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, value: any) => [{ type: 'text', text: value.text }],
        presentationMeta: (_a, value: any) => value.card,
      },
      async execute(args: any) {
        const vm = await bridge<any>(`/api/plans/${encodeURIComponent(args.planId)}`)
        const lines = vm.cost.lines
          .map((l: any) => `  · ${l.title}：$${l.amount}（商品 $${l.item}${l.shipping != null ? ` + 运费 $${l.shipping}` : ' + 运费待确认'}，${l.statusLabel}）`)
          .join('\n')
        const risks = vm.risks.map((r: any) => `  · [${r.level}] ${r.text}`).join('\n')
        const hist = vm.history.length
          ? vm.history.map((h: any) => `  · ${h.slot}：${h.from} → ${h.to}（${h.strategy}）`).join('\n')
          : '  （还没有变更）'
        const text = `${planText(vm)}\n逐项费用：\n${lines}\n风险：\n${risks}\n变更记录：\n${hist}`
        return { ...vm, studioUrl: studioUrl(vm.planId), text, card: cardMeta(vm) }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'crosscart_save_pref',
      description:
        '保存用户**明确要求记住**的偏好（覆盖式：同一属性 + 同一作用域只保留最新一条，旧记录进历史）。' +
        'scope=profile 是长期偏好；scope=task 只用于本次任务（必须带 planId，否则会永久生效），且本次永远优先于长期。' +
        '只能用于用户已经说清楚「记住 / 以后都这样」的情况；你自己观察推测的偏好，一律用 crosscart_propose_pref 写成待确认。',
      parameters: {
        attr: { type: 'string', required: true, description: '属性：palette / style / avoid / size_top / size_bottom / size_shoes / brand_prefer / brand_avoid' },
        value: { type: 'string', required: true, description: '偏好值，如 light / minimal / M / 避开高跟鞋' },
        scope: { type: 'string', required: true, description: 'profile（长期）或 task（仅本次）' },
        planId: { type: 'string', description: 'scope=task 时必填：绑定到哪个方案（本次任务）' },
        quote: { type: 'string', required: true, description: '用户原话（必须是用户真的说过的句子，用于记录依据）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, value: any) => [{ type: 'text', text: value.text }],
      },
      async execute(args: any) {
        if (args.scope !== 'profile' && args.scope !== 'task') throw new Error('scope 必须是 profile 或 task')
        if (args.scope === 'task' && !args.planId) {
          throw new Error('scope=task 必须带 planId（本次任务绑定哪个方案），否则「本次」会变成永久生效；长期偏好请用 scope=profile')
        }
        if (!args.quote || String(args.quote).trim().length < 2) {
          throw new Error('请传 quote（用户原话）。没有原话的偏好只能作为待确认提议，用 crosscart_propose_pref')
        }
        const record = await bridge<any>('/api/prefs', {
          method: 'POST',
          body: JSON.stringify({
            attr: args.attr,
            value: args.value,
            scope: args.scope,
            taskKey: args.scope === 'task' ? args.planId : null,
            source: 'ai',
            evidence: { basis: 'chat', quote: String(args.quote), ...(args.planId ? { ref: args.planId } : {}) },
          }),
        })
        const q = args.planId ? `?planId=${encodeURIComponent(args.planId)}` : ''
        const { prefs } = await bridge<any>(`/api/prefs${q}`)
        const resolved = resolveAttr(prefs, args.attr, null, { taskKey: args.planId ?? null })
        const overriddenNote = resolved.overridden.length
          ? `；本次要求覆盖了长期偏好「${String(resolved.overridden[0].value)}」（长期偏好仍保留，下次任务继续生效）`
          : ''
        const scopeText = args.scope === 'profile' ? '长期偏好' : `本次任务（${args.planId}）`
        // 硬性要求只在「字段能确定性匹配」时生效：别让用户以为所有商品都已被筛过
        const hardAttr = ['avoid', 'brand_avoid', 'size_top', 'size_bottom', 'size_shoes'].includes(record?.attr ?? args.attr)
        const caveat = hardAttr
          ? '\n注意：这类要求是按商品标题 / 颜色 / 标签 / 尺码字段做确定性匹配。字段缺失或语言对不上时（例如中文避开词遇到英文标题）可能匹配不到，届时会在候选与建方案结果里如实标注，不会假装已经筛过。'
          : ''
        return {
          id: record?.id ?? null,
          attr: record?.attr ?? args.attr,
          effectiveValue: resolved.value,
          overridden: resolved.overridden.map((r: any) => ({ scope: r.scope, value: r.value })),
          text: `已保存（${scopeText}）：${record?.attr ?? args.attr} = ${args.value}${overriddenNote}。当前生效值：${String(resolved.value)}${caveat}`,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'crosscart_propose_pref',
      description:
        '提议一条你观察到的长期偏好，写入「待确认」，**不会**立即影响推荐。' +
        '换件/挑选本身只能说明这一次的选择，不能自动变成长期偏好，所以必须由用户在首页确认后才生效。' +
        '依据必须来自真实发生的对话或操作（quote 写用户原话或那次操作），不许编造用户喜好。' +
        '同一属性已有待确认提议时会就地更新而不是重复新增；用户拒绝过的同值提议不会再出现。',
      parameters: {
        attr: { type: 'string', required: true, description: '属性：palette / style / avoid / size_top / size_bottom / size_shoes / brand_prefer / brand_avoid' },
        value: { type: 'string', required: true, description: '推断出的偏好值' },
        basis: { type: 'string', required: true, description: '依据类型：swap（换件）/ selection（在候选里挑选）/ chat（用户说过）/ form' },
        quote: { type: 'string', required: true, description: '依据原文：用户说过的句子，或那次操作的客观描述（如"连续两次把鞋换成白色款"）' },
        scope: { type: 'string', description: 'profile（长期，默认）或 task（仅本方案）' },
        planId: { type: 'string', description: 'scope=task 或 basis=swap/selection 时建议填写：依据来自哪个方案' },
        slot: { type: 'string', description: '依据来自哪个搭配位（可选）' },
        productId: { type: 'string', description: '依据来自哪件商品（可选）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, value: any) => [{ type: 'text', text: value.text }],
      },
      async execute(args: any) {
        const res = await bridge<any>('/api/prefs/propose', {
          method: 'POST',
          body: JSON.stringify({
            attr: args.attr,
            value: args.value,
            scope: args.scope ?? 'profile',
            planId: args.planId ?? null,
            evidence: {
              basis: args.basis,
              quote: args.quote,
              ...(args.planId ? { ref: args.planId } : {}),
              ...(args.slot ? { slot: args.slot } : {}),
              ...(args.productId ? { productId: args.productId } : {}),
            },
          }),
        })
        const rec = res?.record ?? null
        const head =
          res?.action === 'create'
            ? `已记为待确认：${rec?.attr ?? args.attr} = ${String(rec?.value ?? args.value)}`
            : res?.action === 'update_pending'
              ? `已更新原有待确认提议：${rec?.attr ?? args.attr} = ${String(rec?.value ?? args.value)}`
              : `未新增：${res?.note ?? '已有相同记录'}`
        return {
          action: res?.action ?? null,
          reason: res?.reason ?? null,
          prefId: rec?.id ?? null,
          pending: rec,
          text:
            `${head}（${res?.note ?? ''}）。` +
            '待确认的提议不会改变当前推荐；需要用户到首页「个人偏好 → 待确认」点确认后才生效。',
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'crosscart_reject_pref',
      description:
        '拒绝一条待确认提议（仅在用户明确表示「这条不对 / 别记这个」时调用）。' +
        '拒绝后该提议失效，且同样的推断不会再次自动出现。已生效的偏好不能用本工具，需用首页删除。',
      parameters: {
        id: { type: 'string', required: true, description: '待确认提议的 id（可从 crosscart_list_prefs 拿到）' },
        reason: { type: 'string', description: '用户拒绝的原因（可选）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, value: any) => [{ type: 'text', text: value.text }],
      },
      async execute(args: any) {
        if (!args.id) throw new Error('需要待确认提议的 id')
        const rec = await bridge<any>(`/api/prefs/${encodeURIComponent(args.id)}/reject`, {
          method: 'PATCH',
          body: JSON.stringify({ reason: args.reason }),
        })
        return {
          id: rec?.id ?? args.id,
          rejected: true,
          text: `已拒绝：${rec?.attr ?? ''} = ${String(rec?.value ?? '')}。这条不会参与推荐，也不会再重复提议。`,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'crosscart_list_prefs',
      description: '列出已保存的全部偏好，以及每个属性当前生效的是哪一条（本次 > 长期），被覆盖 / 已失效 / 待确认的会标注。',
      parameters: {
        planId: { type: 'string', description: '可选：按某个方案判断「本次任务」是否仍然生效' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, value: any) => [{ type: 'text', text: value.text }],
      },
      async execute(args: any = {}) {
        const q = args.planId ? `?planId=${encodeURIComponent(args.planId)}` : ''
        const data = await bridge<any>(`/api/prefs${q}`)
        const prefs = data.prefs ?? []
        const pending = Array.isArray(data.pending) ? data.pending : []
        if (prefs.length === 0 && pending.length === 0)
          return { prefs: [], pending: [], groups: [], text: '还没有生效的偏好。' }
        const STATUS: Record<string, string> = {
          active: '生效中',
          overridden: '被本次要求覆盖（仍保留）',
          superseded: '已被新记录取代',
          deleted: '已删除',
          rejected: '已拒绝（AI 不再重复提议）',
          unconfirmed: '待确认（未参与推荐）',
          inactive: '所属任务已结束',
        }
        const groups = Array.isArray(data.groups) ? data.groups : []
        const lines = groups.map((g: any) =>
          `${g.attr}${g.canonical === false ? '（自定义属性）' : ''}：` +
          g.records.map((r: any) => `${r.scope === 'profile' ? '长期' : '本次'}「${String(r.value)}」${STATUS[r.status] ?? r.status}`).join('；'),
        )
        const pendingLines = pending.map(
          (p: any) =>
            `  · ${p.attr} = ${String(p.value)}（${p.scope === 'profile' ? '长期' : `仅方案 ${p.taskKey ?? ''}`}；依据：${
              p.evidence?.quote ?? '未记录'
            }）id=${p.id}`,
        )
        return {
          prefs,
          pending,
          groups,
          text:
            `已保存的偏好（生效 ${data.counts?.active ?? prefs.length} 条 / 待确认 ${pending.length} 条）：\n` +
            (lines.length ? lines.map((l: string) => `  · ${l}`).join('\n') : '  （无）') +
            (pending.length
              ? `\n待确认（不影响推荐，需用户在首页「个人偏好」里确认）：\n${pendingLines.join('\n')}`
              : ''),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'crosscart_set_scene',
      description:
        '只切换方案的场景图背景（Mode A：绝不动商品、价格、预算与购买链接）。' +
        '用户说「把这套放到东京夜晚街头 / 换成咖啡馆场景 / 看看海边效果」时用这个工具。' +
        '地点：tokyo-street / nyc-commute / paris-cafe / london-autumn / seoul-fashion / shanghai-walk / seaside / tropical-island / airport / city-travel / mountain / lakeside / cafe / bookstore / gallery / park / shopping-street / home / business / formal-dinner / friends / date / shopping-day / outdoor；' +
        'time: dawn/morning/afternoon/dusk/night；season: spring/summer/autumn/winter；weather: clear/overcast/rain/snow/indoor。' +
        '场景不适合当前穿搭（雨天没外套等）时只在回复里建议，不要自己换商品。',
      parameters: {
        planId: { type: 'string', required: true, description: '方案 ID' },
        place: { type: 'string', description: '场景地点 id（与 custom 二选一）' },
        custom: { type: 'string', description: '自由场景描述，如「雨后傍晚的代官山」（与 place 二选一）' },
        time: { type: 'string', description: 'dawn / morning / afternoon / dusk / night' },
        season: { type: 'string', description: 'spring / summer / autumn / winter' },
        weather: { type: 'string', description: 'clear / overcast / rain / snow / indoor' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, value: any) => [{ type: 'text', text: value.text }],
      },
      async execute(args: any) {
        const view = await bridge<any>(`/api/plans/${encodeURIComponent(args.planId)}/scene`, {
          method: 'POST',
          body: JSON.stringify({
            place: args.place,
            custom: args.custom,
            time: args.time,
            season: args.season,
            weather: args.weather,
          }),
        })
        const statusText =
          view.status === 'ready'
            ? '场景图已就绪'
            : view.status === 'generating'
              ? '场景图正在生成'
              : view.status === 'unconfigured'
                ? '图像生成服务未配置，界面会显示如实提示'
                : view.status === 'missing'
                  ? '这个「方案 + 场景」还没有生成图，可在页面点「生成场景图」'
                  : `场景图状态：${view.status}`
        const adaptationText = view.adaptation?.needed ? `注意：${view.adaptation.hints.join('；')}。是否调整穿搭由用户决定，你没有改动任何商品。` : ''
        return {
          planId: args.planId,
          sceneId: view.spec.sceneId,
          label: view.spec.label,
          status: view.status,
          text: [`已把场景切到「${view.spec.label}」（只改场景，商品 / 价格 / 购买链接都没变）。`, statusText, adaptationText].filter(Boolean).join('\n'),
        }
      },
    }),
  )

  // stdout 在 dsh SDK 运行时里是 JSON-RPC 协议通道，日志一律走 stderr
  console.error('[crosscart] plugin loaded: 7 tools → bridge', BRIDGE_URL)
}
