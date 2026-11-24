import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  claimBotProjectWorkspace,
  isBotProjectWorkspaceDir,
  prepareBotProjectWorkspace,
  releaseBotProjectWorkspace,
} from '../src/host/bot-project-workspace.js'
import { linkedWorktree } from '../src/host/bot-worktree.js'
import { install as installFolders } from '../src/host/folders.js'
import { install as installRoster } from '../src/host/roster.js'

function repository(t, relativeFolder = '') {
  const fixture = mkdtempSync(join(tmpdir(), 'anbot-project-workspace-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const root = realpathSync(fixture)
  const source = join(root, 'repository', relativeFolder)
  mkdirSync(source, { recursive: true })
  const repositoryRoot = join(root, 'repository')
  const git = (...args) => execFileSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '--quiet')
  writeFileSync(join(repositoryRoot, 'tracked.txt'), 'base\n')
  if (relativeFolder !== '') writeFileSync(join(source, 'nested.txt'), 'nested\n')
  git('add', '--all')
  git('-c', 'user.name=Anbot test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'base')
  return { root, repositoryRoot, source, git }
}

function rosterRuntime(root, team) {
  const state = {
    version: 1, workspaceId: 'w1', mainBotIds: [], bots: {}, privateArchives: [], rooms: {}, agents: {},
    sections: [], capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, works: {}, requests: {},
    questions: {}, views: {}, closedCards: {}, prefs: {}, switching: {}, revision: 0,
  }
  const agents = new Map()
  const requests = []
  const archived = []
  let resolves = 0
  const ctx = {
    workspaceRegistry: {
      get: id => id === 'w1' ? { id, path: team, title: 'DS Bot' } : undefined,
      list: () => [{ id: 'w1', path: team, title: 'DS Bot' }],
      resolveByPath: async path => {
        resolves += 1
        return path === team ? { id: 'w1', path: team, title: 'DS Bot' } : undefined
      },
      create: async path => ({ id: 'created', path, title: 'DS Bot' }),
      archiveSession: async id => { archived.push(id) },
    },
    sessionController: {
      create: async options => {
        requests.push(options)
        const id = options.sessionId ?? `session-${requests.length}-1111-4222-8333-444444444444`
        agents.set(id, { status: 'idle', session: { id, header: { cwd: options.cwd ?? team } } })
        return { sessionId: id }
      },
    },
    sessionTitle: { rename: async () => {} },
    get: name => name === 'agents' ? { get: id => agents.get(id), list: () => [...agents.values()] } : undefined,
  }
  const rt = {
    ctx,
    state,
    statePath: join(root, 'state.json'),
    home: join(root, 'data'),
    config: {},
    defaults: { mainName: 'Chief', mainRole: 'Chief of Staff' },
    chatOwners: new Map(),
    botOf: id => state.bots[id],
    roomOf: id => state.rooms[id],
    selfOf: id => id in state.bots ? id : undefined,
    groupOwners: new Map(),
    findBot: name => Object.values(state.bots).find(bot => bot.name.toLowerCase() === name.toLowerCase()),
    isFolder: async path => existsSync(path),
    defaultBotModel: async () => undefined,
    resolveModel: async model => model,
    defaultEffort: async () => undefined,
    resolveEffort: async () => undefined,
    privateClash: async () => undefined,
    readOnly: () => undefined,
    save: async () => writeFileSync(rt.statePath, JSON.stringify(state)),
    warn: () => {},
    resolveAgent: async id => {
      const agent = agents.get(id)
      return { agent }
    },
    uiLanguage: () => 'English',
    catalog: async () => [],
    workspaceHold: { assertUnheld: () => {}, assertCanDelete: () => {} },
    dropBotPreset: async () => {},
    capabilityChanged: async () => {},
  }
  installFolders(rt)
  installRoster(rt)
  return { rt, state, requests, archived, resolves: () => resolves }
}

test('a Bot reservation creates one linked checkout, survives reload, and isolates working files', async t => {
  const { repositoryRoot, source, git } = repository(t)
  const state = {}
  let saves = 0
  const rt = {
    state,
    save: async ({ required } = {}) => {
      assert.equal(required, true)
      if (saves === 0) assert.doesNotMatch(git('worktree', 'list', '--porcelain'), /branch refs\/heads\/anbot-/u)
      saves += 1
    },
  }

  const reserved = await prepareBotProjectWorkspace(rt, { name: 'Builder', source })
  assert.match(reserved.sessionId, /^session-[0-9a-f-]{36}$/u)
  assert.equal(reserved.repositoryRoot, repositoryRoot)
  assert.equal(reserved.status, 'ready')
  assert.equal((await linkedWorktree(reserved.workingDir)).status, 'observed')
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gmu).length, 2)
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(saves, 2)

  writeFileSync(join(reserved.root, 'from-bot.txt'), 'bot only\n')
  assert.equal(existsSync(join(source, 'from-bot.txt')), false)
  writeFileSync(join(source, 'tracked.txt'), 'source only\n')
  assert.equal(readFileSync(join(reserved.root, 'tracked.txt'), 'utf8'), 'base\n')

  const reloaded = { state: JSON.parse(JSON.stringify(state)), save: async () => { saves += 1 } }
  const reused = await prepareBotProjectWorkspace(reloaded, { name: 'Builder', source })
  assert.equal(reused.reservationId, reserved.reservationId)
  assert.equal(reused.sessionId, reserved.sessionId)
  assert.equal(reused.root, reserved.root)
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gmu).length, 2)

  const claimed = claimBotProjectWorkspace(reloaded, reused, 'session-live')
  assert.equal(claimed.sessionId, 'session-live')
  assert.equal(claimed.workingDir, reused.workingDir)
  assert.equal(reloaded.state.projectWorkspaceReservations[reused.reservationId], undefined)
  reloaded.state.bots = { 'session-live': { id: 'session-live', projectWorkspace: claimed } }
  assert.equal(isBotProjectWorkspaceDir(reloaded, reused.workingDir), true)
  assert.equal(isBotProjectWorkspaceDir(reloaded, source), false)

  releaseBotProjectWorkspace(reloaded, reserved, 'session-live')
  const retry = reloaded.state.projectWorkspaceReservations[reserved.reservationId]
  assert.equal(retry.status, 'ready')
  assert.equal(retry.previousSessionId, 'session-live')
  assert.notEqual(retry.sessionId, 'session-live')
  assert.equal(retry.root, reserved.root)
})

test('a reservation inside a repository subfolder reuses that relative working directory', async t => {
  const { source, git } = repository(t, join('packages', 'app'))
  const state = {}
  const rt = { state, save: async () => {} }
  const reserved = await prepareBotProjectWorkspace(rt, { name: 'App Bot', source })
  assert.equal(reserved.workingDir, join(reserved.root, 'packages', 'app'))
  assert.equal(readFileSync(join(reserved.workingDir, 'nested.txt'), 'utf8'), 'nested\n')
  assert.equal((await linkedWorktree(reserved.workingDir)).value.root, reserved.root)
  assert.equal(git('status', '--porcelain'), '')
})

test('retry restores a reserved checkout that disappeared after an interrupted start', async t => {
  const { source, git } = repository(t)
  const rt = { state: {}, save: async () => {} }
  const reserved = await prepareBotProjectWorkspace(rt, { name: 'Retry Bot', source })
  rmSync(reserved.root, { recursive: true, force: true })
  assert.equal(existsSync(reserved.root), false)
  const reused = await prepareBotProjectWorkspace(rt, { name: 'Retry Bot', source })
  assert.equal(reused.reservationId, reserved.reservationId)
  assert.equal(existsSync(reused.root), true)
  assert.equal(readFileSync(join(reused.root, 'tracked.txt'), 'utf8'), 'base\n')
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gmu).length, 2)
})

test('automatic provisioning skips a team folder that the commit does not contain', async t => {
  const { repositoryRoot, git } = repository(t)
  writeFileSync(join(repositoryRoot, '.gitignore'), 'ignored/\n')
  git('add', '.gitignore')
  git('-c', 'user.name=Anbot test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'ignore')
  const state = {}
  const save = async () => { throw new Error('must not save') }
  for (const folder of [join('ignored', 'team'), 'untracked', 'staged']) {
    const source = join(repositoryRoot, folder)
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'notes.txt'), 'local\n')
    if (folder === 'staged') git('add', 'staged')
    assert.equal(await prepareBotProjectWorkspace({ state, save }, { name: 'Ignored Bot', source }), undefined, folder)
  }
  assert.deepEqual(state, {})
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gmu).length, 1)
})

test('automatic provisioning is bounded to repositories with a readable commit', async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'anbot-project-workspace-plain-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const state = {}
  const result = await prepareBotProjectWorkspace({ state, save: async () => { throw new Error('must not save') } }, {
    name: 'Plain Bot', source: fixture,
  })
  assert.equal(result, undefined)
  assert.deepEqual(state, {})
})

test('creating and copying Bots provisions distinct project worktrees while an explicit folder stays explicit', async t => {
  const { root, repositoryRoot, source, git } = repository(t)
  const { rt, state, requests, resolves } = rosterRuntime(root, source)
  const builder = await rt.createBot({ name: 'Builder', pickModel: true })

  assert.equal(builder.workDir, builder.projectWorkspace.workingDir)
  assert.equal(builder.projectWorkspace.root, join(repositoryRoot, '.agents', 'worktrees', builder.projectWorkspace.branch))
  assert.equal(requests[0].sessionId, builder.id)
  assert.equal(requests[0].cwd, builder.workDir)
  assert.equal(requests[0].workspaceId, undefined)
  assert.equal(resolves(), 0)
  assert.deepEqual(state.projectWorkspaceReservations, {})
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gmu).length, 2)

  const copy = await rt.duplicateBot(builder.id)
  assert.notEqual(copy.id, builder.id)
  assert.notEqual(copy.projectWorkspace.root, builder.projectWorkspace.root)
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gmu).length, 3)

  const explicitDir = join(root, 'explicit')
  mkdirSync(explicitDir)
  const explicit = await rt.createBot({ name: 'Explicit', workDir: explicitDir, pickModel: true })
  assert.equal(explicit.workDir, explicitDir)
  assert.equal(explicit.projectWorkspace, undefined)
  assert.equal(requests.at(-1).cwd, explicitDir)
  assert.equal(requests.at(-1).sessionId, undefined)
})

test('a failed Session start reuses its reserved Bot worktree and Session identity', async t => {
  const { root, source, git } = repository(t)
  const { rt, state, requests } = rosterRuntime(root, source)
  const create = rt.ctx.sessionController.create
  let fail = true
  rt.ctx.sessionController.create = async options => {
    if (fail) {
      fail = false
      throw new Error('Session start interrupted')
    }
    return create(options)
  }

  await assert.rejects(rt.createBot({ name: 'Retry', pickModel: true }), /Session start interrupted/u)
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gmu).length, 2)
  const [reservation] = Object.values(state.projectWorkspaceReservations)
  assert.equal(reservation.status, 'ready')

  const bot = await rt.createBot({ name: 'Retry', pickModel: true })
  assert.equal(bot.projectWorkspace.root, reservation.root)
  assert.equal(requests.at(-1).sessionId, reservation.sessionId)
  assert.equal(requests.at(-1).cwd, bot.workDir)
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gmu).length, 2)
  assert.deepEqual(state.projectWorkspaceReservations, {})
})
