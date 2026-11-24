import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as dshSession from '@deepseek-ai/dsh-session'
import { createModelRetry } from '../src/host/model-retry.js'

const original = { provider: 'retry-test', model: 'original' }
const alternate = { provider: 'retry-test', model: 'alternate' }
const manual = { provider: 'retry-test', model: 'manual' }
const models = [original, alternate, manual].map(({ provider, model }) => ({ provider, id: model, ref: provider + '/' + model }))
const request = { sessionId: 'retry', turn: 1, model: models[1].ref }
const prompt = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const nativeRetry = { skip: typeof dshSession.appendPluginRecord !== 'function' && 'Runtime predates native Session plugin records' }

async function fixture(t, { install = true } = {}) {
  const ctx = new Context()
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const calls = []
  let fail = true
  t.after(async () => { release.resolve(); await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } } }
    async *stream(input) {
      calls.push(input.model)
      if (fail) { fail = false; throw new Error('fixture reports a failed request') }
      if (input.model === alternate.model) { started.resolve(); await release.promise }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Finished' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Finished' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter([original.provider], new Adapter())
  await mountAgentLoopTestHarness(ctx)
  const bot = { id: 'bot', model: models[0].ref }
  const rt = {
    ctx, state: { exchangeTurns: {} }, readOnly: () => undefined,
    chatOf: () => 'retry', botOf: id => id === bot.id ? bot : undefined, catalog: async () => models,
    workspaceHold: { heldFor: async () => false, assertUnheld: () => {} },
    warn: (...args) => assert.fail(args.join(' ')),
  }
  const retry = install ? createModelRetry(rt) : undefined
  const agent = await ctx.agentLoop.create(dshSession.SessionId('retry'), original)
  rt.resolveAgent = async () => agent
  agent.followup(prompt('Original question'))
  await agent.whenIdle()
  assert.equal(agent.session.snapshotEvents().at(-1).data.reason.kind, 'error')
  return { rt, retry, bot, agent, calls, started, release }
}

test('a native retry uses the explicitly selected model for one turn and preserves the queued turn model', nativeRetry, async (t) => {
  const { retry, agent, bot, calls, started, release } = await fixture(t)
  await retry(bot, request)
  await started.promise
  await assert.rejects(retry(bot, request), { code: 'bot/busy' })
  agent.followup(prompt('Next question'))
  release.resolve()
  await agent.whenIdle()
  assert.deepEqual(calls, ['original', 'alternate', 'original'])
  assert.deepEqual(agent.model.current(), original)
  assert.equal(bot.model, models[0].ref)
  const users = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
  assert.equal(users.filter(event => event.data.content?.some(block => block.text === 'Original question')).length, 1)
  await assert.rejects(retry(bot, request), { code: 'bot/stale' })
})

test('restoring a native retry respects a later model selection and rejects a held workspace', nativeRetry, async (t) => {
  const { rt, retry, agent, bot, started, release } = await fixture(t)
  rt.workspaceHold.heldFor = async () => true
  await assert.rejects(retry(bot, request), { code: 'bot/busy' })
  rt.workspaceHold.heldFor = async () => false
  await retry(bot, request)
  await started.promise
  agent.model.select(manual)
  release.resolve()
  await agent.whenIdle()
  assert.deepEqual(agent.model.current(), manual)
})

test('recovery restores a persisted temporary selection when attaching to an idle Session', nativeRetry, async (t) => {
  const { rt, agent } = await fixture(t, { install: false })
  dshSession.appendPluginRecord(agent.session, 'plugin:anbot/model-retry', { sessionId: agent.id, turn: 2, original, selection: alternate })
  agent.model.select(alternate)
  createModelRetry(rt)
  assert.deepEqual(agent.model.current(), original)
})

test('a Bot can keep the temporary route by choosing it as its configured model during the retry', nativeRetry, async (t) => {
  const { retry, agent, bot, calls, started, release } = await fixture(t)
  await retry(bot, request)
  await started.promise
  bot.model = request.model
  agent.model.select(alternate)
  release.resolve()
  await agent.whenIdle()
  agent.followup(prompt('Next question'))
  await agent.whenIdle()
  assert.deepEqual(calls, ['original', 'alternate', 'alternate'])
})
