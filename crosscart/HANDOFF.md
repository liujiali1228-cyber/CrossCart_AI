# CrossCart AI —— 交接说明（新会话先读这一份）

> 项目位于 `D:/aiproject/crosscart`，宿主 harness 是 **dsh (DeepSeek Harness) 0.2.2-rc.1**。
> 详细历史日志：`D:/aiproject/.workbuddy/memory/2026-11-16.md` ~ `2026-11-20.md`（主图/热点返工的根因、验收踩坑、F4.5/P9/P10 部署加固）。
> 最后更新：**2026-11-20**（**P9 + P10 已完成并验收**）。
>
> - **P10 体验修复与部署基础（§十三）**：首页外链从独立「灵感」行搬到四张编辑精选卡片的箭头（4 条实测 200）；**「更新穿搭图」确认弹窗整块删除**，图过期/生成中/失败改成图片左上角一条轻量状态条（不压暗、不挡点击）；`state.json` 原子写 + `.bak` 回退、新增按 IP 限流、公开模式接口脱敏、Docker/Render/`docs/DEPLOY.md` 齐备。
> - **P9**：口头声明的自有单品真正进图（`ownedClaim`）；自动更新不再二次确认；聊天去链接/去内部术语；首屏图 WebP srcset。详见 §十二。
> - 验收全绿：`npm test` **141/141**、`verify` **46/46**、`verify:stage3` **144/144**、`check:p10` **32/32**、`check:p9` **70/70**、`check:p9:dialog` **17/17**（真实模型+真实生图）、`check:public` **27/27**、`check:f4` **50/50**、`check:f4:dialog` **12/12**、`check:f3` **72/72**、`check:f2` **15/15**、`check:context` **24/24**、`check:prefs` **10/10**、`check-home-ux` **18/18**、`check:p6:owned` **44/44**、`check:p6:ui` **84/84**、`check:p6:dialog` **9/9**。
> - **下一步**：产品侧无阻断项。**本机没有 Docker，镜像未真 build**；公网正式开放仍缺账号体系与数据隔离（见 §十三 / `docs/DEPLOY.md` 第 8 节）。**动 `rankCandidates` 前先看 §9.7 三条规矩**。

## 一、这是什么

跨境场景购物助手（第一场景：旅行穿搭）。当前形态是**统一购物工作台**：一个页面里左对话、**中场景穿搭图**、右购物决策，三者共用一份结构化方案状态。

不是「AI 输出 Markdown 表格」，而是：
**结构化方案 → 穿着这套方案的人物场景图（可点衣物换装）→ 确定性重算 → 价格/预算/到货即时刷新 → AI 下一句读到新方案。**

中间不是商品槽位板，而是**一个具体场景里的全身人物**：东京街头·秋下午、巴黎咖啡馆·春上午、海边栈道·夏下午……换场景只换背景，商品、价格、购买链接一个都不变。

## 二、架构：一份状态 + 一个会话引擎

```
浏览器 studio/（三栏：对话 / 场景穿搭 / 购物决策）
   │ SSE chat / plan.updated / scene.updated + HTTP plan
   ▼
packages/bridge（唯一事实源）
   ├─ state.mjs    方案/偏好/目录 + viewModel 只读投影（含 sceneView）
   ├─ scenegen.mjs 场景图：provider 配置 / 内容寻址缓存 / 生成任务 / 五态视图
   ├─ chat.mjs     dsh SDK 子进程（stdio JSON-RPC → SSE）
   └─ server.mjs   HTTP + SSE + 静态站（含 /scenes/）+ planContext
   │ import                        │ stdio JSON-RPC
   ▼                               ▼
packages/core（纯函数）        dsh --profile sdk --patch packages/dsh-plugin/cordis.yml
  scenes.ts 场景组合/提示词/      → packages/dsh-plugin（7 工具）打回 bridge
            缓存键/适配/热点
```

铁律（改代码前务必遵守）：

1. **页面不重算任何金额**，只渲染 `state.mjs` 的 `viewModel()`；数字全来自 `packages/core`。
2. **换件不是「让模型重写方案」**：`applySwap` 只替换一个 slot，重算后用 `diffPlan` 断言 `changedSlots.length === 1`，否则抛 `PlanError`。
3. **「未知」是一等状态**：`confirmed | estimated | unavailable` 取最弱者；关税不参与合并、不计入总额；运费待确认的不进策略推荐。
4. **不修改 dsh 核心源码**：只用 `cordis.yml` patch 层 + `dsh plugin add`。
5. **购买链接只来自商品数据的 `url`**，四态判定（buyable/owned/no_link/untrusted），演示数据与未核实域名一律不给按钮。
6. **聊天不解析文字取商品**：AI 每条消息带 `<crosscart-context>` 方案快照，工具写回同一份状态。
7. **场景图必须从结构化方案生成**（`buildScenePrompt(plan, spec)`），**绝不解析聊天文字当提示词**。
8. **切场景不许动方案**：`POST /api/plans/:id/scene` 服务端比商品 ID 数组，不等就抛 `SCENE_MUTATED_PLAN`；`revision` 不变。场景不适配（雨天/雪天）只给 `hints`，用户确认前不动任何商品。
9. **点衣物换装靠区域映射，不靠坐标猜商品**：`Region{x,y,w,h}` 归一化矩形 + 面积最小者优先；画框按 2:3 等比算，**禁止 cover 裁切**（否则热点与像素错位）。
10. **没有图像 API 就如实说**：状态 `unconfigured` 写清缺哪几个环境变量，**绝不用静态图冒充生成结果**；换件后旧图标 `stale`，不假装已经重画。

## 三、当前状态（已验收）

- **P10（2026-11-20）**：首页外链搬到四张编辑精选卡片上、独立「灵感」行删除；「更新穿搭图」确认弹窗彻底删除（图过期/生成中/失败改为一条轻量状态条）；数据原子落盘 + `.bak` 回退、按 IP 限流、公开模式接口脱敏、Docker/Render/部署文档齐备。详见 §十三 与 `docs/P10-体验修复与部署基础报告.md`。
- **P9（2026-11-20）**：口头声明的自有单品真正进图（抽象 `ownedClaim`）、自动更新不再二次确认、聊天去链接/去内部术语、首页风格词加「灵感 ↗」外链、首屏图转 WebP srcset、免口令公开实例 + Docker/Render 托管配置。详见 §十二 与 `docs/P9-体验修复与部署报告.md`。
- 统一工作台：`http://127.0.0.1:8790`（`npm run studio` 一个进程含全部能力，含内部拉起的 dsh SDK 子进程）。
- 场景系统：24 个地点种子（城市/旅行/日常/活动 各 6）+ 自定义，`sceneId = place.season.time.weather`（如 `tokyo-street.autumn.night.rain`）；标签自动组装「东京街头 · 秋夜晚 · 雨天」；不认识的地点**抛错**不静默兜底。
- 场景图：`data/scenes/` 共 **12 张 png + 12 条 ready 条目**（8 张属基线 `pln_020`，2 张属 `pln_038`，2 张属 `pln_001`）+ `index.json`（`entries` 是**对象 map**，键 = 缓存键；`archived` 另存），2:3、2.2–2.7MB，文件名 = 内容寻址键（`hash(排序后的 slot:productId:color + '#' + sceneId)`）。
- 图像 provider：**已接 OpenAI**（`data/scenegen.config.json`：`gpt-image-2.6-sunburst` + `refsMode: openai` + `proxy: http://127.0.0.1:7897`，文件已 gitignore）。切到没缓存的地点会自动生成（约 40s、$0.05–0.1），换件后点「重新生成场景图」会以上一版图作底图 + 新商品图做局部编辑（人物与背景保持）。参考图走 `/images/edits` multipart。
- 场景缓存：文件名 = 内容寻址键；图片 URL 带 `?v=<createdAt>` 防缓存旧图；覆盖生成前把旧图归档进 `index.archived`。
- **热点自动识别**（第三阶段，2026-11-18 升到 `body-box+color@3`）：`packages/core/src/regions.ts` + `hotspots.mjs` + 自带 `png.mjs` 解码。做法是「积分图找人像箱体（5 段横向身体带的里外对比度，带宽度细化）→ 人体框纵向取满画幅 → 每个槽位在比例区间附近做**颜色引导的局部滑窗搜索**，评分 = 框内该商品色像素占比（`colorCoverage`，tol×1.6 环境光补偿）」。`cov>=0.2` 才 ok，`conf=0.32+1.15*min(cov,0.6)`，`CONFIDENT=0.55` 以下不可点。detector 标 `body-box+color@3`、坐标 `normalized`；元数据里 `hotspotsNeedRedetect()` 会比版本号，旧坐标强制重算（`manual` 修正保留）。真实图实测桌面 5/5、390px 5/5 命中；被外套完全遮住的上衣会如实降级为 `low` 并给「修正 / 重新识别」。当前 key 无视觉模型权限（chat/completions 一律 403），`resolveVisionConfig()` 留了切换钩子。
- **费用与预算**（第三阶段）：`packages/core/src/cost.ts` 纯函数 + `packages/bridge/src/cost.mjs` 记账（`data/scenegen.usage.json`，不写 apiKey）。付费前 `GET /api/scenes/quote` 估价；**P10 起界面没有确认弹层**，闸门全在服务端（月度预算默认 $8，80% 预警 / 100% 拦截 / 缓存命中永远放行）。**记账下限**：`costFromUsage` 不得低于档位单价，否则低报会让闸门失守。
- **自动重画**（第三阶段）：默认关。**P10 起「拨开开关」本身就是授权**（不再弹「会持续产生费用」确认框）；`scheduleRegen` 按 planId 防抖（`SCENEGEN_AUTO_DEBOUNCE_MS`，默认 1600ms，按调用时读取），连续换件合并成一次；生成期间再改标 pending，本轮结束补一次；旧结果只落自己的缓存键，不覆盖新方案。
- 交互：点人物身上的衣物 → 右栏出该件详情 → 换一件 → 确认只改这一件；触屏常驻淡虚线热点（没有 hover）。
- 真实商品：Shopify `/products.json`（Cuyana 20 / Rothy's 29 / Allbirds 14 / Everlane 49 = **112 件**），金额双闸（`&country=US` + 类目区间 + `priceSuspect` 整店跳过）。
- 测试：`npm test` **141/141**（core 9 套，含 F4 建方案硬约束 8 条）；`npm run verify` **A–H 共 46 项断言**（真实浏览器 + 真实场景图 + 390px）；`npm run verify:stage3` **A–J 144 项断言**（两个隔离实例 + mock 图像服务，零费用）；**偏好专项** `check:f4` 50 · `check:f4:dialog` 12（真实模型）· `check:f3` 72 · `check:f2` 15 · `check:context` 24 · `check:prefs` 10 · `check-home-ux` 18；**P9 专项** `check:p9` 70 · `check:p9:dialog` 17（真实模型 + 真实生图）；**P10 专项** `check:p10` 32（全新目录启动 / 重启恢复 / `.bak` 回退 / 按 IP 限流 / 管理接口 / 密钥不外泄）；`check-public` 27（免口令公网）。`npm run verify:real` 真实 API 抽查（2 次付费生成）。以上都跑在方案的**副本或隔离目录**上，不动基线、不改真实偏好。
- 截图：`npm run shots` → `shots/scene-*.png`（默认场景 / 热点选中 / 场景面板 / 切场景 / 换件后 stale / 多场景对比 / 未配置状态 / 移动端）。
- 数据：`data/state.json` 有历史方案（`pln_001`~`pln_088`，大部分是验收副本，可清理）；**`pln_020` 是场景验收基线方案**（奶油街拍轻装，5 件真实商品，8 张真实场景图都按它算，缓存键 `gbq5vy`）。

## 四、常用命令

```bash
cd D:/aiproject/crosscart
npm install && npm run build
npm run studio     # http://127.0.0.1:8790
npm test           # 141 个确定性单测（core 9 套：方案/金额/偏好裁决/提议/排序/场景/购买/计费 + 热点 + F4 建方案硬约束）
npm run verify     # A–H 浏览器验收 + 截图（需 studio 在跑，跑在方案副本上）
npm run verify:stage3  # 第三阶段 A–J（144 断言）：隔离实例 + mock 图像服务，零费用
npm run check:f4   # F4 推荐约束闭环 50 断言：硬约束阻断/破例/三态/解释字段（隔离实例，零费用）
npm run check:f4:dialog  # F4 真实 DeepSeek 三场景 12 断言：记住 / 临时换件 / 改主意（会产生少量模型费用）
npm run check:f3   # 偏好闭环 A–I（72 断言）：提议/确认/拒绝/删除 + 首页真实点击（隔离实例，零费用）
npm run check:f2   # 偏好进入换件链路的守卫（15 断言）
npm run check:context  # 偏好注入计划上下文（24 断言）
npm run check:prefs    # 首页偏好写读（10 断言，需先起隔离实例 8791）
npm run check:home # 首页 UX 18 条（需 studio 在跑）
npm run check:p9   # P9 专项 70 条：自有单品/无二次确认/去链接/首页外链（隔离实例 8799）
npm run check:p10  # P10 专项 32 条：全新目录启动/重启恢复/.bak 回退/按 IP 限流/管理接口/密钥
node scripts/shot-redesign.mjs   # 改版截图：首页/购物页/抽屉 × 1440·1280·390（只读，零费用）
node scripts/test-home-flow.mjs  # 真实跑一次：首页输入 → 建方案 → 跳转 → 继续对话换件
npm run verify:real    # 真实 API 抽查：只跑 2 次付费生成（自动换件重画 + 自定义场景）
npm run verify:all     # 上面两套浏览器验收连着跑
npm run shots      # 只重拍交付截图（会真的换件/切场景，结束自动复原）

# —— 公网测试版（F4.5，见 §十）——
npm run demo       # 起演示实例：8796 + data-demo/ 独立副本 + 口令保护 + 限流（DEMO_TOKEN / DEMO_PUBLIC_URL 可覆盖）
npm run tunnel     # 另开终端：Cloudflare 快速隧道（无 cloudflared 时回退 localhost.run），地址写入 .tmp/tunnel-url.txt
npm run check:public -- <url> [token]   # 公网业务链路 27 断言（访问保护/硬约束/对话/图片/布局/持久化；无口令实例不用传 token）
node scripts/shot-p10.mjs        # P10 交付截图（复制基线→换件→拍提示条→删副本，零费用）

# —— 正式部署（P10，步骤见 docs/DEPLOY.md）——
npm run serve:public   # 8797 + data-public/，公开模式（管理接口关闭、health 只回最小信息、按 IP 限流）
docker build -f deploy/Dockerfile -t crosscart .   # 在**有 Docker 的机器**上执行；本机无 Docker，镜像未真 build
node scripts/rekey-scenes.mjs   # 方案单品变了 → 按当前组合复算场景缓存键
node scripts/try-openai-scenegen.mjs   # OpenAI 图像 API 三步验证（生成/换外套/换场景，打印耗时与 token）
node scripts/seed-scenes.mjs    # 登记新生成的场景图（真实提示词 + 人工核对热点）
dsh web --patch packages/dsh-plugin/cordis.yml   # 可选：独立 dsh Web（3080）
```

一次准备（已做过，换机器才需要）：`npm i -g @deepseek-ai/dsh@0.2.2-rc.1`、`npm i -g pnpm`、`dsh plugin --profile web add file:D:/aiproject/crosscart/packages/dsh-client-ui`，并在 `~/.dsh/profiles/web/cordis.patch.yml` 加 `crosscart-client-ui`。
Windows：pnpm 会复制而非软链，改完卡片代码需换 junction 或重跑 add。

## 五、踩过的坑（别重犯）

1. 插件里 `console.log` 会污染 dsh SDK 的 stdout 协议帧 → 一律 `console.error`。
2. `session/resume` 在同一子进程内重复调用会被判 occupied → 加 `sessionBound`，仅新进程 + 有历史时 resume。
3. 旧预算守卫「没进预算就拒绝」会让超支方案永远换不动便宜件 → 改为：更贵且仍超预算才拒绝；更便宜但仍超则允许并如实标注。
4. 换件抽屉宽过右栏会盖住画布 → drawer `width: var(--shop-w)`。
5. 种子数据 example.com 曾被判 `untrusted` → 语义改为 `no_link`（「演示数据」），旧快照用 `normalizeSource` 补 `sourceKind`。
6. 移动端 `.plan-picker > span` 与 `#canvas-hint` 会挤坏布局 → 720px 下隐藏。
7. **候选排序不管「能不能真买」**：演示种子件便宜、到货快，策略排序总推它 → `rankCandidates` 加 `buyablePool` 过滤（有真实可下单候选就不出演示件）。
8. **差价口径混用**：`priceDelta` 曾用「候选到手价 − 当前商品价」，漏算当前运费 → 改为与当前 `lineTotal` 相减；验收断言「卡片标的差价 == 换完后总额实际变化」。
9. **舞台 cover 裁切会把脚切掉**，鞋子热点必然错位 → 加 `.stage-frame` 画框，`fitStageFrame()` 按容器等比算 2:3 像素尺寸（图片 `object-fit: cover` 但画框比例与图片一致，等于不裁切）。
10. **移动端画框高度塌陷**（313px）：第二阶段 CSS 追加在文件末尾，基础 `.stage { flex: 1 1 auto }` 覆盖了前面的媒体查询 → 移动端覆盖规则必须写在**所有 `.stage` 规则之后**（当前在文件末尾）。
11. **热点会重叠**：东京白天图「包」压住「外套」左上角，按固定坐标点击会换错衣物 → 验收脚本改为 `elementFromPoint` 网格采样，选「最上层就是目标热点」的点再点（`clickHotspot()`）。
12. **提示词里的介词**：模板拼 `in ${scene}` 会出现「in outside a Parisian café」→ 模板改为 `scene: ${spec.prompt}`，种子里自带介词。
13. **服装短语生硬**：`garmentPhrase()` 从商家标题提取材质/版型关键词并去重；`straw stripe` → `straw striped` 需补空格正则。
14. **同一套衣服换场景会跑偏**：巴黎/纽约两张首发图多出夹克、颜色漂移 → 用首张图作 `image1` 参考 + `input_fidelity: high` 重生，六张图里才是同一身。
15. **缓存键会被「同款不同 variant」搞坏**：验收里换件再换回，若恢复的是同款另一个 productId，键就变、图对不上 → `scripts/rekey-scenes.mjs` 按当前组合复算键（图与真实提示词不动），改完需重启 studio 让服务端重读索引。
16. **`selectSlot` 是切换语义**：再点同一件会取消选中，脚本里连点两次会拿到一个隐藏但仍存在的 `换一件` 按钮（locator 能解析、点击报 not visible）→ 换件流程前先重新载入页面。
17. **Node 的 fetch 不读 `HTTP_PROXY`**：本机系统代理（63689）对 api.openai.com 返回 502，直连被 DNS 污染。解决办法是 undici 的 `ProxyAgent` + `dispatcher`——注意**只有 undici 自己的 fetch 认 dispatcher**，全局 fetch 会报 `UND_ERR_INVALID_ARG`。undici 8.x 是 CJS，得 `import undici from 'undici'` 再解构（没有 named export）。
18. **`gpt-image-2.6-sunburst` 不接受 `input_fidelity`**：传了直接 400 `invalid_input_fidelity_model`。人物一致性靠「以上一版图为编辑底图」+ 提示词约束，不靠这个参数。
19. **商品会从目录里消失**：某次刷新后 Everlane 的 Way-Short Shirt 不在目录里了，`swap productId` 直接 `NO_CANDIDATE`，导致「换回来」失败、方案漂移、缓存键跟着变。修法：换件时把上一件快照进 `slot.previousItem`，回滚时目录里查不到就用快照（并注明「当前不在店铺目录里」）。
20. **验收会污染基线**：一旦还原失败，`pln_020` 就被改坏、后续所有缓存键失效。现在所有验收脚本都先 `duplicate` 一份方案，全程在副本上折腾；`verify:stage3` 还额外用 `CROSSCART_DATA_DIR` 起隔离实例（临时数据目录），连缓存和额度记录都不碰基线。
21. **覆盖生成会丢掉人工标注的热点**：重新生成同名缓存图前先把旧图归档进 `index.archived` 并改名带时间戳；图片 URL 带 `?v=<createdAt>`，否则浏览器/静态缓存还会显示旧图。
22. **主图变小是「高度反推宽度」**：`fitStageFrame()` 旧写法 `fw = min(w, h*RATIO)`，`h` 是被上方控件挤剩的高度 → 1280 视口只剩 250×376、两侧大留白。改为**以栏宽为唯一基准**（`min(clientWidth, 820)`）+「不超过一屏」上限；`.stage` 要 `flex:0 0 auto`、`.plan-pane` 要 `overflow-y:auto`、`.stage-board` 不能 absolute。用户看到的「主图不可用」根因就在这里，**不要去放大素材**。
23. **图上压字等于毁掉主图**：AI 标识曾是 `absolute;top:10px` 正好盖头顶 → 移到 `#stage-caption` 独占一行，模型名只留技术信息。
24. **「4/4 可信」可能是旧坐标**：`ensureHotspots` 只判断「有没有 hotspots 字段」→ 第二阶段固定坐标（`method:'geometric'`, conf 0.6）永远不重算，界面却按 `status==='ok'` 全标可信。必须比 `DETECTOR_ID` 版本号。
25. **重叠热点要先排 DOM 顺序**：`renderHotspots` 按面积**降序**渲染（小目标后渲染=在上层），和 `pickRegion` 面积最小优先保持一致；否则点背包会换到外套。
26. **`plan.created` 不能无脑切方案**：别的窗口/脚本/AI 后台建副本会把用户正在看的页面顶走（表现为 URL 被改、切场景「没反应」）→ 只刷新列表，当前没方案才进入。小目标命中区 `hitArea()` 只改 style，重建 DOM 会让点击丢目标。

## 六、已知限制 / 下一步

1. **热点是颜色启发式，不是理解**：`@3` 已对每张新图自动识别（不再用固定默认区域），但衣物被外套完全遮住、或颜色与背景接近时会降级为 `low`（不可点，给名称录入/手动拖框）。精确度上限取决于没有视觉模型 → `resolveVisionConfig()` 拿到权限后可替换。
2. **一次生成 40–90s、$0.05–0.1**：切到没缓存的地点会计费；换件后要看到新搭配必须重新生成 → 已有内容寻址缓存 + 并发去重，可再加预生成队列与防抖。
3. **场景图是生成图**，版型细节与实物可能有差异（模型仍可能改动衣服细节）→ 已标「仅供效果参考」；能保证的是「换场景保穿搭、换件保人物」，不保证像素级还原。
4. **需要出海代理时得显式配 `proxy`**：Node 的 fetch 不读 `HTTP_PROXY`，必须写进 `SCENEGEN_PROXY` 或用配置文件；直连环境留空。
5. **商品可能从店铺目录里消失**：缓存键会随单品漂移，`rekey-scenes.mjs` 可复算；换回原商品已用 `previousItem` 快照兜住。
6. 运费时效是店铺级估算（`estimated`），关税恒 `unavailable` → 接 shipping rates / 海关税率表。
7. 只有美元区 4 家店、无亚洲码 → 接 Rakuten（东京）/ AliExpress（发中国），同一 provider 接口。
8. 偏好仅单机 `data/state.json`，无多用户；dsh 客户端卡片仍是手写 bundle。
9. **`data/scenegen.config.json` 里的 apiKey 曾在聊天中明文传输** → 建议到 OpenAI 平台轮换一次，再把新 key 写回该文件（文件已 gitignore，不会进版本库）。
10. ~~建方案路径的偏好硬约束~~ **F4 已解决**：建方案先校验后落库，冲突 422 且不持久化；用户明确授权才允许单套方案破例（记原话、不改长期偏好）。见 §9.11。
11. **AI 不会主动发现偏好**：`propose_pref` 何时调用完全取决于模型；没有「扫历史方案/对话批量推断」的作业，也没有在对话里主动提示「我发现你…要不要记住」。宁可少记，也别乱记 —— 这与 F3 的取舍一致。

**下一步候选项（按优先级，均未开工）**

0. ~~整体 UI/UX 重设计~~ **已完成并冻结（2026-11-18）**，见「八、界面改版」与 8.1 / 8.2。剩余小项：1280×800 主图 655×491（放大需接受首屏滚动）；provider 水印；首页素材为未授权第三方摄影。
0b. **Phase 5 偏好与个性化**：F0–F4 **全部完成并验收**（§9.7–§9.11）；公网测试版见 §十。**主线到此收尾**，下面都是可选优化。
1. 「换件后自动重新生成场景图」已在第三阶段做成开关（默认关 + 防抖 + 任务合并），可继续加预生成队列。
2. 生成图的热点改用视觉模型回归 5 个区域坐标（现在是颜色搜索）。
3. 从右栏清单点衣物 → 图上高亮同一件（解决「被外套遮住看不见」）。
4. 场景图与真实商品图对照视图（降低「生成图 ≠ 实拍」的误解）；处理 provider 水印。
5. 清理 `pln_021`~`pln_063` 验收副本，只留基线 `pln_020`。
6. 若要更高服装还原度，再评估 FASHN Try-On 等专业试穿 API（当前 OpenAI 已能满足「换场景保穿搭、换件保人物」）。

## 七、文档与截图

- `README.md`（架构图 / API 表 / 场景系统 / 购买入口策略 / 验收矩阵 / 取舍 / 限制）
- 截图目录 `shots/`：**改版后以 `shots/redesign/` 为准**（`scene-*.png` 是第二阶段、`fix/*` 是 11-18 早间返工、`shot-*`/`delivery-*`/`wb-*` 更早）
- `docs/CrossCart-AI-技术设计文档.md`、`docs/CrossCart-AI-数据源与可视化方案.md`（设计期文档，未随改造更新）

## 八、界面改版（2026-11-18，消费级重设计）

**目标**：从「技术后台工作台」变成有品牌质感的消费者购物产品。基准参考图：`CrossCart_TOTEME_AI购物首页参考.png` / `CrossCart_TOTEME_场景购物页参考.png`（用户提供，不在仓库）。

**两个页面，一个服务**（`server.mjs` → `serveStatic`）：

| 路径 | 页面 | 说明 |
|---|---|---|
| `/`（无 `plan`） | `studio/home.html` + `home.js` + `home.css` | AI 购物首页 |
| `/?plan=<id>` | `studio/index.html` + `app.js` + `styles.css` | 场景购物页（深链/验收脚本都走这里） |
| `/app` | 同上 | 显式别名 |

**设计规范**：`studio/design.css` 是两页共用 token 层 —— 白底 `#fff`、墨字 `#111`、灰 `#6c6c6c`、发丝线 `#e6e6e6`、AI 蓝 `#2f5bff`（只用于 ✦ 与「AI」角标）；标题衬线 `Songti SC/Noto Serif SC/Georgia`、正文 Inter/系统无衬线；圆角 0–2px（仅左栏动作胶囊 999px）；**全局无卡片阴影**，层次靠图片、字号与留白；微标签 10px + `.14em` 字距。

**购物页关键交互**：图下五个类目（`#slot-chips` → `.slot-chip[data-select]`）是主换装入口 —— 点一下 = `openSlot()` 选中该类 + 直接 `openSwap()` 打开候选抽屉；只读候选、零付费、不动 revision。热点与清单行仍走 `selectSlot()`（选中 → 右栏详情 → 换一件）。左栏给 6 个动作胶囊（换一件{外套/上衣/裤装/鞋/包} + 调整预算或风格）。

**主图尺寸**：`fitStageFrame()` 仍是「栏宽基准 + 一屏封顶」，但封顶时减去 `stageReserve()`（类目行 + 诚信标注 + 自动开关的高度），保证「人物完整 + 类目按钮在首屏」。实测：1440×900 → 402×603（类目 bottom 866）；1280×800 → 335×503（766）；390×844 → 320×479（756，tabbar 790）。兜底 `fw>=300`，绝不回到 250 宽。

**首页链路（真实）**：输入需求 → `POST /api/chat`（同一个 dsh 会话）→ 监听 SSE `plan.created`，用「提交前的 planId 集合 + 本轮开始时间 + 排除 `from` 副本事件」三重条件确认是本轮方案 → 跳 `/?plan=<id>&welcome=1`；2.5s 轮询兜底，150s 上限给「停止等待」。实测 100s 建好并跳转，图像费用 0（不调图像 API）。灵感/方案卡取 `/api/plans` 的 `scene.image`（真实场景图），偏好走 `/api/prefs` 真实读写，文案写明「AI 可在对话中读取，但不自动改变推荐」。

**新增验证工具**：`scripts/shot-redesign.mjs`（两页 + 抽屉，1440/1280/390，`shots/redesign/*.png` + `report.json`）、`scripts/test-home-flow.mjs`（真实首页建方案 + 继续对话换件）。

**改这层时容易踩的坑**：
- 列向 flex/grid 里 `aspect-ratio` 会算出 0 高（候选卡片只剩文字、方案卡没图）→ 图片盒用 `padding-top` 撑比例 + 绝对定位，网格加 `grid-auto-rows:max-content` + 子项 `align-self:start`。卡片不要用 `<button>` 当列向 flex 容器。
- `.stage-frame` 不能加 padding/圆角/transform；`.plan-pane` 必须 `overflow-y:auto`；`.stage` 必须 `flex:0 0 auto`。
- 抽屉/场景面板的 `top` 用 `var(--nav-h)`；移动端全屏覆盖要 `top:0`。
- 移动端顶栏要压：`.plan-picker{flex:1}`、`#btn-duplicate` 隐藏、`#sync-text` 隐藏，否则 390 宽横向溢出。
- 首页 CDN 商品图是懒加载，截图前至少等 2.5s。

### 8.1 首页视觉精修（2026-11-18 晚，Phase 4.1-B 收尾）

**动机**：第一版首页虽然换了编辑式排版，但主视觉仍沿用场景生成产物（2:3），且四张「灵感」是面部/裤脚/鞋/包的细节特写 —— 与 TOTEME 气质接近，却不像「按场景搭整套」的购物入口。

**四处定点改动（只碰首页三个文件 + 素材）**：

1. **主视觉换源**：`16x10_TotemePS27_760706.jpg`（头顶贴画面边缘，4:3 裁切必然把脸推到上缘，`object-position` 救不了）→ `16x10TOTEME_FW26_RUNWAY_FINALE1.jpg`（1600×1000，白色护墙板 + 拼花地板，多套完整造型，头顶余量充足），桌面 `object-position:62% 50%`（4:3，743×557）。
1b. **移动端用独立竖构图**（见 §8.2）：桌面这张是多人行进，塞进 390 宽 3:4 容器会把左右两人各切一半。改用 `<picture>` + `source media="(max-width:720px)"` 指向 `hero-mobile.jpg`（TOTEME `9x16_TotemePS27_760706.jpg`，1080×1920，单人、头顶留白充足），`object-position:50% 8%`。**两个断点两套素材**，与 TOTEME / LEMAIRE 自己的做法一致。
2. **左栏垂直居中**：`.hero` 改 `align-items:stretch`，`.hero-copy` 用 `flex column + justify-content:center` —— 实测上下留白 107/107，此前左下有 458px 空洞。列比 43/57（图片 743，原来 722）。
3. **开发说明移出主视觉**：删掉 `#hero-note`，素材来源/授权改为页面最底部 `#proto`（`y≈2632`，不进首屏）+ `studio/assets/SOURCES.md` + HTML 注释三处留痕。
4. **编辑精选换整套**：四张改为 LEMAIRE 当季造型（`IMAGE_29/32/43/28`，皆 1000×1249 = 4:5 原比例，零额外裁切），主题为「城市秋日穿搭 / 都市极简 / 轻松周末 / 轻旅行衣橱」，每张都是从头到脚的完整造型；图下只留标题 + 箭头（原来重复四遍的「场景起步·点击填入需求」删掉，指示统一放在区块标题行）。
   - **TOTEME PS27 这组物料本身是细节特写**（`4x5/5x7` 系列 = 脸、裤脚、高跟鞋、手袋），无法承担「完整穿搭」，别再用它们填灵感位。

**「我的方案」分层**：有 `scene.image` 的进 3 列卡网格（最多 6 张，`.plan-card .thumb` 必须有 img）；无封面的收成 `#pending-list` 文字行（标题 / 件数·金额 / 等待生成场景图），不再出现大片灰块；标签含「副本」的默认不展示，`#toggle-copies` 可展开（只影响展示，不删数据）。计数行如实写「共 N 份 · M 份已有场景图 · 已隐藏 K 份测试副本」。

**实测（`scripts/shot-phase41.mjs` → `shots/phase41/report.json`）**：1440×900 hero 743×557、底 669，灵感区首卡 y=794（露出 **106px**）；1280×800 655×491、底 603，露出 73px；390×844 图 390×520（`hero-mobile.jpg` 1080×1920 → cover 纵向裁到 2%~77%，头顶留白约 26px）、hero 底 908（第二屏起看灵感，按决策保留）。三档 `overflowX=0`，输入框 `scrollWidth=clientWidth`，JS 错误 0。

**交互自检**：`scripts/check-home-ux.mjs` 现为 **18 条** —— 新增「Hero 不含开发说明」「文本列上下留白对称」「方案卡都有真实封面」「无封面方案走文字状态」「副本默认不占主网格」「原型说明不进首屏」，以及移动端三条（改用专用 `hero-mobile.jpg`、素材必须是 9:16 竖图、取景 `50% 8%` 保头顶留白），删掉已不存在的 `#hero-note` 断言。

### 8.2 移动端 Hero 独立选图（2026-11-18 晚，Phase 4.1 收尾）

**问题**：桌面换成多人秀场图后，移动端仍用同一张做 3:4 裁切 —— 窄屏里左右各切掉半个人，视觉主体不明确。

**做法**：`<picture><source media="(max-width:720px)" srcset="/assets/hero-mobile.jpg"><img src="/assets/hero-editorial.jpg">`，两张都是品牌为不同断点准备的构图。选材前比过 5 张 LEMAIRE `BANNER_n_MOBILE`（1080×1450）与 3 张 TOTEME `9x16`：前者多为鞋靴/包袋特写或半身，后者 760706 是单人、头顶余量足、黑白调与桌面秀场同色系，故选它。

**踩坑记录**：
- 桌面秀场图 **没有** 9:16 / 4:5 竖版（`9x16TOTEME_FW26_RUNWAY_FINALE1` 等逐个探测全 404），只能跨到同季 PS27 单人系列；记录在 `SOURCES.md`。
- `<picture>` 里的 `img` 仍是唯一图元，`bindHeroFallback` 不用改；但 `.hero-media picture` 必须 `display:block; width/height:100%`，否则内联元素撑不开容器。
- 移动端 `object-position` 从 `62% 50%` 改为 `50% 8%`（9:16 放进 3:4 是纵向裁切，横向位置无意义）。
- 旧断言「移动端主图 `object-position` 以 62% 开头」已随行为变化更新为「使用专用竖构图素材 + 9:16 + 50% 8%」，不是削弱测试。

**换件是一次诚实性验证**：给 pln_072 发「外套换成更便宜的」时，AI 回「$62 已是最低价，未改动任何搭配位」（`revision` 保持 0）—— 这是正确行为，不是回归失败；换成「上衣换成更便宜的一件」后 `revision 0→1`、`$170→$165`、图像费用不变。写自动化断言时不要假设「一提换件就必然换」。


### 8.3 DOM / 文案契约（改前端前必读）

界面重写时**视觉全换、这些 id 与断言一个没动**。`verify`（46）与 `verify:stage3`（144）依赖它们，改名或删除会直接红。P9 新增入口见 §12.8（`#btn-share`、`.cap-warn` 等，只加不改）；**P10 删掉了 `#confirm-modal #modal-*` 与 `.inspo`，新增 `.insp-go` 与 `.stale-strip`，见 §13.6**。

```
#stage #stage-img #stage-frame #stage-board #stage-overlay #hotspots
#stage-caption  （文案必须含「AI 模拟穿搭」）
#hotspot-note #scene-name #btn-scene-switch
#scene-picker [data-ptab] #picker-custom-text #btn-picker-apply
#auto-toggle #budget-chip
[data-regen]  （更新/重试按钮；P10 起也在 .stale-strip 里）
#selection [data-act=swap|close]  （文案含「让 AI 建议调整」）
#btn-confirm-swap .cand
.hotspot[data-hot] .slot-chip[data-select]
#toast [data-tab]
```

首页侧：`#ask-input #ask-go #hero-status #hero-media #insp-grid #plan-grid #prefs-list #pref-form #toast`。

**F3 新增（只加不改，勿复用同名 id）**：`#prefs-pending` `#prefs-pending-list`；`.pref-row[data-attr][data-scope][data-pref-id]`、`.pref-prop`、`[data-act=confirm|reject|delete]`、`.pref-src`、`.pref-badge-ai`。
⚠️ **`#pending-list` 已被方案区占用**（「更多方案」待生成列表），偏好区必须用 `#prefs-pending-list`；重名会让条目渲染到方案区且点击不冒泡（见 §9.10 坑）。

**Phase 6 变更（消费者端去工作台化，2026-11-19）** —— 只有这一批是「删除/挪位」，其余仍是只加不改：

| 项 | 处理 | 说明 |
|---|---|---|
| `#pref-history` `#pref-history-summary` `#history-list` | **删除** | 变更记录属审计视图，数据仍在库里（`GET /api/prefs` 的 `all`），页面不再展示 |
| `.budget-chip` `#budget-chip` | 保留，改成「用完才出现的一句话」 | 文案固定为「暂时无法生成新图」，**不得含金额/额度数字**（P8） |
| `#hotspot-note` | 保留 id，内容清空且始终隐藏 | 断言已改；热点本身改为透明热区（`.hotspot` opacity 0、无文字、无 title） |
| `#rev-chip` | **删除** | revision 是内部并发基准，消费者界面不出现 |
| `#btn-tech` `#tech` `#history-card` `#fix-hour` 等开发者入口 | **删除** | 「修正热点 / 重新识别 / 可信度」不再提供；服务端识别照旧 |
| `#slot-chips` | **挪位**：从图下移到 `#pane-shop` 顶部（`.shop-swap` 内） | 5 个 `.slot-chip[data-select]` 契约不变，第二行改「添加 / 已有 / $价格」 |
| `#btn-edit-plan` `#btn-open-swap` `[data-suggest-toggle]` `.qa-chip` `.qa-x` | 新增 | 约束折叠入口 / 移动端换装入场 / 建议恢复入口 / 单条建议与关闭键 |

新增验收：`check:p6:owned`（44 条，确定性）、`check:p6:ui`（84 条，真浏览器）、`check:p6:dialog`（真实模型，3 轮）、`shot:p6`（截图）。

其他易忘点：`selectSlot()` 是切换语义（再点同一件会取消选中）；移动端点热点会自动跳「清单」页，脚本每次点击后要 `click('[data-tab="plan"]')` 切回；`plan.created` 不自动切方案。

## 九、Phase 5 · 偏好与个性化（已完成：F0–F4 + F4.5，验收记录见 §9.7–§9.11 与 docs/F3/F4 文档）

### 9.1 产品目标（用户 2026-11-18 定调）

不是「给商品排序加一个偏好分数」，而是：**CrossCart 能记住用户的长期购物喜好，在不同场景里灵活使用，并根据反馈逐渐调整推荐。**

五段闭环：**偏好采集 → 偏好记忆 → 推荐时使用偏好 → 推荐解释 → 用户反馈 / 偏好更新**。

两条**不可违反**的原则（写进代码与测试，不只是文案）：

1. **偏好不能覆盖硬约束**。喜欢某品牌，但超预算 / 无法按时送达 / 不可下单 → 仍然不能推。硬约束先行，偏好只在合格候选集合内起作用。
2. **一次换件 ≠ 长期偏好**。换掉黑外套可能因为天气、价格、场合。要做「是否记成长期偏好」的确认，而不是静默学习。

其他边界：采集要区分**长期偏好**与**本次任务需求**（「这次去东京要防水外套」不是长期偏好）；偏好要能查看 / 修改 / 删除，并记录来源（用户设置 vs AI 提取待确认）；界面不得声称「已为你个性化」除非真做到了（对应硬约束 10）。

### 9.2 Phase 5A：只读审查（未获确认前不改代码）

用户明确要求：**不要直接改 `rankCandidates`**。先沿真实调用链取证，输出 A–G。

要回答的问题：

1. `/api/prefs` 支持哪些操作、字段、类型？数据落在哪、是否持久化？
2. `crosscart_list_prefs` 怎么读、读的是同一份数据吗？
3. DeepSeek 在什么条件下会调用偏好工具？（是系统提示要求，还是碰巧）
4. 偏好有没有进入商品发现 / 筛选 / 排序？`rankCandidates` 存在的话排序依据是什么？
5. 偏好是否与用户 / 会话正确关联？有冲突、覆盖、删除机制吗？

链路分段取证（每段都要标「模型 / 确定性程序」+ 输入输出结构 + 能否读偏好 + 是否真用了）：
自然语言输入 → 需求解析 → 商品检索 → 硬约束过滤 → 候选排序 → 方案生成 → 推荐解释。

**必须区分三件事**：模型读到过偏好 / 模型声称考虑了偏好 / 实际结果被偏好改变。只有第三种算数，用**真实候选集与结果差异**证明，不看模型措辞。

方案比较：Agent 自主使用偏好 vs 程序排序 vs 混合；给最小改动 + 可验证的那条。**不要默认所有偏好都写成排序公式**（审美类适合 Agent 判断，硬性排除类适合确定性过滤）。

对照测试设计（每组要比真实候选与最终结果，不看模型是否提到偏好）：无偏好新用户 / 极简中性色偏好 / 鲜艳色偏好 / 拒绝高跟鞋 / 偏好品牌与预算冲突 / 当前需求与长期偏好冲突 / 用户修改或删除偏好。同时给出偏好读写是否增加模型调用与费用的判断。

交付格式：A 现状与数据结构 / B 偏好实际作用位置 / C 未实现的关键能力 / D 最小架构方案 / E 要改的文件接口工具 / F 分阶段顺序与测试 / G 成本与风险。

### 9.3 已知事实（均为**待 5A 逐条核实**的线索，不是结论）

- `packages/core/src/prefs.ts`、`/api/prefs`、dsh 插件工具 `crosscart_list_prefs`、首页 `#prefs-list` + `#pref-form` 都已存在。
- 首页偏好区文案目前如实写「AI 会读到这些偏好」而**没有**写「已个性化」——若 5A 证明偏好未进排序，这个措辞必须保持。
- `rankCandidates`（core）已存在，已知行为之一是「有真实可下单候选就排除演示件」；**它是否读取偏好未经验证**。
- 偏好存储是单机 `data/state.json`，无多用户 / 无账号体系 —— 这会限制「用户画像」的讨论范围，方案里要正视。
- 本轮收尾时后台 `npm run studio` 已停止（8790 未监听），新会话先起服务。

### 9.4 工程边界

不改 UI 视觉基线（`studio/home.*`、`index.html`、`styles.css` 的观感层）；不动场景生成 / 热点识别 / 费用控制 / 定价与到账逻辑；不清空历史偏好与方案；不调用付费图像生成；不引入多 Agent 架构替换现有实现；新增能力优先落在 `packages/core`（纯函数、可单测）+ 最少量的 bridge 端点与插件工具。

### 9.5 启动方式

```bash
cd D:/aiproject/crosscart
npm run studio          # 8790；浏览器 http://127.0.0.1:8790/
curl -s http://127.0.0.1:8790/api/health
curl -s http://127.0.0.1:8790/api/prefs          # 看现有偏好真实结构
curl -s http://127.0.0.1:8790/api/plans | head -c 400
```

### 9.6 5A 审查结论（2026-11-18 完成，零代码改动）

**全文报告：`docs/Phase5A-偏好系统审查.md`**（A 现状 / B 链路 / C 缺口 / D 方案 / E 文件接口 / F 顺序与测试 / G 成本风险）。要点：

1. **排序 0 影响**：`rankCandidates(plan, slotId, catalog, strategy, opts)` 没有偏好入参，打分只有「策略 0.40 + 到货 0.25 + 价格 0.20 + 风格 0.15（与当前单品的 Jaccard）」。隔离副本实测：基线 `pln_020` 5 个槽位候选（14/18/15/29/33 条）在「有偏好 / 清空偏好」下 `(productId, score)` 逐项相同。
2. **上下文 0 注入**：`planContext()` 不提偏好；`/api/catalog` 只有 `category / colorFamily / maxPrice / q / limit`；无系统提示要求读偏好。
3. **模型偶然读**：`data/chat.json` 47 次工具调用中 `list_prefs` 3 次、`save_pref` **0 次**。其中一次读完后拉目录没传 `colorFamily`，另一次是先拉目录再读偏好 → 结果不可归因。
4. **两条选品路径（关键）**：建方案 = 模型自挑 `productId`（`createPlan` 只校验存在性/类目，无排序、无预算硬过滤）；换件才走 `rankCandidates`。**只改排序影响不到建方案。**
5. **三个实测缺陷**：① 同 attr 二次写入被 `resolveAttr` 的 `.find()` 取第一条（改成 dark 仍生效 light）；② `scope=task` 无 planId/会话键、落盘永不过期；③ `/api/prefs` 无 DELETE/PATCH，`savePref` 写死 `confirmedByUser:true`（接口层不存在「待确认」）。
6. **attr 词表三套并存**：插件 `color_family/style/size_*/avoid`、首页表单 `style/palette/fit/budget/avoid`、单测 `color.like`。
7. **现有「硬约束」其实半软**：到货与预算都是加权项，预算真正拦住的是 `applySwap` 里「仍超且更贵则拒绝」。故偏好只能在 **pool 阶段**先排除，靠权重调小无法表达「不许出现」。

**当时的下一步 = F0**（已完成，见 §9.7）：`upsertPref` + 取最新 + `taskKey` 失效 + 软删 + canonical attr 别名迁移，**不改变排序行为**。

### 9.7 F0 实施记录（2026-11-18 晚，已验收）

**目标**：只修「数据怎么存储与裁决」，**排序行为零变化**（`rankCandidates` 一行没动，候选结果与 F0 前逐项相同）。

**改了什么**

| 文件 | 改动 |
|---|---|
| `packages/core/src/prefs.ts` | 重写。新增 `CANONICAL_ATTRS`(9 个) + `ATTR_ALIASES`(`color_family/color.like/color/budget/brand` → canonical) + `normalizeAttr` / `isCanonicalAttr` / `normalizePref`（保留 `attrRaw`）；`upsertPref` 覆盖式写入（旧记录标 `supersededBy`，历史不删）；`resolveAttr(records, attr, fallback, ctx?)` 改为**取最新**并新增 `PrefContext{taskKey}`；`isPrefActive` 判定 deleted / superseded / 未确认 / taskKey 不匹配；`prefsOverview` 给 UI/工具用的分组投影（active·overridden·superseded·deleted·unconfirmed·inactive） |
| `packages/bridge/src/state.mjs` | `loadState` 对老记录做幂等迁移（补 `id=legacy_N`、`source=legacy`、attr 归一）；`savePref` 改为 upsert + 生成 `pref_NNN` + 记录 `source/taskKey/evidence`，**`scope=task` 无 taskKey 直接抛错**；新增 `confirmPref` / `deletePref`(软删) / `prefsView` / `migratePref` / `findPref` |
| `packages/bridge/src/server.mjs` | `GET /api/prefs` 返回 `{prefs(生效), all, groups, counts}`，支持 `?planId=`；`POST` 走新 `savePref`；新增 `PATCH /api/prefs/:id/confirm`、`DELETE /api/prefs/:id`；CORS 允许 PATCH/DELETE |
| `packages/dsh-plugin/src/index.ts` | `crosscart_save_pref` 增 `planId` 参数（`scope=task` 必填，否则报错说明），`source:'ai'`；`crosscart_list_prefs` 增可选 `planId`，输出带状态（生效中/被覆盖/已取代/已删除/待确认/所属任务已结束） |
| `packages/core/test/prefs.test.ts`（新） | 14 条守门用例：覆盖写入、三次链、profile/task 分槽、taskKey 失效、旧无键 task 兼容、软删、未确认、已取代、别名归一、`attrRaw`、canonical 判定、`resolveAll`、`prefsOverview` 状态标注 |
| `scripts/check-prefs-ui.mjs`（新）+ `npm run check:prefs` | 界面自检 9 条：保存提示、同属性二次写入只留一行且显示新值、旧记录被标 superseded、界面行数=生效条数、无 JS 报错 |
| `README.md` / `package.json` | API 表补 3 行（GET/POST 语义、PATCH confirm、DELETE 软删）；新增 `check:prefs` 脚本（`test` 脚本加入 `prefs.test.ts`） |

**验收结果**

- `npm test` **92/92**（F0 前 78，新增 14 条；其余 78 条一条没改）
- `npm run verify` **46/46**、`npm run verify:stage3` **140/140**、`check-home-ux` **18/18**、`check:prefs` **9/9**
- 隔离实例实测（`.tmp/f0`，不碰基线）：`light→dark` 生效 **dark**（旧记录 `supersededBy`）；`task` 不带 planId → **HTTP 422** 并给 hint；`task` 带 `pln_020` 时压过 profile、换成 `pln_040` 后自动 `inactive`；AI 推断记录 `pending=1` 且 `winner=null`，PATCH 确认后才生效；DELETE 后 `counts.deleted=1`、`winner=null`、再确认返回 422。

**三条新规矩（写 F2 前必读）**

1. **`scope=task` 必须带 taskKey**（planId）。不带就报错——这是「一次旅行的临时要求不能永久生效」的唯一机器保证。
2. **`resolveAttr` 现在取最新、且默认忽略带键的 task 记录**（调用方不给 ctx 就用不到它）。写工具/接口时要把 ctx 传下去，否则会「明明存了却不生效」。
3. **`GET /api/prefs` 的 `prefs` 字段已改为「仅生效记录」**（被取代/删除/失效的不在里面，去 `all` 或 `groups` 看）。首页列表因此不会再显示已经改掉的旧值——这是修 bug，不是回归。

**F0 尚未做（F2/F3 的事，别在本轮顺手加）**：偏好未进入 `rankCandidates`（排序仍与偏好无关）、首页没有「待确认 / 删除」按钮、没有 `crosscart_propose_pref`。（「未注入 `planContext`」已由 F1 完成，见 §9.8）

```bash
# 隔离实例跑偏好自检（零模型/图像费用）
CROSSCART_DATA_DIR=.tmp/f0 CROSSCART_PORT=8791 node packages/bridge/src/server.mjs
node scripts/check-prefs-ui.mjs http://127.0.0.1:8791
```

### 9.8 F1 实施记录（评审通过，已验收）

**目标**：让「AI 读得到偏好」从文案变成事实，且 **0 次额外模型调用**。

**形状**：`core/src/prefs.ts` 新增 `prefsBrief(records, ctx, opts)` → `{ lines, attrs, omitted, text }`，纯函数、`maxLines` 默认 6、单值默认 40 字截断；`packages/bridge/src/plan-context.mjs`（新文件，从 `server.mjs` 搬出）把它插在「场景」与「待买」之间，并附一条硬约束规则。

**注入原文长这样**（真实数据实测）：

```
用户偏好（用户自己设置或已确认，按「长期 / 仅本方案」标注）：
- 风格偏好：极简、中性色，不要大面积印花（长期）
偏好使用规则：这些偏好只用于软性选品（颜色/风格/品牌倾向），**不能覆盖预算、到货时间、收货地、类目等硬约束**；
与用户这句话里的当前要求冲突时，以当前要求为准，并说明差异。不得因为偏好而声称某个金额、汇率或到货时间。
```

**六条设计约束（改这段前先看）**

1. **只读 `confirmedByUser` + 当前上下文的记录**：未确认 / 已删除 / 被取代 / 过期 task 一条都进不去（全部由 `resolveAttr` 裁决，不靠模型过滤）。
2. **≤6 行硬上限**：超了保留前 5 条 + 「另有 N 项偏好未在此列出（用 crosscart_list_prefs 查看）」。canonical 顺序固定（颜色→风格→避开→尺码→品牌→预算），不随写入顺序抖动。
3. **taskKey = planId**：本方案偏好显示「（仅本方案；长期为 X）」；换方案自动回落长期；`__none__`（还没建方案）只带长期偏好——**建方案路径也读得到**，这是 5A 里 `rankCandidates` 碰不到的路径。
4. **没有生效偏好 → 整段不注入**（不是注入「你没有任何偏好」，避免模型把空段落当事实）。
5. **偏好只做软性输入**：硬约束优先写在 prompt 里，真正的硬保证留给 F2 的 pool 阶段（代码层排除），不依赖这段文字。
6. **可观测**：`GET /api/prefs?planId=` 新增 `brief` 字段 = 下一轮将注入的原文（同一份数据），验收不必读模型回复。

**端到端证据（真实 DeepSeek 调用 1 次，隔离实例）**：写入 `avoid=大面积印花、荧光色` 后问「我最不喜欢什么颜色和图案？只根据你已经知道的信息回答，不要查工具」→ 回答命中两项，且该回合 `tools=[]`（没调 `list_prefs`）。**答案只能来自注入的上下文**。注意：这只证明「读得到」，不代表推荐结果被偏好改变（F2 才做，验证方式必须是候选集差异，不是措辞）。

**同时修掉的隔离缺陷**：`ChatRuntime.transcriptPath` 原来写死 `join(ROOT,'data','chat.json')`，用 `CROSSCART_DATA_DIR` 起隔离实例时**仍会写真实会话记录**（本轮端到端测试实测污染 2 条，已回滚）。现改为 `join(DATA,'chat.json')`；隔离实例 `GET /api/chat` 返回 `messages=0` 可验证。

**验收**：`npm test` **99/99**（F0 92 + F1 7 条）、`check:context` **24/24**（`npm run check:context`）、`verify` **46/46**、`verify:stage3` **140/140**、`check-home-ux` **18/18**、`check:prefs` **9/9**。方案快照文案与金额行逐字未改。

**F1 没做**：`rankCandidates` 仍未读偏好（F2）、没有 `propose_pref`（F3）、首页没有「待确认 / 删除」按钮（F3）。


### 9.9 F2 实施记录（2026-11-18 深夜，已验收）

**目标**：从「AI 知道你喜欢什么」推进到「偏好真的改变候选集与排序」，同时不破坏策略主导、预算守卫、单点换件。

**三层结构（顺序不能反）**

| 层 | 做什么 | 在哪 | 可解释产物 |
| --- | --- | --- | --- |
| 硬层 | 尺码不含 / 避开品牌 / 标题颜色标签含避开词 → 移出候选池 | `core/src/pref-match.ts` `prefExclusionHits()` | `excluded[{productId,title,reasons}]` |
| 软层 | palette +0.05、style +0.03、brand_prefer +0.02（合计 ≤0.10） | `prefBonusFor()` | `Candidate.prefBonus` / `prefWhys` |
| 文本层 | ≤6 行注入 prompt（F1） | `plan-context.mjs` | `GET /api/prefs` 的 `brief` |

**四条硬规矩（改排序前必读）**

1. **无偏好必须逐位相同**：`prefs: []` 时 `prefBonus=0`、`excluded=[]`，`pln_020` 5 槽位仍是 14/18/15/29/33 条、top1 `0.681/0.702/0.763/0.867/0.894`。测试 `pref-ranking.test.ts` 第一条守这个。
2. **硬排除在 pool 阶段**，被排除的商品不参与打分，因此「加分复活」在结构上不可能。
3. **cheaper 双闸**：① 不比当前这件便宜 → 不加分；② 到手价高于「无偏好最优」→ 不加分。已用 110 组「偏好 × 槽位」机器校验 0 违规。
4. **覆盖率 ≥80% 的软规则停用**：真实目录 `minimal` 覆盖 93%，照常给分等于「人人 +0.03」——顺序不变却假装个性化。现在会写进 `relaxed`：「风格偏好：18/18 件候选都符合，没有区分度，不用于排序」。

**规则会排除全部候选时**：放弃该规则并记 `relaxed`，不让偏好把候选池清空（宁可承认没执行，也不制造空列表）。
> **F3 已推翻这一条**：明确排除（避开品牌 / 尺码 / 避开词）排空候选时不再放宽，改为返回空候选 + `blockedBy`。见 §9.10。

**建方案路径（要求 5）**：`createPlan` 不重排候选，新增 `checkPlanPrefConflicts()` 只报告冲突；`POST /api/plans` 返回 `prefConflicts`，插件 `crosscart_create_plan` 在工具文本里追加「⚠️ 偏好冲突…如果这不是你想要的，我可以换掉它」。方案本身不被改写。

**接口变化（都是新增字段）**

- `GET /api/plans/:id/candidates` → `{ candidates, excluded, relaxed, applied, unmapped }`；每个候选项新增 `prefBonus` / `prefWhys`。
- `POST /api/plans/:id/swap` → 响应新增 `prefRanking: { applied, excluded, relaxed, unmapped }`。
- `POST /api/plans` → 响应新增 `prefConflicts` / `prefApplied` / `prefUnmapped`。
- UI：换件抽屉顶部出现「偏好参与排序 / 已排除 N 件 / 未识别」三行；候选卡片上加「颜色符合你的偏好（dark）+0.05」。**只加元素，未改既有 id / class**。

**机器报告**：`npm run report:f2` → `docs/F2-候选差异报告.md` + `.json`（8 个场景 × 24 组对照）。关键数字：
- 无偏好：5 槽位 0 排除、0 加分、0 名次变化、top1 不变 ✅
- `palette=浅色`：14 组中 5 组加分、名次变化 4–7 处
- `brand_avoid=Rothy's`：鞋池 29→18、包池 33→19
- `size_shoes=8`：29→27
- `avoid=Wristlet`：鞋池命中（报告里另有 heels 0 命中的如实记录）
- `cheaper + brand_prefer=Everlane`：外套加分 0（Everlane 都更贵，被第二道闸拦住）
- top1 敏感度：440 组里 37 组第一名发生变化（真实可见）
- cheaper 守卫：110 组 0 违规

**真实目录的能力边界（不要靠调权重掩盖）**：`minimal` 覆盖 122/131（93%）；只有 4 家店；没有高跟鞋（`avoid=heels` 排除 0 件）；中文避雷词在英文标题上命中 0 件。报告末尾写了「要补的是标签/字段，不是权重」。

**验收**：`npm test` **117/117**（F1 99 + F2 18）、`check:f2` **15/15**、`report:f2` 可复现、`verify` **46/46**、`verify:stage3` **140/140**、`check-home-ux` **18/18**、`check:prefs` **9/9**、`check:context` **24/24**。
截图 `shots/f2/swap-{desktop,mobile}.png`、`drawer-{desktop,mobile}.png`（候选图空白是 Shopify CDN 在本机不可达，非本轮改动；`curl` 该 URL 返回 000）。

**F2 没做**：`crosscart_propose_pref`（F3）、首页「待确认 / 删除」按钮（F3）、自由文本偏好的语义匹配（需要商品补中文关键词）。

### 9.10 F3 实施记录（2026-11-18 深夜，已验收）

**目标**：AI 可以发现偏好，但**只有用户能把它变成长期记忆**；用户随时能改、能删。优先级明确：宁可 AI 少记住，也不许它替用户做主。

**数据形状（`PrefRecord` 新增，全部向后兼容）**

| 字段 | 含义 | 谁写 |
| --- | --- | --- |
| `evidence {basis, ref?, quote, slot?, productId?}` | 依据：`swap`/`selection`/`chat`/`form` + 锚点 + 原话 | AI 提议必填；用户表单可缺 |
| `rejectedAt` + `rejectReason?` | 用户明确拒绝的时间与原因（与「删除」区分） | `PATCH /api/prefs/:id/reject` |
| `updatedAt` | 同一条待确认提议被更新值的时间 | `updateProposal()` |
| `source` | `user_form` / `ai` / `legacy`（UI 用来标「你设置 / AI 推断 · 你已确认」） | 写入方 |
| `supersededBy` / `deletedAt` / `confirmedByUser` | 老字段，语义不变 | — |

**四条硬规矩（改偏好链路前必读）**

1. **未确认不得覆盖已确认**：`upsertPref()` 分级 —— 已确认写入会取代同槽位全部活记录；**未确认写入只能顶掉其他未确认记录，绝不把已确认偏好标成 `supersededBy`**。用户确认 `palette=light` 后 AI 推断 `palette=dark`，light 继续生效，dark 只进 pending。测试 `propose.test.ts` 第一条守这个。
2. **判重（`planProposal()` 纯函数）**：同槽位已有同值且已确认 → `skip_duplicate`；已有同值 pending → `skip_duplicate`；已有不同值 pending → `update_pending`（就地改，不新增第二条）；其余 `create`。
3. **拒绝留痕**：`rejectedAt` 有值的记录不生效、不进 pending，且**同 attr + 同值**的提议以后一律 `skip_rejected`。拒绝只封同值 —— 推断出不同值时仍可提议（不能因为拒过一次就永远闭嘴）。
4. **依据必须可复核**：`validateEvidence()` 要求 `basis` 合法、`quote` 非空（≤200 字）；`swap`/`selection` 必须带 `ref` 或 `productId`；`POST /api/prefs/propose` 再校验 `ref` 指向的方案真实存在。**引述内容是否真说过代码判断不了** —— 所以 UI 必须标「AI 推断」并让用户点头，不许把「AI 说你说过」当事实。

**确认 = 覆盖式写入，不是改标志位**：`state.confirmPref()` 把同槽位其他活记录标 `supersededBy`（旧值进历史）。只改 `confirmedByUser` 会让新旧两条同时生效候选，解析时靠 `createdAt` 撞运气。

**明确排除不再静默放宽（F2 遗留边界一，本轮已修）**

- 旧行为：某条排除规则会排掉全部候选 → 放弃它并记 `relaxed`（用户要求避开 Rothy's，系统却悄悄推荐 Rothy's）。
- 新行为：`rankCandidatesDetailed()` 直接返回 `candidates: []` + `blockedBy: ['本类目 29 件候选都不符合你的明确要求（没有你的尺码 XXL），没有可推荐的替代品 —— 需要放宽其中一条才能继续']`；`applySwap()` 抛 `NO_CANDIDATE`，文案带 hint「可以改偏好、放宽其中一条，或手动指定一件」。
- `relaxed` 只剩「软规则覆盖率 ≥80% 没有区分度」一种含义，不再表示「放弃硬规则」。
- UI：候选抽屉空态直接显示 `blockedBy`，不再说「换个策略再试」这种误导话。

**接口 / 工具变化（都是新增）**

- `POST /api/prefs/propose` → `{action, reason, note, record, changed}`；`action ∈ create | update_pending | skip_duplicate | skip_rejected`。
- `PATCH /api/prefs/:id/reject`、`PATCH /api/prefs/:id/confirm`、`DELETE /api/prefs/:id`（三条语义分开：拒绝 / 确认 / 删除）。
- `GET /api/prefs` → 新增 `pending[]`、`counts.rejected`；**`prefs[]` 语义收紧为「已确认且生效」**（原来混着未确认记录）。
- `GET /api/plans/:id/candidates` → 新增 `blockedBy`；swap 响应 `prefRanking` 同步带。
- 插件：新增 `crosscart_propose_pref`（attr/value/basis/quote 必填）、`crosscart_reject_pref`（用户明确否决时用）；`crosscart_save_pref` 增加必填 `quote`，并在描述里写明「只能用于用户已说清『记住』的情况」。

**首页（只加不删，既有 id 全保留）**

- `#prefs-pending` + `#prefs-pending-list`：AI 推断条目，显示 `attr / value / 长期|仅本方案 / 依据原文（来自换件·plan_020）`，两个按钮「确认，以后都参考」「拒绝」。
- `#prefs-list`：生效偏好，每行右侧「删除」；值后带来源徽标（`你设置` / `AI 推断 · 你已确认` / `历史记录`）。
- `#pref-history`（`<details>`，折叠）：被取代 / 已删除 / 已拒绝，带时间与拒绝原因 —— 历史可追溯但不吵。
- 三个操作都走服务端后重新拉取（不在前端猜状态）；SSE `prefs.proposed` / `prefs.updated` 触发 200ms 防抖刷新，所以方案页换件后 AI 提议，首页开着就会自己冒出来。
- 390px：只收时间、保留删除按钮；偏好输入框独占一行（原来 placeholder 被按钮挤掉一半）。

**踩的坑（新增）**

- **重复 id 会静默拿错元素**：首页方案区原本已有 `<ul id="pending-list">`（待生成场景图），偏好区再用同名 id → `getElementById` 拿到前面那个，偏好条目被渲染进方案区，点击事件也不冒泡到 `#prefs`（按钮点了没反应、也不报错）。已改为 `#prefs-pending-list`，并在 `renderPending()` 上方留了注释。
- `#prefs` 比视口高，`scrollIntoViewIfNeeded()` 不能保证截到偏好区 → 截图改用 `locator('#prefs').screenshot()`，同时保留一屏整页图。
- `check-prefs-ui.mjs` 原来按 `.k` 文本匹配 `palette`，界面改中文标签后失效 → 加 `data-attr`，脚本优先读它、缺了再退回文本。

**验收（全绿）**

| 项 | 结果 |
| --- | --- |
| `npm test` | **133/133**（F1 99 + F2 18 + F3 16） |
| `npm run check:f3` | **70/70**（A–I 九段，含真实浏览器 1440/390） |
| `npm run verify` | **46/46** |
| `npm run verify:stage3` | **145/145** |
| `check:f2` / `check:context` / `check:prefs` / `check-home-ux` | 15/15 · 24/24 · 9/9 · 18/18 |

**闭环证据**：`docs/F3-闭环记录.json`（每次提议/拒绝/确认的完整记录 + 三组推荐签名）、`shots/f3/panel-prefs-{1440-before,1440-pending,1440-confirmed,390-pending}.png`。

`check:f3` 的九段与用户验收表一一对应：A 推断生效性 / B 冲突不覆盖 / C 重复不新增 / D 拒绝 / E 确认 / F 删除 / G 临时换件不转长期 / H 明确排除不放宽 / I 首页真实点击。UI 段另起一个干净隔离实例，避免前八段的测试记录污染截图。

**F3 没做 / 留给 F4**

1. ~~建方案仍只报告 `prefConflicts`~~ **F4 已解决**：冲突抛 422、不落库；破例需用户原话且只对当套方案生效（见 §9.11）。
2. AI 不会主动在对话里「发现」偏好 —— 目前靠模型自己决定何时调 `propose_pref`；没有批量挖掘历史行为。
3. 拒绝没有「后悔药」：UI 只能看到历史记录，不能把一条 rejected 恢复为 pending（用户可以重新用表单添加）。
4. 自由文本偏好仍受商品标签限制（F2 结论不变）。

### 9.11 F4 实施记录（2026-11-18 深夜，已验收）

**目标**：把「建方案」拉到和「换件」同一条硬约束上，并让偏好解释可复核。

**核心变化**

1. `validatePlanAgainstPrefs(plan, prefs, ctx, { allowRules })`（`core/src/ranking.ts`）：
   返回 `violations / exempt / applied / unmapped / checks`。`checks` 覆盖预算、到货、收货地、自由文本，三态 `ok | violated | unverified`。
2. `state.createPlan` 改为**先校验后落库**：冲突抛 `PREF_CONFLICT`（422，带 `details.violations` 与 `actions`），不 `set`、不 `persist`、不广播。
3. 破例只记在方案上：`plan.constraints.prefExceptions = [{ rule, quote, at }]`；规则 ID 白名单（`brand_avoid/avoid/size_*`），必须附用户原话（≥4 字）。**长期偏好不变**。
4. `createPlan` 增加类目校验（`CATEGORY_MISMATCH` 409）—— 把包塞进鞋位不再静默成功。
5. 解释字段：`prefRanking.picked = { prefBonus, prefWhys, rankWithPrefs, rankWithoutPrefs, rankChanged }`；建方案响应带 `prefChecks/prefExempt/prefExceptions`；Studio `#risks` 追加破例与冲突；AI 文案区分「加分但名次未变 / 偏好确实改变名次 / 参与排序但没加分」。

**硬规矩（改推荐链路前必读）**

- 预算超支**不阻断**建方案（用户自己的数字要可见），但必须 `violated` + 进 AI 回复与风险列表；关税不可用时预算只能 `unverified`。
- `unverified` 不等于通过：收货地不是 `CN` 时返回「没有该地区的运费/时效数据」。
- 被排除商品不因 `exempt` 复活：`exempt` 只表示"这件不阻断"，候选排序仍走硬过滤。
- 授权不等于改偏好：破例后 `GET /candidates` 仍然排除该品牌（`check:f4` E 段验证）。

**验收**：`npm test` **141/141**、`check:f4` **50/50**、`check:f4:dialog` **12/12**（真实 DeepSeek 三场景）、`verify` 46/46、`verify:stage3` 140/140、`check:f3` 71/71、`check:f2` 15/15、`check:context` 24/24、`check:prefs` 9/9、`check-home-ux` 18/18。

**证据**：`docs/F4-推荐闭环与验收报告.md`、`docs/F4-验收证据.json`、`docs/F4-对话验收.json`、`shots/f4/`。

**F4 明确没做**：AI 主动挖掘偏好；中文避开词对英文标题的语义匹配；预算硬阻断（保留为可见警告）。

---

## 十、F4.5 部署记录（公网测试版）

- 结构：本机 Node `127.0.0.1:8796`（`npm run demo`）+ 隧道（`npm run tunnel`）。**不是**静态托管 —— dsh 运行时与本机商品缓存无法搬到静态平台。
- 隧道：**Cloudflare 快速隧道**（`cloudflared tunnel --url`，无需账号，地址 `https://xxx.trycloudflare.com`）。最早用的 localhost.run 免费层实测约 8KB/s 且域名反复轮换（同一 228KB 文件要 29.7 秒），只留作兜底（`TUNNEL=ssh`）。
- 隔离：`data-demo/` 独立目录（空 state、独立 chat、独立场景缓存与额度），真实 `data/` 不动。
- 保护：`CROSSCART_ACCESS_TOKEN` → 所有 `/api/*` 401，页面走口令登录页并种 HttpOnly Cookie；`/api/health` 匿名只回 `{ok,authRequired}`。
- 限流：对话 40 次/小时、场景图 6 次/小时（429 带等待时间）；图像另有 $8/月预算。
- **工具白名单**：`packages/dsh-plugin/cordis.demo.yml` 关闭 shell / 文件 / 技能 / 子代理 / web / 工作目录工具，只留 crosscart 插件；`CROSSCART_DSH_PATCH` 指定。提示注入实测无法调用命令。
- 链接：`CROSSCART_PUBLIC_URL` 让模型给出的方案地址是公网域名（否则会贴 `127.0.0.1`，用户点不开）。
- 隔离上下文：`CROSSCART_AGENT_CWD` 指到数据目录，模型上下文不再出现项目源码路径。
- **场景图网页小图**：`image-web.mjs` 生成 900px WebP（2.9MB → 180KB），`sceneView.image` 给小图、`imageOriginal` 给原图；老图启动时后台补齐。原因是原图在窄带下传不完、舞台空白（公网实测踩到）。唯一动过的旧断言：`verify-workbench` 的 `.png` 后缀校验改为 `png|webp`。
- **方案删除**：新增 `DELETE /api/plans/:id`（`ws.removePlan`），用于清理验收残留；页面暂无删除按钮。
- 公网实测 24/24：`npm run check:public -- <url> <token>`，结果 `docs/F4.5-公网验收.json`、截图 `shots/deploy/`；场景图真实生成一张（$0.038，`pbvkz6`）。
- 说明与体验指南：`docs/F4.5-部署与体验说明.md`。

**限制**：隧道域名每次重启都变；单实例共享状态，无多用户隔离；服务/隧道进程退出即不可访问。

---

## 十一、Phase 6 · 消费者端去工作台化（2026-11-19 完成）

目标：把「工程师调试台」改成消费者能直接用的 AI 购物助手。**只改呈现与入口，不动排序权重、偏好硬过滤、换件确定性、金额与物流口径。**

### 11.1 三栏与首屏

左（AI 顾问，输入框固定底部）｜中（方案名 + 约束 + 穿搭图）｜右（换装 + 清单 + 金额）。`fitStageFrame()` 仍以栏宽为唯一基准。

首屏实测（`check:p6:ui`，只读、真浏览器）：

| 视口 | 类目入口底边 | 清单首行 y | 金额块底边 | 横向溢出 |
|---|---|---|---|---|
| 1440×900 | 150 | 206 | 767 | 0 |
| 1366×768 | 150 | 206 | 645 | 0 |
| 1920×1080 | 150 | 206 | 917 | 0 |
| 390×844（清单页） | 150 | 204 | 669 | 0 |

### 11.2 逐项改动

- **P1 偏好区**：删「变更记录 / 历史列表 / 机制说明 / 长空态文案」，只留「我的偏好（已保存 N 条）+ 待确认（确认后才会用于推荐）+ 一行输入」。审计数据仍在 `state.json` 与 `GET /api/prefs` 的 `all` 里。首页方案区「待生成场景图」→「更多方案」。
- **P2 类目按钮**：`#slot-chips` 整体移到 `#pane-shop` 顶部 `.shop-swap` 内，5 列紧凑网格（gap 1px 用底色当分隔线），第二行显示 `添加 / 已有 / $价格`，选中反白。点一下 = 选中 + 开候选抽屉（只读零付费）。图下那一行已删除。
- **P3 约束入口**：`#btn-edit-plan`（带 `aria-expanded`）在方案基本信息右侧，默认收起；展开是同一行的三个真实字段（`#budget-input` `#arrival-input` `#ship-input`），保存后自动收起并 PATCH 到后端。`#rev-chip` 删除。
- **P4 建议**：`.qa-chip` 最多 3 条（超预算压预算 / 补空槽 / 换场景 / 换便宜外套），每条带 `.qa-x` 独立关闭，关闭记在 `sessionStorage['cc.dismissedSuggestions']`；有用户消息后自动收起，只留 `[data-suggest-toggle]`「显示建议」；**本来没有建议时整块不占位**。
- **P5 已拥有**：见 §11.3。
- **P6 清单**：一行 = 缩略图 56×70 + 名称/品牌 + 到手价 + 详情或购买入口；底部固定金额块（总额/预算/剩余/超支条 + 渠道按钮）。删掉「演示数据」标签与「无购买链接」段落，不可买的仍如实写「已有 / 无购买页」（原因放 `title`）。
- **P7 热点**：`.hotspot` 变透明热区（opacity 0、无文字、无 title、`unsure` 不可点），`#hotspot-note` 内容清空且常隐；「修正热点 / 重新识别 / 可信度」入口删除。服务端识别、`hitArea()` 46px 扩边、面积降序层叠都没动，点测仍在 `verify:stage3` B 段。
- **P8 成本**：`$0.29 / $8 / 额度` 全部移出消费者界面。额度用完只在舞台上出现一句「暂时无法生成新图」；确认框写「大约 30–60 秒」，失败按 `BUDGET_BLOCKED / RATE_LIMITED / SCENEGEN_UNCONFIGURED` 分别给「用完了，过一会儿再试 / 太频繁，约 N 秒后再试 / 现在还不能生成，可以先看商品图」。服务端 6 张/小时与月度预算保护不变。

### 11.3 P5 根因：每份新方案都自带「已拥有深色直筒牛仔裤」

**两条通路同时存在**（只堵一条都还会复发）：

1. `packages/dsh-plugin/src/index.ts` 里 `crosscart_create_plan` 的示例参数写着 `{"slot":"bottom","status":"owned","productId":"own_dark_jeans"}` —— 模型照示例填，于是每份新方案都多一条。
2. `plan-context.mjs` 把上一份方案的「已有」当事实注入下一轮上下文（`- 裤装：深色直筒牛仔裤（已有…）`），模型据此认为用户确实有，越滚越真。
3. 旁证：`createDemoPlan()` 里也有硬编码的 owned 槽位；`data/state.json` 有 31 份历史方案带这条 owned —— 但这些是**结果**不是原因，直接删数据只会让 bug 隐蔽。

**修法（数据层强制，不靠文案）**：

- `status:'owned'` 必须在同一请求带 `ownedClaims:[{productId, quote}]`，quote 是用户原话（≥2 字）。否则 `OWNED_UNDECLARED` 422，**不 set / 不 persist / 不广播**。claim 必须对上同一个 productId，空 quote 不算。
- 通过后把 `ownedClaim{quote, at}` 记在槽位上（可审计、可显示来源）。
- 上下文只把「有 claim 且不是示例」的 owned 写成「用户声明已有」；示例/历史 owned 单独一段并明确写「**不代表用户真的拥有，不要在新方案里沿用**」。
- 插件参数说明与示例改成 `to_buy`/`empty`，并新增可选 `ownedClaims`；命中 422 时给模型明确的返工指引。
- 示例方案照同一条规则走，用自己的「示例」claim（`示例方案：假设你已有一条深色直筒牛仔裤`）。
- 界面按来源标 `你说过已有 / 示例假设 / 历史数据`，历史方案照常显示原状态（不清历史）。

**验收**：`check:p6:owned` 41/41（未声明→422 且不落库、错商品/空原话→422、声明→200+原话、新建另一方案不继承、新开聊天不继承、历史方案可读但上下文警告、示例方案不污染、落盘自检 owned 必有凭证、历史方案数不减少）；`check:p6:dialog` 真实模型 3 轮（未声明不产生 owned / 声明必带原话 / 重置聊天后仍不自动 owned）。

### 11.4 断言变更（只这三类，均已说明理由）

| 脚本 | 旧断言 | 新断言 | 原因 |
|---|---|---|---|
| `verify-stage3` A | `#hotspot-note` 含「已自动识别」 | 不展示识别说明 + 热点透明无文字 + 后端热点数据仍在 | P7 要求隐藏识别过程 |
| `verify-stage3` H | 胶囊含「图像 $」、title 含「用完」 | 胶囊出现且文案不含金额/额度数字 | P8 要求区分生成成本与购物支出 |
| `check-f3` I | `#pref-history` 展开后能看到 light 被取代 | 页面无该块 + API `all` 里 light 仍 `supersededBy` | P1 删除审计视图，数据未删 |

其余（`verify` 46、`check:f4` 50、`check:f2` 15、`check:context` 24、`check:prefs` 9、`check:home` 18）未改断言。

### 11.5 验收数字

`npm test` 141/141 ｜ `check:p6:owned` 44/44 ｜ `check:p6:ui` 84/84 ｜ `verify` 46/46 ｜ `verify:stage3` 145/145 ｜ `check:f4` 50/50 ｜ `check:f3` 72/72 ｜ `check:f2` 15/15 ｜ `check:context` 24/24 ｜ `check:prefs` 9/9 ｜ `check:home` 18/18 ｜ `check:p6:dialog` 9/9（真实模型 3 轮）｜ `check:public` 24/24。

报告：`docs/Phase6-消费者端体验改造报告.md`；截图：`shots/phase6/`。

## 十二、P9 · 产品体验修复与正式部署（2026-11-20 完成）

报告：`docs/P9-体验修复与部署报告.md`；截图：`shots/p9/`。

### 12.1 最重要的一个根因（改生图/提示词前必读）

用户说「我有白色的鞋子」，图里却是黑短靴。**不是提示词不够狠，是信息在三处被丢掉了**：

1. `buildScenePrompt()` 用 `plan.slots.filter(s => s.item)` 拼穿搭 —— 口头声明的自有单品没有 productId（`item === null`），**整条信息在拼提示词时被过滤掉**，脚上穿什么完全由模型自由发挥；
2. `plan-context.mjs` 同样按 `s.item` 过滤 —— 模型自己看到的方案结构里那双白鞋也不存在（说的和画的来自两份都不完整的事实）；
3. `sceneCacheKey()` 不含口头声明 —— 用户把「白鞋」改成「黑靴」键不变，直接命中旧图。

修法：抽象「已有」建模到 slot 上（`ownedClaim.label/color`），进提示词硬约束、进缓存键、进上下文、进界面；**不要再走「往提示词末尾追加一句」这条路**，那条路解决不了 2、3。

### 12.2 抽象「已有」的契约

- 结构：`{slot:'shoes', status:'owned', ownedLabel:'白色运动鞋', ownedColor:'white'}` + `ownedClaims:[{slot,label,color,quote}]`；**`item` 保持 null**，不许编商品。
- 校验（`state.mjs` `createPlan`）：`status==='owned'` 且无 productId 时，必须有 `ownedLabel`，且**当前这段对话**里用户提过该槽位（`mentionsSlot()` 匹配 `chatEpochStart` 之后的用户消息），否则 422 `OWNED_UNDECLARED`。换新聊天自动失效。
- 提示词：`the wearer's own white shoes and brown bag — must appear exactly as described, do not substitute any of them: the shoes must stay white shoes; the bag must stay brown bag`。
- 结果校验：`checkOwnedMatch()` 按槽位区域算亮度（浅色 p90 ≥ 0.55 / 深色 p50 ≤ 0.72 / 中间记 `unclear`），判错时**只补画一次**（还需过预算闸门）；结果写进 `sceneView.ownedCheck`，界面用 `.cap-warn` 如实提示，不假装满足。
- 用户改口（「鞋子也重新帮我挑」）→ 槽位回 `to_buy`，约束自动释放。

### 12.3 生成状态机（真踩过的两个坑）

- `finally` 里必须把 `running` 归零。否则防抖窗口比换件间隔短时会死锁：窗口到期看到 `running=true` → 只标 pending 返回；上一轮 finally 只排下一次又不清楚 running → 新窗口仍看到 true → **永远「正在更新穿搭图」，一张图都出不来**。
- 合并补排/排队执行时必须 `this.livePlan(plan)`（state 通过 `setScenegen` 注入 `planResolver`）。用换件那一刻的**快照**算键，会命中旧缓存直接返回 → 最新搭配永远没图（`status=missing`）。

### 12.4 部署

- `npm run serve:public` → 无口令实例（独立 `data-public/`，保留限流 40/h + 6/h）。
- 密钥只从环境变量进：`DEEPSEEK_API_KEY` 由 `scripts/provision-dsh-credentials.mjs` 首次写入 `$DSH_HOME/.credentials.yaml`（已存在不动）；图像走 `SCENEGEN_BASE_URL/API_KEY/MODEL`，**云端不要传 `SCENEGEN_PROXY`**（那是本机 7897 代理）。
- `deploy/Dockerfile`（node22 + 全局 dsh + 双数据卷）、`deploy/render.yaml`（blueprint）。换机器能跑的关键是 `packages/bridge/src/dsh-patch.mjs`：启动时按当前仓库位置重写 patch 里的插件绝对路径，否则 dsh 起得来但**工具全没挂上**（表现为 AI 只会聊天、不建方案）。
- 已验证：全新 `DSH_HOME` + 仅环境变量密钥 → dsh 自动初始化 profile → 真实模型正常回话（等价容器冷启动）。**镜像本身未在本机 build 过（无 Docker）**。

### 12.5 P9 断言变更（都写明了理由）

| 脚本 | 旧 | 新 | 原因 |
|---|---|---|---|
| `check-home-ux` | 主视觉必须是 `hero-mobile.jpg` | 允许 `hero-mobile(-N).(jpg\|webp)` | 首屏图改 WebP srcset |
| `verify-stage3` I | 失败提示必须含「失败/图像服务/500」 | 必须同时说清「没成功 + 保留上一版 + 可重试」 | 文案已改口语，旧断言反而更松 |
| `verify-stage3` D | `extra === 1（三次换件合并成 1 次）` | 按换件跨度算窗口上限 + 同窗口内必须恰好 1 次；D 段前先等上一段生成结束 | 换件耗时本身会跨窗口，原断言依赖机器速度 |
| `check-prefs-ui` | `superseded === 1` | 历史里有被取代记录且最新那条是本次旧值 | 同目录重复跑会累积，旧断言是计数假设 |
| `check-public` | 必须带口令（401） | 支持无口令模式，并新增「回复无内部编号/无内部术语」断言 | P9-5 要求免口令公开访问 |

### 12.5.1 `check-public` 的两个时序修正（不是放宽断言）

- 发问前 `waitIdle()`（`running=false` 且消息数连续两次不变）：否则第一条「新」assistant 消息属于上一问，价格断言会拿到「分享链接」的回复。
- `POST /api/chat` 必须显式传 `planId`：不传时服务端默认「最后创建的方案」，公开实例上会答成别人的方案（实测方案 $202、回复 $285，看起来像模型编数，其实是问错了方案）。
- 隧道偶发 502 属链路抖动，重试即可；`PUBLIC_MODE` 的 `/api/health` 只回 `{ok,version}` 是设计如此。

### 12.6 新增 npm 脚本

`check:p9`（55）｜`check:p9:dialog`（17，真实模型+真实生图）｜`serve:public`｜`opt:hero`｜`provision:*` 由 serve:public 内部调用。

### 12.7 P9 验收数字

`npm test` 141/141 ｜ `verify` 46/46 ｜ `verify:stage3` 147→**144**/144（P10 删掉重复断言，见 §13.5）｜ `check:p9` 55→**70** ｜ `check:p9:dialog` 17/17 ｜ `check:public` 27/27（免口令公网）｜ `check:p6:owned` 44 ｜ `check:p6:ui` 84 ｜ `check:f4` 50 ｜ `check:f3` 72 ｜ `check:f2` 15 ｜ `check:context` 24 ｜ `check:prefs` 10 ｜ `check:home` 18。

### 12.8 P9 DOM 契约新增（只加不改）

`#btn-share`（顶栏分享）；`.chip-pair` + `.inspo`（风格词旁的「灵感 ↗」…**P10 已删**，见 §13.6）；`.shop-thumb.placeholder`、`.canvas-empty-slot.owned`（自有单品占位）；`.stage-caption .cap-warn`（颜色对不上时的提示）。`window.__ccCleanReply` 暴露给验收脚本。

---

## 十三、P10 · 体验修复与正式部署基础（2026-11-20 完成）

> 完整报告：`docs/P10-体验修复与部署基础报告.md`；部署步骤：`docs/DEPLOY.md`。

### 13.1 首页外链搬到卡片上

- 删掉页头独立那排「东京·秋季 灵感↗ / 巴黎·周末 灵感↗ / 日常通勤 灵感↗」（含 CSS `.hero-chips .inspo`）。
- 四张编辑精选卡片标题右侧各一个 `a.insp-go`（视觉仍是 `↗`，命中区 34×34），
  链到 Vogue / Harper's BAZAAR 的**具体文章**（四条实测 200，见报告第一节表格），`_blank + noopener`。
- 卡片本身仍是 `button.insp-hit`：点图/标题照旧把需求填进输入框——外链没有覆盖原功能。
- 截图：`shots/p9/home-insp-1440.png` / `-390.png`（滚动到卡片区拍的，能看到箭头）。

### 13.2 确认弹窗是「删掉」不是「藏起来」

删了 `#confirm-modal` 整块 DOM、`openPaidConfirm/closeModal/regenerateSceneConfirmed`、
`scenegen.choose()` 的 `requiresConfirm`、以及 server 三个路由里的确认分支。
**成本保护没有跟着消失**：防抖合并 / 缓存不计费 / 单飞 / 月度预算 402 / 失败不计费，全在服务端。

### 13.3 图过期 / 生成中 / 失败 = 一条轻量状态条（不是弹窗）

`#stage-overlay.strip` + `.stale-strip`：图片左上角一条深色小条，**不压暗、不挡热点点击**。

- 过期：`搭配已更新，图还是上一版 | 更新穿搭图`
- 生成中：`正在更新穿搭图… | 停止等待`，**上一版图继续显示**（以前会清空成白卡片）
- 失败：旧图保留 + 一句人话 toast + 条内可重试

⚠️ `#stage-overlay` 是 `#stage` 的子元素（比图片宽），所以 `syncStripBox()` 在 `fitStageFrame()` 之后
把 overlay 的 `left/top/width/height` 对齐到 `#stage-frame`。**改 fitStageFrame 记得保留这行调用**，否则状态条会跑到照片左边的空白里。

### 13.4 持久化与部署

- `state.mjs` 原子写：`.tmp` → `.bak` → rename；读坏自动回退 `.bak` 并 warn。
- `CROSSCART_DATA_DIR / PORT / HOST / PUBLIC / TRUST_PROXY / ADMIN_TOKEN` + 6 项限流全部由环境变量控制；
  **代码里没有写死 `D:/aiproject`**（仓库根由 `import.meta.url` 推导）。
- 公开模式下 `/api/health` 只回 `{ok,version}` 且不被限流；管理接口（`/api/scenes/budget`、`/api/catalog/refresh`、热点重算/修正）默认 404，配 `CROSSCART_ADMIN_TOKEN` 才认 `x-cc-admin`。
- `deploy/Dockerfile` 加 `HEALTHCHECK`；`.dockerignore` / `.gitignore` 挡住运行状态与密钥；`.env.example` 是无真值的清单。

### 13.5 P10 断言变更（都写明了理由）

| 脚本 | 旧 | 新 | 原因 |
|---|---|---|---|
| `verify-stage3` C | 点「更新穿搭图」→ 弹确认 → 再点确认 | 点一下就进 generating，且 `#confirm-modal` 不存在 | P10-2 |
| `verify-stage3` D/F/H/I | 各处等确认框 | 开关即授权 / 自定义场景不等确认 / 402 与失败都不弹框 | P10-2 |
| `check:p9` F | 风格词旁 `.inspo` 外链 | 页头 `.inspo` 必须为 0；四张卡片各一条 https 外链 + 命中区 + 新标签页 | P10-1 |
| `check:p9` D2 | 用 `confirmBudget` 验预算弹窗 | 改成「无 `requiresConfirm` + 未配置如实 503」 | P10-2 |
| `check:public` turn | 不带 `planId` | 带 `planId`（与真实界面一致） | 断言口径修正，非放宽 |

### 13.6 P10 DOM 契约变更

- **删除**：`#confirm-modal #modal-title #modal-note #modal-cost #modal-foot #modal-ok #modal-cancel`、`.hero-chips .inspo`、`.stage-caption .cap-stale`、`.stage-overlay.dim`。
- **新增**：`.insp` / `.insp-hit` / `.insp-cap` / `a.insp-go[data-…]`；`#stage-overlay.strip` + `.stale-strip` + `.strip-btn`（`[data-regen]`、`[data-cancel-wait]`）。

### 13.7 P10 验收数字

`npm test` 141/141 ｜ `verify` 46/46 ｜ `verify:stage3` **144/144** ｜ `check:p9` **70/70** ｜ `check:p10` **32/32** ｜ `check:public` 27/27 ｜ `check:p6:owned` 44 ｜ `check:p6:ui` 84 ｜ `check:f4` 50 ｜ `check:f3` 72 ｜ `check:f2` 15 ｜ `check:context` 24 ｜ `check:prefs` 10 ｜ `check:home` 18。辅助：`shot:p10`（`scripts/shot-p10.mjs`，零费用交付截图）。

聊天区两条硬约定：`#messages` 不要加 `scroll-behavior: smooth`（会停在半路裁掉最后一条）；贴底靠 `state.chatStick` + `ResizeObserver` 盯最后一条高度。
