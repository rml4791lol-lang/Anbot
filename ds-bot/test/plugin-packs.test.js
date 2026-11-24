import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, PACKS } from '../src/host/plugin-packs.js'

const bundle = (name, enabled, extra = {}) => ({
  name, enabled, installed: true, availability: 'profile', official: false,
  optional: false, removable: true, rows: [], overrides: [], ...extra,
})

function fixture(initial = [], { failSet = new Set(), failInstall = new Set() } = {}) {
  const rows = new Map(initial.map(row => [row.name, { ...row }]))
  const calls = []
  return {
    rows,
    calls,
    manager: {
      async listBundles() { return [...rows.values()].map(row => ({ ...row })) },
      async setBundleEnabled(name, enabled) {
        calls.push(['set', name, enabled])
        if (failSet.has(name)) return { changed: false, application: 'failed', stage: 'enable', target: name, enabled, error: { code: 'operation-error', message: `${name} refused` } }
        const row = rows.get(name)
        if (row === undefined) throw new Error(`unknown bundle ${name}`)
        row.enabled = enabled
        return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
      },
      async installBundle(spec, options) {
        calls.push(['install', spec, options])
        const name = spec
        if (failInstall.has(name)) return { changed: false, application: 'failed', stage: 'install', target: spec, enabled: options?.enabled ?? false, error: { code: 'operation-error', message: `${name} refused` } }
        rows.set(name, bundle(name, options?.enabled ?? false, { availability: 'profile' }))
        return { changed: true, application: 'restart-required', stage: 'install', target: spec, bundle: name, enabled: options?.enabled ?? false, version: '1.0.0' }
      },
    },
  }
}

function runtime(manager, { save, state = { prefs: {} } } = {}) {
  const saves = []
  const rt = {
    state,
    readOnly: () => undefined,
    warn() {},
    save: save ?? (async options => { saves.push(options) }),
    ctx: { get: name => name === 'pluginManager' ? manager : undefined },
  }
  install(rt)
  rt.saves = saves
  return rt
}

test('the catalog covers the requested integration families', () => {
  const ids = new Set(PACKS.map(pack => pack.id))
  for (const id of ['forge', 'worktree', 'session-search', 'super-code', 'billion-context', 'mnemon', 'genui', 'media', 'qq-onebot']) {
    assert.equal(ids.has(id), true, id)
  }
})

test('the native bundle state is mapped to installed, enabled, disabled, missing and error', async () => {
  const { manager } = fixture([
    bundle('@deepseek-ai/dsh-experimental-forge-bundle', true),
    bundle('@deepseek-ai/dsh-experimental-tool-worktree', false),
    bundle('dsh-media', true, { error: { code: 'incompatible-version', message: 'needs a newer DSH' } }),
  ])
  const rt = runtime(manager)
  const view = await rt.pluginPackEndpoint('plugin-packs', {})
  const rows = Object.fromEntries(view.packs.map(pack => [pack.id, pack]))
  assert.equal(view.available, true)
  assert.equal(rows.forge.status, 'enabled')
  assert.equal(rows.worktree.status, 'disabled')
  assert.equal(rows.media.status, 'error')
  assert.match(rows.media.error, /newer DSH/)
  assert.equal(rows['session-search'].status, 'missing')
})

test('enabling an installed pack delegates every bundle to DSH pluginManager', async () => {
  const env = fixture([bundle('@deepseek-ai/dsh-experimental-tool-worktree', false)])
  const rt = runtime(env.manager)
  await rt.pluginPackEndpoint('plugin-packs', {})
  const view = await rt.pluginPackEndpoint('plugin-pack-set', { id: 'worktree', enabled: true })
  assert.deepEqual(env.calls, [['set', '@deepseek-ai/dsh-experimental-tool-worktree', true]])
  assert.equal(view.packs.find(pack => pack.id === 'worktree').status, 'enabled')
})

test('a missing pack installs through DSH and comes back enabled', async () => {
  const env = fixture([])
  const rt = runtime(env.manager)
  const view = await rt.pluginPackEndpoint('plugin-pack-install', { id: 'media' })
  assert.deepEqual(env.calls, [['install', 'dsh-media', { enabled: true }]])
  assert.equal(view.packs.find(pack => pack.id === 'media').status, 'enabled')
  assert.equal(view.lastChange.application, 'restart-required')
})

test('only one engine in an exclusive group can be enabled', async () => {
  const env = fixture([
    bundle('dsh-super-code', true),
    bundle('@deepseek-ai/dsh-experimental-ralph-bundle', false),
  ])
  const rt = runtime(env.manager)
  await rt.pluginPackEndpoint('plugin-packs', {})
  await assert.rejects(
    rt.pluginPackEndpoint('plugin-pack-set', { id: 'ralph', enabled: true }),
    /super-code.*engine|engine.*super-code/i,
  )
  assert.deepEqual(env.calls, [])
})

test('compression and memory authorities cannot be switched by a pack toggle', async () => {
  const env = fixture([bundle('billion-context', false), bundle('dsh-mnemon', false)])
  const rt = runtime(env.manager)
  await assert.rejects(rt.pluginPackEndpoint('plugin-pack-set', { id: 'billion-context', enabled: true }), /compression authority/i)
  await assert.rejects(rt.pluginPackEndpoint('plugin-pack-set', { id: 'mnemon', enabled: true }), /memory authority/i)
  assert.deepEqual(env.calls, [])
})

test('without DSH pluginManager the catalog is visible but unavailable', async () => {
  const rt = runtime(undefined)
  const view = await rt.pluginPackEndpoint('plugin-packs', {})
  assert.equal(view.available, false)
  assert.ok(view.packs.length > 0)
  assert.equal(view.packs.every(pack => pack.status === 'unavailable'), true)
})

test('the authority view reports the selected implementation and every option status', async () => {
  const env = fixture([bundle('billion-context', false), bundle('dsh-mnemon', true), bundle('@openviking/dsh-memory-plugin', false)])
  const rt = runtime(env.manager)
  const view = await rt.pluginPackEndpoint('plugin-packs', {})
  assert.equal(view.authorities.compression.selected, 'steward')
  assert.equal(view.authorities.compression.options.find(option => option.id === 'bili').status, 'disabled')
  assert.equal(view.authorities.memory.selected, 'dsbot')
  assert.equal(view.authorities.memory.options.find(option => option.id === 'mnemon').status, 'enabled')
  assert.equal(view.authorities.computer.selected, 'dsbot')
})

test('switching compression to Billion Context persists the one authority through the native manager', async () => {
  const env = fixture([bundle('billion-context', false)])
  const rt = runtime(env.manager)
  const view = await rt.pluginPackEndpoint('plugin-pack-authority', { authority: 'compression', id: 'bili' })
  assert.deepEqual(env.calls, [['set', 'billion-context', true]])
  assert.equal(view.authorities.compression.selected, 'bili')
  assert.equal(rt.compressionAuthority(), 'bili')
  assert.equal(rt.state.prefs.pluginPackAuthorities.compression, 'bili')
  assert.deepEqual(rt.saves, [{ required: true }])
})

test('switching memory disables the old provider before enabling the new one', async () => {
  const env = fixture([bundle('dsh-mnemon', true), bundle('@openviking/dsh-memory-plugin', false)])
  const rt = runtime(env.manager)
  let resynced = 0
  rt.resyncTeamTools = () => { resynced += 1 }
  const view = await rt.pluginPackEndpoint('plugin-pack-authority', { authority: 'memory', id: 'openviking' })
  assert.deepEqual(env.calls, [
    ['set', 'dsh-mnemon', false],
    ['set', '@openviking/dsh-memory-plugin', true],
  ])
  assert.equal(view.authorities.memory.selected, 'openviking')
  assert.equal(view.packs.find(pack => pack.id === 'mnemon').status, 'disabled')
  assert.equal(view.packs.find(pack => pack.id === 'openviking').status, 'enabled')
  assert.equal(rt.memoryAuthority(), 'openviking')
  assert.equal(resynced, 1)
})

test('a failed authority switch restores the previous provider and leaves the preference unchanged', async () => {
  const env = fixture([bundle('dsh-mnemon', true), bundle('@openviking/dsh-memory-plugin', false)], { failSet: new Set(['@openviking/dsh-memory-plugin']) })
  const rt = runtime(env.manager)
  await assert.rejects(rt.pluginPackEndpoint('plugin-pack-authority', { authority: 'memory', id: 'openviking' }), /refused/)
  assert.deepEqual(env.calls, [
    ['set', 'dsh-mnemon', false],
    ['set', '@openviking/dsh-memory-plugin', true],
    ['set', 'dsh-mnemon', true],
  ])
  assert.equal(env.rows.get('dsh-mnemon').enabled, true)
  assert.equal(env.rows.get('@openviking/dsh-memory-plugin').enabled, false)
  assert.equal(rt.state.prefs.pluginPackAuthorities?.memory, undefined)
})

test('a failed preference save rolls the native authority selection back', async () => {
  const env = fixture([bundle('dsh-mnemon', true), bundle('@openviking/dsh-memory-plugin', false)])
  const rt = runtime(env.manager, { save: async () => { throw new Error('disk full') } })
  await assert.rejects(rt.pluginPackEndpoint('plugin-pack-authority', { authority: 'memory', id: 'openviking' }), /disk full/)
  assert.equal(env.rows.get('dsh-mnemon').enabled, true)
  assert.equal(env.rows.get('@openviking/dsh-memory-plugin').enabled, false)
  assert.equal(rt.state.prefs.pluginPackAuthorities?.memory, undefined)
})

test('returning memory to DS Bot disables the alternative and clears the stored override', async () => {
  const state = { prefs: { pluginPackAuthorities: { memory: 'mnemon' } } }
  const env = fixture([bundle('dsh-mnemon', true)])
  const rt = runtime(env.manager, { state })
  const view = await rt.pluginPackEndpoint('plugin-pack-authority', { authority: 'memory', id: 'dsbot' })
  assert.deepEqual(env.calls, [['set', 'dsh-mnemon', false]])
  assert.equal(view.authorities.memory.selected, 'dsbot')
  assert.equal(Object.hasOwn(state.prefs.pluginPackAuthorities, 'memory'), false)
})
