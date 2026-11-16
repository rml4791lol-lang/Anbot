import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  captureProjectChanges,
  gitLogEntries,
  gitStatusFiles,
  install,
  normalizeChangeFiles,
  parseProjectChanges,
  projectChangeEntry,
  projectChangeFacts,
  readProjectChanges,
  writeProjectChange,
} from '../src/host/project-records.js'

const run = promisify(execFile)

const temp = async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-records-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('project change entries are bounded, attributed and deduplicated', () => {
  const project = '/tmp/project'
  const entry = projectChangeEntry({
    id: 'one', at: 100, project, kind: 'progress', action: 'recorded',
    actor: 'Coder', summary: '  Built checkout  ', reason: 'The user asked for a working flow.',
    files: ['src/a.js', 'src/a.js', '../secret'], evidence: ['npm test'],
    progress: { before: 'shell', after: 'working checkout' }, sourceKind: 'bot', verification: 'reported',
  })
  assert.equal(entry.summary, 'Built checkout')
  assert.deepEqual(entry.files, ['src/a.js'])
  assert.deepEqual(entry.progress, { before: 'shell', after: 'working checkout' })
  const rows = parseProjectChanges(`${JSON.stringify(entry)}\n${JSON.stringify({ ...entry, summary: 'duplicate' })}\nnot json\n`, project)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].summary, 'Built checkout')
})

test('Git status and log parsers keep real paths and commit facts', () => {
  assert.deepEqual(gitStatusFiles(' M src/app.js\u0000?? src/new.js\u0000'), [
    { status: ' M', path: 'src/app.js' },
    { status: '??', path: 'src/new.js' },
  ])
  const log = '\u001eabc1234\u001f2026-11-16T10:00:00Z\u001fMei\u001fFinish checkout\u000asrc/app.js\u000asrc/cart.js\u000a'
  const rows = gitLogEntries(log, '/tmp/project')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'git:abc1234')
  assert.equal(rows[0].actor, 'Mei')
  assert.equal(rows[0].summary, 'Finish checkout')
  assert.deepEqual(rows[0].files, ['src/app.js', 'src/cart.js'])
})

test('files outside a project are refused by the recorder', () => {
  assert.deepEqual(normalizeChangeFiles('/tmp/project', ['src/a.js', '../secret', '/tmp/project/src/b.js', '/etc/passwd']), ['src/a.js', 'src/b.js'])
})

test('the append-only ledger survives a reload and keeps duplicate ids out', async (t) => {
  const home = await temp(t)
  const project = join(home, 'project')
  await mkdir(project)
  const base = {
    id: 'bot:call-1', at: 100, project, kind: 'change', action: 'recorded', actor: 'Coder',
    summary: 'Add checkout', reason: 'Core conversion path', files: ['src/checkout.js'], evidence: ['npm test'],
    progress: { before: '', after: 'checkout works' }, source: 'Coder', sourceKind: 'bot', verification: 'reported',
  }
  assert.equal(await writeProjectChange(home, base), true)
  assert.equal(await writeProjectChange(home, base), false)
  const rows = await readProjectChanges(home, project)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].summary, 'Add checkout')
})

test('a non-Git project records changed files after the first baseline', async (t) => {
  const home = await temp(t)
  const project = join(home, 'project')
  await mkdir(project)
  await writeFile(join(project, 'index.js'), 'one')
  assert.deepEqual(await captureProjectChanges(home, project, { actor: 'Coder' }), { recorded: false, files: [] })
  await writeFile(join(project, 'index.js'), 'two')
  const captured = await captureProjectChanges(home, project, { actor: 'Coder' })
  assert.equal(captured.recorded, true)
  assert.deepEqual(captured.files, ['index.js'])
  const rows = await readProjectChanges(home, project)
  assert.equal(rows[0].sourceKind, 'automatic')
  assert.deepEqual(rows[0].files, ['index.js'])
})

test('a nested Git project reads commits and status relative to its own folder', async (t) => {
  const root = await temp(t)
  const project = join(root, 'app')
  await mkdir(project)
  await writeFile(join(project, 'index.js'), 'one\n')
  await run('git', ['-C', root, 'init', '-q'])
  await run('git', ['-C', root, 'add', '.'])
  await run('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Initial project'])
  await writeFile(join(project, 'index.js'), 'two\n')
  const facts = await projectChangeFacts(join(root, 'data'), project)
  assert.equal(facts.git.available, true)
  assert.equal(facts.git.working, 1)
  assert.ok(facts.entries.some(entry => entry.action === 'committed' && entry.files.includes('index.js')))
  assert.ok(facts.entries.some(entry => entry.action === 'working' && entry.files.includes('index.js')))
})

test('the Bot tool records a project change with its caller and call id', async (t) => {
  const home = await temp(t)
  const project = join(home, 'project')
  await mkdir(project)
  const bot = { id: 'builder', name: 'Builder', workDir: project }
  const rt = {
    home,
    state: { bots: { builder: bot }, rooms: {} },
    teamTools: [],
    groupOwners: new Map(),
    ctx: { on() {}, effect(run) { return run() } },
    load: async () => {},
    selfOf: id => id,
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    isFolder: async () => true,
    readOnly: () => undefined,
    redactSecrets: value => value,
    warn() {},
  }
  const cleanup = install(rt)
  t.after(() => cleanup?.())
  const tool = rt.teamTools.find(def => def.name === 'record_project_change')
  const result = await tool.execute({
    summary: 'Add checkout', reason: 'Core conversion path', files: ['src/checkout.js'],
    evidence: ['npm test'], before: 'form only', after: 'checkout works', kind: 'progress',
  }, { agent: { id: 'builder' }, callId: 'call-1' })
  assert.match(result, /Recorded progress/)
  const rows = await readProjectChanges(home, project)
  assert.equal(rows[0].id, 'bot:call-1')
  assert.equal(rows[0].actor, 'Builder')
  assert.equal(rows[0].kind, 'progress')
})
