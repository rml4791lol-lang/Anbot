import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const plugin = fileURLToPath(new URL('..', import.meta.url))

const run = (home, state, args) => spawnSync(process.execPath, ['dev/tasks.mjs', ...args], {
  cwd: plugin,
  encoding: 'utf8',
  env: { ...process.env, DS_BOT_HOME: home, DSH_ATLAS_STATE_DIR: state },
  timeout: 10_000,
})

test('the task report filters by row time and keeps board rows separate', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-tasks-cli-'))
  const home = join(root, 'home')
  const state = join(root, 'state')
  const ledger = join(home, 'ledger')
  const archive = join(state, 'board', 'archive')
  mkdirSync(ledger, { recursive: true })
  mkdirSync(archive, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const now = Date.parse('2026-11-16T12:00:00Z')
  const hour = 3_600_000
  const rows = [
    { kind: 'open', id: 'a', time: now - 5 * hour, day: '2026-11-16' },
    { kind: 'open', id: 'a', time: now - 2 * hour, day: '2026-11-16' },
    { kind: 'close', id: 'a', time: now - hour, outcome: 'answered', day: '2026-11-16' },
    { kind: 'open', id: 'b', time: now - 0.5 * hour, day: '2026-11-16' },
    { kind: 'close', id: 'b', time: now - 0.25 * hour, outcome: 'abandoned', day: '2026-11-16' },
    { kind: 'open', id: 'c', time: now - 0.1 * hour, day: '2026-11-16' },
  ]
  // The file is one file day earlier, so it remains a candidate while row.time decides.
  writeFileSync(join(ledger, 'tasks-2026-11-15.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  writeFileSync(join(archive, 'ops.jsonl'), [
    { bot: 'ops', kind: 'delivery', what: 'done', at: new Date(now - hour).toISOString() },
    { bot: 'ops', kind: 'decision', what: 'choose', at: new Date(now - 2 * hour).toISOString() },
    { bot: 'ops', kind: 'blocked', what: 'old', at: new Date(now - 30 * hour).toISOString() },
    { bot: 'ops', kind: 'delivery', what: 'undated', at: null },
  ].map(row => JSON.stringify(row)).join('\n') + '\n')

  const result = run(home, state, ['--days', '1', '--now', new Date(now).toISOString(), '--json'])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.opened, 3)
  assert.equal(report.closed, 2)
  assert.equal(report.answered, 1)
  assert.equal(report.abandoned, 1)
  assert.equal(report.pending, 1)
  assert.equal(report.completion, '1/3 (33.3%)')
  assert.equal(report.abandonRate, '1/3 (33.3%)')
  assert.deepEqual(report.files, ['tasks-2026-11-15.jsonl'])
  assert.deepEqual(report.daysSeen, ['2026-11-16'])
  assert.deepEqual(report.board, { total: 2, delivery: 1, decision: 1, blocked: 0, undated: 1 })
})

test('a window shorter than one day is rejected before reading anything', () => {
  const result = spawnSync(process.execPath, ['dev/tasks.mjs', '--days', '0'], {
    cwd: plugin,
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /positive integer/)
})
