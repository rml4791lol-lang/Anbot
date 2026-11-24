import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadManifest, validateManifest } from '../dev/ai-os/manifest.mjs'

const valid = {
  schemaVersion: 1,
  id: 'restart-team',
  title: 'Restart preserves the team',
  modes: ['mock'],
  dataMode: 'mock',
  workspace: { kind: 'scratch', path: 'workspace' },
  timeoutMs: 30_000,
  steps: [{ id: 'state', kind: 'api', endpoint: 'state', payload: {} }],
  acceptance: [{ id: 'bots', kind: 'json', path: 'state.json', pointer: '/bots', minLength: 1 }],
}

test('a valid manifest has no problems', () => {
  assert.deepEqual(validateManifest(valid), [])
})

test('mock and attached modes have different mandatory inputs', () => {
  assert.match(validateManifest({ ...valid, modes: ['attached'], dataMode: 'live' }).join('\n'), /baseUrl/)
  assert.match(validateManifest({ ...valid, dataMode: 'preview' }).join('\n'), /dataMode/)
})

test('steps reject shell strings and unknown kinds', () => {
  const bad = structuredClone(valid)
  bad.steps = [{ id: 'x', kind: 'shell', command: 'echo should not run' }]
  assert.match(validateManifest(bad).join('\n'), /unknown step kind/)
})

test('the attached harness can name a worktree workspace', () => {
  assert.deepEqual(validateManifest({ ...valid, modes: ['attached'], dataMode: 'live', baseUrl: 'http://127.0.0.1:3080', workspace: { kind: 'worktree', path: '.' } }), [])
})

test('workspace kinds and relative scratch paths are checked', () => {
  assert.match(validateManifest({ ...valid, workspace: { kind: 'unknown', path: 'workspace' } }).join('\n'), /workspace kind/)
  assert.match(validateManifest({ ...valid, workspace: { kind: 'scratch', path: '../outside' } }).join('\n'), /relative path/)
  assert.match(validateManifest({ ...valid, workspace: { kind: 'existing', path: '' } }).join('\n'), /workspace path/)
})

test('loadManifest returns the parsed manifest and reports validation errors', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsb-ai-os-manifest-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const good = join(dir, 'good.json')
  const bad = join(dir, 'bad.json')
  await writeFile(good, JSON.stringify(valid))
  await writeFile(bad, JSON.stringify({ ...valid, id: '' }))
  assert.deepEqual(await loadManifest(good), valid)
  await assert.rejects(loadManifest(bad), error => error.code === 'AIOS_MANIFEST' && /id must be/.test(error.message))
})
