import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeJudgeRun, summarizeStability } from '../dev/eval/stability.mjs'

const row = (id, verdict, scores = [2, 2, 2, 2]) => ({
  id,
  verdict,
  scores: { accuracy: scores[0], completeness: scores[1], usefulness: scores[2], signal: scores[3] },
  error: null
})

test('identical verdicts give agreement 1 and no instability', () => {
  const runs = [
    [row('a', 'pass'), row('b', 'fail')],
    [row('a', 'pass'), row('b', 'fail')],
    [row('a', 'pass'), row('b', 'fail')]
  ]
  const summary = summarizeStability(runs)
  assert.equal(summary.agreement, 1)
  assert.equal(summary.unanimousTasks, 2)
  assert.deepEqual(summary.unstable, [])
  assert.equal(summary.decision, 'trustworthy')
})

test('a flipping verdict counts each disagreeing pair', () => {
  const runs = [
    [row('a', 'pass')],
    [row('a', 'pass')],
    [row('a', 'partial')]
  ]
  const summary = summarizeStability(runs)
  assert.equal(summary.comparisons, 3)
  assert.equal(summary.agreeing, 1)
  assert.equal(summary.agreement, 1 / 3)
  assert.deepEqual(summary.unstable, [{ id: 'a', verdicts: ['pass', 'pass', 'partial'] }])
  assert.equal(summary.decision, 'inconclusive')
})

test('an errored run is reported but never compared', () => {
  const runs = [
    [row('a', 'pass')],
    [{ id: 'a', verdict: 'error', scores: {}, error: 'exit 1' }],
    [row('a', 'pass')]
  ]
  const summary = summarizeStability(runs)
  assert.equal(summary.errors, 1)
  assert.equal(summary.comparisons, 1)
  assert.equal(summary.agreement, 1)
})

test('per-dimension variance is the population variance across runs', () => {
  const runs = [
    [row('a', 'pass', [0, 2, 2, 2])],
    [row('a', 'pass', [2, 2, 2, 2])],
    [row('a', 'pass', [2, 2, 2, 2])]
  ]
  const summary = summarizeStability(runs)
  // scores 0, 2, 2: mean 4/3, population variance 8/9.
  assert.ok(Math.abs(summary.dimensions.accuracy.maxVariance - 8 / 9) < 1e-12)
  assert.equal(summary.dimensions.accuracy.maxVarianceId, 'a')
  assert.equal(summary.dimensions.signal.meanVariance, 0)
})

test('the threshold decides which side the number falls on', () => {
  const runs = [
    [row('a', 'pass')],
    [row('a', 'pass')],
    [row('a', 'pass')],
    [row('a', 'partial')]
  ]
  // 6 pairs, 3 agreeing → 0.5
  assert.equal(summarizeStability(runs).decision, 'inconclusive')
  assert.equal(summarizeStability(runs, { threshold: 0.5 }).decision, 'trustworthy')
})

test('normalizeJudgeRun keeps scores and turns failed calls into errors', () => {
  const normalized = normalizeJudgeRun([
    { id: 'a', error: 'answer missing' },
    { id: 'b', runsOut: [{ verdict: 'pass', accuracy: 2, completeness: 1, usefulness: 2, signal: 0, cached: false }] },
    { id: 'c', runsOut: [{ verdict: 'maybe', accuracy: 1, completeness: 1, usefulness: 1, signal: 1 }] }
  ])
  assert.equal(normalized[0].verdict, 'error')
  assert.equal(normalized[0].error, 'answer missing')
  assert.deepEqual(normalized[1].scores, { accuracy: 2, completeness: 1, usefulness: 2, signal: 0 })
  assert.equal(normalized[1].error, null)
  assert.equal(normalized[2].verdict, 'error')
})
