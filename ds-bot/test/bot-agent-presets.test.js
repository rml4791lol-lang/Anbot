import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  revision: 1,
  whaleStored: true,
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function registryFixture() {
  const base = new Map([
    ['standard', { id: 'standard', content: '- id: standard-tools\n  name: dsh-test-standard\n' }],
    ['ptc', { id: 'ptc', content: '- id: ptc-tools\n  name: dsh-test-ptc\n' }],
  ])
  const registered = new Map()
  const disposed = []
  return {
    registered,
    disposed,
    async list() {
      return [
        ...[...base.values()].map(value => ({ id: value.id })),
        ...[...registered.values()].map(record => ({ id: record.definition.id, name: record.definition.name, ...(record.broken ? { broken: record.broken } : {}) })),
      ]
    },
    async readDocument(id) {
      const found = base.get(id)
      if (found === undefined) throw new Error(`Unknown agent preset: ${id}`)
      return { agentPreset: id, content: found.content, name: id }
    },
    async register(definition) {
      if (registered.has(definition.id) || base.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
      const broken = definition.plugins.some(row => row?.name === 'broken-plugin') ? 'broken-plugin failed to start' : undefined
      registered.set(definition.id, { definition, broken })
      return async () => {
        registered.delete(definition.id)
        disposed.push(definition.id)
      }
    },
  }
}

function start({ state, presetsFrom } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-owned-preset-'))
  writeFileSync(join(home, 'state.json'), state ?? JSON.stringify(TEAM))
  if (presetsFrom !== undefined) {
    mkdirSync(join(home, 'presets'), { recursive: true })
    for (const file of readdirSync(join(presetsFrom, 'presets'))) copyFileSync(join(presetsFrom, 'presets', file), join(home, 'presets', file))
  }
  const agentPresets = registryFixture()
  const ctx = fakeContext({ services: { agentPresets } })
  const created = []
  const agents = new Map()
  const agentOf = (id) => {
    if (!agents.has(id)) {
      const calls = []
      const held = []
      agents.set(id, {
        id,
        status: 'idle',
        session: { id, requestHeader: () => undefined },
        calls,
        inbox: { nextStep: [], nextTurn: held, remove(messageId) { const at = held.findIndex(message => message.id === messageId); if (at < 0) return false; held.splice(at, 1); return true } },
        followup(message) { calls.push(message); held.push(message) },
        cancel() {},
        whenIdle: async () => {},
      })
    }
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [] },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id } : undefined),
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async (request) => {
        created.push(request)
        return { sessionId: `new${created.length}` }
      },
      resolveAgent: async id => ({ agent: agentOf(id) }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  const stop = async () => {
    await ctx.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, ctx, home, created, agentPresets, agentOf, stop }
}

test('every Bot gets a unique preset file and every new Bot Session names it', async (t) => {
  const { rt, home, created, agentPresets, stop } = start()
  t.after(stop)
  await rt.load()
  await rt.ensureBotPresets()
  const one = await rt.createBot({ name: 'Writer', pickModel: true })
  const two = await rt.createBot({ name: 'Researcher', pickModel: true })
  assert.notEqual(one.agentPreset, two.agentPreset)
  assert.match(one.agentPreset, /^dsbot-bot-/)
  assert.equal(created[0].agentPreset, one.agentPreset)
  assert.equal(created[1].agentPreset, two.agentPreset)
  assert.ok(agentPresets.registered.has(one.agentPreset))
  assert.ok(agentPresets.registered.has(two.agentPreset))
  assert.ok(readdirSync(join(home, 'presets')).some(name => name.endsWith('.yaml')))
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.bots[one.id].agentPreset, one.agentPreset)
  assert.equal(saved.bots[two.id].agentPreset, two.agentPreset)
})

test('a new Bot can select any native DSH preset as its source', async (t) => {
  const { rt, agentPresets, stop } = start()
  t.after(stop)
  await rt.load()
  await rt.ensureBotPresets()
  const bot = await rt.createBot({ name: 'Reviewer', pickModel: true, agentPresetBase: 'ptc' })
  const view = await rt.presetView(rt.botOf(bot.id))
  assert.equal(view.base, 'ptc')
  assert.match(agentPresets.registered.get(bot.agentPreset).definition.plugins[0].name, /dsh-test-ptc/)
})

test('a fresh part of a working Bot uses the same owned preset', async (t) => {
  const { rt, created, agentOf, stop } = start()
  t.after(stop)
  await rt.load()
  await rt.ensureBotPresets()
  const bot = await rt.createBot({ name: 'Writer', pickModel: true })
  agentOf(bot.id).status = 'running'
  await rt.newPart(bot.id)
  assert.equal(created.at(-1).agentPreset, bot.agentPreset)
})

test('a copied Bot gets its own preset registration and file', async (t) => {
  const { rt, agentPresets, stop } = start()
  t.after(stop)
  await rt.load()
  await rt.ensureBotPresets()
  const original = await rt.createBot({ name: 'Writer', pickModel: true })
  const copy = await rt.duplicateBot(original.id)
  assert.notEqual(copy.agentPreset, original.agentPreset)
  assert.equal((await rt.presetView(rt.botOf(original.id))).base, 'standard')
  assert.equal((await rt.presetView(rt.botOf(copy.id))).base, 'standard')
  assert.notEqual(agentPresets.registered.get(original.agentPreset), agentPresets.registered.get(copy.agentPreset))
})

test('reloading the team recreates registered presets from the Bot files', async (t) => {
  const first = start()
  t.after(first.stop)
  await first.rt.load()
  await first.rt.ensureBotPresets()
  const bot = await first.rt.createBot({ name: 'Writer', pickModel: true })
  const presetId = bot.agentPreset
  const second = start({ state: readFileSync(join(first.home, 'state.json')), presetsFrom: first.home })
  t.after(second.stop)
  await second.rt.load()
  await second.rt.ensureBotPresets()
  assert.ok(second.agentPresets.registered.has(presetId))
})

test('deleting a Bot refuses to leave an orphaned preset registration or file', async (t) => {
  const { rt, home, agentPresets, stop } = start()
  t.after(stop)
  await rt.load()
  await rt.ensureBotPresets()
  const bot = await rt.createBot({ name: 'Writer', pickModel: true })
  const presetId = bot.agentPreset
  const folder = join(home, 'presets')
  assert.ok(existsSync(folder))
  await rt.deleteBotPreset(bot)
  assert.equal(agentPresets.registered.has(presetId), false)
  assert.ok(agentPresets.disposed.includes(presetId))
})

test('a group own Session uses the relay preset while its member Bots keep their own', async (t) => {
  const { rt, created, agentPresets, stop } = start()
  t.after(stop)
  await rt.load()
  await rt.ensureBotPresets()
  const one = await rt.createBot({ name: 'Developer', pickModel: true })
  const two = await rt.createBot({ name: 'Reviewer', pickModel: true })
  const room = await rt.createRoom({ members: [one.id, two.id], name: 'Build' })
  assert.equal(created.at(-1).agentPreset, 'dsbot-group-relay')
  assert.ok(agentPresets.registered.has('dsbot-group-relay'))
  // A user message opens a round. The first member Session it creates must carry that
  // member Bot's own preset, never the relay preset the group Session itself uses.
  rt.roomInbox.set(room.id, [{ text: '@Developer review the build' }])
  const relay = rt.teamTools.find(tool => tool.name === 'group_relay')
  const abort = new AbortController()
  const pending = relay.execute({}, { agent: { id: room.id }, callId: 'preset-round', signal: abort.signal }).catch(() => {})
  const until = Date.now() + 2000
  while (!created.some(request => request.agentPreset === one.agentPreset) && Date.now() < until) {
    await new Promise(resolve => setImmediate(resolve))
  }
  abort.abort()
  await pending
  const memberRequest = created.find(request => request.agentPreset === one.agentPreset)
  assert.ok(memberRequest, 'the group member Session names its own Bot preset')
  assert.equal(memberRequest.agentPreset, one.agentPreset)
  assert.notEqual(memberRequest.agentPreset, 'dsbot-group-relay')
  assert.ok(room.members.includes(one.id))
  await rt.stopRoomWork(room.id).catch(() => {})
  await new Promise(resolve => setImmediate(resolve))
})
