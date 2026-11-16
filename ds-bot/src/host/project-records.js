// Append-only project history. The ledger lives in DS Bot's own data folder,
// never in the project, so recording work cannot dirty the user's repository.
// Git stays the authority for commits and the current working tree; the ledger
// adds the intent and progress that Git cannot carry.
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, lstat, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'

const runFile = promisify(execFile)
const RECORD_DIR = 'project-records'
const LEDGER_FILE = 'changes.jsonl'
const STATE_DIR = 'state'
const STATE_VERSION = 1
const READ_TAIL = 1024 * 1024
const MAX_FILES = 80
const MAX_EVIDENCE = 16
const MAX_CONTRIBUTORS = 16
const MAX_SCAN_FILES = 5000
const MAX_DEPTH = 18
const GIT_TIMEOUT = 6_000
const GIT_MAX_BUFFER = 512 * 1024
const KINDS = new Set(['change', 'progress', 'decision', 'checkpoint'])
const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', '.ds-bot', 'node_modules', '.next', '.nuxt', '.cache',
  '.turbo', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', 'Pods',
  '.venv', 'venv', '__pycache__', '.idea', '.vscode',
])
const INTERNAL_FILES = new Set(['.ds-bot/changes.jsonl', '.ds-bot/change-state.json'])

const clampText = (value, max) => String(value ?? '').replaceAll('\u0000', '').trim().slice(0, max)
const unique = values => [...new Set(values.filter(Boolean))]
const hash = text => createHash('sha256').update(String(text)).digest('hex')
const stamp = value => Number.isFinite(value) ? value : (Date.parse(String(value ?? '')) || 0)
const normalizePath = path => String(path ?? '').replaceAll('\\', '/').replace(/^\.\//, '')

function safeRelative(folder, path) {
  const raw = normalizePath(path)
  if (raw === '' || raw.startsWith('../') || raw.includes('/../') || raw.startsWith('/')) return undefined
  const absolute = resolve(folder, raw)
  const inside = relative(resolve(folder), absolute)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined
  return normalizePath(inside)
}

export function normalizeChangeFiles(folder, files) {
  if (!Array.isArray(files)) return []
  return unique(files.flatMap((file) => {
    if (typeof file !== 'string') return []
    const raw = file.trim()
    if (raw === '') return []
    const absolute = isAbsolute(raw) ? raw : undefined
    const rel = absolute === undefined ? safeRelative(folder, raw) : safeRelative(folder, relative(folder, absolute))
    return rel === undefined ? [] : [rel.slice(0, 400)]
  })).slice(0, MAX_FILES)
}

export function projectChangeEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const at = stamp(value.at)
  const id = clampText(value.id, 180)
  const project = clampText(value.project, 1200)
  const summary = clampText(value.summary, 500)
  if (at <= 0 || id === '' || project === '' || summary === '') return undefined
  const files = unique(Array.isArray(value.files) ? value.files.filter(file => typeof file === 'string').flatMap((file) => {
    const path = normalizePath(file).slice(0, 400)
    return path === '' || path.startsWith('../') || path.startsWith('/') || path.includes('/../') ? [] : [path]
  }) : []).slice(0, MAX_FILES)
  const evidence = unique(Array.isArray(value.evidence) ? value.evidence.filter(item => typeof item === 'string').map(item => clampText(item, 500)) : []).slice(0, MAX_EVIDENCE)
  const contributors = unique(Array.isArray(value.contributors) ? value.contributors.filter(item => typeof item === 'string').map(item => clampText(item, 80)) : []).slice(0, MAX_CONTRIBUTORS)
  const kind = KINDS.has(value.kind) ? value.kind : 'change'
  const action = ['recorded', 'detected', 'committed', 'working'].includes(value.action) ? value.action : 'recorded'
  const sourceKind = ['bot', 'automatic', 'git', 'filesystem', 'github'].includes(value.sourceKind) ? value.sourceKind : 'bot'
  const verification = ['reported', 'observed'].includes(value.verification) ? value.verification : 'reported'
  return {
    version: 1,
    id,
    at,
    project,
    kind,
    action,
    actor: clampText(value.actor, 100) || 'DS Bot',
    actorId: clampText(value.actorId, 180) || null,
    contributors,
    summary,
    reason: clampText(value.reason, 1200),
    files,
    evidence,
    progress: {
      before: clampText(value.progress?.before ?? value.before, 1200),
      after: clampText(value.progress?.after ?? value.after, 1200),
    },
    source: clampText(value.source, 240) || 'DS Bot',
    sourceKind,
    verification,
    sessionId: clampText(value.sessionId, 180) || null,
    roomId: clampText(value.roomId, 180) || null,
  }
}

export function parseProjectChanges(text, project) {
  const wanted = project === undefined ? undefined : resolve(project)
  const seen = new Set()
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '' || line.length > 24_000) continue
    let value
    try { value = JSON.parse(line) } catch { continue }
    const entry = projectChangeEntry(value)
    if (entry === undefined || seen.has(entry.id)) continue
    if (wanted !== undefined && resolve(entry.project) !== wanted) continue
    seen.add(entry.id)
    rows.push(entry)
  }
  return rows.sort((a, b) => b.at - a.at)
}

export function gitStatusFiles(text) {
  const fields = String(text ?? '').split('\u0000')
  const rows = []
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (field.length < 4) continue
    const status = field.slice(0, 2)
    const path = normalizePath(field.slice(3))
    if (path === '' || INTERNAL_FILES.has(path)) continue
    rows.push({ status, path })
    if (/[RC]/.test(status)) i += 1
  }
  return rows.filter((row, index, all) => all.findIndex(other => other.path === row.path && other.status === row.status) === index)
}

export function gitLogEntries(text, project) {
  const wanted = resolve(project)
  return String(text ?? '').split('\u001e').flatMap((block) => {
    if (block.trim() === '') return []
    const lines = block.trim().split(/\r?\n/)
    const [commit, date, author, ...subjectParts] = (lines.shift() ?? '').split('\u001f')
    if (!/^[0-9a-f]{7,64}$/i.test(commit ?? '') || stamp(date) <= 0) return []
    const files = unique(lines.map(line => normalizePath(line.trim())).filter(path => path !== '' && !INTERNAL_FILES.has(path))).slice(0, MAX_FILES)
    return [{
      version: 1,
      id: `git:${commit}`,
      at: stamp(date),
      project: wanted,
      kind: 'change',
      action: 'committed',
      actor: clampText(author, 100) || 'Git',
      actorId: null,
      contributors: [],
      summary: clampText(subjectParts.join('\u001f'), 500) || commit.slice(0, 12),
      reason: '',
      files,
      evidence: [`commit ${commit}`],
      progress: { before: '', after: '' },
      source: `Git ${commit.slice(0, 12)}`,
      sourceKind: 'git',
      verification: 'observed',
      sessionId: null,
      roomId: null,
    }]
  })
}

async function git(folder, args) {
  const result = await runFile('git', ['-C', folder, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  })
  return result.stdout ?? ''
}

async function gitFacts(folder) {
  try {
    const inside = (await git(folder, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return { available: false, commits: [], working: [], head: '' }
    const head = (await git(folder, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim()
    const prefix = (await git(folder, ['rev-parse', '--show-prefix'])).trim()
    const status = await git(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])
    const working = gitStatusFiles(status).flatMap((row) => {
      if (prefix === '' || row.path.startsWith(prefix)) return [{ ...row, path: prefix === '' ? row.path : row.path.slice(prefix.length) }]
      return []
    })
    const workingState = await workingTreeState(folder, working)
    const workingAt = Math.max(0, ...workingState.map(row => row.mtimeMs ?? 0))
    let log = ''
    if (head !== '') {
      log = await git(folder, [
        'log', '-n', '30', '--no-merges', '--relative',
        '--format=%x1e%H%x1f%aI%x1f%an%x1f%s', '--name-only', '--', '.',
      ])
    }
    return { available: true, commits: gitLogEntries(log, folder), working, workingState, workingAt, head }
  } catch (error) {
    return { available: false, commits: [], working: [], head: '', error: error?.code ?? 'git unavailable' }
  }
}

async function readTail(path, max) {
  const info = await stat(path).catch(() => undefined)
  if (info === undefined || !info.isFile()) return ''
  const length = Math.min(info.size, max)
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, Math.max(0, info.size - length))
    const text = buffer.toString('utf8')
    return info.size > length ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await file.close()
  }
}

const ledgerPath = home => join(home, RECORD_DIR, LEDGER_FILE)
const statePath = (home, folder) => join(home, RECORD_DIR, STATE_DIR, `${hash(resolve(folder))}.json`)
const writes = new Map()
const ledgerCache = new Map()

function serial(path, run) {
  const previous = writes.get(path) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(run)
  writes.set(path, next)
  return next.finally(() => {
    if (writes.get(path) === next) writes.delete(path)
  })
}

export async function readProjectChanges(home, folder) {
  const key = resolve(home)
  const cached = ledgerCache.get(key)
  const text = cached !== undefined && Date.now() - cached.at < 1_000
    ? cached.text
    : await readTail(ledgerPath(home), READ_TAIL)
  if (cached === undefined || Date.now() - cached.at >= 1_000) ledgerCache.set(key, { at: Date.now(), text })
  return parseProjectChanges(text, folder).slice(0, 160)
}

export async function writeProjectChange(home, entry) {
  const row = projectChangeEntry(entry)
  if (row === undefined) throw new Error('Invalid project change record')
  const path = ledgerPath(home)
  return serial(path, async () => {
    const existing = parseProjectChanges(await readTail(path, READ_TAIL), row.project)
    if (existing.some(item => item.id === row.id)) return false
    await mkdir(join(home, RECORD_DIR), { recursive: true })
    await appendFile(path, `${JSON.stringify(row)}\n`, 'utf8')
    ledgerCache.delete(resolve(home))
    return true
  })
}

async function scanTree(folder) {
  const files = {}
  const stack = [{ path: folder, depth: 0 }]
  let truncated = false
  while (stack.length > 0 && Object.keys(files).length < MAX_SCAN_FILES) {
    const { path, depth } = stack.pop()
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (Object.keys(files).length >= MAX_SCAN_FILES) { truncated = true; break }
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || depth >= MAX_DEPTH) continue
        stack.push({ path: join(path, entry.name), depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      const absolute = join(path, entry.name)
      const rel = safeRelative(folder, relative(folder, absolute))
      if (rel === undefined || INTERNAL_FILES.has(rel)) continue
      const info = await stat(absolute).catch(() => undefined)
      if (info !== undefined) files[rel] = { size: info.size, mtimeMs: Math.round(info.mtimeMs) }
    }
  }
  return { files, truncated }
}

function treeChanges(before, after) {
  const names = unique([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]).sort()
  return names.flatMap((path) => {
    const old = before?.[path]
    const next = after?.[path]
    if (old === undefined && next !== undefined) return [{ path, status: 'A' }]
    if (old !== undefined && next === undefined) return [{ path, status: 'D' }]
    if (old.size !== next.size || old.mtimeMs !== next.mtimeMs) return [{ path, status: 'M' }]
    return []
  })
}

async function workingTreeState(folder, working) {
  return Promise.all(working.map(async (row) => {
    const info = await lstat(join(folder, row.path)).catch(() => undefined)
    return {
      status: row.status,
      path: row.path,
      size: info?.isFile() ? info.size : null,
      mtimeMs: info?.isFile() ? Math.round(info.mtimeMs) : null,
    }
  }))
}

function workingTreeChanges(before, after) {
  const old = new Map((before ?? []).filter(row => row && typeof row.path === 'string').map(row => [row.path, JSON.stringify(row)]))
  const next = new Map(after.map(row => [row.path, JSON.stringify(row)]))
  return unique([...old.keys(), ...next.keys()]).flatMap((path) => {
    if (old.get(path) === next.get(path)) return []
    return [{ path, status: after.find(row => row.path === path)?.status ?? 'reverted' }]
  }).map(row => ({ path: row.path, status: row.status }))
}

async function snapshotState(home, folder, gitInfo) {
  const path = statePath(home, folder)
  return serial(path, async () => {
    const previous = await readFile(path, 'utf8').then(JSON.parse).catch(() => undefined)
    let next
    let changed = []
    if (gitInfo?.available) {
      const gitStatus = gitInfo.workingState ?? await workingTreeState(folder, gitInfo.working)
      next = {
        version: STATE_VERSION,
        at: Date.now(),
        gitHead: gitInfo.head,
        gitStatus,
      }
      changed = workingTreeChanges(previous?.gitStatus, gitStatus)
      // A new commit already appears as a Git event. Only keep still-uncommitted
      // paths here instead of recording the same commit a second time.
      if (previous?.gitHead !== undefined && previous.gitHead !== gitInfo.head) {
        const present = new Set(gitStatus.map(row => row.path))
        changed = changed.filter(row => present.has(row.path))
      }
    } else {
      const tree = await scanTree(folder)
      next = { version: STATE_VERSION, at: Date.now(), tree: tree.files, truncated: tree.truncated }
      if (previous?.tree !== undefined && !previous.truncated && !tree.truncated) changed = treeChanges(previous.tree, tree.files)
    }
    await mkdir(join(home, RECORD_DIR, STATE_DIR), { recursive: true })
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(next), 'utf8')
    await import('node:fs/promises').then(({ rename }) => rename(temp, path))
    return { first: previous === undefined, changed, git: Boolean(gitInfo?.available) }
  })
}

export async function captureProjectChanges(home, folder, context = {}) {
  const absolute = resolve(folder)
  const gitInfo = await gitFacts(absolute)
  const state = await snapshotState(home, absolute, gitInfo)
  if (state.first || state.changed.length === 0) return { recorded: false, files: [] }
  const files = unique(state.changed.map(row => row.path)).slice(0, MAX_FILES)
  if (files.length === 0) return { recorded: false, files: [] }
  const at = Date.now()
  const entry = {
    version: 1,
    id: `auto:${hash(`${absolute}\n${at}\n${files.join('\n')}`)}`,
    at,
    project: absolute,
    kind: 'change',
    action: 'detected',
    actor: clampText(context.actor, 100) || 'DS Bot',
    actorId: context.actorId ?? null,
    contributors: [],
    summary: state.git ? 'Working tree changed' : 'Project files changed',
    reason: 'Automatically observed after project work.',
    files,
    evidence: [state.git ? 'Git working tree' : 'File size and modification time'],
    progress: { before: '', after: '' },
    source: state.git ? 'Git working tree' : 'Project files',
    sourceKind: 'automatic',
    verification: 'observed',
    sessionId: context.sessionId ?? null,
    roomId: context.roomId ?? null,
  }
  await writeProjectChange(home, entry)
  return { recorded: true, files, entry }
}

export async function projectChangeFacts(home, folder) {
  if (typeof folder !== 'string' || folder === '') {
    return { entries: [], count: 0, updatedAt: 0, git: { available: false, working: 0 }, sources: { bot: 0, automatic: 0, git: 0 } }
  }
  const absolute = resolve(folder)
  const [ledger, gitInfo] = await Promise.all([readProjectChanges(home, absolute), gitFacts(absolute)])
  const working = gitInfo.working
  const workingEntry = working.length === 0 ? [] : [{
    version: 1,
    id: `working:${hash(working.map(row => `${row.status}\t${row.path}`).join('\n'))}`,
    at: gitInfo.workingAt || gitInfo.commits[0]?.at || Date.now(),
    project: absolute,
    kind: 'change',
    action: 'working',
    actor: 'Git',
    actorId: null,
    contributors: [],
    summary: `${working.length} uncommitted ${working.length === 1 ? 'file' : 'files'}`,
    reason: '',
    files: unique(working.map(row => row.path)).slice(0, MAX_FILES),
    evidence: ['git status'],
    progress: { before: '', after: '' },
    source: 'Git working tree',
    sourceKind: 'git',
    verification: 'observed',
    sessionId: null,
    roomId: null,
  }]
  const entries = [...ledger, ...gitInfo.commits, ...workingEntry]
    .filter((entry, index, all) => all.findIndex(other => other.id === entry.id) === index)
    .sort((a, b) => b.at - a.at)
    .slice(0, 160)
  return {
    entries,
    count: entries.length,
    updatedAt: entries[0]?.at ?? 0,
    git: { available: gitInfo.available, head: gitInfo.head, working: working.length },
    sources: {
      bot: entries.filter(entry => entry.sourceKind === 'bot').length,
      automatic: entries.filter(entry => entry.sourceKind === 'automatic' || entry.sourceKind === 'filesystem').length,
      git: entries.filter(entry => entry.sourceKind === 'git').length,
    },
  }
}

const clean = (rt, value, max) => clampText(rt.redactSecrets?.(String(value ?? '')) ?? value, max)
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

export function install(rt) {
  const { ctx, home } = rt
  const captureTimers = new Map()
  let disposed = false
  let scanning = false

  const sessionProject = async (sessionId, options = {}) => {
    await rt.load()
    const self = rt.selfOf?.(sessionId)
    const bot = rt.botOf?.(self)
    if (bot === undefined) return undefined
    const roomId = rt.groupOwners?.get(sessionId)?.roomId
    const room = roomId === undefined ? undefined : rt.roomOf?.(roomId)
    const folder = room?.workDir ?? bot.workDir
    if (typeof folder !== 'string' || folder === '') return undefined
    if (!(await rt.isFolder(folder))) return undefined
    return { folder, actor: options.actor ?? bot.name, actorId: bot.id, sessionId, roomId }
  }

  const capture = async (folder, context = {}) => {
    if (disposed || rt.readOnly?.() !== undefined) return { recorded: false, files: [] }
    try {
      return await captureProjectChanges(home, folder, context)
    } catch (error) {
      rt.warn?.('ds-bot: project changes in %s were not captured: %s', folder, error?.message ?? error)
      return { recorded: false, files: [] }
    }
  }

  const schedule = (folder, context) => {
    if (disposed || captureTimers.has(folder)) return
    const timer = setTimeout(() => {
      captureTimers.delete(folder)
      void capture(folder, context)
    }, 900)
    timer.unref?.()
    captureTimers.set(folder, timer)
  }

  ctx.on?.('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || agent?.id === undefined) return
    void sessionProject(agent.id).then((project) => {
      if (project !== undefined) schedule(project.folder, project)
    })
  })

  const allProjects = async () => {
    if (disposed || rt.readOnly?.() !== undefined) return
    if (scanning) return
    scanning = true
    try {
      await rt.load()
      const folders = unique([
        ...Object.values(rt.state?.bots ?? {}).map(bot => bot.workDir),
        ...Object.values(rt.state?.rooms ?? {}).map(room => room.workDir),
      ].filter(folder => typeof folder === 'string' && folder !== ''))
      for (const folder of folders) {
        if (disposed || rt.readOnly?.() !== undefined) break
        if (await rt.isFolder(folder)) await capture(folder, { actor: 'DS Bot' })
      }
    } catch (error) {
      rt.warn?.('ds-bot: project record scan failed: %s', error?.message ?? error)
    } finally {
      scanning = false
    }
  }

  ctx.effect?.(() => {
    const first = setTimeout(() => { void allProjects() }, 8_000)
    first.unref?.()
    const timer = setInterval(() => { void allProjects() }, 60_000)
    timer.unref?.()
    return () => {
      disposed = true
      clearTimeout(first)
      clearInterval(timer)
      for (const pending of captureTimers.values()) clearTimeout(pending)
      captureTimers.clear()
    }
  }, 'ds-bot: project change capture')

  Object.assign(rt, {
    projectChangeFacts: folder => projectChangeFacts(home, folder),
    captureProjectChanges: async ({ folder, all = false, ...context } = {}) => {
      if (all === true) {
        await allProjects()
        return { recorded: false, files: [] }
      }
      return capture(folder, context)
    },
  })

  rt.teamTools.push(defineTool({
    name: 'record_project_change',
    description: 'Append a durable project-history entry after real project files changed or the project reached a checkpoint. Record what changed, why, the affected files, evidence you actually ran, and the state before and after. Do not use it for reads, routine chat, or unverified claims. If a teammate is the project record keeper, send it the completed change facts so it can record them here.',
    parameters: {
      summary: { type: 'string', required: true, description: 'One concrete sentence describing what changed or what checkpoint was reached' },
      reason: { type: 'string', required: true, description: 'Why the change was made, in one or two sentences' },
      kind: { type: 'string', enum: [...KINDS], description: 'change (default), progress, decision, or checkpoint' },
      files: { type: 'array', items: { type: 'string' }, description: 'Project-relative files changed. Omit to use the current Git working tree files' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Tests, checks, screenshots, or artifacts you actually ran or produced' },
      before: { type: 'string', description: 'What was true before this step' },
      after: { type: 'string', description: 'What is true now' },
      contributors: { type: 'array', items: { type: 'string' }, description: 'Bots or people who did the work when a recorder is recording for them' },
    },
    output,
    async execute(args, exec) {
      const project = await sessionProject(exec.agent?.id)
      if (project === undefined) throw new Error('This Bot has no project working folder to record. Set its working folder or use the group folder first.')
      const summary = clean(rt, args.summary, 500)
      const reason = clean(rt, args.reason, 1200)
      if (summary === '') throw new Error('summary is required')
      if (reason === '') throw new Error('reason is required')
      const gitInfo = await gitFacts(project.folder)
      const files = normalizeChangeFiles(project.folder, args.files?.length ? args.files : gitInfo.working.map(row => row.path))
      const contributors = unique((args.contributors ?? []).filter(item => typeof item === 'string').map(item => clean(rt, item, 80))).slice(0, MAX_CONTRIBUTORS)
      const kind = KINDS.has(args.kind) ? args.kind : 'change'
      const entry = projectChangeEntry({
        version: 1,
        id: `bot:${typeof exec.callId === 'string' && exec.callId !== '' ? exec.callId : randomUUID()}`,
        at: Date.now(),
        project: project.folder,
        kind,
        action: 'recorded',
        actor: project.actor,
        actorId: project.actorId,
        contributors,
        summary,
        reason,
        files,
        evidence: (args.evidence ?? []).filter(item => typeof item === 'string').map(item => clean(rt, item, 500)).slice(0, MAX_EVIDENCE),
        progress: { before: clean(rt, args.before, 1200), after: clean(rt, args.after, 1200) },
        source: project.roomId === undefined ? project.actor : `${project.actor} in ${rt.roomOf(project.roomId)?.name ?? 'group chat'}`,
        sourceKind: 'bot',
        verification: 'reported',
        sessionId: project.sessionId,
        roomId: project.roomId,
      })
      await writeProjectChange(home, entry)
      await snapshotState(home, project.folder, gitInfo)
      return `Recorded ${kind} in ${basename(project.folder)}: ${summary}`
    },
  }))
}
