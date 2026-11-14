// Who a finished turn's text reaches. A Bot that asked and ended its turn must be woken
// by the answer; a turn that only answers a "[Reply from …]" never goes back to that Bot;
// a question the user sees is answered to the user. Issue #17: a reply looked lost, so
// these are the paths it could have taken, each held by an assertion.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const seed = () => ({
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
})

// A host over the plugin's own folder. Each Session's agent records what the plugin asks
// it to do: `followup` queues a message for the next turn and starts it when idle, `send`
// queues without waking, `steer` cuts into a running turn.
async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-reply-wake-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        send(message, when, wake) { calls.push(['send', message, when, wake]) },
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
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  await tool('list_bots', {}, 'a')
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { ctx, rt, agents, emit, tool, agentOf }
}

const textBlock = content => [{ type: 'text', text: content }]
const assistantText = text => ({ message: { content: textBlock(text) } })
const textOf = content => content.map(block => block.text ?? '').join('\n')
const callsOf = (agents, id) => agents.get(id)?.calls ?? []

const until = async (check, ms = 2000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await delay(10)
  }
  return check()
}

// Runs one turn on `id` whose trigger is `message` (a UserMessage the plugin delivered),
// writes `text`, and ends it.
const turn = (emit, id, message, text) => {
  emit(id, 'turn/start', { turn: 1 })
  emit(id, 'user/message', { content: message.content, source: message.source })
  if (text !== undefined) emit(id, 'assistant/message', assistantText(text))
  emit(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
}

test('a plain text answer wakes the Bot that asked: it gets a new turn (followup)', async (t) => {
  const { agents, emit, tool } = await start(t)
  // Writer asks Chief and ends its turn; Chief is idle, so the message goes in as a steer.
  await tool('message_bot', { to: 'Chief', message: '就发还是换封面' }, 'b')
  const [kind, asked] = callsOf(agents, 'a')[0]
  assert.equal(kind, 'steer')
  assert.equal(asked.source.role, 'request')
  assert.match(textOf(asked.content), /^\[Message from Writer\]\n就发还是换封面$/)

  turn(emit, 'a', asked, '就发')
  assert.ok(await until(() => callsOf(agents, 'b').length > 0), 'Writer was never handed the answer')

  // A followup is a queue entry that starts a turn when the Bot is idle: Writer is woken.
  const [back, reply] = callsOf(agents, 'b')[0]
  assert.equal(back, 'followup')
  assert.equal(reply.source.role, 'reply')
  assert.equal(reply.source.replyTo, asked.source.exchangeId)
  assert.equal(textOf(reply.content), '[Reply from Chief]\n就发')
})

test('a turn opened by a "[Reply from …]" never writes back to that Bot', async (t) => {
  const { rt, agents, emit } = await start(t)
  // Chief told Writer something; Writer's turn is the answer to it, so its final text
  // answers the user. Delivering it back would restart an exchange that just ended.
  await rt.deliver({ fromId: 'a', toId: 'b', text: '封面用第二版', role: 'reply', replyTo: 'x-1' })
  const [, told] = callsOf(agents, 'b')[0]
  assert.equal(told.source.role, 'reply')

  turn(emit, 'b', told, '收到，我去换')
  await delay(50)
  assert.deepEqual(callsOf(agents, 'a'), [])
})

test('an answer the user sees stays with the user, never relayed back as a reply', async (t) => {
  const { agents, emit, tool } = await start(t)
  await tool('message_bot', { to: 'Writer', message: '告诉用户：明天发', reply_to: 'user', when: 'now' }, 'a')
  const [, asked] = callsOf(agents, 'b')[0]
  assert.equal(asked.source.audience, 'user')

  turn(emit, 'b', asked, '明天发')
  await delay(50)
  assert.deepEqual(callsOf(agents, 'a'), [])
})

test('stop_bot still hands the reason to the stopped Bot', async (t) => {
  const { agents, emit, tool } = await start(t)
  // A running turn must be there for stop_bot to stop.
  emit('b', 'turn/start', { turn: 1 })
  await tool('stop_bot', { bot: 'Writer', reason: '先别发' }, 'a')
  const receipt = callsOf(agents, 'b').at(-1)
  t.diagnostic(`stop_bot receipt delivered as: ${receipt[0]}`)
  assert.equal(receipt[1].source.role, 'stopped')
  assert.equal(textOf(receipt[1].content), '[Stopped by Chief]\n先别发')
})
