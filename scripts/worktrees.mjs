#!/usr/bin/env node
// Read-only triage of every registered Git worktree: which ones are merged into main,
// clean and idle long enough to be reaped, which ones are still in use, and which ones
// no longer exist on disk. Stage one never deletes anything.
//
//   node scripts/worktrees.mjs            # default: --dry-run
//   node scripts/worktrees.mjs --dry-run
//   node scripts/worktrees.mjs --apply    # not implemented yet: exits non-zero
//
// Facts that keep this honest:
//   - `dirty` counts tracked changes only, so `?? node_modules` does not mark every tree
//     dirty; a separate `untracked` flag keeps a tree with new, uncommitted files busy.
//   - `mtimeMs` is the last moment git wrote state for the tree: the newer of the admin
//     index file and the HEAD commit time. A worktree's `.git` file is written once at
//     creation and never again, so its mtime says nothing about use.
//   - A detached HEAD has no branch to restore from, so it is never reapable.
//   - The main worktree (`.git` is a directory) and the first porcelain entry are skipped.
import { execFileSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAIN_REF = 'main'
const LOCK_MINUTES = 45

// Blocks of `git worktree list --porcelain`, split on blank lines.
export function parsePorcelain(text) {
  const entries = []
  let current = null
  for (const line of text.split('\n')) {
    if (line === '') {
      current = null
      continue
    }
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1)
    if (key === 'worktree') {
      current = { path: value, head: null, branch: null, detached: false, bare: false }
      entries.push(current)
      continue
    }
    if (!current) continue
    if (key === 'HEAD') current.head = value
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '')
    else if (key === 'detached') current.detached = true
    else if (key === 'bare') current.bare = true
  }
  return entries
}

// 13 from `DS-Bot-wt-13`, `fix/13-bot-durability` or `feat/13-bot-inbox`; '' when neither names one.
export function issueOf(entry) {
  for (const text of [entry.branch ?? '', entry.path]) {
    const match = /wt-(\d+)/i.exec(text) ?? /(?:fix|feat)\/(\d+)/i.exec(text)
    if (match) return match[1]
  }
  return ''
}

// Entry facts: { path, branch, head, detached, bare, exists, merged, ahead, dirty,
// untracked, mtimeMs }. Pure: no git, no fs, no clock. `merged` is `HEAD` being an
// ancestor of main, `dirty` the number of tracked changes, `untracked` whether the tree
// holds files git does not track yet, `ahead` the commits main does not have yet.
export function classify(entries, { now = Date.now(), lockMinutes = LOCK_MINUTES } = {}) {
  const lockMs = lockMinutes * 60 * 1000
  const rows = entries.map((entry) => ({ ...entry, kind: kindOf(entry, now, lockMs) }))
  const counts = { total: rows.length, reapable: 0, busy: 0, prunable: 0 }
  for (const row of rows) counts[row.kind] += 1
  return { rows, counts }
}

function kindOf(entry, now, lockMs) {
  if (!entry.exists) return 'prunable'
  const idle = Number.isFinite(entry.mtimeMs) && now - entry.mtimeMs > lockMs
  // A detached HEAD has no branch to restore from, and unknown facts are never clean.
  if (entry.detached || entry.merged !== true || entry.dirty !== 0 || entry.untracked !== false || !idle) return 'busy'
  return 'reapable'
}

// `??` is `git status --porcelain`'s only untracked marker: one pass yields both the
// tracked-change count the row shows and the untracked flag that blocks reaping.
export function parseStatus(text) {
  let dirty = 0
  let untracked = false
  for (const line of text.split('\n')) {
    if (line === '') continue
    if (line.startsWith('??')) untracked = true
    else dirty += 1
  }
  return { dirty, untracked }
}

// Newest known timestamp, null when none is known.
export function newestMs(values) {
  let newest = null
  for (const value of values) {
    if (Number.isFinite(value) && (newest === null || value > newest)) newest = value
  }
  return newest
}

export function formatRow(row) {
  const branch = row.detached ? '(detached)' : row.branch ?? '-'
  return [
    row.path,
    branch,
    row.ahead ?? '-',
    row.dirty ?? '-',
    Number.isFinite(row.mtimeMs) ? new Date(row.mtimeMs).toISOString() : '-',
    issueOf(row),
    row.kind,
  ].join(' | ')
}

export function formatSummary(counts) {
  return `total=${counts.total} reapable=${counts.reapable} busy=${counts.busy} prunable=${counts.prunable}`
}

// `--dry-run` is the only mode that exists. `--apply` fails loudly instead of silently
// doing nothing: stage two (commit paused work, re-verify, remove) has its own ticket.
export function parseArgs(argv) {
  for (const arg of argv) {
    if (arg === '--dry-run') continue
    if (arg === '--apply') throw new Error('--apply is not implemented; stage one only classifies and never deletes')
    throw new Error(`unknown argument: ${arg} (use --dry-run)`)
  }
}

// A hung git (a stale `.git/index.lock`, an unreachable network filesystem) would hang
// triage forever, so it is bounded. The timeout throws like any other git failure, which
// `factsFor` turns into "cannot read" and `classify` into `busy`.
function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  }).trim()
}

function gitExit(args, cwd) {
  try {
    git(args, cwd)
    return 0
  } catch (error) {
    return typeof error.status === 'number' ? error.status : -1
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// A worktree's `.git` is a file; the main checkout's is a directory.
function isMainCheckout(path) {
  return isDirectory(join(path, '.git'))
}

// Fallback only, for a tree whose admin index and HEAD are both unreadable.
function mtimeOf(path) {
  for (const candidate of [join(path, '.git'), path]) {
    try {
      return statSync(candidate).mtimeMs
    } catch {
      // try the next candidate
    }
  }
  return null
}

// The admin index moves on every git write in the worktree.
function adminIndexMs(path) {
  try {
    return statSync(join(git(['rev-parse', '--absolute-git-dir'], path), 'index')).mtimeMs
  } catch {
    return null
  }
}

function headCommitMs(path) {
  try {
    return Number(git(['log', '-1', '--format=%ct', 'HEAD'], path)) * 1000 || null
  } catch {
    return null
  }
}

function factsFor(entry, mainSha) {
  if (!isDirectory(entry.path)) {
    return { ...entry, exists: false, merged: false, ahead: null, dirty: null, untracked: null, mtimeMs: null }
  }
  const mtimeMs = newestMs([adminIndexMs(entry.path), headCommitMs(entry.path)]) ?? mtimeOf(entry.path)
  try {
    const { dirty, untracked } = parseStatus(
      // `status` may refresh the index, which is exactly what `mtimeMs` measures.
      git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal'], entry.path),
    )
    return {
      ...entry,
      exists: true,
      merged: gitExit(['merge-base', '--is-ancestor', entry.head, mainSha], entry.path) === 0,
      ahead: Number(git(['rev-list', '--count', `${mainSha}..HEAD`], entry.path)),
      dirty,
      untracked,
      mtimeMs,
    }
  } catch {
    // A tree git cannot read is not a tree we may call reapable.
    return { ...entry, exists: true, merged: null, ahead: null, dirty: null, untracked: null, mtimeMs }
  }
}

// Compare real paths: through a symlink (or `/tmp` on macOS) a plain `resolve` compare
// is false, and the script would exit 0 having printed nothing.
function invokedDirectly(argv) {
  if (!argv) return false
  try {
    return realpathSync(resolve(argv)) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

function main(argv) {
  parseArgs(argv)
  const cwd = process.cwd()
  const mainSha = git(['rev-parse', '--verify', `${MAIN_REF}^{commit}`], cwd)
  const entries = parsePorcelain(git(['worktree', 'list', '--porcelain'], cwd))
  const targets = entries
    .filter((entry, index) => index !== 0)
    .filter((entry) => !isMainCheckout(entry.path))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const { rows, counts } = classify(targets.map((entry) => factsFor(entry, mainSha)), { lockMinutes: LOCK_MINUTES })
  for (const row of rows) console.log(formatRow(row))
  console.log(formatSummary(counts))
  if (counts.reapable + counts.busy + counts.prunable !== counts.total) {
    console.error(`worktrees: classification does not add up for ${counts.total} entries`)
    process.exitCode = 1
  }
}

if (invokedDirectly(process.argv[1])) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`worktrees: ${error.message}`)
    process.exit(2)
  }
}
