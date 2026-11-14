// The Claude Code control protocol only accepts a permission answer it can parse.
// A deny without a message is not one: the CLI reports "invalid permission
// result" and the turn hangs, which is what a review Bot hit on `md5`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { permissionResponse, readOnlyTools } from '../src/host/local-agents/claude.js'

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
