// The Claude Code control protocol only accepts a permission answer it can parse.
// A deny without a message is not one: the CLI reports "invalid permission
// result" and the turn hangs, which is what a review Bot hit on `md5`.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GATE_SCRIPT_DIRS, gateScriptTools, permissionResponse, readOnlyTools } from '../src/host/local-agents/claude.js'

test('a denied permission result is well formed, readable and serializable', () => {
  const result = permissionResponse('req-12', 'deny', { command: 'md5 final.mp4' })
  assert.equal(result.type, 'control_response')
  assert.equal(result.response.subtype, 'success')
  assert.equal(result.response.request_id, 'req-12')
  const inner = result.response.response
  assert.equal(inner.behavior, 'deny')
  assert.equal(typeof inner.message, 'string')
  assert.ok(inner.message.trim() !== '', 'a deny must carry a reason')
  // The shape the CLI rejected: `{ behavior: 'deny' }` alone is not valid.
  assert.notEqual(JSON.stringify(inner), JSON.stringify({ behavior: 'deny' }))
  assert.doesNotThrow(() => JSON.stringify(result))
})

test('an allowed permission hands the tool input back', () => {
  const result = permissionResponse('req-13', 'allow', { command: 'ls' })
  assert.deepEqual(result.response.response, { behavior: 'allow', updatedInput: { command: 'ls' } })
})

test('read-only verification commands need no approval', () => {
  const tools = readOnlyTools()
  for (const command of ['md5', 'md5sum', 'shasum', 'ffprobe', 'stat', 'wc']) {
    assert.ok(tools.includes(`Bash(${command}:*)`), `${command} must be allowed`)
  }
  assert.ok(tools.includes('Bash(ffmpeg -i:*)'), 'ffmpeg -i must be allowed')
})

// A review has to run the team's own checks instead of describing what it read.
// Issue: `bash 内容/bin/research-gate.sh` stopped on an approval card.
test("the team's gate scripts run with their arguments, and nothing else", (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-gate-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'ds-bot-elsewhere-'))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  })
  writeFileSync(join(dir, 'research-gate.sh'), '#!/bin/sh\nexit 0\n')
  writeFileSync(join(dir, 'notes.txt'), '')
  writeFileSync(join(dir, '.hidden.sh'), '')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'inner.sh'), '')
  writeFileSync(join(elsewhere, 'evil.sh'), '#!/bin/sh\n')
  symlinkSync(join(elsewhere, 'evil.sh'), join(dir, 'link.sh'))

  const tools = readOnlyTools([dir])
  const scriptPath = realpathSync(join(dir, 'research-gate.sh'))
  const rule = `Bash(bash ${scriptPath}:*)`
  assert.ok(tools.includes(rule), 'a gate script must run without a card')
  // The whole form matters: the CLI takes `Bash(<prefix>:*)`, and a `*` inside the
  // path is matched literally, so a pattern rule would admit nothing.
  const prefix = 'Bash(bash '
  const suffix = ':*)'
  assert.ok(rule.startsWith(prefix) && rule.endsWith(suffix), 'the rule is a Bash(bash <path>:*) form')
  assert.equal(rule.slice(prefix.length, rule.length - suffix.length), scriptPath, 'the rule carries the exact full script path')

  const scripts = tools.filter(tool => tool.startsWith('Bash(bash '))
  assert.deepEqual(scripts, [rule], 'one rule per script in the folder, and no other')
  assert.ok(!tools.some(tool => tool.includes('notes.txt')), 'a file that is not a script is not a rule')
  assert.ok(!tools.some(tool => tool.includes('inner.sh')), 'a script in a subfolder is not covered')
  assert.ok(!tools.some(tool => tool.includes('.hidden.sh')), 'a hidden file is not a rule')
  assert.ok(!tools.some(tool => tool.includes('evil.sh')), 'a link that leaves the folder is refused')
  // Anything outside those folders still asks: /tmp/evil.sh is not a team gate.
  assert.ok(!gateScriptTools().some(tool => tool.includes('evil.sh')), 'a script outside the gate folders never gets a rule')
  assert.ok(!readOnlyTools([dir]).some(tool => tool.includes('/tmp/evil.sh')))
})

test('the gate folders are the team rule folders', () => {
  const atlasHome = join(homedir(), 'Desktop', 'Atlas')
  assert.deepEqual(GATE_SCRIPT_DIRS, [
    join(atlasHome, '内容', 'bin'),
    join(atlasHome, '任务标准规范规则', 'bin'),
  ])
})
