import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gitRepository } from './bot-worktree.js'
import { normalize } from './text.js'

const runGit = promisify(execFile)
const RESERVATIONS = 'projectWorkspaceReservations'
const POOL = join('.agents', 'worktrees')

const gitEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/iu.test(name))),
  GIT_NO_LAZY_FETCH: '1',
  ...extra,
})

async function git(folder, args, { allow = [0], env } = {}) {
  try {
    const result = await runGit('git', ['-C', folder, ...args], {
      env: gitEnv(env), timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true,
    })
    return { ...result, code: 0 }
  } catch (error) {
    if (allow.includes(error.code)) return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }
    const detail = String(error.stderr ?? error.message).trim().split(/\r?\n/u).at(-1)
    throw new Error(`Git could not prepare the Bot project workspace${detail ? `: ${detail}` : '.'}`, { cause: error })
  }
}

const isFolder = path => stat(path).then(info => info.isDirectory(), () => false)
const inside = (inner, outer) => {
  const value = relative(outer, inner)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}
const newSessionId = () => `session-${randomUUID()}`
const pathKey = path => realpath(path).catch(() => resolve(path))

async function preparePool(repositoryRoot) {
  const agents = join(repositoryRoot, '.agents')
  const pool = join(repositoryRoot, POOL)
  const existingAgents = await realpath(agents).catch(() => undefined)
  if (existingAgents !== undefined && !inside(existingAgents, repositoryRoot)) {
    throw new Error(`The worktree pool parent ${agents} leads outside ${repositoryRoot}`)
  }
  await mkdir(agents, { recursive: true })
  let created = false
  try {
    await mkdir(pool)
    created = true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const canonical = await realpath(pool)
  if (!inside(canonical, repositoryRoot)) throw new Error(`The worktree pool ${pool} leads outside ${repositoryRoot}`)
  if (created) {
    try {
      await writeFile(join(canonical, '.gitignore'), '*\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  return canonical
}

async function registrations(repositoryRoot) {
  const { stdout } = await git(repositoryRoot, ['worktree', 'list', '--porcelain', '-z'])
  const rows = []
  let row
  for (const field of stdout.split('\0')) {
    if (field === '') {
      if (row !== undefined) rows.push(row)
      row = undefined
      continue
    }
    if (field.startsWith('worktree ')) {
      if (row !== undefined) rows.push(row)
      row = { path: field.slice('worktree '.length) }
    } else if (row !== undefined && field.startsWith('HEAD ')) row.head = field.slice('HEAD '.length)
    else if (row !== undefined && field.startsWith('branch ')) row.branch = field.slice('branch '.length)
    else if (row !== undefined && field === 'detached') row.detached = true
  }
  if (row !== undefined) rows.push(row)
  return rows
}

async function registrationAt(repositoryRoot, target) {
  const wanted = await pathKey(target)
  for (const row of await registrations(repositoryRoot)) {
    if (await pathKey(row.path) === wanted) return row
  }
  return undefined
}

async function filterOverrides(checkout) {
  const { stdout } = await git(checkout, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], { allow: [0, 1] })
  const drivers = new Set()
  for (const key of stdout.split('\0')) {
    const separator = key.lastIndexOf('.')
    if (separator > 'filter.'.length && ['clean', 'smudge', 'process', 'required'].includes(key.slice(separator + 1))) {
      drivers.add(key.slice('filter.'.length, separator))
    }
  }
  const overrides = { GIT_CONFIG_COUNT: String(drivers.size * 4) }
  let index = 0
  for (const driver of drivers) {
    for (const attribute of ['clean', 'smudge', 'process', 'required']) {
      overrides[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${attribute}`
      overrides[`GIT_CONFIG_VALUE_${index}`] = attribute === 'required' ? 'false' : ''
      index += 1
    }
  }
  return overrides
}

function tableOf(rt) {
  const current = rt.state[RESERVATIONS]
  if (current === null || typeof current !== 'object' || Array.isArray(current)) rt.state[RESERVATIONS] = {}
  return rt.state[RESERVATIONS]
}

function validRecord(record) {
  return record !== null && typeof record === 'object' && !Array.isArray(record)
    && typeof record.reservationId === 'string' && typeof record.sessionId === 'string'
    && typeof record.nameKey === 'string' && typeof record.repositoryRoot === 'string'
    && typeof record.commonDir === 'string' && typeof record.root === 'string'
    && typeof record.workingDir === 'string' && typeof record.branch === 'string'
    && typeof record.baseCommit === 'string' && typeof record.sourceRelative === 'string'
}

async function validateRecord(record, repository) {
  const expectedRoot = join(repository.value.root, POOL, record.branch)
  if (!/^anbot-[0-9a-f]{8}-[0-9a-f]{4}$/u.test(record.branch)
    || !/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(record.sessionId)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(record.baseCommit)
    || await pathKey(record.root) !== await pathKey(expectedRoot)
    || record.workingDir !== (record.sourceRelative === '' ? record.root : join(record.root, record.sourceRelative))) {
    throw new Error('The saved Bot project workspace reservation does not match its repository.')
  }
}

function reservationFor(rt, { nameKey, repositoryRoot, commonDir, sourceRelative }) {
  const table = tableOf(rt)
  return Object.values(table).find(record => validRecord(record)
    && record.nameKey === nameKey && record.repositoryRoot === repositoryRoot
    && record.commonDir === commonDir && record.sourceRelative === sourceRelative)
}

async function saveReservation(rt, record) {
  if (typeof rt.save !== 'function') throw new Error('The Bot team cannot save its project workspace reservation.')
  await rt.save({ required: true })
  return record
}

async function verifyCheckout(record) {
  if (!(await isFolder(record.root))) throw new Error(`The reserved worktree ${record.root} is missing.`)
  if (!(await isFolder(record.workingDir))) throw new Error(`The reserved worktree does not contain ${record.workingDir}.`)
  const registration = await registrationAt(record.repositoryRoot, record.root)
  if (registration === undefined || registration.branch !== `refs/heads/${record.branch}`) {
    throw new Error(`The reserved path ${record.root} is not the expected Git worktree.`)
  }
  const observed = await gitRepository(record.root)
  if (observed.status !== 'observed') throw new Error(observed.reason)
  if (!observed.value.linked || observed.value.root !== record.root || observed.value.commonDir !== record.commonDir) {
    throw new Error(`The reserved path ${record.root} belongs to another Git repository.`)
  }
  const branch = (await git(record.root, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim()
  if (branch !== record.branch) throw new Error(`The reserved worktree is on ${branch}, not ${record.branch}.`)
}

async function ensureCheckout(record) {
  await preparePool(record.repositoryRoot)
  const checkoutExists = await isFolder(record.root)
  const registration = await registrationAt(record.repositoryRoot, record.root)
  if (checkoutExists) {
    await verifyCheckout(record)
  } else {
    if (await stat(record.root).catch(() => undefined) !== undefined) throw new Error(`The reserved worktree path ${record.root} is not a folder.`)
    if (registration !== undefined) {
      if (registration.branch !== `refs/heads/${record.branch}`) {
        throw new Error(`The reserved path ${record.root} is another Git worktree.`)
      }
      await git(record.repositoryRoot, ['worktree', 'remove', '--', record.root])
    }
    const existing = await git(record.repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`], { allow: [0, 1] })
    const args = existing.code === 0
      ? ['--work-tree', record.repositoryRoot, 'worktree', 'add', '--no-checkout', '--', record.root, record.branch]
      : ['--work-tree', record.repositoryRoot, 'worktree', 'add', '--no-checkout', '-b', record.branch, '--', record.root, record.baseCommit]
    await git(record.repositoryRoot, args)
    await git(record.root, ['--work-tree', record.root, 'read-tree', '-m', '-u', 'HEAD'], { env: await filterOverrides(record.root) })
    await verifyCheckout(record)
  }
}

export async function prepareBotProjectWorkspace(rt, { name, source } = {}) {
  const cleanName = typeof name === 'string' ? name.trim() : ''
  if (cleanName === '' || typeof source !== 'string' || source === '') return undefined
  const repository = await gitRepository(source)
  if (repository.status !== 'observed') return undefined
  const sourcePath = await realpath(source)
  const sourceRelative = relative(repository.value.root, sourcePath)
  if (sourceRelative === '..' || sourceRelative.startsWith(`..${sep}`) || isAbsolute(sourceRelative)) {
    throw new Error(`${source} is outside the Git repository ${repository.value.root}`)
  }
  const nameKey = normalize(cleanName)
  let record = reservationFor(rt, {
    nameKey, repositoryRoot: repository.value.root, commonDir: repository.value.commonDir, sourceRelative,
  })
  if (record === undefined) {
    const pool = await preparePool(repository.value.root)
    const sessionId = newSessionId()
    const compact = sessionId.slice('session-'.length)
    const branch = `anbot-${compact.slice(0, 8)}-${randomBytes(2).toString('hex')}`
    const root = join(pool, branch)
    record = {
      reservationId: randomUUID(),
      sessionId,
      nameKey,
      repositoryRoot: repository.value.root,
      commonDir: repository.value.commonDir,
      sourceRelative,
      root,
      workingDir: sourceRelative === '' ? root : join(root, sourceRelative),
      branch,
      baseCommit: repository.value.revision,
      status: 'reserved',
      createdAt: Date.now(),
    }
    tableOf(rt)[record.reservationId] = record
    await saveReservation(rt, record)
  }
  await validateRecord(record, repository)
  await ensureCheckout(record)
  if (record.status !== 'ready') {
    record.status = 'ready'
    record.at = Date.now()
    await saveReservation(rt, record)
  }
  return { ...record }
}

export function claimBotProjectWorkspace(rt, reservation, sessionId) {
  const table = tableOf(rt)
  const record = table[reservation.reservationId]
  if (!validRecord(record) || record.root !== reservation.root || record.branch !== reservation.branch) {
    throw new Error('The Bot project workspace reservation changed before it could be used.')
  }
  delete table[record.reservationId]
  return {
    sessionId,
    root: record.root,
    workingDir: record.workingDir,
    branch: record.branch,
    baseCommit: record.baseCommit,
    repositoryRoot: record.repositoryRoot,
    commonDir: record.commonDir,
  }
}

export function releaseBotProjectWorkspace(rt, reservation, sessionId) {
  if (reservation === undefined) return
  const table = tableOf(rt)
  const record = table[reservation.reservationId] ?? { ...reservation }
  record.previousSessionId = sessionId
  record.sessionId = newSessionId()
  record.status = 'ready'
  record.at = Date.now()
  table[record.reservationId] = record
}

export function isBotProjectWorkspaceDir(rt, folder) {
  if (typeof folder !== 'string' || folder === '') return false
  const wanted = resolve(folder)
  return Object.values(rt.state.bots ?? {}).some(bot => typeof bot?.projectWorkspace?.workingDir === 'string'
    && resolve(bot.projectWorkspace.workingDir) === wanted)
}
