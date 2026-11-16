import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { installTaskLog, readTaskLedger, summarizeTasks, taskDay, taskRow } from '../src/host/task-ledger.js'

test('a work counts as done only when an answer came back', () => {
  const rows = [
    { kind: 'open', id: 'a', time: 1_000 },
    { kind: 'close', id: 'a', outcome: 'answered', time: 3_000 },
    { kind: 'open', id: 'b', time: 1_000 },
    { kind: 'close', id: 'b', outcome: 'abandoned', time: 5_000 },
    { kind: 'open', id: 'c', time: 1_000 },
  ]
  const summary = summarizeTasks(rows)
  assert.equal(summary.opened, 3)
  assert.equal(summary.closed, 2)
  assert.equal(summary.answered, 1)
  assert.equal(summary.abandoned, 1)
  assert.equal(summary.pending, 1)
  assert.equal(summary.completion, '1/3 (33.3%)')
  assert.equal(summary.abandonRate, '1/3 (33.3%)')
  assert.equal(summary.p50Ms, 2_000)
  assert.equal(summary.p90Ms, 4_000)
})

test('a close with no open in the window is counted, not guessed', () => {
  const summary = summarizeTasks([{ kind: 'close', id: 'x', outcome: 'answered', time: 2 }])
  assert.equal(summary.opened, 0)
  assert.equal(summary.closed, 0)
  assert.equal(summary.completion, 'n/a')
  assert.equal(summary.closedWithoutOpen, 1)
})

test('nothing at all is n/a, not 0%', () => {
  const summary = summarizeTasks([])
  assert.equal(summary.completion, 'n/a')
  assert.equal(summary.p50Ms, undefined)
})

test('a close before its open is pending, not a negative duration', () => {
  const summary = summarizeTasks([
    { kind: 'open', id: 'a', time: 10 },
    { kind: 'close', id: 'a', outcome: 'answered', time: 5 },
  ])
  assert.equal(summary.closed, 0)
  assert.equal(summary.pending, 1)
  assert.equal(summary.p50Ms, undefined)
})

test('a close with no outcome is counted apart, never as answered', () => {
  const summary = summarizeTasks([
    { kind: 'open', id: 'a', time: 10 },
    { kind: 'close', id: 'a', outcome: 'something-else', time: 20 },
  ])
  assert.equal(summary.closed, 1)
  assert.equal(summary.answered, 0)
  assert.equal(summary.abandoned, 0)
  assert.equal(summary.unclassified, 1)
  assert.equal(summary.completion, '0/1 (0.0%)')
})

test('a later valid close replaces an unreadable earlier close', () => {
  const summary = summarizeTasks([
    { kind: 'open', id: 'a', time: 10 },
    { kind: 'close', id: 'a', outcome: 'answered', time: undefined },
    { kind: 'close', id: 'a', outcome: 'answered', time: 20 },
  ])
  assert.equal(summary.closed, 1)
  assert.equal(summary.answered, 1)
  assert.equal(summary.p50Ms, 10)
})

test('taskRow carries the configured local day and its event', () => {
  const time = Date.UTC(2026, 10, 15, 23, 30)
  const row = taskRow({ kind: 'open', id: 'a', day: 'not-the-day', time: 1 }, time, 'Asia/Shanghai')
  assert.equal(taskDay(time, 'Asia/Shanghai'), '2026-11-16')
  assert.equal(taskDay(time, 'UTC'), '2026-11-15')
  assert.equal(row.day, '2026-11-16')
  assert.equal(row.time, time)
  assert.equal(row.kind, 'open')
  assert.equal(row.id, 'a')
})

test('the report reads by row time, not by the file named for another day', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-tasks-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'tasks-2026-11-15.jsonl'), [
    JSON.stringify({ kind: 'open', id: 'old', day: '2026-11-15', time: 100 }),
    '{torn',
    JSON.stringify({ kind: 'close', id: 'bad-time', day: '2026-11-15', time: 'not-a-time' }),
    JSON.stringify({ kind: 'brainstorm', id: 'bad-kind', day: '2026-11-15', time: 220 }),
    JSON.stringify({ kind: 'close', id: 'old', day: '2026-11-15', time: 200, outcome: 'answered' }),
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'tasks-2026-11-16.jsonl'), JSON.stringify({ kind: 'open', id: 'new', day: '2026-11-16', time: 300 }) + '\n')
  writeFileSync(join(dir, 'notes.jsonl'), JSON.stringify({ kind: 'open', id: 'noise', time: 200 }) + '\n')

  const warn = []
  const ledger = readTaskLedger(dir, 150, 250, message => warn.push(message))
  assert.deepEqual(ledger.rows.map(row => [row.kind, row.id, row.time]), [['close', 'old', 200]])
  assert.deepEqual(warn, ['task ledger: skipped 3 bad rows in tasks-2026-11-15.jsonl'])
  assert.deepEqual(ledger.files, ['tasks-2026-11-15.jsonl', 'tasks-2026-11-16.jsonl'])
  assert.deepEqual(ledger.days, ['2026-11-15'])
})

test('the host writes the event under the configured local day', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 15, 23, 30) })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-log-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const warn = []
  installTaskLog({ home, config: { timeZone: 'Asia/Shanghai' }, warn: message => warn.push(message) })({ kind: 'open', id: 'a' })
  const file = join(home, 'ledger', 'tasks-2026-11-16.jsonl')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).id, 'a')
  assert.deepEqual(warn, [])
})

test('a read-only host writes no task row, and a failed write only warns', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-log-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const readOnly = installTaskLog({ home, config: {}, readOnly: () => 'another host', warn() {} })
  readOnly({ kind: 'open', id: 'a' })
  assert.deepEqual(readdirSync(home), [])

  const file = join(home, 'not-a-directory')
  writeFileSync(file, 'x')
  const warn = []
  installTaskLog({ home: file, config: {}, warn: (message, ...args) => warn.push([message, ...args]) })({ kind: 'open', id: 'b' })
  assert.match(warn[0][0], /task ledger row not written/)
  assert.equal(warn[0][1], 'b')
})

test('a warm ledger cache sees an appended row without losing its file entry', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-tasks-cache-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'tasks-2026-11-15.jsonl')
  writeFileSync(file, JSON.stringify({ kind: 'open', id: 'a', day: '2026-11-15', time: 100 }) + '\n')
  const cache = new Map()
  assert.deepEqual(readTaskLedger(dir, 0, Number.MAX_SAFE_INTEGER, () => {}, cache).rows.map(row => row.id), ['a'])
  appendFileSync(file, JSON.stringify({ kind: 'close', id: 'a', outcome: 'answered', day: '2026-11-15', time: 200 }) + '\n')
  assert.deepEqual(readTaskLedger(dir, 0, Number.MAX_SAFE_INTEGER, () => {}, cache).rows.map(row => [row.kind, row.id]), [['open', 'a'], ['close', 'a']])
  assert.equal(cache.size, 1)
})
