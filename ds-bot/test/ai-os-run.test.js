import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runManifest } from '../dev/ai-os/run.mjs'

const recorder = () => {
  const records = []
  const finished = []
  return {
    records,
    finished,
    bundle: {
      record: async entry => { records.push(entry) },
      finish: async result => { finished.push(result) },
    },
  }
}

const base = {
  schemaVersion: 1, id: 'x', title: 'x', modes: ['mock'], dataMode: 'mock', timeoutMs: 10_000,
  workspace: { kind: 'scratch', path: '.' }, steps: [],
}

test('a command step and a file acceptance produce completed', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'aios-run-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const log = recorder()
  const result = await runManifest({
    manifest: {
      ...base,
      steps: [{ id: 'write', kind: 'command', argv: [process.execPath, '-e', 'require("fs").writeFileSync("ok.txt","yes")'], cwd: '.', timeoutMs: 5_000 }],
      acceptance: [{ id: 'file', kind: 'file', path: 'ok.txt' }],
    },
    mode: 'mock', client: {}, bundle: log.bundle, workspace,
  })
  assert.equal(result.status, 'completed')
  assert.deepEqual(log.finished.map(row => row.status), ['completed'])
  assert.deepEqual(log.records.map(row => row.kind), ['command', 'acceptance'])
})

test('missing acceptance evidence fails the run', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'aios-run-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'bad.txt'), 'no')
  const log = recorder()
  const result = await runManifest({
    manifest: { ...base, acceptance: [{ id: 'missing', kind: 'file', path: 'ok.txt' }] },
    mode: 'mock', client: {}, bundle: log.bundle, workspace,
  })
  assert.equal(result.status, 'failed')
  assert.match(result.failure.message, /ok\.txt|ENOENT/)
  assert.equal(log.finished[0].status, 'failed')
})

test('a JSON pointer and minimum length prove acceptance', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'aios-run-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'state.json'), JSON.stringify({ bots: [{ id: 'one' }] }))
  const result = await runManifest({
    manifest: { ...base, acceptance: [{ id: 'bots', kind: 'json', path: 'state.json', pointer: '/bots', minLength: 1 }] },
    mode: 'mock', client: {}, bundle: recorder().bundle, workspace,
  })
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.acceptance, [{ id: 'bots', ok: true }])
})

test('an acceptance path cannot escape the workspace', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'aios-run-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const result = await runManifest({
    manifest: { ...base, acceptance: [{ id: 'outside', kind: 'file', path: '../outside.txt' }] },
    mode: 'mock', client: {}, bundle: recorder().bundle, workspace,
  })
  assert.equal(result.status, 'failed')
  assert.match(result.failure.message, /escapes workspace/)
})
