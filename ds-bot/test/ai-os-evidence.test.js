import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBundle, sha256File } from '../dev/ai-os/evidence.mjs'

test('events are append-only and secrets are redacted', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'aios-evidence-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const bundle = await createBundle({ runDir, manifest: { id: 'x' }, mode: 'mock', secrets: ['secret-cookie'] })
  await bundle.record({ kind: 'command', command: ['echo', 'secret-cookie'], exitCode: 0 })
  await bundle.record({ kind: 'note', text: 'token=abc123' })
  await bundle.finish({ status: 'completed' })
  const events = await readFile(join(runDir, 'events.jsonl'), 'utf8')
  assert.doesNotMatch(events, /secret-cookie/)
  assert.doesNotMatch(events, /abc123/)
  assert.match(events, /\[REDACTED\]/)
  assert.equal(events.trim().split('\n').length, 2)
  const result = JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8'))
  assert.equal(result.status, 'completed')
})

test('manifest metadata is written before events and files can be hashed', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'aios-evidence-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const bundle = await createBundle({ runDir, manifest: { id: 'restart-team' }, mode: 'attached' })
  const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.manifest, { id: 'restart-team' })
  assert.equal(manifest.mode, 'attached')
  const artifact = join(runDir, 'artifact.txt')
  await writeFile(artifact, 'hello\n')
  assert.match(await sha256File(artifact), /^[0-9a-f]{64}$/)
  await bundle.finish({ status: 'completed' })
})

test('finishing twice preserves the first immutable result', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'aios-evidence-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const bundle = await createBundle({ runDir, manifest: { id: 'x' }, mode: 'mock' })
  await bundle.finish({ status: 'completed' })
  const first = await readFile(join(runDir, 'result.json'), 'utf8')
  await assert.rejects(bundle.finish({ status: 'failed' }), /already finished/)
  assert.equal(await readFile(join(runDir, 'result.json'), 'utf8'), first)
})

test('structured credentials are redacted before they reach evidence', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'aios-evidence-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const bundle = await createBundle({ runDir, manifest: { id: 'x' }, mode: 'mock' })
  await bundle.record({
    kind: 'request',
    headers: { authorization: 'Bearer super-secret', cookie: 'session=session-secret' },
    body: { apiKey: 'api-key-secret', nested: { password: 'password-secret' }, note: 'Bearer another-secret' },
  })
  await bundle.finish({ status: 'completed' })
  const text = await readFile(join(runDir, 'events.jsonl'), 'utf8')
  for (const secret of ['super-secret', 'session-secret', 'api-key-secret', 'password-secret', 'another-secret']) {
    assert.doesNotMatch(text, new RegExp(secret))
  }
  assert.match(text, /\[REDACTED\]/)
})
