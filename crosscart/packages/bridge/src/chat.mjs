/**
 * CrossCart ⇄ dsh 的对话通道。
 *
 * 为什么不自己调大模型：
 *  - 用户要求「不要重新实现已有的大模型调用机制、工具调用机制」；
 *  - dsh 0.2.2 自带官方 SDK 运行时（`dsh --profile sdk`），用 stdio JSON-RPC
 *    暴露 initialize / session/query / session.event，正是为「把 agent 嵌进别的应用」准备的；
 *  - 所以 bridge 只做三件事：拉起这个进程、把用户消息丢进去、把事件投影成聊天气泡。
 *    模型调用、工具循环、会话持久化全都留在 dsh 里。
 *
 * 关键约定：
 *  - stdout 是协议专用通道，任何日志都要走 stderr；
 *  - 工具仍然通过 @crosscart/dsh-plugin 读写 bridge 的同一份方案状态，
 *    所以「页面改方案 → AI 下一句话就知道」不依赖提示词同步；
 *  - 「停止」= 终止该进程（会话已落盘），下次发言前 session/resume 恢复，
 *    dsh 会修复被打断的最后一轮 —— 不假装停止其实还在跑。
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import readline from 'node:readline'
import { materializePatch } from './dsh-patch.mjs'

const PROVIDER = process.env.CROSSCART_LLM_PROVIDER ?? 'deepseek-official'
const MODEL = process.env.CROSSCART_LLM_MODEL ?? 'deepseek-chat'
const MAX_MESSAGES = 60

function resolveDsh() {
  const override = process.env.CROSSCART_DSH_BIN
  if (override && existsSync(override)) return { cmd: process.execPath, args: [override], shell: false }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true, timeout: 8000 }).trim()
    const bin = join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(bin)) return { cmd: process.execPath, args: [bin], shell: false }
  } catch {
    /* 找不到就退回 PATH 里的 dsh */
  }
  return { cmd: 'dsh', args: [], shell: true }
}

const TOOL_LABEL = {
  crosscart_list_catalog: '浏览商品目录',
  crosscart_create_plan: '创建方案',
  crosscart_swap_item: '替换单品',
  crosscart_plan_state: '读取方案状态',
  crosscart_save_pref: '保存偏好',
  crosscart_propose_pref: '提议长期偏好',
  crosscart_reject_pref: '拒绝偏好提议',
  crosscart_list_prefs: '读取偏好',
}

function clip(text, n = 160) {
  const s = String(text ?? '')
  return s.length > n ? `${s.slice(0, n)}…` : s
}

export class ChatRuntime {
  constructor({ cwd, patch, transcriptPath, onUpdate, log = () => {} }) {
    this.cwd = cwd
    this.patch = patch
    this.transcriptPath = transcriptPath
    this.onUpdate = onUpdate
    this.log = log

    this.child = null
    this.rl = null
    this.ready = false
    this.starting = null
    /** 当前 dsh 进程是否已经持有这个会话（持有中就不要 resume，否则会被判为 occupied） */
    this.sessionBound = false
    this.seq = 0
    this.pending = new Map()
    this.current = null
    this.error = null
    this.lastEventAt = null

    this.state = { sessionId: null, messages: [], running: false, phase: 'idle', startedAt: null, error: null }
    this.load()
  }

  /* ------------------------------------------------------------ 持久化 */

  load() {
    if (!existsSync(this.transcriptPath)) return
    try {
      const saved = JSON.parse(readFileSync(this.transcriptPath, 'utf8'))
      this.state.sessionId = saved.sessionId ?? null
      this.state.messages = Array.isArray(saved.messages) ? saved.messages.slice(-MAX_MESSAGES) : []
      this.state.restored = this.state.messages.length > 0
    } catch {
      /* 坏文件就当没有 */
    }
  }

  persist() {
    try {
      mkdirSync(dirname(this.transcriptPath), { recursive: true })
      writeFileSync(
        this.transcriptPath,
        JSON.stringify({ sessionId: this.state.sessionId, messages: this.state.messages.slice(-MAX_MESSAGES) }, null, 2),
        'utf8',
      )
    } catch (e) {
      this.log('对话记录写入失败：', e?.message ?? e)
    }
  }

  snapshot() {
    return {
      sessionId: this.state.sessionId,
      messages: this.state.messages,
      running: this.state.running,
      phase: this.state.phase,
      ready: this.ready,
      error: this.error,
      model: `${PROVIDER}/${MODEL}`,
    }
  }

  touch() {
    this.state.error = this.error
    this.persist()
    this.onUpdate?.(this.snapshot())
  }

  /* ------------------------------------------------------------ 进程管理 */

  async ensure() {
    if (this.ready && this.child) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      const dsh = resolveDsh()
      // 公网演示用 cordis.demo.yml（关掉本机执行/文件类工具）；本地开发仍用 cordis.yml
      // patch 里写的插件绝对路径要在启动时按当前仓库位置重写，否则换机器/进容器就挂不上插件
      const patch = materializePatch(process.env.CROSSCART_DSH_PATCH || this.patch)
      const args = [...dsh.args, '--profile', 'sdk', '--patch', patch]
      const child = spawn(dsh.cmd, args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: dsh.shell,
        env: { ...process.env, CROSSCART_BRIDGE_URL: process.env.CROSSCART_BRIDGE_URL ?? 'http://127.0.0.1:8790' },
      })
      this.child = child
      child.on('exit', (code) => {
        if (this.child === child) {
          this.child = null
          this.ready = false
          if (this.state.running) {
            this.finishTurn({ interrupted: true, reason: '连接已结束' })
          }
        }
        this.log(`dsh 进程退出（code=${code}）`)
      })
      child.stderr.on('data', (d) => {
        const text = String(d).trim()
        if (text) this.log('[dsh]', clip(text, 240))
      })
      this.rl = readline.createInterface({ input: child.stdout })
      this.rl.on('line', (line) => this.onLine(line))

      await this.call('initialize', {
        cwd: this.cwd,
        provider: PROVIDER,
        model: MODEL,
        approvalRequests: false,
      })
      this.ready = true
      this.sessionBound = false
      this.error = null
      this.log(`dsh sdk 就绪：${PROVIDER}/${MODEL}`)
    })()
      .catch((e) => {
        this.error = `AI 运行时启动失败：${e.message}`
        this.ready = false
        this.child?.kill()
        this.child = null
        throw new Error(this.error)
      })
      .finally(() => {
        this.starting = null
        this.touch()
      })
    return this.starting
  }

  async killChild() {
    const child = this.child
    if (!child) return
    this.child = null
    this.ready = false
    this.sessionBound = false
    try {
      this.rl?.close()
    } catch {
      /* ignore */
    }
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        child.kill('SIGKILL')
      }
    } catch {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
    for (const [, p] of this.pending) p.reject(new Error('运行时已停止'))
    this.pending.clear()
  }

  /* ------------------------------------------------------------ 协议 */

  call(method, params, timeoutMs = 180000) {
    if (!this.child) return Promise.reject(new Error('AI 运行时没有启动'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  onLine(line) {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      // 插件日志不该出现在 stdout；出现了就记录，但绝不当作协议帧
      this.log('[dsh:stdout]', clip(line, 200))
      return
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else waiter.resolve(msg.result)
      return
    }
    if (msg.method) {
      if (msg.id !== undefined) {
        // 服务端反向请求（审批/提问）：本应用不开，直接回空结果让其走原生兜底
        this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
      }
      this.onNotify(msg.method, msg.params)
    }
  }

  onNotify(method, params) {
    if (method === 'session.status' && params?.sessionId === this.state.sessionId) {
      this.lastEventAt = Date.now()
      if (params.status === 'running') {
        this.state.running = true
        this.state.phase = 'thinking'
        this.state.startedAt = Date.now()
        this.emitPhase()
      } else if (params.status === 'idle' && this.state.running) {
        this.finishTurn({})
      }
      return
    }
    if (method !== 'session.event' || params?.sessionId !== this.state.sessionId) return
    const event = params.event
    this.lastEventAt = Date.now()
    if (!this.current) {
      this.current = { text: '', tools: [], at: new Date().toISOString() }
      this.state.running = true
    }
    switch (event.type) {
      case 'assistant/message': {
        const blocks = event.data?.message?.content ?? []
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
        if (text.trim()) {
          this.current.text += text
          this.state.phase = 'writing'
          this.flushTurn()
        }
        break
      }
      case 'tool/call': {
        this.state.phase = 'tools'
        this.current.tools.push({
          callId: event.data.callId,
          name: event.data.name,
          label: TOOL_LABEL[event.data.name] ?? event.data.name,
          args: clip(event.data.arguments, 140),
          ok: null,
        })
        this.flushTurn()
        break
      }
      case 'tool/result': {
        const callId = event.data?.message?.toolCallId
        const failed = !!event.data?.message?.isError || !!event.data?.error
        const tool = callId
          ? this.current.tools.find((t) => t.callId === callId)
          : [...this.current.tools].reverse().find((t) => t.ok === null)
        if (tool) {
          tool.ok = !failed
          if (failed) tool.error = clip(event.data?.error?.reason ?? '工具返回失败', 120)
        }
        this.flushTurn()
        break
      }
      case 'turn/end': {
        const reason = event.data?.reason
        const kind = typeof reason === 'string' ? reason : reason?.kind
        if (kind && kind !== 'completed') this.current.error = `本轮未完成：${kind}`
        this.pendingEnd = true
        break
      }
      default:
        break
    }
  }

  flushTurn() {
    if (!this.current) return
    const message = this.current
    const last = this.state.messages[this.state.messages.length - 1]
    if (last && last.role === 'assistant' && last._live) {
      last.text = message.text
      last.tools = message.tools
      last.error = message.error
    } else {
      this.state.messages.push({
        id: `a_${Date.now()}`,
        role: 'assistant',
        text: message.text,
        tools: message.tools,
        error: message.error,
        at: message.at,
        _live: true,
      })
    }
    this.touch()
  }

  finishTurn({ interrupted = false, reason = '' } = {}) {
    const message = this.current
    this.current = null
    this.pendingEnd = false
    this.state.running = false
    this.state.phase = 'idle'
    this.state.startedAt = null
    if (message && (message.text || message.tools.length)) {
      const idx = this.state.messages.findIndex((m) => m.role === 'assistant' && m._live)
      const final = {
        id: `a_${Date.now()}`,
        role: 'assistant',
        text: message.text,
        tools: message.tools,
        error: message.error ?? (interrupted ? reason || '已停止生成' : null),
        interrupted: !!interrupted,
        at: message.at,
      }
      if (idx >= 0) this.state.messages[idx] = final
      else this.state.messages.push(final)
    } else {
      // 没有内容就丢掉占位气泡
      this.state.messages = this.state.messages.filter((m) => !(m.role === 'assistant' && m._live))
    }
    for (const m of this.state.messages) delete m._live
    this.touch()
  }

  emitPhase() {
    this.touch()
  }

  /* ------------------------------------------------------------ 对外操作 */

  async send(text, contextText) {
    if (this.state.running) throw Object.assign(new Error('AI 正在回复，先停止或等它说完'), { code: 'BUSY' })
    const clean = String(text ?? '').trim()
    if (!clean) throw Object.assign(new Error('消息不能为空'), { code: 'EMPTY' })

    await this.ensure()

    if (!this.state.sessionId) {
      this.state.sessionId = `cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    } else if (!this.sessionBound && this.state.messages.length > 0) {
      // 只有「新拉起的进程 + 有历史」才恢复会话；同一进程里继续对话不需要 resume
      try {
        await this.call('session/resume', { sessionId: this.state.sessionId })
        this.sessionBound = true
      } catch (e) {
        this.log('会话恢复失败，改为新会话：', e.message)
        this.state.sessionId = `cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        this.state.messages.push({
          id: `s_${Date.now()}`,
          role: 'system',
          text: '上一轮对话无法恢复，已开始新会话；当前方案状态不受影响。',
          at: new Date().toISOString(),
        })
      }
    }

    this.state.messages.push({
      id: `u_${Date.now()}`,
      role: 'user',
      text: clean,
      at: new Date().toISOString(),
    })
    this.state.running = true
    this.state.phase = 'queued'
    this.state.startedAt = Date.now()
    this.current = { text: '', tools: [], at: new Date().toISOString() }
    this.touch()

    const contentBlocks = [{ type: 'text', text: clean }]
    if (contextText) contentBlocks.push({ type: 'text', text: contextText })

    try {
      await this.call('session/query', { sessionId: this.state.sessionId, contentBlocks })
      this.sessionBound = true
    } catch (e) {
      this.state.running = false
      this.state.phase = 'idle'
      this.current = null
      this.error = e.message
      this.state.messages.push({
        id: `e_${Date.now()}`,
        role: 'system',
        text: `发送失败：${e.message}`,
        at: new Date().toISOString(),
      })
      this.touch()
      throw e
    }
    return this.snapshot()
  }

  async stop() {
    if (!this.state.running) return this.snapshot()
    if (this.current && (this.current.text || this.current.tools.length)) {
      this.finishTurn({ interrupted: true, reason: '已停止生成' })
    } else {
      this.current = null
      this.state.running = false
      this.state.phase = 'idle'
      this.touch()
    }
    await this.killChild()
    this.state.messages.push({
      id: `s_${Date.now()}`,
      role: 'system',
      text: '已停止本轮生成。已改动过的方案保持不变，可以继续对话。',
      at: new Date().toISOString(),
    })
    this.touch()
    return this.snapshot()
  }

  async reset() {
    await this.killChild()
    this.state.sessionId = `cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    this.state.messages = []
    this.state.running = false
    this.state.phase = 'idle'
    this.error = null
    this.persist()
    this.touch()
    return this.snapshot()
  }
}
