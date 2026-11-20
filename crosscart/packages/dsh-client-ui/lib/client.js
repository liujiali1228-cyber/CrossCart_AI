/**
 * CrossCart 方案卡片（dsh Web UI 客户端插件）。
 *
 * 注册在 tool.call.toolview 槽位，key 为 CrossCart 的三个方案工具，
 * 于是会话里的工具调用不再是「一行 JSON」，而是一张可点的方案卡。
 *
 * 数据来源只有一处：工具结果里的 presentationMeta（output.presentationMeta 产出），
 * 它在 replay 时也随 tool/result 一起回放，所以卡片不需要请求 bridge 也能重绘。
 */
window.__ModuleLoader__.load({
  id: '@crosscart/dsh-client-ui',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    // 用 createElement（h(type, props, ...children)），bundle 里不需要 jsx-runtime
    const h = react.createElement

    const TOOL_KEYS = ['crosscart_create_plan', 'crosscart_swap_item', 'crosscart_plan_state']

    const C = {
      ink: '#23231f',
      muted: '#7a776e',
      line: '#e2ddd1',
      paper: '#fffdf8',
      primary: '#2f4a3f',
      ok: '#3b6d11',
      okBg: '#ecf3e2',
      warn: '#8a5a12',
      warnBg: '#fbf1de',
      bad: '#b4552d',
      badBg: '#fbe9e2',
    }

    function money(n) {
      if (n == null) return '—'
      return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
    }

    function pickMeta(block) {
      const meta = block && block.meta
      if (!meta || typeof meta !== 'object') return null
      if (meta.kind !== 'crosscart.plan') return null
      return meta
    }

    function Badge({ text, tone }) {
      const tones = {
        ok: { bg: C.okBg, fg: C.ok },
        warn: { bg: C.warnBg, fg: C.warn },
        bad: { bg: C.badBg, fg: C.bad },
        plain: { bg: '#f1efe8', fg: C.muted },
      }
      const t = tones[tone] ?? tones.plain
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 999,
            fontSize: 11,
            lineHeight: '17px',
            background: t.bg,
            color: t.fg,
            whiteSpace: 'nowrap',
          },
        },
        text,
      )
    }

    function Thumb({ slot }) {
      const hasImage = Boolean(slot.image)
      return h(
        'div',
        {
          title: slot.title ? `${slot.label} · ${slot.title}` : `${slot.label} · 空位`,
          style: {
            position: 'relative',
            width: 62,
            height: 62,
            borderRadius: 10,
            background: '#f3efe6',
            border: `1px solid ${C.line}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            flex: '0 0 auto',
          },
        },
        hasImage
          ? h('img', {
              src: slot.image,
              alt: slot.title ?? slot.label,
              style: { width: '86%', height: '86%', objectFit: 'contain', mixBlendMode: slot.sourceKind === 'live' ? 'normal' : 'multiply' },
            })
          : h('span', { style: { fontSize: 11, color: C.muted } }, '空位'),
        h(
          'span',
          {
            style: {
              position: 'absolute',
              left: 3,
              bottom: 2,
              fontSize: 9,
              color: C.muted,
              background: 'rgba(255,253,248,.86)',
              padding: '0 3px',
              borderRadius: 4,
            },
          },
          slot.label,
        ),
      )
    }

    function PlanCard(props) {
      const meta = pickMeta(props.block)
      if (!meta) {
        return h(
          'div',
          { style: { fontSize: 12, color: C.muted, padding: '4px 0' } },
          'CrossCart：本步骤没有可渲染的方案快照',
        )
      }

      const over = meta.verdict === 'over_budget'
      const arrivalTone =
        meta.arrivalLabel === '能赶上' ? 'ok' : meta.arrivalLabel === '无法确认' ? 'plain' : 'warn'

      return h(
        'div',
        {
          style: {
            border: `1px solid ${C.line}`,
            borderRadius: 14,
            background: C.paper,
            padding: '12px 14px',
            maxWidth: 620,
            fontFamily: 'inherit',
            boxShadow: '0 1px 2px rgba(35,35,31,.05), 0 8px 20px rgba(35,35,31,.05)',
          },
        },
        // header
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontWeight: 600, fontSize: 14, color: C.ink } }, meta.label),
            h('span', { style: { fontSize: 11, color: C.muted } }, `${meta.planId} · rev ${meta.revision}`),
          ),
          h(
            'a',
            {
              href: meta.studioUrl,
              target: '_blank',
              rel: 'noreferrer',
              style: {
                fontSize: 12,
                color: C.primary,
                textDecoration: 'none',
                border: `1px solid ${C.line}`,
                borderRadius: 8,
                padding: '3px 9px',
                background: '#fff',
                whiteSpace: 'nowrap',
              },
            },
            '打开可视化方案 ↗',
          ),
        ),
        // thumbnails
        h(
          'div',
          { style: { display: 'flex', gap: 8, margin: '10px 0' } },
          (meta.slots ?? []).map((slot) => h(Thumb, { key: slot.slot, slot })),
        ),
        // stats
        h(
          'div',
          { style: { display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5, color: C.ink } },
          h('span', null, h('b', { style: { fontSize: 17, fontWeight: 600 } }, money(meta.total)), h('span', { style: { color: C.muted } }, ` / 预算 ${money(meta.budgetLimit)}`)),
          h(
            'span',
            { style: { color: over ? C.bad : C.ok } },
            over ? `已超 ${money(Math.abs(meta.remaining))}` : `剩余 ${money(meta.remaining)}`,
          ),
          h(Badge, { text: meta.arrivalLabel + (meta.arrivalLatest ? ` · 最晚 ${meta.arrivalLatest}` : ''), tone: arrivalTone }),
          h(Badge, { text: `截止 ${meta.deadline}`, tone: 'plain' }),
        ),
        h(
          'div',
          { style: { fontSize: 11, color: C.muted, marginTop: 8 } },
          '点缩略图上方的按钮可进入可交互方案页：点单品即可换，费用与到货实时重算。',
        ),
      )
    }

    const toolview = {
      name: 'crosscart-plan-card',
      inject: ['slots'],
      apply(ctx) {
        for (const key of TOOL_KEYS) {
          ctx.slots.inject('tool.call.toolview', () =>
            ctx.slots.register({ name: 'tool.call.toolview', key }, PlanCard),
          )
        }
      },
    }

    exports.name = toolview.name
    exports.inject = toolview.inject
    exports.apply = toolview.apply
    return module.exports
  },
})
