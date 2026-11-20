# CrossCart AI 技术设计文档

> 版本 v0.1 ｜ 2026-11-16 ｜ 目标平台：DeepSeek Harness (dsh) 0.2.x developer preview  
> 范围：首版「旅行穿搭」闭环，含方案生成、点图换件、偏好记忆、费用与到货判定、轻量评测。

---

## 0. 结论先说

**可以，而且 dsh 是目前少见的、能力面和这个项目几乎一一对应的 harness。** 但成立的前提是三条边界划对：

| 判断                  | 依据                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Harness 层不需要自己写     | dsh 的 agent loop、工具注册、会话日志、UI 全是插件，`web` profile 开箱可用；你只写业务插件，不改 dsh 源码                                            |
| 「功能用 skills + 扩展」可行 | skill 是**给模型的作业指导（`SKILL.md` 按需加载）；扩展是挂进运行时的代码包（`ct`**`x.tools.register` / `defineTool`）。两者分层清晰，正好对应「流程知识」与「确定性能力」 |
| 缺扩展自己写成本可控          | 单个插件最小形态只是 `export const name` + `apply(ctx)`；一个业务插件通常 200–500 行，且注册是「可撤销副作用」，卸载自动回卷，不污染宿主                         |
| **真正的难点不在 dsh**     | 在**商品数据源（含图片授权）**、**运费/ETA 的可信度**、**「点图换一件只改这一件」的确定性**。前两个是数据问题，第三个是架构问题——本文用「结构化方案对象 + 操作式变更 + 服务端校验」解决           |

三条必须提前接受的现实约束：

1. **dsh 是 preview**（0.1.x → 0.2.x 期间事件名和 payload 都改过，例如 0.2.0-rc.2 去掉 `assistant/chunk`、新增 `assistant/attempt`）。对策见 §13.2：所有 dsh 触点收敛在薄适配层，领域逻辑写成不依赖 `ctx` 的纯函数包。
2. **「点图换件」不能走模型自由重写**。只要让模型「重新输出一份完整方案」，就必然出现误改其他单品、价格重算不一致。本文把它设计成**操作（op）+ 重算（recompute）+ 校验（guard）**，模型只负责选品和解释。
3. **v1 不做「AI 场景效果图」**。用商品原图拼搭，图与商品一一对应、可点到、可审计。AI 场景图后续作为只读预览插件接入，且必须标注「非实际商品图」。

---

## 1. 目标与非目标

### 1.1 v1 必须做到（验收口径）

| #  | 能力    | 可验收的表现                                          |
| -- | ----- | ----------------------------------------------- |
| A1 | 描述任务  | 文字或图片输入 → 助手识别出用途/预算/收货地/最晚到货 → **回读确认**后才进入搭配  |
| A2 | 可视化方案 | 两套搭配图；图上每件可点；区分「已有」与「待买」；清单显示**新增支出**           |
| A3 | 点图换件  | 点某件 → 只换这一件 → 搭配图、清单、到手价、到货判断**同步更新**，其他单品字段零变化 |
| A4 | 偏好记忆  | 长期偏好可保存/查看/改/删；本次要求可临时覆盖长期偏好；再次开启任务时偏好被复用       |
| A5 | 诚实标注  | 运费、关税、到货时间缺失时标「待确认/估算」，**不得**表述为已确认             |

### 1.2 明确不做（v1）

- 不做代下单、不做支付、不做真实库存锁定（只给购买链接）。
- 不做多语言站点抓取、不做全站比价（种子目录 + 单一联盟源即可）。
- 不做多人协作方案、不做移动端原生 App（Web UI + 响应式）。
- 不做 AI 生成穿搭效果图（放到 v1.5，见 §12.4）。

---

## 2. 总体架构

### 2.1 分层：dsh 提供骨架，我们只补四层

```
┌──────────────────────────────────────────────────────────────┐
│ L4 呈现   dsh-client-ui 插件（搭配卡 / 单品抽屉 / 偏好页）      │  ← 自研
├──────────────────────────────────────────────────────────────┤
│ L3 知识   Skills：crosscart-shopping / -preference / -outfit   │  ← 自研（Markdown）
├──────────────────────────────────────────────────────────────┤
│ L2 能力   dsh 插件：catalog / pricing / shipping / plan /     │  ← 自研（TS）
│           prefs / render / guard                              │
├──────────────────────────────────────────────────────────────┤
│ L1 骨架   dsh 本体：agent-loop、tools、session-log、llm、      │  ← 直接使用
│           sandbox、approval、web-app、子 agent、调度           │
└──────────────────────────────────────────────────────────────┘
```

**一句话分工**：dsh 管「怎么跑」，插件管「算什么」，skill 管「怎么问、怎么选、怎么解释」，UI 插件管「怎么点」。

### 2.2 为什么这些放 skill、那些放插件

| 内容                 | 放哪                 | 理由                     |
| ------------------ | ------------------ | ---------------------- |
| 澄清问句的先后顺序、确认话术     | skill              | 改动频繁，业务同学能直接改 Markdown |
| 「旅行 3 天搭 2 套」的场景模板 | skill              | 属于搭配常识，随季节/目的地演进       |
| 偏好「何时建议保存、如何确认」    | skill              | 涉及对话策略                 |
| 商品检索、字段校验          | 插件（tool）           | 需要确定性、可测试、可缓存          |
| 到手价与 ETA 计算        | 插件（纯函数）            | 一分钱都不能靠模型算             |
| 方案状态变更（换件/锁定/撤销）   | 插件（service + tool） | 需要事务性、需要 diff 校验       |
| 搭配图合成与热区           | 插件                 | 图像处理不能进模型              |
| 方案卡片、点击交互          | UI 插件              | 需要在浏览器里渲染与响应点击         |

**反例（明确禁止）**：不要写一个「生成整套方案 HTML」的 skill，让模型直接吐 JSON 或 HTML。这是误改其他单品的根因。

### 2.3 运行时形态

| 场景         | 形态                                 | 命令                                                 |
| ---------- | ---------------------------------- | -------------------------------------------------- |
| 开发 / 演示    | `web` profile + 我们的 bundle         | `dsh --profile web` → `http://127.0.0.1:3080`      |
| 批量评测       | `headless` profile + eval 插件       | `dsh --profile headless "跑 evals/cases/swap.yaml"` |
| 对外 API（后续） | `sdk` profile（JSON-RPC over stdio） | 自有前端接 TS/Python SDK                                |
| 桌面端（后续）    | Electron desktop profile           | 复用同一套 bundle                                       |

v1 **不新建 profile**，直接装进 `web` / `headless` 两个官方 profile：少一层升级负担，`dsh --profile web --dump-config` 能直接确认插件真的挂上了。

### 2.4 Agent preset：把工具面收到最小

dsh 的 preset 决定「这个 agent 能看见哪些工具」。CrossCart 不需要 shell、不需要写文件，所以自建一个 preset：

```yaml
# presets/crosscart.yml（示意）
name: crosscart
persona: >
  你是 CrossCart 的跨境购物搭配助手。只做选品、搭配、报价与到货判断。
  你从不编造价格、运费、到货时间；不确定就标注待确认。
tools:
  allow:
    - skill
    - ask_user
    - catalog_search
    - catalog_get
    - plan_create
    - plan_get
    - plan_swap_item
    - plan_lock_slot
    - plan_remove_item
    - plan_render
    - prefs_resolve
    - prefs_commit
    - web_fetch          # 仅用于核实商家页面，可选
  deny: [bash, powershell, fs_write, fs_edit]
```

收益有三个：误操作面变小（模型无法 `rm`、无法改仓库）；系统提示更短（工具 schema 占 token，工具越少越省、KV cache 越稳）；评测更可复现。

---

## 3. 四条设计原则（后面所有设计都由它们推出）

### P1｜方案是结构化对象，不是一段文本

`OutfitPlan` 是唯一事实源（§5.1），存库、带 `revision`。模型只能通过 tool 读写它，不能「重新生成一版」。UI、清单、报价、ETA 全部从同一对象渲染 → 天然一致。

### P2｜LLM 选品与解释，代码做重算与约束

模型输出的是**决策**（选哪几个 SKU、为什么），代码输出的是**结果**（总价、是否超预算、能否按时到）。凡是可以算的，一律不经过模型。

### P3｜「未知」是一等状态，不是 0

价格三态：`confirmed / estimated / unavailable`。运费、关税、ETA 各自独立带状态与来源。预算与到货结论由状态推导，`unavailable` 必须向上传染为「待确认」，禁止静默当 0 或当「包邮」。

### P4｜偏好带作用域，优先级由代码裁决

|                          |                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| 每条偏好记录带 \`scope: profile | task`。解析时 `task > profile > default\`，并把「谁赢了、依据哪一轮」写进方案约束。**本次覆盖长期偏好不靠模型自觉，靠 resolver。** |

---

## 4. dsh 触点地图（每个插件只碰少数 seam）

dsh 把可替换能力叫 seam：服务定义（谁声明接口）、提供者（谁实现）、消费者（谁用）。我们的插件全部按「自己声明 seam + 内置默认 provider」写，未来换供应商只换一行配置。

| 我们声明的 seam     | 默认 provider        | 消费者                        | 未来可换           |
| -------------- | ------------------ | -------------------------- | -------------- |
| `ctx.catalog`  | `seed-sqlite`      | catalog tools、plan 插件的候选检索 | 联盟 API、MCP 商品源 |
| `ctx.shipping` | `rule-based`       | pricing                    | 物流商 API、货代报价   |
| `ctx.pricing`  | 纯函数                | plan、UI                    | —              |
| `ctx.plans`    | `sqlite`           | plan tools、UI host route   | 远端方案服务         |
| `ctx.prefs`    | `sqlite`           | prefs tools、resolver       | 云端账号体系         |
| `ctx.render`   | `sharp + onnx(抠图)` | plan 插件、UI                 | 云渲染            |

| 我们用到的事件（只读）                     | 用途                           |
| ------------------------------- | ---------------------------- |
| `tools/pre-execute`（waterfall）  | Guard：拦截越界方案操作、拦截超预算写入       |
| `tools/post-execute`（waterfall） | Guard：检查返回里是否出现「未确认却说已确认」的文案 |
| `crosscart/plan-updated`（自定义）   | UI 增量刷新卡片                    |
| `session/event`                 | 评测回放时重建对话事实                  |

> ⚠️ 事件与 payload 在 preview 期会变。**唯一允许在插件里出现 dsh 事件名的地方是 `packages/adapters/*`**，其余代码只吃我们自己的领域事件。

---

## 5. 领域模型

### 5.1 OutfitPlan（核心对象）

```jsonc
{
  "planId": "pln_7Q2...",
  "revision": 7,                     // 每次成功变更 +1，用于乐观并发与缓存失效
  "taskId": "tsk_...",
  "label": "东京 3 天 · 方案 A",
  "scene": {
    "type": "travel",
    "destination": { "city": "Tokyo", "country": "JP" },
    "days": 3,
    "dates": ["2026-11-24", "2026-11-26"],
    "activities": ["walking", "photo"]
  },
  "constraints": {
    "budget":   { "amount": 200, "currency": "USD", "basis": "new_items_only", "source": "turn#3" },
    "arrivalBy":{ "date": "2026-11-22", "timezone": "Asia/Shanghai", "source": "turn#3" },
    "shipTo":   { "country": "CN", "city": "Shanghai", "postal": "200000" },
    "overrides":[ { "attr": "color", "value": "black", "scope": "task", "source": "turn#9" } ]
  },
  "slots": [
    {
      "slot": "outerwear",            // outerwear|top|bottom|shoes|bag|accessory
      "status": "to_buy",             // owned | to_buy
      "locked": false,                // 锁定后不参与自动替换
      "reason": "浅色短款风衣，拍照出片；与已有深色牛仔形成对比",
      "item": {
        "productId": "sku_9f1",
        "title": "Lightweight Trench Coat, Ivory",
        "image": {
          "main":   "asset://sku_9f1/main.jpg",
          "cutout": "asset://sku_9f1/cutout.png",
          "hotspot": [0.12, 0.06, 0.62, 0.58],   // 归一化 x,y,w,h，供 UI 点选
          "attribution": { "source": "seed", "license": "merchant-authorized" }
        },
        "price":    { "amount": 89, "currency": "USD", "status": "confirmed",
                      "source": "catalog:sku_9f1", "fetchedAt": "2026-11-16T10:12:00Z" },
        "shipping": { "fee": 12, "currency": "USD", "status": "estimated",
                      "etaDays": [5, 9], "etaDate": "2026-11-25",
                      "source": "rule:us-cn-standard", "note": "不含目的国关税" },
        "duty":     { "amount": null, "status": "unavailable",
                      "reason": "需按类目与申报价计算，v1 不估算" },
        "url": "https://example.com/p/sku_9f1"
      },
      "alternatives": ["sku_2ab", "sku_77c", "sku_31d"]
    }
  ],
  "cost": {
    "currency": "USD",
    "lines": [
      { "label": "外套", "amount": 89, "status": "confirmed" },
      { "label": "运费", "amount": 12, "status": "estimated" }
    ],
    "newItemsTotal": { "amount": 165, "status": "estimated" },
    "budget": { "limit": 200, "remaining": 35, "status": "estimated", "verdict": "within_budget" }
  },
  "arrival": {
    "verdict": "at_risk",             // on_time | at_risk | late | unknown
    "earliest": "2026-11-25",
    "latest":   "2026-11-29",
    "deadline": "2026-11-22",
    "blocking": ["sku_9f1 运费与时效未确认"]
  },
  "ops": [
    { "opId": "op_1", "type": "swap_item", "slot": "outerwear",
      "from": "sku_old", "to": "sku_9f1", "turn": "turn#11", "at": "2026-11-16T10:20:00Z" }
  ],
  "render": { "version": 7, "image": "asset://plan/pln_7Q2/r7.png", "canvas": [1200, 1600] },
  "createdAt": "2026-11-16T10:10:00Z",
  "updatedAt": "2026-11-16T10:20:00Z"
}
```

**关键约定**

- `revision` 是唯一版本号；渲染图文件名带 revision，天然做缓存。
- `hotspot` 存在方案里而不是图里 → 点选坐标稳定，缩放不错位。
- `status` 三态在**每一个**金额和 ETA 上独立存在，不做「整体已确认」的偷懒合并。
- `ops` 是变更流水，天然支持「撤销一步」和评测时「这次到底改了什么」。

### 5.2 Preference（偏好）

| 字段                         | 说明                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `attr`                     | `size.top` / `size.bottom` / `size.shoes` / `color.like` / `color.avoid` / `style.tag` / `avoid.fit` / `budget.default` / `shipTo.default` |
| `value`                    | 结构化值，如 `{ system: "JP", size: "M" }`                                                                                                       |
| `scope`                    | `profile`（长期）/ `task`（本次）                                                                                                                  |
| `confidence`               | `stated`（用户明说）/ `inferred`（多次选择推断，需确认）                                                                                                     |
| `evidence`                 | `{ sessionId, turnId }`，写入必带                                                                                                               |
| `confirmedByUser`          | 布尔。为 false 的记录不参与解析                                                                                                                        |
| `createdAt` / `lastUsedAt` | 用于「久未使用」降权与清理建议                                                                                                                            |

解析优先级（`ctx.prefs.resolve(taskId)`）：

```
task 且未过期  >  profile 且 confirmed  >  默认值
```

返回结构带 `winner` 与 `overridden: [...]`，方案生成时把 `overridden` 写进 `constraints.overrides`——**这就是「本次要求覆盖长期偏好」的机器可验证证据**。

### 5.3 CatalogItem（种子目录）

```jsonc
{
  "productId": "sku_9f1",
  "title": "Lightweight Trench Coat, Ivory",
  "category": "outerwear/trench",
  "attributes": { "color": "ivory", "fit": "regular", "material": "cotton-blend",
                  "style": ["minimal", "photo-friendly"], "season": ["spring", "autumn"] },
  "sizes": [{ "system": "US", "label": "M", "stock": 3 }],
  "price": { "amount": 89, "currency": "USD" },
  "weightG": 720,
  "images": [{ "path": "main.jpg", "kind": "main" }, { "path": "worn.jpg", "kind": "worn" }],
  "source": { "type": "seed", "license": "merchant-authorized", "verifiedAt": "2026-11-01" }
}
```

---

## 6. 关键流程

### 6.1 新建任务：澄清 → 确认 → 组套 → 渲染

```
用户: "下周去东京玩三天，想搭两套好走路又适合拍照的衣服。
      我已经有深色牛仔裤，新买的东西最多花 200 美元，出发前要收到。"
        │
        ▼
[skill: crosscart-shopping]
  step1 抽槽位 → scene / budget / arrivalBy / shipTo / owned
  step2 缺什么问什么（最多 3 个问题，一次问完，可跳默认）
        └─ 图片输入 → 走 image_ingest（若有附件通道）或工作区文件路径
  step3 【强制】回读确认卡片：「东京 11/24–11/26 · 2 套 · 预算 200 美元 ·
        11/22 前到上海 · 已有深色牛仔」→ 用户点「对」才继续
        │
        ▼
[skill → tool] catalog_search × N（按 slot 类目并行）
[skill → tool] plan_create(planA) / plan_create(planB)
        │   ↓ 插件内部（无模型参与）
        │   pricing.recompute → shipping.estimate → guard.validate
        │   render.compose（抠图 + 排版模板 + 热区）
        ▼
[UI] 两张 OutfitCard 依次出现：预算条 / 搭配图（可点）/ 清单 / 到货结论
[skill] 一句话解释取舍（「A 更出片但到货风险高；B 更稳但偏素」）
```


**硬规则（写进 skill 正文，不靠模型记性）**

- 未确认前不得调用 `plan_create`。
- `plan_create` 的入参必须来自本轮用户话语或已确认卡片，不得自行补默认值（`shipTo` 缺失时必须问）。
- 一次最多出 2 套方案；每套 4–6 件；每套至少 1 件 `owned`（否则不是「用已有物品搭配」）。

### 6.2 点图换一件：两条路径，都不让模型重写方案

**路径 A｜直接换（无自然语言，最快）**

```
UI 点外套 → SwapPopover「换一件 / 锁定 / 看详情」
  → 选「换一件」→ POST /crosscart/plan/:id/swap { slot, strategy: "similar|color:light" }
  → ctx.plans.applyOps(planId, rev, [{ type: "swap_item", slot, strategy }])
  → 候选打分（确定性）→ 取 top1 应用 → 重算 cost/arrival → guard 校验只改了 1 个 slot
  → emit crosscart/plan-updated → 卡片局部刷新（图 + 清单 + 预算 + 到货）
  → 300ms 内返回「已换成 X，+$12，仍在上限内；到货 11/25（估算）」
```

**路径 B｜点选 + 一句话（有意图）**

```
UI 点外套 → 输入框出现 chip「[外套]」+ 候选提示（浅色/更便宜/更快到）
  → 用户："换成浅色的，其他保留"
  → 模型读 chip 上下文 → 调 plan_swap_item({ planId, slot: "outerwear",
                                             intent: { color: "light" },
                                             expect: { only: ["outerwear"] } })
  → 插件执行 + 校验 → 返回 diff（改了什么/没改什么/新报价/新到货结论）
```

**swap 的确定性算法（插件内，纯函数 + 一次写库）**

| 步 | 动作 | 失败处理 |
|---|---|---|
| 1 | 校验 slot 存在、未 `locked`、planId/revision 匹配 | 返回 `STALE_REVISION`，UI 拉最新 |
| 2 | 候选集 = catalog 同 slot 类目 ∩ 硬约束（预算/性别/尺码有货） | 空集则返回「无满足条件替代」，并给放宽建议 |
| 3 | 打分：颜色匹配 0.40｜价格适配 0.20｜到货达标 0.25｜风格契合 0.15 | 记录分数到 `ops[].score`，便于复盘 |
| 4 | 应用单条 op，**只替换该 slot 的 `item`** | — |
| 5 | 重算 `cost` / `arrival` | 任何 `unavailable` 向上传染为 `at_risk/unknown` |
| 6 | Guard 断言 `changedSlots.length === 1`，否则回滚 | 回滚并记 `crosscart/guard-blocked` 事件 |
| 7 | revision+1、落库、emit、异步重渲染 | 渲染失败不影响方案可用性（旧图 + 「重绘中」） |

> 这一步是整套设计的地基：**「只改一件」不是提示词约束，是数据库层的事实**。评测里直接断言 `diff.slots`。

### 6.3 偏好写入：建议 → 确认 → 落库

```
用户: "我平时喜欢浅色，帮我记住"
  → skill 判定为 profile 级陈述
  → prefs_propose({ attr: "color.like", value: "light", scope: "profile", confidence: "stated" })
  → UI 内联确认卡（可改可删）→ 用户确认
  → prefs_commit({ proposalId, confirmedByUser: true, evidence: { turnId } })
```

| 情形 | 作用域 | 处理 |
|---|---|---|
| 「我平时/以后都喜欢浅色」 | profile | 直接建议保存 |
| 「这次婚礼要穿黑色」 | task | 只写 `constraints.overrides`，prompt 明示「本次优先」，不动长期偏好 |
| 用户连续 3 次选同一特征 | profile | 建议保存，**必须**用户确认（`confidence: inferred`） |
| 用户说「记住我不喜欢紧身」 | profile（`avoid.fit`） | 保存后进入**硬过滤**，候选集直接排除 |

**`prefs_commit` 的入参校验**：没有 `confirmedByUser === true` 直接拒绝。防止模型「自作主张记住」。

### 6.4 到手价与到货判定（纯函数）

```
itemLandedCost(item) =
    price.amount            (status: price.status)
  + shipping.fee            (status: shipping.status)
  + duty.amount             (status: duty.status)        // v1 恒 unavailable
  → line.status = weakest(price, shipping, duty)          // confirmed > estimated > unavailable
```

状态合并用**最弱者**，不是「有值就算」。因此：

- 有运费但无关税 → 整行 `estimated`，文案必须带「不含关税」。
- 完全没运费报价 → `unavailable`，清单显示「运费待确认」，**不计入** `newItemsTotal`，且预算条显示「已知部分 $X / 上限 $200（可能上浮）」。

到货判定：

```
if (任一待买单品 shipping.status === "unavailable")  verdict = "unknown"
else if (max(etaDate) <= deadline)                    verdict = "on_time"
else if (max(etaDate) - deadline <= 3d)               verdict = "at_risk"   // 可能赶得上
else                                                   verdict = "late"
```

文案白名单：只有 `on_time` 可以说「能赶上」；`at_risk` 只能说「可能赶得上，建议选更快的物流」；`unknown` 必须说「到货时间待确认」。

---

## 7. 插件清单（12 个，含自研/复用判断）

| # | 包 | dsh 形态 | 挂载点 | 职责 | 代码量级 |
|---|---|---|---|---|---|
| 1 | `@crosscart/dsh-catalog` | service + tool provider | `ctx.catalog`、`ctx.tools` | 假设目录声明、种子 SQLite provider、`catalog_search` / `catalog_get` | M |
| 2 | `@crosscart/dsh-shipping` | service provider | `ctx.shipping` | 规则式 ETA/运费估算，返回三态 + 来源 | S |
| 3 | `@crosscart/dsh-pricing` | service | `ctx.pricing` | 到手价/预算/到货判定纯函数封装 | S |
| 4 | `@crosscart/dsh-plan` | service + tool provider | `ctx.plans`、`ctx.tools` | 方案 CRUD、`applyOps`、revision、撤销、SQLite 持久化 | L |
| 5 | `@crosscart/dsh-prefs` | service + tool provider | `ctx.prefs`、`ctx.tools` | 偏好存储、scope 解析、propose/commit 两段式 | M |
| 6 | `@crosscart/dsh-render` | service | `ctx.render` | 抠图（onnx/rembg）+ 套版排版 + 输出热区 + 本地资产服务 | M |
| 7 | `@crosscart/dsh-guard` | waterfall 监听 | `tools/pre-execute`、`tools/post-execute` | 拦截越界 op、超预算、未确认却说已确认的文案 | S |
| 8 | `@crosscart/dsh-ui` | client 插件（`dsh.client`） | `conversation.view` 节点、`shell.overlay`、`settings.section`、host route | 搭配卡、单品抽屉、换件浮层、偏好页 | L |
| 9 | `@crosscart/dsh-bundle` | bundle | `cordis.patch.yml` | 把 1–8 行按顺序插入 + 注册 `crosscart` preset | S |
| 10 | `@crosscart/dsh-eval` | 工具 + headless 驱动 | `ctx.tools` | 跑 fixture、读 session JSONL、断言三问、出报告 | M |
| 11 | `@crosscart/seed-cli` | 离线脚本（非插件） | — | 种子商品导入、抠图批处理、版权字段校验 | S |
| 12 | `@crosscart/dsh-scene`（v1.5） | service | `ctx.render` 扩展 | AI 场景效果图，标注「非实际商品图」 | M |

### 7.1 可以直接复用的社区插件（省掉的部分）

| 需求 | 现成插件 | 怎么用 | 判断 |
|---|---|---|---|
| 技能管理/热更新 | `dsh-agent-skills`、`@ctl456/dsh-skills-manager` | 开发期用它在 Settings 里改 skill 并即时生效 | **直接用**（devDependency 性质） |
| 聊天里渲染交互卡片 | `dsh-visualize`、`dsh-genui` | M2 的原型验证：先用它把方案卡渲出来验证交互，再决定是否值得写正式 UI 插件 | **先用后替** |
| 侧边栏/工作台 | `dsh-better-sidebar` | 调试时看方案 JSON、渲染产物 | 选用 |
| 主题/外观 | `dsh-ui-appearance` | 视觉打磨阶段 | 选用 |
| 图片输入引用 | `dsh-at-file` | 用户上传「已有单品」照片时定位文件 | 选用（M0 验证） |

> 结论：**「可视化扩展」不一定第一版就自己写**。先用 `dsh-visualize` 把卡片交互跑通（一周内可见效果），等交互定型再迁到自研 UI 插件，避免在 UI 细节未定时投入过多。

---

## 8. Skills 清单

放在项目级目录（`{workspace}/.dsh/skills/`，随仓库走），或打包进 bundle 用 bundled provider 分发。

### 8.1 `crosscart-shopping`（主流程）

```markdown
---
name: crosscart-shopping
description: 用户提出跨境场景购物需求（旅行/活动穿搭、成套采购）时使用。负责需求澄清、回读确认、生成 1-2 套方案、处理换件与收尾。
---

# 何时用
用户说"去 X 玩 N 天穿什么""帮我配一套…""预算 X 什么时候能到"。

# 步骤
1. 抽槽位：scene / budget / arrivalBy / shipTo / ownedItems。
   - 图片输入先调 image_ingest，让用户确认识别到的单品与颜色。
2. 缺关键槽位才问，一次问完，最多 3 个。shipTo 与 arrivalBy 缺一不可。
3. 【硬规则】回读确认卡，用户确认前禁止 plan_create。
4. 并行 catalog_search：按 slot 类目 + 硬约束（预算上限、尺码有货、avoid 项）。
5. plan_create 两套，差异要明确（出片向 / 稳妥向），不要两套雷同。
6. 每套必须：4-6 件、至少 1 件 owned、至少 1 件 to_buy。
7. 解释只讲取舍，不复述价格明细（清单里已有）。

# 硬规则
- 不得编造 price / shipping / eta / duty。工具没返回就写"待确认"。
- 不得调用 plan_swap_item 之外的任何方式修改方案。
- 用户说"换一件"时，slot 必须来自 UI chip 或用户明确指认；不明确就问"换哪一件"。
- 一次换件只允许一个 slot；若用户要求"整体重搭"，明确告知会新建一套方案。
```

### 8.2 `crosscart-preference`

```markdown
---
name: crosscart-preference
description: 用户表达长期偏好、要求记住某事，或本次提出与长期偏好冲突的要求时使用。
---
# 判定
- "平时/以后/我一直" → scope=profile
- "这次/今天/这场婚礼" → scope=task（只写 constraints.overrides，不动长期偏好）
- 三次以上同类选择 → 建议保存，标 inferred，必须确认

# 硬规则
- prefs_commit 必须带 confirmedByUser=true；用户没点确认就不能写。
- 本次要求与长期偏好冲突时，优先本次，并在解释里说明"按你这次的要求"，不要提"你平时喜欢浅色"。
- 不主动记住敏感信息（身材评价、疾病、宗教相关的着装禁忌需用户明确要求才存）。
```

### 8.3 `crosscart-outfit-rules`

```markdown
---
name: crosscart-outfit-rules
description: 生成或评估搭配时使用。包含场景模板、色彩与比例常识、可行性检查。
---
# 场景模板
- 城市旅行 3 天 2 套：1 套步行日（舒适鞋、透气层）+ 1 套拍照日（有对比色、有廓形）
- 活动/婚礼：1 套主装 + 1 件可替换外层
# 检查清单（每套出图前过一遍）
- 鞋与总风格一致；颜色不超过 3 个主色；上宽下窄或上窄下宽选其一
- 目的地当季温度区间与面料匹配（来自 scene.destination + 月份规则）
- 已有单品与新买单品的色系能对上（否则解释为什么仍然推荐）
```

---

## 9. UI 设计

### 9.1 槽位使用

| 槽位 | 组件 | 内容 |
|---|---|---|
| `conversation.view` 自定义节点 | `OutfitCard` | 方案标题 / 搭配图（含热区）/ 清单 / 预算条 / 到货结论 / 操作条 |
| `shell.overlay` | `ItemSheet` | 单品原图、价格明细（带状态徽标）、购买链接、替换候选三选一 |
| `shell.overlay` | `SwapPopover` | 点热点后浮出：换一件（同款/浅色/更便宜/更快到）· 锁定 · 看详情 |
| `settings.section` | `PrefsPage` | 长期偏好列表，每条显示作用域、来源轮次、确认状态，可改可删 |
| 输入框 | `SlotChip` | 点选后把 `[外套]` 结构化 chip 塞进下一条消息 |

### 9.2 搭配卡布局（1200×1600 画布，等比缩放）

```
┌────────────────────────────────────────────┐
│ 东京 3 天 · 方案 A          ¥1,120 / ¥1,400 │  ← 预算条（含"估算"斜纹底）
├────────────────────────────────────────────┤
│        ┌──────────┐                        │
│        │  外套 ●待买│  ← 热区可点，右上角状态点 │
│        └──────────┘                        │
│   ┌─────┐  ┌─────┐      ┌──────┐           │
│   │ 上衣 │  │ 牛仔 │已有  │ 鞋 ●待买│        │
│   └─────┘  └─────┘      └──────┘           │
├────────────────────────────────────────────┤
│ 待买 3 件 · 新增支出 ¥1,120（含运费 ¥88 估算）│
│ ⚠ 到货：可能赶不上 11/22（最快 11/25）        │
│ [换一套看]  [导出清单]  [保存方案]            │
└────────────────────────────────────────────┘
```

**要点**

- 「已有」单品用低饱和描边 + 「已有」角标；「待买」用主色描边 + 状态点。
- 状态点三色：绿=已确认、橙=估算、灰=待确认。**不给任何单品打绿点，除非价格与运费都 confirmed。**
- 到货结论永远在清单下方单独一行，不与价格混排（这是评测断言 C 的视觉落点）。
- 换件后只重绘该热区的 `img` 与下方文字，不整卡闪烁；用 `crosscart/plan-updated.changedSlots` 决定重绘范围。

### 9.3 交互原则

| 原则 | 说明 |
|---|---|
| 点图先出操作面板，不直接换 | 裸点击猜意图必错；面板给 4 个明确策略 |
| 面板放画布下方，不做浮动层 | 浮层会盖住刚点的那件，用户恰恰要判断「换了还搭不搭」。原型阶段已改成画布下方的面板，选中态由描边承担 |
| 换件必须可撤销 | `ops` 栈支持 undo，卡片右上角出现「撤销」5 秒 |
| 任何金额都带状态 | 不出现「¥1,120」这种无来源裸数字 |
| 空/缺数据不隐藏 | 「运费待确认」比空着更可信 |
| 方案可变但不可动 | 用户不能手改价格；只能换件/锁定/移除 |

---

## 10. 数据源方案（三个待议问题之一）

### 10.1 首批商品数据从哪来

| 方案 | 优点 | 缺点 | 适用 |
|---|---|---|---|
| **A. 自建种子目录**（推荐 v1） | 图片授权可控、字段齐全（重量/尺码/面料）、可离线跑评测 | 人工选品成本；覆盖窄 | 首发 300–500 SKU，5 个类目 |
| B. 联盟开放 API（PA-API / Rakuten / AliExpress） | 数据新鲜、有分成 | 需过审、图片使用受限、返回字段不全（常缺 ETA）、评测不可复现 | v1.5 作为第二 provider |
| C. MCP 商品源插件 | 接入快、可换供应商 | 能力受限（MCP 只桥接 tool，不带 resources/prompts）、依赖第三方稳定性 | 只做补位 |

**推荐落地**：`ctx.catalog` 双 provider。v1 只启用 `seed-sqlite`；bundle 里预留 `affiliate-api` 行（注释掉），过审后一行配置切换。这样「商品数据从哪来」不阻塞开发，也不锁死未来。

种子集规格（v1）：

- 5 类目：外套 / 上衣 / 裤装 / 鞋 / 包，各 60–100 SKU。
- 每 SKU：主图 + 白底图（或可抠图）+ 重量 + 尺码表 + 3 个场景标签 + 授权字段。
- 覆盖 3 个收货地（上海/北京/深圳）× 2 种物流档（标准/加急），用于 ETA 规则标定。

### 10.2 运费与到货时间从哪来

v1 没有实时物流 API，**必须诚实**：

- 用规则表：`(仓库国, 目的国, 物流档, 重量段) → { fee, etaDays[低,高] }`，标 `estimated`。
- 只有商家页面明确写「Ships to CN, 3-5 business days, $12」并被抓取核实时，才可升为 `confirmed`，且必须存 `source: url + fetchedAt`。
- 关税恒 `unavailable`（v1 不估算），文案统一「不含目的国关税，可能产生额外费用」。

这条规则直接服务评测 C：**系统在结构上就无法把未知说成已确认**。

### 10.3 偏好首版保存哪些字段（三个待议问题之二）

必存（7 项，覆盖 80% 场景）：`size.top`、`size.bottom`、`size.shoes`、`color.like`、`color.avoid`、`style.tag`、`shipTo.default`。
选存：`budget.default`、`avoid.fit`、`avoid.material`。
不存：身材尺寸明细、价格敏感度评分（先观察，不做推断型画像）。

### 10.4 搭配图上最重要的操作（三个待议问题之三）

按优先级只做 4 个：**① 点单品换一件（含 4 个策略）② 锁定单品（不再被换）③ 看原图/价格明细/购买链接 ④ 撤销上一步**。
「整套换风格」「分享给朋友」放 v1.5。

---

## 11. 评测设计

dsh 的 session log 是 append-only 事件流，`resume / fork / replay` 共用同一条流——这正是「轻量 AI Studio 回放」的天然实现：**不用另建评测框架，回放就是重跑同一串事件并断言产物**。

### 11.1 三个断言的可执行形式

| 断言 | 做法（fixture + 断言） | 判定 |
|---|---|---|
| **A. 换一件不误改其他** | fixture：5 件方案，脚本触发 `swap_item(outerwear)`；比对 `before/after` 的 plan JSON | `diff.changedSlots == ["outerwear"]` 且 `revision == before+1` 且 `sum(lines) == newItemsTotal`（误差 0）。任一不满足即 fail |
| **B. 本次要求覆盖长期偏好** | fixture：profile=`color.like:light`，用户说「这次婚礼要穿黑色」 | ① resolver 单测：解析结果 `winner.scope == "task"`；② 方案断言：`constraints.overrides` 含 `color=black`；③ 文案断言：解释中不出现「你平时喜欢浅色」这类反向表述（关键词黑名单 + LLM judge 打分） |
| **C. 缺失信息不被误报** | fixture：某单品无运费报价、无 ETA | ① 结构断言：`shipping.status == "unavailable"`，`arrival.verdict == "unknown"`；② 文案断言：消息中不得出现「包邮/免运费/保证到达/预计X天送达/一定能赶上」，且必须出现「待确认」类词；③ 渲染断言：该单品状态点非绿色 |


### 11.2 运行方式

```
evals/
  cases/
    swap_isolation.yaml        # A
    task_scope_override.yaml   # B
    unknown_shipping.yaml      # C
    regression_budget.yaml     # 超预算时是否正确降级
  golden/
    swap_isolation/*.jsonl     # 人工确认过的会话快照
```

```bash
# 批量跑（headless，不起 UI，快）
dsh --profile headless "run crosscart_eval --suite evals/cases --out evals/report.json"

# 人工看一遍（Trajectory 视图按来源展开，检查上下文注入有没有污染）
dsh --profile web
```

报告输出：用例 × 断言 × 通过率 + 失败时的 diff 片段。CI 门槛：A、C 必须 100%（确定性逻辑，不允许偶发）；B 的结构部分 100%，文案部分 ≥ 0.9（judge 评分）。

### 11.3 需要额外加的两个回归点（建议）

- **D. 预算硬约束**：超预算时必须给出「降档方案」而不是静默超支。
- **E. 已有单品不被计入新增支出**：`cost.newItemsTotal` 只含 `to_buy`。

---

## 12. 工程结构

### 12.1 Monorepo

```
crosscart/
├─ packages/
│  ├─ core/                     # 纯 TS，无 dsh 依赖（可单测、可移植）
│  │   ├─ plan.ts               # 类型 + applyOps + diff
│  │   ├─ pricing.ts            # 到手价/预算/到货
│  │   ├─ prefs.ts              # resolver
│  │   ├─ ranking.ts            # 候选打分
│  │   └─ __tests__/
│  ├─ adapters/                 # 唯一允许出现 dsh 事件名/服务名的地方
│  │   ├─ dsh-plan.ts
│  │   ├─ dsh-events.ts
│  │   └─ dsh-tools.ts
│  ├─ dsh-catalog/
│  ├─ dsh-shipping/
│  ├─ dsh-pricing/
│  ├─ dsh-plan/
│  ├─ dsh-prefs/
│  ├─ dsh-render/
│  ├─ dsh-guard/
│  ├─ dsh-ui/                   # client 半区 + host route
│  ├─ dsh-eval/
│  └─ dsh-bundle/
├─ skills/
│  ├─ crosscart-shopping/SKILL.md
│  ├─ crosscart-preference/SKILL.md
│  └─ crosscart-outfit-rules/SKILL.md
├─ data/
│  ├─ seed/catalog.jsonl
│  ├─ seed/assets/              # 商品图（含授权元数据）
│  └─ shipping-rules.yaml
├─ evals/
├─ presets/crosscart.yml
└─ cordis.patch.yml
```

### 12.2 一个最小可跑的插件（对照 dsh 写法）

```ts
// packages/dsh-plan/src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { applySwap, diffPlan } from '@crosscart/core'

export const name = 'crosscart-plan'
export const inject = ['tools', 'catalog', 'pricing', 'render']   // 缺这行会在 ctx 未就绪时跑

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'plan_swap_item',
    description:
      '只替换方案中指定 slot 的单品并重算费用与到货判断。' +
      '用户点选单品要求更换时使用。一次只允许换一件。',
    parameters: {
      planId:  { type: 'string', required: true, description: '方案 ID' },
      revision:{ type: 'number', required: true, description: '客户端持有的版本号' },
      slot:    { type: 'string', required: true, description: 'outerwear|top|bottom|shoes|bag' },
      intent:  { type: 'object', required: false,
                 description: '替换意图，如 { color: "light" } 或 { cheaper: true }' },
      productId:{ type: 'string', required: false, description: '用户明确指定时传入' },
    },
    output: {
      schema: { type: 'object' },   // 返回 PlanDiff
      render: (_args, diff) => [{ type: 'text', text: diff.summary }],
    },
    async execute(args) {
      const plan = await ctx.plans.get(args.planId)
      if (plan.revision !== args.revision) throw new Error('STALE_REVISION')

      const next = applySwap(plan, args, ctx.catalog, ctx.pricing)  // 纯函数
      const diff = diffPlan(plan, next)
      if (diff.changedSlots.length !== 1) throw new Error('GUARD: multi-slot mutation')

      await ctx.plans.save(next)
      ctx.emit('crosscart/plan-updated', { planId: next.planId, revision: next.revision,
                                           changedSlots: diff.changedSlots })
      void ctx.render.compose(next.planId, next.revision)
      return diff
    },
  }))
}
```

### 12.3 bundle 与安装

```yaml
# cordis.patch.yml
- insert:
    - id: crosscart-catalog
      name: '@crosscart/dsh-catalog'
    - id: crosscart-shipping
      name: '@crosscart/dsh-shipping'
    - id: crosscart-pricing
      name: '@crosscart/dsh-pricing'
    - id: crosscart-plan
      name: '@crosscart/dsh-plan'
    - id: crosscart-prefs
      name: '@crosscart/dsh-prefs'
    - id: crosscart-render
      name: '@crosscart/dsh-render'
    - id: crosscart-guard
      name: '@crosscart/dsh-guard'
    - id: crosscart-ui
      name: '@crosscart/dsh-ui'
```

```json
// packages/dsh-bundle/package.json
{
  "name": "@crosscart/dsh-bundle",
  "version": "0.1.0",
  "type": "module",
  "dsh": { "bundle": "./cordis.patch.yml" }
}
```

```bash
# 开发期：本地包直接挂（link: 会跳过部分 peer 依赖，用 file:）
dsh plugin --profile web add file:$(pwd)/packages/dsh-bundle
dsh --profile web --dump-config | grep crosscart     # 确认真的挂上了
dsh --profile web
```

### 12.4 存储

- 方案与偏好：SQLite（`better-sqlite3`），库文件放 workspace 下 `.crosscart/crosscart.db`，按 workspace 天然隔离。
- 商品种子：只读 SQLite（`data/seed/catalog.db`），构建期生成。
- 图片资产：`.crosscart/assets/{sku,plan}/`，host route `/crosscart/asset/:id` 只接受白名单路径 + loopback 校验（参考社区插件的做法：realpath 校验、拒绝 `..`、限制回环访问）。
- 会话：交给 dsh 的 session log，不自建对话存储。

---

## 13. 里程碑与验收

| 阶段 | 交付 | 完成定义（DoD） |
|---|---|---|
| **M0 骨架验证** | web profile 装上 1 个 hello 插件 + 1 个 tool；3 个 skill 目录可被 skill 工具加载 | `--dump-config` 能看到插件行；聊天里能调通 tool；skill 出现在会话目录并能读正文。**同时清掉 §14 的 8 个待验证项** |
| **M1 数据与算账** | 种子目录 300 SKU + `catalog`/`shipping`/`pricing` 三插件 + `core` 单测 | 给定 SKU 与收货地，到手价与到货结论可复现；`unavailable` 正确传染；单测覆盖 ≥ 90% |
| **M2 方案与卡片** | `plan` 插件 + `render` 抠图合成 + UI 搭配卡（可先借 `dsh-visualize` 出原型） | 一句话需求 → 两套方案卡片出现；图上每件可点到；清单新增支出正确 |
| **M3 换件闭环** | `plan_swap_item` + SwapPopover + guard 校验 + 撤销 | 点外套换一件：只有外套变，预算/到货同步更新，其他字段 diff 为空；300ms 内有反馈 |
| **M4 偏好** | `prefs` 插件 + PrefsPage + 两段式确认 | 长期偏好可存/改/删；本次覆盖长期偏好在方案里有 `overrides` 记录；第二次开任务时偏好被复用 |
| **M5 评测** | `dsh-eval` + 5 个 fixture + 报告 | A/C 100%，B 结构 100%、文案 ≥0.9；报告可在 CI 跑 |

依赖关系：M0 → M1 → M2 → M3 → M4，M5 从 M2 起可并行搭骨架。

---

## 14. M0 必须验证的 8 件事（决定后面返工量）

| # | 待验证 | 为什么重要 | 若否的退路 |
|---|---|---|---|
| 1 | dsh 版本 pin（0.2.x）与 web profile 是否支持**图片附件**输入 | 「上传已有单品照片」是核心入口 | 走工作区文件路径 + 自建 `image_ingest` tool 读文件 |
| 2 | 自定义 tool 的**结构化返回值**能否被自定义 UI 节点消费 | 决定卡片是「从 tool result 渲染」还是「从事件流渲染」 | 统一走 `crosscart/plan-updated` + host route 拉数据（本文默认方案） |
| 3 | client 插件注册 **host route** 的方式与鉴权 | 搭配图、资产需要 HTTP 通道 | 资产写成 data URL 内联（大图不推荐）或落文件用现有文件预览 |
| 4 | **抠图性能**（CPU onnx，单图 P95） | 6 件 × 2 套 = 12 次推理，慢就卡顿 | 构建期预抠图存 `cutout.png`，运行时只合成 |
| 5 | SQLite 放 workspace 还是 `$DSH_HOME` | 影响多 workspace 隔离与备份策略 | 放 workspace，天然隔离 |
| 6 | skill 项目级目录的确切路径与 rank | 放错目录＝skill 不生效，且很难察觉 | 用 bundled provider 打包进 bundle 分发 |
| 7 | headless profile 能否注入本地 JSON/图片输入 | 决定评测能否全自动 | 用 SDK profile + 自写 runner |
| 8 | 去掉 bash/fs 工具后，插件网络访问是否需要额外声明 | 影响 preset 与权限配置 | 在插件内用自己的 fetch，并显式声明网络需求 |

> 这 8 项建议在 M0 用一两天集中打掉：写一个 `spike/` 目录，每项一个最小脚本 + 一行结论。**不要在 M2 之后才发现图片进不来。**

---

## 15. 风险与对策

### 15.1 技术与平台

| 风险 | 影响 | 对策 |
|---|---|---|
| dsh preview 破坏性变更（事件名/payload/slot 名） | 插件随时可能编译不过或运行时不触发 | ① 锁版本 + 升级前跑全套 eval；② `packages/adapters/*` 是唯一接触 dsh API 的地方；③ `core` 零 dsh 依赖，可单测、可迁移 |
| UI 槽位能力不足（如无法在卡片内嵌交互按钮） | 交互降级 | M0 先探针；退路：`shell.overlay` 全屏浮层 + 普通 Markdown 链接 |
| 抠图质量差（浅色衣物边缘） | 视觉廉价 | 构建期人工抽检 + 对差图改用「白底原图 + 圆角卡片」降级样式 |
| 合成图坐标与显示缩放错位 | 点错件 | 热区用归一化坐标存方案里，渲染时按容器实际尺寸换算 |

### 15.2 数据与合规

| 风险 | 影响 | 对策 |
|---|---|---|
| 商品图版权 | 上线即侵权 | 种子集只用商家书面授权图；每张图带 `license` 字段，构建期强制校验；对外展示保留 `attribution` |
| 价格/库存过期 | 用户信任崩塌 | 每条价格带 `fetchedAt`；超过 24h 在 UI 打「价格可能已变」；点购买链接时二次提示 |
| 关税/时效不实 | 客诉 | v1 不估关税；ETA 只给区间并标 `estimated`；文案白名单由 guard 强制 |
| 偏好数据隐私 | 合规风险 | 只存 9 个白名单字段；本地 SQLite；提供一键清空；不存身材评价与敏感属性 |

### 15.3 成本

| 项 | 量级 | 备注 |
|---|---|---|
| LLM 调用 | 每套方案约 3–6 次 tool 往返 | 工具面收窄后 prompt 更短；方案 JSON 不进 prompt，只注入紧凑摘要 |
| 抠图 | 构建期一次性 | 运行期零推理（缓存 `cutout.png`） |
| 图片存储 | 300 SKU × 2 图 ≈ 200MB | 本地磁盘，无对象存储成本 |
| 评测 | headless 批量跑 | 用 flash 档模型跑结构断言，避免贵模型做确定性检查 |

---

## 16. 附：术语映射（你们的产品词 → dsh 概念）

| 产品文档里的说法 | dsh/本设计里的实体 |
|---|---|
| DeepSeek Harness 方向 / harness 能力 | dsh 本体（profile + bundle + patch），直接用 |
| 场景购物 Skill | `skills/crosscart-shopping/SKILL.md` |
| 可视化扩展 | `@crosscart/dsh-ui`（client 插件）+ `conversation.view` 节点 |
| 现有 v2 的预算与费用计算 | 原样搬进 `packages/core/pricing.ts`，包一层 `ctx.pricing` |
| 轻量 AI Studio 回放 | `dsh --profile headless` + `dsh-eval` + session log 回放 |
| 商品原图拼搭 | `@crosscart/dsh-render`（抠图 + 套版 + 热区） |
| 偏好记忆区分长期/本次 | `prefs.scope = profile \| task` + resolver 优先级 |
| 「点图换一件，其余同步更新」 | `applyOps` 单 slot 变更 + `recompute` + `guard` 断言 + `crosscart/plan-updated` 增量重绘 |

---

## 17. 下一步（建议顺序）

1. **拍 M0**：跑那 8 个探针，尤其第 1、2、4 项。
2. **定种子集口径**：5 类目 × 60 SKU 的选品规则 + 图片授权模板（这是最容易被低估的工作量）。
3. **先写 `core/plan.ts` 与单测**：`applyOps` / `diff` / `pricing` 三件套确定后，插件只是薄壳。
4. **M2 用 `dsh-visualize` 出原型**，交互定型再写正式 UI 插件。
5. **评测先行**：三问的 fixture 在 M2 就写好，避免「功能做完了才发现改不动」。
