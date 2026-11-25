// A burst of Bot messages that arrive while the target Bot is working is read as one
// message: one follow-up, one turn, every reply in it still named. A user message and a
// silent note are never folded; a folded batch that a restart finds in the inbox is not
// sent again.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
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

async function start(seed, home = mkdtempSync(join(tmpdir(), 'ds-bot-coalesce-'))) {
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
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data, extra) => {
    if (type === 'user/message') agentOf(id).session.deriveMessages().push({ role: 'user', content: data.content, source: data.source })
    if (type === 'assistant/message') agentOf(id).session.deriveMessages().push({ ...data.message, role: 'assistant' })
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data, ...extra })
    }
  }
  const status = value => ctx.emit('agent/status', { agent: agentOf('b'), status: value })
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const exchanges = async () => (await call('exchange', { a: 'a', b: 'b' })).value ?? []
  const stop = () => ctx.dispose()
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { rt, ctx, agents, agentOf, emit, status, tool, call, exchanges, home, stop }
}

const textOf = content => content.map(block => block.text ?? '').join('\n')
const notes = (home) => {
  try { return JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8')) } catch { return { turns: {}, queued: {} } }
}
const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const reply = (rt, at, text) => rt.deliver({ fromId: 'a', toId: 'b', role: 'reply', replyTo: `r${at}`, exchangeId: `e${at}`, text })

test('replies that arrive while the Bot works are read as one message', async (t) => {
  const { rt, agentOf, emit, status, home, stop } = await start(team())
  t.after(async () => { await stop(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  emit('b', 'turn/start', { turn: 1 })
  for (const [at, text] of ['one', 'two', 'three'].entries()) await reply(rt, at, text)
  assert.deepEqual(agentOf('b').calls, [])

  status('idle')
  await delay(2100)
  const calls = agentOf('b').calls
  assert.equal(calls.length, 1)
  const body = textOf(calls[0][1].content)
  assert.match(body, /^\[Work completed by Chief · closed;[^\n]*\n\[Reply from Chief · re r0/)
  assert.match(body, /\[Reply from Chief · re r0 · ex e0\]\none/)
  assert.match(body, /\[Reply from Chief · re r1 · ex e1\]\ntwo/)
  assert.match(body, /\[Reply from Chief · re r2 · ex e2\]\nthree/)
  assert.ok(body.indexOf('one') < body.indexOf('two') && body.indexOf('two') < body.indexOf('three'))
  // Every reply's words are printed above, so no "N more" line may claim otherwise.
  assert.equal(body.includes('came along in this batch'), false)
  assert.match(body, /three\n\nReply only/)
  assert.match(body, /Reply only to the exchanges you actually need; the rest are recorded\./)
  assert.deepEqual(calls[0][1].source.exchangeIds, ['e0', 'e1', 'e2'])
  assert.equal(calls[0][1].source.exchangeId, 'e2')

  // The batch is gone: another idle edge sends nothing.
  status('idle')
  await delay(200)
  assert.equal(agentOf('b').calls.length, 1)
})

test('a note that lands while the window counts down joins the batch', async (t) => {
  const { rt, agentOf, emit, status, home, stop } = await start(team())
  t.after(async () => { await stop(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  emit('b', 'turn/start', { turn: 1 })
  await reply(rt, 0, 'one')
  // The turn ends and the quiet window starts; the next reply arrives inside it.
  emit('b', 'turn/end', { turn: 1 })
  status('idle')
  await reply(rt, 1, 'two')
  assert.deepEqual(agentOf('b').calls, [], 'a note inside the window must not open its own turn')

  await delay(2100)
  const calls = agentOf('b').calls
  assert.equal(calls.length, 1)
  const body = textOf(calls[0][1].content)
  assert.match(body, /one/)
  assert.match(body, /two/)
  assert.deepEqual(calls[0][1].source.exchangeIds, ['e0', 'e1'])
})

test('a flood is read five at a time and the rest come next round', async (t) => {
  const { rt, agentOf, emit, status, home, stop } = await start(team())
  t.after(async () => { await stop(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  emit('b', 'turn/start', { turn: 1 })
  for (let at = 0; at < 7; at += 1) await reply(rt, at, `task ${at}`)
  status('idle')
  await rt.flushWaiting('b')
  let body = textOf(agentOf('b').calls[0][1].content)
  assert.match(body, /task 0/)
  assert.match(body, /task 3/)
  assert.match(body, /task 4\n/)
  assert.equal(body.includes('task 5'), false)
  assert.equal(body.includes('came along in this batch'), false)
  assert.match(body, /task 4\n\nReply only/)
  assert.deepEqual(agentOf('b').calls[0][1].source.exchangeIds, ['e0', 'e1', 'e2', 'e3', 'e4'])

  status('idle')
  await rt.flushWaiting('b')
  body = textOf(agentOf('b').calls[1][1].content)
  assert.match(body, /task 5/)
  assert.match(body, /task 6\n/)
  assert.equal(body.includes('came along in this batch'), false)
  assert.equal(agentOf('b').calls.length, 2)
})

test('a message from the user is never folded', async (t) => {
  const { rt, agentOf, emit, home, stop } = await start(team())
  t.after(async () => { await stop(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  emit('b', 'turn/start', { turn: 1 })
  await rt.deliver({ toId: 'b', text: 'from the user', role: 'user' })
  const calls = agentOf('b').calls
  assert.equal(calls.length, 1)
  assert.match(textOf(calls[0][1].content), /from the user$/)
})

test('a silent note does not wake the Bot and is not folded', async (t) => {
  const { rt, agentOf, emit, status, home, stop } = await start(team())
  t.after(async () => { await stop(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  emit('b', 'turn/start', { turn: 1 })
  await rt.deliver({ fromId: 'a', toId: 'b', role: 'reply', replyTo: 'r0', exchangeId: 'e0', text: 'done already', silent: true })
  // Busy target: the note is held until the turn ends, never folded and never waking it.
  assert.deepEqual(agentOf('b').calls, [])
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  status('idle')
  await settle(() => agentOf('b').calls.length === 1)
  assert.deepEqual(agentOf('b').calls.map(([kind]) => kind), ['inject'])
})

test('every reply of a folded batch is marked delivered', async (t) => {
  const { rt, agentOf, emit, status, exchanges, home, stop } = await start(team())
  t.after(async () => { await stop(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  emit('b', 'turn/start', { turn: 1 })
  for (let at = 0; at < 3; at += 1) await reply(rt, at, `answer ${at}`)
  assert.equal((await exchanges()).length, 0)

  status('idle')
  await rt.flushWaiting('b')
  assert.equal(agentOf('b').calls.length, 1)
  const delivered = await exchanges()
  assert.equal(delivered.length, 3)
  assert.deepEqual(delivered.map(entry => entry.id).sort(), ['e0', 'e1', 'e2'])
})

test('a folded batch found in the inbox after a restart is not sent again', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-coalesce-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const first = await start(team(), home)
  first.emit('b', 'turn/start', { turn: 1 })
  for (let at = 0; at < 3; at += 1) await reply(first.rt, at, `answer ${at}`)
  await settle(() => (notes(home).queued?.b ?? []).length === 3)

  first.status('idle')
  await first.rt.flushWaiting('b')
  assert.equal(first.agentOf('b').calls.length, 1)
  const merged = first.agentOf('b').calls[0][1]
  await first.stop()

  // DSH kept the merged message in the inbox; DS Bot stopped before a turn took it up.
  // The Agent is still running, as it is when only DS Bot restarted.
  const second = await start(team(), home)
  second.agentOf('b').status = 'running'
  second.agentOf('b').inbox.nextTurn.push(merged)
  await delay(3300)

  // The batch already has a turn to run in: nothing is sent again, nothing is lost.
  assert.equal(second.agentOf('b').calls.length, 0)
  assert.equal(second.agentOf('b').inbox.nextTurn.length, 1)
  assert.deepEqual(second.agentOf('b').inbox.nextTurn[0].source.exchangeIds, ['e0', 'e1', 'e2'])
  await second.stop()
})
