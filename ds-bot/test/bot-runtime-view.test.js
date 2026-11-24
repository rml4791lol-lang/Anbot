import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectiveExtensions, observeBotRuntime } from '../src/host/bot-runtime-view.js'

const observation = (value, at = 10) => ({ status: 'observed', value, at, source: 'test' })

function runtime({ capabilities, agent }) {
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: () => agent }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
      return undefined
    },
  }
  return {
    ctx,
    botOf: () => ({ id: 'chief' }),
    chatOf: () => 'session-1',
    isLocalAgentRoute: () => false,
    isLocalAgentSession: () => false,
    contextBudgetOf: async () => null,
    observeSessionCapabilities: async () => capabilities,
    interruptedTurnState: () => null,
    redactSecrets: value => value,
  }
}

test('effective extensions preserve typed observations and conservative availability', () => {
  const skills = [{
    name: 'review',
    kind: 'skill',
    status: 'ready',
    observations: { bodyLoadable: observation(true) },
  }]
  const mcp = [{
    name: 'echo',
    kind: 'mcp',
    status: 'unobserved',
    reason: 'No transport lifecycle observation is available.',
    observations: { liveness: { status: 'unavailable', reason: 'No transport lifecycle observation is available.', source: 'mcp-transport' } },
  }, {
    name: 'local',
    kind: 'mcp',
    status: 'needs-approval',
    observations: { authorization: observation('approval-required') },
  }]
  const extensions = effectiveExtensions({ status: 'observed', observedAt: 10, skills, mcp })
  assert.deepEqual(extensions.map(item => [item.id, item.kind, item.availability.status]), [
    ['review', 'skill', 'observed'],
    ['echo', 'mcp', 'unavailable'],
    ['local', 'mcp', 'observed'],
  ])
  assert.equal(extensions[0].availability.value, 'loaded')
  assert.equal(extensions[1].availability.reason, 'No transport lifecycle observation is available.')
  assert.equal(extensions[2].availability.value, 'approval-required')
  assert.equal(extensions[0].observations, skills[0].observations)
})

test('bot runtime returns the Session capability observations as effective extensions', async () => {
  const session = { id: 'session-1', snapshotEvents: () => [], inheritedEventCount: 0 }
  const agent = { session, model: { current: () => ({ provider: 'native', model: 'model' }) }, ctx: {} }
  const capabilities = {
    status: 'observed',
    catalogObserved: true,
    observedAt: 20,
    skills: [],
    mcp: [{ name: 'echo', kind: 'mcp', status: 'unobserved', observations: { initialConnected: observation(true, 20) } }],
  }
  const view = await observeBotRuntime(runtime({ capabilities, agent }), 'chief', 'session-1')
  assert.equal(view.status, 'observed')
  assert.equal(view.capabilities, capabilities)
  assert.equal(view.extensions.length, 1)
  assert.equal(view.extensions[0].observations.initialConnected.value, true)
  assert.equal(view.extensions[0].availability.status, 'unavailable')
})

test('failed capability observation is explicit and yields no effective extensions', async () => {
  const session = { id: 'session-1', snapshotEvents: () => [], inheritedEventCount: 0 }
  const agent = { session, model: { current: () => ({ provider: 'native', model: 'model' }) }, ctx: {} }
  const rt = runtime({ capabilities: null, agent })
  rt.observeSessionCapabilities = async () => { throw new Error('catalog unavailable') }
  const view = await observeBotRuntime(rt, 'chief', 'session-1')
  assert.equal(view.capabilities.status, 'unavailable')
  assert.equal(view.capabilities.reason, 'catalog unavailable')
  assert.deepEqual(view.extensions, [])
})
