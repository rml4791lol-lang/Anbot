// A delivery is noted until a turn takes it up. A send that fails keeps its note, and
// the same exchange sent again adds another one; once the exchange is taken up every
// note of it is done, or the stale one sends it once more at the next start. An
// exchange a Session took up while DS Bot was not running is not in the inbox any more
// and no event here saw it: the Session's durable log is what says so.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    c: { id: 'c', name: 'Reader', role: 'Read', sessionId: 'c', createdAt: 3 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

const started = new Map()

// One DS Bot host on `home`; a second start on the same home is a restart. `logs` is
// the durable log DSH keeps of a Session's turns, as a restart may read it.
async function start(home, logs = new Map()) {
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId },
        calls,
        status: 'idle',
        inbox: { nextStep: [], nextTurn: [], remove: () => false },
        followup(message) { calls.push(message) },
        steer(message) { calls.push(message) },
        send(message) { calls.push(message) },
        cancel() {},
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
      inspect: async sessionId => ({ events: logs.get(sessionId) ?? [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    const session = agents.get(id)?.session ?? { id }
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(session, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  const host = { rt, ctx, agentOf, emit, stop: () => ctx.dispose() }
  started.set(home, [...(started.get(home) ?? []), host])
  return host
}

const freshHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-redelivery-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  t.after(async () => {
    await Promise.all((started.get(home) ?? []).map(host => host.stop()))
    started.delete(home)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return home
}
const notes = (home) => {
  try { return JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8')) } catch { return { turns: {}, queued: {} } }
}
const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
// A turn of that Session takes the message up, as DSH replays it.
const run = (host, sessionId, turn, message) => {
  host.emit(sessionId, 'turn/start', { turn })
  host.emit(sessionId, 'user/message', { content: message.content, source: message.source })
}

test('an exchange sent again under the same id is taken up once, and every note of it is done', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  const writer = first.agentOf('b')
  const send = writer.followup
  // The first send is cut off before it reaches the inbox: its note stays.
  writer.followup = () => { throw new Error('DeepSeek Harness shut down') }
  await assert.rejects(first.rt.deliver({ fromId: 'a', toId: 'b', role: 'reply', replyTo: 'r0', exchangeId: 'e0', text: 'Do it once.' }), /shut down/)
  writer.followup = send
  await settle(() => (notes(home).queued?.b ?? []).length === 1)

  // The same exchange is sent again: the queue holds a note of each send, and the
  // Session holds the one message that got through.
  await first.rt.deliver({ fromId: 'a', toId: 'b', role: 'reply', replyTo: 'r0', exchangeId: 'e0', text: 'Do it once.' })
  await settle(() => (notes(home).queued?.b ?? []).length === 2)
  assert.equal(writer.calls.length, 1)

  // A turn takes that one message up: both notes of the exchange are done with, or the
  // stale one sends the same exchange again at the next start.
  run(first, 'b', 1, writer.calls[0])
  first.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => (notes(home).queued?.b ?? []).length === 0)
  await settle(() => notes(home).turns.b === undefined)
  await first.stop()

  const second = await start(home)
  await delay(3300)
  assert.equal(second.agentOf('b').calls.length, 0)
})

test('forgetDelivery drops every note of an exchange, in every Session it was noted under', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  // The same exchange noted under two Sessions: a send that went to another one
  // leaves the earlier note behind.
  for (const toId of ['b', 'c']) {
    await first.rt.deliver({ toId, role: 'reply', exchangeId: 'e0', text: 'Do it once.' })
  }
  await settle(() => Object.keys(notes(home).queued).length === 2)
  first.rt.forgetDelivery('e0')
  await settle(() => Object.keys(notes(home).queued).length === 0)
  await first.stop()
})

test('a turn the shutdown cut off does not swallow a note that was never sent', async (t) => {
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const writer = first.agentOf('b')
  const send = writer.followup
  // A send that failed leaves its note; the Session's log holds a turn that read an
  // earlier delivery of the same exchange and was cut as DSH stopped.
  writer.followup = () => { throw new Error('DeepSeek Harness shut down') }
  await assert.rejects(first.rt.deliver({ fromId: 'a', toId: 'b', role: 'reply', replyTo: 'r0', exchangeId: 'e0', text: 'Do it once.' }), /shut down/)
  writer.followup = send
  await settle(() => (notes(home).queued?.b ?? []).length === 1)
  await first.stop()
  logs.set('b', [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { content: [], source: { kind: 'bot', exchangeId: 'e0' } } },
  ])

  // The cut turn's own note picks it up; the pending note is sent rather than taken as
  // read, so the message it holds is not lost.
  const second = await start(home, logs)
  await delay(3300)
  assert.equal(second.agentOf('b').calls.length, 1)
  await second.stop()
})

test('an exchange a Session took up while DS Bot was down is not sent again', async (t) => {
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  await first.rt.deliver({ fromId: 'a', toId: 'b', role: 'reply', replyTo: 'r0', exchangeId: 'e0', text: 'Do it once.' })
  await settle(() => (notes(home).queued?.b ?? []).length === 1)
  const delivered = first.agentOf('b').calls[0]
  // DS Bot stops before a turn took the message up.
  await first.stop()

  // While DS Bot was down a turn of that Session took the message up and answered it.
  logs.set('b', [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { content: delivered.content, source: delivered.source } },
    { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: 'Done.' }] } } },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ])

  // The restart reads that log, so it does not send the message a second time, and the
  // note it was kept under is gone.
  const second = await start(home, logs)
  await delay(3300)
  assert.equal(second.agentOf('b').calls.length, 0)
  assert.deepEqual(notes(home).queued, {})
  await second.stop()
})
