/**
 * dsh 插件 ↔ Bridge 的传输层。
 *
 * 方案状态不放在插件里：插件和 Studio 页面都只是 bridge 的客户端，
 * 因此「页面点换件 → AI 下一句话就读到新方案」是结构上成立的，而不是靠提示词同步。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
export const BRIDGE_URL = process.env.CROSSCART_BRIDGE_URL ?? 'http://127.0.0.1:8790'
/**
 * 演示环境的访问口令：bridge 所有 /api/* 都要求带它。
 * 只存在于服务端进程环境里，不会下发到浏览器；插件与 bridge 同机，直连带过去即可。
 */
const ACCESS_TOKEN = String(process.env.CROSSCART_ACCESS_TOKEN ?? '').trim()
const authHeaders = (): Record<string, string> => (ACCESS_TOKEN ? { 'x-cc-token': ACCESS_TOKEN } : {})

/**
 * 给用户/模型看的链接。
 * 本地开发用 BRIDGE_URL；部署到公网时用 CROSSCART_PUBLIC_URL —— 否则模型会在回复里
 * 贴一个 http://127.0.0.1:8796 的地址，用户点了打不开（这不是"小问题"，是死链）。
 */
export function studioUrl(planId?: string) {
  const base = (process.env.CROSSCART_PUBLIC_URL || BRIDGE_URL).replace(/\/+$/, '')
  return planId ? `${base}/?plan=${encodeURIComponent(planId)}` : `${base}/`
}

async function tryHealth(timeoutMs = 800) {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/health`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

let ensurePromise: Promise<boolean> | null = null

/** 首次调用时若 bridge 没起，就地拉起（detached），让 dsh 单独启动也能用。 */
export function ensureBridge(): Promise<boolean> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      if (await tryHealth()) return true
      const entry = join(ROOT, 'packages', 'bridge', 'src', 'server.mjs')
      if (!existsSync(entry)) return false
      try {
        const child = spawn(process.execPath, [entry], {
          cwd: ROOT,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        child.unref()
      } catch {
        return false
      }
      for (let i = 0; i < 25; i += 1) {
        await new Promise((r) => setTimeout(r, 200))
        if (await tryHealth()) return true
      }
      return false
    })()
  }
  return ensurePromise
}

export class BridgeError extends Error {
  code?: string
  hint?: string
  /** 服务端结构化详情（如 PREF_CONFLICT 的冲突商品与规则） */
  details?: unknown
  constructor(message: string, code?: string, hint?: string, details?: unknown) {
    super(message)
    this.code = code
    this.hint = hint
    this.details = details
  }
}

export async function bridge<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  if (!(await ensureBridge())) {
    throw new BridgeError(
      `状态服务没在 ${BRIDGE_URL} 上运行，且自动启动失败。`,
      'BRIDGE_DOWN',
      `在 crosscart 目录运行 npm run studio 后重试。`,
    )
  }
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(init.headers ?? {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new BridgeError(body.error ?? `HTTP ${res.status}`, body.code, body.hint ?? undefined, body.details ?? undefined)
  }
  return body as T
}

export function loadSeedFile() {
  const p = join(ROOT, 'data', 'seed', 'catalog.json')
  return JSON.parse(readFileSync(p, 'utf8'))
}
