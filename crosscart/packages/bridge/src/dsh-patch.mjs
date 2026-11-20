/**
 * dsh patch 文件的可移植化。
 *
 * 仓库里 `packages/dsh-plugin/cordis*.yml` 需要写插件的**绝对路径**
 * （形如 `name: 'D:/aiproject/crosscart/packages/dsh-plugin/src/index.ts'`）。
 * 换机器、换盘符、进 Docker 容器以后这个路径就不存在了，dsh 会「插件没挂上」——
 * 表现出来不是报错，而是 AI 变成一个没有工具、只会聊天的模型。
 *
 * 所以启动时按当前仓库位置重写一份 patch 到临时目录，再用它启动 dsh。
 * 两份 yml 仍然是唯一的事实来源（要改工具开关只改那里），这里只改一行路径。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** packages/bridge/src → packages/dsh-plugin/src/index.ts */
export const PLUGIN_ENTRY = resolve(HERE, '..', '..', 'dsh-plugin', 'src', 'index.ts')

const NAME_RE = /(name:\s*')([^']*dsh-plugin[\\/]src[\\/]index\.ts)(')/g

/**
 * 返回一份「插件路径指向本机仓库」的 patch 文件路径。
 * 原文件里没有可替换的插件行时，原样返回（不猜、不改别的行）。
 */
export function materializePatch(patchPath) {
  if (!patchPath || !existsSync(patchPath)) return patchPath
  const raw = readFileSync(patchPath, 'utf8')
  const entry = PLUGIN_ENTRY.replace(/\\/g, '/')
  const next = raw.replace(NAME_RE, `$1${entry}$3`)
  if (next === raw) return patchPath

  const dir = join(tmpdir(), 'crosscart-dsh-patch')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `${basename(patchPath, '.yml')}.${process.pid}.yml`)
  writeFileSync(out, next, 'utf8')
  return out
}
