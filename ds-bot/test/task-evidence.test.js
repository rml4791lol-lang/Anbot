import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PendingCallCache,
  evidenceFromEvents,
  invalidateAcceptance,
  normalizeAcceptanceChecks,
  progressAfterTurn,
  progressFingerprint,
  verifyAcceptance,
} from '../src/host/task-evidence.js'

const textBlock = text => [{ type: 'text', text }]

test('typed hand-off checks default command success to exit 0 and reject prose checks', () => {
  assert.deepEqual(normalizeAcceptanceChecks([
    { id: 'tests', kind: 'command', command: 'npm test' },
    { id: 'artifact', kind: 'artifact', path: 'dist/app.zip', expect: { digest: 'sha256:abc' } },
  ]).checks, [
    { id: 'tests', kind: 'command', label: 'npm test', required: true, command: 'npm test', expect: { exitCode: 0 } },
    { id: 'artifact', kind: 'artifact', label: 'dist/app.zip', required: true, path: 'dist/app.zip', expect: { digest: 'sha256:abc' } },
  ])
  assert.match(normalizeAcceptanceChecks([{ id: 'done', kind: 'manual' }]).error, /command, artifact, or diff/)
  assert.match(normalizeAcceptanceChecks('done').error, /must be an array/)
  assert.equal(normalizeAcceptanceChecks([{ id: 'tests', kind: 'command', command: 'npm test', expect: { exitCode: 1 } }]).checks[0].expect.exitCode, 1)
  assert.match(normalizeAcceptanceChecks([
    { id: 'same', kind: 'command', command: 'npm test' },
    { id: 'same', kind: 'command', command: 'npm run test' },
  ]).error, /repeated/)
})

test('only an exact successful command result satisfies a command check', () => {
  const evidence = evidenceFromEvents({
    sessionId: 's1',
    actor: { botId: 'b1' },
    events: [
      { seq: 1, time: 10, type: 'assistant/message', data: { message: { content: textBlock('done') } } },
      { seq: 2, time: 11, type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) } },
      { seq: 3, time: 12, type: 'tool/result', data: { callId: 'c1', message: { ok: true, content: textBlock('tests pass') } } },
    ],
  })
  assert.deepEqual(evidence.map(item => item.state), ['reported', 'executed'])
  assert.equal(evidence[1].command.text, 'npm test')
  assert.equal(evidence[1].command.exitCode, 0)
  assert.match(evidence[1].command.outputDigest, /^sha256:[a-f0-9]{64}$/)

  const check = { id: 'c1', kind: 'command', label: 'tests', required: true, command: 'npm test', expect: { exitCode: 0 } }
  assert.equal(verifyAcceptance({ checks: [check], evidence, now: 13 }).state, 'verified')
  assert.equal(verifyAcceptance({ checks: [{ ...check, command: 'npm run test' }], evidence, now: 13 }).state, 'pending')
  assert.equal(verifyAcceptance({ checks: [{ ...check, expect: { exitCode: 1 } }], evidence, now: 13 }).state, 'pending')
})

test('a spoofed tool name cannot create command evidence', () => {
  const evidence = evidenceFromEvents({
    sessionId: 's1',
    events: [
      { seq: 1, time: 10, type: 'tool/call', data: { callId: 'c1', name: 'report_command', arguments: JSON.stringify({ command: 'npm test' }) } },
      { seq: 2, time: 11, type: 'tool/result', data: { callId: 'c1', message: { ok: true, content: textBlock('green') } } },
    ],
  })
  assert.equal(evidence[0].command, undefined)
  assert.equal(verifyAcceptance({
    checks: [{ id: 'tests', kind: 'command', command: 'npm test', expect: { exitCode: 0 } }],
    evidence,
    now: 12,
  }).state, 'pending')
})

test('artifact and diff checks bind exact digests and go stale when those change', () => {
  const evidence = evidenceFromEvents({
    sessionId: 's1',
    events: [
      { seq: 1, time: 10, type: 'deliverables/presented', data: { files: [{ path: 'dist/app.zip', digest: 'sha256:artifact' }] } },
      { seq: 2, time: 11, type: 'tool/call', data: { callId: 'd1', name: 'edit', arguments: '{}' } },
      { seq: 3, time: 12, type: 'tool/result', data: { callId: 'd1', message: { ok: true, content: textBlock('edited'), meta: { diffs: [{ path: 'src/app.js', oldText: 'a', newText: 'b' }] } } } },
    ],
  })
  const diff = evidence.find(item => item.state === 'executed' && item.diff !== undefined)
  assert.deepEqual(diff.diff.paths, ['src/app.js'])
  assert.match(diff.diff.digest, /^sha256:[a-f0-9]{64}$/)

  const checks = [
    { id: 'artifact', kind: 'artifact', path: 'dist/app.zip', expect: { digest: 'sha256:artifact' } },
    { id: 'diff', kind: 'diff', path: 'src/app.js', expect: { digest: diff.diff.digest } },
  ]
  const verified = verifyAcceptance({ checks, evidence, now: 13 })
  assert.equal(verified.state, 'verified')
  assert.deepEqual(verified.artifactDigests, { 'dist/app.zip': 'sha256:artifact' })
  assert.deepEqual(verified.diffDigests, { 'src/app.js': diff.diff.digest })

  const stale = invalidateAcceptance(verified, {
    artifacts: { 'dist/app.zip': 'sha256:changed' },
    diffs: { 'src/app.js': 'sha256:changed-diff' },
  }, 14)
  assert.equal(stale.state, 'stale')
  assert.deepEqual(stale.invalidated, ['dist/app.zip', 'src/app.js'])
})

test('every required check must bind its own matching evidence', () => {
  const evidence = evidenceFromEvents({
    sessionId: 's1',
    events: [
      { seq: 1, time: 10, type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) } },
      { seq: 2, time: 11, type: 'tool/result', data: { callId: 'c1', message: { ok: true, content: textBlock('green') } } },
    ],
  })
  const checks = [
    { id: 'tests', kind: 'command', command: 'npm test', expect: { exitCode: 0 } },
    { id: 'artifact', kind: 'artifact', path: 'dist/app.zip', expect: { digest: 'sha256:app' } },
  ]
  const verification = verifyAcceptance({ checks, evidence, now: 12 })
  assert.equal(verification.state, 'pending')
  assert.deepEqual(verification.missing, ['artifact'])
  assert.deepEqual(verification.checks.map(item => [item.id, item.status]), [['tests', 'verified'], ['artifact', 'pending']])
})

test('one evidence record cannot satisfy two declared checks', () => {
  const evidence = evidenceFromEvents({
    sessionId: 's1',
    events: [
      { seq: 1, time: 10, type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) } },
      { seq: 2, time: 11, type: 'tool/result', data: { callId: 'c1', message: { ok: true, content: textBlock('green') } } },
    ],
  })
  const verification = verifyAcceptance({
    checks: [
      { id: 'first', kind: 'command', command: 'npm test', expect: { exitCode: 0 } },
      { id: 'second', kind: 'command', command: 'npm test', expect: { exitCode: 0 } },
    ],
    evidence,
    now: 12,
  })
  assert.equal(verification.state, 'pending')
  assert.deepEqual(verification.missing, ['second'])
})

test('two completed turns without new executed evidence stall the task', () => {
  const reported = name => [{ id: name, state: 'reported', summary: name }]
  const first = progressAfterTurn(undefined, reported('looks good'), { now: 10, limit: 2 })
  assert.deepEqual([first.state, first.unchangedTurns], ['moving', 1])
  const second = progressAfterTurn(first, reported('still looks good'), { now: 11, limit: 2 })
  assert.deepEqual([second.state, second.unchangedTurns], ['stalled', 2])
})

test('new executed evidence resets the no-progress count', () => {
  const first = progressAfterTurn(undefined, [], { now: 10, limit: 2 })
  const executed = [{ id: 'ev-1', state: 'executed', source: 'tool-result', command: { text: 'npm test', exitCode: 0 }, at: 11 }]
  const second = progressAfterTurn(first, executed, { now: 11, limit: 2 })
  assert.deepEqual([second.state, second.unchangedTurns], ['moving', 0])
  const third = progressAfterTurn(second, executed, { now: 12, limit: 2 })
  assert.deepEqual([third.state, third.unchangedTurns], ['moving', 1])
})

test('repeating the same measurable evidence later does not look like progress', () => {
  const turn = (id, at, outputDigest = 'sha256:same') => [{
    id,
    state: 'executed',
    source: 'tool-result',
    command: { text: 'npm test', exitCode: 0, outputDigest },
    artifact: { path: 'dist/app.zip', digest: 'sha256:app' },
    diff: { paths: ['src/app.js'], digest: 'sha256:diff' },
    at,
  }]
  const first = progressAfterTurn(undefined, turn('ev-1', 10), { now: 10, limit: 2 })
  const repeated = progressAfterTurn(first, turn('ev-2', 11), { now: 11, limit: 2 })
  const repeatedAgain = progressAfterTurn(repeated, turn('ev-3', 12), { now: 12, limit: 2 })
  assert.deepEqual([repeated.state, repeated.unchangedTurns], ['moving', 1])
  assert.deepEqual([repeatedAgain.state, repeatedAgain.unchangedTurns], ['stalled', 2])
  assert.notEqual(progressFingerprint(turn('ev-4', 13, 'sha256:changed')), progressFingerprint(turn('ev-5', 14)))
})

test('the turn-end baseline lets repeated productive evidence stay moving', () => {
  let progress = {
    state: 'moving',
    fingerprint: progressFingerprint([]),
    lastTurnFingerprint: progressFingerprint([]),
    unchangedTurns: 0,
  }
  for (let turn = 1; turn <= 3; turn += 1) {
    const evidence = [{ id: `ev-${turn}`, state: 'executed', source: 'tool-result', command: { text: `command-${turn}`, exitCode: 0 }, at: turn }]
    const fingerprint = progressFingerprint(evidence)
    progress = { ...progress, fingerprint }
    progress = progressAfterTurn(progress, evidence, { now: turn, limit: 2 })
    assert.deepEqual([progress.state, progress.unchangedTurns], ['moving', 0])
  }
})

test('a missing current artifact or diff digest invalidates verified acceptance', () => {
  const verification = {
    state: 'verified', status: 'verified',
    artifactDigests: { 'dist/app.zip': 'sha256:first' },
    diffDigests: { 'src/app.js': 'sha256:diff' },
  }
  const stale = invalidateAcceptance(verification, {
    artifacts: { 'dist/app.zip': undefined },
    diffs: { 'src/app.js': undefined },
  }, 14)
  assert.equal(stale.state, 'stale')
  assert.deepEqual(stale.invalidated, ['dist/app.zip', 'src/app.js'])
})

test('the pending tool-call cache is bounded and removes results it consumes', () => {
  const cache = new PendingCallCache({ limit: 2 })
  cache.remember('s', '1', { data: { callId: '1' } })
  cache.remember('s', '2', { data: { callId: '2' } })
  cache.remember('s', '3', { data: { callId: '3' } })
  assert.equal(cache.size, 2)
  assert.equal(cache.take('s', '1'), undefined)
  assert.deepEqual(cache.take('s', '3')?.data, { callId: '3' })
  assert.equal(cache.size, 1)
  cache.clearSession('s')
  assert.equal(cache.size, 0)
})

test('command exit and artifact digest must be present, not merely implied', () => {
  const evidence = evidenceFromEvents({
    sessionId: 's1',
    events: [
      { seq: 1, time: 10, type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) } },
      { seq: 2, time: 11, type: 'tool/result', data: { callId: 'c1', message: { content: textBlock('unknown') } } },
      { seq: 3, time: 12, type: 'deliverables/presented', data: { files: [{ path: 'dist/app.zip' }] } },
    ],
  })
  assert.equal(verifyAcceptance({
    checks: [{ id: 'tests', kind: 'command', command: 'npm test', expect: { exitCode: 0 } }],
    evidence,
    now: 13,
  }).state, 'pending')
  assert.equal(verifyAcceptance({
    checks: [{ id: 'artifact', kind: 'artifact', path: 'dist/app.zip' }],
    evidence,
    now: 13,
  }).state, 'pending')
})
