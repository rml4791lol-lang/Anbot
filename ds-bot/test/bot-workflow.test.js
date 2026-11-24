import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/bot-workflow.js'

function fixture({ engine = true, savedBot } = {}) {
  const events = []
  const request = []
  const close = []
  const lifecycle = Promise.withResolvers()
  const run = {
    id: 'native-run', result: lifecycle.promise,
    dispose: async () => { close.push('dispose') },
  }
  const agent = { session: { id: 'working-session', snapshotEvents: () => events } }
  const preset = { serviceFor: (actual, name) => actual === agent && name === 'workflowEngine' && engine ? {
    start: (options) => { request.push(options); return run },
  } : undefined }
  let cleanup
  const bot = savedBot ?? { id: 'bot' }
  const rt = {
    ctx: { get: name => name === 'agentPresets' ? preset : undefined, effect: effect => { cleanup = effect() } },
    botOf: id => id === 'bot' ? bot : undefined,
    save: async () => {},
    chatOf: () => agent.session.id,
    resolveAgent: async () => agent,
    warn() {},
  }
  install(rt)
  return { rt, agent, bot, events, request, close, lifecycle, cleanup }
}

test('the workflow binds to its Bot Session and receives evidence counts from events only', async () => {
  const { rt, agent, events, request, close, lifecycle, cleanup } = fixture()
  events.push({ type: 'assistant/message', seq: 7, data: { message: { content: [{ type: 'text', text: 'I verified it' }] } } })
  const record = await rt.startBotWorkflow('bot')
  assert.deepEqual(record, { botId: 'bot', sessionId: agent.session.id, runId: 'native-run', throughSequence: 7, status: 'running' })
  assert.equal(request[0].parent, agent)
  assert.deepEqual(request[0].args, [])
  await assert.rejects(rt.startBotWorkflow('bot'), /already running/)
  lifecycle.resolve({ stopReason: 'completed', value: { commands: 0, failures: 0, diffs: 0, deliverables: 0 }, agentsStarted: 0 })
  await cleanup()
  assert.equal(rt.botWorkflowView('bot').status, 'completed')
  assert.deepEqual(rt.botWorkflowView('bot').result, { commands: 0, failures: 0, diffs: 0, deliverables: 0 })
  assert.deepEqual(close, ['dispose'])
})

test('cancellation waits for the native result and one disposal', async () => {
  const { rt, request, close, lifecycle, cleanup } = fixture()
  await rt.startBotWorkflow('bot')
  const first = rt.cancelBotWorkflow('bot', 'native-run')
  assert.equal(request[0].signal.aborted, true)
  assert.equal(rt.botWorkflowView('bot').status, 'cancelling')
  lifecycle.resolve({ stopReason: 'cancelled', error: 'User cancellation', agentsStarted: 0 })
  assert.equal((await first).status, 'cancelled')
  await cleanup()
  assert.deepEqual(close, ['dispose'])
})

test('a missing native service produces an actionable error for that Bot', async () => {
  const { rt } = fixture({ engine: false })
  await assert.rejects(rt.startBotWorkflow('missing'), /unknown bot/i)
  await assert.rejects(rt.startBotWorkflow('bot'), /DSH Agent preset/)
  assert.equal(rt.botWorkflowView('bot').status, 'error')
})


test('terminal Workflow evidence survives a fresh host with the same Bot record', async () => {
  const first = fixture()
  const started = await first.rt.startBotWorkflow('bot')
  const result = { commands: 1, failures: 0, diffs: 1, deliverables: 0 }
  first.lifecycle.resolve({ stopReason: 'completed', value: result })
  await first.cleanup()
  const restarted = fixture({ savedBot: JSON.parse(JSON.stringify(first.bot)) })
  assert.deepEqual(restarted.rt.botWorkflowView('bot'), { ...started, status: 'completed', result })
  assert.equal(restarted.request.length, 0)
})

test('a workflow still running at process loss is shown as interrupted without dispatching it again', async () => {
  const first = fixture()
  const started = await first.rt.startBotWorkflow('bot')
  const restarted = fixture({ savedBot: JSON.parse(JSON.stringify(first.bot)) })
  const interrupted = restarted.rt.botWorkflowView('bot')
  assert.equal(interrupted?.status, 'interrupted')
  assert.equal(interrupted?.runId, started.runId)
  assert.equal(restarted.request.length, 0)
  first.lifecycle.resolve({ stopReason: 'cancelled' })
  await first.cleanup()
})
