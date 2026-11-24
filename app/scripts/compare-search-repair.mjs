// Prepare equally seeded worktrees and independently verify proposed repairs.
import assert from 'node:assert/strict'
import { fork, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { engineeringPresets } from '../../ds-bot/src/shared/engineering-presets.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const baseline = 'e88324459cd0d5ab2a173126d5f5de6b97f171a0'
const repair = 'app/src/search-patch.mjs'
const testFile = 'app/test/search-patch.test.mjs'
const regression = 'keeps the effective web options when restoring only the search selector'
const testArgs = ['--import', './test/reset-env.mjs', '--test', 'test/search-patch.test.mjs']
const debugging = engineeringPresets.find(preset => preset.id === 'debugging')
const arms = [
  { name: 'general', instructions: '', skills: [] },
  { name: 'debugging', instructions: debugging.instructions, skills: debugging.skills },
]
const prompt = [
  'Fix the search configuration regression in this checkout. Disabling automatic search can restore the bundled search provider, but it must preserve the effective fetch and other web settings.',
  'Reproduce with cd app && node --import ./test/reset-env.mjs --test test/search-patch.test.mjs. Edit only app/src/search-patch.mjs, leave the acceptance test unchanged, run it again, and report the failure, change, and verification.',
].join('\n')

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USERPROFILE|SYSTEMROOT|TEMP|TMP|TMPDIR|LANG)$/iu.test(key)),
)
const digest = data => createHash('sha256').update(data).digest('hex')

function run(cwd, file, args) {
  const result = spawnSync(file, args, { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.signal !== null) throw new Error(`${file} terminated with ${result.signal}`)
  return result
}

function git(cwd, ...args) {
  const result = run(cwd, 'git', ['-c', 'core.hooksPath=/dev/null', ...args])
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function check(root, worktree, name, phase) {
  const { status, stdout, stderr } = run(join(worktree, 'app'), process.execPath, testArgs)
  const log = `${name}-${phase}.log`
  writeFileSync(join(root, log), stdout + stderr)
  const fail = Number(stdout.match(/^ℹ fail (\d+)$/mu)?.[1])
  const pass = Number(stdout.match(/^ℹ pass (\d+)$/mu)?.[1])
  const expectedFailure = stdout.includes(`✖ ${regression}`) && stdout.includes('AssertionError')
  return { status, fail, pass, expectedFailure, log }
}

function prepare() {
  const root = mkdtempSync(join(tmpdir(), 'anbot-search-comparison-'))
  console.log(`Comparison directory: ${root}`)
  const clone = join(root, 'source')
  git(root, 'clone', '--quiet', '--no-local', '--no-checkout', repo, clone)
  git(clone, 'remote', 'remove', 'origin')
  const testHash = digest(readFileSync(join(repo, testFile)))
  const cases = []
  for (const arm of arms) {
    const worktree = join(root, arm.name)
    git(clone, 'worktree', 'add', '--quiet', '--detach', worktree, baseline)
    copyFileSync(join(repo, testFile), join(worktree, testFile))
    const installed = run(join(worktree, 'app'), 'npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'])
    writeFileSync(join(root, `${arm.name}-install.log`), installed.stdout + installed.stderr)
    assert.equal(installed.status, 0, `Dependency setup failed for ${arm.name}; see its install log`)
    const red = check(root, worktree, arm.name, 'baseline')
    assert.ok(red.status === 1 && red.pass === 5 && red.fail === 1 && red.expectedFailure,
      `${arm.name} did not reproduce the expected failure; see ${red.log}`)
    cases.push({ ...arm, baseline: red })
  }
  writeFileSync(join(root, 'comparison.json'), JSON.stringify({ baseline, testHash, prompt, arms: cases }, null, 2) + '\n')
  console.log('Both worktrees independently reproduced the same regression.')
}

function readComparison(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'comparison.json'), 'utf8'))
  assert.equal(manifest.baseline, baseline)
  assert.equal(manifest.testHash, digest(readFileSync(join(repo, testFile))), 'The run used a different acceptance test')
  return manifest
}

function verify(root) {
  const manifest = readComparison(root)
  const results = ['general', 'debugging'].map(name => {
    const worktree = join(root, name)
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), baseline)
    assert.equal(digest(readFileSync(join(worktree, testFile))), manifest.testHash, `${name} changed the acceptance test`)
    const changed = git(worktree, 'diff', '--name-only', 'HEAD').split('\n').filter(path => path !== testFile)
    assert.ok(changed.every(path => path === repair), `${name} changed files outside the repair scope`)
    assert.equal(git(worktree, 'ls-files', '--others', '--exclude-standard'), '', `${name} added unexpected files`)
    git(worktree, 'diff', '--check', 'HEAD')
    const checks = check(root, worktree, name, 'candidate')
    const changedSource = changed.includes(repair)
    const patch = git(worktree, 'diff', 'HEAD', '--', repair)
    if (changedSource) writeFileSync(join(root, `${name}-repair.diff`), patch + '\n')
    return { name, changedSource, checks, passed: changedSource && checks.status === 0 && checks.pass === 6 && checks.fail === 0 }
  })
  writeFileSync(join(root, 'verification.json'), JSON.stringify({ baseline, results }, null, 2) + '\n')
  console.log(JSON.stringify(results, null, 2))
  if (results.some(result => !result.passed)) process.exitCode = 1
}

async function withHost(home, key, execute) {
  const child = fork(join(repo, 'app/src/host.mjs'), [], {
    cwd: home,
    env: { ...env, DSH_HOME: join(home, 'data'), DS_BOT_WORKSPACE: join(home, 'workspace'),
      ...(key ? { REPAIR_COMPARISON_API_KEY: key } : {}) },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const exited = once(child, 'exit')
  try {
    const ready = Promise.withResolvers()
    child.on('message', message => {
      if (message?.type === 'ready') ready.resolve(new URL(message.url))
      if (message?.type === 'fatal') ready.reject(new Error('The pinned DSH host failed to start'))
    })
    const url = await Promise.race([
      ready.promise, exited.then(() => { throw new Error('The DSH host exited during startup') }),
      delay(40_000, null, { ref: false }).then(() => { throw new Error('The DSH host did not become ready') }),
    ])
    assert.equal(url.protocol, 'http:')
    assert.equal(url.hostname, '127.0.0.1')
    const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    assert.ok(cookie, 'The comparison host did not create a browser session')
    await execute(async (endpoint, payload = {}) => {
      const response = await fetch(new URL('/api/bot', url), {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ endpoint, payload }), signal: AbortSignal.timeout(35_000),
      })
      const result = await response.json()
      if (!result.ok) throw Object.assign(new Error(`Comparison request failed at ${endpoint}`), { code: result.error?.code })
      return result.value
    })
  } finally {
    if (child.connected) child.send({ type: 'shutdown' })
    if (!await Promise.race([exited.then(() => true), delay(5_000, false, { ref: false })])) {
      child.kill('SIGKILL')
      await exited
    }
  }
}

async function until(read, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await delay(500)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function bindComparison(root, dispatch) {
  const manifest = readComparison(root)
  const home = mkdtempSync(join(root, 'dsh-run-'))
  console.log(`DSH run directory: ${home}`)
  mkdirSync(join(home, 'workspace'))
  const provider = 'repair-comparison'
  const baseURL = process.env.ANBOT_REPAIR_BASE_URL
  const model = process.env.ANBOT_REPAIR_MODEL
  const key = process.env.ANBOT_REPAIR_API_KEY
  const protocol = process.env.ANBOT_REPAIR_PROTOCOL ?? 'openai-responses'
  const effort = process.env.ANBOT_REPAIR_EFFORT
  if (dispatch) {
    assert.ok(baseURL && model, 'A live comparison requires ANBOT_REPAIR_BASE_URL and ANBOT_REPAIR_MODEL')
    assert.ok(URL.canParse(baseURL), 'Use a valid provider URL')
    const endpoint = new URL(baseURL)
    assert.ok(['http:', 'https:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
      'Use a provider URL without credentials, query or fragment')
  }
  const selectedModel = dispatch ? model : 'binding-check'
  const route = `${provider}/${selectedModel}`
  const evidence = { baseline, dispatched: false, route, ...(effort ? { effort } : {}), arms: [] }
  const save = () => writeFileSync(join(home, 'bindings.json'), JSON.stringify(evidence, null, 2) + '\n')
  try {
    await withHost(home, dispatch ? key : undefined, async api => {
      await api('state')
      await api('provider-add', { custom: true, provider, name: 'Repair comparison', api: dispatch ? protocol : 'openai-responses',
        baseURL: dispatch ? baseURL : 'http://127.0.0.1:1/v1', models: [{ id: selectedModel, contextWindow: 100_000, maxTokens: 8192,
          ...(dispatch && effort ? { reasoningEfforts: { [effort]: effort } } : {}) }] })
      if (dispatch && effort) {
        const levels = await api('efforts', { ref: route })
        assert.ok(levels.efforts?.some(level => level.id === effort), 'The route does not advertise the requested effort')
      }
      for (const arm of arms) {
        const workDir = realpathSync(join(root, arm.name))
        assert.equal(git(workDir, 'rev-parse', 'HEAD'), baseline)
        assert.equal(digest(readFileSync(join(workDir, testFile))), manifest.testHash)
        assert.equal(git(workDir, 'diff', '--name-only', 'HEAD', '--', '.', `:(exclude)${testFile}`), '', 'The arm must start from the original defect')
        const bot = await api('create-bot', { name: `Repair ${arm.name}`, model: route, agentPreset: 'standard',
          workDir, instructions: arm.instructions, skills: arm.skills, ...(dispatch && effort ? { effort } : {}) })
        assert.deepEqual(bot.skillShortlist, arm.skills)
        assert.equal(bot.instructions, arm.instructions)
        const record = { name: arm.name, botId: bot.id, sessionId: bot.id, workDir, skills: bot.skillShortlist }
        evidence.arms.push(record)
        const bound = await api('bot-worktree', { botId: bot.id })
        assert.equal(bound.value?.root, workDir)
        assert.equal(bound.value?.sessionId, bot.id)
        assert.notEqual(bound.value?.state, 'created')
        const runtime = await until(async () => {
          const view = await api('bot-runtime', { botId: bot.id, sessionId: bot.id })
          return view.route === route ? view : null
        }, 15_000, `${arm.name} model selection`)
        assert.equal(runtime.sandbox, 'workspace-write')
        const scoped = runtime.extensions.filter(extension => extension.kind === 'skill')
        assert.deepEqual(scoped.map(extension => extension.id), arm.skills.map(skill => skill.name))
        for (const extension of scoped) {
          assert.equal(extension.availability.value, 'loaded')
          for (const check of ['cataloged', 'loaderAdmitted', 'bodyLoadable']) {
            const evidence = extension.observations[check]
            assert.ok(evidence?.status === 'observed' && evidence.value === true, `${extension.id}: ${check} was not observed`)
          }
        }
        Object.assign(record, { observation: bound.value.state, sandbox: runtime.sandbox, presetId: runtime.preset?.id ?? null })
        save()
      }
      assert.equal(new Set(evidence.arms.map(arm => arm.sessionId)).size, arms.length)
      if (!dispatch) return
      // A greeting exercises the actual model before the repair is dispatched.
      for (const arm of evidence.arms) {
        await until(async () => {
          const state = await api('state')
          const bot = state.bots.find(item => item.id === arm.botId)
          if (bot?.blocked) throw new Error(`Model request failed for ${arm.name}: ${bot.blocked.code}`)
          const chat = await api('chat', { botId: arm.botId })
          if (state.work?.turns?.[arm.sessionId] || !chat.items.some(item => item.kind === 'bot')) return false
          const runtime = await api('bot-runtime', { botId: arm.botId, sessionId: arm.sessionId })
          assert.equal(runtime.lastRoute, route, `${arm.name} replied using a different route`)
          arm.preflightRoute = runtime.lastRoute
          save()
          return true
        }, 90_000, `${arm.name} live model response`)
      }
      for (const arm of evidence.arms) {
        await api('send', { sessionId: arm.sessionId, text: prompt })
        arm.dispatched = true
        save()
      }
      evidence.dispatched = true
      for (const arm of evidence.arms) {
        await until(async () => {
          const state = await api('state')
          const bot = state.bots.find(item => item.id === arm.botId)
          if (bot?.blocked) throw new Error(`Repair request failed for ${arm.name}: ${bot.blocked.code}`)
          const chat = await api('chat', { botId: arm.botId, steps: true })
          const submitted = chat.items.findLastIndex(item => item.kind === 'user' && item.text === prompt)
          if (submitted < 0 || state.work?.turns?.[chat.sessionId]) return false
          const repairTurn = chat.items.slice(submitted + 1)
          if (!repairTurn.some(item => item.kind === 'bot')) return false
          arm.sessionId = chat.sessionId
          arm.tools = repairTurn.filter(item => item.kind === 'steps').flatMap(item => item.tools.map(tool => tool.name))
          arm.lastRoute = (await api('bot-runtime', { botId: arm.botId, sessionId: arm.sessionId })).lastRoute
          assert.equal(arm.lastRoute, route)
          return true
        }, 300_000, `${arm.name} repair turn`)
        save()
      }
      verify(root)
    })
  } finally { save() }
}

async function testTakeover(home) {
  const root = resolve(home, '..')
  verify(root)
  assert.equal(process.exitCode ?? 0, 0, 'Both repairs must pass before the takeover check')
  const evidence = JSON.parse(readFileSync(join(home, 'bindings.json'), 'utf8'))
  assert.equal(evidence.baseline, baseline)
  assert.equal(evidence.dispatched, true)
  assert.deepEqual(evidence.arms.map(arm => arm.name), arms.map(arm => arm.name))
  const captures = []
  try {
    await withHost(home, process.env.ANBOT_REPAIR_API_KEY, async api => {
      for (const arm of evidence.arms) {
        const workDir = realpathSync(join(root, arm.name))
        assert.equal(arm.workDir, workDir)
        assert.equal(arm.lastRoute, evidence.route)
        const request = { botId: arm.botId, sessionId: arm.sessionId }
        const note = `anbot-handoff-${randomUUID()}.txt`
        const value = `anbot-human-edit-${randomUUID()}`
        const file = join(workDir, note)
        await api('state')
        const send = text => api('send', { sessionId: arm.sessionId, text })
        const reply = (text, expected) => until(async () => {
          const state = await api('state')
          if (state.work?.turns?.[arm.sessionId]) return false
          const chat = await api('chat', { botId: arm.botId, steps: true })
          assert.equal(chat.sessionId, arm.sessionId)
          const at = chat.items.findLastIndex(item => item.kind === 'user' && item.text === text)
          if (at < 0) return false
          const entries = chat.items.slice(at + 1)
          return entries.some(item => item.kind === 'bot' && item.text.includes(expected)) ? entries : false
        }, 90000, `${arm.name} response in the original Session`)
        const readyText = 'Reply with Ready for takeover. Do not edit files.'
        await send(readyText)
        await reply(readyText, 'Ready for takeover')
        const held = await api('bot-worktree-takeover', request)
        assert.deepEqual({ sessionId: held.sessionId, root: held.root, status: held.status },
          { sessionId: arm.sessionId, root: workDir, status: 'held' })
        try {
          await assert.rejects(send('This prompt should be refused during takeover.'), { code: 'bot/refused' })
          writeFileSync(file, value + '\n', { flag: 'wx' })
          try {
            await api('bot-worktree-return', request)
            assert.equal((await api('bot-worktree', request)).hold, null)
            const text = `Read ${note} using a file tool. Reply with its exact contents. Do not edit files.`
            await send(text)
            const entries = await reply(text, value)
            const tools = entries.filter(item => item.kind === 'steps').flatMap(item => item.tools.map(tool => tool.name))
            assert.ok(tools.some(tool => tool === 'read' || tool === 'bash'))
            assert.equal((await api('bot-runtime', request)).lastRoute, evidence.route)
            assert.equal(readFileSync(file, 'utf8'), value + '\n')
            captures.push({ name: arm.name, sessionId: arm.sessionId, workDir, held: true, inputRefused: true,
              returned: true, humanEditRead: true, tools })
          } finally { unlinkSync(file) }
        } finally {
          if ((await api('bot-worktree', request)).hold !== null) await api('bot-worktree-return', request)
        }
      }
    })
  } finally {
    writeFileSync(join(home, 'takeover.json'), JSON.stringify(captures, null, 2) + '\n')
  }
  verify(root)
}

const [action, directory] = process.argv.slice(2)
if (action === 'prepare' && directory === undefined) prepare()
else if (action === 'verify' && directory) verify(resolve(directory))
else if ((action === 'bind' || action === 'run') && directory) await bindComparison(resolve(directory), action === 'run')
else if (action === 'takeover' && directory) await testTakeover(resolve(directory))
else {
  console.error('Usage: node app/scripts/compare-search-repair.mjs prepare | bind|run|verify <comparison-directory> | takeover <DSH-run-directory>')
  process.exitCode = 2
}
