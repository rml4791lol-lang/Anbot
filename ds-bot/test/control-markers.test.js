import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripControlMarkers } from '../src/host/text.js'

// A model that has nothing to say can end its answer with its chat template's stop
// marker. It is not text the Bot said, so it must never reach a ledger or another Bot
// (issue #14: a reply reached Antbot as `。<｜end▁of▁thinking｜>`).
test('a stop marker alone leaves nothing to send', () => {
  assert.equal(stripControlMarkers('<｜end▁of▁thinking｜>'), '')
  assert.equal(stripControlMarkers('  <｜end▁of▁thinking｜>\n\n<｜end▁of▁thinking｜>  '), '')
})

test('a stop marker after a sentence leaves the sentence', () => {
  assert.equal(stripControlMarkers('。<｜end▁of▁thinking｜>'), '。')
  assert.equal(stripControlMarkers('Done.\n<｜end▁of▁begin_of▁thinking｜>'), 'Done.')
})

test('the same markers written with ASCII pipes go too', () => {
  assert.equal(stripControlMarkers('<|end_of_thinking|>'), '')
  assert.equal(stripControlMarkers('好的<|end_of_thinking|>'), '好的')
})

test('ordinary text is left alone', () => {
  assert.equal(stripControlMarkers('正常文本'), '正常文本')
  assert.equal(stripControlMarkers('a < b and c > d'), 'a < b and c > d')
})
