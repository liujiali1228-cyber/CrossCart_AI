/**
 * 为测试版开一个公网入口。
 *
 * 两套通道，按可用性自动选：
 *   1. cloudflared 快速隧道（优先）：带宽正常、无账号，地址形如 https://xxx.trycloudflare.com；
 *      每次启动都换地址，进程退出即失效。二进制放 .tmp/bin/cloudflared.exe 或装在 PATH 里。
 *   2. SSH 反向隧道（localhost.run）：不装任何东西也能用，但免费层会限速（约 8KB/s）
 *      且域名会轮换——图片多的页面会明显变慢，只适合兜底。
 *
 * 为什么独立成脚本：隧道是外部网络资源，进程退出地址就失效；
 * 独立出来，重启时能拿到新地址，也不会让人误以为"域名永久有效"。
 *
 * 用法：
 *   node scripts/tunnel.mjs              # 转发本机 8796
 *   node scripts/tunnel.mjs 9000         # 转发别的端口
 *   TUNNEL=ssh node scripts/tunnel.mjs   # 强制走 SSH 通道
 *
 * 输出里的 https://… 就是公网地址；同时写入 .tmp/tunnel-url.txt。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.argv[2] ?? process.env.DEMO_PORT ?? '8796'
const OUT_DIR = join(process.cwd(), '.tmp')
mkdirSync(OUT_DIR, { recursive: true })

const LOCAL_BIN = join(OUT_DIR, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
const hasCloudflared = () => {
  if (process.env.TUNNEL === 'ssh') return null
  if (existsSync(LOCAL_BIN)) return LOCAL_BIN
  const probe = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' })
  return probe.status === 0 ? 'cloudflared' : null
}

function report(url, note) {
  writeFileSync(join(OUT_DIR, 'tunnel-url.txt'), `${url}\n`, 'utf8')
  console.log(`\n[tunnel] 公网地址：${url}`)
  console.log('[tunnel] 公开实例（npm run serve:public，8797）不需要口令；演示实例（npm run demo，8796）首次访问要口令，见启动日志')
  console.log(`[tunnel] ${note}`)
  console.log('[tunnel] 建议带着这个地址重启服务，模型/分享入口给出的才是公网地址：')
  console.log(`[tunnel]   CROSSCART_PUBLIC_URL=${url} npm run serve:public\n`)
}

function runCloudflared(bin) {
  console.log(`[tunnel] forward 127.0.0.1:${PORT} → Cloudflare 快速隧道（Ctrl+C 结束）`)
  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let found = false
  const scan = (d) => {
    const text = String(d)
    process.stdout.write(text)
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
    if (m && !found) {
      found = true
      report(m[0], 'Cloudflare 快速隧道地址每次启动都会变；进程退出即失效。')
    }
  }
  child.stdout.on('data', scan)
  child.stderr.on('data', scan)
  child.on('error', (e) => {
    console.error(`[tunnel] cloudflared 启动失败：${e.message}，改用 SSH 通道`)
    runSsh()
  })
  child.on('exit', (code) => {
    console.log(`\n[tunnel] 已断开（exit ${code}）。重新运行 node scripts/tunnel.mjs 获取新地址。`)
    process.exit(code ?? 0)
  })
}

function runSsh() {
  console.log(`[tunnel] forward 127.0.0.1:${PORT} → localhost.run（Ctrl+C 结束）`)
  const child = spawn(
    'ssh',
    [
      '-o', 'StrictHostKeyChecking=no',
      '-o', `UserKnownHostsFile=${join(OUT_DIR, 'known_hosts')}`,
      '-o', 'ServerAliveInterval=30',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'BatchMode=yes',
      '-R', `80:127.0.0.1:${PORT}`,
      'nokey@localhost.run',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let found = false
  child.stdout.on('data', (d) => {
    const text = String(d)
    process.stdout.write(text)
    const m = text.match(/https:\/\/[a-z0-9-]+\.(?:app\.)?lhr\.life/i)
    if (m && !found) {
      found = true
      report(m[0], '免费层会限速且域名会轮换；体验大图建议用 cloudflared 通道或本机访问。')
    }
  })
  child.stderr.on('data', (d) => process.stderr.write(d))
  child.on('exit', (code) => {
    console.log(`\n[tunnel] 已断开（exit ${code}）。重新运行 node scripts/tunnel.mjs 获取新地址。`)
    process.exit(code ?? 0)
  })
}

const bin = hasCloudflared()
if (bin) runCloudflared(bin)
else runSsh()
