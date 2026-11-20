# CrossCart AI · 正式托管镜像
#
# 为什么需要 Dockerfile：
#  - 这不是静态站。bridge 是常驻 Node 进程，AI 会话由 dsh 子进程承载，
#    方案状态 / 偏好 / 场景图缓存都落在数据目录上，必须有可写磁盘 + 持久卷。
#  - dsh 是全局 CLI（@deepseek-ai/dsh），要装进镜像，bridge 才能拉起它。
#  - 密钥只从环境变量进（DEEPSEEK_API_KEY / SCENEGEN_*），不进镜像、不进仓库、不进前端。
#    仓库里的 .dockerignore 会挡掉 data/ 下的本机 scenegen.config.json，别删它。
#
# 构建：docker build -f deploy/Dockerfile -t crosscart .
# 运行：docker run -d -p 3000:3000 \
#         -e DEEPSEEK_API_KEY=sk-xxx \
#         -e SCENEGEN_BASE_URL=... -e SCENEGEN_API_KEY=... -e SCENEGEN_MODEL=... \
#         -e CROSSCART_TRUST_PROXY=1 \
#         -v crosscart-data:/app/data-public -v crosscart-dsh:/app/dsh-home crosscart
#
# 首次启动时数据卷是空的：工作区从零开始（会自动建一份示例方案），方案与偏好此后都在卷里。

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖先装，利用层缓存（构建需要 typescript，所以先装全量、构建完再裁掉 dev）
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
RUN npm ci || npm install

# dsh 运行时：bridge 用它承载模型调用与工具循环
RUN npm i -g @deepseek-ai/dsh@0.2.2-rc.1

# 应用源码（.dockerignore 已排除 data/ 运行文件、本机密钥、截图与 node_modules）
COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production \
    CROSSCART_HOST=0.0.0.0 \
    CROSSCART_PORT=3000 \
    CROSSCART_DATA_DIR=/app/data-public \
    DSH_HOME=/app/dsh-home \
    CROSSCART_DEMO_MODE=1 \
    CROSSCART_PUBLIC=1 \
    CROSSCART_RATE_CHAT_PER_HOUR=40 \
    CROSSCART_RATE_IMAGE_PER_HOUR=6 \
    CROSSCART_RATE_CHAT_PER_IP_PER_HOUR=12 \
    CROSSCART_RATE_IMAGE_PER_IP_PER_HOUR=3 \
    CROSSCART_RATE_API_PER_IP_PER_MIN=90 \
    CROSSCART_RATE_WRITE_PER_IP_PER_MIN=30

# 两个数据卷：业务数据（方案/偏好/场景图/额度/商品缓存）+ dsh 会话与 profile。
# 不提供持久卷的平台，重启会回到初始状态 —— 这一点必须如实告知使用者。
VOLUME ["/app/data-public", "/app/dsh-home"]

EXPOSE 3000

# 容器自愈：平台或 docker 用这一个探针判断「活着」，不要用「端口能连上」当健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.CROSSCART_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/serve-public.mjs"]
