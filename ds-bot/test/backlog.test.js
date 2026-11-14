// R59: notes waiting for one Bot are read as one message, not one turn each.
// The rules here are the six the plan fixed: same Session only, plain relays only,
// nothing the plugin injects, at most five a round, the newest text untouched with a
// last line counting the others, and a burst measured as one delivery.
import test from 'node:test'
import assert from 'node:assert/strict'
import { BACKLOG_LIMIT, backlogNote, mergeBacklog, mergeBySession, plainRelay } from '../src/host/backlog.js'

const note = (text, extra = {}) => ({ role: 'request', text, toId: 'b', ...extra })

test('only a plain relay is folded', () => {
  assert.equal(plainRelay(note('one')), true)
  const rejected = [
    { title: 'an image', extra: { images: [{ attachment: {} }] } },
    { title: 'a file', extra: { files: [{ attachment: {} }] } },
    { title: 'a reply target', extra: { replyTo: 'x-1' } },
    { title: 'a room', extra: { roomId: 'room-1' } },
    { title: 'a work item', extra: { work: 'w-1' } },
    { title: 'an audience', extra: { audience: 'user' } },
    { title: 'a sender room', extra: { fromRoomId: 'room-2' } },
    { title: 'a silent note', extra: { silent: true } },
    { title: 'a steering message', extra: { steer: true } },
    { title: 'a deferred one', extra: { deferred: true } },
    { title: 'a resumed one', extra: { resumed: true } },
    { title: 'a retried one', extra: { retried: true } },
    { title: 'an already merged one', extra: { merged: true } },
    { title: 'an abandoned one', extra: { abandoned: true } },
    { title: 'empty text', extra: { text: '' } },
  ]
  for (const { title, extra } of rejected) assert.equal(plainRelay(note('one', extra)), false, title)
})

test('what the plugin injects into a Session never rides along', () => {
  for (const role of ['memory-update', 'runtime-context', 'skill-catalog', 'approval', 'update', 'kickoff', 'resume', 'room', 'report', 'secret', 'stopped', 'reply']) {
    assert.equal(plainRelay({ role, text: 'injected' }), false, role)
  }
})

test('the newest text goes out untouched, the others are only counted', () => {
  const merged = mergeBacklog([note('first', { toId: 'b' }), note('second'), note('third')])
  assert.equal(merged.text, `third\n\n${backlogNote(2)}`)
  assert.equal(merged.count, 3)
  assert.deepEqual(merged.rest, [])
  // The earlier words are not rewritten into the body: only the newest one is quoted.
  assert.ok(!merged.text.includes('first'))
  assert.ok(!merged.text.includes('second'))
})

test('one note is delivered as it was written, with no counting line', () => {
  const merged = mergeBacklog([note('just this')])
  assert.equal(merged.text, 'just this')
  assert.equal(merged.count, 1)
})

test('at most five notes go in one round, the rest wait for the next', () => {
  const entries = Array.from({ length: 7 }, (_, index) => note(`note ${index + 1}`))
  const first = mergeBacklog(entries)
  assert.equal(BACKLOG_LIMIT, 5)
  assert.equal(first.count, 5)
  assert.equal(first.rest.length, 2)
  assert.equal(first.text, `note 5\n\n${backlogNote(4)}`)
  const next = mergeBacklog(first.rest)
  assert.equal(next.count, 2)
  assert.equal(next.text, `note 7\n\n${backlogNote(1)}`)
})

test('a burst that used to open five turns now opens one', () => {
  // The measured shape: five notes to the same Bot inside one minute (00:13–00:14).
  const burst = Array.from({ length: 5 }, (_, index) => note(`第 ${index + 1} 条`))
  const merged = mergeBySession(burst)
  assert.equal(merged.size, 1)
  const [folded] = merged.values()
  assert.equal(folded.count, 5)
  assert.equal(folded.text, `第 5 条\n\n${backlogNote(4)}`)
})

test('notes for two Bots are never folded together', () => {
  const merged = mergeBySession([note('for b', { toId: 'b', sessionId: 's-b' }), note('for c', { toId: 'c', sessionId: 's-c' })])
  assert.equal(merged.size, 2)
  assert.equal(merged.get('s-b').text, 'for b')
  assert.equal(merged.get('s-c').text, 'for c')
})

test('a note that is not a plain relay is left out of the fold', () => {
  const merged = mergeBySession([note('plain', { sessionId: 's-b' }), { role: 'request', text: 'with a file', toId: 'b', sessionId: 's-b', files: [{ attachment: {} }] }])
  assert.equal(merged.get('s-b').count, 1)
  assert.equal(merged.get('s-b').text, 'plain')
})
