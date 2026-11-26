import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gitRepository, linkedWorktree, observeGitWorktreeStatus, probeBotWorktree } from '../src/host/bot-worktree.js'
import { checkpointWorktree, materializeCheckpoint, snapshotWorktree } from '../src/host/bot-checkpoint.js'
import { createWorktreeHold } from '../src/host/worktree-hold.js'

test('Git and DSH independently prove worktree creation, attachment, and only the active turn start', async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'anbot-worktree-probe-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const source = join(fixture, 'repo')
  const worker = join(fixture, 'worker')
  const sibling = join(fixture, 'sibling')
  mkdirSync(source)
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
  git('init', '--quiet')
  git('-c', 'user.name=Anbot test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'base')
  git('worktree', 'add', '--quiet', '--detach', worker)
  git('worktree', 'add', '--quiet', '--detach', sibling)
  const primary = await gitRepository(source)
  assert.equal(primary.status, 'observed')
  assert.deepEqual(primary.value, {
    root: realpathSync(source), gitDir: realpathSync(join(source, '.git')),
    commonDir: realpathSync(join(source, '.git')), revision: git('rev-parse', 'HEAD'), linked: false,
  })
  const checkout = await gitRepository(worker)
  assert.equal(checkout.status, 'observed')
  assert.equal(checkout.value.root, realpathSync(worker))
  assert.equal(checkout.value.commonDir, realpathSync(join(source, '.git')))
  assert.equal(checkout.value.linked, true)
  assert.match((await linkedWorktree(source)).reason, /primary checkout/u)
  assert.equal((await linkedWorktree(fixture)).status, 'unavailable')

  let live
  let directory = sibling
  const events = []
  const rt = {
    ctx: { get: () => ({ get: () => live }) },
    botOf: () => ({}), chatOf: () => 'current', workDirOf: () => worker,
    sessionFolder: (_session, { observedOnly }) => {
      assert.equal(observedOnly, true)
      return directory
    },
  }
  const expected = { root: realpathSync(worker), sessionId: 'current', revision: git('rev-parse', 'HEAD') }
  assert.deepEqual((await probeBotWorktree(rt, 'bot')).value, { ...expected, state: 'created' })
  live = { status: 'running', session: { id: 'current', inheritedEventCount: 1, snapshotEvents: () => events } }
  assert.equal((await probeBotWorktree(rt, 'bot')).value.state, 'created')
  directory = undefined
  assert.equal((await probeBotWorktree(rt, 'bot')).value.state, 'created')
  directory = worker
  events.push({ type: 'turn/start', seq: 41, data: { turn: 1 } })
  assert.equal((await probeBotWorktree(rt, 'bot')).value.state, 'session-ready')
  events.push({ type: 'turn/start', seq: 42, data: { turn: 1 } })
  assert.deepEqual((await probeBotWorktree(rt, 'bot')).value, { ...expected, state: 'turn-started', turnSequence: 42 })
  events.push({ type: 'turn/end', seq: 43, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.deepEqual((await probeBotWorktree(rt, 'bot')).value, { ...expected, state: 'session-ready' })

  events.push({ type: 'turn/start', seq: 44, data: { turn: 2 } })
  assert.deepEqual((await probeBotWorktree(rt, 'bot')).value, { ...expected, state: 'turn-started', turnSequence: 44 })
  events.push({ type: 'turn/end', seq: 45, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.deepEqual((await probeBotWorktree(rt, 'bot')).value, { ...expected, state: 'session-ready' })

  events.push({ type: 'turn/start', seq: 46, data: { turn: 3 } })
  events.push({ type: 'turn/end', seq: 47, data: { turn: 3, reason: { kind: 'error', error: { message: 'failed' } } } })
  assert.deepEqual((await probeBotWorktree(rt, 'bot')).value, { ...expected, state: 'session-ready' })

  events.push({ type: 'turn/start', seq: 48, data: { turn: 4 } })
  live.status = 'idle'
  assert.deepEqual((await probeBotWorktree(rt, 'bot')).value, { ...expected, state: 'session-ready' })
})

test('the live Git worktree status reports its branch and working changes without altering the index', async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'anbot-worktree-status-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const source = join(fixture, 'source')
  const worker = join(fixture, 'worker')
  mkdirSync(source)
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q')
  git('-c', 'user.name=Anbot test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base', '--allow-empty')
  git('worktree', 'add', '-qb', 'anbot-status-test', worker)
  const revision = git('rev-parse', 'HEAD')
  assert.deepEqual(await observeGitWorktreeStatus(worker), { branch: 'anbot-status-test', revision, dirty: false })
  writeFileSync(join(worker, 'notes.txt'), 'An untracked draft\n')
  assert.deepEqual(await observeGitWorktreeStatus(worker), { branch: 'anbot-status-test', revision, dirty: true })
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(await observeGitWorktreeStatus(join(fixture, 'missing')), null)
})

test('a Git checkpoint captures working contents without moving HEAD or changing the staged index', async t => {
  const root = mkdtempSync(join(tmpdir(), 'anbot-worktree-checkpoint-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '--quiet')
  const tracked = join(root, 'tracked.txt')
  writeFileSync(tracked, 'original\n')
  git('add', 'tracked.txt')
  git('-c', 'user.name=Anbot test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'base')
  writeFileSync(tracked, 'staged\n')
  git('add', 'tracked.txt')
  writeFileSync(tracked, 'working copy\n')
  writeFileSync(join(root, 'untracked.txt'), 'untracked\n')
  const head = git('rev-parse', 'HEAD')
  const status = git('status', '--porcelain')
  const snapshot = await snapshotWorktree(root)
  assert.equal(git('rev-parse', snapshot.checkpointRef), snapshot.commit)
  assert.equal(git('show', `${snapshot.checkpointRef}:tracked.txt`), 'working copy')
  assert.equal(git('ls-tree', '--name-only', snapshot.checkpointRef), 'tracked.txt')
  assert.equal(git('show', ':tracked.txt'), 'staged')
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(git('status', '--porcelain'), status)
  await snapshot.discard()
  assert.equal(git('for-each-ref', 'refs/anbot/checkpoints'), '')
})

test('local takeover keeps the worktree stopping until the original executor confirms the turn ended', async t => {
  const root = mkdtempSync(join(tmpdir(), 'anbot-local-worktree-hold-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const folder = join(root, 'checkout')
  const worker = join(root, 'worker')
  mkdirSync(folder)
  const git = (...args) => execFileSync('git', ['-C', folder, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '--quiet')
  git('-c', 'user.name=Anbot test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'base')
  git('worktree', 'add', '--quiet', '--detach', worker)

  const bot = {}
  const agent = { status: 'idle', session: { id: 's1' }, inbox: { hasPending: false }, whenIdle: async () => {} }
  const other = { status: 'idle', session: { id: 's2' } }
  const registry = { get: () => agent, list: () => [agent, other] }
  const native = Promise.withResolvers()
  const called = Promise.withResolvers()
  const saved = []
  let proof = native.promise
  let otherHasPrompt = true
  let ownHasPrompt = false
  let hasSubagents = false
  let workflowStatus
  let saveRelease
  const rt = {
    ctx: { get: () => registry }, state: { bots: { b1: bot } },
    botOf: id => id === 'b1' ? bot : undefined, selfOf: () => 'b1', chatOf: () => agent.session.id,
    sessionFolder: () => worker, real: async path => realpathSync(path), hasSubagents: () => hasSubagents,
    botWorkflowView: () => ({ status: workflowStatus }),
    engineOfBot: () => 'local-opencode', isLocalAgentRoute: route => route === 'local-opencode', localAgentCanConfirmStop: () => true,
    stopLocalAgentForTakeover: () => { called.resolve(); return proof },
    localAgentHasUnsettledPrompt: id => id === 's2' ? otherHasPrompt : ownHasPrompt,
    save: async () => {
      if (bot.worktreeHold === undefined && saveRelease) await saveRelease()
      saved.push(bot.worktreeHold?.status ?? null)
    },
  }
  const ownership = createWorktreeHold(rt)
  await assert.rejects(ownership.change('b1', true), /Another Agent is active/)
  assert.equal(ownership.view('b1'), null)
  otherHasPrompt = false
  const taking = ownership.change('b1', true)
  await called.promise
  assert.equal(ownership.view('b1').status, 'stopping')
  assert.throws(() => ownership.assertUnheld('s1'), /paused/)
  native.resolve(false)
  await assert.rejects(taking, /has not confirmed it stopped/)
  await assert.rejects(createWorktreeHold(rt).change('b1', true), /previous host/)
  await assert.rejects(ownership.change('b1', false), /has not confirmed it stopped/)
  assert.deepEqual(saved, ['stopping'])

  proof = Promise.resolve(true)
  assert.equal((await ownership.change('b1', true)).status, 'held')
  agent.status = 'running'
  await assert.rejects(ownership.change('b1', false), /Session.*idle/)
  agent.status = 'idle'
  agent.inbox.hasPending = true
  await assert.rejects(ownership.change('b1', false), /waiting messages/)
  agent.inbox.hasPending = false
  hasSubagents = true
  await assert.rejects(ownership.change('b1', false), /delegated work/)
  hasSubagents = false
  workflowStatus = 'cancelling'
  await assert.rejects(ownership.change('b1', false), /Workflow/)
  workflowStatus = 'cancelled'
  ownHasPrompt = true
  await assert.rejects(ownership.change('b1', false), /local Agent/)
  ownHasPrompt = false
  assert.equal(ownership.view('b1').status, 'held')

  const saving = Promise.withResolvers()
  const disk = Promise.withResolvers()
  saveRelease = () => { saving.resolve(); return disk.promise }
  const releasing = ownership.change('b1', false)
  const failed = assert.rejects(releasing, /save failed/)
  await saving.promise
  try {
    assert.equal(ownership.view('b1')?.status, 'held')
    assert.throws(() => ownership.assertUnheld('s1'), /paused/)
    assert.equal(await ownership.heldFor(other.session), true)
  } finally {
    disk.reject(new Error('save failed'))
    await failed
  }
  assert.equal(ownership.view('b1').status, 'held')

  saveRelease = undefined
  await ownership.change('b1', false)
  assert.deepEqual(saved, ['stopping', 'held', null])
  assert.doesNotThrow(() => ownership.assertUnheld('s1'))
})

test('a stopping local worktree hold left by a previous host is reconciled at startup', async t => {
  const root = mkdtempSync(join(tmpdir(), 'anbot-hold-reconcile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const holds = {
    b1: { sessionId: 's1', root: join(root, 'w1'), gitDir: join(root, 'g1'), status: 'stopping', at: 1, local: true, hostRun: 'previous-host' },
    b2: { sessionId: 's2', root: join(root, 'w2'), gitDir: join(root, 'g2'), status: 'stopping', at: 2, local: true, hostRun: 'previous-host' },
  }
  const bots = { b1: { id: 'b1', worktreeHold: holds.b1 }, b2: { id: 'b2', worktreeHold: holds.b2 } }
  const stops = []
  const saved = []
  const rt = {
    ctx: {}, state: { bots },
    botOf: id => bots[id], selfOf: id => id, chatOf: id => id,
    load: async () => {}, readOnly: () => undefined,
    save: async () => { saved.push(Object.values(bots).map(bot => bot.worktreeHold.status)) },
    // The adapter proves only s1 stopped; s2's executor may still be writing.
    stopLocalAgentForTakeover: (id) => { stops.push(id); return Promise.resolve(id === 's1') },
  }
  const ownership = createWorktreeHold(rt)
  await ownership.recoverPendingRestores()
  assert.deepEqual(stops, ['s1', 's2'])
  assert.equal(bots.b1.worktreeHold.status, 'held')
  assert.equal(bots.b2.worktreeHold.status, 'stopping')
  assert.match(bots.b2.worktreeHold.reason, /did not prove it stopped/)
  assert.equal(ownership.view('b1').status, 'held')
  assert.match(ownership.view('b2').reason, /did not prove it stopped/)
  assert.deepEqual(saved, [['held', 'stopping'], ['held', 'stopping']])
})

test('restart cleans only the reserved unpublished restore and retains a dirty checkout for operator recovery', async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'anbot-restore-reconcile-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const root = realpathSync(fixture)
  const source = join(root, 'project')
  mkdirSync(source)
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '--quiet')
  git('-c', 'user.name=Anbot test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'base')
  const checkpoint = { ...await snapshotWorktree(source), worktree: source }
  const sessionId = 'session-4f063ccc-ed95-4202-9bd6-0395374f5f0e'
  const reservation = { sessionId, checkpointRef: checkpoint.checkpointRef, createdAfter: 100 }
  const restored = checkpointWorktree(source, sessionId)
  await materializeCheckpoint(source, checkpoint, restored)
  const bot = { id: 'b1', checkpoints: [checkpoint], checkpointRestore: reservation }
  const warnings = []
  const archived = new Set()
  let header = { id: sessionId, cwd: source, isSeeded: true, createdAt: 101 }
  const persistence = { stat: async () => header === null ? undefined : { header } }
  const rt = {
    ctx: { get: name => name === 'sessionPersistence' ? persistence : undefined,
      sessions: { get: () => undefined }, workspaceRegistry: { archiveSession: async id => { archived.add(id) } } },
    state: { bots: { b1: bot } }, botOf: id => id === bot.id ? bot : undefined,
    selfOf: () => undefined, load: async () => {}, readOnly: () => undefined,
    save: async ({ required }) => { assert.equal(required, true) },
    warn: (...args) => warnings.push(args),
  }
  const dirt = join(restored, 'human.txt')
  writeFileSync(dirt, 'keep this')
  const ownership = createWorktreeHold(rt)
  assert.equal(await ownership.heldFor({ id: sessionId }), true)
  await ownership.recoverPendingRestores()
  assert.equal(archived.size, 0)
  assert.equal(existsSync(dirt), true)
  assert.equal(bot.checkpointRestore, reservation)
  header = { ...header, cwd: restored }
  await ownership.recoverPendingRestores()
  assert.deepEqual([...archived], [sessionId])
  assert.equal(existsSync(dirt), true)
  assert.equal(bot.checkpointRestore, reservation)
  assert.equal(warnings.length, 2)
  rmSync(dirt)
  const ignored = join(restored, 'ignored.txt')
  writeFileSync(join(source, '.git', 'info', 'exclude'), 'ignored.txt\n')
  writeFileSync(ignored, 'keep this too')
  await ownership.recoverPendingRestores()
  assert.equal(existsSync(ignored), true)
  assert.equal(bot.checkpointRestore, reservation)
  rmSync(ignored)
  const restarted = createWorktreeHold(rt)
  await restarted.recoverPendingRestores()
  assert.equal(existsSync(restored), false)
  assert.equal(bot.checkpointRestore, undefined)
  assert.equal(await restarted.heldFor({ id: sessionId }), false)

  // A process can exit after creating the Git worktree and before creating the DSH Session.
  archived.clear()
  header = null
  bot.checkpointRestore = reservation
  await materializeCheckpoint(source, checkpoint, restored)
  writeFileSync(dirt, 'keep this pre-session change')
  await restarted.recoverPendingRestores()
  assert.equal(existsSync(dirt), true)
  assert.equal(bot.checkpointRestore, reservation)
  rmSync(dirt)
  await restarted.recoverPendingRestores()
  assert.equal(existsSync(restored), false)
  assert.equal(bot.checkpointRestore, undefined)
  assert.equal(archived.size, 0)
})
