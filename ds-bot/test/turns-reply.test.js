import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerSender } from '../src/host/turns.js'

// answerSender sends a finished turn's answer back to the Bot that asked. An answer with
// nothing in it must not wake the asker: the work is closed with what came back, and the
// asker reads it at its next turn (see the `silent` note in delivery.js).
function fake() {
  const sent = []
  const rt = {
    roomOf: () => undefined,
    botOf: () => ({ name: 'Writer' }),
    selfOf: id => id,
    closeWork: () => ({ id: 'work-1' }),
    deliver: async args => { sent.push(args) },
    warn: () => {},
  }
  return { rt, sent }
}

const source = { senderSessionId: 'a', senderSessionIdRoom: undefined, exchangeId: 'x-1' }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('an empty answer does not wake the Bot that asked', async () => {
  const { rt, sent } = fake()
  answerSender(rt, 'b', source, '   ')
  await tick()
  assert.equal(sent.length, 0)
})

test('an answer made only of punctuation does not wake the Bot that asked', async () => {
  for (const body of ['。', '.']) {
    const { rt, sent } = fake()
    answerSender(rt, 'b', source, body)
    await tick()
    assert.equal(sent.length, 0, `“${body}” is not an answer`)
  }
})

test('an answer of one CJK character still goes back to the Bot that asked', async () => {
  const { rt, sent } = fake()
  answerSender(rt, 'b', source, '好')
  await tick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, '好')
})

test('an answer with text still goes back to the Bot that asked', async () => {
  const { rt, sent } = fake()
  answerSender(rt, 'b', source, 'done: 12 rows')
  await tick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].role, 'reply')
  assert.equal(sent[0].text, 'done: 12 rows')
  assert.equal(sent[0].toId, 'a')
})
