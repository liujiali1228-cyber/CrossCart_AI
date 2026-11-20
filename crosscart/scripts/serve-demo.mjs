/**
 * 一键启动「公网测试版」的服务端。
 *
 * 与 `npm run studio` 的区别只有三件事：
 *   1. 数据目录换成 data-demo（干净副本，不碰真实偏好与聊天记录）
 *   2. 开访问口令（CROSSCART_ACCESS_TOKEN）+ 按小时限流
 *   3. 打印带口令的入口链接，方便直接发给体验者
 *
 * 用法：
 *   node scripts/serve-demo.mjs                 # 端口 8796，自动生成口令
 *   DEMO_PORT=9000 DEMO_TOKEN=xxx node scripts/serve-demo.mjs
 *
 * 口令请通过私聊发给体验者。它等同于这个测试环境的管理员权限
 * （单机状态、无多用户隔离，只适合个人/小范围试用）。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const DIR = resolve(process.env.CROSSCART_DATA_DIR ?? join(ROOT, 'data-demo'))
const PORT = process.env.DEMO_PORT ?? process.env.CROSSCART_PORT ?? '8796'
const TOKEN = process.env.DEMO_TOKEN ?? process.env.CROSSCART_ACCESS_TOKEN ?? randomBytes(9).toString('base64url')

mkdirSync(DIR, { recursive: true })
if (!existsSync(join(DIR, 'state.json'))) {
  writeFileSync(join(DIR, 'state.json'), JSON.stringify({ plans: [], prefs: [], seq: 0 }, null, 2), 'utf8')
}
// 图像生成配置与额度记录同样是「服务端资产」：复制到演示目录，随演示实例独立计费
for (const f of ['scenegen.config.json', 'scenegen.usage.json']) {
  const src = join(ROOT, 'data', f)
  const dst = join(DIR, f)
  if (existsSync(src) && !existsSync(dst)) copyFileSync(src, dst)
}
// 场景图缓存整目录复制：只复制 index.json 会指向不存在的图片（页面变破图）
const cacheDir = join(ROOT, 'data', 'scenes')
if (existsSync(cacheDir) && !existsSync(join(DIR, 'scenes'))) {
  try {
    cpSync(cacheDir, join(DIR, 'scenes'), { recursive: true })
  } catch (e) {
    console.log(`[demo] 场景缓存复制失败（会按需重新生成）：${e?.message ?? e}`)
  }
}

process.env.CROSSCART_DATA_DIR = DIR
process.env.CROSSCART_PORT = String(PORT)
process.env.CROSSCART_DEMO_MODE = process.env.CROSSCART_DEMO_MODE ?? '1'
process.env.CROSSCART_ACCESS_TOKEN = TOKEN
process.env.CROSSCART_BRIDGE_URL = process.env.CROSSCART_BRIDGE_URL ?? `http://127.0.0.1:${PORT}`
// 公网演示不允许模型调用本机命令/文件工具（见 cordis.demo.yml 注释）
process.env.CROSSCART_DSH_PATCH = process.env.CROSSCART_DSH_PATCH ?? join(ROOT, 'packages', 'dsh-plugin', 'cordis.demo.yml')
// agent 的工作目录放到演示数据目录：上下文里不出现项目源码路径
process.env.CROSSCART_AGENT_CWD = process.env.CROSSCART_AGENT_CWD ?? DIR
// 公网入口（有隧道后设置）：只影响模型回复里的方案链接，不影响服务监听
if (process.env.DEMO_PUBLIC_URL) process.env.CROSSCART_PUBLIC_URL = process.env.DEMO_PUBLIC_URL

console.log('\n==================================================')
console.log(' CrossCart AI · 测试版')
console.log('==================================================')
console.log(` 本机地址   http://127.0.0.1:${PORT}/?t=${TOKEN}`)
console.log(` 访问口令   ${TOKEN}`)
console.log(` 数据目录   ${DIR}`)
console.log(' 限流       AI 对话 40 次/小时 · 场景图 6 次/小时')
if (process.env.DEMO_PUBLIC_URL) console.log(` 公网地址   ${process.env.DEMO_PUBLIC_URL}/?t=${TOKEN}`)
else console.log(' 公网访问   需另开隧道（见 docs/F4.5-部署与体验说明.md）')
console.log('==================================================\n')

await import('../packages/bridge/src/server.mjs')
