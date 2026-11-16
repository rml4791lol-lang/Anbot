import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripWireTags } from '../src/shared/wire-tags.js'
import { textOf } from '../src/host/text.js'

const C = '<' + '/'
const B = '\uFF5C\uFF5C'
const dsml = (name) => C + B + 'DSML' + B + ' ' + name + '>'
const OPEN_FINAL = '<' + 'final>'
const CLOSE_FINAL = C + 'final>'

// #1517: the check that matters is on the text itself - whatever a model writes
// around its words, a message keeps the words and nothing else.
test('a message body keeps only the words', () => {
  const leaks = [
    ['\u505A\u5230\u7B2C 3 \u9898\u4E86\u3002', dsml('parameter'), dsml('invoke'), dsml('calls')].join('\n'),
    OPEN_FINAL + '\u5DF2\u7ECF\u6539\u5B8C\u4E86\u3002' + CLOSE_FINAL,
    '\u6B63\u6587\n' + C + 'DSML invoke>',
    '\u6B63\u6587\n' + C + 'DSML calls>',
  ]
  for (const leak of leaks) {
    const out = stripWireTags(leak)
    assert.ok(!out.includes('<') && !out.includes('>'), out)
  }
})

test('the host reads model content without the tags', () => {
  assert.equal(textOf([{ type: 'text', text: '\u505A\u5230\u7B2C 3 \u9898\u3002\n' + dsml('invoke') }]), '\u505A\u5230\u7B2C 3 \u9898\u3002')
  assert.equal(textOf([{ type: 'text', text: OPEN_FINAL + '\u5DF2\u7ECF\u6539\u5B8C\u4E86\u3002' + CLOSE_FINAL }]), '\u5DF2\u7ECF\u6539\u5B8C\u4E86\u3002')
  assert.equal(textOf([{ type: 'text', text: dsml('invoke') + '\n' + dsml('calls') }]), '')
})

test('code inside a fence is left as written', () => {
  const code = '```\n' + dsml('invoke') + '\n```'
  assert.equal(stripWireTags('\u770B\u8FD9\u6BB5\uFF1A\n' + code), '\u770B\u8FD9\u6BB5\uFF1A\n' + code)
})

test('ordinary text is untouched', () => {
  assert.equal(stripWireTags('a < b and c > d'), 'a < b and c > d')
  assert.equal(stripWireTags('\u6700\u7EC8\u7B54\u6848\u3002'), '\u6700\u7EC8\u7B54\u6848\u3002')
})
