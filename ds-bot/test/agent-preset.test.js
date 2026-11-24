import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import * as repeatReminder from '@deepseek-ai/dsh-repeat-tool-reminder'
// Fei2411/DS-Bot#978: the real guard counts by tool name and canonical arguments;
// the group relay stream is synthesized, so that integration test does not need an LLM adapter.

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { createRuntime } from '../index.js'
import { engineeringPresets } from '../src/shared/engineering-presets.js'
import { fakeContext } from './fake-ctx.js'

// Fei2411/DS-Bot#37: under DSH Desktop's default PTC preset a model may call only
// run_code, so the group_relay call made for a group chat's Session was turned down
// and no group message reached its Bots.

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  revision: 1,
  whaleStored: true,
  bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 } },
  rooms: { room: { id: 'room', name: 'Desk', members: ['chief'], admin: 'chief', mode: 'everyone', sessions: {}, seq: 0, log: [] } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test('the ten professional recommendations are editable and use only bundled Skills', () => {
  assert.deepEqual(engineeringPresets.map(preset => preset.id), [
    'development-debug', 'review', 'ui-product', 'frontend', 'backend-db',
    'qa', 'project-coordination', 'local-agent-collaboration', 'docs-knowledge', 'self-maintenance',
  ])
  for (const preset of engineeringPresets) {
    for (const field of ['label', 'role', 'methods', 'plugin', 'localAgent', 'model', 'effort', 'workspace', 'permission', 'acceptance', 'output']) {
      assert.equal(typeof preset[field], 'string', `${preset.id}.${field}`)
      assert.ok(preset[field].trim().length > 0, `${preset.id}.${field}`)
    }
    assert.ok(preset.role.length <= 24, `${preset.id}.role fits the roster field`)
    assert.ok(Array.isArray(preset.skills), `${preset.id}.skills`)
    assert.ok(preset.instructions.includes(preset.acceptance), `${preset.id}.instructions acceptance`)
    assert.ok(preset.instructions.includes(preset.output), `${preset.id}.instructions output`)
    for (const skill of preset.skills) {
      assert.doesNotThrow(() => readFileSync(new URL(`../src/host/skills/${skill.name}/SKILL.md`, import.meta.url), 'utf8'), `${preset.id}: ${skill.name}`)
    }
  }
})

function start({ presets, registry, saved = TEAM, failSession = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-agent-preset-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  const services = registry !== undefined ? { agentPresets: registry }
    : presets === undefined ? {} : { agentPresets: { list: async () => presets } }
  const ctx = fakeContext({ services })
  const created = []
  const archived = []
  Object.assign(ctx, {
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id } : undefined),
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async id => { archived.push(id) },
    },
    sessionController: {
      create: async (request) => {
        created.push(request)
        return { sessionId: `new${created.length}` }
      },
      resolveAgent: async id => failSession ? { error: { message: 'Agent startup failed' } } : { agent: { id, session: { id } } },
    },
    sessionTitle: { rename: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  const relay = ctx.listeners.get('llm/stream').find(listener => /relayOrPass/.test(String(listener)))
  const warnings = []
  const warn = rt.warn
  rt.warn = (...args) => { warnings.push(format(...args)); return warn(...args) }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, created, archived, relay, warnings, stop, home }
}

async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const userText = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const declared = (...names) => names.map(name => ({ name, description: '', parameters: {} }))
const relayCall = async (relay, tools) => {
  const chunks = await drain(relay({ provider: 'deepseek', model: 'v4', sessionId: 'room', messages: [userText('Hello team')], tools }, () => {
    throw new Error('a group round never reaches the model')
  }))
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  return chunks.find(chunk => chunk.type === 'block-end').block
}

test('a new Bot Session is made with the standard preset when DSH serves it', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'ptc' }, { id: 'standard' }] })
  t.after(stop)
  await rt.load()
  await rt.createSession('Chief')
  assert.deepEqual(created, [{ workspaceId: 'w1', agentPreset: 'standard' }])
})

test('without a usable standard preset a Bot Session keeps DSH\'s default', async (t) => {
  for (const presets of [undefined, [{ id: 'ptc' }], [{ id: 'standard', broken: 'failed to start' }]]) {
    const { rt, created, stop } = start({ presets })
    t.after(stop)
    await rt.load()
    await rt.createSession('Chief')
    assert.deepEqual(created, [{ workspaceId: 'w1' }])
  }
})

test('a Bot binds the requested native preset without changing the relay default', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'standard' }, { id: 'minimal', name: 'Minimal' }] })
  t.after(stop)
  await rt.load()
  const bot = await rt.createBot({ name: 'Reviewer', agentPreset: 'minimal', pickModel: true })
  assert.equal(bot.agentPreset, 'minimal')
  assert.equal(rt.state.bots[bot.id].agentPreset, 'minimal')
  await rt.createSession('Reviewer · fresh', { agentPreset: bot.agentPreset })
  await rt.createSession('Group relay')
  assert.deepEqual(created.map(request => request.agentPreset), ['minimal', 'minimal', 'standard'])
})

test('an explicit missing or broken preset refuses to create a Session', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'standard' }, { id: 'broken', broken: 'failed to start' }] })
  t.after(stop)
  await rt.load()
  for (const agentPreset of ['missing', 'broken', {}]) {
    await assert.rejects(rt.createBot({ name: 'Reviewer', agentPreset, pickModel: true }), /preset/i)
  }
  assert.equal(created.length, 0)
  assert.equal(Object.values(rt.state.bots).some(bot => bot.name === 'Reviewer'), false)
})

test('a failed Agent startup archives its new Session and releases its preset', async (t) => {
  const active = new Set()
  const registry = {
    list: async () => ['standard', 'ptc', ...active].map(id => ({ id })),
    readDocument: async () => ({ content: '[]' }),
    register: async ({ id }) => {
      active.add(id)
      return () => active.delete(id)
    },
  }
  const { rt, created, archived, stop } = start({ registry, failSession: true })
  t.after(stop)
  await rt.load()
  await assert.rejects(rt.createBot({ name: 'Reviewer', agentPreset: 'ptc', pickModel: true }), /Agent startup failed/u)
  assert.equal(created.length, 1)
  assert.deepEqual(archived, ['new1'])
  assert.equal(active.size, 0)
  assert.equal(Object.keys(rt.state.bots).length, 1)
})

test('an owned preset is recreated on restart without persisting its plugin configuration', async (t) => {
  const content = '- name: fixture-plugin\n  config: { localValue: fixture-only }'
  const registry = (source = content) => {
    const active = new Map()
    return {
      active,
      list: async () => [{ id: 'standard' }, { id: 'ptc' }, ...active.values()],
      readDocument: async () => ({ content: source }),
      register: async definition => {
        active.set(definition.id, definition)
        return () => active.delete(definition.id)
      },
    }
  }
  const first = registry()
  const one = start({ registry: first })
  t.after(one.stop)
  await one.rt.load()
  const bot = await one.rt.createBot({ name: 'Reviewer', agentPreset: 'ptc', pickModel: true })
  assert.equal(bot.agentPreset, 'ptc')
  assert.match(bot.presetBinding.id, /^anbot-preset-/u)
  assert.equal(one.created[0].agentPreset, bot.presetBinding.id)
  const raw = readFileSync(join(one.home, 'state.json'), 'utf8')
  assert.doesNotMatch(raw, /fixture-only/u)
  const saved = JSON.parse(raw)
  const second = registry()
  const two = start({ registry: second, saved })
  t.after(two.stop)
  await two.rt.load()
  assert.equal(second.active.get(bot.presetBinding.id)?.plugins[0].name, 'fixture-plugin')
  const third = registry('- name: changed-plugin')
  const three = start({ registry: third, saved })
  t.after(three.stop)
  await three.rt.load()
  assert.equal(third.active.size, 0)
  await assert.rejects(three.rt.ensureBotPreset(bot.presetBinding), /changed/u)
  await assert.rejects(three.rt.resolveAgent(three.rt.chatOf(bot.id)), /preset ptc changed/u)
})

test('a group round calls group_relay directly when the Session declares it', async (t) => {
  const { relay, stop } = start()
  t.after(stop)
  const rounds = []
  for (const tools of [declared('read', 'group_relay'), declared('run_code', 'group_relay'), declared('group_relay')]) {
    const block = await relayCall(relay, tools)
    assert.equal(block.name, 'group_relay')
    rounds.push(JSON.parse(block.arguments))
  }
  for (const args of rounds) {
    assert.match(args.roundId, /^\d+-[0-9a-f-]{36}$/)
    assert.deepEqual(validateJsonSchemaValue({ type: 'object', properties: { roundId: { type: 'string' } } }, args), [])
  }
  assert.equal(new Set(rounds.map(args => args.roundId)).size, rounds.length)
})

const runPtc = async block => {
  const args = JSON.parse(block.arguments)
  let inner
  const value = await Function('tools', `return (async () => { ${args.code} })()`)({ group_relay: async input => { inner = input; return input } })
  return { args, inner, value }
}

test('a group made under the PTC preset changes the run_code and inner relay arguments every round', async (t) => {
  const { relay, stop } = start()
  t.after(stop)
  const blocks = [await relayCall(relay, declared('run_code')), await relayCall(relay, declared('run_code'))]
  for (const block of blocks) {
    assert.equal(block.name, 'run_code')
    const { args, inner, value } = await runPtc(block)
    const roundId = args.description.match(/^Relay the group chat to its Bots \((\d+-[0-9a-f-]{36})\)$/)?.[1]
    assert.ok(roundId)
    assert.equal(args.code, `return await tools.group_relay({ roundId: ${JSON.stringify(roundId)} })`)
    assert.equal(args.timeoutMs, 600_000)
    assert.deepEqual(value, { roundId })
    assert.deepEqual(inner, { roundId })
  }
  assert.notEqual(blocks[0].arguments, blocks[1].arguments)
})

test('a legacy round without roundId returns the same result as a new one', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  await rt.load()
  const tool = rt.teamTools.find(def => def.name === 'group_relay')
  assert.deepEqual(validateJsonSchemaValue(tool.parameters, {}), [])
  const exec = { agent: { id: 'room' }, callId: 'legacy', signal: AbortSignal.abort() }
  // Each call names where its rows start in the group's book; the rest of the result is the same.
  const rest = (value) => {
    const { from, anchor, ...others } = JSON.parse(value)
    assert.ok(Number.isInteger(from) && typeof anchor === 'string')
    return others
  }
  const legacy = rest(await tool.execute({}, exec))
  const current = rest(await tool.execute({ roundId: `${Date.now()}-legacy` }, { ...exec, callId: 'current' }))
  assert.deepEqual(current, legacy)
  assert.deepEqual(current, {})
})

test('nine consecutive synthesized calls add no repeat-tool reminder', async (t) => {
  const { relay, stop } = start()
  t.after(stop)
  const listeners = []
  repeatReminder.apply({ on: (name, listener) => listeners.push([name, listener]) }, {
    thresholds: [3, 5, 8], include: [], exclude: [], argumentsPreviewChars: 500,
  })
  const observe = listeners.find(([name]) => name === 'tools/post-execute')[1]
  const agent = { id: 'room' }
  for (const tools of [declared('group_relay'), declared('run_code')]) {
    for (let round = 0; round < 9; round += 1) {
      const block = await relayCall(relay, tools)
      const args = JSON.parse(block.arguments)
      const exec = { name: block.name, arguments: args, agent }
      if (block.name === 'run_code') {
        const { inner } = await runPtc(block)
        exec.name = 'group_relay'
        exec.arguments = inner
        const nested = await observe(exec, {}, async () => ({ kind: 'continue' }))
        assert.equal(nested.additionalContexts, undefined, 'the inner relay stays distinct across varying run_code calls')
      }
      const decision = await observe(exec, {}, async () => ({ kind: 'continue' }))
      assert.equal(decision.additionalContexts, undefined)
    }
  }
})

test('a group Session without either relay tool ends visibly instead of calling nothing', async (t) => {
  // #826: the relay used to synthesize group_relay even when the Session did not
  // declare it, and the "unknown tool" failure left no trace.
  const { relay, warnings, stop } = start()
  t.after(stop)
  const chunks = await drain(relay({ provider: 'deepseek', model: 'v4', sessionId: 'room', messages: [userText('Hello team')], tools: declared('read', 'write') }, () => {
    throw new Error('a group round never reaches the model')
  }))
  assert.ok(!chunks.some(chunk => chunk.type === 'tool-call-delta' || chunk.block?.type === 'tool-call'))
  const text = chunks.find(chunk => chunk.type === 'text-delta')?.text
  assert.match(text ?? '', /relay tool is not available/)
  assert.equal(chunks.find(chunk => chunk.type === 'block-end')?.block?.type, 'text')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.ok(warnings.some(line => line.includes('cannot relay')))
})
