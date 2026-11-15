import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  classify,
  formatSummary,
  issueOf,
  newestMs,
  parseArgs,
  parsePorcelain,
  parseStatus,
} from '../../scripts/worktrees.mjs'

const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const SCRIPT = fileURLToPath(new URL('../../scripts/worktrees.mjs', import.meta.url))
const POSIX_ONLY = process.platform === 'win32' ? 'needs a POSIX shell and symlinks' : false

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
    untracked: false,
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

test('a detached worktree is busy even when clean, merged and idle', () => {
  // A detached HEAD has no branch to restore from, so it can never be reaped safely.
  assert.deepEqual(kinds([entry({ detached: true, branch: null })]), ['busy'])
})

test('untracked work keeps a worktree busy', () => {
  assert.deepEqual(kinds([entry({ untracked: true })]), ['busy'])
  // Unknown is not clean either: a tree whose status could not be read stays busy.
  assert.deepEqual(kinds([entry({ untracked: null })]), ['busy'])
})

test('an unknown activity time keeps a worktree busy', () => {
  assert.deepEqual(kinds([entry({ mtimeMs: null })]), ['busy'])
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

test('status counts tracked changes and notices untracked work', () => {
  assert.deepEqual(parseStatus(''), { dirty: 0, untracked: false })
  assert.deepEqual(parseStatus(' M a.txt\nA  b.txt\n'), { dirty: 2, untracked: false })
  assert.deepEqual(parseStatus(' M a.txt\n?? test/new.test.js\n'), { dirty: 1, untracked: true })
  // An untracked-only tree is not dirty, but it is not clean work either.
  assert.deepEqual(parseStatus('?? notes.md\n?? node_modules/\n'), { dirty: 0, untracked: true })
})

test('the activity time is the newest known one, and null when none is known', () => {
  // The admin index moves on every git write in a worktree; HEAD's commit time covers
  // a tree that has been idle since its last commit.
  assert.equal(newestMs([10, 30, 20]), 30)
  assert.equal(newestMs([null, 30, undefined, NaN]), 30)
  assert.equal(newestMs([null, undefined]), null)
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

// A throwaway repository with `main` and one commit, dated in the past so that a fresh
// worktree counts as idle and would be classified reapable.
function makeRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'worktrees-test-'))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const env = { ...process.env, GIT_AUTHOR_DATE: '2020-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2020-01-02T03:04:05Z' }
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  git('init', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', 'a.txt')
  git('commit', '-m', 'init')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, repo, git }
}

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

function triage(cwd, { env = process.env, script = SCRIPT, args = ['--dry-run'] } = {}) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env })
}

test('the script runs when it is invoked through a symlink', { skip: POSIX_ONLY }, (t) => {
  const { root, repo, git } = makeRepo(t)
  git('worktree', 'add', join(root, 'wt'), '-b', 'feat/1-example')
  const link = join(root, 'wt-link.mjs')
  symlinkSync(SCRIPT, link)

  const linked = triage(repo, { script: link })
  assert.equal(linked.status, 0, linked.stderr)
  assert.match(linked.stdout, /total=1 reapable=0 busy=1 prunable=0/)
})

test('a worktree whose git status dies is busy, not reapable', { skip: POSIX_ONLY }, (t) => {
  const realGit = findOnPath('git')
  if (!realGit) {
    t.skip('git is not on PATH')
    return
  }
  const { root, repo, git } = makeRepo(t)
  const wt = join(root, 'wt')
  git('worktree', 'add', wt, '-b', 'feat/1-example')
  // The worktree is idle: backdate the admin index that the triage reads.
  const adminDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: wt, encoding: 'utf8' }).trim()
  const old = new Date('2020-01-02T03:04:05Z')
  utimesSync(join(adminDir, 'index'), old, old)
  assert.match(triage(repo).stdout, /total=1 reapable=1 busy=0 prunable=0/)

  // Stand-in for a `git status` that is killed, e.g. by the 60 s timeout.
  const shimDir = join(root, 'bin')
  mkdirSync(shimDir)
  writeFileSync(
    join(shimDir, 'git'),
    ['#!/bin/sh', 'for arg in "$@"; do', '  if [ "$arg" = "status" ]; then kill -9 $$; fi', 'done', `exec "${realGit}" "$@"`, ''].join('\n'),
    { mode: 0o755 },
  )
  const killed = triage(repo, { env: { ...process.env, PATH: `${shimDir}${delimiter}${process.env.PATH}` } })
  assert.equal(killed.status, 0, killed.stderr)
  assert.match(killed.stdout, /total=1 reapable=0 busy=1 prunable=0/)
})
