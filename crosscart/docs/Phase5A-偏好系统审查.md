# Phase 5A · 用户偏好与个性化推荐能力审查（只读）

> 审查日期：2026-11-18 晚 · 基线 `pln_020` · 未修改任何业务代码
> 取证方式：读真实源码 + 在 `data/state.json` 的**隔离副本**上跑真实目录（131 件商品）与真实方案，比对候选集差异
> 结论以「结果是否真被偏好改变」为准，不采信模型措辞

---

## 0. 一句话结论

**偏好目前只存在于「模型可能读一眼」这一层：它确实被读过（历史对话 3/30 次），但从未进入任何数字或候选集——同一方案、同一策略下，清空偏好与保留偏好得到的 5 个槽位候选列表**逐字节完全一致**。与此同时，写入路径有 3 个会让偏好「看似记住了、实际没生效」的缺陷（同属性二次写入被静默忽略、`task` 作用域永不过期、无删除/修改接口）。**

三条硬结论：

1. **无影响**：`rankCandidates` 的入参里没有偏好（`plan / slotId / catalog / strategy / opts`），打分只有 4 项——策略 0.40 + 到货 0.25 + 价格 0.20 + 风格 0.15，其中「风格」是与**当前单品**的 `style` 标签 Jaccard，与用户偏好无关。实测 5 个槽位（14/18/15/29/33 个候选）在「有偏好 / 无偏好」下完全一致。
2. **无注入**：发给模型的 `<crosscart-context>`（`server.mjs:83 planContext`）里**没有一个字**提到偏好；没有系统提示要求它读偏好；`crosscart_list_catalog` 的 4 个筛选参数（category / colorFamily / maxLandedUSD / limit）也表达不了「极简、中性色、不要大面积印花」这种自由文本偏好。
3. **不可归因**：历史对话里 3 次 `crosscart_list_prefs` 中，msg[5] 读完后拉目录**完全没带 colorFamily 过滤**，msg[11] 是**先拉完目录再读偏好**（结构上不可能影响那一轮的浏览）。`crosscart_save_pref` 历史调用 **0 次**——采集闭环从未被模型走过一次。

---

## A. 当前偏好系统的真实能力与数据结构

### A1. 数据模型（`packages/core/src/prefs.ts`，52 行）

```ts
type PrefScope = 'profile' | 'task'
interface PrefRecord {
  attr: string
  value: unknown
  scope: PrefScope
  confidence: 'stated' | 'inferred'
  confirmedByUser: boolean
  evidence?: { turnId?: string; sessionId?: string }   // 类型里有，实际从未写入
  createdAt?: string
}
```

- `resolveAttr(records, attr, fallback)`：**只有 `confirmedByUser === true` 的记录参与**；`task` 无条件压过 `profile`；被压过的记录进 `overridden`。
- `resolveAll(records, defaults)`：批量版本，但**当前零调用方**（只有单测与两个 dsh 工具用 `resolveAttr`）。
- 设计意图是对的（作用域 + 确认态 + 可查证覆盖），但它是**孤岛**：`grep` 全仓，消费者只有 `packages/dsh-plugin/src/index.ts:272,301`（两个工具做展示）与 `packages/core/test/core.test.ts`（2 个合成用例）。**没有任何业务函数调用它。**

### A2. 存储与持久化

- 位置：`data/state.json` 的顶层 `prefs` 数组（`state.mjs:131` 读、`:146` 写，`persist()` 全量覆写）。
- 单机、无用户维度、无会话维度、无 `id` 字段、无删除标记。
- 实测当前内容（**只有 1 条**，来自首页表单）：

```json
{ "attr": "style", "value": "极简、中性色，不要大面积印花", "scope": "profile",
  "confidence": "stated", "confirmedByUser": true, "createdAt": "2026-11-18T07:44:30.853Z" }
```

- 注意：`attr` 存的是**自由文本键 + 自由文本值**，没有任何枚举约束。

### A3. 读写接口（`packages/bridge/src/server.mjs:526-532`）

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/prefs` | 返回 `{ prefs: ws.prefs }`（全量，无分页、无过滤） |
| POST | `/api/prefs` | `ws.savePref(body)` → **无条件 push 一条新记录**，广播 `prefs.updated` |
| DELETE / PATCH / PUT | — | **不存在**（`server.mjs` 里没有任何 prefs 的删除/更新分支） |

`Workspace.savePref`（`state.mjs:277-289`）硬编码 `confidence: 'stated'`、`confirmedByUser: true`，**忽略调用方传入的任何 evidence / confidence**。也就是说：**接口层面不存在「AI 推断但待确认」这条路径**，凡是能写进去的，都已经算「用户确认」。

### A4. 工具层（`packages/dsh-plugin/src/index.ts`）

- `crosscart_list_prefs`（描述：列出全部偏好 + 当前生效哪一条，被覆盖的标注）→ 读 `/api/prefs`，用 `resolveAttr` 计算 winner。
- `crosscart_save_pref`（描述：`scope=profile` 长期 / `task` 仅本次，**只有用户明确同意才保存**）→ POST 后回一条「已保存 / 本次覆盖了长期」文案。参数 `attr` 建议值：`color_family / style / size_top / size_bottom / size_shoes / avoid`。

**词表已经分裂成三套**：

| 来源 | attr 取值 |
|---|---|
| 插件工具描述 | `color_family` / `style` / `size_top` / `size_bottom` / `size_shoes` / `avoid` |
| 首页表单（`home.html:78-84`） | `style` / `palette` / `fit` / `budget` / `avoid` |
| 单测（`core.test.ts:222`） | `color.like` |

三者只有 `style` / `avoid` 重合。任何按 attr 精确匹配的确定性逻辑，现在都会被这套漂移打穿。

### A5. 模型在什么情况下调用偏好工具（实测，非推测）

`data/chat.json`：30 条消息、6 类工具、共 47 次工具调用。

```
crosscart_list_catalog 18   crosscart_plan_state 14   crosscart_create_plan 6
crosscart_swap_item     5   crosscart_list_prefs   3   crosscart_set_scene   1
crosscart_save_pref     0
```

- 没有任何系统提示要求读偏好；`planContext` 也没有提。**读偏好是模型的偶然行为**（3/30 ≈ 10%，且集中在同一段会话）。
- 3 次读取的实际后果：
  - msg[5]（用户："我要去东京玩三天，预算 200 美元"）：先 `list_prefs`，随后 4 次 `list_catalog` **都没传 `colorFamily`**——偏好那一条自由文本没有落到任何参数上。
  - msg[7] / msg[11]（用户："帮我搭一套日常通勤的穿搭，预算 150 美元，简洁一点"）：中性色/简洁**已由用户原话给出**；msg[11] 的 `list_prefs` 排在 4 次拉目录之后，**结构上不可能影响该轮浏览**。
- 结论：记录不到「偏好改变了结果」的案例。pln_030（无风格要求）与 pln_068（有偏好）落到的商品高度同质（灰西装外套 + 奶油 T 恤 + 白鞋 + 自有深色牛仔裤），而这套组合同时也是目录里最便宜的浅色组合——**无法区分是偏好还是价格**。

### A6. 与用户 / 会话的关联

**没有。** 记录里没有 `userId`、`sessionId`、`planId`。`state.json` 只有一份全局 `prefs`，浏览器任何窗口、任何方案、任何新会话读到的都是同一份。`task` 作用域在语义上「只属于本次任务」，但**代码里没有任何键能界定「本次」**。

### A7. 冲突、修改、覆盖、删除（实测三个缺陷）

在 `data/state.json` 的隔离副本上跑真实代码（不碰基线）：

| 操作 | 期望 | 实测 | 根因 |
|---|---|---|---|
| 写 `palette=light` 后再写 `palette=dark` | 生效 `dark` | **生效 `light`** | `resolveAttr` 用 `.find()` 取**第一条**匹配；`savePref` 只 push，不做 upsert |
| 写 `palette=bright, scope=task` | 只在本次任务压过长期 | 永久压过，且**已落盘**（副本 `state.json` 里 3 条记录） | `task` 记录没有过期键，也没有方案/会话关联 |
| 删除一条偏好 | 能删 | **接口不存在**，只能手改 json | 无 DELETE 路由、无 `Workspace.deletePref` |

也就是说：**用户改主意时，系统会一直用第一次的值**——这是当前最危险的一条，因为它会让「偏好已被采纳」的假象持续存在。

---

## B. 现有推荐链路与偏好的实际作用位置

### B1. 七段取证

| 段 | 责任方 | 输入 → 输出 | 能读偏好 | 真用了偏好 |
|---|---|---|---|---|
| 1 自然语言输入 | 模型（dsh 会话） | 用户文本 + `<crosscart-context>` → 意图 | 否（上下文里没有偏好） | — |
| 2 需求解析 | **模型**（自由发挥，无结构化 schema） | 意图 → 目的地/天数/预算/到货日 | 间接（可自己调 `list_prefs`） | 3/30 次读过，**无法证明影响** |
| 3 商品检索 | `GET /api/catalog`（确定性） | category / colorFamily / maxPrice / q / limit → 商品数组 | **否**（无偏好参数） | **否** |
| 4 硬约束过滤 | 分散：`rankCandidates` 的 pool；`applySwap` 的预算守卫；`createPlan` 只校验存在性 | — | **否** | **否** |
| 5 候选排序 | `rankCandidates`（确定性，纯函数） | plan+slot+catalog+strategy → `Candidate[]`（score + whys） | **否**（签名里没有） | **否（实测 5/5 槽位候选完全一致）** |
| 6 方案生成 | **模型**直接给 `productId` 列表 → `createPlan` 只校验「商品在不在目录 / 类目对不对」 | — | 间接 | 不可归因 |
| 7 推荐解释 | 模型自述；`whys` 来自排序器（仅「浅色系 / 同色系 / 省 $x / 可按时到」四种） | — | 否 | **否** |

### B2. 关键结构：现在有**两条**选品路径，只有一条有排序

```
路径一（建方案）  用户 → 模型 → /api/catalog（4 个筛选参数）→ 模型自己挑 productId → createPlan（只校验存在性 + 重算金额）
                               ↑ 这里没有 rankCandidates，没有预算硬过滤，超预算也能建

路径二（换件）    策略/指定 → rankCandidates（4 项加权）→ 取第一个 withinBudget → applySwap（changedSlots===1 守卫 + 超预算守卫）
```

这意味着：**只改 `rankCandidates` 只会影响「换一件」，完全不影响「新建方案」**——而用户对「AI 会记住我的喜好」的预期，主要发生在路径一。这是本次审查最重要的一条工程事实。

### B3. 「三件事」的区分（只认第三种）

| 说法 | 是否成立 | 证据 |
|---|---|---|
| 模型读到过偏好 | ✅ 成立 | `crosscart_list_prefs` 实际调用 3 次，`ok:true` |
| 模型声称考虑偏好 | ⚠️ 无法确认 | 回复里从未出现「根据你的偏好」类表述；也没有反向证据 |
| 实际结果被偏好改变 | ❌ **不成立** | 真实目录 131 件、真实方案 5 槽位，`prefs=[]` 与 `prefs=[1 条]` 的候选 `(productId, score)` 序列**逐项相同**（14/18/15/29/33 条） |

复现命令（只读，不写基线）：

```bash
cd D:/aiproject/crosscart
node --input-type=module -e "
import {readFileSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {Workspace} from './packages/bridge/src/state.mjs';
import {readLiveCache} from './packages/bridge/src/live-catalog.mjs';
const tmp='.tmp/phase5a'; rmSync(tmp,{recursive:true,force:true}); mkdirSync(tmp,{recursive:true});
copyFileSync('data/state.json',tmp+'/state.json');
const ws=new Workspace({dataDir:tmp, live:readLiveCache('data/live/catalog.json')});
const keep=JSON.parse(JSON.stringify(ws.prefs));
for (const s of ['outerwear','top','bottom','shoes','bag']) {
  const a=ws.candidates('pln_020',s,'similar').map(c=>[c.item.productId,c.score]);
  ws.prefs=[];
  const b=ws.candidates('pln_020',s,'similar').map(c=>[c.item.productId,c.score]);
  ws.prefs=JSON.parse(JSON.stringify(keep));
  console.log(s, a.length, JSON.stringify(a)===JSON.stringify(b)?'IDENTICAL':'DIFFERENT');
}"
```

### B4. 目前的「硬约束」其实也不是全硬

为了后面不把权重的锅推给偏好，必须先说清现状：

- **硬**（真的会被排除）：类目不匹配、商品不在目录、`sizes.length===0`、`shipping.status==='unavailable'`（除非 `includeUnconfirmed`）、演示件让位于真实可下单件、`slot.locked`、`slot.status==='owned'`、`changedSlots===1`。
- **软**（只是扣分/加权）：**到货**（`etaScore` 0/0.5/1）、**预算**（`withinBudget` 只影响 `price` 分；真正拦住的是 `applySwap` 之后那句「仍超且更贵则拒绝」）。
- 因此「偏好不能覆盖硬约束」这条原则在代码里只能落在**pool 阶段**（先排除，再加分），不能靠「权重给小一点」来保证——权重永远无法表达「不许出现」。

---

## C. 尚未实现的关键能力

1. **偏好进入排序**：`rankCandidates` 不接收偏好，加分项里没有偏好维度。
2. **偏好进入建方案路径**：模型挑 `productId` 时没有任何结构化偏好约束（只有 colorFamily 一个可传参维度）。
3. **偏好注入上下文**：`planContext` 不含偏好，模型不去调工具就完全不知道用户喜欢什么。
4. **待确认偏好（inferred）**：接口与 `savePref` 都写死 `confirmedByUser:true`，`PrefRecord.evidence` 从未被填。
5. **一次换件 → 长期偏好的确认流程**：不存在「这个改动要不要记成偏好」的询问，也没有提议工具。
6. **修改 / 覆盖 / 删除**：只有 append；同属性二次写入静默失效；无 DELETE。
7. **task 作用域的生命周期**：没有 planId/sessionId 绑定，也没有过期或清理。
8. **偏好来源与可查证性**：无 `id`、无来源（用户设置 / AI 提取）、无「哪一轮对话」、UI 也只显示 attr/value/日期。
9. **推荐解释的偏好依据**：`whys` 只有 4 种固定文案，没有「因为你说过…」的可验证证据链。
10. **偏好冲突裁决**：同一 attr 多条记录、`avoid` 与 `palette` 互斥（既爱中性色又排除灰色）没有任何检测。
11. **尺码**：`Preference` 里没有用户尺码，方案里也没有尺码字段；`sizes.length>0` 只表示「有得选」，不代表「有你的码」。
12. **多用户**：单机 `state.json`，无账号体系（这一点只能如实承认，不能装作有）。

---

## D. 推荐的最小架构改造方案

### D1. 三条候选路线对比

| 方案 | 做法 | 优点 | 缺点 | 可验证性 |
|---|---|---|---|---|
| **A. Agent 自主** | 只把偏好写进 `planContext`，让模型自己选 | 0 额外调用；能理解「不要大面积印花」这类语义 | 不可复现、不可断言；模型可能口头说「考虑了」而结果没变；容易被价格/到货挤掉 | ❌ 只能看文案 |
| **B. 程序排序** | `prefs → rankCandidates` 权重 | 可断言（候选集差异）、可复现、零模型成本 | 只能处理结构化字段；自由文本表达不了；权重调错会翻车 | ✅ 最强 |
| **C. 混合（推荐）** | 硬性排除走 pool 过滤；审美类走有上限的加分；自由文本仍注入上下文；解释带证据 | 两类偏好各归其位；每一条都能被测试或至少被观察 | 需要一次 attr 规范化 | ✅ 大部分可断言 |

### D2. 混合方案的三层职责（不引入新 Agent、不新增服务）

```
              ┌── 硬层（pool，先跑）：avoid / 尺码 / 明确排除的品牌  → 不符合直接不入候选
PrefRecord ───┼── 软层（score，后跑）：palette / style 关键词       → 加分上限 0.10，绝不改池子
              └── 文本层（context）：自由文本原样注入 ≤6 行         → 供模型理解审美语义
```

三条不可违反的落地规则：

1. **硬层先于软层**：任何偏好加分都发生在 pool 过滤之后，所以「偏好再高也进不来被排除的商品」是**结构保证**，不是调参保证。
2. **软层有上限**：`Σ prefBonus ≤ 0.10`，且只在与 `strategy` 同向时才生效（避免「找更便宜」被偏好扭成「找更贵但符合偏好」）。`pick = 第一个 withinBudget` 的逻辑不动，预算守卫仍在 `applySwap` 里独立生效。
3. **采集只写 `inferred + confirmedByUser:false`**：`resolveAttr` 已经会忽略这类记录——「一次换件 ≠ 长期偏好」在代码里天然成立，UI 上给「记成长期偏好？」的确认入口即可。

### D3. 偏好规范化（必须先做，否则后面全白做）

把三套词表收敛成一套 canonical attr，并保留别名映射：

| canonical | 类型 | 语义 | 处理层 |
|---|---|---|---|
| `palette` | 枚举 `light/mid/dark`（可多值） | 色系倾向 | 软层加分 |
| `style` | 自由文本 + 关键词数组 | 风格（极简/运动/正式） | 软层（关键词命中 style 标签）+ 文本层 |
| `avoid` | 自由文本 | 明确不要（高跟鞋/印花/皮草） | **硬层** |
| `size_top` / `size_bottom` / `size_shoes` | 字符串 | 尺码 | **硬层**（`sizes` 不含则排除） |
| `brand_prefer` / `brand_avoid` | 字符串 | 品牌倾向 | 软层 / 硬层 |
| `budget_habit` | 数字区间 | 预算习惯 | **不进排序**（预算是任务约束，不是偏好） |

别名：`color_family→palette`、`fit→size_*`（需拆）、`palette→palette`、`color.like→palette`。

---

## E. 需要修改的具体文件、接口及工具

| 文件 | 改动 | 性质 |
|---|---|---|
| `packages/core/src/prefs.ts` | ① `CANONICAL_ATTRS` + `normalizeAttr()` 别名表；② `upsertPref(records, rec)`（同 attr+scope 覆盖，旧记录进 `supersededBy`）；③ `resolveAttr` 改为取**最新**一条（`createdAt` 最大）而非 `find` 第一条；④ `taskKey`（`sessionId` 或 `planId`）+ `isActive(rec, ctx)`，`task` 记录超出该 key 即失效；⑤ `resolveAllWithEvidence()` 返回 `{values, winner, overridden, matchedBy}` | 新增 + 修 bug |
| `packages/core/src/ranking.ts` | `RankOptions` 增 `prefs?: PrefRecord[]`；拆出 `hardFilter(item, prefs)`（avoid/尺码/品牌排除）与 `prefBonus(item, prefs)`（≤0.10）；`whys` 增「符合长期偏好：中性色」「按你的要求排除高跟鞋」 | 新增（不删旧逻辑） |
| `packages/core/src/plan.ts` | `applySwap` 把 `prefs` 透传给 `rankCandidates`；`createPlan` 增加**可选**的 `validateAgainstPrefs`（默认关，先只告警，不改拒绝语义） | 透传 + 可选校验 |
| `packages/core/test/core.test.ts` / `scenarios.test.ts` | 新增 7 组偏好用例（见 F2），断言**候选集差异**，不断言文案 | 测试 |
| `packages/bridge/src/state.mjs` | `savePref`：生成 `id`、走 `upsertPref`、记录 `source`（`user_form` / `ai_proposed` / `ai_confirmed`）、`turnId`；新增 `deletePref(id)`（软删 `deletedAt`）、`confirmPref(id)`、`prefsView()`（含 winner/overridden/来源/待确认）；`candidates()` 把 `this.prefs` 传进 `rankCandidates` | 修 bug + 新增 |
| `packages/bridge/src/server.mjs` | `/api/prefs`：GET 返回 `prefsView`；POST 走 upsert；新增 `PATCH /api/prefs/:id/confirm`、`DELETE /api/prefs/:id`；`planContext()` 增 ≤6 行偏好块（只放 resolved 生效值与待确认条数）；`/api/catalog` 增 `avoid` / `size` / `preferPalette` 三个**可选**参数 | 新增（不动既有路由） |
| `packages/dsh-plugin/src/index.ts` | `crosscart_save_pref` 改走 upsert 语义 + 要求 `scope=task` 时传 `planId`；新增 `crosscart_propose_pref`（只写 `inferred/未确认`）；`crosscart_list_prefs` 输出来源与待确认态；**不新增第 8 个以外的工具**（当前 7 个 → 8 个） | 新增 |
| `studio/home.js` + `home.html` | `#prefs-list` 每行加「待确认 / 删除」两个操作位（**不动 token、不动布局骨架、不删任何既有 id**）；保存后刷新 `prefsView` | 增量（需你确认是否允许碰首页） |
| `studio/app.js` | 候选抽屉卡片展示 `whys` 里的偏好理由（复用现有 `.cand` 结构，不新增区块） | 增量（可选） |
| `scripts/verify-prefs.mjs`（新） | 7 组对照场景的浏览器断言 + 候选集快照比对，零图像费用 | 新增 |
| `HANDOFF.md` §9 | 审查完成后补「9.6 实施记录」 | 文档 |

**不改**：`scenegen.mjs` / `regions.ts` / `cost.mjs` / `purchase.ts` / `pricing.ts` / 任何 dsh 核心源码 / 任何视觉 token。

---

## F. 分阶段实施顺序与测试方案

### F1. 顺序（每阶段独立可停）

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| **F0（不改变任何行为）** | 修 A7 三个缺陷：upsert、取最新、task 过期键、软删；canonical attr + 别名迁移（把现有 1 条 `style` 自由文本保留原样，只加 `attrRaw`） | `npm test` 78 → 85+ 全绿；现有 `verify` 46/46、`verify:stage3` 140/140 不变；`/api/prefs` 结构向后兼容 |
| **F1（只读路径打通）** | `planContext` 注入 ≤6 行偏好；`list_prefs` 输出带来源；**先只做「可观察」不做「可断言」** | 跑 2 次真实建方案，人工确认模型是否在首轮就按偏好传 `colorFamily`（记录在案） |
| **F2（确定性生效，核心）** | `rankCandidates` 接 `prefs`：硬层 avoid/size + 软层 palette/style（≤0.10）；`whys` 带偏好理由 | F2 的 7 组单测全绿；候选集差异可复现；`changedSlots===1` 守卫仍全绿 |
| **F3（采集与确认）** | `propose_pref`（未确认）+ 首页「待确认 / 删除」+ `PATCH/DELETE` | 一次换件后不写库，只有在 UI 确认后才 `confirmedByUser:true` |
| **F4（解释与验收）** | `whys` / `evidence` 透到候选抽屉与 AI 回复；新 `verify-prefs.mjs` 进 `npm run verify:all` | 46 + 140 + 新组全绿 |
| **F5（归因实验，一次性）** | 同一句需求 × 有/无偏好各跑 1 次真实对话，比对最终 `productId` 集合 | 报告「结果差异是否与软层预期一致」，费用单独记账 |

> F1 与 F2 的顺序不能反：先让偏好「可被读」，再让偏好「可被算」，否则无法区分「模型没读到」和「排序没用上」。

### F2. 7 组对照测试（全部比对**真实候选集**，不看模型是否提到偏好）

统一夹具：`pln_020`（5 件真实商品，缓存键 `gbq5vy`）+ 真实目录 131 件（116 live + 15 seed），策略 `similar` / `cheaper` 各跑一遍。

| # | 场景 | 偏好 | 断言（针对候选集，不针对文案） |
|---|---|---|---|
| 1 | 无偏好新用户 | `[]` | top-1 与今日基线**完全一致**（回归锚点：`top1` 分别 0.681 / 0.702 / 0.763 / 0.867 / 0.894） |
| 2 | 极简中性色 | `palette=light`（profile） | `palette=light` 候选平均排名上升；top-1 的 `colorFamily==='light'`；分数差 ≤0.10 |
| 3 | 鲜艳色 | `palette=dark` + `style=statement` | top-1 的 `colorFamily` 变为 `dark` 或 `mid`；**且**不出现「演示件」 |
| 4 | 拒绝高跟鞋 | `avoid=heels`（硬层） | shoes 候选集中所有 `title` 含 heel/pump 的商品**数量 = 0**；被排除项能在 `excludedBy` 里查到 |
| 5 | 偏好品牌 vs 预算 | `brand_prefer=everlane` + 预算紧到放不下 | 超预算的 everlane 商品**仍不出现**在 `pick`；硬层与预算守卫都在，偏好不得救回 |
| 6 | 当次需求 vs 长期 | `profile.palette=light` + `task.palette=dark`（带 `planId`） | 本方案 top-1 为 dark；`overridden` 含 profile 那条；**换一个 planId 后 task 记录失效**，回到 light |
| 7 | 修改 / 删除 | 先 light 后 dark；再删除 | 生效值变 dark（不是 light）；删除后回到 fallback；`deletedAt` 记录存在 |

每组都要求：**候选 `productId` 序列快照**（不只是分数），失败时输出 diff。全部是纯函数测试，零模型调用。

### F3. 额外一条「脏数据」测试

同一 `attr` 写 3 次（light → dark → light）后再 `resolve`：必须得到最后一次的值，且 `supersededBy` 链完整。**这条直接对应 A7 现在的 bug**。

---

## G. 预期模型调用成本及潜在风险

### G1. 成本

| 项 | 增量 |
|---|---|
| 读偏好（`planContext` 注入） | **0 次额外模型调用**；每轮提示词 +约 80–150 tokens（≤6 行） |
| 排序（硬层 + 软层） | **0 次**（纯函数，零网络） |
| 采集提议（`propose_pref`） | 同轮内多 1 次 tool round-trip ≈ **+1 次模型往返**（不是新会话） |
| 用户确认后写库 | **0 次** |
| 7 组对照测试 | **0 费用**（纯单测） |
| F5 归因实验 | 2 次真实对话；按历史实测每次约 11–15 次工具往返、100s 量级，**图像费用 0** |
| 图像侧 | **0**（本轮与后续偏好开发都不碰 `scenegen`） |

⚠️ 诚实说明：`chat.mjs` **目前完全没有 token 记账**（只有图像侧有 `scenegen.usage.json` ledger），所以这里只能给调用次数，给不出美元数。要报金额得先在 bridge 里加 usage 记录——那是独立小任务，不建议塞进 Phase 5。

### G2. 风险

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| 1 | **同属性二次写入静默失效**（已实测） | 用户改了偏好，系统继续用旧的，且界面显示"已保存" | F0 必修；修完前不要在任何文案里说"已记住" |
| 2 | **`task` 永不过期**（已实测） | 一次旅行的临时要求永久压过长期偏好 | F0 加 `taskKey` + 失效判定 |
| 3 | attr 词表三套并存 | 确定性过滤命中率 0，且新逻辑一上线就"什么都没匹配到" | F0 收敛 + 别名迁移 + 迁移脚本打印未识别项 |
| 4 | 自由文本偏好无法被程序使用 | 「不要大面积印花」只能靠模型 | 双写：结构化字段（可算）+ `note` 原文（可读），UI 明确哪部分是"AI 理解" |
| 5 | 只改 `rankCandidates` 就宣布完成 | 建方案路径（用户感知最强）完全没变 | D2/B2 已写明：两条路径都要接，F1 先通上下文 |
| 6 | 偏好被模型用来覆盖硬约束 | 违反 9.1 第一条原则 | 硬层在 pool 阶段 + 提示词写"硬约束优先"；测试 #5 守着 |
| 7 | 软层权重过大 | 「找更便宜」被偏好扭成更贵 | 上限 0.10 + 仅同向生效 + 预算守卫独立 |
| 8 | 一次换件被当成长期偏好 | 静默学习，用户不知情 | 只写 `inferred/未确认`（`resolveAttr` 天然忽略）+ UI 确认 |
| 9 | 无用户体系 | 多人共用一台机器会互相污染偏好 | 如实说明"单机偏好"；不写"为你个性化" |
| 10 | 碰坏 186 条 DOM 断言 | 验收直接红 | 首页只**新增**操作位，不改任何既有 id 与文案契约（HANDOFF §8.3） |
| 11 | 提示词膨胀挤掉方案上下文 | 模型读不到金额/到货 | 偏好块硬限 6 行 / 200 字，超出截断并注明 |
| 12 | 「已个性化」类文案先于能力上线 | 违反硬约束 10 | 文案随阶段解锁：F2 之后才允许在候选卡写"因为你说过…" |

---

## 附：本轮取证清单（可复查）

```
✅ packages/core/src/prefs.ts            全读（52 行）
✅ packages/core/src/ranking.ts          全读（149 行，权重与 pool 规则）
✅ packages/core/src/plan.ts             applySwap / fitBudget / createPlan 关键段
✅ packages/bridge/src/state.mjs         全读（prefs 读写、candidates、viewModel）
✅ packages/bridge/src/server.mjs        /api/prefs、/api/catalog、planContext
✅ packages/dsh-plugin/src/index.ts      7 个工具的 description 与实现
✅ studio/home.html + home.js            偏好表单、attr 选项、文案
✅ data/state.json                       现有 1 条偏好的真实结构（只读）
✅ data/chat.json                        30 条消息 / 47 次工具调用统计
✅ 隔离副本实验                          候选集比对 + 写入行为（不碰基线）
⬜ 真实对话 A/B 归因                      放到 F5，本轮不跑（不产生费用）
```
