import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../scripts/gate.test.sh', import.meta.url))

// The gate is a shell script and these tests drive it as one, against scratch repositories; this
// runs them under `npm test` and shows their output when one fails.
test('the gate, its hooks and install-hooks.sh behave', () => {
  const run = spawnSync('sh', [script], { encoding: 'utf8', timeout: 110000 })
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
})
