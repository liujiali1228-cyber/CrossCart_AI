# CrossCart AI｜商品数据源与可视化交互方案

> 配套文档：`CrossCart-AI-技术设计文档.md`
> 本文回答三个问题：① 免费商品 API 接哪些、② 可视化怎么做、③ 点选单品置换怎么实现。

---

## 一、免费商品 API：先想清楚要哪几个字段

拼搭方案对字段的要求比"能搜到商品"苛刻得多。先列需求，再看谁能给：

| 字段 | 用途 | 缺了会怎样 |
|---|---|---|
| 主图（白底/可抠） | 拼搭图、热区 | 无法出图 |
| 价格 + 币种 | 到手价、预算 | 无法算账 |
| 尺码列表 | 偏好匹配、可买性 | 推荐了买不到的码 |
| 颜色 / 属性 | 换件策略（换成浅色） | 换件只能靠标题关键词瞎猜 |
| 重量 | 运费估算 | 运费只能按类目均值估 |
| 运费 / ETA | 到货判断 | 只能标"待确认"（可接受） |
| 购买链接 + 联盟追踪 | 转化 | 没法变现 |
| 库存 | 避免推已售罄 | 用户点进去发现没了 |

**关键结论**：没有任何一个免费 API 能同时给全"去背图 + 重量 + 运费 + ETA"。所以架构上必须是 **API 取骨架字段 + 本地规则/构建期处理补齐**，这也正是设计文档里 `ctx.catalog` 双 provider + `shipping-rules.yaml` 的原因。

### 1.1 候选源逐个评估（2026-11 现状）

| 平台 | 免费额度 | 门槛 | 有图 | 尺码/属性 | 运费/ETA | 发中国 | 结论 |
|---|---|---|---|---|---|---|---|
| **AliExpress 联盟 API**（`aliexpress.affiliate.product.query`） | 新号 500 次/天，审核后提升 | 开放平台建应用，类目选联盟/代发，审核数小时～数天 | ✅ | ✅ SKU 属性 | △ `delivery_days` 粗粒度 | ✅ 原生支持 `ship_to_country=CN` | **首选主源** |
| **Rakuten Ichiba Item API**（`IchibaItem/Search/20220601`） | 1 req/s，单次 ≤30（可调至 100），最多 100 页 | 注册即给 `applicationId`，几乎零门槛 | ✅ | △ 靠 `itemName`+genres | ❌ | ❌（日本境内为主） | **东京场景首选** |
| **eBay Browse API** | 5,000 次/天，无期限 | 开发者计划免费注册，OAuth `client_credentials`（token 2h） | ✅ | ✅ item specifics（含 size/color） | △ shippingOptions 部分有 | △ 看卖家 | **补位源**（欧美款、尺码全） |
| **Amazon PA-API 5.0** | 免费 | 需联盟账号 + 近 30 天 ≥10 笔合格销售；24h 数据留存；**许可禁止存储图片** | ✅ | ✅ | △ | △ | **v1 不用**（不能存图＝不能拼搭） |
| Shopify 品牌自建站 `/products.json` | 免费 | 无（公开端点） | ✅ | ✅ variants 带尺码 | ❌ | △ | **仅内部原型**，上线需商家授权或 Storefront API |
| Canopy API | 100 次/月 | 邮箱注册 | ✅ | ✅ | ❌ | △ | 字段验证用，不能当主源 |
| SerpApi / Scrapingdog | 250 次/月 / 100 credits | 注册 | ✅ | △ | ❌ | — | 同上 |
| DummyJSON / Fake Store API | 无限 | 无 | ✅ | 假数据 | 假数据 | — | **评测 fixture 专用** |

**Amazon 这一条要特别标出来**：PA-API 的 Associates 许可明确不允许存储商品图片、内容最多缓存 24 小时。而 CrossCart 的核心是「把商品图抠出来拼成搭配图并长期保存」——这在许可上直接冲突。所以哪怕它免费、数据最好，v1 也必须排除。这是很多同类产品踩过的坑。

### 1.2 推荐组合（三层，互不阻塞）

```
P0 种子库（自建，300–500 SKU）
   └─ 作用：图片授权可控、字段齐全、评测可复现。开发全程都靠它，不被 API 审核卡住
P1 Rakuten（东京目的地） + AliExpress（发中国的通用款）
   └─ 作用：真实价格与真实商品，让 demo 可信
P2 eBay（欧美尺码补位）
   └─ 作用：型号/尺码覆盖，退货率低
✗  Amazon PA-API：许可与"存图拼搭"冲突，v1 排除
```

### 1.3 AliExpress 调用要点

```ts
// packages/dsh-catalog/src/providers/aliexpress.ts
import crypto from 'node:crypto'

const API = 'https://api-sg.aliexpress.com/sync'
const METHOD = 'aliexpress.affiliate.product.query'

function sign(params: Record<string, string>, secret: string) {
  const base = Object.keys(params).sort()
    .map(k => `${k}${params[k]}`).join('')
  return crypto.createHmac('sha256', secret)
    .update(base).digest('hex').toUpperCase()
}

export async function search(q: {
  keywords: string; shipTo: string; currency: string;
  minPrice?: number; maxPrice?: number; page?: number
}) {
  const params: Record<string, string> = {
    method: METHOD,
    app_key: process.env.AE_APP_KEY!,
    timestamp: String(Date.now()),
    format: 'json',
    v: '2.0',
    sign_method: 'sha256',
    keywords: q.keywords,
    ship_to_country: q.shipTo,          // 关键：直接决定"能不能发到中国"
    target_currency: q.currency,        // 直接给 USD/CNY，省一次汇率换算
    page_no: String(q.page ?? 1),
    page_size: '50',
    // 只取要用的字段，返回体小一个量级
    fields: 'product_id,product_title,product_main_image_url,product_small_image_urls,' +
            'sale_price,target_sale_price,target_original_price,currency_code,' +
            'first_level_category_name,ship_to_days,promotion_link,product_detail_url,' +
            'sku_properties,evaluate_rate,lastest_volume',
  }
  if (q.minPrice) params.min_sale_price = String(q.minPrice)
  if (q.maxPrice) params.max_sale_price = String(q.maxPrice)
  params.sign = sign(params, process.env.AE_APP_SECRET!)

  const res = await fetch(`${API}?${new URLSearchParams(params)}`)
  return res.json()
}
```

三个坑：**签名必须服务端算**（Secret 不能进前端/客户端插件）；`fields` 不传会返回一大堆用不上的字段；`ship_to_country` 会同时影响价格（含税口径）和可售性，必须与用户收货地一致。

### 1.4 Rakuten 调用要点

```
GET https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601
  ?applicationId=xxx
  &keyword=トレンチコート
  &genreId=100371          # レディースファッション
  &minPrice=3000&maxPrice=20000
  &sort=-reviewAverage
  &hits=30&page=1&format=json
```

返回的 `itemPrice` 是 JPY，`mediumImageUrls` 给图，`shopName` 给店铺。日文检索要注意：中文关键词要先过一层「中→日」类目/词映射（`外套 → アウター/コート`），否则召回很差。这一步放在 skill 里做（模型翻译关键词很擅长），不要写死在代码里。

### 1.5 字段补齐策略

| 缺什么 | 怎么补 | 状态标记 |
|---|---|---|
| 去背图 | 构建期批处理（rembg / BiRefNet），存 `cutout.png` | — |
| 重量 | 类目均值表（外套 700g / 鞋 900g / 上衣 250g） | `estimated` |
| 运费 | `(仓国, 目的国, 物流档, 重量段) → fee` 规则表 | `estimated` |
| ETA | 同上规则表给区间 `[low, high]` | `estimated` |
| 关税 | 不估 | `unavailable` |
| 库存 | 取 API 值；超过 6h 未刷新则标"库存可能已变" | — |

**这张表就是"诚实标注"的落地位置**：凡是补出来的，一律不是 `confirmed`。

### 1.6 合规红线

- 联盟 API 的 ToS 通常限制：图片/价格不得长期缓存、必须带追踪参数、展示需标注来源、不得改价。落地做法：价格存 `fetchedAt`，超过 24h 打「价格可能已变」；购买链接一律走 `promotion_link`；卡片脚注「商品数据来自 AliExpress / 楽天」。
- 抠图属于"修改商品图"，用于内部搭配展示通常可行，但**对外分享图**建议保留原图入口，并避免裁掉品牌 logo。
- 抓 Shopify `/products.json` 只用于开发期自测，不进商业版本。

---

## 二、可视化：四种方案，只有一种是"可点选"的

| 方案 | 实现 | 真实感 | 可点选 | 单件成本 | 结论 |
|---|---|---|---|---|---|
| **A. HTML/CSS 绝对定位拼贴** | 每个单品一个 `<img>`，按模板定位；热区就是元素本身 | 高（真实商品图） | ✅ 天然 | ~0 | **v1 主方案** |
| B. SVG 模板 + `<image>` + clipPath | 适合异形遮罩、统一描边、矢量导出 | 高 | ✅ | ~0 | 需要形状裁切时用 |
| C. 服务端合成 PNG（sharp / canvas） | 一次合成一张图 | 高 | ❌（要另置热区） | 50–200ms | **只用于导出/分享/OG** |
| D. AI 场景效果图（ImageGen） | 文生图/图生图 | 「氛围」高，商品失真 | ❌ | $0.01–0.05/张 | v1.5 的氛围预览，必须标"示意图" |
| E. 虚拟试穿 VTON | 人像 + 衣服 → 上身图 | 最高 | ❌ | GPU 或 API | v2 能力，不进主流程 |

### 2.1 为什么 A 比 C 好（这是最容易做错的决定）

如果先合成一张 PNG 再显示，就要在 PNG 上**另铺一层透明热区**。问题是：图缩放、换件、布局变化时，热区坐标必须跟着重算，很容易点偏；而且换件要重新合成整张图，300ms 起。

A 方案里**每个单品就是一个 DOM 元素**：

- 点击命中由浏览器负责，不可能点偏；
- 换件只改一个 `<img>` 的 `src`，其余元素不动；
- hover 抬升、选中描边、状态点、加载骨架，全是 CSS；
- 无障碍免费拿到（`<button aria-label="外套，米色风衣，89 美元，待买">`）；
- 需要一张图分享时，才调 C 做一次合成（同一套坐标数据）。

### 2.2 拼贴版式（flat-lay 模板）

```
画布 1080 × 1350（4:5，适配信息流）
┌──────────────────────────────────────┐
│  [外套]                    ← 行1 占满 │  行高 34%
│                                      │
├───────────────────┬──────────────────┤
│  [上衣]           │   [裤装]         │  行高 30%（左右各 50%）
├───────────────────┼──────────────────┤
│  [鞋]             │   [包]           │  行高 26%
└───────────────────┴──────────────────┘
底部 10%：清单摘要 + 到货结论
```

规则：
- 背景纯色浅灰 `#F5F4F0`（不用渐变/贴图）。
- 每格内边距 ≥ 8% 画布宽；单品长边对齐到格的 82%，**底边对齐基线**（flat-lay 的视觉重量在底部）。
- 去背图统一输出 800px 长边、PNG-32；合成时按格等比缩放，不拉伸。
- 已有单品：`filter: saturate(.85)` + 左上「已有」角标；待买：主色 1px 描边 + 右上状态点。
- 空槽：1px 虚线框 + 「＋ 添加」。
- 千万别给每个单品加投影/发光——会让拼贴看起来像电商 Banner 而不是搭配稿。

### 2.3 AI 场景图放哪（v1.5）

定位：**只做「氛围预览」，不参与决策**。
- 入口放在方案卡右上「看看穿上的样子」；
- 生成时把方案里的商品主图作为参考图（image-to-image），提示词固定场景（东京街头、秋日、自然光）；
- 图上必须压角标「AI 示意图，商品以实物为准」；
- 失败/耗时不影响主流程（异步，生成完再替换占位）。

### 2.4 虚拟试穿放哪（v2）

| 模型 | 许可 | 商用 | 显存 | 说明 |
|---|---|---|---|---|
| **FASHN VTON v1.5** | Apache-2.0 | ✅ | ~2GB 权重，消费级卡可跑 | 2026-01 开源，目前唯一"可商用 + 轻量"的成熟选择 |
| CatVTON | CC BY-NC-SA 4.0 | ❌ | <8GB | 轻、快，只能研究/自用 |
| IDM-VTON | CC BY-NC-SA 4.0 | ❌ | ≥16GB（ComfyUI 节点） | 纹理细节好，非商用 |
| Leffa | MIT（权重训练数据待查） | ⚠️ | — | 支持姿态迁移，商用需法务确认 |
| OmniTry | Apache-2.0 LoRA + 非商用底座 | ❌ | ≥28GB | 可试戴配饰，底座受限 |

结论：**v2 若要做试穿，只有 FASHN VTON v1.5 这条路能直接商用**；其余只能内部看效果。且试穿图不能替代拼搭图——用户需要看清"这套由哪几件组成"，试穿图给不了这个信息。

---

## 三、交互：点选一件衣服并置换，怎么做得准

### 3.1 数据契约（先定死，UI 才不摇摆）

```jsonc
{
  "slot": "outerwear",
  "status": "to_buy",
  "hotspot": [0.12, 0.06, 0.62, 0.58],   // 归一化 x, y, w, h（相对画布）
  "item": { "productId": "sku_9f1", "price": { "amount": 89, "status": "confirmed" } },
  "locked": false
}
```

**归一化坐标**是重点：存 `0–1` 而不是像素，画布从 1080 缩到 360、从 4:5 变 1:1 都不需要重算。像素只用于导出合成。

### 3.2 渲染结构

```html
<div class="outfit-canvas" style="aspect-ratio:4/5; position:relative">
  <!-- 背景 -->
  <div class="canvas-bg"></div>

  <!-- 每个单品：一个按钮，不是一个热区矩形 -->
  <button class="slot" data-slot="outerwear"
          style="left:12%; top:6%; width:62%; height:58%"
          aria-label="外套：米色风衣，89 美元，待买">
    <img src="/crosscart/asset/sku_9f1/cutout.png" alt="米色风衣" />
    <span class="badge badge--buy">待买</span>
    <span class="dot dot--confirmed" title="价格已确认"></span>
  </button>

  <button class="slot" data-slot="bottom" ...>
    <img src=".../cutout.png" alt="深色直筒牛仔裤" />
    <span class="badge badge--owned">已有</span>
  </button>

  <!-- 空槽 -->
  <button class="slot slot--empty" data-slot="bag" style="left:50%; top:64%; ...">＋ 添加</button>
</div>
```

要点：
- `<button>` 而不是 `<div>`：键盘可 Tab、可 Enter、读屏器可读。
- `left/top/width/height` 直接取 hotspot 的百分比，零 JS 计算。
- 状态点三色（绿=confirmed / 橙=estimated / 灰=unavailable），**颜色不进 CSS 类名靠数据驱动**。

### 3.3 点击之后：不要"点一下就换"

裸点击只能猜意图，猜错就是"我点外套想看看细节，结果它给我换了"。正确做法是**点 → 选中态 → 浮层四策略**：

```
点击外套
  ├─ 视觉：该格抬升 2px + 主色 2px 描边 + 其余格降到 60% 不透明度
  └─ 浮层（贴近该格，屏幕边缘自动翻转）
       ┌─────────────────────────────┐
       │ 米色风衣 · $89 · 待买        │
       │ 到货 11/25（估算）           │
       ├─────────────────────────────┤
       │ ⟳ 换成浅色                   │
       │ ≋ 换相似款                   │
       │ ↓ 找更便宜的                 │
       │ ⚡ 找更快到的                 │
       ├─────────────────────────────┤
       │ 看原图 / 锁定这件 / 移除     │
       └─────────────────────────────┘
```

四个策略映射到确定的检索参数（不是让模型自由发挥）：

| 策略 | 检索参数 |
|---|---|
| 换成浅色 | 同 slot 类目 + `color in [ivory, cream, beige, light-gray]` + 价格 ≤ 当前 ×1.25 |
| 换相似款 | 同 slot 类目 + 同 `style` 标签 + 价格 ±20% |
| 找更便宜的 | 同 slot 类目 + 价格 ≤ 当前 ×0.8 + 排序 price asc |
| 找更快到的 | 同 slot 类目 + `etaDate <= 当前截止日` + 排序 eta asc |

> **实现时的两条修正（原型已验证）**
> 1. **面板放画布下方，不要浮动层**：浮层会盖住刚点的那件，用户没法看"换了还搭不搭"。选中态用描边+其余格降透明承担，操作面板出现在画布下方。
> 2. **策略候选默认排除「运费待确认」的商品**：把它们推给用户等于把"到货判断不了"的问题丢回去。这类商品只在「手动挑一件」列表里出现，并明确标注"到货待确认"，由用户知情选择。

### 3.4 完整事件流（含"只改一件"的保证）

```
click(slot)
  → setSelected(slot)
  → popover.show({ productId, currentPrice, eta, locked })
  → user picks strategy
  → POST /crosscart/plan/:planId/swap
       { revision, slot, strategy, productId? }
  → 服务端：applyOps(单 slot) → recompute → guard 断言 changedSlots==1
  → 返回 PlanDiff { changed: [outerwear], cost, arrival, message }
  → 事件 crosscart/plan-updated{ changedSlots }
  → 只重绘 changedSlots 内的 <img> + 底部清单/预算/到货三行
  → toast: "已换成象牙白风衣，+$12；预算还剩 $35；到货 11/22 → 11/25（估算）"
  → 5 秒内可「撤销」
```

**为什么反馈必须是这句话**：换一件会同时影响三件事（价格、预算、到货），用户需要一句话看到全部连带变化，而不是自己去找。这也是评测断言 A 的 UI 侧证据。

### 3.5 换件动画（做对细节，观感差一个档次）

```css
.slot img { transition: opacity .18s ease, transform .18s ease; }
.slot.is-swapping img { opacity: 0; transform: scale(.97); }
.slot.just-changed { animation: pop .32s ease; }
@keyframes pop { 0%{transform:scale(.97)} 60%{transform:scale(1.02)} 100%{transform:scale(1)} }
```

布局变化用 **FLIP**（先记录旧位置 → 改 DOM → 计算差值 → transform 过渡），避免整卡重排时的跳动。不要用 `display:none` 切换单品（内存与布局都会抖）。

### 3.6 另外三条入口（都指向同一个 swap 服务）

| 入口 | 场景 | 实现 |
|---|---|---|
| 点图上单品 | "这件换掉" | 上述流程 |
| 点清单行 | 清单里更清楚价格 | 清单行 hover ↔ 图上对应格高亮（双向联动） |
| 从候选网格直选 | "我就要这件" | 底部横向 strip：3 个候选缩略图 + 价差 + 到货，点即 `productId` 直传 |
| 上传已有单品 | "我已经有这件" | 上传 → 抠图 → 占 slot，`status=owned`，不进新增支出 |

### 3.7 移动端与无障碍

- 移动端：单击 = 选中 + 底部 sheet（不用 popover，避免遮挡）；长按 = 看原图。
- 候选 strip 支持横向滑动，一屏 3 个，卡片高度与图上热区高度无关（独立滚动区）。
- 键盘：`Tab` 遍历单品 → `Enter` 开浮层 → `1–4` 选策略 → `Esc` 关闭。
- 读屏：每格 `aria-label` 必须带「品类 + 颜色 + 价格 + 状态」，状态用文字不只靠颜色。
- 动效遵循 `prefers-reduced-motion`，关闭缩放与 FLIP。

### 3.8 状态机（避免"替换中"被重复点击）

```
idle ──click──▶ selected ──pick strategy──▶ swapping
                    │                          │
                    └──Esc / 点空白──▶ idle     ├─ success ──▶ changed ──(5s)──▶ idle
                                               └─ fail ──▶ selected + toast(原因)
swapping 期间：该格 loading 骨架 + 其余格 disabled + 浮层按钮全部禁用
失败原因要具体：`无满足条件的替代` / `会超出预算，已为你保留原方案` / `版本已更新，已刷新`
```

---

## 四、落地顺序（每一步都能单独验收）

| 步骤 | 做什么 | 验收 |
|---|---|---|
| 1 | 静态 HTML 拼贴原型，DummyJSON 假数据 | 图上每件能 hover/点击、点中率 100% |
| 2 | 接种子库 + 真实热区 + 状态点 | 1080/720/360 三种宽度下热区不偏 |
| 3 | 接 swap 服务 + diff 反馈 + 撤销 | 换件后其他单品字段零变化；300ms 内有反馈 |
| 4 | 接 Rakuten / AliExpress | 真实商品能进方案；缺失字段正确标"待确认" |
| 5 | 导出合成图（sharp） | 分享图与页面视觉一致，含角标与免责声明 |

---

## 五、三条容易被忽略的工程约束

1. **API 限流决定缓存设计**。AliExpress 新号 500/天、Rakuten 1 req/s——一次需求要 5 个 slot × 3 个候选 ≈ 15 次调用，加上重试很容易打满。必须做「按 `(关键词, 收货地, 币种)` 键的 15 分钟本地缓存 + 请求合并」，否则做两个方案就报错。
2. **图片要走本地资产服务**。不要在前端直接引用联盟 CDN 图：会过期、会限流、跨域抠图受限。落盘 `cutout.png` + host route 提供，才能做拼搭和导出。
3. **币种只在一处转换**。API 给什么币就存什么币，另存 `fxRate + fxAt`；展示时统一换算到用户预算币种。绝对不要在多个插件里各自换汇，否则预算判定会飘。

---

## 六、没有显卡怎么办

先给结论：**这个项目 90% 的环节不需要显卡，剩下 10% 按张付费调用就行，v1 总成本低于 1 美元。**

### 6.1 逐环节判断：到底哪里"传统上"要 GPU

| 环节 | 要 GPU 吗 | 为什么 | v1 方案 |
|---|---|---|---|
| dsh 本体 / agent 运行 | ❌ | 它是 Node.js 进程，模型推理在 DeepSeek 云端 | 普通笔记本 CPU 就够；要常开就 1C2G 云主机 |
| 拼搭图渲染 | ❌ | 就是 DOM + CSS，或 sharp 做合成 | 浏览器 / Node |
| 商品图去背 | ⚠️ 模型本身想用 GPU，但**可以离线** | 商品是有限的，抠一次存下来 | 本地 CPU 批处理 或 按张调 API |
| 用户上传照片去背 | ⚠️ | 每次都要算 | 按张调 API（~$0.02） |
| AI 场景效果图 | ✅ 需要 | 扩散模型 | 调 API，$0.003–0.05/张 |
| 虚拟试穿 | ✅ 需要 | 扩散模型 | 调 API，$0.3–1.1/次 |
| 评测回放 | ❌ | 纯文本断言 | headless |
| 抠图以外的图像处理（缩放/裁切/圆角/水印） | ❌ | sharp 是 libvips，CPU 极快 | Node |

关键认知：**"要不要显卡"取决于"算多少次"，不取决于"模型多大"。** 拼搭场景里 80% 的图都是同一个 300–500 SKU 的池子，抠一次永久复用——这是一次性成本，不是运行时成本。

### 6.2 去背：三条零 GPU 路线，按成本从低到高

**路线 1（首选，零成本零延迟）：白底图不抠，用混合模式**

电商主图 90% 是白底。把白底图直接叠在**浅色**背景上，用 `multiply` 混合，白底会被吃掉，视觉上等价于去背：

```css
.canvas-bg { background: #F5F4F0; }
.slot img {
  mix-blend-mode: multiply;   /* 白底消失，商品保留 */
  isolation: isolate;
}
```

```ts
// 用 sharp 先判断"是不是真白底"，再决定走哪条路
const { data } = await sharp(src).resize(8, 8, { fit: 'fill' })
  .removeAlpha().raw().toBuffer({ resolveWithObject: true })
const corners = [0, 7, 56, 63].map(i => data[i * 3] + data[i * 3 + 1] + data[i * 3 + 2])
const isWhiteBg = corners.every(v => v / 3 > 245)
```

限制（必须知道，否则会翻车）：
- 只对**浅色背景**有效，深色背景会留下白块。
- **近白色商品会"消失"**（白 T 叠在白底上）→ 需要先算商品主体平均亮度，`> 235` 就别用这招。
- 图上不能有阴影/渐变底（会变成脏灰色块）。

**路线 2（次选，一次性成本，永久复用）：本地 CPU 批处理**

```bash
# rembg：MIT，默认跑 CPU（只需 onnxruntime，不需要 CUDA）
pip install "rembg[cli]"
rembg p data/seed/assets/raw/ data/seed/assets/cutout/     # 目录批处理
```

- 模型选择：`-m birefnet-general`（BiRefNet，MIT，边缘最好，CPU 约 2–5 s/张）；追求快用 `-m u2net`（~170MB，亚秒级）；只想拿衣服不要人用 `-m u2net_cloth_seg`。
- 500 张 × 2 s ≈ 17 分钟，跑一次就够，之后仓库里存 `cutout.png`。
- 不想装 Python：用 Docker `danielgatis/rembg`，或 Node 里 `onnxruntime-node` 直接加载 BiRefNet ONNX（自己写 30 行前后处理）。
- 这是**构建期工具**，不进运行时依赖，所以不用担心部署环境有没有模型。

**路线 3（用户上传的单品照片）：按张调 API**

用户自己拍的照片没有白底，必须真去背。按张付费，不用自己扛模型：

| 服务 | 价格 | 免费额度 | 备注 |
|---|---|---|---|
| **Replicate**（`851-labs/background-remover`） | **≈$0.0005/张**（约 1 美元 2000 张） | 注册送少量额度 | T4 上约 3 s，最便宜，适合直接接 |
| **Photoroom API** | $0.02/张（1000 张起售） | 10 次生产 + 1000 次沙箱（带水印） | 电商图质量稳，文档好 |
| Pixian.AI | $0.0009–0.018/张（按像素） | 有 | 预付额度不过期 |
| rembg.com（在线服务） | 约 €0.019/张起 | 60 credits/月 | 即开即用 |
| remove.bg | $0.09–0.23/张 | 50 次/月（**预览分辨率**） | ⚠️ **2026-12-01 起官网关闭，API 迁移到 Leonardo.Ai**，别做长期依赖 |
| fal.ai（Bria RMBG-2.0） | $0.018/张 | 有 | 训练数据有授权说明，企业采购友好 |

选型建议：**Replicate 做默认，Photoroom 做兜底**（质量不满意时切）。两者都是"一个 HTTP 请求"，包在 `ctx.render` 里做成 provider，换供应商只改一行配置——正好用上设计文档里的 seam 设计。

```ts
// packages/dsh-render/src/providers/replicate-cutout.ts
export async function cutout(imageUrl: string) {
  const r = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.REPLICATE_TOKEN}`,
               'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: '<851-labs/background-remover 的版本号>',
      input: { image: imageUrl },
    }),
  })
  const p = await r.json()
  return pollUntilDone(p.urls.get)      // 返回带 alpha 的 PNG URL
}
```

### 6.3 AI 场景效果图：按张调，不要自建

| 服务 | 价格量级 | 适合 |
|---|---|---|
| Replicate（FLUX schnell / SDXL） | $0.003–0.01/张 | 批量、便宜 |
| fal.ai | $0.01–0.05/张 | 速度快、模型多 |
| 即梦 / 通义万相 / 豆包 图像 API | 几毛人民币/张 | 国内网络、中文提示词友好 |
| WorkBuddy 的 ImageGen 工具 | 按次 | 做原型和素材最快 |

一个方案 2 套 × 1 张场景图 = 2 张，即使每张 $0.05，单次需求也就 $0.1。而且这是 v1.5 的锦上添花，v1 完全可以不做。

### 6.4 虚拟试穿：只有"按次调 API"这一条现实路径

本地跑 VTON 要 8–28GB 显存，且开源模型多数是 **CC BY-NC**（不可商用）。没有显卡就别碰本地部署：

| 服务 | 价格 | 许可 |
|---|---|---|
| FASHN Try-On Max（托管） | 约 $0.3–1.1/次 | 可商用 |
| Replicate 上的 FASHN VTON v1.5 | 按秒计费，约 $0.01–0.05/次 | Apache-2.0，可商用 |
| 阿里云 / 腾讯云 AI 试衣 | 按次，有免费试用额度 | 商用需看条款 |
| HuggingFace Space（ZeroGPU） | 免费但排队 | 多数模型非商用，只能看效果 |

结论：**v2 想做就用 Replicate 上的 FASHN v1.5，$0.01–0.05/次**，比自己买卡便宜几个数量级（一张 4090 的钱够跑 20 万次）。

### 6.5 成本测算（v1 全量）

| 项 | 数量 | 方案 | 成本 |
|---|---|---|---|
| 商品图去背 | 500 SKU | 本地 rembg CPU 批处理 | **$0**（17 分钟） |
| 商品图去背（备选） | 500 SKU | Replicate | **$0.26** |
| 用户上传去背 | 假设 200 次/月 | Replicate | **$0.10** |
| 拼搭合成 | 全部 | sharp / CSS | **$0** |
| LLM | 每需求 3–6 次往返 | DeepSeek API | 按 token，单次数分钱 |
| AI 场景图（v1.5） | 2 张/需求 | Replicate | **≈$0.02/需求** |
| 试穿（v2） | 1 次/需求 | Replicate FASHN | **≈$0.03/需求** |
| **v1 一次性总成本** | | | **< $1** |

真正的成本在 LLM 调用和商品数据获取，不在图像。

### 6.6 如果连本机 CPU 批处理都不想跑

三条退路，任选：

1. **构建期跑在 CI 里**：GitHub Actions 的 `ubuntu-latest` 是 2 核 CPU，跑 500 张 rembg 约 20–30 分钟，产物提交到仓库或用 artifact。免费额度足够。
2. **一次性租按量 CPU 实例**：云厂商 2C4G 按小时计费，跑完就释放，几毛钱。
3. **全部走 API**：本地不装任何依赖，`seed-cli` 逐个调 Replicate，$0.26 结束。

### 6.7 三个容易踩的坑

1. **不要在运行时抠图**。用户点"换一件"时如果现抠，500ms–3s 的延迟会毁掉交互手感。所有商品图必须在构建期就处理好，运行时只做 `src` 替换。
2. **`mix-blend-mode` 会"吃"掉浅色商品**。上线前一定要跑一遍「商品主体亮度 > 235 则强制走带 alpha 的 PNG」的规则，否则白衬衫会在拼搭图里凭空消失。
3. **remove.bg 别做长期依赖**。它 2026-12-01 关站、API 迁到 Leonardo.Ai，密钥和调用方式都会变。用 Replicate 或 Photoroom 更稳。
