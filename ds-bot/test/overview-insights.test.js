import test from 'node:test'
import assert from 'node:assert/strict'
import { detectProjectProfile, documentSummary, memoryOwnerSummary, packageChecks, qualitySummary, standardsManifest, standardSummary } from '../src/host/overview-insights.js'

test('standardSummary counts rules and keeps official links', () => {
  const summary = standardSummary([
    '# Project rules',
    '- Run the tests before shipping.',
    '- Keep the API stable.',
    '## Sources',
    'Read https://example.com/spec and https://example.com/spec.',
  ].join('\n'))
  assert.deepEqual(summary.headings, ['Project rules', 'Sources'])
  assert.equal(summary.rules, 2)
  assert.deepEqual(summary.ruleLines, ['Run the tests before shipping.', 'Keep the API stable.'])
  assert.deepEqual(summary.sources, ['https://example.com/spec'])
})

test('packageChecks lists only known scripts, in a stable order', () => {
  assert.deepEqual(packageChecks(JSON.stringify({ scripts: { build: 'vite build', test: 'node --test', watch: 'watcher' } })), [
    { name: 'test', command: 'node --test' },
    { name: 'build', command: 'vite build' },
  ])
  assert.deepEqual(packageChecks('not json'), [])
})

test('memoryOwnerSummary keeps a short, read-only owner view', () => {
  const view = {
    entries: [
      { scope: 'own', topic: 'Release', text: 'A'.repeat(200), added: '2026-11-15' },
      { scope: 'own', topic: 'Release', text: 'Ship the small fix.', added: '2026-11-16' },
      { scope: 'team', topic: 'Shared', text: 'Not this owner.', added: '2026-11-16' },
    ],
    sizes: { own: 24 },
    limits: { own: 8000 },
  }
  const summary = memoryOwnerSummary(view, 'own')
  assert.equal(summary.count, 2)
  assert.deepEqual(summary.topics, ['Release'])
  assert.equal(summary.recent[0].text, 'Ship the small fix.')
  assert.equal(summary.recent[0].added, '2026-11-16')
  assert.equal(summary.recent[1].text.length, 161)
})


test('qualitySummary reads recorded check evidence without inventing a result', () => {
  const report = qualitySummary(JSON.stringify({ checkedAt: '2026-11-16T10:00:00Z', expected: 12, passed: 10, total: 12, checks: [{ name: 'lint', status: 'passed' }, { name: 'test', status: 'failed' }] }))
  assert.equal(report.expected, 12)
  assert.equal(report.passed, 10)
  assert.deepEqual(report.checks.map(check => check.status), ['passed', 'failed'])
  assert.equal(qualitySummary('{}'), undefined)
})


test('standardsManifest keeps declared profile, official sources and required evidence', () => {
  const manifest = standardsManifest(JSON.stringify({
    profile: 'miniprogram', name: 'WeChat mini program',
    sources: [{ name: 'Mini program design guide', url: 'https://developers.weixin.qq.com/miniprogram/design/', scope: ['UI', 'navigation'], checkedAt: '2026-11-16' }],
    requiredFiles: ['miniprogram/app.json', '../secret'], requiredChecks: ['lint', 'privacy'],
  }))
  assert.equal(manifest.profile, 'miniprogram')
  assert.equal(manifest.sources[0].scope[1], 'navigation')
  assert.deepEqual(manifest.requiredFiles, ['miniprogram/app.json'])
  assert.deepEqual(manifest.requiredChecks, ['lint', 'privacy'])
})

test('project profiles use a declared pack first, then real project markers', () => {
  assert.deepEqual(detectProjectProfile(['project.config.json', 'app.json'], null), { id: 'miniprogram', declared: false })
  assert.deepEqual(detectProjectProfile(['STORYBOARD.md'], null), { id: 'video', declared: false })
  assert.deepEqual(detectProjectProfile(['notes.txt'], { profile: 'video' }), { id: 'video', declared: true })
  assert.deepEqual(detectProjectProfile(['notes.txt'], null), { id: 'generic', declared: false })
})

test('documentSummary gives headings and a short human-readable description', () => {
  const summary = documentSummary('# Product\n\nA tool for **teams**.\n\n## Setup\nRun it.')
  assert.deepEqual(summary.headings, ['Product', 'Setup'])
  assert.match(summary.excerpt, /A tool for teams/)
})
