import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

let rt

function team({ group = false } = {}) {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: group ? { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' } } } : {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

// Services for a full apply(): resolveAgent returns a per-Session agent that
// records followup/steer/inject/cancel calls.
async function start(seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-messages-'))
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
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data, extra) => {
    if (type === 'user/message') agentOf(id).session.deriveMessages().push({ role: 'user', content: data.content, source: data.source })
    if (type === 'assistant/message') agentOf(id).session.deriveMessages().push({ ...data.message, role: 'assistant' })
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data, ...extra })
    }
  }
  // Runs every registered waterfall listener; `next` settles the chain.
  const fire = (name, payload) => Promise.all((ctx.listeners.get(name) ?? []).map(listener => listener(payload, () => Promise.resolve(undefined))))
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const exchanges = async () => (await call('exchange', { a: 'a', b: 'b' })).value ?? []
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { rt, ctx, agents, agentOf, emit, fire, tool, call, exchanges, home, stop }
}


const textOf = content => content.map(block => block.text ?? '').join('\n')

const flush = async (agents, ctx, sessionId) => {
  for (const listener of ctx.listeners.get('agent/status') ?? []) listener({ agent: agents.get(sessionId), status: 'idle' })
  // The batch waits out the quiet window after the turn ends; flush it now.
  await rt.flushWaiting(sessionId)
}

test('plain notes that pile up while a Bot works are read as one message', async (t) => {
  const { agents, ctx, emit, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  for (const text of ['one', 'two', 'three']) await rt.deliver({ fromId: 'a', toId: 'b', text, role: 'request' })
  assert.deepEqual(agents.get('b').calls, [])

  await flush(agents, ctx, 'b')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup'])
  const body = textOf(agents.get('b').calls[0][1].content)
  assert.match(body, /^\[Work from Chief[^\]]*\]\nthree\n\n2 more messages came along in this batch\.$/)
})

test('a flood of notes is read five at a time, the rest at the next turn', async (t) => {
  const { agents, ctx, emit, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  for (const text of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) await rt.deliver({ fromId: 'a', toId: 'b', text, role: 'request' })
  await flush(agents, ctx, 'b')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup'])
  assert.match(textOf(agents.get('b').calls[0][1].content), /\nfive\n\n4 more messages came along in this batch\.$/)

  await flush(agents, ctx, 'b')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup', 'followup'])
  assert.match(textOf(agents.get('b').calls[1][1].content), /\nseven\n\n1 more message came along in this batch\.$/)
})

test('notes for two Bots never ride together', async (t) => {
  const { agents, ctx, emit, stop } = await start(team())
  t.after(stop)

  emit('a', 'turn/start', { turn: 1 })
  emit('b', 'turn/start', { turn: 1 })
  await rt.deliver({ fromId: 'b', toId: 'a', text: 'for the chief', role: 'request' })
  await rt.deliver({ fromId: 'a', toId: 'b', text: 'for the writer', role: 'request' })
  await flush(agents, ctx, 'a')
  await flush(agents, ctx, 'b')
  assert.equal(textOf(agents.get('a').calls[0][1].content).includes('for the writer'), false)
  assert.equal(textOf(agents.get('b').calls[0][1].content).includes('for the chief'), false)
  assert.match(textOf(agents.get('a').calls[0][1].content), /for the chief$/)
  assert.match(textOf(agents.get('b').calls[0][1].content), /for the writer$/)
})

test('twelve waiting notes are read in three rounds of five, five and two', async (t) => {
  const { agents, ctx, emit, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  for (let index = 1; index <= 12; index += 1) await rt.deliver({ fromId: 'a', toId: 'b', text: `note ${index}`, role: 'request' })
  await flush(agents, ctx, 'b')
  assert.match(textOf(agents.get('b').calls[0][1].content), /\nnote 5\n\n4 more messages came along in this batch\.$/)
  await flush(agents, ctx, 'b')
  assert.match(textOf(agents.get('b').calls[1][1].content), /\nnote 10\n\n4 more messages came along in this batch\.$/)
  await flush(agents, ctx, 'b')
  assert.match(textOf(agents.get('b').calls[2][1].content), /\nnote 12\n\n1 more message came along in this batch\.$/)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup', 'followup', 'followup'])
  await flush(agents, ctx, 'b')
  assert.equal(agents.get('b').calls.length, 3)
})

test('a deferred note is not folded: it goes out as it came', async (t) => {
  const { agents, ctx, emit, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  await rt.deliver({ fromId: 'a', toId: 'b', text: 'plain', role: 'request' })
  await rt.deliver({ fromId: 'a', toId: 'b', text: 'answer it now', role: 'request', deferred: true })
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup'])
  assert.match(textOf(agents.get('b').calls[0][1].content), /answer it now$/)

  await flush(agents, ctx, 'b')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup', 'followup'])
  assert.match(textOf(agents.get('b').calls[1][1].content), /\nplain$/)
})

test('a queued task is never folded: it goes out on its own', async (t) => {
  const { agents, ctx, emit, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  await rt.deliver({ fromId: 'a', toId: 'b', text: 'plain one', role: 'request' })
  await rt.deliver({ fromId: 'a', toId: 'b', text: 'the task', role: 'request', queue: true })
  await rt.deliver({ fromId: 'a', toId: 'b', text: 'plain two', role: 'request' })
  await rt.deliver({ fromId: 'a', toId: 'b', text: 'plain three', role: 'request' })
  // The task cannot wait for the end of the turn: it is work to start, not a note.
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup'])
  assert.match(textOf(agents.get('b').calls[0][1].content), /the task$/)

  await flush(agents, ctx, 'b')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup', 'followup'])
  assert.match(textOf(agents.get('b').calls[1][1].content), /^\[Work from Chief[^\]]*\]\nplain three\n\n2 more messages came along in this batch\.$/)
})
