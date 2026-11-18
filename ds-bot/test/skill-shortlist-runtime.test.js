// A real DSH skill registry, filesystem provider and skill tool, not a fake
// catalog: an Agent-scoped mask must remove a profile skill from the model
// catalog and make a direct `skill` call fail, while a symbolic-link skill
// remains selectable.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as FsSkill from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { skillMaskPreStepGate } from '../src/host/capabilities.js'

function writeSkill(root, name, body = name) {
  const dir = join(root, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`)
}

function maskPlugin(names) {
  return {
    name: `test-skill-mask-${names.join('-')}`,
    inject: ['skills'],
    apply(c) {
      for (const name of names) {
        c.effect(() => c.skills.register({
          name,
          description: 'masked by a shortlist',
          source: 'shortlist-mask',
          content: '',
          invocation: { modelInvocable: false, userInvocable: false },
        }))
      }
    },
  }
}

test('the real DSH catalog and skill tool obey an Agent-scoped shortlist mask', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-skill-runtime-'))
  const external = join(root, 'external-linked')
  mkdirSync(external)
  writeFileSync(join(external, 'SKILL.md'), '---\nname: linked\ndescription: linked skill\n---\n\nLINKED BODY\n')
  for (let index = 0; index < 5; index += 1) writeSkill(root, `skill-${index}`, `BODY ${index}`)
  symlinkSync(external, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: {} })
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(FsSkill, { includeDefaultRoots: false, customSkillDirs: [root], watch: false })
  await ctx.plugin(ToolSkill)
  await mountAgentLoopTestHarness(ctx)
  const agent = await ctx.agentLoop.create(SessionId('s1'), {})
  const all = (await ctx.skills.snapshot({ cwd: root, scope: agent })).skills
    .filter(skill => skill.invocation.modelInvocable)
    .map(skill => skill.name)
    .sort()
  assert.deepEqual(all, ['linked', 'skill-0', 'skill-1', 'skill-2', 'skill-3', 'skill-4'])

  const chosen = new Set(['linked', 'skill-0', 'skill-1', 'skill-2', 'skill-3'])
  const masked = agent.ctx.plugin(maskPlugin(all.filter(name => !chosen.has(name))))
  await masked.await()
  const visible = (await ctx.skills.snapshot({ cwd: root, scope: agent })).skills
    .filter(skill => skill.invocation.modelInvocable)
    .map(skill => skill.name)
    .sort()
  assert.deepEqual(visible, ['linked', 'skill-0', 'skill-1', 'skill-2', 'skill-3'])

  const tool = ctx.tools.get('skill', agent)
  const exec = { agent, signal: new AbortController().signal }
  assert.match((await tool.execute({ name: 'linked' }, exec)).content, /LINKED BODY/)
  await assert.rejects(() => tool.execute({ name: 'skill-4' }, exec), /not available for model invocation/)
  const hidden = await ctx.skills.get('skill-4', { cwd: root, scope: agent })
  assert.equal(hidden.invocation.userInvocable, false)
  assert.equal(hidden.invocation.modelInvocable, false)

  await masked.dispose()
  const restored = (await ctx.skills.snapshot({ cwd: root, scope: agent })).skills
    .filter(skill => skill.invocation.modelInvocable)
    .map(skill => skill.name)
    .sort()
  assert.deepEqual(restored, all)
})

test('a strict-mask failure rejects a real DSH /name invocation but leaves ordinary text alone', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-skill-gesture-'))
  writeSkill(root, 'hidden', 'HIDDEN BODY')

  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: {} })
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(FsSkill, { includeDefaultRoots: false, customSkillDirs: [root], watch: false })
  await ctx.plugin(ToolSkill)
  await mountAgentLoopTestHarness(ctx)
  const agent = await ctx.agentLoop.create(SessionId('s-gate'), {})
  const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const propose = async text => {
    const input = message(text)
    return agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { modelSelection: { provider: 'mock', model: 'mock' }, messages: [input], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [input] }),
    )
  }

  // DSH itself injects the body on `/hidden`; this is the bypass the tool denial
  // cannot close. The capabilities gate is then layered over the real listener.
  const invoked = await propose('/hidden')
  assert.equal(invoked.kind, 'enter')
  assert.equal(invoked.messages.some(item => item.source.kind === 'skill-invocation' && item.source.name === 'hidden'), true)

  const unavailable = new WeakSet()
  const gate = ctx.plugin({
    name: 'test-strict-mask-gate',
    apply(c) { c.on('agent/pre-step', skillMaskPreStepGate(unavailable)) },
  })
  await gate.await()
  assert.equal((await propose('ordinary text')).kind, 'enter')
  unavailable.add(agent)
  assert.deepEqual(await propose('/hidden'), { kind: 'reject' })
  assert.equal((await propose('ordinary text')).kind, 'enter')
})
