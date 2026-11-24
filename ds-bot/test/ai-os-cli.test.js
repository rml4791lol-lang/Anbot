import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { clientModeFor } from '../dev/ai-os/cli.mjs'

test('the CLI explains missing attached credentials without a stack trace', () => {
  const runId = `cli-missing-cookie-${process.pid}`
  const result = spawnSync(process.execPath, [
    'dev/ai-os/cli.mjs',
    '--manifest', 'dev/ai-os/scenarios/attached-repository-check.json',
    '--mode', 'attached',
    '--run-id', runId,
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    env: { ...process.env, DSBOT_RUN_COOKIE: '' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /cookie/i)
  assert.doesNotMatch(result.stderr, /at file:|node:internal/)
  assert.equal(existsSync(fileURLToPath(new URL(`../../.aios-runs/${runId}`, import.meta.url))), false)
})

test('manifest modes map to the client that owns or attaches the runtime', () => {
  assert.equal(clientModeFor('mock'), 'owned')
  assert.equal(clientModeFor('attached'), 'attached')
})
