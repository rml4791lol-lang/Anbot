// A task handed to a Bot that is already working waits for the running turn to
// end and is read in a turn of its own. It is never inserted into the turn that
// was under way when it arrived (R59: queue means "after its current work").
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))
const TEAM = ['message_bot', 'approve_agent_action']

function makeAdapter() {
  return new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'fake', name: 'Fake ACP', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: (kind, route, spec) => new AcpEngine(route, { ...spec, command: process.execPath, args: [FIXTURE] }, { findExecutable: path => path }),
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => mkdtempSync(join(tmpdir(), 'dsb-cwd-')),
    probeCwd: () => mkdtempSync(join(tmpdir(), 'dsb-probe-')),
    toolsFor: options => (options.tools ?? []).filter(tool => TEAM.includes(tool.name)),
  })
}

async function boot() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const adapter = makeAdapter()
  ctx.llm.registerAdapter(['local-acp-fake'], adapter)
  await mountAgentLoopTestHarness(ctx)
  const agent = await ctx.agentLoop.create(SessionId('s1'), { provider: 'local-acp-fake', model: 'default' })
  return { ctx, agent, adapter }
}

const send = (agent, text) => agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))

function waitForIdle(ctx, agent) {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

const answers = agent => agent.session.snapshotEvents()
  .filter(event => event.type === 'assistant/message')
  .map(event => (event.data.message.content ?? []).map(block => block.text ?? '').join(''))

test('a task sent during a running turn is read in the next turn, not inserted into it', async (t) => {
  const gate = mkdtempSync(join(tmpdir(), 'dsb-gate-'))
  process.env.FAKE_ACP_GATE = gate
  const { ctx, agent, adapter } = await boot()
  t.after(async () => { await adapter.dispose(); await ctx.fiber.dispose(); delete process.env.FAKE_ACP_GATE })

  send(agent, 'warm up')
  await waitForIdle(ctx, agent)

  // Turn two starts before the second task is sent, so the task really arrives
  // while that turn is running.
  const secondTurnStarted = new Promise((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      const turns = agent.session.snapshotEvents().filter(entry => entry.type === 'turn/start').length
      if (event.type !== 'step/start' || turns < 2) return
      dispose(); resolve()
    })
  })
  send(agent, 'wait-gate first')
  await secondTurnStarted
  send(agent, 'second task')

  // Queued, not claimed: the running turn cannot see it.
  assert.equal(agent.inbox.nextTurn.length, 1)
  assert.equal(agent.inbox.nextStep.length, 0)

  writeFileSync(join(gate, 'open'), '')
  await waitForIdle(ctx, agent)

  const turns = agent.session.snapshotEvents().filter(event => event.type === 'turn/start')
  assert.equal(turns.length, 3, 'warm up, the gated turn, the queued task')
  const said = answers(agent)
  assert.equal(said.length, 3)
  assert.match(said[1], /ok: wait-gate first/)
  assert.doesNotMatch(said[1], /second task/, 'the running turn must not read the queued task')
  assert.match(said[2], /ok: second task/, 'the queued task is read in its own turn')
})

test('the same hand-over without wakeup leaves the message parked on an idle Bot', async (t) => {
  const { ctx, agent, adapter } = await boot()
  t.after(async () => { await adapter.dispose(); await ctx.fiber.dispose() })
  let turns = 0
  const stop = ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'turn/start') turns += 1
  })
  t.after(() => stop())
  agent.send(createUserMessage({ content: [{ type: 'text', text: 'parked task' }], source: { kind: 'user' } }), 'next-turn', false)
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(turns, 0, 'no turn starts without a wakeup')
  assert.equal(agent.inbox.nextTurn.length, 1, 'the message is still queued')
})
