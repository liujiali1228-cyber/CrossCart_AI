# Phase 6 · 消费者端 UI/UX 产品化改造报告

日期：2026-11-19　范围：`studio/`（前端）+ `packages/bridge`（状态与上下文）+ `packages/dsh-plugin`（工具契约）+ `scripts/`（验收）
不改：排序权重、偏好硬过滤、F3 确认/拒绝/删除、F4 建方案校验、预算守卫、DeepSeek/dsh 运行时、图像模型与计费、价格与物流口径。

---

## 一、要解决的问题

改造前的页面是「工程师调试台」：一屏里同时出现「技术信息」按钮、`rev 38`、`图像 $0.29 / $8`、`演示数据`、`无购买链接`、热点描边与可信度、「待生成场景图」「变更记录（5）」「AI 可在对话中读取…」，左栏还堆着 7 个换装按钮。消费者要买东西，却先要读懂实现细节。

更严重的是一个**业务错误**：每一份新方案都自带「已拥有：深色直筒牛仔裤 $0」——用户从没说过自己有这条裤子。

（改造前：`shots/deploy/final-1440-plan.png`）

---

## 二、改造结果一览

| 项 | 改造前 | 改造后 |
|---|---|---|
| P1 偏好页 | 变更记录、机制说明、长空态 | 「我的偏好 · 已保存 N 条」+ 待确认 + 一行输入 |
| P2 类目入口 | 图下 5 个格子，含「空位」 | 右栏顶部紧凑 5 列，第二行 `添加 / 已有 / $价格` |
| P3 约束 | 顶部「技术信息」+「调整约束」常显 | 只留「调整约束 ⌄」，默认收起，展开是三个真字段 |
| P4 建议 | 7 个换装按钮常驻 | ≤3 条建议胶囊，逐条可关，聊过天自动收起 |
| P5 已拥有 | 每份新方案凭空一条牛仔裤 | 必须有用户原话凭证，二层防护 + 界面标来源 |
| P6 清单 | 名称堆叠 + 「演示数据」+ 长说明 | 缩略图/名称/到手价/入口一行，底部固定金额块 |
| P7 热点 | 描边 + 标签 + 可信度 + 修正入口 | 透明热区，点得准但看不见 |
| P8 成本 | `图像 $0.29 / $8`、账单说明 | 只剩「暂时无法生成新图」一句人话 |

---

## 三、逐项改动

### P1 个人偏好页去工作台化
- 删：`#pref-history` / `#pref-history-summary` / `#history-list`（变更记录）、区块级机制说明、表单下的 hint、长空态文案。
- 留：属性/值输入 + 保存；待确认区（`#prefs-pending`）保留并写明「确认后才会用于推荐」；每条偏好的确认/拒绝/删除按钮不变。
- 数据不删：`GET /api/prefs` 的 `all` 里旧值仍是 `supersededBy`，`check:f3` 直接断言这一点。
- 首页方案区「待生成场景图」→「更多方案」；素材归属说明（未获授权、来源 `SOURCES.md`）原样保留（合规项，不能删）。
- 文件：`studio/home.html`、`studio/home.js`。

### P2 类目按钮移到右栏顶部
- `#slot-chips` 整块从图像下方移到 `#pane-shop` 顶部的 `.shop-swap` 里，与「更换单品 · 点一下看候选」同一行组；图像下方那一行删除。
- 5 列紧凑网格（`gap:1px` + 底色当分隔线），每个格子两行：类目名 + `添加 / 已有 / $价格`，选中反白。
- 点击行为不变：`selectSlot()` 选中并打开候选抽屉，只读、零付费。
- 文件：`studio/index.html`、`studio/styles.css`、`studio/app.js`（`renderSlotChips`）。

### P3 「调整约束」轻入口
- 删 `#btn-tech` / `#tech` 整块，删 `#rev-chip`（revision 是内部并发基准）。
- `#btn-edit-plan` 带 `aria-expanded`，默认收起；展开后是 `#budget-input` / `#arrival-input` / `#ship-input` 三个真实字段，保存走原有 PATCH 并自动收起。
- 展开不遮挡人物图与输入框（`check:p6:ui` 用矩形相交断言，两档 1440/1366 都是 false）。
- 文件同上。

### P4 建议改成可关闭的轻提示
- `suggestionsFor(plan)`：超预算 → 压回预算；有空槽 → 加一件；恒有「换个场景」「外套换便宜」，`slice(0,3)`。
- 每条 `.qa-chip` = `.qa-text` + `.qa-x`；关闭记 `sessionStorage['cc.dismissedSuggestions']`，刷新不回来。
- 「显示建议」恢复入口；有用户消息后自动收起（`suggestPinned` 只在用户手动展开时为真）。
- 本来没有可建议的事时整块不占位（`#suggest` hidden），不留点不出东西的入口。
- 输入框仍固定左栏底部（`#composer` 底边 ≤ 视口高）。
- 文件：`studio/app.js`（`renderSuggestions` / `suggestionsFor`）、`studio/styles.css`。

### P5 「已拥有」状态错误
见第四节（单独根因分析）。

### P6 清单与金额
- 一行 = 56×70 缩略图 + 名称/品牌 + 到手价 + 「前往 X →」或 `已有 / 无购买页`（原因放 `title`）。
- 底部固定 `.shop-money`：总额、预算、还剩/已超、进度条、购买渠道按钮。
- 删「演示数据」标签与「N 件没有（不展示假链接）」整段；保留一句压缩后的结账提示（不做购买承诺）。
- 文件：`studio/app.js`（`renderShop` / `buyMarkup`）、`studio/styles.css`。

### P7 热点隐藏但保持可用
- `.hotspot`：`opacity:0`、无文字、无 title、无描边；低置信度仍是 `pointer-events:none`。
- 删「重新识别 / 拖框修正 / 可信度 / 命中率」入口；`#hotspot-note` 内容清空且常隐。
- 服务端识别、`body-box+color@3`、`hitArea()` 46px 扩边、面积降序层叠全未改动；`verify:stage3` B 段仍逐个热点点击命中。
- 文件：`studio/app.js`、`studio/styles.css`。

### P8 生成成本与购物支出分离
- 删：`$0.29 / $8`、模型消费、预算百分比、账单说明、「命中缓存，没花钱」。
- 留：服务端 6 张/小时与月度预算保护；额度用完时舞台一句「暂时无法生成新图」。
- 确认框：`大约 30–60 秒` / `这张已经生成过，直接打开` / `暂时无法生成`；失败按 `BUDGET_BLOCKED / RATE_LIMITED / SCENEGEN_UNCONFIGURED` 给人话。
- 商品价格、运费、预算、剩余一分钱没动（`verify` J 段与 `check:p6:ui` 都断言金额口径）。
- 文件：`studio/app.js`（`openPaidConfirm` / `handleSceneError` / `syncBudget` / `chooseScene`）。

---

## 四、P5「已拥有」状态错误：根因与修法

### 4.1 症状
任何新方案建出来都带一条 `裤装 / 已拥有 / 深色直筒牛仔裤 / $0`，用户从未说过自己有。界面还把它当事实展示（改造前截图右栏「已拥有」区块）。

### 4.2 根因：两条通路叠加

**通路一：工具示例参数成了模型的行为模板。**
`packages/dsh-plugin/src/index.ts` 里 `crosscart_create_plan` 的 `slotsJson` 示例写着：

```json
[{"slot":"outerwear","status":"to_buy","productId":"..."},
 {"slot":"bottom","status":"owned","productId":"own_dark_jeans"}]
```

模型照示例填 → 每份新方案都多一条 owned。这条不是「模型瞎编」，是我们自己教的。

**通路二：上一份方案的「已有」被注入下一轮上下文。**
`plan-context.mjs` 把所有 `status==='owned'` 都渲染成 `已有：- 裤装：深色直筒牛仔裤（不计入支出）`。模型读到就把用户当成「确实有这条裤子」，再写进新方案——自我强化，越滚越像真的。

**旁证：**
- `server.mjs` 的 `createDemoPlan()` 里硬编码了同一条 owned；
- `data/state.json` 里有 31 份历史方案带这条 owned（是**结果**，不是原因；靠删数据「修」只会让 bug 更难发现）。

### 4.3 修法：四层，全部在数据层

1. **建方案必须有凭证**（`state.mjs` `createPlan()`）：`status:'owned'` 必须在同一请求带 `ownedClaims:[{productId, quote}]`，quote 为用户原话（≥2 字）且必须对上同一个 productId；否则 `OWNED_UNDECLARED` **422，不 set / 不 persist / 不广播**。
2. **凭证记在槽位上**：`slot.ownedClaim = {quote, at}`，界面据此标「你说过已有」，审计可查。
3. **上下文分层**（`plan-context.mjs`）：只有「有 claim + 不是示例 + **这段对话里说的**」才写成 `已有（用户明确说过）`；示例/历史/上一段对话的 owned 单独一段并明写「不代表用户这段对话里说过自己拥有…不要自动沿用」。
4. **新开聊天划时间线**（`markNewChat` → `ws.chatEpochStart`）：`POST /api/chat/reset` 刷新时间点，之前记下的 claim 降级为历史。这是「新开聊天」用例可判定的关键。

配套：插件参数说明与示例改为 `to_buy` / `empty`，新增可选 `ownedClaims`；`crosscart_list_catalog` 增加「已有单品占位」段（把 `own_dark_jeans` 这类 ID 暴露给模型，但明确标注「不代表用户真的有」）——否则用户真说了「我有一条牛仔裤」时，模型拿不到 productId，只能放弃这一位（第三次真机跑就是这样，补上后才通过）。

### 4.4 证据

```
# 未声明 → 422，方案数不变（90 → 90）
$ curl -X POST /api/plans -d '{"slots":[{"slot":"bottom","status":"owned","productId":"own_dark_jeans"}]}'
{"error":"「裤装」被标成「已拥有」，但用户这次没有说过自己拥有它","code":"OWNED_UNDECLARED",
 "hint":"只有用户明确说过…并在 ownedClaims 里带上他的原话；否则按 to_buy 或 empty 提交。","details":{"slot":"bottom",...}}

# 声明 → 200，槽位带原话
{"planId":"pln_097", "slots":[… {"slot":"bottom","status":"owned",
  "ownedClaim":{"quote":"我有一条深色牛仔裤","at":"2026-11-19T08:54:47.172Z"}}]}
```

真实模型三轮回放（`docs/P6-owned-对话记录.json`）：
1. 「我下周去东京玩三天，预算 200 美元…」→ 0 个 owned，回复里也没有替用户声称「你已有某件」；
2. 「我家里已经有一条深色直筒牛仔裤了…」→ owned 出现，凭证 = 用户原话；
3. 新开聊天后「帮我出大阪四天方案」→ 0 个 owned。

### 4.5 明确没有做的事
- 没有删历史方案（`check:p6:owned` 断言带 owned 的方案数 ≥31 不减少）；
- 没有把标签藏起来当修复（数据层拒绝写入，界面只是如实标来源）；
- 没有无条件继承（新建方案、新开聊天、示例方案三条都不继承）；
- 演示方案保留它自己的「已有」位，但走同一条规则、带「示例方案：假设你已有一条…」的凭证。

---

## 五、改动前后截图

| 场景 | 改造前 | 改造后 |
|---|---|---|
| 桌面 1440 | `shots/deploy/final-1440-plan.png` | `shots/phase6/plan-1440x900.png` |
| 桌面 1366 | —（旧版无这一档） | `shots/phase6/plan-1366x768.png` |
| 桌面 1920 | — | `shots/phase6/plan-1920x1080.png` |
| 约束展开 | — | `shots/phase6/constraints-1366x768.png` |
| 手机 390 | `shots/deploy/final-390-plan.png` | `shots/phase6/ui-390-plan.png`、`ui-390-shop.png` |
| 偏好区 | `shots/f3/panel-prefs-1440-before.png` | `shots/phase6/ui-home-prefs.png` |
| 公网新首屏 | — | `shots/deploy/plan-1440.png`（17:25 更新）、`shots/phase6/demo-1440-pln005.png`、`demo-390-shop.png` |

首屏实测（`shots/phase6/report.json`）：

| 视口 | 类目入口底边 | 清单首行 y | 金额块底边 | 横向溢出 |
|---|---|---|---|---|
| 1440×900 | 150 | 206 | 777 | 0 |
| 1366×768 | 150 | 206 | 645 | 0 |
| 1920×1080 | 150 | 206 | 957 | 0 |
| 390×844 | 150 | 204 | 669 | 0 |

---

## 六、功能仍然可用（不是靠删功能换布局）

- 建方案（首页一句话）、换件、锁件、候选（相似/更便宜/更快）、切场景（只换背景）、自定义场景、保存副本、分享链接；
- 清单里的详情/购买入口、金额三态、到货判断、风险提示；
- 偏好：新增、确认、拒绝、删除、注入上下文、影响排序（软加分 ≤0.10）、硬排除；
- AI 对话 + 工具调用 + 公网口令与限流。

---

## 七、测试结果

| 套件 | 结果 | 说明 |
|---|---|---|
| `npm test` | 141/141 | core 9 套 + scenegen |
| `check:p6:owned` | **44/44** | 新增，确定性；六种情形全覆盖 |
| `check:p6:ui` | **84/84** | 新增，真浏览器；1440/1366/390 + 首页 |
| `check:p6:dialog` | **9/9** | 新增，真实 DeepSeek 三轮 |
| `verify` | 46/46 | 主工作台 A–H |
| `verify:stage3` | **145/145** | 隔离实例 + mock 图像，零费用 |
| `check:f4` | 50/50 | 建方案硬约束 |
| `check:f3` | **72/72** | 闭环 + 首页偏好 UI |
| `check:f2` | 15/15 | 偏好换件排名 |
| `check:context` | 24/24 | 上下文注入 |
| `check:prefs` | 9/9 | 偏好 UI（隔离实例 8791） |
| `check:home` | 18/18 | 首页 UX |
| `check:public` | 24/24 | 公网链路（真模型、真口令、真限流） |

### 断言变更（3 处，均已说明理由并换成消费者行为断言）

| 脚本 | 旧 | 新 | 理由 |
|---|---|---|---|
| `verify-stage3` A | 页面明确告知「已自动识别」（`#hotspot-note`） | 不展示识别说明 + 热点透明无文字 + 后端热点数据仍在 | P7 要求隐藏识别过程 |
| `verify-stage3` C/F | 确认框写明「约 $0.29 / 费用待确认」 | 说清「大约 30–60 秒」且不含金额/额度 | P8 要求生成成本不上消费者界面 |
| `verify-stage3` H | 胶囊含「图像 $」+ 账单说明 | 胶囊出现、文案不含金额/额度数字 | 同上 |
| `check-f3` I | 展开 `#pref-history` 看到 light 被取代 | 页面无该块 + API `all` 里 light 仍 `supersededBy` | P1 删除审计视图，数据未删 |

`verify:stage3` 的 140 → 145 是因为上述断言「1 条拆成 3 条」，不是放宽。

---

## 八、已知问题与没做的事

1. **公网隧道域名会变**：本次重启只换了进程、没换隧道，地址仍是 `https://incredible-drugs-month-occurred.trycloudflare.com`；隧道若断开重连，域名会变（新地址写入 `.tmp/tunnel-url.txt`）。
2. **旧数据仍带历史 owned**：`data/state.json` 31 份、`data-demo` 3 份历史方案里那条牛仔裤仍在（这是修复前留下的真实记录），界面按「历史数据」如实标注，不冒充用户声明；没有为了好看去删。
3. **单实例共享状态**：演示环境多人同时改偏好会互相覆盖，无多用户隔离。
4. **偏好区没有「已保存」的分组说明**：现在是一行一条 + 来源标签，属性多时会显得平；后续可按「长期 / 仅本方案」分组。
5. **方案列表仍无删除按钮**（`DELETE /api/plans/:id` 已存在，只缺入口）。
6. **首页主视觉约 950KB 未按带宽压缩**（Phase 4.1 素材，未动）。
7. **热点「不确定」区域现在完全不可见**：用户点不到那件，只能走右栏类目按钮；这是「不误导」的取舍，代价是覆盖率。
8. **`verify:stage3` 存在一个历史 flake**：E 段末尾从巴黎切回主方案时偶发 `#stage-img` 20s 未可见（本次 4 跑中出现 1 次，与本次改动无关）；已加诊断输出 `⚠ E 回主方案时图不可见`，失败时打印视图/状态并截图，便于定位。
