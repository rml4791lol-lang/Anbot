import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, shellCommandRisk } from '../src/host/shell-approval.js'
import { fakeContext } from './fake-ctx.js'

test('recognizes high-risk direct shell commands and preserves ordinary reads', () => {
  for (const [command, risk] of [
    ['git -C checkout reset --hard HEAD', 'git'],
    ['printf start && git clean -fd', 'git'],
    ['git push origin local', 'remote'],
    ['git branch -D temp', 'git'],
    ['sh -c "rm -rf dir"', 'delete'],
    ['env LC_ALL=C /bin/rm --recursive tmp', 'delete'],
    ["Remove-Item -LiteralPath 'temp tree' -Recurse", 'delete'],
    ['sudo ls', 'elevated'],
    ['mkfs.ext4 test.img', 'disk'],
    ['git status --short', undefined],
    ['git log -- push', undefined],
    ['git restore --staged file', undefined],
    ["printf '%s' 'git reset --hard HEAD; rm -rf dir'", undefined],
    ['rm -f test.log', undefined],
  ]) assert.equal(shellCommandRisk(command), risk, command)
})

test('requests native approval in Bot sessions and preserves other pre-execute outcomes', async () => {
  const ctx = fakeContext()
  install({ ctx, load: async () => {}, isBotSession: id => id === 'owned' })
  const policy = ctx.listeners.get('tools/pre-execute')[0]
  const exec = { name: 'bash', arguments: { command: 'rm -rf dir' }, agent: { session: { id: 'owned' } } }
  const allow = async () => ({ kind: 'allow' })
  assert.equal((await policy(exec, allow)).kind, 'ask')
  assert.deepEqual(await policy(exec, async () => ({ kind: 'deny', reason: 'other protection' })), { kind: 'deny', reason: 'other protection' })
  assert.deepEqual(await policy({ ...exec, signal: AbortSignal.abort() }, allow), { kind: 'cancel' })
  assert.deepEqual(await policy({ ...exec, name: 'file_read' }, allow), { kind: 'allow' })
  assert.deepEqual(await policy({ ...exec, agent: { id: 'outside' } }, allow), { kind: 'allow' })
})
