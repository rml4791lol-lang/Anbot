import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  checkpointTaskRef,
  checkpointWorktree,
  discardCheckpointWorktree,
  materializeCheckpoint,
  snapshotWorktree,
} from '../src/host/bot-checkpoint.js'
import { linkedWorktree } from '../src/host/bot-worktree.js'
import { createCheckpointSession } from '../src/host/checkpoint-session.js'
import { createWorktreeHold } from '../src/host/worktree-hold.js'
import { installTaskLog } from '../src/host/task-ledger.js'

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

function repository(t, { linked = false } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'anbot-checkpoint-test-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const fixture = realpathSync(temporary)
  const source = join(fixture, 'repo')
  mkdirSync(source)
  git(source, 'init', '--quiet')
  writeFileSync(join(source, 'tracked.txt'), 'base\n')
  writeFileSync(join(source, '.gitignore'), 'ignored/\n')
  git(source, 'add', 'tracked.txt', '.gitignore')
  git(source, '-c', 'user.name=Anbot test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'base')
  if (!linked) return { fixture, source, worker: source }
  const worker = join(fixture, 'worker')
  git(source, 'worktree', 'add', '--quiet', '--detach', worker)
  return { fixture, source, worker }
}

function turnEvents(number, seq, source = { kind: 'user' }, { ended = true } = {}) {
  const events = [
    { seq, time: 100 + seq, type: 'turn/start', data: { turn: number } },
    { seq: seq + 1, time: 101 + seq, type: 'user/message', data: { id: `message-${seq + 1}`, role: 'user', content: [], source } },
  ]
  if (ended) events.push({ seq: seq + 2, time: 102 + seq, type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } } })
  return events
}

function checkpointRuntime({ bot, session, worker }) {
  const agent = { status: 'idle', session, whenIdle: async () => {} }
  const agents = { get: id => id === session.id ? agent : undefined, list: () => [agent] }
  const ctx = {
    sessions: { flush: async () => {} },
    get: name => name === 'agents' ? agents : undefined,
  }
  return {
    ctx,
    state: bot.state,
    botOf: id => id === bot.id ? bot : undefined,
    selfOf: id => id,
    chatOf: () => session.id,
    sessionFolder: () => worker,
    save: async ({ required } = {}) => { assert.equal(required, true) },
    warn: () => {},
  }
}

function sessionCreationContext(events, worktree) {
  let created = 0
  const agent = { model: { current: () => ({ provider: 'deepseek', model: 'model-1' }) }, session: { id: 'session-restored' } }
  const scope = { on: () => () => {} }
  const ctx = {
    sessions: { flush: async () => {} },
    get: name => ({
      agents: {
        create: async options => {
          created += 1
          await options.setup(scope, agent)
          return { agent, dispose: async () => {} }
        },
      },
      agentPresets: { resolve: async () => ({ id: 'preset-1' }), mount: async () => {} },
      sessionQuery: {
        observeSession: async () => ({
          events,
          projections: { values: { agentPreset: 'preset-1' } },
          [Symbol.dispose]: () => {},
        }),
      },
      workingDirectory: { set: async () => {} },
      permissionPresets: { resolve: () => undefined, set: () => {} },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: worktree }) },
      agentDefaultModel: { currentSelection: () => ({}) },
    })[name],
  }
  return { ctx, created: () => created }
}

test('Phase 1A checkpoints capture tracked work but exclude untracked and ignored files', async t => {
  const { source, worker } = repository(t, { linked: true })
  writeFileSync(join(worker, 'tracked.txt'), 'staged\n')
  git(worker, 'add', 'tracked.txt')
  writeFileSync(join(worker, 'tracked.txt'), 'working copy\n')
  writeFileSync(join(worker, 'notes.txt'), 'untracked work\n')
  mkdirSync(join(worker, 'ignored'))
  writeFileSync(join(worker, 'ignored', 'artifact.bin'), 'ignored artifact\n')
  const task = { taskId: 'goal:g1:s1:t1', attemptId: 't1:a1' }
  const head = git(worker, 'rev-parse', 'HEAD')
  const status = git(worker, 'status', '--porcelain')

  const snapshot = await snapshotWorktree(worker, task)
  assert.deepEqual(snapshot.task, task)
  assert.equal(git(worker, 'show', `${snapshot.checkpointRef}:tracked.txt`), 'working copy')
  const tree = git(worker, 'ls-tree', '-r', '--name-only', snapshot.checkpointRef)
  assert.doesNotMatch(tree, /notes\.txt|ignored\//u)
  assert.equal(git(worker, 'show', ':tracked.txt'), 'staged')
  assert.equal(git(worker, 'rev-parse', 'HEAD'), head)
  assert.equal(git(worker, 'status', '--porcelain'), status)

  const sessionId = 'session-4f063ccc-ed95-4202-9bd6-0395374f5f0e'
  const restored = checkpointWorktree(source, sessionId)
  await materializeCheckpoint(source, snapshot, restored)
  assert.equal(readFileSync(join(restored, 'tracked.txt'), 'utf8'), 'working copy\n')
  assert.equal(existsSync(join(restored, 'notes.txt')), false)
  assert.equal(existsSync(join(restored, 'ignored', 'artifact.bin')), false)
  await assert.rejects(
    discardCheckpointWorktree(source, restored, snapshot.commit, { sessionId: 'session-00000000-0000-0000-0000-000000000000' }),
    /not the reserved checkpoint worktree/u,
  )
  assert.equal(existsSync(restored), true)
  await discardCheckpointWorktree(source, restored, snapshot.commit, { sessionId })
  assert.equal(existsSync(restored), false)
  await snapshot.discard()
})

test('checkpoint records the verified TaskRef from the latest turn and rejects a forged identity', async t => {
  const { worker } = repository(t, { linked: true })
  const observed = await linkedWorktree(worker)
  assert.equal(observed.status, 'observed')
  const task = { taskId: 'goal:g1:s1:t1', attemptId: 't1:a1' }
  let events = turnEvents(1, 0, { kind: 'bot', role: 'request', ...task })
  const session = { id: 'session-source', snapshotEvents: () => events.slice() }
  const state = {
    bots: {},
    rooms: {
      r1: {
        id: 'r1',
        goal: {
          id: 'g1', status: 'active', current: 0,
          stages: [{ id: 's1', tasks: [{ id: 't1', botId: 'b1', attempt: { id: 't1:a1', sessionId: session.id } }] }],
        },
      },
    },
  }
  const bot = {
    id: 'b1', state, sessionId: session.id,
    worktreeHold: { sessionId: session.id, root: observed.value.root, gitDir: observed.value.gitDir, status: 'held', at: 1 },
  }
  const ownership = createWorktreeHold(checkpointRuntime({ bot, session, worker }))
  const record = await ownership.checkpoint('b1')
  assert.deepEqual(record.task, task)
  assert.equal(bot.checkpoints.at(-1).task.taskId, task.taskId)
  assert.equal(bot.checkpoints.at(-1).task.attemptId, task.attemptId)

  events = [...events, ...turnEvents(2, 3, { kind: 'bot', role: 'request', taskId: 'goal:g1:s1:ghost', attemptId: 'ghost:a1' })]
  await assert.rejects(ownership.checkpoint('b1'), /does not match the current goal or hand-off attempt/u)
  assert.equal(bot.checkpoints.length, 1)
})

test('finished handoffs use the exact Session and attempt in the close ledger', async t => {
  const { fixture, worker } = repository(t, { linked: true })
  const { value: tree } = await linkedWorktree(worker)
  const task = { taskId: 'handoff:request-1', attemptId: 'request-1:a1' }
  const events = turnEvents(1, 0, { kind: 'bot', role: 'request', ...task })
  const now = Date.now()
  for (const event of events) event.time = now - 100
  const session = { id: 'session-source', snapshotEvents: () => events }
  const state = { bots: {}, works: {} }
  const bot = {
    id: 'b1', state, sessionId: session.id,
    worktreeHold: { sessionId: session.id, root: tree.root, gitDir: tree.gitDir, status: 'held', at: now },
  }
  const rt = { ...checkpointRuntime({ bot, session, worker }), home: fixture }
  const log = installTaskLog(rt)
  log({ kind: 'close', id: 'request-1', to: bot.id, attemptId: task.attemptId, sessionId: 'another-session' })
  const hold = createWorktreeHold(rt)
  await assert.rejects(hold.checkpoint(bot.id), /does not match the current goal or hand-off attempt/u)
  log({ kind: 'close', id: 'request-1', to: bot.id, attemptId: task.attemptId, sessionId: session.id })
  assert.deepEqual((await hold.checkpoint(bot.id)).task, task)
})

test('a legacy close record corroborates the recipient of a TaskRef from native history', async t => {
  const { fixture, worker } = repository(t, { linked: true })
  const { value: tree } = await linkedWorktree(worker)
  const task = { taskId: 'handoff:legacy-request', attemptId: 'legacy-request:a1' }
  const events = turnEvents(1, 0, { kind: 'bot', role: 'request', ...task })
  const now = Date.now()
  for (const event of events) event.time = now - 100
  const session = { id: 'session-source', snapshotEvents: () => events }
  const bot = {
    id: 'b1', state: { bots: {}, works: {} }, sessionId: session.id,
    worktreeHold: { sessionId: session.id, root: tree.root, gitDir: tree.gitDir, status: 'held', at: now },
  }
  const rt = { ...checkpointRuntime({ bot, session, worker }), home: fixture }
  const log = installTaskLog(rt)
  const hold = createWorktreeHold(rt)
  log({ kind: 'close', id: 'legacy-request', to: 'b2' })
  await assert.rejects(hold.checkpoint(bot.id), /does not match/u)
  log({ kind: 'close', id: 'legacy-request', to: bot.id })
  assert.deepEqual((await hold.checkpoint(bot.id)).task, task)
  log({ kind: 'close', id: 'legacy-request', to: bot.id, attemptId: task.attemptId, sessionId: 'other-session' })
  await assert.rejects(hold.checkpoint(bot.id), /does not match/u)
})

test('interactive checkpoints without a task source stay unbound', async t => {
  const { worker } = repository(t, { linked: true })
  const observed = await linkedWorktree(worker)
  let events = turnEvents(1, 0)
  const session = { id: 'session-private', snapshotEvents: () => events.slice() }
  const bot = {
    id: 'b1', state: { bots: {}, rooms: {}, works: {} }, sessionId: session.id,
    worktreeHold: { sessionId: session.id, root: observed.value.root, gitDir: observed.value.gitDir, status: 'held', at: 1 },
  }
  const record = await createWorktreeHold(checkpointRuntime({ bot, session, worker })).checkpoint('b1')
  assert.equal(Object.hasOwn(record, 'task'), false)
  assert.equal(Object.hasOwn(bot.checkpoints[0], 'task'), false)
})

test('discard archives a clean preview and retains dirty previews and failed saves for retry', async t => {
  const { worker } = repository(t, { linked: true })
  const checkpoint = { ...await snapshotWorktree(worker), worktree: worker }
  const sessionId = 'session-1d969339-b75c-433e-85f2-7b1ccb2e49ce'
  const worktree = checkpointWorktree(worker, sessionId)
  await materializeCheckpoint(worker, checkpoint, worktree)
  const preview = { sessionId, worktree, checkpointRef: checkpoint.checkpointRef }
  const bot = { id: 'b1', checkpoints: [checkpoint], checkpointPreviews: [preview] }
  const archived = new Set()
  const persistence = { stat: async () => ({ header: { id: sessionId, cwd: worktree, isSeeded: true } }) }
  let failing = false
  const rt = {
    ctx: { get: name => name === 'sessionPersistence' ? persistence : undefined,
      sessions: { get: () => undefined }, workspaceRegistry: { archiveSession: async id => { archived.add(id) } } },
    state: { bots: { b1: bot } }, botOf: id => id === bot.id ? bot : undefined,
    selfOf: () => undefined,
    save: async ({ required }) => { assert.equal(required, true); if (failing) throw new Error('save failed') },
  }
  const control = createWorktreeHold(rt)
  const remove = () => control.discardCheckpoint(bot.id, checkpoint.checkpointRef)
  assert.throws(() => control.assertCanDelete(bot), /checkpoint/i)
  const dirty = join(worktree, 'human.txt')
  writeFileSync(dirty, 'keep this')
  await assert.rejects(remove(), /working files/)
  assert.equal(archived.size, 0)
  assert.equal(readFileSync(dirty, 'utf8'), 'keep this')
  rmSync(dirty)
  failing = true
  await assert.rejects(remove(), /save failed/)
  assert.equal(bot.checkpointPreviews[0], preview)
  assert.equal(bot.checkpoints[0], checkpoint)
  assert.equal(existsSync(worktree), false)
  assert.deepEqual([...archived], [sessionId])
  failing = false
  await remove()
  assert.deepEqual(bot.checkpoints, [])
  assert.deepEqual(bot.checkpointPreviews, [])
  assert.equal(git(worker, 'for-each-ref', 'refs/anbot/checkpoints'), '')
  assert.doesNotThrow(() => control.assertCanDelete(bot))
})

test('checkpoint refuses a native Session change during its final Git check', async t => {
  const { worker } = repository(t, { linked: true })
  const { value: tree } = await linkedWorktree(worker)
  const events = turnEvents(1, 0)
  const session = { id: 'session-private', snapshotEvents: () => events.slice() }
  const bot = {
    id: 'b1', state: { bots: {} }, sessionId: session.id,
    worktreeHold: { sessionId: session.id, root: tree.root, gitDir: tree.gitDir, status: 'held', at: 1 },
  }
  const rt = checkpointRuntime({ bot, session, worker })
  let checks = 0
  rt.sessionFolder = () => {
    if (++checks === 2) events.push(...turnEvents(2, 3))
    return worker
  }
  await assert.rejects(createWorktreeHold(rt).checkpoint(bot.id), /changed while taking the checkpoint/u)
  assert.equal(bot.checkpoints, undefined)
  assert.equal(git(worker, 'for-each-ref', 'refs/anbot/checkpoints'), '')
})

test('checkpoint Session creation validates a native task source and preserves no-task restores', async t => {
  const { worker } = repository(t)
  const expected = { taskId: 'goal:g1:s1:t1', attemptId: 't1:a1' }
  const mismatched = turnEvents(1, 0, { kind: 'bot', role: 'request', taskId: 'goal:g1:s1:t2', attemptId: 't2:a1' })
  const rejected = sessionCreationContext(mismatched, worker)
  await assert.rejects(
    createCheckpointSession(rejected.ctx, { sessionId: 'session-source', throughSequence: 2, task: expected }, worker, 'session-restored', true),
    /does not belong to its recorded TaskRef/u,
  )
  assert.equal(rejected.created(), 0)

  const legacy = sessionCreationContext(turnEvents(1, 0, { kind: 'bot', ...expected }), worker)
  await createCheckpointSession(legacy.ctx, { sessionId: 'session-source', throughSequence: 2 }, worker, 'session-restored', true)
  assert.equal(legacy.created(), 1)

  const untasked = sessionCreationContext(turnEvents(1, 0), worker)
  const handle = await createCheckpointSession(untasked.ctx, { sessionId: 'session-source', throughSequence: 2 }, worker, 'session-restored', true)
  assert.equal(untasked.created(), 1)
  assert.equal(handle.agent.session.id, 'session-restored')
})

test('restart cleanup verifies a restored TaskRef and retains an identity mismatch', async t => {
  const { source } = repository(t)
  const task = { taskId: 'handoff:w1', attemptId: 'w1:a1' }
  const snapshot = await snapshotWorktree(source, task)
  const record = { ...snapshot, task, worktree: source, sessionId: 'session-source', throughSequence: 2 }
  const sessionId = 'session-4f063ccc-ed95-4202-9bd6-0395374f5f0e'
  const restored = checkpointWorktree(source, sessionId)
  await materializeCheckpoint(source, record, restored)
  const bot = {
    id: 'b1', checkpoints: [record],
    checkpointRestore: { sessionId, checkpointRef: record.checkpointRef, createdAfter: 100 },
  }
  let childEvents = turnEvents(1, 0, { kind: 'bot', role: 'request', taskId: 'handoff:w2', attemptId: 'w2:a1' })
  const archived = []
  const warnings = []
  const saves = []
  const persistence = {
    stat: async () => ({ header: { id: sessionId, cwd: restored, isSeeded: true, createdAt: 101 } }),
    open: async () => ({ read: async () => ({ events: childEvents }), close: async () => {} }),
  }
  const rt = {
    ctx: {
      get: name => name === 'sessionPersistence' ? persistence : undefined,
      sessions: { get: () => undefined },
      workspaceRegistry: { archiveSession: async id => archived.push(id) },
    },
    state: { bots: { b1: bot } },
    botOf: id => id === 'b1' ? bot : undefined,
    selfOf: () => undefined,
    load: async () => {},
    readOnly: () => undefined,
    save: async ({ required }) => { assert.equal(required, true); saves.push(bot.checkpointRestore) },
    warn: (message, ...args) => warnings.push({ message, args }),
  }

  await createWorktreeHold(rt).recoverPendingRestores()
  assert.equal(archived.length, 0)
  assert.equal(existsSync(restored), true)
  assert.equal(bot.checkpointRestore.sessionId, sessionId)
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0].args.at(-1)), /does not contain the checkpoint TaskRef/u)

  childEvents = turnEvents(1, 0, { kind: 'bot', role: 'request', ...task })
  await createWorktreeHold(rt).recoverPendingRestores()
  assert.deepEqual(archived, [sessionId])
  assert.equal(existsSync(restored), false)
  assert.equal(bot.checkpointRestore, undefined)
  assert.equal(saves.at(-1), undefined)
  await snapshot.discard()
})

test('TaskRef extraction is limited to the latest turn and requires both IDs when present', () => {
  const first = { taskId: 'goal:g1:s1:t1', attemptId: 't1:a1' }
  const previous = turnEvents(1, 0, { kind: 'bot', role: 'request', ...first })
  const privateTurn = turnEvents(2, 3)
  assert.equal(Object.hasOwn(privateTurn[1].data, 'turn'), false)
  assert.equal(checkpointTaskRef([...previous, ...privateTurn], 5), undefined)
  assert.deepEqual(checkpointTaskRef(turnEvents(1, 0, { kind: 'bot', ...first }, { ended: false }), 1), first)

  const endedPrivate = turnEvents(1, 0)
  endedPrivate.push({ seq: 3, time: 103, type: 'user/message', data: { id: 'message-3', role: 'user', content: [], source: { kind: 'bot', ...first } } })
  assert.equal(checkpointTaskRef(endedPrivate, 3), undefined)

  assert.throws(
    () => checkpointTaskRef([...previous, ...turnEvents(2, 3, { kind: 'bot', taskId: first.taskId })], 5),
    /no complete TaskRef/u,
  )
  assert.throws(
    () => checkpointTaskRef([
      { seq: 0, time: 100, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: 101, type: 'user/message', data: { id: 'message-1', role: 'user', content: [], source: { kind: 'bot', ...first } } },
      { seq: 2, time: 102, type: 'user/message', data: { id: 'message-2', role: 'user', content: [], source: { kind: 'bot', ...first, attemptId: 't1:a2' } } },
    ], 2),
    /conflicting task identities/u,
  )
})
