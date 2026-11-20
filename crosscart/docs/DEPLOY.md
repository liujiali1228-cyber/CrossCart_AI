# 正式部署说明（P10）

> 这份文档只讲「怎么在一台全新的服务器上把它跑起来、数据放哪、出问题先看什么」。
> 它不承诺「已经可以面向公众正式上线」—— 账号与数据隔离还没做，见最后一节。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **22.18+**（推荐 22 LTS） | 仓库用 ES Module + 顶层 await；`npm test` 需要 node:test |
| dsh CLI | `@deepseek-ai/dsh@0.2.2-rc.1` | 全局安装：`npm i -g @deepseek-ai/dsh@0.2.2-rc.1`，bridge 用它承载模型会话 |
| 可写磁盘 | ≥ 1GB | `state.json`、场景图、商品缓存、额度记录、dsh 会话都在这里 |
| 出网 | 443 可用 | 模型 API、图像 API、真实商品抓取都要出网 |
| 内存 | ≥ 1GB | 场景图热点识别会同步解码整图，峰值约 300–500MB |

不需要数据库、不需要 Redis；状态就是数据目录里的 JSON + 图片文件。

---

## 2. 数据目录：什么必须留、什么可以丢

默认数据目录是仓库下的 `data/`，用 `CROSSCART_DATA_DIR` 指到持久卷即可（容器里是 `/app/data-public`）。

| 路径（相对数据目录） | 内容 | 丢了会怎样 | 必须持久化 |
|---|---|---|---|
| `state.json` | 方案、偏好、序号 | **所有方案消失**（会退回空工作区） | ✅ |
| `state.json.bak` | 上一次完整写入 | 用于 `state.json` 损坏时自动回退 | ✅（自动生成） |
| `scenes/` | 场景图原图 + 900px WebP + `index.json` | 图片要重新花钱生成 | ✅ |
| `scenegen.usage.json` | 月度额度与调用记录 | 额度清零（可能超支） | ✅ |
| `live/catalog.json` | 真实商品缓存 | 启动时重新抓（慢几秒，不影响正确性） | 建议 |
| `chat.json` | 对话记录 | 聊天历史清空，方案不受影响 | 可选 |
| `scenegen.config.json` | 本机图像配置（含 key） | 云端别放这个文件，改用环境变量 | ❌ |

> `data/seed/` 是**仓库自带**的种子目录与占位图，属于代码资产，不在持久卷里也不影响运行。

写入方式是「临时文件 → 备份上一版 → 原子 rename」，进程在写一半被杀不会留下半截 JSON；下次启动读到坏文件会自动回退到 `.bak` 并在日志里写一行 `[state] … 已回退到 .bak`。

---

## 3. 环境变量

完整清单与默认值见仓库根 `.env.example`（不含任何真实密钥）。最关键的几项：

```bash
CROSSCART_HOST=0.0.0.0            # 容器/托管必须；本机默认 127.0.0.1
CROSSCART_PORT=3000               # 平台给 PORT 时以 PORT 为准
CROSSCART_DATA_DIR=/app/data-public
DSH_HOME=/app/dsh-home            # dsh 的 profile 与凭据
DEEPSEEK_API_KEY=sk-...           # 首次启动写进 $DSH_HOME/.credentials.yaml（已存在不动）
SCENEGEN_BASE_URL=...             # OpenAI 兼容图像接口
SCENEGEN_API_KEY=...
SCENEGEN_MODEL=...
SCENEGEN_REFS=openai              # 有参考图就必须是 openai（multipart）
CROSSCART_PUBLIC=1                # 公开模式：管理接口关闭、健康检查最小化、按 IP 限流
CROSSCART_TRUST_PROXY=1           # 在 Nginx / Render / Cloudflare 后面才开
CROSSCART_ADMIN_TOKEN=...         # 可选：内部接口用（x-cc-admin）
```

云端**不要**设置 `SCENEGEN_PROXY`（那是本机 7897 代理），否则出图必失败。

---

## 4. 启动

### 4.1 本机开发

```bash
npm install && npm run build
npm run studio        # http://127.0.0.1:8790，数据在 data/
```

### 4.2 服务器上直接跑（无 Docker）

```bash
git clone <repo> /srv/crosscart && cd /srv/crosscart
npm install && npm run build
npm i -g @deepseek-ai/dsh@0.2.2-rc.1

export CROSSCART_HOST=0.0.0.0 CROSSCART_PORT=3000
export CROSSCART_DATA_DIR=/var/lib/crosscart CROSSCART_PUBLIC=1 CROSSCART_TRUST_PROXY=1
export DEEPSEEK_API_KEY=... SCENEGEN_BASE_URL=... SCENEGEN_API_KEY=... SCENEGEN_MODEL=...
node scripts/serve-public.mjs
```

首次启动会：创建数据目录 → 生成空 `state.json` → 用环境变量写 dsh 凭据 → 拉真实商品（5–15 秒）→ 建一份示例方案。

### 4.3 Docker

```bash
docker build -f deploy/Dockerfile -t crosscart .
docker run -d --name crosscart -p 3000:3000 \
  -e DEEPSEEK_API_KEY=sk-... \
  -e SCENEGEN_BASE_URL=... -e SCENEGEN_API_KEY=... -e SCENEGEN_MODEL=... \
  -e CROSSCART_TRUST_PROXY=1 \
  -v crosscart-data:/app/data-public -v crosscart-dsh:/app/dsh-home \
  crosscart
```

镜像里已经设好 `CROSSCART_PUBLIC=1`、各项限流与 `HEALTHCHECK`（探 `/api/health`）。
`.dockerignore` 会挡掉 `data/` 下的运行状态和本机密钥，**不要删这个文件**。

### 4.4 Render

`deploy/render.yaml` 已写好：Docker runtime + `healthCheckPath: /api/health` + 1GB 磁盘挂 `/app/data-public`。
在 Render 的 Environment 里填 `sync: false` 的几项（模型与图像密钥），`CROSSCART_TRUST_PROXY` 已设 1。

> 免费档没有持久磁盘，重启会回到初始状态；要「重启不丢方案」必须用带磁盘的付费档。
> `dsh-home` 想一起持久化的话，在服务上加第二块盘挂 `/app/dsh-home`（不挂也能跑，只是重启后对话历史清空）。

---

## 5. 反向代理与 HTTPS（Nginx 示例）

```nginx
server {
  listen 443 ssl http2;
  server_name crosscart.example.com;

  ssl_certificate     /etc/letsencrypt/live/crosscart.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/crosscart.example.com/privkey.pem;

  client_max_body_size 10m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    # 应用只在这个头存在、且 CROSSCART_TRUST_PROXY=1 时才会用它做按 IP 限流
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;

    # SSE（/api/events）必须关缓冲、放长超时，否则聊天与出图状态不会实时更新
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
  }
}
```

要点：

- **SSE 必须 `proxy_buffering off`**，否则页面看起来「一直停在生成中」。
- `CROSSCART_TRUST_PROXY=1` 只在确实有代理时开；直接裸奔在公网时保持 0，否则来源 IP 可被伪造，限流形同虚设。
- HTTPS 用 Let's Encrypt（certbot）即可；不要在应用层再套一层自签证书。

---

## 6. 健康检查与故障恢复

| 检查 | 命令 | 期望 |
|---|---|---|
| 存活 | `curl -s http://127.0.0.1:3000/api/health` | 公开模式回 `{"ok":true,"version":"..."}` |
| 首页 | `curl -sI http://127.0.0.1:3000/` | 200 + `text/html` |
| 数据落地 | `ls -l $CROSSCART_DATA_DIR/state.json` | 文件存在且非 0 字节 |

`/api/health` **不受限流影响**（平台探针不能被 429 掉），其余接口都受限流与预算闸门约束。

重启行为：

- 进程收到 `SIGINT/SIGTERM` 会先收掉 dsh 子进程再退出，不留孤儿占着 `$DSH_HOME`。
- 重启后从 `state.json`（或 `.bak`）恢复方案与偏好；场景图按缓存键复用，不重复计费。
- 正在生成的请求会随进程消失 → 该方案回到「上一版图 + 待更新」状态，用户点一次「更新穿搭图」即可。

---

## 7. 安全清单（本轮已做 / 仍需注意）

已做：

- 密钥只在服务端：全部从环境变量读；前端、`/api/*` 响应、日志里都没有 key（`check:p10` 有断言）。
- `.dockerignore` 阻止 `data/scenegen.config.json` 被打进镜像层。
- 公开模式默认关闭管理/调试接口（`/api/scenes/budget`、`/api/catalog/refresh`、热点修正），要开需 `CROSSCART_ADMIN_TOKEN` + 请求头 `x-cc-admin`。
- 限流两层：全实例每小时额度（对话 40 / 生图 6）+ 单 IP 每小时额度（对话 12 / 生图 3）+ 每分钟 API/写操作频率。
- 限流与预算都在服务端判定，改前端参数绕不过去；缓存命中不计费。
- 提示语里不出现金额、额度、账单（只有「这阵子的生成次数用完了」这类人话）。

仍需注意：

- 目前**没有账号体系**，所有人共用一份数据。任何拿到地址的人都能看到、修改同一批方案与偏好。
- 没有按用户计费/配额，限流只能按 IP 与全实例两道闸门。
- 日志会记录 IP（用于排查限流），如涉及合规需自行决定保留期。

---

## 8. 正式公网开放前必须补的（本轮明确不做）

1. **账号与登录**：注册 / 登录 / 找回密码 / 会话管理。
2. **数据归属与隔离**：方案、聊天、偏好按用户分区；现在的 `state.json` 是单工作区，需要迁移到「用户 → 方案」结构。
3. **权限控制**：谁能看谁的分享链接、管理接口的角色划分。
4. **按用户的调用配额**：与账号绑定的月度额度，而不是现在的 IP + 全实例。
5. **备份与保留策略**：数据目录的定期快照、图片清理、隐私删除。
6. **监控与告警**：错误率、生成失败率、额度水位（当前只有本机日志与 `check:*` 脚本）。

在这些完成之前，本服务只适合**开发与受控演示**，或小范围公开试用。

### 8.1 已经为账号体系留的位置（本轮不实现）

- **数据目录按「一份工作区 = 一个目录」设计的**：现在 `CROSSCART_DATA_DIR` 指向的那一层就是工作区，
  里面是 `state.json / scenes/ / scenegen.usage.json / live/ / chat.json`。
  将来多用户只需要把这一层变成 `data/users/<userId>/`，**内部文件不用改一行**：
  `new Workspace({ dataDir })` 已经是按目录构造的，`scenes/`、账本、缓存都是相对的。
- **归属字段不需要现在加**：`Plan` / `Pref` 里没有 `userId` 是刻意的——本轮没有任何鉴权，
  加了也只会是「假隔离」。等有登录态时，归属由「目录」表达，比给每条记录塞一个可被伪造的字段更安全。
- **额度账本按工作区独立**：`scenegen.usage.json` 跟着工作区走，接账号后天然变成「每用户月度额度」，
  不需要改 `CostLedger` 的逻辑。
- **公开实例的 `data-public/` 就是这份结构**，所以从现在到接账号，只需要换目录、不需要迁移数据格式。
