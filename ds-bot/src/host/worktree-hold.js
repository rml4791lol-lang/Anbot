import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { linkedWorktree } from './bot-worktree.js'
import { within } from './folders.js'
import { pidAlive } from './home-lock.js'
import { checkCheckpointWorktree, checkpointTaskRef, checkpointWorktree, discardCheckpointRef, discardCheckpointWorktree, materializeCheckpoint, normalizeTaskRef, sameTaskRef, snapshotWorktree } from './bot-checkpoint.js'
import { createCheckpointSession } from './checkpoint-session.js'
import { readTaskLedger } from './task-ledger.js'

const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })
const STOP_TIMEOUT_MS = 15_000
const workflowActive = status => ['preparing', 'running', 'cancelling'].includes(status)

function verifiedTaskFor(rt, botId, sessionId, value, events, throughSequence) {
  const { state } = rt
  const task = normalizeTaskRef(value)
  for (const room of Object.values(state.rooms ?? {})) {
    for (const goal of [room.goal, ...(room.pastGoals ?? [])]) {
      if (goal === undefined) continue
      for (const stage of goal.stages ?? []) {
        for (const candidate of stage.tasks ?? []) {
          if (`goal:${goal.id}:${stage.id}:${candidate.id}` !== task.taskId) continue
          if (candidate.attempt?.id !== task.attemptId || candidate.botId !== botId) continue
          if (candidate.attempt.sessionId !== undefined && candidate.attempt.sessionId !== sessionId) continue
          return task
        }
      }
    }
  }
  const handoffId = task.taskId.startsWith('handoff:') ? task.taskId.slice('handoff:'.length) : undefined
  const handoff = handoffId === undefined ? undefined : state.works?.[handoffId]
  if (handoff?.to === botId && handoff.attempt?.id === task.attemptId
    && (handoff.attempt.sessionId === undefined || handoff.attempt.sessionId === sessionId)) return task
  if (handoffId !== undefined && handoff === undefined && typeof rt.home === 'string') {
    const startedAt = events.findLast(event => event.type === 'turn/start' && event.seq <= throughSequence)?.time
    if (Number.isFinite(startedAt)) {
      const { rows } = readTaskLedger(join(rt.home, 'ledger'), startedAt, Date.now() + 1, undefined, undefined, rt.config?.timeZone)
      const close = rows.findLast(row => row.kind === 'close' && row.id === handoffId)
      if (close?.to === botId && close.attemptId === task.attemptId && close.sessionId === sessionId) return task
      // Older ledgers corroborate the recipient. The immutable Session event supplies the attempt.
      if (close?.to === botId && close.attemptId === undefined && close.sessionId === undefined) return task
    }
  }
  throw refused('The checkpoint TaskRef does not match the current goal or hand-off attempt.')
}

export function createWorktreeHold(rt) {
  const { ctx, state } = rt
  const changing = new Set()
  const activating = new Set()
  const releasing = new Map()
  const previewHandles = new Map()
  const hostRun = randomUUID()
  const get = id => rt.botOf(id)?.worktreeHold ?? releasing.get(id) ?? null
  const holds = () => Object.keys(state.bots).map(get).filter(Boolean)
  const view = id => {
    const hold = get(id)
    if (hold === null) return null
    return { sessionId: hold.sessionId, root: hold.root, status: hold.status, at: hold.at, ...(hold.reason === undefined ? {} : { reason: hold.reason }) }
  }
  const owner = id => get(rt.selfOf(id))
  const pendingRestore = id => Object.values(state.bots).some(bot => bot.checkpointRestore?.sessionId === id)
  const assertUnheld = id => {
    if (activating.has(id) || pendingRestore(id) || owner(id) !== null) throw refused('This Bot is paused for workspace takeover. Give the workspace back to continue.')
  }
  const assertCanDelete = bot => {
    if (changing.has(bot.id)) throw refused('Wait for this Bot’s worktree operation to finish before deleting it.')
    if (bot.checkpoints?.length || bot.checkpointPreviews?.length) throw refused('Discard this Bot’s saved checkpoints in X-Ray before deleting it.')
  }
  async function attached(botId) {
    const sessionId = rt.chatOf(botId)
    const agent = ctx.get?.('agents')?.get?.(sessionId)
    if (!agent?.session || typeof agent.whenIdle !== 'function') throw refused('Open the Bot Session before taking control of its workspace.')
    const worktree = await linkedWorktree(rt.sessionFolder(agent.session, { observedOnly: true }))
    if (worktree.status !== 'observed') throw refused(worktree.reason)
    if (rt.chatOf(botId) !== sessionId || ctx.get('agents').get(sessionId) !== agent) throw refused('The Bot Session changed. Refresh before trying again.')
    return { sessionId, agent, ...worktree.value }
  }
  async function persist(bot, next) {
    const previous = bot.worktreeHold
    if (next === undefined) delete bot.worktreeHold
    else bot.worktreeHold = next
    try { await rt.save({ required: true }) } catch (error) {
      if (previous === undefined) delete bot.worktreeHold
      else bot.worktreeHold = previous
      throw error
    }
  }
  const same = (left, right) => left.sessionId === right.sessionId && left.root === right.root && left.gitDir === right.gitDir
  const findCheckpoint = (botId, ref) => rt.botOf(botId)?.checkpoints?.find(record => record.checkpointRef === ref)
  const memoryChangedSince = async (botId, record) => record.memoryCursors && rt.checkpointMemoryReview
    ? (await rt.checkpointMemoryReview(botId, record)).changed
    : (await rt.memoryCheckpointCursor?.(botId) ?? null) !== record.memoryJournalThrough
  async function storedSessionEvents(persistence, sessionId) {
    if (typeof persistence.open !== 'function') return undefined
    const handle = await persistence.open(sessionId, 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
  }
  const executor = (botId, agent) => {
    const routes = [agent?.model?.current?.()?.provider, rt.engineOfBot?.(rt.botOf(botId))].filter(route => rt.isLocalAgentRoute?.(route))
    return { local: routes.length !== 0, canTakeOver: routes.every(route => rt.localAgentCanConfirmStop?.(route) === true) }
  }

  async function waitForStop(agent, confirmation) {
    const timeout = new AbortController()
    try {
      const stopped = await Promise.race([
        Promise.all([agent.whenIdle(), confirmation]).then(([, proven]) => proven),
        delay(STOP_TIMEOUT_MS, false, { signal: timeout.signal }),
      ])
      if (stopped !== true) throw refused('The executor has not confirmed it stopped. The worktree is still waiting for takeover.')
    } finally { timeout.abort() }
  }

  async function change(botId, take) {
    const bot = rt.botOf(botId)
    if (bot === undefined || changing.has(botId) || rt.botDeleting?.(botId)) throw refused('The Bot workspace is unavailable or already changing hands.')
    changing.add(botId)
    try {
      let current = get(botId)
      const worktree = await attached(botId)
      // The previous host run's process can exit after startup reconciliation: a
      // takeover or return re-checks it before refusing on the old host run.
      const promoted = current !== null && current.status === 'stopping' && current.local === true
        && current.hostRun !== hostRun && Number.isSafeInteger(current.pid) && current.pid > 0 && !pidAlive(current.pid)
      if (promoted) {
        const held = { ...current, status: 'held', at: Date.now() }
        delete held.pid
        delete held.reason
        await persist(bot, held)
        current = held
      }
      if (!take) {
        if (current === null || !same(current, worktree)) throw refused('This Session is no longer attached to the held worktree.')
        if (current.status !== 'held') throw refused('The executor has not confirmed it stopped. Finish taking control before giving the worktree back.')
        const { agent, sessionId } = worktree
        if (agent.status !== 'idle') throw refused('Wait for the Bot Session to become idle before giving the worktree back.')
        if (agent.inbox?.hasPending) throw refused('Resolve the Session’s waiting messages before giving the worktree back.')
        if (rt.hasSubagents(sessionId) || workflowActive(rt.botWorkflowView?.(botId)?.status)) {
          throw refused('Stop the Bot’s delegated work or Workflow before giving the worktree back.')
        }
        if (rt.localAgentHasUnsettledPrompt?.(sessionId)) throw refused('Wait for the local Agent to finish before giving the worktree back.')
        // Keep dispatch fenced while save serializes the roster without the hold.
        releasing.set(botId, current)
        try { await persist(bot, undefined) } finally { releasing.delete(botId) }
        return null
      }
      // The recorded process is gone: the takeover the previous host was waiting
      // on is complete, so this call returns the hold it left.
      if (promoted) {
        if (!same(current, worktree)) throw refused('This Session is no longer attached to the held worktree.')
        return current
      }
      const route = executor(botId, worktree.agent)
      if (!route.canTakeOver) throw refused('Workspace takeover is not ready for this local Agent.')
      if (current !== null && (current.status !== 'stopping' || !same(current, worktree))) throw refused('This Bot workspace already has a hold.')
      if (current?.local && current.hostRun !== hostRun) throw refused(current.reason ?? 'The previous host did not confirm that the local Agent stopped. Keep this worktree reserved until its executor is reconciled.')
      if (rt.hasSubagents(worktree.sessionId) || workflowActive(rt.botWorkflowView?.(botId)?.status)) {
        throw refused('Stop the Bot’s delegated work or Workflow before taking control.')
      }
      const { sessionId, root, gitDir, agent } = worktree
      const registry = ctx.get('agents')
      for (const other of registry.list()) {
        if (other === agent || (other.status === 'idle' && !rt.localAgentHasUnsettledPrompt?.(other.session?.id))) continue
        const folder = rt.sessionFolder(other.session, { observedOnly: true })
        if (typeof folder === 'string' && within(await rt.real(folder), root)) throw refused('Another Agent is active in this worktree.')
      }
      if (holds().some(other => other !== current && other.gitDir === gitDir)) throw refused('Another Bot already has a hold on this worktree.')
      const localPid = route.local ? rt.localAgentProcessId?.(sessionId) : undefined
      const hold = current ?? { sessionId, root, gitDir, status: 'stopping', at: Date.now(), ...(route.local ? { local: true, hostRun, ...(Number.isSafeInteger(localPid) && localPid > 0 ? { pid: localPid } : {}) } : {}) }
      if (current === null) await persist(bot, hold)
      if (agent.status !== 'idle') agent.cancel({ kind: 'user' }, { keepInbox: true })
      const stop = route.local ? rt.stopLocalAgentForTakeover?.(sessionId) : true
      await waitForStop(agent, stop)
      if (!same(hold, await attached(botId))) throw refused('The worktree changed before the Bot stopped.')
      const held = { ...hold, status: 'held' }
      delete held.pid
      await persist(bot, held)
      return held
    } finally { changing.delete(botId) }
  }

  async function heldFor(session) {
    if (activating.has(session.id) || pendingRestore(session.id) || owner(session.id) !== null) return true
    const current = holds()
    if (current.length === 0) return false
    const folder = rt.sessionFolder(session, { observedOnly: true })
    if (typeof folder !== 'string') return false
    const real = await rt.real(folder)
    return current.some(hold => within(real, hold.root))
  }

  /** @returns {Promise<import('./harness-contracts.js').PairedCheckpoint>} */
  async function checkpoint(botId) {
    const bot = rt.botOf(botId)
    if (!bot || changing.has(botId) || rt.botDeleting?.(botId)) throw refused('The Bot workspace is unavailable or already changing hands.')
    changing.add(botId)
    try {
      const hold = get(botId)
      const current = await attached(botId)
      if (hold?.status !== 'held' || !same(hold, current) || current.agent.status !== 'idle') throw refused('Take over the worktree and wait for the Bot to stop before saving a checkpoint.')
      const { session } = current.agent
      await ctx.sessions.flush(session)
      const events = session.snapshotEvents()
      const throughSequence = events.at(-1)?.seq ?? null
      const taskSource = checkpointTaskRef(events, throughSequence)
      const task = taskSource === undefined ? undefined : verifiedTaskFor(rt, botId, session.id, taskSource, events, throughSequence)
      const memoryJournalThrough = await rt.memoryCheckpointCursor?.(botId) ?? null
      const memoryCursors = await rt.memoryCheckpointCursors?.(botId)
      const { discard, ...git } = await snapshotWorktree(current.root, task)
      const previous = bot.checkpoints
      try {
        const verified = await attached(botId)
        const currentEvents = session.snapshotEvents()
        if (!same(hold, verified) || get(botId) !== hold || verified.agent !== current.agent || verified.agent.status !== 'idle'
          || verified.revision !== git.head || current.revision !== git.head || currentEvents.at(-1)?.seq !== throughSequence) {
          throw refused('The Session or worktree changed while taking the checkpoint. Try again.')
        }
        const currentTaskSource = checkpointTaskRef(currentEvents, throughSequence)
        const currentTask = currentTaskSource === undefined ? undefined : verifiedTaskFor(rt, botId, session.id, currentTaskSource, currentEvents, throughSequence)
        if (!sameTaskRef(currentTask, task)) {
          throw refused('The Session or worktree changed while taking the checkpoint. Try again.')
        }
        const record = { ...git, ...(task ? { task } : {}), sessionId: session.id, throughSequence, memoryJournalThrough, ...(memoryCursors ? { memoryCursors } : {}), worktree: current.root, at: Date.now() }
        bot.checkpoints = [...(previous ?? []), record]
        await rt.save({ required: true })
        return record
      } catch (error) {
        if (previous === undefined) delete bot.checkpoints
        else bot.checkpoints = previous
        await discard().catch(cleanup => rt.warn('ds-bot: could not remove a failed checkpoint ref: %s', cleanup.message))
        throw error
      }
    } finally { changing.delete(botId) }
  }

  async function saveRestore(bot, restore) {
    const previous = bot.checkpointRestore
    if (restore === undefined) delete bot.checkpointRestore
    else bot.checkpointRestore = restore
    try { await rt.save({ required: true }) } catch (error) {
      if (previous === undefined) delete bot.checkpointRestore
      else bot.checkpointRestore = previous
      throw error
    }
  }

  // A durable reservation identifies both native resources before either exists.
  // Only remove a matching clean checkout. Keep the reservation on any uncertain failure.
  async function rollbackRestore(bot, handle) {
    const pending = bot.checkpointRestore
    if (pending === undefined) return
    const record = bot.checkpoints?.find(item => item.checkpointRef === pending.checkpointRef)
    if (!record || !/^session-[0-9a-f-]{36}$/u.test(pending.sessionId) || !Number.isSafeInteger(pending.createdAfter) || rt.selfOf(pending.sessionId) !== undefined
      || bot.checkpointPreviews?.some(item => item.sessionId === pending.sessionId)) {
      throw refused('The interrupted restore is no longer an unpublished checkpoint Session.')
    }
    const worktree = checkpointWorktree(record.worktree, pending.sessionId)
    const persistence = ctx.get('sessionPersistence')
    if (!persistence || !ctx.workspaceRegistry) throw refused('DSH cannot check the interrupted restore in this profile.')
    const session = ctx.sessions.get(pending.sessionId)
    const stored = await persistence.stat(pending.sessionId)
    if (session === undefined && stored === undefined) {
      if (ctx.sessions.get(pending.sessionId) || ctx.get('agents')?.get(pending.sessionId)) {
        throw refused('The interrupted restore is still attached to a live Session.')
      }
      await discardCheckpointWorktree(record.worktree, worktree, record.commit, { sessionId: pending.sessionId })
      await saveRestore(bot, undefined)
      return
    }
    const header = session?.header ?? stored?.header
    if (!header) throw refused('DSH has no persistent identity for the interrupted restore.')
    if (header.id !== pending.sessionId || header.cwd !== worktree || header.isSeeded !== true || header.createdAt < pending.createdAfter) {
      throw refused('The Session identity does not match the interrupted restore.')
    }
    if (record.task !== undefined) {
      const events = await storedSessionEvents(persistence, pending.sessionId)
      if (!Array.isArray(events) || !sameTaskRef(checkpointTaskRef(events, record.throughSequence), normalizeTaskRef(record.task))) {
        throw refused('The restored Session does not contain the checkpoint TaskRef.')
      }
    }
    if (session && handle?.agent.session !== session) throw refused('The interrupted restore is still attached to a live Session.')
    await ctx.workspaceRegistry.archiveSession(pending.sessionId)
    await handle?.dispose()
    if (ctx.sessions.get(pending.sessionId) || ctx.get('agents')?.get(pending.sessionId)) throw refused('DSH has not released the interrupted restore.')
    await discardCheckpointWorktree(record.worktree, worktree, record.commit, { sessionId: pending.sessionId })
    await saveRestore(bot, undefined)
  }

  // A hold persisted in `stopping` by another host run carries no stop
  // confirmation. A recorded process that is gone proves the stop; a live one,
  // or one this host cannot identify, keeps the reservation and says why.
  async function reconcileStoppingHolds() {
    for (const bot of Object.values(state.bots)) {
      const hold = bot.worktreeHold
      if (hold === undefined || hold.status !== 'stopping' || hold.hostRun === hostRun || changing.has(bot.id)) continue
      let stopped = true
      if (hold.local === true) stopped = Number.isSafeInteger(hold.pid) && hold.pid > 0 && !pidAlive(hold.pid)
      if (stopped) {
        const held = { ...hold, status: 'held', at: Date.now() }
        delete held.pid
        delete held.reason
        await persist(bot, held)
      } else {
        const reason = Number.isSafeInteger(hold.pid) && hold.pid > 0
          ? 'The previous host’s local Agent process is still running; keep this worktree reserved until it exits.'
          : 'The previous host did not record the local Agent process; keep this worktree reserved until its executor is confirmed stopped.'
        if (hold.reason !== reason) await persist(bot, { ...hold, reason })
      }
    }
  }

  async function recoverPendingRestores() {
    await rt.load()
    if (rt.readOnly?.() !== undefined) return
    await reconcileStoppingHolds()
    for (const bot of Object.values(state.bots)) {
      if (bot.checkpointRestore === undefined || changing.has(bot.id)) continue
      changing.add(bot.id)
      try { await rollbackRestore(bot) } catch (error) {
        rt.warn('anbot: interrupted checkpoint restore for %s could not be cleaned up: %s', bot.id, error.message)
      } finally { changing.delete(bot.id) }
    }
  }

  async function restorePreview(botId, ref, { writable = false, keepCurrentMemory = false } = {}) {
    const bot = rt.botOf(botId)
    if (!bot || changing.has(botId) || rt.botDeleting?.(botId)) throw refused('The Bot workspace is unavailable or already changing hands.')
    const record = bot.checkpoints?.find(checkpoint => checkpoint.checkpointRef === ref)
    if (!record || !Number.isSafeInteger(record.throughSequence)) throw refused('This checkpoint has no recoverable conversation boundary.')
    changing.add(botId)
    let handle
    let reserved = false
    try {
      await rollbackRestore(bot)
      const hold = get(botId)
      const current = await attached(botId)
      if (hold?.status !== 'held' || !same(hold, current) || current.root !== record.worktree) throw refused('Take over the original worktree before restoring its checkpoint.')
      const memoryChanged = await memoryChangedSince(botId, record)
      if (writable && memoryChanged && !keepCurrentMemory) throw refused('Memory has changed since this checkpoint. Confirm that the current memory should be kept before restoring.')
      const sessionId = `session-${randomUUID()}`
      const worktree = checkpointWorktree(current.root, sessionId)
      const persistence = ctx.get('sessionPersistence')
      if (!persistence || !ctx.workspaceRegistry) throw refused('This DSH profile cannot persist checkpoint Sessions.')
      if (ctx.sessions.get(sessionId) || await persistence.stat(sessionId)) throw refused('The restore Session ID is already in use. Try again.')
      await saveRestore(bot, { sessionId, checkpointRef: record.checkpointRef, createdAfter: Date.now() })
      reserved = true
      await materializeCheckpoint(current.root, record, worktree)
      handle = await createCheckpointSession(ctx, record, worktree, sessionId, writable)
      const preview = { sessionId, checkpointRef: record.checkpointRef, ...(record.task ? { task: normalizeTaskRef(record.task) } : {}), worktree, memoryChanged, ...(writable ? { writable: true } : {}), at: Date.now() }
      const previous = bot.checkpointPreviews
      bot.checkpointPreviews = [...(previous ?? []), preview]
      try { await saveRestore(bot, undefined) } catch (error) {
        if (previous === undefined) delete bot.checkpointPreviews
        else bot.checkpointPreviews = previous
        throw error
      }
      previewHandles.set(sessionId, handle)
      return preview
    } catch (error) {
      if (reserved) await rollbackRestore(bot, handle).catch(cleanup => rt.warn('anbot: checkpoint restore cleanup failed: %s', cleanup.message))
      throw error
    } finally { changing.delete(botId) }
  }

  async function activateRestore(botId, sessionId, { keepCurrentMemory = false } = {}) {
    const bot = rt.botOf(botId)
    const branch = bot?.checkpointPreviews?.find(item => item.sessionId === sessionId && item.writable === true)
    if (!branch || changing.has(botId) || rt.botDeleting?.(botId) || rt.selfOf(sessionId) !== undefined) throw refused('That restored Session is unavailable.')
    const record = bot.checkpoints?.find(item => item.checkpointRef === branch.checkpointRef)
    const hold = get(botId)
    if (!record || hold?.status !== 'held') throw refused('Take over the original worktree before switching to the restore.')
    if ((record.task !== undefined || branch.task !== undefined) && !sameTaskRef(record.task, branch.task)) {
      throw refused('The restored Session TaskRef does not match its checkpoint.')
    }
    changing.add(botId)
    activating.add(sessionId)
    try {
      const source = await attached(botId)
      if (!same(hold, source) || source.root !== record.worktree) throw refused('The Bot is no longer holding the worktree that this checkpoint came from.')
      if (source.agent.inbox?.hasPending || state.switching?.[source.sessionId] || state.questions?.[source.sessionId] || state.views?.[source.sessionId]) {
        throw refused('Resolve the original Session’s waiting messages or cards before switching.')
      }
      if (await memoryChangedSince(botId, record) && !keepCurrentMemory) {
        throw refused('Memory has changed since this checkpoint. Confirm that the current memory should be kept before switching.')
      }
      const target = await rt.resolveAgent(sessionId)
      const git = await linkedWorktree(branch.worktree)
      const policy = ctx.get('sandboxPolicy')?.resolve({ session: target.session })
      if (git.status !== 'observed' || target.status !== 'idle' || target.inbox?.hasPending || rt.hasSubagents(sessionId)
        || await rt.real(rt.sessionFolder(target.session, { observedOnly: true }) ?? '') !== git.value.root
        || policy?.workspaceRoot !== git.value.root || policy.mode !== 'workspace-write' || policy.additionalWritableRoots?.length) {
        throw refused('The restored Session must be idle in its original isolated worktree with workspace-write permission.')
      }
      const selection = source.agent.model?.current?.()
      if (rt.isLocalAgentSession?.(source.sessionId) || rt.isLocalAgentRoute?.(selection?.provider)) throw refused('This Bot is using a local Agent.')
      if (selection?.provider && selection?.model) await rt.selectSessionModel(sessionId, selection)
      await ctx.sessions.flush(target.session)
      if (rt.chatOf(botId) !== source.sessionId || target.status !== 'idle' || target.inbox?.hasPending) throw refused('A Session changed while switching. Try again when both Sessions are idle.')
      const previous = { sessionId: bot.sessionId, segments: bot.segments, directWorkDir: bot.directWorkDir, worktreeHold: bot.worktreeHold }
      bot.segments = [...(bot.segments ?? []), { sessionId: source.sessionId, endedAt: Date.now(), directWorkDir: bot.directWorkDir }]
      bot.sessionId = sessionId
      bot.directWorkDir = git.value.root
      bot.worktreeHold = { sessionId, root: git.value.root, gitDir: git.value.gitDir, status: 'held', at: Date.now() }
      try { await rt.save({ required: true }) } catch (error) {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete bot[key]
          else bot[key] = value
        }
        rt.indexSessionsAfterRollback?.()
        throw error
      }
      return { sessionId, worktree: git.value.root }
    } finally {
      changing.delete(botId)
      activating.delete(sessionId)
    }
  }

  async function checkPreviewForDiscard(botId, record, preview) {
    const { sessionId, worktree } = preview
    if (!/^session-[0-9a-f-]{36}$/u.test(sessionId) || worktree !== checkpointWorktree(record.worktree, sessionId)) {
      throw refused('This preview does not match its reserved restore path.')
    }
    const owner = rt.selfOf(sessionId)
    if (owner === botId) return false // An adopted restore now belongs to regular Session history.
    if (owner !== undefined) throw refused('Another Bot is using this restored Session.')
    const handle = previewHandles.get(sessionId)
    const session = ctx.sessions.get(sessionId)
    if (session && session !== handle?.agent.session) throw refused('Close the restored Session before discarding its checkpoint.')
    if (handle && (handle.agent.status !== 'idle' || handle.agent.inbox?.hasPending)) throw refused('Wait for the restored Session to finish before discarding it.')
    const persistence = ctx.get('sessionPersistence')
    if (!persistence || !ctx.workspaceRegistry) throw refused('DSH cannot verify and archive this restored Session.')
    const stored = await persistence.stat(sessionId)
    const header = session?.header ?? stored?.header
    if (!header || header.id !== sessionId || header.cwd !== worktree || header.isSeeded !== true) {
      throw refused('The stored Session identity does not match this checkpoint preview.')
    }
    await checkCheckpointWorktree(record.worktree, worktree, record.commit, sessionId)
    return true
  }

  async function discardCheckpoint(botId, ref) {
    const bot = rt.botOf(botId)
    const record = findCheckpoint(botId, ref)
    if (!record || changing.has(botId) || rt.botDeleting?.(botId)) throw refused('This checkpoint is unavailable or already changing.')
    if (bot.checkpointRestore !== undefined) throw refused('Resolve the interrupted checkpoint restore before discarding a checkpoint.')
    const checkpoints = bot.checkpoints
    const previews = bot.checkpointPreviews
    const linked = (previews ?? []).filter(preview => preview.checkpointRef === ref)
    changing.add(botId)
    try {
      const removable = []
      for (const preview of linked) {
        if (await checkPreviewForDiscard(botId, record, preview)) {
          activating.add(preview.sessionId)
          removable.push(preview)
        }
      }
      for (const { sessionId, worktree } of removable) {
        await ctx.workspaceRegistry.archiveSession(sessionId)
        await previewHandles.get(sessionId)?.dispose()
        previewHandles.delete(sessionId)
        if (ctx.sessions.get(sessionId) || ctx.get('agents')?.get(sessionId)) throw refused('DSH has not released the restored Session. Close it and retry.')
        await discardCheckpointWorktree(record.worktree, worktree, record.commit, { sessionId })
      }
      await discardCheckpointRef(record)
      bot.checkpoints = checkpoints.filter(item => item !== record)
      if (previews) bot.checkpointPreviews = previews.filter(item => item.checkpointRef !== ref)
      try { await rt.save({ required: true }) } catch (error) {
        bot.checkpoints = checkpoints
        if (previews) bot.checkpointPreviews = previews
        throw error
      }
      return true
    } finally {
      for (const { sessionId } of linked) activating.delete(sessionId)
      changing.delete(botId)
    }
  }

  async function checkpointMemory(botId, ref, changeId) {
    const record = findCheckpoint(botId, ref)
    if (!record) throw refused('Unknown checkpoint.')
    if (!rt.checkpointMemoryReview) return { status: 'unavailable', changed: false, changes: [] }
    if (changeId !== undefined) await rt.checkpointMemoryUndo(botId, record, changeId)
    return rt.checkpointMemoryReview(botId, record)
  }

  const executorOf = botId => executor(botId, ctx.get?.('agents')?.get?.(rt.chatOf(botId)))
  return { view, executorOf, assertUnheld, assertCanDelete, heldFor, change, checkpoint, restorePreview, activateRestore, discardCheckpoint, checkpointMemory, recoverPendingRestores }
}
