import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, summarize } from '../dev/eval/failures.mjs'

test('a delivered answer that misses the point is a content failure', () => {
  const result = classify({ delivered: true, text: 'done', detail: 'no match for 压缩|compact' })
  assert.deepEqual([result.kind, result.class], ['content', 'wrong-delivery'])
})

test('no delivery at all is a process failure even without a recognised marker', () => {
  const result = classify({ delivered: false, text: '', detail: 'no answer file' })
  assert.deepEqual([result.kind, result.class], ['process', 'no-delivery'])
})

test('a step limit named in the answer is classified from its text', () => {
  const result = classify({ delivered: false, text: 'Stopped: max steps reached after 40 calls.', detail: '' })
  assert.deepEqual([result.kind, result.class], ['process', 'step-limit'])
})

test('a blocked tool is a process failure and keeps the evidence', () => {
  const result = classify({ delivered: true, text: 'bash: not in checks.allow', detail: '' })
  assert.equal(result.kind, 'process')
  assert.equal(result.class, 'tool-blocked')
  assert.equal(result.evidence, 'not in checks.allow')
})

test('a passing task gets no class and summary counts kinds', () => {
  const rows = [
    { id: 'a', failed: false, kind: null, class: null },
    { id: 'b', failed: true, kind: 'process', class: 'turn-crash' },
    { id: 'c', failed: true, kind: 'content', class: 'wrong-delivery' }
  ]
  const summary = summarize(rows)
  assert.equal(summary.failed, 2)
  assert.deepEqual(summary.byKind, { process: 1, content: 1 })
})
