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

  // The same exchange is sent again: the retry replaces its own note instead of
  // stacking a second one, and the Session holds the one message that got through.
  await first.rt.deliver({ fromId: 'a', toId: 'b', role: 'reply', replyTo: 'r0', exchangeId: 'e0', text: 'Do it once.' })
  await settle(() => (notes(home).queued?.b ?? []).length === 1 && notes(home).queued.b[0].args.exchangeId === 'e0')
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

test('a restart keeps the task and attempt identity while resuming once', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  await first.rt.deliver({
    toId: 'b', role: 'reply', exchangeId: 'e-task', text: 'Run the task once.',
    taskId: 'handoff:w1', attemptId: 'handoff:w1:a1',
  })
  const delivered = first.agentOf('b').calls[0]
  assert.equal(delivered.source.taskId, 'handoff:w1')
  assert.equal(delivered.source.attemptId, 'handoff:w1:a1')
  run(first, 'b', 1, delivered)
  await delay(20)
  await first.stop()

  const second = await start(home)
  await delay(3300)
  assert.equal(second.agentOf('b').calls.length, 1)
  assert.equal(second.agentOf('b').calls[0].source.taskId, 'handoff:w1')
  assert.equal(second.agentOf('b').calls[0].source.attemptId, 'handoff:w1:a1')
  assert.equal(second.agentOf('b').calls[0].source.resumed, true)
  run(second, 'b', 2, second.agentOf('b').calls[0])
  await settle(() => notes(home).turns.b?.resumed === true)
  await second.stop()

  const third = await start(home)
  await delay(3300)
  assert.equal(third.agentOf('b').calls.length, 0)
  assert.equal(third.rt.interruptedTurnState('b'), 'limit-reached')
  assert.equal(notes(home).turns.b.paused, 'limit-reached')
  assert.equal(await third.rt.continueInterrupted('b'), true)
  assert.equal(third.agentOf('b').calls.length, 1)
  assert.equal(third.agentOf('b').calls[0].source.attemptId, 'handoff:w1:a1')
})

test('a same-session turn before the startup scan keeps the interrupted TaskRef', async (t) => {
  const home = freshHome(t)
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({ turns: {
    b: { botId: 'b', since: 1, trigger: { role: 'resume', exchangeId: 'old', taskId: 'handoff:w1', attemptId: 'w1:a1' } },
  }, queued: {} }))

  const host = await start(home)
  // A turn of the same Session starts and finishes while startup recovery still waits.
  host.emit('b', 'turn/start', { turn: 2 })
  host.emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await delay(3300)

  assert.equal(host.agentOf('b').calls.length, 1)
  assert.equal(host.agentOf('b').calls[0].source.taskId, 'handoff:w1')
  assert.equal(host.agentOf('b').calls[0].source.attemptId, 'w1:a1')
  assert.equal(host.agentOf('b').calls[0].source.resumed, true)
})

test('a held worktree parks recovery without erasing a new turn that starts before the startup scan', async t => {
  const home = freshHome(t)
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({ turns: {
    b: { botId: 'b', since: 1, trigger: { role: 'resume', taskId: 'work:b', attemptId: 'work:b:a1' } },
  }, queued: {} }))
  const host = await start(home)
  let held = true
  host.rt.workspaceHold.heldFor = async session => session.id === 'b' && held
  host.emit('c', 'turn/start', { turn: 1 })
  await settle(() => notes(home).turns.c !== undefined)
  assert.equal(notes(home).turns.b?.botId, 'b')
  await delay(3300)
  assert.equal(host.rt.interruptedTurnState('b'), 'worktree-held')
  assert.equal(notes(home).turns.c.botId, 'c')
  assert.equal(host.agentOf('b').calls.length, 0)
  await assert.rejects(host.rt.continueInterrupted('b'), { code: 'bot/busy' })
  held = false
  assert.equal(await host.rt.continueInterrupted('b'), true)
  assert.equal(host.agentOf('b').calls[0].source.attemptId, 'work:b:a1')
})

test('a resumed handoff keeps its attempt and records the restart on the work', async (t) => {
  const home = freshHome(t)
  const now = Date.now()
  const team = seed()
  team.works = {
    w1: {
      from: 'a', to: 'b', open: [], results: [], at: now,
      attempt: { id: 'w1:a1', n: 1, status: 'working', startedAt: now, updatedAt: now },
      verification: { state: 'pending', status: 'pending', evidenceIds: [], checks: [], missing: [] },
      evidence: [],
    },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))

  const first = await start(home)
  await first.rt.deliver({
    fromId: 'a', toId: 'b', role: 'request', exchangeId: 'w1', text: 'Review the repair.',
    taskId: 'handoff:w1', attemptId: 'w1:a1',
  })
  const delivered = first.agentOf('b').calls[0]
  run(first, 'b', 1, delivered)
  await delay(20)
  await first.stop()

  const second = await start(home)
  await delay(3300)
  assert.equal(second.agentOf('b').calls.length, 1)
  assert.deepEqual(
    [second.agentOf('b').calls[0].source.taskId, second.agentOf('b').calls[0].source.attemptId, second.agentOf('b').calls[0].source.resumed],
    ['handoff:w1', 'w1:a1', true],
  )
  const work = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).works.w1
  assert.equal(work.attempt.id, 'w1:a1')
  run(second, 'b', 1, second.agentOf('b').calls[0])
  await delay(20)
  const resumedWork = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).works.w1
  assert.equal(resumedWork.recovery.length, 1)
  assert.equal(resumedWork.recovery[0].attemptId, 'w1:a1')
  assert.equal(resumedWork.recovery[0].kind, 'resumed')
  await second.stop()
})

test('a restart reconciles pending evidence into the same task attempt', async (t) => {
  const home = freshHome(t)
  const now = Date.now()
  const team = seed()
  team.rooms.r1 = {
    id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true,
    sessions: { a: 'ga', b: 'gb' }, log: [], seq: 0, seen: {},
    goal: {
      id: 'g1', revision: 1, status: 'active', title: 'Ship', brief: '', objective: 'Ship it', acceptance: 'tests pass',
      constraints: [], current: 0, nudges: 0, by: 'a', createdAt: now, updatedAt: now, events: [], counter: { stage: 1, task: 1 },
      stages: [{
        id: 's1', title: 'Check', acceptance: 'tests pass', status: 'active', reworks: 0,
        checks: [{ id: 'tests', kind: 'command', label: 'tests', command: 'npm test', expect: { exitCode: 0 } }],
        verification: { state: 'pending', checkEvidence: {}, missing: ['tests'] },
        tasks: [{
          id: 't1', botId: 'b', task: 'run tests', status: 'working',
          checks: [{ id: 'tests', kind: 'command', label: 'tests', command: 'npm test', expect: { exitCode: 0 } }],
          attempt: { id: 't1:a1', n: 1, status: 'working', startedAt: now, updatedAt: now },
          checkpoint: { at: now, attemptId: 't1:a1', kind: 'progress', summary: 'Started.' },
          progress: { state: 'moving', fingerprint: '', unchangedTurns: 0 },
          verification: { state: 'pending', checkEvidence: {}, missing: ['tests'] },
          evidence: [],
        }],
      }],
    },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({
    turns: { gb: { botId: 'b', roomId: 'r1', since: now, trigger: { role: 'room', roomId: 'r1', exchangeId: 'e1', taskId: 'goal:g1:s1:t1', attemptId: 't1:a1' } } },
    queued: {},
  }))
  const logs = new Map([['gb', [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { content: [], source: { kind: 'bot', role: 'room', roomId: 'r1', exchangeId: 'e1', taskId: 'goal:g1:s1:t1', attemptId: 't1:a1' } } },
    { type: 'tool/call', seq: 3, data: { turn: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) } },
    { type: 'tool/result', seq: 4, data: { turn: 1, callId: 'c1', message: { ok: true, content: [{ type: 'text', text: 'green' }] } } },
    { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'interrupted' } } },
  ]]])

  const host = await start(home, logs)
  await delay(3300)
  const task = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms.r1.goal.stages[0].tasks[0]
  assert.equal(task.attempt.id, 't1:a1')
  assert.equal(task.evidence[0].attemptId, 't1:a1')
  assert.equal(task.evidence[0].command.text, 'npm test')
  assert.equal(task.evidence[0].command.exitCode, 0)
  assert.equal(host.agentOf('gb').calls.length, 1)
  await host.stop()
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
  assert.equal(second.agentOf('b').calls[0].source.resent, true)
  await second.stop()
})

test('a turn DSH disposed does not swallow a note that was never sent', async (t) => {
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const writer = first.agentOf('b')
  const send = writer.followup
  // A send that failed leaves its note; the log holds a turn that read an earlier
  // delivery of the same exchange and was disposed as DSH stopped. A disposed turn did
  // not settle, so the note it did not read must still go out.
  writer.followup = () => { throw new Error('DeepSeek Harness shut down') }
  await assert.rejects(first.rt.deliver({ fromId: 'a', toId: 'b', role: 'reply', replyTo: 'r0', exchangeId: 'e0', text: 'Do it once.' }), /shut down/)
  writer.followup = send
  await settle(() => (notes(home).queued?.b ?? []).length === 1)
  await first.stop()
  logs.set('b', [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { content: [], source: { kind: 'bot', exchangeId: 'e0' } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } },
  ])
  const second = await start(home, logs)
  await delay(3300)
  assert.equal(second.agentOf('b').calls.length, 1)
  assert.equal(second.agentOf('b').calls[0].source.resent, true)
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
