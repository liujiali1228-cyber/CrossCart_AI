# 首页摄影素材清单（Phase 4.1-B 精修）

**状态：临时参考素材，仅用于本地内部原型视觉验证。**
未获得任何商业使用授权：不得公开部署、不得二次分发、不得用于对外宣传。图片原样保存，**未裁剪、未调色、未去除任何水印或署名**（源图本身无水印）；页面里的裁切只发生在 CSS 层（`object-fit/object-position`），不修改源文件。

- 取回日期：2026-11-18
- 取回方式：带浏览器 UA 与 Referer 直接请求品牌公开 CDN 地址，未绕过任何访问限制、未使用反盗链手段
- 落地尺寸：请求参数后的实际像素，已在本地逐张读取校验

## 主视觉（桌面 / 移动两套独立构图）

| 文件 | 品牌 | 原始尺寸 | 页面类型 | 页面 URL | 图片地址 | 用途 | 授权状态 |
|---|---|---|---|---|---|---|---|
| `hero-editorial.jpg` | TOTEME | 1600×1000（16:10） | FW26 秀场（Runway） | https://toteme.com/en-us/ | `https://toteme.com/cdn/shop/files/16x10TOTEME_FW26_RUNWAY_FINALE1.jpg?width=1600` | 桌面 4:3 容器，`object-position: 62% 50%` | 未授权 · 临时 |
| `hero-mobile.jpg` | TOTEME | 1080×1920（9:16） | PS27 系列（首页移动端位） | https://toteme.com/en-us/ | `https://toteme.com/cdn/shop/files/9x16_TotemePS27_760706.jpg?width=1080` | 移动 3:4 容器（≤720px），`object-position: 50% 8%` | 未授权 · 临时 |

桌面选用理由：模特头顶有充足余量，横构图里同时呈现多套完整造型、白色护墙板与拼花地板（自然光 + 建筑），比单人半身像更贴合「按场景搭整套」的产品主张，也避免脸贴画面上缘。

移动选用理由：桌面那张是多人行进，塞进 390 宽的 3:4 容器会把左右两人各切掉一半，主体不明确。改用品牌**专门为窄屏准备的 9:16 竖版单人文件**，单人即视觉中心、头顶留白充足、黑白色系与桌面秀场同调；纵向裁切只切掉底部，不出现半个人物。这是 TOTEME / LEMAIRE 自己也在用的做法（每个断点一套构图，而非同一张图缩放）。

> 上一版桌面主视觉（`16x10_TotemePS27_760706.jpg`）已弃用并从目录删除：源图头顶即贴画面边缘，任何 4:3 裁切都会把脸推到上缘，靠 `object-position` 无法修复。注意它与本版移动素材是同一组拍摄的不同裁切文件 —— 移动竖版保留的正是桌面横版里被切掉的那段头顶余量。

> 已核查：桌面秀场图 `16x10TOTEME_FW26_RUNWAY_FINALE1` 在 CDN 上没有 9:16 / 4:5 竖版（逐个探测均 404），因此移动端跨到同季 PS27 单人系列，二者在色系（黑/白/灰）、光线（自然柔光）、背景（素色墙）上保持一致。

## 编辑精选（四种场景的完整造型）

| 文件 | 场景主题 | 品牌 | 原始尺寸 | 来源页面 | 图片地址 | 授权状态 |
|---|---|---|---|---|---|---|
| `insp-1.jpg` | 城市秋日穿搭 | LEMAIRE | 1000×1249（4:5） | https://www.lemaire.fr/collections/women-coats | `https://www.lemaire.fr/cdn/shop/files/IMAGE_29_798f0b94-887b-4f11-ad9a-9166c4f52c55.jpg?width=1000` | 未授权 · 临时 |
| `insp-2.jpg` | 都市极简 | LEMAIRE | 1000×1249（4:5） | https://www.lemaire.fr/collections/women-pants | `https://www.lemaire.fr/cdn/shop/files/IMAGE_32_8154cbfa-738c-4781-9d1b-e52837913956.jpg?width=1000` | 未授权 · 临时 |
| `insp-3.jpg` | 轻松周末 | LEMAIRE | 1000×1249（4:5） | https://www.lemaire.fr/collections/skirts | `https://www.lemaire.fr/cdn/shop/files/IMAGE_43_5ed879af-0473-49dd-a960-de9c26a1d041.jpg?width=1000` | 未授权 · 临时 |
| `insp-4.jpg` | 轻旅行衣橱 | LEMAIRE | 1000×1249（4:5） | https://www.lemaire.fr/collections/ready-to-wear-new-arrivals | `https://www.lemaire.fr/cdn/shop/files/IMAGE_28_35e2325a-8410-4920-b4b6-aaae51d1f502.jpg?width=1000` | 未授权 · 临时 |

四张同属 LEMAIRE 当季造型、同为 4:5、同一自然光与城市建筑语境，人物从头到脚完整可见 —— 单独看是造型，成组看是一组编辑企划。

> 上一版四张（TOTEME PS27 的 `4x5/5x7` 系列）已弃用：那组物料本身是面部、裤脚、鞋、手袋的细节特写，无法承担「完整穿搭灵感」的职责。

## 素材与页面的关系

- 编辑精选只做**需求起点**：点击只把一句话填进输入框，不建方案、不显示价格、不声称可购买。
- 真实价格、件数、到货只在「我的方案」与场景购物页出现，且全部来自 `/api/plans`。
- 页面底部的 `#proto` 是消费者界面里唯一的素材声明，内容与本文一致；主视觉区不再出现开发说明。

## 正式发布前必须替换

1. 换成自有拍摄、已授权图库或自建生成素材（`SCENEGEN_*` 配置可直接产出 16:10 编辑感主视觉）。
2. 替换后同步更新本文件与 `studio/home.js` 的 `HERO_ASSETS`（桌面 / 移动）与 `EDITORIAL`。
3. 若要临时下线第三方素材：删除本目录 6 张图即可，首页有 `.hero-media.typo` 排版兜底，不会出现破图（编辑精选会显示空图块，需一并清空 `EDITORIAL`）。
