import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'

const runGit = promisify(execFile)

export async function linkedWorktree(folder) {
  if (typeof folder !== 'string' || folder === '') return { status: 'unavailable', reason: 'No working folder is set for this Bot.' }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/iu.test(name)))
  try {
    const { stdout } = await runGit('git', ['-C', folder, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir', 'HEAD'], {
      env, timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true,
    })
    const [path, metadata, common, revision] = stdout.trimEnd().split(/\r?\n/u)
    const [root, gitDir, commonDir] = await Promise.all([path, metadata, common].map(value => realpath(value)))
    if (gitDir === commonDir) return { status: 'unavailable', reason: 'The working folder is the primary checkout. Select a linked Git worktree.' }
    return { status: 'observed', value: { root, gitDir, revision } }
  } catch (error) {
    return { status: 'unavailable', reason: error.code === 'ENOENT' ? 'Git or the working folder is missing.' : 'The working folder has no readable linked Git worktree.' }
  }
}

/** @returns {Promise<import('./harness-contracts.js').WorktreeObservation>} */
export async function probeBotWorktree(rt, botId) {
  if (rt.botOf(botId) === undefined) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })
  const sessionId = rt.chatOf(botId)
  const agents = rt.ctx.get?.('agents')
  const agent = agents?.get?.(sessionId)
  const configured = await linkedWorktree(rt.workDirOf({ botId }) ?? rt.teamFolder())
  if (configured.status === 'unavailable') return configured
  const { root, gitDir, revision } = configured.value
  const value = { sessionId, root, revision }
  const at = Date.now()
  /** @type {import('./harness-contracts.js').WorktreeObservation} */
  const created = { status: 'observed', at, source: 'git rev-parse', value: { ...value, state: 'created' } }
  if (agent?.session?.id !== sessionId || agents.get(sessionId) !== agent) return created
  const sessionWorktree = await linkedWorktree(rt.sessionFolder(agent.session, { observedOnly: true }))
  if (sessionWorktree.value?.gitDir !== gitDir || rt.chatOf(botId) !== sessionId || agents.get(sessionId) !== agent) return created
  const source = 'git rev-parse + DSH Agent registry'
  /** @type {import('./harness-contracts.js').WorktreeObservation} */
  const ready = { status: 'observed', at, source, value: { ...value, state: 'session-ready' } }
  if (agent.status !== 'running') return ready
  const events = agent.session.snapshotEvents?.() ?? []
  let start
  for (let i = agent.session.inheritedEventCount ?? 0; i < events.length; i += 1) {
    const event = events[i]
    if (event.type === 'turn/start') start = event
    else if (start !== undefined && event.type === 'turn/end' && event.data.turn === start.data.turn) start = undefined
  }
  return start === undefined ? ready : { status: 'observed', at, source: `${source} + Session turn/start`,
    value: { ...value, state: 'turn-started', turnSequence: start.seq } }
}
