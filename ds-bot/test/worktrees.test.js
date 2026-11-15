import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { classify, formatSummary, issueOf, parseArgs, parsePorcelain } from '../../scripts/worktrees.mjs'

const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const SCRIPT = fileURLToPath(new URL('../../scripts/worktrees.mjs', import.meta.url))

function entry(overrides = {}) {
  return {
    path: '/tmp/DS-Bot-wt-1',
    branch: 'feat/1-example',
    head: 'a'.repeat(40),
    detached: false,
    bare: false,
    exists: true,
    merged: true,
    ahead: 0,
    dirty: 0,
    mtimeMs: NOW - 60 * MINUTE,
    ...overrides,
  }
}

function kinds(entries) {
  return classify(entries, { now: NOW, lockMinutes: 45 }).rows.map((row) => row.kind)
}

test('a clean worktree merged into main and untouched for over 45 minutes is reapable', () => {
  assert.deepEqual(kinds([entry()]), ['reapable'])
})

test('tracked changes keep a worktree busy', () => {
  assert.deepEqual(kinds([entry({ dirty: 2 })]), ['busy'])
})

test('commits main does not have keep a worktree busy even when it looks idle', () => {
  assert.deepEqual(kinds([entry({ merged: false, ahead: 3 })]), ['busy'])
})

test('a worktree touched within 45 minutes is busy even when clean and merged', () => {
  assert.deepEqual(kinds([entry({ mtimeMs: NOW - 5 * MINUTE })]), ['busy'])
  // The boundary is exclusive: exactly 45 minutes is not enough to reap.
  assert.deepEqual(kinds([entry({ mtimeMs: NOW - 45 * MINUTE })]), ['busy'])
})

test('a worktree whose path is gone is prunable', () => {
  assert.deepEqual(kinds([entry({ exists: false })]), ['prunable'])
})

test('the three classes cover every input exactly once', () => {
  const { rows, counts } = classify(
    [
      entry(),
      entry({ path: '/tmp/DS-Bot-wt-2', dirty: 1 }),
      entry({ path: '/tmp/DS-Bot-wt-3', mtimeMs: NOW - 2 * MINUTE }),
      entry({ path: '/tmp/DS-Bot-wt-4', merged: false, ahead: 1 }),
      entry({ path: '/tmp/DS-Bot-wt-5', exists: false }),
    ],
    { now: NOW, lockMinutes: 45 },
  )
  assert.equal(rows.length, 5)
  assert.deepEqual(counts, { total: 5, reapable: 1, busy: 3, prunable: 1 })
  assert.equal(counts.reapable + counts.busy + counts.prunable, counts.total)
  assert.equal(formatSummary(counts), 'total=5 reapable=1 busy=3 prunable=1')
})

test('porcelain blocks carry path, HEAD, branch and the detached/bare markers', () => {
  const head = (letter) => letter.repeat(40)
  const text = [
    'worktree /repo',
    'HEAD ' + head('a'),
    'branch refs/heads/main',
    '',
    'worktree /private/tmp/dsbot-base',
    'HEAD ' + head('b'),
    'detached',
    '',
    'worktree /srv/mirror.git',
    'HEAD ' + head('c'),
    'bare',
    '',
  ].join('\n')
  assert.deepEqual(parsePorcelain(text), [
    { path: '/repo', head: head('a'), branch: 'main', detached: false, bare: false },
    { path: '/private/tmp/dsbot-base', head: head('b'), branch: null, detached: true, bare: false },
    { path: '/srv/mirror.git', head: head('c'), branch: null, detached: false, bare: true },
  ])
})

test('the issue comes from wt-<n> or fix|feat/<n>, and stays empty otherwise', () => {
  assert.equal(issueOf({ path: '/Users/x/DS-Bot-wt-13', branch: 'fix/13-bot-durability' }), '13')
  assert.equal(issueOf({ path: '/Users/x/DS-Bot-wt-t17', branch: 'feat/17-local-gate' }), '17')
  assert.equal(issueOf({ path: '/Users/x/DS-Bot-wt-agentskills', branch: 'docs/agent-skills-setup' }), '')
  assert.equal(issueOf({ path: '/private/tmp/dsbot-base', branch: null }), '')
})

test('--apply is rejected instead of acting like a dry run', () => {
  assert.throws(() => parseArgs(['--apply']), /--apply is not implemented/)
  assert.doesNotThrow(() => parseArgs([]))
  assert.doesNotThrow(() => parseArgs(['--dry-run']))

  const result = spawnSync(process.execPath, [SCRIPT, '--apply'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--apply is not implemented/)
})
