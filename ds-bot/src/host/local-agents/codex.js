// The Codex app-server engine: `codex app-server --listen stdio://`, one
// JSON-RPC process per route that multiplexes threads. DS Bot Sessions map to
// threads; turns stream item notifications back.
import { JsonRpcPeer, wireProcess, EventQueue } from './jsonrpc.js'
import { cleanEnv, spawnAgent } from './discover.js'

// The name the loopback MCP server is registered under in each thread's config.
const MCP_SERVER = 'dsbot'
const TERMINAL_STATES = new Set(['completed', 'failed', 'interrupted'])

export class CodexEngine {
  constructor(route, engine, { findExecutable }) {
    this.route = route
    this.engine = engine
    this.findExecutable = findExecutable
    this.child = undefined
    this.peer = undefined
    this.threads = new Map()
  }

  threadFor(dshSessionId) {
    let thread = this.threads.get(dshSessionId)
    // A thread whose process exited keeps its queue and, with it, the pump
    // still waiting there: a resumed thread needs a fresh one.
    if (thread === undefined || thread.dead) {
      const queue = new EventQueue()
      thread = { dshSessionId, threadId: undefined, dead: false, push: event => queue.push(event), next: () => queue.next() }
      this.threads.set(dshSessionId, thread)
    }
    return thread
  }

  async ensure() {
    if (this.peer !== undefined) return this.peer
    const bin = this.findExecutable(this.engine.command)
    if (bin === undefined) throw Object.assign(new Error(`${this.engine.name} is not installed`), { code: 'NO_ADAPTER' })
    const child = spawnAgent(bin, this.engine.args ?? [], {
      env: cleanEnv(this.engine.env ?? {}),
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    })
    this.child = child
    const peer = this.peer = new JsonRpcPeer(line => child.stdin.write(`${JSON.stringify(line)}\n`))
    wireProcess(child, peer)
    const gone = (error) => {
      peer.close(error)
      // A process close() let go of must not take the one that replaced it along.
      if (this.child !== child) return
      this.child = undefined
      this.peer = undefined
      for (const thread of this.threads.values()) {
        thread.dead = true
        thread.activeTurn?.settled.resolve(false)
        thread.push({ type: 'error', error })
      }
    }
    child.on('exit', () => gone(new Error(`${this.engine.name} exited`)))
    // A CLI that cannot start at all (a broken install, a missing interpreter)
    // raises 'error', never 'exit'; unheard it takes the host down.
    child.on('error', error => gone(Object.assign(new Error(`${this.engine.name} could not start: ${error.message}`), { code: 'LOCAL_AGENT_EXIT' })))
    peer.notificationHandler = (method, params) => this.onNotice(method, params)
    peer.requestHandler = (method, params) => this.onRequest(method, params)
    await peer.request('initialize', { clientInfo: { name: 'ds-bot', title: null, version: '1' } }, { timeout: 30_000 })
    peer.notify('initialized', {})
    return peer
  }

  onNotice(method, params) {
    const thread = [...this.threads.values()].find(entry => entry.threadId === params?.threadId)
    switch (method) {
      case 'item/started':
      case 'item/completed': {
        const item = params?.item ?? {}
        if (thread === undefined || thread.activeTurn?.cancelled) break
        if (params?.turnId && thread.activeTurn?.id && params.turnId !== thread.activeTurn.id) break
        if (item.type === 'agentMessage' || item.type === 'agent_message') thread.push({ type: 'text', text: item.text ?? '' })
        else if (item.type === 'reasoning') thread.push({ type: 'thought', text: (item.content ?? []).join('') || item.text || '' })
        else if (method === 'item/started' && item.type !== undefined) thread.push({ type: 'activity', text: `▸ ${activityOf(item)}` })
        break
      }
      case 'turn/completed': {
        const active = thread?.activeTurn
        const turn = params?.turn
        if (active === undefined || typeof turn?.id !== 'string' || !TERMINAL_STATES.has(turn.status)) break
        if (active.id === undefined && active.early.size < 16) active.early.set(turn.id, turn)
        else if (active.id === turn.id) this.finishTurn(thread, active, turn)
        break
      }
      case 'thread/tokenUsage/updated': {
        if (thread === undefined) break
        const usage = params?.tokenUsage ?? params?.usage
        if (usage !== undefined) thread.push({ type: 'usage', usage: { inputTokens: usage.inputTokens ?? usage.input_tokens ?? 0, outputTokens: usage.outputTokens ?? usage.output_tokens ?? 0 } })
        break
      }
      default: break
    }
  }

  // Server-initiated approval requests bridge to the approval tool.
  onRequest(method, params) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'execCommandApproval' || method === 'patchApproval') {
      const thread = [...this.threads.values()].find(entry => entry.threadId === params?.threadId)
      if (thread === undefined || thread.activeTurn?.cancelled) return Promise.resolve({ decision: 'decline' })
      const options = (params?.availableDecisions ?? params?.decisions ?? ['accept', 'decline']).map(decision => ({ optionId: decision, kind: decision === 'accept' || decision === 'acceptForSession' ? 'allow_once' : 'reject_once', name: decision }))
      return new Promise((resolve) => {
        const reply = (decision) => resolve({ decision: decision ?? 'decline' })
        thread.push({
          type: 'permission', id: `perm-${Math.random().toString(36).slice(2)}`, reply,
          action: params?.reason ?? params?.command ?? 'The agent asks to run an action',
          changes: true,
          detail: detailText(params),
          options,
        })
      })
    }
    // Codex asks before every MCP tool call under `on-request`. A refusal reads as
    // "user rejected MCP tool call", so DS Bot's own loopback server is approved
    // here: toolsFor() already narrowed what the Bot may call. Other servers and
    // real form elicitations keep the refusal; they are not DS Bot's to approve.
    if (method === 'mcpServer/elicitation/request' && params?.serverName === MCP_SERVER && params?._meta?.codex_approval_kind === 'mcp_tool_call') {
      const thread = [...this.threads.values()].find(entry => entry.threadId === params?.threadId)
      if (thread?.activeTurn?.cancelled) return Promise.resolve({ action: 'decline', content: null, _meta: null })
      return Promise.resolve({ action: 'accept', content: null, _meta: null })
    }
    return Promise.reject({ code: -32601, message: `method not found: ${method}` })
  }

  async open(dshSessionId, { cwd, mcp, resumeId, mode, instructions, model }) {
    const peer = await this.ensure()
    const thread = this.threadFor(dshSessionId)
    if (resumeId !== undefined) thread.threadId = resumeId
    // Codex 0.166 reads `ThreadStartParams` from the top level and takes the MCP
    // servers from `config`; it drops unknown keys without a word. So the fields keep
    // their documented names: `sandbox`, `approvalPolicy`, and `config.mcp_servers`.
    // The team instructions belong to a new thread: a resumed one keeps the
    // instructions it was started with, and instruct() updates them later.
    const params = {
      cwd,
      ...(model && model !== 'default' ? { model } : {}),
      ...(mode ? { sandbox: mode, approvalPolicy: mode === 'danger-full-access' ? 'never' : 'on-request' } : {}),
      ...(mcp !== undefined ? { config: { mcp_servers: { [MCP_SERVER]: { url: mcp.url, http_headers: { Authorization: `Bearer ${mcp.token}` } } } } } : {}),
    }
    if (thread.threadId !== undefined) {
      try {
        // thread/resume takes the same params, plus the thread id. The instructions it
        // was started with stay: they are not sent again here.
        await peer.request('thread/resume', { threadId: thread.threadId, ...params }, { timeout: 30_000 })
        return thread
      } catch {
        thread.threadId = undefined
      }
    }
    const reply = await peer.request('thread/start', { ...params, ...(instructions ? { developerInstructions: instructions } : {}) }, { timeout: 60_000 })
    thread.threadId = reply?.thread?.id ?? reply?.threadId
    return thread
  }

  // Follow-up instructions while a thread lives (Codex injects a developer item).
  async instruct(thread, text) {
    if (text === '') return
    await this.peer?.request('thread/inject_items', { threadId: thread.threadId, items: [{ type: 'developerMessage', text }] }, { timeout: 15_000 }).catch(() => {})
  }

  async prompt(thread, blocks, { signal, effort }) {
    const peer = await this.ensure()
    if (signal?.aborted) return true
    if (thread.activeTurn !== undefined) throw new Error('The previous Codex turn is still stopping')
    const active = { settled: Promise.withResolvers(), early: new Map(), id: undefined, cancelled: false, interruptSent: false, peer }
    thread.activeTurn = active
    void peer.request('turn/start', {
      threadId: thread.threadId,
      input: blocks.map(block => block.type === 'image' ? { type: 'image', url: block.url ?? block.data } : { type: 'text', text: block.text ?? '' }),
      // The app-server takes the level per turn and keeps it for the next ones.
      ...(effort === undefined ? {} : { effort }),
    }, { timeout: 60_000 }).then(reply => {
      if (thread.activeTurn !== active) return
      const id = reply?.turn?.id ?? reply?.id
      if (typeof id !== 'string' || id === '') throw new Error('Codex did not identify the started turn')
      active.id = id
      const terminal = active.early.get(id)
      active.early.clear()
      if (terminal !== undefined) this.finishTurn(thread, active, terminal)
      else if (active.cancelled) this.interruptTurn(thread, active)
    }).catch(error => {
      if (thread.activeTurn !== active) return
      if (!active.cancelled) thread.push({ type: 'error', error })
      active.settled.resolve(false)
    })
    try { return await active.settled.promise } finally { if (thread.activeTurn === active) delete thread.activeTurn }
  }

  finishTurn(thread, active, turn) {
    delete thread.activeTurn
    active.settled.resolve(true)
    if (active.cancelled) return
    if (turn.status === 'failed') thread.push({ type: 'error', error: new Error(turn.error?.message ?? 'the turn failed') })
    else thread.push({ type: 'done', reason: 'stop' })
  }

  interruptTurn(thread, active) {
    if (active.id === undefined || active.interruptSent) return
    active.interruptSent = true
    void active.peer.request('turn/interrupt', { threadId: thread.threadId, turnId: active.id }, { timeout: 15_000 })
      .catch(() => { active.interruptSent = false })
  }

  async steer(thread, text) {
    await this.peer?.request('turn/steer', { threadId: thread.threadId, input: [{ type: 'text', text }] }, { timeout: 15_000 }).catch(() => {})
  }

  cancel(thread) {
    const active = thread.activeTurn
    if (active === undefined) return undefined
    active.cancelled = true
    this.interruptTurn(thread, active)
    return active.settled.promise
  }

  // The adapter stopped reading this thread: a later open starts a new queue, or
  // the pump that waits on this one would swallow its first event.
  forget(dshSessionId) {
    this.threads.get(dshSessionId)?.activeTurn?.settled.resolve(false)
    this.threads.delete(dshSessionId)
  }

  async listModels() {
    const peer = await this.ensure()
    const reply = await peer.request('model/list', {}, { timeout: 30_000 })
    return (reply?.data ?? reply?.models ?? []).map((entry) => {
      const model = {
        id: String(entry.id ?? entry.model),
        name: String(entry.displayName ?? entry.name ?? entry.id ?? entry.model),
      }
      // The app-server advertises the levels each model takes. Its default is
      // left out on purpose: DSH would send it on every turn, and the level the
      // user set in their Codex config (model_reasoning_effort) would stop
      // applying. A Bot without a level of its own keeps the CLI's.
      const efforts = (entry.supportedReasoningEfforts ?? []).map(option => ({
        id: String(option.reasoningEffort ?? option),
        name: String(option.reasoningEffort ?? option),
        ...(option.description ? { description: String(option.description) } : {}),
      }))
      if (efforts.length === 0) return model
      return { ...model, reasoning: { efforts } }
    })
  }

  async close() {
    const child = this.child
    this.child = undefined
    this.peer = undefined
    for (const thread of this.threads.values()) thread.activeTurn?.settled.resolve(false)
    if (child !== undefined) {
      child.kill('SIGTERM')
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5_000).unref?.()
    }
  }
}

const activityOf = item => {
  const kind = item.type === 'commandExecution' ? (item.command ?? 'command')
    : item.type === 'fileChange' ? 'edit'
      : item.type === 'mcpToolCall' ? (item.tool ?? 'tool')
        : (item.title ?? item.type)
  return String(kind).split('\n')[0].slice(0, 120)
}
const detailText = params => [params?.command, params?.reason, JSON.stringify(params?.changes ?? params?.patch ?? '')].filter(Boolean).join('\n').slice(0, 4_000)
