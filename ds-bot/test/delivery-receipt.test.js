// A Bot's routine receipt to a Main Bot is written to the team board and costs the Main
// Bot no turn. A request that needs the Main Bot to decide, a user's own message, a
// reply, and anything a room or an attachment makes a message keep the normal route.
// The board keeps the newest receipt of each Bot; the archive keeps every one.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { writeTeamBoard } from '../src/host/team-board-feed.js'
import { fakeContext } from './fake-ctx.js'

function team() {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

async function start(seed, home = mkdtempSync(join(tmpdir(), 'ds-bot-receipt-'))) {
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const messages = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined, deriveMessages: () => messages },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        send(message, target, wakeup) { calls.push(['send', message, target, wakeup]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep: [],
          nextTurn: [],
          remove(id) {
            for (const list of [this.nextStep, this.nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) return list.splice(at, 1).length === 1
            }
            return false
          },
        },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data, extra) => {
    if (type === 'user/message') agentOf(id).session.deriveMessages().push({ role: 'user', content: data.content, source: data.source })
    if (type === 'assistant/message') agentOf(id).session.deriveMessages().push({ ...data.message, role: 'assistant' })
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data, ...extra })
    }
  }
  const stop = () => ctx.dispose()
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await rt.teamTools.find(tool => tool.name === 'list_bots').execute({}, { agent: { id: 'a' } })
  return { rt, agentOf, emit, home, stop }
}

const textOf = content => content.map(block => block.text ?? '').join('\n')
const boardFile = (dir, bot = 'Writer') => join(dir, `${bot}.json`)
const boardLines = (dir, bot = 'Writer') => JSON.parse(readFileSync(boardFile(dir, bot), 'utf8'))
const receiptLine = (rt, text, exchangeId, extra = {}) => rt.deliver({ fromId: 'b', toId: 'a', role: 'request', text, exchangeId, ...extra })

async function setup(t) {
  const state = mkdtempSync(join(tmpdir(), 'ds-bot-state-'))
  const board = join(state, 'board')
  const saved = process.env.DSH_ATLAS_STATE_DIR
  process.env.DSH_ATLAS_STATE_DIR = state
  const started = await start(team())
  t.after(async () => {
    await started.stop()
    rmSync(started.home, { recursive: true, force: true, maxRetries: 5 })
    rmSync(state, { recursive: true, force: true, maxRetries: 5 })
    if (saved === undefined) delete process.env.DSH_ATLAS_STATE_DIR
    else process.env.DSH_ATLAS_STATE_DIR = saved
  })
  return { ...started, board }
}

test('a marked receipt to a busy Main Bot lands on the board and costs no turn', async (t) => {
  const { rt, agentOf, emit, board } = await setup(t)
  emit('a', 'turn/start', { turn: 1 })
  await rt.openWork('r1', { from: 'b', to: 'a' })
  const exchange = await receiptLine(rt, '[[receipt]] 完工：5 条单测全绿', 'r1', { work: 'r1' })

  assert.equal(exchange, 'r1')
  assert.equal(rt.workOf('r1'), undefined)
  assert.deepEqual(agentOf('a').calls, [])
  const lines = boardLines(board)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].bot, 'Writer')
  assert.equal(lines[0].kind, 'delivery')
  assert.equal(lines[0].what, '回执 · 完工：5 条单测全绿')
  assert.ok(Number.isFinite(Date.parse(lines[0].at)))
})

test('a marked receipt to an idle Main Bot still costs no turn', async (t) => {
  const { rt, agentOf, board } = await setup(t)
  await receiptLine(rt, '[[receipt]] 收尾了', 'r2')

  assert.deepEqual(agentOf('a').calls, [])
  assert.equal(boardLines(board).length, 1)
})

test('a request that needs a decision keeps the normal route', async (t) => {
  const { rt, agentOf, emit, board } = await setup(t)
  emit('a', 'turn/start', { turn: 1 })
  await rt.deliver({ fromId: 'b', toId: 'a', role: 'request', text: '请验收：交付在 feat/x 分支', exchangeId: 'r3' })

  assert.deepEqual(agentOf('a').calls, [])
  assert.equal(existsSync(boardFile(board)), false)
  await rt.flushWaiting('a')
  assert.equal(agentOf('a').calls.length, 1)
  assert.equal(agentOf('a').calls[0][0], 'followup')
  assert.match(textOf(agentOf('a').calls[0][1].content), /请验收/)
})

test('a user message is never read as a receipt', async (t) => {
  const { rt, agentOf, board } = await setup(t)
  await rt.deliver({ toId: 'a', role: 'user', text: '[[receipt]] 用户自己说的', exchangeId: 'r4' })

  assert.equal(agentOf('a').calls.length, 1)
  const body = textOf(agentOf('a').calls[0][1].content)
  assert.match(body, /用户自己说的/)
  assert.doesNotMatch(body, /\[\[receipt\]\]/)
  assert.equal(existsSync(boardFile(board)), false)
})

test('a reply is never read as a receipt', async (t) => {
  const { rt, agentOf, board } = await setup(t)
  await rt.deliver({ fromId: 'a', toId: 'b', role: 'reply', replyTo: 'x', text: '[[receipt]] 收到', exchangeId: 'r5' })

  const calls = agentOf('b').calls
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'followup')
  const body = textOf(calls[0][1].content)
  assert.match(body, /收到/)
  assert.doesNotMatch(body, /\[\[receipt\]\]/)
  assert.equal(existsSync(boardFile(board)), false)
})

test('the board keeps the newest receipt and the Bot\'s other lines', async (t) => {
  const { rt, board } = await setup(t)
  writeTeamBoard('Writer', [
    { bot: 'Writer', kind: 'delivery', what: '回执 · 更早一', at: '2026-11-19T10:00:00.000Z' },
    { bot: 'Writer', kind: 'delivery', what: '回执 · 更早二', at: '2026-11-19T10:01:00.000Z' },
    { bot: 'Writer', kind: 'delivery', what: '已交付：分支 feat/x', at: '2026-11-19T10:02:00.000Z' },
  ], board)

  await receiptLine(rt, '[[receipt]] 最新一条', 'r6')

  const lines = boardLines(board)
  assert.equal(lines.length, 2)
  const whats = lines.map(line => line.what)
  assert.ok(whats.includes('回执 · 最新一条'))
  assert.ok(whats.includes('已交付：分支 feat/x'))
  assert.ok(!whats.some(what => what.startsWith('回执 · 更早')))
})

test('a receipt that cannot reach the board still reaches the Main Bot', async (t) => {
  const { rt, agentOf, board } = await setup(t)
  const notADirectory = join(board, '..', 'not-a-directory')
  writeFileSync(notADirectory, '')
  process.env.DSH_ATLAS_STATE_DIR = notADirectory

  await receiptLine(rt, '[[receipt]] 板子写不进去也得送到', 'r7')

  const calls = agentOf('a').calls
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'followup')
  const body = textOf(calls[0][1].content)
  assert.match(body, /板子写不进去也得送到/)
  assert.doesNotMatch(body, /\[\[receipt\]\]/)
  assert.equal(existsSync(boardFile(board)), false)
})

test('an unmarked reply that only says there is nothing to do lands on the board', async (t) => {
  const { rt, agentOf, board } = await setup(t)
  await rt.deliver({
    fromId: 'b',
    toId: 'a',
    role: 'reply',
    replyTo: 'x',
    text: '本轮不回复：这条是静默标记，不需要动作。',
    exchangeId: 'r8',
  })

  assert.deepEqual(agentOf('a').calls, [])
  const lines = boardLines(board)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].what, '回执 · 本轮不回复：这条是静默标记，不需要动作。')
})

test('a bare acknowledgement still reaches the Main Bot', async (t) => {
  const { rt, agentOf, board } = await setup(t)
  await rt.deliver({ fromId: 'b', toId: 'a', role: 'reply', replyTo: 'x', text: '好的', exchangeId: 'r9' })

  const calls = agentOf('a').calls
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'followup')
  assert.match(textOf(calls[0][1].content), /好的/)
  assert.equal(existsSync(boardFile(board)), false)
})

test('a marked no-work reply also lands on the board, without the marker', async (t) => {
  const { rt, agentOf, board } = await setup(t)
  await rt.deliver({
    fromId: 'b',
    toId: 'a',
    role: 'reply',
    replyTo: 'x',
    text: '[[receipt]] 本轮不回复：这条是静默标记，不需要动作。',
    exchangeId: 'r10',
  })

  assert.deepEqual(agentOf('a').calls, [])
  const lines = boardLines(board)
  assert.equal(lines.length, 1)
  assert.doesNotMatch(lines[0].what, /\[\[receipt\]\]/)
  assert.match(lines[0].what, /静默标记/)
})
