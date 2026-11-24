import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { observeContextBudget } from '../src/host/bot-context-view.js'

const route = { provider: 'deepseek', model: 'flash', maxTokens: 2000 }
function session() {
  return { id: 'session', requestHeader: () => ({ config: route }) }
}

test('the context budget uses one captured meter revision and the thresholds for its request route', async () => {
  const read = await observeContextBudget(session(), {
    measure: () => ({ logRevision: 9, totalTokens: 2700, baseline: { kind: 'usage' }, nodes: [{ seq: 1 }, { seq: 7 }] }),
    limits: async seen => {
      assert.equal(seen, route)
      return { window: 10000, usable: 8000, hard: 7200, check: 4000 }
    },
  })
  assert.deepEqual(read, { status: 'observed', throughSequence: 8, usedTokens: 2700, measuredFrom: 'usage',
    window: 10000, usable: 8000, check: 4000, hard: 7200, surfaceNodes: 2 })
})

test('an unloaded meter, missing route and unknown capacity are explicit', async () => {
  const missing = () => assert.fail('there is no route to resolve')
  assert.deepEqual(await observeContextBudget({ requestHeader: () => undefined }, { measure: missing, limits: missing }),
    { status: 'unavailable', reason: 'no-request' })
  assert.deepEqual(await observeContextBudget(session(), { measure: () => undefined, limits: missing }),
    { status: 'unavailable', reason: 'meter-unavailable' })
  const measure = () => ({ logRevision: 2, totalTokens: 0, baseline: { kind: 'estimated' }, nodes: [] })
  assert.deepEqual(await observeContextBudget(session(), { measure, limits: async () => undefined }),
    { status: 'unavailable', reason: 'capacity-unavailable' })
})

test('native DSH projection traces nested replacements without changing the committed prefix', async t => {
  const ctx = new Context()
  ctx.provide('sessionProjections', { register() {} })
  ctx.provide('llm', { imageRequestPricing: () => undefined })
  await ctx.plugin(TokenMeter)
  t.after(() => ctx.fiber.dispose())
  const live = Session.create('provenance')
  const message = id => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text: id }] })
  const append = id => live.append('user/message', message(id), { surfaceOp: 'append' })
  const replace = (id, start, end, sources) => live.append('user/message', message(id), {
    surfaceOp: { op: 'replace', startSeq: start.seq, endSeq: end.seq }, sourceEventSeqs: sources.map(event => event.seq),
  })
  const first = append('first')
  const cited = live.append('turn/start', { turn: 1 })
  const gap = live.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const second = append('second')
  const prefix = live.snapshotEvents()
  const serialized = JSON.stringify(prefix)
  const brief = replace('brief', first, second, [first, cited, second])
  const recent = append('recent')
  const joined = replace('joined', brief, recent, [brief, recent])
  const tail = append('tail')
  live.append('request/header', { header: { config: route } })
  const throughSequence = live.seq - 1
  const measured = ctx.tokenMeter.measure(live)
  assert.ok(measured.totalTokens > 0)
  const observed = await observeContextBudget(live, {
    measure: session => ctx.tokenMeter.measure(session),
    limits: async () => {
      append('after-capture')
      return undefined
    },
  })
  assert.deepEqual(live.deriveMessages().map(item => item.id), ['joined', 'tail', 'after-capture'])
  assert.equal(JSON.stringify(live.snapshotEvents(0, prefix.length)), serialized)
  assert.equal(observed.reason, 'capacity-unavailable')
  const { at, ...used } = observed.projection.usedTokens
  assert.ok(Number.isFinite(at))
  assert.deepEqual(used, { status: 'observed', value: measured.totalTokens, source: 'DSH TokenMeter' })
  assert.deepEqual(observed.projection.limitTokens, { status: 'unavailable', reason: 'capacity-unavailable' })
  assert.equal(observed.projection.sessionId, live.id)
  assert.equal(observed.projection.throughSequence, throughSequence)
  assert.deepEqual(observed.projection.retainedMessageIds, ['joined', 'tail'])
  assert.deepEqual(observed.projection.sourceRanges, [{ from: first.seq, through: cited.seq }, { from: second.seq, through: tail.seq }])
  assert.ok(observed.projection.sourceRanges.every(range => gap.seq < range.from || gap.seq > range.through))
  assert.deepEqual(observed.projection.replacements, [
    { sequence: brief.seq, start: first.seq, end: second.seq, sourceSequences: [first.seq, cited.seq, second.seq] },
    { sequence: joined.seq, start: brief.seq, end: recent.seq, sourceSequences: [brief.seq, recent.seq] },
  ])
})
