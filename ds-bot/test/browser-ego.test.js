import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import {
  EGO_RESULT,
  EGO_SKILL,
  EGO_TOOL,
  EgoCli,
  createEgoControl,
  egoEnabledFor,
  egoProfileFor,
  egoSkillProvider,
  scriptFor,
} from '../src/host/browser/ego.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotId: 'm1',
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: {
      id: 'b2',
      sessionId: 'b2',
      name: 'Researcher',
      role: 'Research',
      instructions: '',
      skillShortlist: [{ name: EGO_SKILL, purpose: 'inspect a public page in Ego Lite' }],
      createdAt: 2,
    },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function fakeCli(overrides = {}) {
  const calls = []
  const cli = {
    calls,
    async status() {
      return { version: 'ego-browser test', value: { ok: true, profile: { found: true, default: false } } }
    },
    async run(script, signal) {
      calls.push({ script, signal })
      if (script.includes('await __page.goto')) return { value: { ok: true, spaceId: 12, page: 'p1', title: 'Example', url: 'https://example.com/', snapshot: 'Example Domain' } }
      if (script.includes('const __info = await __page.evaluate')) return { value: { ok: true, title: 'IANA', url: 'https://www.iana.org/help/example-domains', snapshot: 'IANA' } }
      if (script.includes('await __task.handOff')) return { value: { ok: true, spaceId: 12, page: 'p1' } }
      if (script.includes('await takeOverTaskSpace')) return { value: { ok: true, title: 'Example', url: 'https://example.com/' } }
      if (script.includes('await __task.finish')) return { value: { ok: true } }
      if (script.includes('await __page.snapshot')) return { value: { ok: true, title: 'Example', url: 'https://example.com/', snapshot: 'Example Domain' } }
      return { ...overrides, value: overrides.value ?? { ok: false, error: `unexpected script: ${script.slice(0, 80)}` } }
    },
  }
  return cli
}

function fakeChild({ stdout = '', stderr = '', code = 0 } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  child.stdin = {
    end() {
      queueMicrotask(() => {
        if (stdout !== '') child.stdout.emit('data', stdout)
        if (stderr !== '') child.stderr.emit('data', stderr)
        child.emit('close', code, null)
      })
    },
  }
  return child
}

test('the bundled Ego skill is original, opt-in, and uses the fixed tool', async () => {
  const provider = egoSkillProvider()
  const items = await provider.list()
  assert.deepEqual(items.map(item => item.name), [EGO_SKILL])
  const skill = await provider.get(items[0])
  assert.match(skill.content, /Use `browser_ego`/)
  assert.match(skill.content, /no typing, form-fill, payment, upload, download/)
  assert.equal(egoEnabledFor({ skillShortlist: [{ name: EGO_SKILL }] }), true)
  assert.equal(egoEnabledFor({ skillShortlist: [{ name: 'other' }] }), false)
})

test('Ego profiles are explicit, per-Bot, and never default by convention', () => {
  const config = { browserEgoProfiles: { writer: { profileId: 'Profile 9' } } }
  assert.equal(egoProfileFor(config, 'writer'), 'Profile 9')
  assert.equal(egoProfileFor(config, 'chief'), '')
})

test('every Ego action is built from fixed code around JSON values', () => {
  const hostile = `@2'); console.log('not generated code'); //`
  const click = scriptFor('click', { spaceId: 4, pageLabel: 'p1', target: hostile, label: 'Open docs' })
  assert.match(click, /__anbotEmit/)
  assert.match(click, /console\.log/)
  assert.ok(click.includes(JSON.stringify(hostile)))
  assert.match(click, /The click policy allows ordinary HTTP or HTTPS links only/)
  assert.doesNotMatch(click, /fillInput|\bjs\(|typeText|setInputFiles/)
  for (const action of ['snapshot', 'screenshot', 'handoff', 'resume', 'close']) {
    assert.match(scriptFor(action, { spaceId: 4, pageLabel: 'p1', screenshotPath: '/tmp/page.png' }), /__anbotEmit/)
  }
  assert.match(scriptFor('snapshot', { spaceId: 4, pageLabel: 'p1' }), /String\(await __page\.url\(\)\)/)
})

test('the CLI probe accepts the documented nodejs form and sends no credential-shaped environment', async () => {
  const seen = []
  const cli = new EgoCli({
    env: { SAFE_FLAG: 'yes', OPENAI_API_KEY: 'must-not-pass' },
    spawnImpl(command, args, options) {
      seen.push({ command, args, options })
      return fakeChild({ stdout: `probe ${EGO_RESULT} {"ok":true}\n` })
    },
  })
  const previous = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'must-not-pass'
  try {
    assert.deepEqual(await cli.probe(), ['nodejs'])
    await cli.probe()
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].command, 'ego-browser')
  assert.deepEqual(seen[0].args, ['nodejs'])
  assert.equal(seen[0].options.env.SAFE_FLAG, 'yes')
  assert.equal(seen[0].options.env.OPENAI_API_KEY, undefined)
  assert.equal(seen[0].options.shell, false)
})

test('takeover blocks Bot actions until the user gives the same tab back', async () => {
  const cli = fakeCli()
  let hold = null
  const control = createEgoControl({
    cli,
    profileFor: () => 'Profile 9',
    getHold: () => hold,
    setHold: (_botId, next) => { hold = next },
    randomId: () => 'fixed',
  })

  const opened = await control.execute({ action: 'open', url: 'https://example.com/' }, { botId: 'b2' })
  assert.match(opened.text, /Opened in Ego Lite/)
  const handed = await control.execute({ action: 'handoff', note: 'Check the highlighted paragraph.' }, { botId: 'b2' })
  assert.match(handed.text, /now with the user/)
  assert.deepEqual(hold, { by: 'bot', reason: 'other', note: 'Check the highlighted paragraph.' })

  hold = { ...hold, by: 'user' }
  const before = cli.calls.length
  const blocked = await control.execute({ action: 'snapshot' }, { botId: 'b2' })
  assert.match(blocked.text, /user controls/)
  assert.equal(cli.calls.length, before)

  hold = null
  const resumed = await control.execute({ action: 'resume' }, { botId: 'b2' })
  assert.match(resumed.text, /control returned to the Bot/)
  assert.equal(hold, null)
  assert.match(cli.calls.at(-1).script, /const __pages = await __task\.pages\(\)/)
  assert.match(cli.calls.at(-1).script, /will not adopt a user-created tab/)

  const closed = await control.execute({ action: 'close' }, { botId: 'b2' })
  assert.match(closed.text, /Closed this Bot/)
})

test('Ego refuses a default profile and rejects non-HTTP URLs before the CLI runs', async () => {
  const calls = []
  const cli = {
    async status() { return { version: 'v', value: { ok: true, profile: { found: true, default: true } } } },
    async run(script) { calls.push(script); return { value: { ok: true } } },
  }
  const control = createEgoControl({ cli, profileFor: () => 'Profile 5' })
  assert.match((await control.execute({ action: 'status' }, { botId: 'b2' })).text, /personal default/)
  assert.match((await control.execute({ action: 'open', url: 'javascript:alert(1)' }, { botId: 'b2' })).text, /only HTTP or HTTPS/)
  assert.equal(calls.length, 0)
})

test('the Browser module registers browser_ego but only an opted-in Bot reaches it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-browser-ego-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const cli = fakeCli()
  const rt = createRuntime(ctx, {
    home,
    browser: true,
    browserEgoCli: cli,
    browserEgoProfiles: { b2: 'Profile 9' },
  })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  ctx.sessions = { flush: async () => {} }
  rt.ensureCapabilities = async () => {}
  rt.resolveAgent = async sessionId => ({ session: { id: sessionId }, followup() {} })
  await rt.load()

  const tool = rt.teamTools.find(item => item.name === EGO_TOOL)
  assert.ok(tool)
  assert.deepEqual(Object.keys(tool.parameters.properties), ['action', 'url', 'target', 'label', 'note'])
  assert.equal(tool.parameters.properties.script, undefined)

  const chief = await tool.execute({ action: 'status' }, { agent: { id: 'm1' } })
  assert.match(chief, /capability is off/)
  const writer = await tool.execute({ action: 'status' }, { agent: { id: 'b2' } })
  assert.match(writer.text, /Ego Lite is ready/)
})
