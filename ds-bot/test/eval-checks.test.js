import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runChecks, allowedCommands } from '../dev/eval/checks.mjs'

const dir = mkdtempSync(join(tmpdir(), 'checks-'))
writeFileSync(join(dir, 'ok.md'), 'done: 42 rows\n')
const allow = ['node -e "process.exit(0)"']

test('a task passes when every check finds its trace', () => {
  const result = runChecks({ id: 'a', checks: [{ kind: 'file_exists', path: 'ok.md' }, { kind: 'grep', path: 'ok.md', pattern: '42 rows' }] }, { cwd: dir, allow })
  assert.equal(result.passed, true)
  assert.equal(result.total, 2)
})

test('a missing file fails the whole task', () => {
  const result = runChecks({ id: 'b', checks: [{ kind: 'file_exists', path: 'nope.md' }] }, { cwd: dir, allow })
  assert.equal(result.passed, false)
  assert.match(result.results[0].detail, /missing/)
})

test('a command outside the allowlist never runs', () => {
  const result = runChecks({ id: 'c', checks: [{ kind: 'exit_zero', cmd: 'rm -rf /' }] }, { cwd: dir, allow })
  assert.equal(result.passed, false)
  assert.match(result.results[0].detail, /allow/)
})

test('a task with no checks is not counted as a pass', () => {
  const result = runChecks({ id: 'd' }, { cwd: dir, allow })
  assert.equal(result.total, 0)
  assert.equal(result.passed, false)
})

test('the shipped allowlist only names scripts in this repo', () => {
  for (const cmd of allowedCommands()) assert.match(cmd, /^node dev\/eval\//)
})
