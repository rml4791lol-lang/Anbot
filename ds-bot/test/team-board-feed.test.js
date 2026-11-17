import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { boardFileName, readTeamBoardArchive, readTeamBoardLines, writeTeamBoard } from '../src/host/team-board-feed.js'

const dirOf = t => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-board-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const line = (over = {}) => ({
  kind: 'delivery',
  what: 'did a thing',
  number: null,
  evidence: null,
  needs: null,
  default: null,
  deadline: null,
  at: '2026-11-15T02:00:00+08:00',
  ...over,
})

test('a missing or empty board directory is an empty feed, not an error', (t) => {
  const dir = join(dirOf(t), 'absent')
  assert.deepEqual(readTeamBoardLines(dir), [])
})

test('the feed is newest first, and each Bot keeps at most 3 lines', (t) => {
  const dir = dirOf(t)
  writeFileSync(join(dir, 'a.json'), JSON.stringify([
    line({ what: 'a1', at: '2026-11-15T01:00:00+08:00' }),
    line({ what: 'a2', at: '2026-11-15T02:00:00+08:00' }),
    line({ what: 'a3', at: '2026-11-15T03:00:00+08:00' }),
    line({ what: 'a4', at: '2026-11-15T04:00:00+08:00' }),
  ]))
  writeFileSync(join(dir, 'b.json'), JSON.stringify([line({ what: 'b1', at: '2026-11-15T02:30:00+08:00' })]))
  const lines = readTeamBoardLines(dir)
  assert.deepEqual(lines.map(entry => entry.what), ['a4', 'a3', 'b1', 'a2'])
  assert.deepEqual(lines.map(entry => entry.bot), ['a', 'a', 'b', 'a'])
})

test('a broken file is skipped and a line of an unknown kind is dropped with a warning', (t) => {
  const dir = dirOf(t)
  writeFileSync(join(dir, 'broken.json'), '{oops')
  writeFileSync(join(dir, 'good.json'), JSON.stringify([
    line({ what: 'kept' }),
    line({ what: 'unknown', kind: 'brainstorm' }),
  ]))
  const warned = []
  const lines = readTeamBoardLines(dir, message => warned.push(message))
  assert.deepEqual(lines.map(entry => entry.what), ['kept'])
  assert.equal(warned.length, 2)
  assert.match(warned[0], /skipped broken\.json/)
  assert.match(warned[1], /kind brainstorm/)
})

test('every field of a line is present; a missing one is null', (t) => {
  const dir = dirOf(t)
  writeFileSync(join(dir, 'ops.json'), JSON.stringify([{ kind: 'decision', what: 'choose', at: '2026-11-15T02:00:00+08:00' }]))
  const [entry] = readTeamBoardLines(dir)
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'bot', 'deadline', 'default', 'evidence', 'kind', 'needs', 'number', 'what'])
  assert.equal(entry.bot, 'ops')
  assert.equal(entry.number, null)
  assert.equal(entry.needs, null)
})

test('a Bot writes only its own file, and a missing field is stored as null', (t) => {
  const dir = dirOf(t)
  writeFileSync(join(dir, 'other.json'), JSON.stringify([line({ what: 'theirs' })]))
  const count = writeTeamBoard('运维', [{ kind: 'blocked', what: 'stuck', at: '2026-11-15T05:00:00+08:00' }], dir)
  assert.equal(count, 1)
  const written = JSON.parse(readFileSync(join(dir, '运维.json'), 'utf8'))
  assert.equal(written.length, 1)
  assert.equal(written[0].bot, '运维')
  assert.equal(written[0].evidence, null)
  assert.equal(written[0].deadline, null)
  // The other Bot's file is untouched.
  assert.equal(JSON.parse(readFileSync(join(dir, 'other.json'), 'utf8'))[0].what, 'theirs')
  // A second write replaces this Bot's file instead of appending to it.
  writeTeamBoard('运维', [], dir)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '运维.json'), 'utf8')), [])
})

test('a Bot name that a path could read as a directory still lands in one file', () => {
  assert.equal(boardFileName('运维'), '运维.json')
  assert.equal(boardFileName('a/b..c'), 'a_b_c.json')
  assert.equal(boardFileName(''), 'bot.json')
})

test('the board keeps three lines; the archive keeps every delivery, once', (t) => {
  const dir = dirOf(t)
  const lines = [1, 2, 3, 4].map(n => line({ what: `d${n}`, at: `2026-11-15T0${n}:00:00+08:00` }))
  writeTeamBoard('ops', lines, dir)
  // Sending the same lines again must not duplicate them in the archive.
  writeTeamBoard('ops', lines, dir)
  assert.equal(readTeamBoardLines(dir).length, 3)
  const archived = readFileSync(join(dir, 'archive', 'ops.jsonl'), 'utf8').trim().split('\n')
  assert.equal(archived.length, 4)
  assert.deepEqual(readTeamBoardArchive(join(dir, 'archive')).map(entry => entry.what), ['d1', 'd2', 'd3', 'd4'])
})

test('a line of an unknown kind is on the board file but not in the archive', (t) => {
  const dir = dirOf(t)
  writeTeamBoard('ops', [line({ kind: 'brainstorm', what: 'idea' }), line({ what: 'done' })], dir)
  assert.equal(readFileSync(join(dir, 'archive', 'ops.jsonl'), 'utf8').trim().split('\n').length, 1)
  assert.deepEqual(readTeamBoardArchive(join(dir, 'archive')).map(entry => entry.what), ['done'])
})

test('an old archive with duplicates, a torn row and an unknown kind still reads once', (t) => {
  const dir = join(dirOf(t), 'archive')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ops.jsonl'), [
    JSON.stringify(line({ bot: 'ops', what: 'done' })),
    JSON.stringify(line({ bot: 'ops', what: 'done' })),
    JSON.stringify(line({ bot: 'ops', kind: 'brainstorm', what: 'idea' })),
    '{torn',
    '',
  ].join('\n'))
  const warned = []
  assert.deepEqual(readTeamBoardArchive(dir, message => warned.push(message)).map(entry => entry.what), ['done'])
  assert.deepEqual(warned, ['team board archive: skipped 2 bad rows in ops.jsonl'])
})
