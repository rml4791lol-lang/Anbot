import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('../../', import.meta.url)
const registry = JSON.parse(readFileSync(new URL('docs/reuse/code-reuse-registry.json', root), 'utf8'))
const candidateFields = [
  'id', 'name', 'repository', 'inspectedVersion', 'inspectedCommit', 'commitDate', 'license', 'maintained', 'runtime',
  'sourcePaths', 'testPaths', 'reusableMechanisms', 'limitations', 'reuseMode', 'finalDecision', 'adoptedCode', 'noticeRequiredNow',
]
const featureFields = [
  'id', 'title', 'status', 'existingDsBot', 'existingDsh', 'candidateIds', 'reuseMode', 'integrationCost', 'dependencies',
  'compatibility', 'finalDecision', 'migration', 'acceptance',
]

test('the reuse registry has unique, complete candidates and features', () => {
  assert.equal(registry.schemaVersion, 1)
  assert.match(registry.snapshotDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(registry.candidates.length > 0)
  assert.ok(registry.features.length > 0)

  const candidateIds = registry.candidates.map(candidate => candidate.id)
  assert.equal(new Set(candidateIds).size, candidateIds.length, 'candidate ids must be unique')
  for (const candidate of registry.candidates) {
    for (const field of candidateFields) assert.ok(field in candidate, `${candidate.id} is missing ${field}`)
    assert.ok(Array.isArray(candidate.sourcePaths) && candidate.sourcePaths.length > 0, `${candidate.id} has no source evidence`)
    assert.ok(Array.isArray(candidate.testPaths), `${candidate.id} has no testPaths array`)
    assert.ok(typeof candidate.adoptedCode === 'boolean', `${candidate.id} has no adoptedCode flag`)
  }

  const featureIds = registry.features.map(feature => feature.id)
  assert.equal(new Set(featureIds).size, featureIds.length, 'feature ids must be unique')
  const known = new Set(candidateIds)
  for (const feature of registry.features) {
    for (const field of featureFields) assert.ok(field in feature, `${feature.id} is missing ${field}`)
    assert.ok(['native', 'partial', 'missing'].includes(feature.status), `${feature.id} has an unknown status`)
    for (const id of feature.candidateIds) assert.ok(known.has(id), `${feature.id} references unknown candidate ${id}`)
  }
})

test('the reuse decision documents exist beside the machine registry', () => {
  for (const path of [
    'CODE_REUSE_MAP.md',
    'THIRD_PARTY_COMPONENTS.md',
    'THIRD_PARTY_NOTICES.md',
    'ARCHITECTURE_DECISIONS.md',
    'docs/reuse/README.md',
    'docs/reuse/code-reuse-registry.schema.json',
  ]) assert.equal(existsSync(new URL(path, root)), true, `${path} is missing`)
})
