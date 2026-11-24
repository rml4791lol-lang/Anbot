import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { SOURCE_KIND } from './constants.js'

const execute = promisify(execFile)
const cleanGitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/iu.test(name)))

const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })
const hasLineBreak = value => value.includes('\0') || value.includes('\r') || value.includes('\n')

/** @returns {Readonly<import('./harness-contracts.js').TaskRef>} */
export function normalizeTaskRef(value) {
  const taskId = value?.taskId
  const attemptId = value?.attemptId
  if (typeof taskId !== 'string' || typeof attemptId !== 'string' || taskId === '' || attemptId === '') {
    throw refused('The checkpoint has no complete TaskRef.')
  }
  if (taskId.trim() !== taskId || attemptId.trim() !== attemptId || hasLineBreak(taskId) || hasLineBreak(attemptId)
    || taskId.length > 1024 || attemptId.length > 1024) {
    throw refused('The checkpoint TaskRef is invalid.')
  }
  return Object.freeze({ taskId, attemptId })
}

export const sameTaskRef = (left, right) => {
  if (left === undefined || right === undefined) return left === right
  return typeof left.taskId === 'string' && left.taskId !== ''
    && typeof left.attemptId === 'string' && left.attemptId !== ''
    && left.taskId === right.taskId && left.attemptId === right.attemptId
}

export function checkpointTaskRef(events, throughSequence) {
  if (!Number.isSafeInteger(throughSequence) || throughSequence < 0 || !Array.isArray(events)) {
    throw refused('The checkpoint has no recoverable conversation boundary.')
  }
  const start = events.findLastIndex(event => event?.type === 'turn/start'
    && Number.isSafeInteger(event.seq) && event.seq <= throughSequence)
  if (start === -1) return undefined
  const turn = events[start].data?.turn
  if (!Number.isSafeInteger(turn)) return undefined
  const end = events.findIndex((event, index) => index > start && event?.type === 'turn/end'
    && Number.isSafeInteger(event.seq) && event.seq <= throughSequence && event.data?.turn === turn)
  const boundary = end === -1 ? throughSequence : events[end].seq
  let task
  // The pinned AgentLoop appends turn/start before the step's user/message.
  // UserMessage carries source at data.source and has no data.turn field.
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index]
    if (!Number.isSafeInteger(event?.seq) || event.seq > boundary) break
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== SOURCE_KIND) continue
    if (source?.taskId === undefined && source?.attemptId === undefined) continue
    const current = normalizeTaskRef(source)
    if (task !== undefined && !sameTaskRef(task, current)) {
      throw refused('The checkpoint turn has conflicting task identities.')
    }
    task = current
  }
  return task
}

export async function snapshotWorktree(root, taskRef) {
  const temp = await mkdtemp(join(tmpdir(), 'anbot-git-checkpoint-'))
  const env = cleanGitEnv()
  Object.assign(env, { GIT_INDEX_FILE: join(temp, 'index'), GIT_AUTHOR_NAME: 'Anbot', GIT_AUTHOR_EMAIL: 'anbot@localhost', GIT_COMMITTER_NAME: 'Anbot', GIT_COMMITTER_EMAIL: 'anbot@localhost' })
  const git = async (...args) => (await execute('git', ['-C', root, ...args], { env, windowsHide: true, timeout: 30000 })).stdout.trim()
  const task = taskRef === undefined ? undefined : normalizeTaskRef(taskRef)
  try {
    const head = await git('rev-parse', 'HEAD')
    await git('read-tree', head)
    // Phase 1A captures paths tracked at HEAD only. Untracked and ignored
    // workspace output is excluded from the snapshot.
    await git('add', '--update')
    const tree = await git('write-tree')
    const commit = await git('-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', head, '-m', 'Anbot workspace checkpoint')
    const checkpointRef = `refs/anbot/checkpoints/${randomUUID()}`
    await git('update-ref', checkpointRef, commit)
    return { checkpointRef, commit, head, ...(task ? { task } : {}), discard: () => git('update-ref', '-d', checkpointRef, commit) }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

export const checkpointWorktree = (root, id) => join(dirname(root), `.anbot-restore-${id}`)

function restoreGit(root) {
  const env = cleanGitEnv()
  return async (...args) => (await execute('git', ['-C', root, ...args], { env, windowsHide: true, timeout: 30000 })).stdout
}

export async function materializeCheckpoint(root, record, worktree) {
  const git = restoreGit(root)
  const commit = (await git('rev-parse', '--verify', `${record.checkpointRef}^{commit}`)).trim()
  if (commit !== record.commit) throw new Error('The checkpoint ref no longer points to the saved Git snapshot.')
  await git('-c', `core.hooksPath=${join(worktree, '.anbot-no-hooks')}`, 'worktree', 'add', '--detach', worktree, commit)
}

export async function checkCheckpointWorktree(root, worktree, commit, sessionId) {
  if (sessionId !== undefined && worktree !== checkpointWorktree(root, sessionId)) {
    throw new Error('The interrupted restore path is not the reserved checkpoint worktree.')
  }
  const git = restoreGit(root)
  let exists = true
  try {
    if (!(await lstat(worktree)).isDirectory()) throw new Error('The interrupted restore path is not an owned directory.')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    exists = false
  }
  const entries = (await git('worktree', 'list', '--porcelain', '-z')).split('\0\0')
  const gitPath = process.platform === 'win32' ? worktree.replaceAll('\\', '/') : worktree
  const entry = entries.map(row => row.split('\0')).find(row => row[0] === `worktree ${gitPath}`)
  if (!entry && !exists) return false
  if (!entry?.includes(`HEAD ${commit}`) || !entry.includes('detached')) {
    throw new Error('The interrupted restore path no longer matches its Git checkout.')
  }
  if (exists && (await restoreGit(worktree)('status', '--porcelain', '--untracked-files=all', '--ignored')).trim() !== '') {
    throw new Error('The interrupted restore has working files. Review them before retrying.')
  }
  return true
}

export async function discardCheckpointWorktree(root, worktree, commit, { sessionId } = {}) {
  if (await checkCheckpointWorktree(root, worktree, commit, sessionId)) {
    await restoreGit(root)('worktree', 'remove', worktree)
  }
}

export async function discardCheckpointRef(record) {
  const { checkpointRef, commit, worktree } = record
  if (!/^refs\/anbot\/checkpoints\/[0-9a-f-]{36}$/u.test(checkpointRef) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(commit)) {
    throw refused('This is not a valid Anbot checkpoint ref.')
  }
  const git = restoreGit(worktree)
  try { await git('show-ref', '--verify', '--quiet', checkpointRef) } catch (error) {
    if (error.code === 1) return
    throw error
  }
  await git('update-ref', '--no-deref', '-d', checkpointRef, commit)
}
