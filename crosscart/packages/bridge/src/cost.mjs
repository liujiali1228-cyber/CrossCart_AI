/**
 * 图像调用账本（bridge 侧）：纯记账与预算判定，计费数学在 core/cost.ts。
 *
 * 落盘 data/scenegen.usage.json：
 *   { budget: {limit, currency}, records: [...] }
 * records 里**绝不写 apiKey、认证头、完整请求体**；只留模型名、耗时、usage 与估价。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { budgetStatus, canAfford, estimateCost, costFromUsage, DEFAULT_MONTHLY_BUDGET } from '../../core/dist/index.js'

function readJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

export class CostLedger {
  constructor({ root, dataDir, log }) {
    this.root = root ?? null
    // 数据目录可注入：验收实例用临时目录记账，基线额度记录不受影响
    this.dataDir = dataDir ?? (root ? join(root, 'data') : null)
    if (!this.dataDir) throw new Error('CostLedger 需要 dataDir 或 root')
    this.log = log ?? (() => {})
    this.path = join(this.dataDir, 'scenegen.usage.json')
    const saved = readJson(this.path, null)
    this.records = saved?.records ?? []
    this.budget = saved?.budget ?? { limit: Number(process.env.SCENEGEN_MONTHLY_BUDGET ?? DEFAULT_MONTHLY_BUDGET), currency: 'USD' }
  }

  persist() {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify({ budget: this.budget, records: this.records.slice(-500) }, null, 2))
  }

  /** 生成前估价（不落盘）。 */
  estimate({ model, quality, kind, cached }) {
    return estimateCost({ model, quality, kind, cached })
  }

  status(nowIso = new Date().toISOString()) {
    return budgetStatus(this.records, this.budget, nowIso)
  }

  canSpend(estimate) {
    return canAfford(this.status(), estimate)
  }

  /**
   * 记一次调用。cached=true 时不记金额（缓存命中=0 费用），但仍留一行便于核查
   * 「为什么这张图没花钱」。
   */
  record(entry) {
    const cost = entry.cached
      ? { amount: 0, currency: 'USD', status: 'estimated', basis: 'cache-hit', note: '缓存命中' }
      : entry.ok === false
        ? { amount: 0, currency: 'USD', status: 'estimated', basis: 'unknown', note: '调用失败，不计费' }
        : costFromUsage(entry.usage, { model: entry.model, quality: entry.quality })
    const rec = {
      at: entry.at ?? new Date().toISOString(),
      month: String(entry.at ?? new Date().toISOString()).slice(0, 7),
      kind: entry.kind,
      operation: entry.operation ?? null,
      model: entry.model ?? null,
      quality: entry.quality ?? null,
      startedAt: entry.startedAt ?? null,
      finishedAt: entry.finishedAt ?? null,
      ms: entry.ms ?? null,
      usage: entry.usage ?? null,
      amount: cost.amount,
      currency: 'USD',
      basis: cost.basis,
      costNote: cost.note,
      cached: !!entry.cached,
      ok: entry.ok !== false,
      error: entry.ok === false ? String(entry.error ?? '').slice(0, 200) : null,
      retries: entry.retries ?? 0,
    }
    this.records.push(rec)
    this.persist()
    this.log(
      'cost',
      `${rec.kind} ${rec.model ?? '—'} ${rec.cached ? '缓存' : rec.ok ? `$${rec.amount ?? '?'}` : '失败'} ${rec.ms ?? '?'}ms`,
    )
    return rec
  }

  /** 最近 N 条，给界面看（不含任何凭证字段，本来就没存）。 */
  tail(n = 12) {
    return this.records.slice(-n).reverse()
  }
}
