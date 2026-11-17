import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Product-level approval boundaries. Every side effect in these tests is a stub:
// no real git commit/push, deploy, mail send, payment, or review submission.

const FORBIDDEN_TEAM_TOOLS = [
  'git_commit',
  'git_push',
  'deploy',
  'appstore_submit',
  'submit_for_review',
  'submit_for_app_review',
]

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b',
      named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {},
    },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-approval-bound-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  await rt.load()
  return { ctx, rt }
}

test('DS-Bot does not register unguarded team tools for commit, push, deploy, or store review', async (t) => {
  const { rt } = await start(t)
  const names = rt.teamTools.map(tool => tool.name)
  for (const name of FORBIDDEN_TEAM_TOOLS) {
    assert.equal(names.includes(name), false, `unexpected team tool ${name}`)
  }
})

test('a group Session approval for git push stays pending and is not auto-allowed', async (t) => {
  const { ctx, rt } = await start(t)
  let nextCalls = 0
  const listeners = ctx.listeners.get('approval/request') ?? []
  assert.ok(listeners.length > 0, 'approval/request listener is installed')
  const pending = listeners[0]({
    agent: { session: { id: 'gb' } },
    toolName: 'bash',
    reason: 'git push origin main',
  }, () => {
    nextCalls += 1
    return 'allowed-once'
  })
  const open = rt.approvalsView()
  assert.equal(open.length, 1)
  assert.equal(open[0].tool, 'bash')
  assert.match(open[0].reason, /git push origin main/)
  assert.equal(nextCalls, 0)
  // Without a recorded user answer the request must not settle.
  const raced = await Promise.race([
    pending.then(outcome => ({ settled: true, outcome })),
    new Promise(resolve => setTimeout(() => resolve({ settled: false }), 50)),
  ])
  assert.equal(raced.settled, false)
  assert.equal(nextCalls, 0)
  assert.equal(rt.approvalsView().length, 1)
})

test('rejecting a group Session git commit approval does not run the DSH allow path', async (t) => {
  const { ctx, rt } = await start(t)
  let nextCalls = 0
  const pending = ctx.listeners.get('approval/request')[0]({
    agent: { session: { id: 'gb' } },
    toolName: 'bash',
    reason: 'git commit -am ship-it',
  }, () => {
    nextCalls += 1
    return 'allowed-once'
  })
  const id = rt.approvalsView()[0].id
  rt.answerApproval(id, 'reject')
  assert.equal(await pending, 'rejected')
  assert.equal(nextCalls, 0)
  assert.equal(rt.approvalsView().length, 0)
})
