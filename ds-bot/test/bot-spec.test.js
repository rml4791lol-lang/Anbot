import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBotSpecAccess } from '../src/host/bot-spec.js'
import { install as installPrompt } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'

function fixture(save = async () => {}) {
  const bot = { name: 'Engineer', instructions: 'Check files.' }
  const ctx = fakeContext()
  const rt = {
    ctx, save,
    roomOf: () => undefined, isMain: () => false,
    botOf: id => id === 'bot' ? bot : undefined,
    selfOf: () => 'bot',
    chatOf: () => 'direct',
  }
  installPrompt(rt)
  return { bot, access: createBotSpecAccess(rt), prompt: id => ctx.sections.get('bot-identity').text({ agent: { id } }) }
}

test('the latest saved task spec enters the direct request without leaking to other Sessions', async () => {
  const { access, prompt } = fixture()
  const input = { revision: null, objective: 'Keep migrations reversible', checklist: '- [ ] Run the migration tests' }
  const first = await access.save('bot', 'direct', input)
  assert.equal(access.get('bot', 'direct'), first)
  assert.match(prompt('direct'), /Keep migrations reversible/)
  assert.match(prompt('direct'), /Run the migration tests/)
  assert.doesNotMatch(prompt('group-member'), /Keep migrations reversible/)
  assert.throws(() => access.get('bot', 'earlier'), { code: 'bot/stale' })
  await assert.rejects(access.save('bot', 'direct', input), { code: 'bot/stale' })
  const clear = await access.save('bot', 'direct', { revision: first.revision, objective: '', checklist: '' })
  assert.notEqual(first.revision, clear.revision)
  assert.doesNotMatch(prompt('direct'), /Current task spec/)
})

test('an unsuccessful write restores the saved task spec', async () => {
  const { access, bot } = fixture(async () => { throw Error('write rejected') })
  await assert.rejects(access.save('bot', 'direct', { revision: null, objective: 'Keep it', checklist: '' }), /write rejected/)
  assert.equal(bot.taskSpec, undefined)
  assert.equal(access.get('bot', 'direct'), null)
})
