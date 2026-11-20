# CrossCart AI

跨境场景购物搭配助手（首个场景：旅行穿搭）。

**一个页面把「和 AI 说要什么」和「看着实物做决定」合成一件事**：左边聊需求，中间是**一个穿着这套方案、站在具体场景里的人**，右边看钱和到货。点她身上的外套就能换，整套搭配、待买清单、到手价和到货判断同步更新；页面改完，AI 下一句话读到的就是新方案。换场景只换背景，不动商品、价格与链接。

访问：<http://127.0.0.1:8790>（`npm run studio` 启动）

---

## 1. 三个面板，一份状态

```
┌──────────────┬───────────────────────────┬──────────────────┐
│  ① 对话       │  ② 场景穿搭                 │  ③ 购物决策        │
│  和 AI 说需求  │  写实人物穿着这套方案         │  费用 / 到货 / 清单 │
│  7 个工具调用  │  点身上的衣物直接换           │  选一件才出详情     │
└──────────────┴───────────────────────────┴──────────────────┘
```

- **桌面**：三栏并排，`grid: 336px minmax(0,1fr) 348px`，中间画布最宽。
- **移动（≤1023px）**：单栏 + 底部切换条（对话 / 搭配 / 清单），三块内容都保留，不砍功能。
- **为什么不是 iframe 嵌 dsh Web UI**：那样会有两套滚动、两套输入框、两套状态。这里把 dsh 当**会话引擎**用（SDK 子进程），UI 全自己画。

---

## 2. 怎么跑起来

```bash
# 依赖（Node ^20.19 || >=22）
npm install && npm run build

# 启动统一工作台（首次会拉真实商品，约 5–15 秒）
npm run studio     # http://127.0.0.1:8790

# 选一个长期/临时公开入口
npm run demo         # 8796：带口令 + 限流，数据 data-demo/（对外测试用）
npm run serve:public # 8797：无口令 + 限流 + 公开模式，数据 data-public/（P9 起的公开入口）
npm run tunnel 8797  # 另开终端：公网隧道，地址写进 .tmp/tunnel-url.txt（重启即变）

# 正式服务器怎么部署、数据放哪、反向代理怎么写：见 docs/DEPLOY.md

# 可选：单独的 dsh Web（工具与聊天内卡片也能用）
dsh web --patch packages/dsh-plugin/cordis.yml   # http://127.0.0.1:3080/?token=...
# 可选：接自己的图像生成服务（不配就只显示已缓存的场景图，并如实标注未配置）
# SCENEGEN_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
# SCENEGEN_API_KEY=...
# SCENEGEN_MODEL=doubao-seedream-4-0-250828
```

`npm run studio` 一个进程同时提供：静态页面、方案 API（HTTP + SSE）、聊天 API，以及它内部拉起的 **dsh SDK 子进程**（`dsh --profile sdk`）。所以对话面板开箱可用，不需要额外再开一个 dsh。

仓库自带 `data/scenes/` 里 12 张已生成的真实场景图，**不配图像 API 也能完整体验**：切到这些已缓存的地点会直接命中缓存（同一套商品 + 同一场景 = 同一个键）。

一次性准备（换机器才需要）：

```bash
npm install -g @deepseek-ai/dsh@0.2.2-rc.1
npm install -g pnpm
dsh plugin --profile web add file:<仓库绝对路径>/packages/dsh-client-ui
# 容器/托管：不用手改路径，dsh-patch.mjs 启动时按当前仓库位置重写插件路径；
# 密钥只从环境变量进：DEEPSEEK_API_KEY → scripts/provision-dsh-credentials.mjs 写 $DSH_HOME/.credentials.yaml
```

---

## 3. 架构：一份状态 + 一个会话引擎

```
        ┌────────────────────── 浏览器：studio/ ──────────────────────┐
        │  ① 对话面板        ② 搭配画布          ③ 购物决策面板        │
        │      │ SSE chat      │ HTTP/SSE plan     │ HTTP/SSE plan     │
        └──────┼───────────────┼───────────────────┼───────────────────┘
               ▼               ▼                   ▼
        ┌──────────────── packages/bridge（唯一事实源）────────────────┐
        │  state.mjs   方案/偏好/目录 + 只读视图投影（viewModel）        │
        │  chat.mjs    dsh SDK 子进程：stdio JSON-RPC，事件转 SSE        │
        │  server.mjs  HTTP + SSE + 静态站点                            │
        └───────────┬───────────────────────────────┬─────────────────┘
                    │ import（同一份纯函数）          │ stdio JSON-RPC
                    ▼                               ▼
        packages/core（无 IO、无模型）        dsh --profile sdk --patch ...
        建方案/换件/算钱/判到货/购买入口       packages/dsh-plugin（6 个工具）
                                              → 工具回调 HTTP 打回 bridge
```

三条不破的规矩：

1. **页面不重算金额**。Studio 只渲染 `viewModel()` 的投影；所有数字来自 `packages/core`。
2. **换件是确定性操作**。`applySwap` 只替换一个 slot，重算后用 `diffPlan` 断言 `changedSlots.length === 1`，不满足就抛 `PlanError`，绝不落库一份改乱的方案。
3. **页面和 AI 是同一份数字**。AI 不读聊天记录里的商品文字——每条用户消息附带 `<crosscart-context>`（当前方案快照 + 费用拆分 + 到货 + 购买入口 + 规则），工具本身又写回同一份状态。

### 3.1 对话框到底连了什么

不是重新实现大模型调用，用的是 dsh 自带的 SDK profile：

```
bridge → spawn('dsh --profile sdk --patch packages/dsh-plugin/cordis.yml')
       → initialize {provider, model, approvalRequests:false}
       → session/query → session/prompt {content:[{text:用户话}, {text:<crosscart-context>}]}
       ← session.event: turn/start · tool/call · tool/result · assistant/message · turn/end
```

事件映射成前端的三样东西：文本气泡、工具 chip（同名折叠成「浏览商品目录 ×5 ✓」）、状态行。

- **停止** = 真杀子进程（`taskkill /PID /T /F`），已落盘的方案不受影响；下一句自动重启 + `session/resume` 接上历史。
- **新对话** = 重置 session，方案不删。
- **stdout 只走协议帧**，插件里任何日志都打 `console.error`（踩过：`console.log` 会把 JSON-RPC 帧搞坏）。

---

## 4. 接口（Studio 与 AI 工具共用）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/health` | 服务、目录、聊天子进程状态（设了访问口令时匿名只回 `{ok,authRequired}`） |
| GET | `/api/demo` | 测试版自述：版本、是否隔离数据、限流、图像服务能力、已知限制（不含密钥） |
| GET | `/api/catalog?category=&colorFamily=&maxPrice=&q=` | 目录查询（真实商品 + 种子） |
| POST | `/api/catalog/refresh` | 重新拉真实商品 |
| GET/POST | `/api/plans` | 方案列表 / 新建。**新建会先过硬约束**：违反已确认的尺码 / 避开品牌 / 避开词 → `422 PREF_CONFLICT`（带 `details.violations` 与 `actions`），**不落库**；响应带 `prefConflicts/prefExempt/prefApplied/prefChecks/prefExceptions`。用户明确授权破例时传 `prefOverride: { rules, quote }`（只对这套方案生效） |
| GET | `/api/plans/:id` | 方案只读视图（逐项费用、购买入口、风险、变更记录） |
| GET | `/api/plans/:id/candidates?slot=&strategy=&sort=` | 候选（差价 / 到货 / 适配理由 / 购买入口）。**偏好生效时**额外返回 `excluded`（被硬排除的商品与原因）/ `applied`（正在参与排序的规则）/ `relaxed`（仅表示软规则无区分度）/ `blockedBy`（明确排除把候选排空时的原因，**不放宽**）/ `unmapped`（认不出、未参与计算的偏好值）；每个候选带 `prefBonus` 与 `prefWhys` |
| POST | `/api/plans/:id/swap` | 换件（`by: 'ui' \| 'ai'`）。响应 `prefRanking`：排除了什么、生效了哪些规则、以及 `picked`（这件拿多少加分、有偏好/无偏好的名次），用于区分「加分但名次没变」和「因偏好成为首选」 |
| POST | `/api/plans/:id/lock` `/remove` | 锁定 / 移除 |
| POST | `/api/plans/:id/constraints` | 改预算 / 最晚到货 / 收货地 |
| POST | `/api/plans/:id/fit-budget` | 自动降到预算内（确定性贪心） |
| POST | `/api/plans/:id/duplicate` | 另存为 |
| GET/POST | `/api/prefs` | 偏好读写。GET 返回 `prefs`（**只含已确认且生效**）/ `pending`（AI 推断待确认）/ `all` / `groups`（含 active·overridden·superseded·deleted·rejected·unconfirmed·inactive）/ `counts`，可用 `?planId=` 判定「本次任务」是否仍成立；**`brief` = 下一轮对话会注入模型的原文（≤6 行，未确认/已删除/过期的不在里面）**。POST 是**覆盖式写入**（同 attr + 同 scope + 同 taskKey 只保留最新一条，旧记录标 `supersededBy` 保留历史；**未确认的写入不得取代已确认记录**） |
| POST | `/api/prefs/propose` | **AI 提议**：必须带 `evidence {basis, quote, ref?}`，写入 `confirmedByUser=false`。返回 `action ∈ create / update_pending / skip_duplicate / skip_rejected` —— 同值不新增、同槽位不同值就地更新、拒绝过的同值不再出现。**提议不影响任何推荐** |
| PATCH | `/api/prefs/:id/confirm` | 用户确认（覆盖式：同槽位其他活记录标 `supersededBy`，旧值进历史） |
| PATCH | `/api/prefs/:id/reject` | 用户拒绝待确认提议（记 `rejectedAt`，同值提议以后不再出现；已生效的偏好只能删除） |
| DELETE | `/api/prefs/:id` | 软删（写 `deletedAt`，历史保留，解析时不再生效） |
| GET | `/api/scenes?planId=` | 场景库（按目的地推荐 + 全部地点） |
| POST | `/api/plans/:id/scene` | 切场景（Mode A，服务端断言商品不变） |
| POST | `/api/plans/:id/scene/regenerate` | 重新生成当前场景图 |
| GET/POST | `/api/chat`、`/api/chat/stop`、`/api/chat/reset` | 对话快照 / 发消息 / 停止 / 新对话 |
| GET | `/api/events` | SSE：`plan.updated` / `plan.created` / `catalog.updated` / `scene.updated` / `chat` |

---

## 5. 购买入口：链接从哪来，凭什么敢放按钮

`packages/core/src/purchase.ts` 是唯一判定处，纯函数，四态：

| 状态 | 条件 | 界面 |
|---|---|---|
| `buyable` | `https` + 店铺在白名单 + 路径形如 `/products/<handle>` | 「前往商家购买」，新标签打开 |
| `owned` | 该搭配位标了已有 | 「已拥有」，不给购买按钮 |
| `no_link` | 演示种子数据（`sourceKind==='seed'`，example.com） | 「演示数据 · 无购买链接」，**不渲染按钮** |
| `untrusted` | 域名不在白名单，或链接是分类页/搜索页 | 「链接未经核实」，**不渲染按钮** |

- 链接**只取商品数据的 `url` 字段**，绝不按商品名拼搜索链接。
- 白名单：`www.everlane.com` / `www.allbirds.com` / `rothys.com` / `www.cuyana.com`，且必须落在商品详情路径上——分类页不算。
- 目前 112 件真实商品都是店铺公开 `/products.json` 里的商详页，SKU 与颜色由店铺页面承接，按钮下方固定写「颜色与尺码请在商家页面再次核对」。
- **按店铺汇总的购物清单**：`purchaseGroups()` 聚合到店铺，带小计、可下单件数、缺失运费件数；同店多件只跳一次。
- **推荐池也守这条线**：`rankCandidates()` 一旦发现本类目存在「真实可下单」候选，就把演示数据整批排除——演示件更便宜、到货更快，不排除的话排序总把它推上来，最后整份方案都变成没有链接的演示款（这是实测踩到的）。本类目确实没有真实候选时才回退，界面上照旧标「演示数据 · 无购买链接」。

---

## 6. 预算与到货：不许把未知当 0

费用卡把四类钱分开写，绝不合并成一个「到手价」：

| 行 | 状态来源 | 展示 |
|---|---|---|
| 商品小计 | 店铺挂牌价 | 已确认 |
| 运费 | 店铺级估算 | 估算（缺失时写「X 件运费待确认」） |
| 已确认其他费用 | 用户填的 | 已确认 |
| 关税 / 税费 | 不估算 | **待确认，不计入** |
| 可计算总额 | 上面相加 | 明写「不含待确认费用」 |

- `costBreakdown()` 返回 `knownTotal` + `knownTotalStatus` + `unknownFees[]`；`weakest()` 三态合并取弱者，**关税不参与合并**（否则每行都变「待确认」）。
- **硬预算**：$200 预算 vs $342 总额 → 风险横幅红色写明超出 $142，并给「调整至预算内」按钮 → `fitBudget()` 从最贵的待买位开始换更便宜候选（跳过锁定），换不动就如实返回原因，不会假装成功。
- **到货**：收货地 `shipTo` 与旅行目的地分离，`planContext` 明确要求「旅行目的地不等于收货地址，不确定必须问」；到货区间 + 判定（`ok` / `late` / `unknown`）分开写。
- AI 侧同样受约束：预算守卫在 `applySwap` 里，超出预算是**程序拒绝**，不是提示词请求。超额方案上换更便宜件是允许的，但必须在 `diff.summary` 写明「仍超预算 $X」。

---

## 7. 换件交互

点某个搭配位的「换一件」→ 右侧滑出抽屉：

- 三个策略（更便宜的 / 更快到的 / 同风格）+ 排序（推荐 / 价格 / 差价 / 到货）
- 卡片含实拍图、店铺、价格、差价、到货区间、适配理由、购买入口状态
- 锁定位置不给候选；同一商品去重；无候选时明写「没有符合条件的替代商品 —— 原方案保持不变」
- 确认后**只改这一个搭配位**，画布高亮变化，费用 / 到货 / 变更记录立刻重算，toast 说明改了什么
- 卡片上的差价是**到手价之差**（`lineTotal − 当前这件 lineTotal`，含运费），换完后总额的实际变化必须与它一致——验收脚本会比对，差 1 美元都算失败（早期版本用「当前商品价」当基准，把当前运费漏算，差价虚高了一档）

抽屉宽度 = 右栏宽度（`position: fixed; right: 0; width: var(--shop-w)`），**只盖住右栏，中间的搭配画布始终可见**——验收脚本会量 `canvasBox.right <= drawerBox.x`。

---

## 8. 场景系统：人物穿搭图 + 衣物热点

中间不再是「五个商品格子」，而是**一个穿着当前方案的人，站在一个具体场景里**；点她身上的外套就能换外套。

**场景是组合出来的，不是几张固定模板**：`地点 × 季节 × 时间 × 天气`

- 24 个地点种子（城市生活 6 / 旅行度假 6 / 日常 6 / 活动 6），也可自由描述（`custom`）
- `sceneId = place.season.time.weather`，例如 `tokyo-street.autumn.night.rain`
- 标签自动组装：「东京街头 · 秋夜晚 · 雨天」；地点不认识就**报错**，不会悄悄换成别的地方
- 提示词只从结构化方案生成（`buildScenePrompt(plan, spec)`），**不解析聊天文字**：每件待买的颜色 + 材质/版型 + 类目 → `garmentPhrase()`，再拼全身构图、镜头、光影一致性、反塑料感

**缓存按内容寻址**，换商品或换场景键就变，不会拿旧图冒充新搭配：

```js
sceneCacheKey(plan, spec) = hash(排序后的 "slot:productId:color" 列表 + '#' + sceneId)
```

**两个场景模式，权限边界不同**：

| 模式 | 触发 | 允许改什么 | 硬约束 |
|---|---|---|---|
| A 只换场景 | 点「切换场景」 | 只换背景图 | 商品 ID 数组必须完全相等，否则抛 `SCENE_MUTATED_PLAN`；`revision` 不变 |
| B 场景不适配 | 雨天/雪天等 | 只在提示条里**建议** | 用户点「让 AI 建议调整」才会发消息，确认前不动任何商品 |

适配规则在 `checkAdaptation()`：雨天查外套是否防雨材质、雪天查保暖，只产出 `hints`，绝不自己动手换。

**点衣物换装是确定性的，不按坐标猜商品**：每个槽位对应一个归一化矩形（`Region{x,y,w,h}`），逐图人工核对；命中用面积最小者优先（鞋子 > 上衣 > 外套），重叠时点到的永远是更小的那块。图片按容器等比算出 2:3 画框（`fitStageFrame()`），**不做 cover 裁切**，否则热点会和像素错位。触屏没有 hover，热点常驻一层淡虚线保证看得见。

**五种状态都画出来，不装**：`ready` / `generating`（转圈 + 可回到商品图）/ `error`（重试）/ `missing`（生成按钮）/ `unconfigured`（写清缺哪几个环境变量，给「切到商品图」）。换件后旧图仍在，但角标写「搭配已更新，此图还是上一版」，遮罩写「搭配已更新」——**不假装已经重画**。所有场景图常驻角标「AI 模拟穿搭 · 仅供效果参考」+ 模型名。

**图像生成能力可配置，不绑死服务**（本仓库不内置任何密钥）：

```bash
SCENEGEN_BASE_URL=https://api.openai.com/v1   # 官方或任何 OpenAI 兼容网关
SCENEGEN_API_KEY=sk-...
SCENEGEN_MODEL=gpt-image-2.6-sunburst         # 或 gpt-image-2.6-flare（更快更便宜）
SCENEGEN_REFS=openai                          # openai=参考图走 /images/edits 保人物一致；doubao=URL 放 image 字段；none=纯提示词
SCENEGEN_QUALITY=medium                       # low/medium/high，控制成本
SCENEGEN_PROXY=http://127.0.0.1:7897          # 需要出海代理时填；留空=直连
```

也可写 `data/scenegen.config.json`（已 gitignore，见 `data/scenegen.config.example.json` 的字段说明）。**没配置时运行时就停在 `unconfigured`，如实报告缺什么，绝不用静态图冒充生成结果。**

OpenAI 参考图模式的行为：有上一版场景图就把它作为编辑底图（保人物与构图），真实商品图一并上传（还原料与色）；提示词附加「只改描述里提到的部分，其余保持」的约束。每次调用会记录耗时与 usage tokens 到服务端日志，便于核算真实成本。

**实测（`scripts/try-openai-scenegen.mjs`，gpt-image-2.6-sunburst / medium / 1024×1536）**：

| 操作 | 耗时 | image in | text in | out | 估算成本 |
|---|---|---|---|---|---|
| 5 张商品图 → 东京街头全身人像 | 39.2s | 7541 | 253 | 1132 | ≈ $0.096 |
| 以人像为底，只换外套 | 36.1s | 3041 | 107 | 1132 | ≈ $0.059 |
| 以人像为底，只换场景（巴黎） | 39.5s | 1536 | 121 | 1132 | ≈ $0.047 |

按官方价（图像输入 $8 / 文本输入 $5 / 图像输出 $30 每百万 token）。产品内实测：切到一个没缓存的地点 → 42s 出图并自动进缓存；换件后点「重新生成场景图」→ 45s 出图，人物与场景保持、只有外套变。

本仓库里 `data/scenes/` 这 6 张图是开发时用 WorkBuddy 图像生成工具真实生成、逐张人工核对热点后登记的（提示词就是实际用的那份，没美化）。生成后用首张图作 `image1` 参考 + `input_fidelity:high` 重生了两张服装跑偏的，让六张图里是同一身衣服。单张成本约 5–10 积分（约 ¥0.5–1），2:3 竖图约 2.2–2.7MB。

---

## 9. 真实商品从哪来

Shopify 店铺公开的 `/products.json`（店铺主题自己在用，无账号无密钥）：

| 店铺 | 类目 | 件数 |
|---|---|---|
| Cuyana | 包 / 少量外套 | 20 |
| Rothy's | 鞋 | 29 |
| Allbirds | 鞋 | 14 |
| Everlane | 外套 / 上衣 / 裤装 | 49 |

合计 **112 件真实商品**：真实名称、真实挂牌价、真实尺码、真实商品图（`cdn.shopify.com`）、可打开的商详页。

两个工程坑：

1. **Node 的 fetch 会被 Cloudflare 判 bot（429）**，同 URL 用 curl 正常 → 先 fetch，非 2xx 回退 `curl --compressed`，都失败才用缓存。
2. **金额双闸**：请求带 `&country=US`；收数侧按类目合理性区间过滤（包 20–700 / 鞋 20–500 / 外套 30–900 / 裤 20–400 / 上衣 10–400）。单店越界 >35% 且 ≥8 件判「这家店这次口径不可信」，整店跳过并标 `priceSuspect`。
   背景：曾出现「$118 的杯垫返回 815」（本地货币混入且无币种字段），直接当 USD 用会算出 $3,455 的外套。
   原则：**宁可少几件候选，也不让猜出来的金额进账单。**

---

## 10. 测试与浏览器验收

```bash
npm test             # 141 个确定性单测
npm run verify       # 真实浏览器跑 A–H（真实场景图、真实商品、390px），产出截图
npm run verify:stage3 # 144 项第三阶段验收（隔离实例 + mock 图像服务，零费用）
npm run check:f3     # 偏好闭环：提议→确认/拒绝/删除 + 首页真实点击（隔离实例，72 断言）
npm run check:f4     # 建方案硬约束 + 破例 + 换件解释 + UI 契约（隔离实例，50 断言）
npm run check:f4:dialog # 真实 DeepSeek 三场景：记住 / 临时换件 / 改主意（会产生少量模型费用）
npm run check:p9     # P9 专项 70 项（自有单品 / 无二次确认 / 去链接 / 首页外链，隔离实例）
npm run check:p9:dialog # P9 真实模型 + 真实生图（会产生少量费用）
npm run check:p10    # P10 专项 32 项（全新目录启动 / 重启恢复 / .bak 回退 / 按 IP 限流 / 管理接口 / 密钥不外泄）
npm run check:public -- <url> [口令]  # 公网业务链路 27 项（访问保护/硬约束/对话/布局/持久化）
npm run check:prefs  # 偏好接口/首页偏好区（需先起隔离实例 8791）
npm run check:context # 偏好是否真的进了模型上下文（不起服务、不调模型）
npm run check:f2     # 偏好是否真的改变候选/换件（含守卫、预算、task 隔离）
npm run check:home   # 首页 UX 18 条（需 studio 在跑）
npm run check:p6:ui  # 消费者端首屏契约 84 条（1440 / 1366 / 390）
npm run report:f2    # 生成 docs/F2-候选差异报告.md（Before/After，440 组 top1 扫描）
npm run shots        # 只重拍交付截图
```

`npm test`（141/141）：第一阶段 35 个（方案创建 / 单件隔离 / 预算 / 配送 / 状态往返 / 无候选与锁定 / 购买入口四态与白名单 / 按店铺聚合 / 费用拆分 / `fitBudget` / 推荐池真实商品优先），第二阶段新增 11 个场景断言——sceneId 确定性（同输入同 ID）、未知地点**抛错**、自定义场景稳定 ID、提示词含全部颜色与类目与 full-body、缓存键随商品与场景变化、适配检查只产出提示不改方案、热点命中面积最小者优先、推荐命中目的地、`stableHash` 稳定、结构完整，外加「商品下架后仍能换回换件前那件」。

`npm run verify`（A–H，46 项断言全通过）：

| 场景 | 断言 |
|---|---|
| A 默认场景 | `/scenes/*.png` 真实图、商品槽位板不出现、热点数 = 已选单品数、无遮罩、场景名可见、「AI 模拟穿搭」角标在 |
| B 点衣物换装 | 命中测试采样点衣物 → 右栏出该件详情 → 换一件 → 确认 → **只改这一件**、rev +1、费用重算、旧图标「搭配已更新」、换回后复位 |
| C 仅切场景 | 商品 ID / 总额 / 预算 / 购买链接 / revision **全部不变**，页面已换图（Mode A 不改方案） |
| D 场景适配 | 雨天服务端给 hints、页面出提示条、提供「让 AI 建议调整」入口、**未确认前不动任何商品** |
| E 多场景差异 | 5 张图内容哈希互不相同、sceneId 唯一（不是同一张背景换文字） |
| F 商品真实性 | 提示词含全部 5 件待买商品颜色、要求 full-body、记录模型名、画面带 AI 角标、右栏 5 件真实商品可核对 |
| G 回归 | 锁定位 409 `SLOT_LOCKED` 且拒绝后 revision 不变、AI 侧换件走同一份状态并 SSE 同步到页面、购买链接全落在白名单商详页、页面无 JS 报错 |
| H 390px | 无横向溢出、场景图完整可见（473px 高）、热点可点、能进换件、场景面板可开、清单无溢出 |

截图由脚本产出（`shots/`）：`scene-default.png`（默认场景整页）、`scene-hotspot-select.png`（点衣物 → 热点框 + 右栏详情）、`scene-picker.png`（场景面板：地点 × 时间 × 季节 × 天气）、`scene-switched-night.png`（切场景后）、`scene-before-after.png` / `scene-multi-compare.png`（同一套衣服 6 个场景对比）、`scene-swap-candidates.png`（换件候选）、`scene-after-swap-stale.png`（换完件旧图被标「搭配已更新」）、`scene-unconfigured.png`（未配置图像服务时的如实状态）、`scene-mobile.png` / `scene-mobile-select.png`（390px）。

---

## 11. 目录

```
packages/core/                  # 纯 TS，零依赖、零 IO、可单测
  src/types.ts                  # OutfitPlan / Slot / Item / CostLine / Preference
  src/status.ts                 # confirmed | estimated | unavailable 三态合并
  src/pricing.ts                # 到手价、预算、到货判定
  src/plan.ts                   # createPlan / applySwap / diffPlan / guard / fitBudget
  src/purchase.ts               # 购买入口四态、按店铺聚合、费用拆分
  src/ranking.ts                # 候选打分与策略
  src/prefs.ts                  # profile | task 优先级解析 + 提议判重 / 依据校验
  src/pref-match.ts             # 偏好 → 硬排除 / 软加分规则
  src/scenes.ts                 # 场景组合 / 提示词 / 缓存键 / 适配检查 / 热点命中
  test/*.test.ts                # 133 个确定性断言
packages/bridge/                # 状态服务 + 真实商品源 + 对话引擎
  src/server.mjs                # HTTP + SSE + 静态站 + planContext（9 个工具）
  src/state.mjs                 # 存储 + 只读视图投影
  src/chat.mjs                  # dsh SDK 子进程 / 事件映射 / 停止与恢复
  src/live-catalog.mjs          # Shopify 公开接口 → CatalogItem
  src/scenegen.mjs              # 场景图：provider 配置 / 内容寻址缓存 / 生成任务 / 视图
packages/dsh-plugin/            # dsh 工具插件（7 个工具，走 bridge）
packages/dsh-client-ui/         # dsh 聊天内方案卡片（tool.call.toolview）
studio/                         # 三栏工作台（原生 ESM，无构建）
scripts/verify-workbench.mjs    # A–H 浏览器验收 + 截图
scripts/shoot-workbench.mjs     # 只出图（含多场景对比拼图）
scripts/seed-scenes.mjs         # 登记已生成的场景图（真实提示词 + 人工核对热点）
scripts/register-scene.mjs      # 登记单张
scripts/rekey-scenes.mjs        # 方案单品变了 → 按当前组合复算缓存键
scripts/try-openai-scenegen.mjs # OpenAI 图像 API 三步验证（生成/换件/换场景，含成本记录）
data/seed/                      # 种子目录 + 自制 SVG 图
data/live/catalog.json          # 真实商品缓存
data/scenes/                    # 场景图缓存（文件名 = 内容寻址键）+ index.json
data/state.json                 # 方案持久化
data/chat.json                  # 对话记录
demo/                           # 早期拼搭原型（保留参考）
```

---

## 12. 实现时的取舍

**视觉上「少即是多」**：Revision、`presentationMeta`、JSON 这类调试信息默认折叠在 `<details>` 里；聊天里不再复述整套商品表格（`planContext` 明确要求 3–5 行、不要表格）。第二阶段把中栏做成**一张大图**：顶部只有场景名 + 「点人物身上的衣物就能换」+ 切换场景 + 场景图/商品图切换，费用明细与风险说明收进折叠项，右栏默认只留预算 / 到货 / 清单摘要，**选中一件衣服时才展开详情 + 换一件 + 前往购买**。

**不为了好看牺牲诚实**：费用四行分开、总额标「不含待确认费用」、超预算红横幅、无购买链接就不给按钮、AI 回答与页面同一份数字；场景图常驻「AI 模拟穿搭 · 仅供效果参考」，换了件就标「搭配已更新，此图还是上一版」，没配置图像服务就写清缺哪几个环境变量——**宁可显示一个空画框，也不放一张静态图骗人**。

**为什么不做真 3D**：需求里明确不做 3D 引擎。2D 写实图 + 结构化热点已经能覆盖「看效果 + 点着换」，成本是每张几分钱而不是每次渲染；真 3D 需要建模与布料解算，且现有商品只有平铺图，没有可用的 3D 资产。

**没做的事**：衣物照片识别 / 抠图、相似图检索、数字衣橱、3D 试穿、云端账号、新增跨境平台、支付下单。场景图目前是**缓存命中**式（不是每次对话都实时重绘），运行时接上 provider 后即可自动生成。

---

## 13. 已知限制

| 限制 | 影响 | 下一步 |
|---|---|---|
| 场景图是生成图，不是这件商品的实拍 | 版型细节可能与实物有差异（模型仍可能改动衣服细节） | 界面已标注「仅供效果参考」；核对可达「换场景保穿搭、换件保人物」，但不保证像素级还原 |
| 动态生成的图用默认热点区域 | 新场景的热点可能与衣物有偏移 | 提示词固定构图（全身居中、脚可见）使默认区域基本可用；精确需人工标注 → 标注工具化 |
| 一次生成 40–90s、$0.05–0.1 | 交互上有等待，切新场景会计费 | 已有内容寻址缓存与并发去重；可加预生成队列 |
| 需要出海代理时得显式配 `proxy` | Node 的 fetch 不读 `HTTP_PROXY`，代理要写进 `SCENEGEN_PROXY` | 已用 undici ProxyAgent 支持；直连环境留空即可 |
| 商品可能从店铺目录里消失（下架/抓取口径变化） | 缓存键会随单品变化漂移，换回原商品曾报 `NO_CANDIDATE` | 已加「换件前一件」快照，回滚不再依赖在售；缓存用 `scripts/rekey-scenes.mjs` 复算 |
| 运费/时效是店铺级估算 | 到货只能到「估算」 | 接商家 shipping rates 或联盟 API |
| 只有美元区 4 家店、无亚洲码 | 品类少 | 接 Rakuten（东京）/ AliExpress（发中国），同一 provider 接口 |
| 关税恒 `unavailable` | 实际到手价仍不完整 | 接海关税率表 + 商品 HS 编码，标 `estimated` 并注明依据 |
| 候选价格区间按类目硬编码 | 会出现极端但真实的候选 | 叠加「相对当前价倍数」二次过滤 |
| 偏好只在单机 `data/state.json` | 无多用户 | 接用户维度存储 + 两段式确认写入 |
| dsh 客户端卡片是手写 bundle | 升级 dsh 需跟进 loader 格式 | 迁官方 tsdown client preset |
| 拼搭视觉是「卡片 + 画布」，无 AI 场景图 | 氛围弱 | v1.5 按张生成场景图并压「示意图」角标 |
