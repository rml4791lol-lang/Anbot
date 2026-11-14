import test from 'node:test'
import assert from 'node:assert/strict'
import { summarize, candidates, share, parseLedger, checkProposal } from '../dev/digest.mjs'

const row = (turn, extra = {}) => ({
  ts: Date.parse('2026-11-14T10:00:00+08:00'),
  bot: '写手', session: 's1', turn, seed: { kind: 'user' },
  context: { bytes: 0, sources: {} }, tools: { used: [], errors: 0 },
  final_chars: 10, outcome: 'completed', ...extra
})

test('a rate without a denominator says n/a, not zero', () => {
  assert.equal(share(0, 0), 'n/a')
  assert.equal(share(1, 4), '1/4 (25%)')
})

test('bad ledger lines are skipped instead of crashing the digest', () => {
  assert.deepEqual(parseLedger('{"turn":1}\nnot json\n'), [{ turn: 1 }])
})

test('summarize counts only Bot turns and keeps denominators attached', () => {
  const s = summarize([
    row(1, { tools: { used: ['bash'], errors: 0 }, context: { bytes: 100, sources: { openviking: 100 } } }),
    row(2, { tools: { used: [], errors: 1 }, final_chars: 0, outcome: 'aborted' }),
    { ts: Date.now(), session: 's2', turn: 1, bot: null }
  ])
  assert.equal(s.turns, 2)
  assert.equal(s.tools.zero, '1/2 (50%)')
  assert.equal(s.emptyAnswers, '1/2 (50%)')
  assert.equal(s.context.sources.openviking, 100)
})

test('candidates rank failures above empty answers above big injections', () => {
  const picks = candidates([
    row(1, { context: { bytes: 20000, sources: {} } }),
    row(2, { final_chars: 0 }),
    row(3, { tools: { used: [], errors: 2 } }),
    row(4)
  ])
  assert.deepEqual(picks.map(p => p.turn), ['s1#3', 's1#2', 's1#1'])
})

test('a proposal without a rollback section is refused', () => {
  const without = '# 提议\n\n## 假设\nA\n\n## 证据\nB\n\n## 改动\nC\n\n## 预期指标\nD\n'
  assert.deepEqual(checkProposal(without), { ok: false, missing: ['回滚'] })
  const withRollback = without + '\n## 回滚\nrevert abc123\n'
  assert.deepEqual(checkProposal(withRollback), { ok: true, missing: [] })
})
