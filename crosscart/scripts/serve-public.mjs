/**
 * 公网正式实例：**不需要访问口令**，直接打开就能用。
 *
 * 和 `npm run demo`（带口令的测试版）的区别：
 *   1. 不设 CROSSCART_ACCESS_TOKEN —— 普通访客打开即用；
 *   2. 仍然开 DEMO_MODE=1：模型只能调用购物相关的工具，不能读文件/执行命令；
 *   3. 仍然有按小时的调用限额（AI 对话 / 图像生成），防止公开接口被刷；
 *   4. 数据目录独立（默认 data-public），重启/重新部署不会影响开发数据与演示数据。
 *
 * 监听端口取 PORT（托管平台注入）或 CROSSCART_PORT，绑定 0.0.0.0。
 *
 *   npm run serve:public                 # 本机 8797
 *   PORT=3000 npm run serve:public       # 托管平台
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { provisionDshCredentials } from './provision-dsh-credentials.mjs'

const ROOT = process.cwd()
const DIR = resolve(process.env.CROSSCART_DATA_DIR ?? join(ROOT, 'data-public'))
const PORT = String(process.env.PORT ?? process.env.CROSSCART_PORT ?? '8797')

mkdirSync(DIR, { recursive: true })
if (!existsSync(join(DIR, 'state.json'))) {
  // 全新实例从空方案开始：不把开发机上的私人方案带到公网上
  writeFileSync(join(DIR, 'state.json'), JSON.stringify({ plans: [], prefs: [], seq: 0 }, null, 2), 'utf8')
}
// 模型凭据：托管平台用环境变量注入；本机已有 ~/.dsh/.credentials.yaml 就不动
const cred = provisionDshCredentials({ log: (m) => console.log(`[public] ${m}`) })
if (!cred.ok) console.log(`[public] 模型凭据缺失（${cred.reason}）：对话会起不来，需要设置 DEEPSEEK_API_KEY`)

// 图像配置与额度：服务端资产，随实例独立计费。
// 平台用 SCENEGEN_* 环境变量注入时不复制本地文件 —— 本地配置里可能有开发机代理（127.0.0.1:7897），
// 复制到云端只会让出图必然失败。
const useEnvImage = !!(process.env.SCENEGEN_BASE_URL && process.env.SCENEGEN_API_KEY)
for (const f of ['scenegen.config.json', 'scenegen.usage.json']) {
  if (f === 'scenegen.config.json' && useEnvImage) continue
  const src = join(ROOT, 'data', f)
  if (existsSync(src) && !existsSync(join(DIR, f))) copyFileSync(src, join(DIR, f))
}
// 场景图缓存：只复制 index.json 会指向不存在的图片，整目录复制
const cacheDir = join(ROOT, 'data', 'scenes')
if (existsSync(cacheDir) && !existsSync(join(DIR, 'scenes'))) {
  try {
    cpSync(cacheDir, join(DIR, 'scenes'), { recursive: true })
  } catch (e) {
    console.log(`[public] 场景缓存复制失败（会按需重新生成）：${e?.message ?? e}`)
  }
}
// 真实商品缓存：有就带上，省掉首次启动的抓取等待；没有就启动时自己拉
const liveCache = join(ROOT, 'data', 'live', 'catalog.json')
if (existsSync(liveCache) && !existsSync(join(DIR, 'live', 'catalog.json'))) {
  try {
    mkdirSync(join(DIR, 'live'), { recursive: true })
    copyFileSync(liveCache, join(DIR, 'live', 'catalog.json'))
  } catch (e) {
    console.log(`[public] 商品缓存复制失败（会启动时重新抓取）：${e?.message ?? e}`)
  }
}

process.env.CROSSCART_DATA_DIR = DIR
process.env.CROSSCART_PORT = PORT
process.env.CROSSCART_HOST = process.env.CROSSCART_HOST ?? '0.0.0.0'
process.env.CROSSCART_DEMO_MODE = process.env.CROSSCART_DEMO_MODE ?? '1'
// 公开模式：管理/调试接口默认不再对外开放（要开就配 CROSSCART_ADMIN_TOKEN），健康检查只回最小信息
process.env.CROSSCART_PUBLIC = process.env.CROSSCART_PUBLIC ?? '1'
// 关键差异：不设口令。空字符串等于「谁都能进」。
delete process.env.CROSSCART_ACCESS_TOKEN
process.env.CROSSCART_BRIDGE_URL = process.env.CROSSCART_BRIDGE_URL ?? `http://127.0.0.1:${PORT}`
process.env.CROSSCART_DSH_PATCH = process.env.CROSSCART_DSH_PATCH ?? join(ROOT, 'packages', 'dsh-plugin', 'cordis.demo.yml')
process.env.CROSSCART_AGENT_CWD = process.env.CROSSCART_AGENT_CWD ?? DIR
if (process.env.CROSSCART_PUBLIC_URL) process.env.CROSSCART_PUBLIC_URL = process.env.CROSSCART_PUBLIC_URL

console.log('\n==================================================')
console.log(' CrossCart AI · 公开实例（无访问口令）')
console.log('==================================================')
console.log(` 监听       ${process.env.CROSSCART_HOST}:${PORT}`)
console.log(` 数据目录   ${DIR}`)
console.log(
  ` 限额       全实例：AI 对话 ${process.env.CROSSCART_RATE_CHAT_PER_HOUR ?? 40} 次/小时 · 场景图 ${process.env.CROSSCART_RATE_IMAGE_PER_HOUR ?? 6} 次/小时`,
)
console.log(
  `            单访客：AI 对话 ${process.env.CROSSCART_RATE_CHAT_PER_IP_PER_HOUR ?? 12} 次/小时 · 场景图 ${process.env.CROSSCART_RATE_IMAGE_PER_IP_PER_HOUR ?? 3} 次/小时`,
)
console.log(` 管理接口   ${process.env.CROSSCART_ADMIN_TOKEN ? '已开启（需 x-cc-admin）' : '关闭（公开模式下默认不开放）'}`)
if (process.env.CROSSCART_PUBLIC_URL) console.log(` 公网地址   ${process.env.CROSSCART_PUBLIC_URL}`)
console.log('==================================================\n')

await import('../packages/bridge/src/server.mjs')
