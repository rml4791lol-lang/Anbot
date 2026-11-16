import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runRealityGate } from './reality-gate.mjs'

test('Reality Gate proves Chief, Forge, restart, then one Prism review with typed evidence', async () => {
  const result = await runRealityGate()
  const output = fileURLToPath(new URL('./reality-gate-evidence.json', import.meta.url))
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)

  assert.equal(result.schema, 2)
  assert.equal(result.scenario, 'chief-forge-prism-mcp-repair')
  assert.equal(result.outcome, 'component-verified')
  assert.deepEqual([result.agentLoop.executed, result.agentLoop.mode], [false, 'scripted-session-events'])
  assert.deepEqual([result.followUpGate.required, result.followUpGate.status], [true, 'not-run'])
  assert.equal(result.chief.stages.length, 2)
  assert.deepEqual(result.chief.stages.map(stage => stage.owner), ['Forge', 'Prism'])
  assert.equal(result.forge.worktree.isolated, true)
  assert.deepEqual(result.forge.handoff.changedPaths, ['ds-bot/src/host/local-agents/mcp.js'])
  assert.ok(result.forge.handoff.commands.length >= 2)
  assert.match(result.forge.handoff.limitations, /scripted/i)
  assert.deepEqual(result.restart, {
    boundary: 'after-forge-durable-result-before-prism-pickup',
    hostStarts: 2,
    sameTaskId: result.prism.taskId,
    sameAttemptId: result.prism.attemptId,
    queuedBeforeRestart: true,
    prismPickupsBeforeRestart: 0,
    prismPickupsAfterRestart: 1,
    recoveryKind: 'resent',
  })
  assert.equal(result.prism.checks.diff.verified, true)
  assert.equal(result.prism.checks.inventory.verified, true)
  assert.equal(result.prism.checks.tests.verified, true)
  assert.equal(result.prism.checks.noDshPatch.verified, true)
  assert.equal(result.verification.status, 'verified')
  assert.equal(result.detail.attempt.id, result.prism.attemptId)
  assert.equal(result.detail.owner.role, 'Reviewer')
  assert.equal(result.detail.handoff.from.name, 'Chief')
  assert.equal(result.detail.handoff.to.name, 'Prism')
  assert.equal(result.detail.recovery.records[0].attemptId, result.prism.attemptId)
  assert.ok(result.typedEvidence.every(item => ['executed', 'verified'].includes(item.trust)))
  assert.ok(result.mockSeams.some(item => /scripted DSH Session events/i.test(item)))
})
