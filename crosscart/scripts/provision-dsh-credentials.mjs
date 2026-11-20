/**
 * 给托管环境准备 dsh 的模型凭据。
 *
 * 为什么需要这个：dsh 的模型密钥不在仓库里，它读 `$DSH_HOME/.credentials.yaml`。
 * 本机开发时这个文件已经存在（`~/.dsh/.credentials.yaml`），所以平时感知不到；
 * 但换到容器/托管平台，全新机器上没有这个文件，AI 会直接起不来。
 *
 * 做法：只从环境变量 `DEEPSEEK_API_KEY` 写一次，**已存在就不动**（不覆盖用户/平台的凭据）。
 * 密钥永远不会进仓库、不进前端、不进 URL —— 平台用环境变量注入，本地用已有文件。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function provisionDshCredentials({ log = () => {} } = {}) {
  const key = process.env.DEEPSEEK_API_KEY
  const home = dshHome()
  const file = join(home, '.credentials.yaml')
  if (existsSync(file)) return { ok: true, reason: 'already-present', file }
  if (!key) return { ok: false, reason: 'no-env-key', file }
  mkdirSync(home, { recursive: true })
  writeFileSync(
    file,
    ['version: 1', 'refs:', `  DEEPSEEK_API_KEY: ${key}`, ''].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  )
  log(`已用环境变量写入 dsh 凭据：${file}`)
  return { ok: true, reason: 'written-from-env', file }
}

// 直接执行时（容器启动脚本里会这么调）打印结果，方便从平台日志确认
if (process.argv[1] && process.argv[1].endsWith('provision-dsh-credentials.mjs')) {
  const r = provisionDshCredentials({ log: (m) => console.log(`[dsh] ${m}`) })
  console.log(`[dsh] 凭据：${r.reason} → ${r.file}`)
}
