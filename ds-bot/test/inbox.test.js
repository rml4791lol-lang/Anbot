import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { INBOX_READ_MAX, install, parseInbox } from '../src/host/inbox.js'
import { fakeContext } from './fake-ctx.js'

const host = (t, { readOnly, home: given } = {}) => {
  const home = given ?? mkdtempSync(join(tmpdir(), 'ds-bot-inbox-'))
  const warnings = []
  const rt = { home, readOnly: () => readOnly, warn: (...args) => warnings.push(args) }
  install(rt)
  if (given === undefined) t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  return {
    rt,
    home,
    warnings,
    file: botId => join(home, 'inbox', `${botId}.jsonl`),
    cursor: botId => join(home, 'inbox', `${botId}.cursor.json`),
  }
}

const entry = (over = {}) => ({ from: 'b', fromName: 'Writer', role: 'update', sessionId: 's-a', exchangeId: 'x-1', text: 'note', time: 1763000000000, ...over })

test('append keeps the schema, oldest first, and a resend writes no second line', async (t) => {
  const { rt, file } = host(t)
  const first = await rt.inbox.append('a', entry({ senderRoomId: 'r9', roomId: 'r9' }))
  await rt.inbox.append('a', entry({ exchangeId: 'x-2', text: 'second', time: 1763000001000 }))
  // The same exchange arriving twice is one note: it reaches the Bot once.
  const again = await rt.inbox.append('a', entry({ exchangeId: 'x-1', text: 'resent', time: 1763000002000 }))
  assert.equal(again.id, first.id)
  assert.equal(again.text, 'note')
  assert.equal(first.id.length > 0, true)
  const entries = rt.inbox.list('a')
  assert.deepEqual(entries.map(item => item.text), ['note', 'second'])
  assert.equal(rt.inbox.unreadCount('a'), 2)
  const lines = readFileSync(file('a'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  const record = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(record), ['id', 'from', 'fromName', 'role', 'sessionId', 'senderRoomId', 'exchangeId', 'roomId', 'text', 'time'])
  assert.deepEqual([record.sessionId, record.senderRoomId, record.exchangeId], ['s-a', 'r9', 'x-1'])
  assert.equal(record.time, 1763000000000)
})

test('markRead moves a cursor file and never rewrites the message lines', async (t) => {
  const { rt, home, file, cursor } = host(t)
  const one = await rt.inbox.append('a', entry({ exchangeId: 'x-1', text: 'one' }))
  await rt.inbox.append('a', entry({ exchangeId: 'x-2', text: 'two' }))
  await rt.inbox.append('a', entry({ exchangeId: 'x-3', text: 'three' }))
  const before = readFileSync(file('a'), 'utf8')
  assert.equal(await rt.inbox.markRead('a', [one.id]), 1)
  assert.equal(readFileSync(file('a'), 'utf8'), before)
  assert.equal(JSON.parse(readFileSync(cursor('a'), 'utf8')).cursor, 1)
  assert.deepEqual(rt.inbox.list('a', { unreadOnly: true }).map(item => item.text), ['two', 'three'])
  assert.deepEqual(rt.inbox.list('a').map(item => [item.text, item.unread]), [['one', false], ['two', true], ['three', true]])
  assert.equal(rt.inbox.unreadCount('a'), 2)
  // A cursor only moves forward: an earlier id cannot unread a later note.
  assert.equal(await rt.inbox.markRead('a', [one.id]), 0)
  // The cursor is what survives a restart; the messages are replayed from the file.
  const replayed = { home, readOnly: () => undefined, warn: () => {} }
  install(replayed)
  assert.equal(replayed.inbox.unreadCount('a'), 2)
  assert.deepEqual(replayed.inbox.list('a', { unreadOnly: true }).map(item => item.text), ['two', 'three'])
})

test('a window reads oldest first, so the next read starts where the last one stopped', async (t) => {
  const { rt } = host(t)
  for (let at = 1; at <= 25; at += 1) await rt.inbox.append('a', entry({ exchangeId: `x-${at}`, text: `m${at}` }))
  const first = rt.inbox.list('a', { limit: 3 })
  assert.deepEqual(first.map(item => item.text), ['m1', 'm2', 'm3'])
  assert.equal(await rt.inbox.markRead('a', first.map(item => item.id)), 3)
  assert.deepEqual(rt.inbox.list('a', { unreadOnly: true }).map(item => item.text), ['m4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12', 'm13'])
  assert.equal(rt.inbox.list('a', { limit: 999 }).length, INBOX_READ_MAX)
  assert.equal(rt.inbox.list('a', { limit: 0 }).length, 1)
})

test('a line cut by an interruption is skipped, and the next record gets its own line', async (t) => {
  const { rt, home, file } = host(t)
  await rt.inbox.append('a', entry({ exchangeId: 'x-1', text: 'whole' }))
  const whole = readFileSync(file('a'), 'utf8')
  writeFileSync(file('a'), `${whole}{"id":"cut","text":"no end`)
  assert.deepEqual(rt.inbox.list('a').map(item => item.text), ['whole'])
  await rt.inbox.append('a', entry({ exchangeId: 'x-2', text: 'again' }))
  assert.deepEqual(rt.inbox.list('a').map(item => item.text), ['whole', 'again'])
  assert.equal(parseInbox(readFileSync(join(home, 'inbox', 'a.jsonl'), 'utf8')).length, 2)
})

test('a mailbox is per Bot, and a read-only host writes nothing', async (t) => {
  const { rt, file } = host(t)
  await rt.inbox.append('a', entry({ text: 'for a' }))
  assert.deepEqual(rt.inbox.list('b'), [])
  assert.equal(existsSync(file('b')), false)
  const reader = host(t, { readOnly: 'another dsh holds the team' })
  await assert.rejects(reader.rt.inbox.append('a', entry({ text: 'nope' })), /cannot be written/)
  assert.equal(await reader.rt.inbox.markRead('a', ['x']), 0)
  assert.equal(reader.rt.inbox.list('a').length, 0)
})

test('read_inbox shows a quiet note, marks it read, and works in a group Session', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-read-inbox-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], sessions: { b: 'g1' }, log: [], seq: 0 } },
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  await rt.inbox.append('b', entry({ exchangeId: 'x-1', text: 'Your profile was updated. Ship it.' }))
  const read = rt.teamTools.find(def => def.name === 'read_inbox')
  assert.ok(read, 'read_inbox is a team tool')
  const seen = await read.execute({}, { agent: { id: 'b' } })
  assert.match(seen, /^1 note for Writer:/)
  assert.match(seen, /Writer · profile update/)
  assert.match(seen, /Your profile was updated/)
  assert.match(seen, /never start a turn/)
  assert.equal(rt.inbox.unreadCount('b'), 0)
  assert.match(await read.execute({}, { agent: { id: 'b' } }), /^No unread notes/)
  // A group Session belongs to its Bot: the relay scope includes the inbox.
  await rt.inbox.append('b', entry({ exchangeId: 'x-2', text: 'Stop receipt' }))
  const group = await read.execute({}, { agent: { id: 'g1' } })
  assert.match(group, /^1 note for Writer:/)
  assert.match(group, /stop receipt|update/)
})
