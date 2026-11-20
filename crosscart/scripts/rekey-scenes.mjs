/**
 * 场景缓存重键：图片是按「当时的 pln_020 单品组合」登记的内容寻址缓存，
 * 之后验收里换过件又换回来，如果恢复的是同款不同 variant 的 productId，
 * 缓存键就会变——图还是那身衣服，但键对不上。
 *
 * 这里按当前状态复算键：图与提示词都不改（那是真实生成记录），只把条目挂到
 * 当前组合的键上，并同步文件名（文件名 = 键 = 内容寻址）。
 * 用法：node scripts/rekey-scenes.mjs  （跑完需重启 studio 让服务端重读索引）
 */
import { resolveScene, sceneCacheKey } from '../packages/core/dist/index.js'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const DATA = join(ROOT, 'data')
const planId = process.argv[2] ?? 'pln_020'

const state = JSON.parse(readFileSync(join(DATA, 'state.json'), 'utf8'))
const plan = state.plans.find((p) => p.planId === planId)
if (!plan) throw new Error(`${planId} 不存在`)

const idxPath = join(DATA, 'scenes', 'index.json')
const idx = JSON.parse(readFileSync(idxPath, 'utf8'))

const next = {}
let moved = 0
for (const [oldKey, entry] of Object.entries(idx.entries)) {
  // sceneId = place.season.time.weather（自定义场景前缀是 custom.<hash>，不参与重键）
  const parts = String(entry.sceneId).split('.')
  if (parts[0] === 'custom' || parts.length !== 4) {
    next[oldKey] = entry
    continue
  }
  const [place, season, time, weather] = parts
  const spec = resolveScene({ place, season, time, weather })
  const key = sceneCacheKey(plan, spec)
  const from = join(DATA, 'scenes', `${oldKey}.png`)
  const to = join(DATA, 'scenes', `${key}.png`)
  if (key !== oldKey) {
    if (!existsSync(from)) throw new Error(`缺图：${from}`)
    if (existsSync(to)) throw new Error(`目标键已存在，拒绝覆盖：${to}`)
    renameSync(from, to)
    console.log(`rekey ${oldKey} -> ${key}  (${spec.label})`)
    moved += 1
  }
  next[key] = { ...entry, key, file: `${key}.png` }
}

writeFileSync(idxPath, JSON.stringify({ ...idx, entries: next }, null, 2))
console.log(`entries: ${Object.keys(idx.entries).length} -> ${Object.keys(next).length}，重键 ${moved} 张`)
console.log(`当前组合键：${Object.keys(next).join(', ')}`)
