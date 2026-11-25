import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { manualDirectory } from '../src/host/manual-skills.js'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'
import { install as installBuiltinPacks, BUILTIN_PACKS } from '../src/host/builtin-packs.js'

function start() {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief' }],
    ['worker', { name: 'Dev', instructions: 'Check files.' }],
  ])
  install({
    ctx,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
  })
  const prompt = id => [
    ctx.sections.get('bot-team-rules').text({ agent: { id } }),
    ctx.sections.get('bot-identity').text({ agent: { id } }),
  ].filter(Boolean).join('\n\n')
  return { ctx, prompt }
}

const SECTION_TITLES = [
  '### 1. Identity and scope',
  '### 2. Work loop',
  '### 3. Evidence',
  '### 4. Stop rules',
  '### 5. Delivery',
  '### 6. Collaboration',
  '### 7. Memory',
  '### 8. Failure handling',
]

// 26 team rules and 12 Main Bot rules; a rendered prompt repeats no rule.
const RULE_COUNTS = { main: 38, worker: 26 }

test('Bots get the eight rule sections in order, with every rule exactly once', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '- Only for a direct user request in your own chat that needs several steps: make your first tool call in the same response as your text. When the work will take more than a minute or two, open with one short sentence of what you are about to do; when that sentence would only repeat the request or the first command, start with the tool call instead. On long tasks, give brief factual updates only at meaningful milestones, then keep working. Never end with a promise in place of the work.',
    '- Do not narrate tool mechanics or system notices to the user: exit codes, "no output", "saved", a handoff note, a context or memory injection, a checkpoint, or the label you were given. That is plumbing. Report the result the user can act on, or nothing.',
    '- For "[Work …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer (or [PASS] when a completed work needs nothing told to the user). Simple answers do not need progress messages.',
    '- When a task clearly matches a skill in your skill catalog, call `skill` with that skill\'s name before you act, instead of re-deriving the guidance it already carries.',
    '- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates.',
  ]
  for (const id of ['main', 'worker']) {
    const text = prompt(id)
    const lines = text.split('\n')
    for (const rule of rules) {
      assert.ok(lines.includes(rule))
      assert.equal(text.split(rule).length - 1, 1)
    }
    for (const title of SECTION_TITLES) {
      assert.equal(lines.filter(line => line === title).length, 1)
    }
    const positions = SECTION_TITLES.map(title => lines.indexOf(title))
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
    const bullets = lines.filter(line => line.startsWith('- '))
    assert.equal(bullets.length, RULE_COUNTS[id])
    assert.equal(new Set(bullets).size, bullets.length)
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

// 公开#1499: a Bot that is handed a saved path and finds `read` closed to a PDF has to know where to go next.
test('Bots are told how to open a PDF the user attached, once, in the shared prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  for (const id of ['main', 'worker']) {
    const rule = prompt(id).split('\n').filter(line => line.startsWith('- A file the user attaches reaches you as a saved path'))
    assert.equal(rule.length, 1)
    assert.match(rule[0], /read tool opens text files only/)
    assert.match(rule[0], /scanned or not/)
    assert.match(rule[0], /office skill/)
    assert.match(rule[0], /office_render/)
    assert.match(rule[0], /never answer only that the file cannot be read/)
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

// L1: a note that repeats a question the conversation already answered is not fresh work.
test('Bots are told not to redo a question this conversation already answered, once, in the shared prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  for (const id of ['main', 'worker']) {
    const rule = prompt(id).split('\n').filter(line => line.startsWith('- A note or a message that repeats a question'))
    assert.equal(rule.length, 1)
    assert.match(rule[0], /this conversation already answered/)
    assert.match(rule[0], /same sender, same question/)
    assert.match(rule[0], /is not new work/)
    assert.match(rule[0], /points back to the earlier conclusion/)
    assert.match(rule[0], /genuinely still open/)
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('every Bot can read the manual directly when no skill loader is available', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  for (const id of ['main', 'worker', 'group-worker']) {
    assert.ok(prompt(id).includes(JSON.stringify(join(manualDirectory(), 'SKILL.md'))))
    assert.match(prompt(id), /if you have no skill loader, use your read tool/)
    assert.match(prompt(id), /linked references directly/)
  }
})

test('the group relay and non-Bot sessions do not get progress instructions', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})

test('only Main Bot gets the ds-bot-maintenance and ds-bot-plugin-dev rules while worker and group-worker stay unchanged', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const maintenanceRule = '- When the user asks to inspect, diagnose, update, back up, migrate, or repair DS Bot itself, load the ds-bot-maintenance skill before acting, and never edit live team state or DSH files behind a running host.'
  const pluginDevRule = '- When the user asks to build, install, or attach a plugin, MCP server, reusable skill, capability pack, or extension for DS Bot, load the ds-bot-plugin-dev skill before acting.'
  const main = prompt('main')
  assert.equal(main.split(maintenanceRule).length - 1, 1)
  assert.equal(main.split(pluginDevRule).length - 1, 1)
  const worker = prompt('worker')
  assert.doesNotMatch(worker, /ds-bot-maintenance/)
  assert.doesNotMatch(worker, /ds-bot-plugin-dev/)
  assert.equal(prompt('group-worker'), worker)
})

test('ordinary Bot prompts never direct calls to team-admin tools', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  for (const id of ['worker', 'group-worker']) {
    for (const name of BUILTIN_PACKS['team-admin'].tools) assert.ok(!prompt(id).includes(name), name)
    assert.match(prompt(id), /update_bot changes your own settings/)
    assert.match(prompt(id), /change the group with update_group/)
  }
  for (const name of BUILTIN_PACKS['team-admin'].tools) assert.ok(prompt('main').includes(name), name)
})

test('role-dependent prompt guidance stays frozen until the next turn in both directions', (t) => {
  const ctx = fakeContext()
  t.after(() => ctx.dispose())
  let main = false
  const rt = { ctx, selfOf: id => id, botOf: () => ({ name: 'Writer' }), roomOf: () => undefined, isMain: () => main, isBotSession: () => true }
  installBuiltinPacks(rt)
  install(rt)
  const prompt = () => [
    ctx.sections.get('bot-team-rules').text({ agent: { id: 'worker' } }),
    ctx.sections.get('bot-identity').text({ agent: { id: 'worker' } }),
  ].filter(Boolean).join('\n\n')
  const emit = type => ctx.listeners.get('session/event')[0]({ id: 'worker' }, { type })
  for (const initial of [false, true]) {
    main = initial
    emit('turn/start')
    const before = prompt()
    main = !initial
    assert.equal(prompt(), before)
    emit('turn/end')
    emit('turn/start')
    assert.notEqual(prompt(), before)
    assert.equal(prompt().includes('create_bot'), !initial)
    emit('turn/end')
  }
})
