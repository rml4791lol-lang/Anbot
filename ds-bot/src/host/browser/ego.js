// Opt-in Ego Lite bridge for one Bot. Ego runs a separate browser runtime, so this
// module keeps the command surface fixed: the model may navigate, inspect,
// screenshot, follow an ordinary link, hand control to the user, and take it back,
// but it never supplies JavaScript or credentials.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EGO_SKILL = 'anbot-ego-browser'
export const EGO_TOOL = 'browser_ego'
export const EGO_RESULT = '@@ANBOT_EGO_RESULT@@'
export const EGO_TIMEOUT_MS = 60_000
export const EGO_SNAPSHOT_MAX = 40_000
const EGO_OUTPUT_MAX = 256_000
const HARD_STOP = 'taken control of this task space'
const ACTIONS = new Set(['status', 'open', 'snapshot', 'screenshot', 'click', 'handoff', 'resume', 'close'])
const SAFE_ENV = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')

function parseSkill(raw, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const metadata = frontmatter?.[1] ? Object.fromEntries(
    frontmatter[1].split('\n').map(line => /^(\w[\w-]*):\s*(.+)$/.exec(line.trim())?.slice(1) ?? []).filter(part => part.length === 2),
  ) : {}
  if (typeof metadata.description !== 'string' || metadata.description === '') {
    throw new Error(`Bundled skill ${path} has no description`)
  }
  return { description: metadata.description, content: raw.slice(frontmatter[0].length).trim() }
}

function candidate() {
  const directory = join(SKILLS, EGO_SKILL)
  const locator = join(directory, 'SKILL.md')
  const { description } = parseSkill(readFileSync(locator, 'utf8'), locator)
  return {
    name: EGO_SKILL,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'ds-bot-ego',
    source: 'bundled',
    rank: 700,
    resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
    locator,
  }
}

export function egoSkillProvider() {
  const item = candidate()
  return {
    name: 'ds-bot-ego',
    list: () => Promise.resolve([item]),
    async get(requested) {
      if (requested?.name !== EGO_SKILL) return undefined
      const { description, content } = parseSkill(readFileSync(item.locator, 'utf8'), item.locator)
      return { ...item, description, content }
    },
  }
}

export function egoEnabledFor(bot) {
  return (bot?.skillShortlist ?? []).some(skill => skill?.name === EGO_SKILL)
}

export function egoProfileFor(config, botId) {
  const value = config?.browserEgoProfiles?.[botId]
  const profileId = typeof value === 'string' ? value : value?.profileId
  return typeof profileId === 'string' ? profileId.trim() : ''
}

function safeEnv(source = process.env, extra = {}) {
  const env = {}
  for (const name of SAFE_ENV) {
    if (typeof source[name] === 'string') env[name] = source[name]
  }
  for (const [name, value] of Object.entries(extra)) {
    if (typeof value === 'string' && !/(?:KEY|PASSWORD|SECRET|TOKEN)/i.test(name)) env[name] = value
  }
  return env
}

function markerExpression() {
  const half = Math.ceil(EGO_RESULT.length / 2)
  return `${JSON.stringify(EGO_RESULT.slice(0, half))} + ${JSON.stringify(EGO_RESULT.slice(half))}`
}

function fixedScript(lines) {
  return [
    `const __anbotEmit = value => console.log(${markerExpression()}, JSON.stringify(value))`,
    'try {',
    ...lines.map(line => `  ${line}`),
    '} catch (error) {',
    `  __anbotEmit({ ok: false, error: String(error?.message || error), code: error?.error_code || error?.code })`,
    '}',
  ].join('\n')
}

function resultFrom(stdout, stderr) {
  const all = `${stdout}\n${stderr}`
  const output = stdout.includes(EGO_RESULT) ? stdout : stderr
  const lines = output.split('\n')
  const at = lines.findLastIndex(line => line.includes(EGO_RESULT))
  if (at !== -1) {
    const text = lines[at].slice(lines[at].indexOf(EGO_RESULT) + EGO_RESULT.length).trim()
    try {
      return { value: JSON.parse(text), stdout, stderr }
    } catch {
      return { value: { ok: false, error: 'Ego Lite returned an unreadable result.' }, stdout, stderr }
    }
  }
  if (all.includes(HARD_STOP)) {
    return { value: { ok: false, takeover: true, error: 'The user has taken control in Ego Lite. Do not retry.' }, stdout, stderr }
  }
  const detail = stderr.trim() || stdout.trim() || 'Ego Lite exited without a result.'
  return { value: { ok: false, error: detail.split('\n')[0].slice(0, 500) }, stdout, stderr }
}

function trimSnapshot(value, limit = EGO_SNAPSHOT_MAX) {
  const text = String(value ?? '')
  return text.length <= limit
    ? { snapshot: text, truncated: false }
    : { snapshot: text.slice(0, limit), truncated: true }
}

function assertUrl(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0 || text.length > 2_000) throw new Error('Give one HTTP or HTTPS page address.')
  let url
  try { url = new URL(text) } catch { throw new Error('Give a complete HTTP or HTTPS page address.') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Ego Lite may open only HTTP or HTTPS pages.')
  if (url.username || url.password) throw new Error('A page address cannot contain a username or password.')
  return url.toString()
}

function assertTarget(value) {
  const target = String(value ?? '').trim()
  if (target === '' || target.length > 500 || /[\r\n]/.test(target)) throw new Error('Give one CSS selector for the ordinary link.')
  if (/^(?:@|ref=|loc=|text=|xpath=)/i.test(target)) throw new Error('Use a CSS selector for the ordinary link, such as "#docs" or "nav a[href]".')
  return target
}

function gateProfile(profileId) {
  return [
    `const __profiles = await profiles()`,
    `const __profile = __profiles.find(item => item.id === ${JSON.stringify(profileId)})`,
    `if (!__profile) throw new Error('The configured Ego Lite profile was not found.')`,
    `if (__profile.isDefault) throw new Error('Use a dedicated non-default Ego Lite profile for this Bot.')`,
  ]
}

export function scriptFor(action, input) {
  if (action === 'open') {
    const profile = gateProfile(input.profileId)
    return fixedScript([
      ...profile,
      `const __name = ${JSON.stringify(input.spaceName)}`,
      `const __listed = await listTaskSpaces()`,
      `const __known = __listed.find(space => space.name === __name && space.createdBy === 'agent')`,
      `if (__known && __known.profileId !== ${JSON.stringify(input.profileId)}) throw new Error('This Ego Lite task uses a different profile.')`,
      `const __task = __known ? await taskSpace(__known.id) : await taskSpace(__name, { profileId: ${JSON.stringify(input.profileId)} })`,
      `const __page = __task.page('p1')`,
      `const __created = !__known`,
      'try {',
      `  await __page.goto(${JSON.stringify(input.url)})`,
      `  const __title = await __page.title()`,
      `  const __text = await __page.snapshot({ scope: 'full_page' })`,
      `  __anbotEmit({ ok: true, spaceId: __task.spaceId, page: __page.label, title: __title, url: String(await __page.url()), snapshot: __text })`,
      '} catch (error) {',
      '  if (__created) await __task.finish({ keep: [] }).catch(() => {})',
      '  throw error',
      '}',
    ])
  }
  if (action === 'snapshot') {
    return fixedScript([
      `const __task = await taskSpace(${JSON.stringify(input.spaceId)})`,
      `const __page = __task.page(${JSON.stringify(input.pageLabel)})`,
      `const __title = await __page.title()`,
      `const __text = await __page.snapshot({ scope: 'full_page' })`,
      `__anbotEmit({ ok: true, title: __title, url: String(await __page.url()), snapshot: __text })`,
    ])
  }
  if (action === 'screenshot') {
    return fixedScript([
      `const __task = await taskSpace(${JSON.stringify(input.spaceId)})`,
      `const __page = __task.page(${JSON.stringify(input.pageLabel)})`,
      `await __page.screenshot({ path: ${JSON.stringify(input.screenshotPath)} })`,
      `__anbotEmit({ ok: true, title: await __page.title(), url: String(await __page.url()) })`,
    ])
  }
  if (action === 'click') {
    return fixedScript([
      `const __task = await taskSpace(${JSON.stringify(input.spaceId)})`,
      `const __page = __task.page(${JSON.stringify(input.pageLabel)})`,
      `const __target = ${JSON.stringify(input.target)}`,
      `const __info = await __page.evaluate(selector => {`,
      `  const element = document.querySelector(selector)`,
      `  const link = element?.closest?.('a[href]')`,
      `  return link ? { href: link.href, target: link.target || '', download: link.hasAttribute('download') } : null`,
      '}, __target)',
      `if (!__info) throw new Error('The click policy allows ordinary HTTP or HTTPS links only.')`,
      `if (__info.download) throw new Error('Download links are not available through this capability.')`,
      `if (__info.target === '_blank') throw new Error('Links that open another tab are not available through this capability.')`,
      `if (!/^https?:/i.test(__info.href)) throw new Error('The selected link leaves HTTP or HTTPS.')`,
      `await __page.click(__target, { label: ${JSON.stringify(input.label || 'Follow safe link')} })`,
      `await __page.waitForLoadState('load').catch(() => {})`,
      `const __title = await __page.title()`,
      `const __text = await __page.snapshot({ scope: 'full_page' })`,
      `__anbotEmit({ ok: true, title: __title, url: String(await __page.url()), snapshot: __text, followed: __info.href })`,
    ])
  }
  if (action === 'handoff') {
    return fixedScript([
      `const __task = await taskSpace(${JSON.stringify(input.spaceId)})`,
      `await __task.handOff()`,
      `__anbotEmit({ ok: true, spaceId: __task.spaceId, page: ${JSON.stringify(input.pageLabel)} })`,
    ])
  }
  if (action === 'resume') {
    return fixedScript([
      `const __task = await takeOverTaskSpace(${JSON.stringify(input.spaceId)})`,
      `const __pages = await __task.pages()`,
      `const __page = __pages.find(page => page.label === ${JSON.stringify(input.pageLabel)})`,
      `if (!__page) throw new Error('The dedicated Ego Lite tab is gone; it will not adopt a user-created tab.')`,
      `__anbotEmit({ ok: true, title: await __page.title(), url: String(await __page.url()) })`,
    ])
  }
  if (action === 'close') {
    return fixedScript([
      `const __task = await taskSpace(${JSON.stringify(input.spaceId)})`,
      `await __task.finish({ keep: [] })`,
      `__anbotEmit({ ok: true })`,
    ])
  }
  throw new Error(`Unknown Ego Lite action ${action}.`)
}

export class EgoCli {
  constructor({ bin = 'ego-browser', serverName = '', env = {}, spawnImpl = spawn, timeoutMs = EGO_TIMEOUT_MS } = {}) {
    this.bin = bin
    this.serverName = String(serverName ?? '').trim()
    this.env = env
    this.spawnImpl = spawnImpl
    this.timeoutMs = timeoutMs
    this.argvPrefix = null
  }

  args(extra = []) {
    return [this.bin, ...(this.serverName ? [`--ego-server-name=${this.serverName}`] : []), ...extra]
  }

  runProcess(extra, input = '', signal) {
    const argv = this.args(extra)
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(argv[0], argv.slice(1), {
        cwd: process.cwd(),
        env: safeEnv(process.env, this.env),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        resolve(value)
      }
      const fail = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reject(error)
      }
      const abort = () => {
        child.kill?.('SIGTERM')
        fail(Object.assign(new Error('The Ego Lite command was cancelled.'), { code: 'ABORT_ERR' }))
      }
      const timer = setTimeout(() => {
        child.kill?.('SIGTERM')
        fail(new Error('The Ego Lite command timed out.'))
      }, this.timeoutMs)
      if (signal?.aborted) return abort()
      signal?.addEventListener('abort', abort, { once: true })
      child.once?.('error', fail)
      child.once?.('close', (code, closeSignal) => finish({ stdout, stderr, code, signal: closeSignal }))
      child.stdout?.on('data', chunk => {
        if (stdout.length < EGO_OUTPUT_MAX) stdout += String(chunk)
      })
      child.stderr?.on('data', chunk => {
        if (stderr.length < EGO_OUTPUT_MAX) stderr += String(chunk)
      })
      child.stdin?.end(input)
    })
  }

  async version(signal) {
    const run = await this.runProcess(['--version'], '', signal)
    const line = (run.stdout.trim() || run.stderr.trim()).split('\n')[0]
    return line || 'unknown'
  }

  async probe(signal) {
    if (this.argvPrefix !== null) return this.argvPrefix
    for (const prefix of [['nodejs'], []]) {
      const run = await this.runProcess(prefix, `console.log(${markerExpression()}, JSON.stringify({ ok: true }))`, signal)
      if (resultFrom(run.stdout, run.stderr).value?.ok === true) {
        this.argvPrefix = prefix
        return prefix
      }
    }
    throw new Error('The installed ego-browser command did not run a probe script. Update or finish onboarding Ego Lite.')
  }

  async run(script, signal) {
    const prefix = await this.probe(signal)
    const run = await this.runProcess(prefix, script, signal)
    return { ...resultFrom(run.stdout, run.stderr), code: run.code, runSignal: run.signal }
  }

  async status(profileId, signal) {
    const [version, prefix] = await Promise.all([this.version(signal), this.probe(signal)])
    const probe = await this.run(fixedScript([
      `const __profiles = await profiles()`,
      `const __selected = __profiles.find(item => item.id === ${JSON.stringify(profileId)})`,
      `__anbotEmit({ ok: true, version: process.version, taskSpace: typeof taskSpace === 'function', handoff: typeof takeOverTaskSpace === 'function' && typeof taskSpace === 'function', profile: __selected ? { found: true, default: __selected.isDefault } : { found: false, default: false } })`,
    ]), signal)
    return { version, prefix, ...probe }
  }
}

export function createEgoControl({
  cli,
  profileFor,
  getHold = () => null,
  setHold = () => {},
  randomId = randomUUID,
} = {}) {
  const states = new Map()
  const pending = new Map()

  const withLock = (botId, task) => {
    const previous = pending.get(botId) ?? Promise.resolve()
    const running = previous.catch(() => {}).then(task)
    pending.set(botId, running)
    return running.finally(() => {
      if (pending.get(botId) === running) pending.delete(botId)
    })
  }

  async function act(action, args, context) {
    const { botId, signal } = context
    const profileId = profileFor(botId)
    if (profileId === '') return { text: 'Ego Lite needs a dedicated profile mapped to this Bot before it can run.' }
    if (action === 'status') {
      try {
        const status = await cli.status(profileId, signal)
        if (!status.value?.ok) return { text: `Ego Lite probe failed: ${status.value?.error ?? status.stderr ?? 'unknown error'}` }
        const profile = status.value.profile
        if (!profile?.found) return { text: `Ego Lite is ${status.version}, but the configured profile was not found.` }
        if (profile.default) return { text: 'Ego Lite is installed, but the configured profile is the personal default. Map this Bot to a dedicated non-default profile.' }
        return { text: `Ego Lite is ready (${status.version}); CLI probe passed; dedicated profile found; TaskSpace and handoff helpers are available.` }
      } catch (error) {
        return { text: `Ego Lite is unavailable: ${error?.message ?? error}` }
      }
    }

    const state = states.get(botId)
    const hold = getHold(botId)
    if (hold?.by === 'user') return { text: 'The user controls this Ego Lite browser. Wait for them to give it back before continuing.' }
    if (state?.held && action !== 'resume' && action !== 'close') return { text: 'Ego Lite is waiting for the user. Resume it after they give the browser back.' }

    try {
      if (action === 'open') {
        const url = assertUrl(args.url)
        const current = state ?? { spaceName: `anbot-ego-${botId}-${randomId()}`, pageLabel: 'p1' }
        const run = await cli.run(scriptFor('open', { profileId, spaceName: current.spaceName, url }), signal)
        if (!run.value?.ok) return takeoverOrError(run, botId)
        states.set(botId, { ...current, spaceId: run.value.spaceId, held: false })
        const page = trimSnapshot(run.value.snapshot)
        return { text: `Opened in Ego Lite.\nTitle: ${run.value.title || '(none)'}\nURL: ${run.value.url}\nTaskSpace: ${run.value.spaceId}\nPage: ${run.value.page}${page.truncated ? '\nSnapshot truncated.' : ''}\n\n${page.snapshot}` }
      }
      if (state?.spaceId === undefined) return { text: 'Open a page with action "open" before using this Ego Lite action.' }
      if (action === 'snapshot') {
        const run = await cli.run(scriptFor('snapshot', state), signal)
        if (!run.value?.ok) return takeoverOrError(run, botId)
        const page = trimSnapshot(run.value.snapshot)
        return { text: `Ego Lite page.\nTitle: ${run.value.title || '(none)'}\nURL: ${run.value.url}${page.truncated ? '\nSnapshot truncated.' : ''}\n\n${page.snapshot}` }
      }
      if (action === 'screenshot') {
        const directory = await mkdtemp(join(tmpdir(), 'anbot-ego-shot-'))
        const path = join(directory, 'page.png')
        try {
          const run = await cli.run(scriptFor('screenshot', { ...state, screenshotPath: path }), signal)
          if (!run.value?.ok) return takeoverOrError(run, botId)
          const data = await readFile(path)
          return { text: `Ego Lite screenshot. Title: ${run.value.title || '(none)'}\nURL: ${run.value.url}`, image: data.toString('base64') }
        } finally {
          await rm(directory, { recursive: true, force: true }).catch(() => {})
        }
      }
      if (action === 'click') {
        const target = assertTarget(args.target)
        const run = await cli.run(scriptFor('click', { ...state, target, label: String(args.label ?? '').slice(0, 80) }), signal)
        if (!run.value?.ok) return takeoverOrError(run, botId)
        const page = trimSnapshot(run.value.snapshot)
        return { text: `Followed an ordinary link in Ego Lite.\nTitle: ${run.value.title || '(none)'}\nURL: ${run.value.url}${page.truncated ? '\nSnapshot truncated.' : ''}\n\n${page.snapshot}` }
      }
      if (action === 'handoff') {
        const note = String(args.note ?? 'Inspect this page and give the browser back when ready.').replace(/\s+/g, ' ').trim().slice(0, 500)
        const run = await cli.run(scriptFor('handoff', state), signal)
        if (!run.value?.ok) return takeoverOrError(run, botId)
        const next = { ...state, held: true }
        states.set(botId, next)
        setHold(botId, { by: 'bot', reason: 'other', note })
        return { text: `Ego Lite is now with the user. ${note}` }
      }
      if (action === 'resume') {
        if (!state.held) return { text: 'Ego Lite is already under the Bot’s control.' }
        const run = await cli.run(scriptFor('resume', state), signal)
        if (!run.value?.ok) return takeoverOrError(run, botId)
        states.set(botId, { ...state, held: false })
        setHold(botId, null)
        return { text: `Ego Lite control returned to the Bot.\nTitle: ${run.value.title || '(none)'}\nURL: ${run.value.url}` }
      }
      if (action === 'close') {
        if (state.held) return { text: 'The user still controls Ego Lite. The Bot cannot close their tab.' }
        const run = await cli.run(scriptFor('close', state), signal)
        if (!run.value?.ok) return takeoverOrError(run, botId)
        states.delete(botId)
        setHold(botId, null)
        return { text: 'Closed this Bot’s dedicated Ego Lite TaskSpace.' }
      }
      return { text: `Unknown Ego Lite action ${action}.` }
    } catch (error) {
      return { text: `Ego Lite action failed: ${error?.message ?? error}` }
    }

    function takeoverOrError(run, currentBotId) {
      if (run.value?.takeover) {
        const current = states.get(currentBotId)
        if (current) states.set(currentBotId, { ...current, held: true })
        setHold(currentBotId, { by: 'user', reason: 'takeover', note: 'The user took control in Ego Lite.' })
        return { text: 'The user took control in Ego Lite. Do not retry or take the page back until they give it back.' }
      }
      return { text: `Ego Lite action failed: ${run.value?.error ?? run.stderr ?? 'unknown error'}` }
    }
  }

  return {
    async execute(args = {}, context = {}) {
      const action = String(args.action ?? '')
      if (!ACTIONS.has(action)) return { text: 'Choose an Ego Lite action: status, open, snapshot, screenshot, click, handoff, resume, or close.' }
      if (typeof context.botId !== 'string' || context.botId === '') return { text: 'Only Bots on the team can use Ego Lite.' }
      return withLock(context.botId, () => act(action, args, context))
    },
  }
}
