// Delivery: how one Bot, the user, or DS Bot itself puts a message into a Bot Session.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HISTORY_TIMEOUT_MS, LONG_HEAD, MESSAGE_INLINE_MAX, READ_LINE_MAX, SOURCE_KIND, TEXT_KEPT, TEXT_SHOW_MAX } from './constants.js'
import { headOf, stripControlMarkers, textOf } from './text.js'
import { WAITING_MAX_MS, WAITING_QUIET_MS, mergeBacklog, plainRelay } from './backlog.js'
import { readTeamBoardLines, writeTeamBoard } from './team-board-feed.js'
import { stripWireTags } from '../shared/wire-tags.js'
import { isNoWorkStatusText } from '../shared/idle-text.js'
import { sameConversation, threadCurrentOfPart } from './threads.js'

// A routine receipt a Bot sends a Main Bot: the marker is what the sender means, because
// at this layer a receipt and a request have the same shape.
const RECEIPT_MARKER = /^\s*\[\[receipt\]\]\s*/i
const RECEIPT_PREFIX = '回执 · '

export function install(rt) {
  const { ctx, state } = rt

  const resolveAgent = async (sessionId) => {
    const binding = rt.botOf(rt.selfOf(sessionId))?.presetBinding
    if (binding !== undefined) await rt.ensureBotPreset(binding)
    if (ctx.fiber?.uid === null || ctx.sessionController === undefined) {
      throw Object.assign(new Error('Plugin context is inactive'), { code: 'plugin/disposed' })
    }
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw Object.assign(new Error(resolved.error?.message ?? 'Session unavailable'), { code: resolved.error?.code })
    rt.hideBotUnusedTools(resolved.agent)
    return resolved.agent
  }

  // R59: what a Bot was told while it was in the middle of a turn. Plain notes wait here
  // and are read together when that turn ends, so a burst of notes costs one turn, not one
  // turn each. Anything with a reply target, an image or a room goes out as it came.
  const waiting = new Map()

  const flushTimers = new Map()
  // Cleared with the batch: a quiet window and a deadline both end in one flush.
  const unarm = (sessionId) => {
    const timer = flushTimers.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer.quiet)
    clearTimeout(timer.deadline)
    flushTimers.delete(sessionId)
  }
  const later = (sessionId, at) => {
    const handle = setTimeout(() => void flushWaiting(sessionId), at)
    handle?.unref?.()
    return handle
  }
  // `quiet` (after a turn ends) restarts on every note; `deadline` starts with the
  // first note and is not moved, so a slow trickle is read within WAITING_MAX_MS.
  const arm = (sessionId, { quiet = false, deadline = false } = {}) => {
    let timer = flushTimers.get(sessionId)
    if (timer === undefined) {
      timer = { quiet: undefined, deadline: undefined }
      flushTimers.set(sessionId, timer)
    }
    if (deadline && timer.deadline === undefined) timer.deadline = later(sessionId, WAITING_MAX_MS)
    if (quiet) {
      clearTimeout(timer.quiet)
      timer.quiet = later(sessionId, WAITING_QUIET_MS)
    }
  }

  const headerFor = (role, fromName, roomName, audience, note, deferred = false, { resumed = false, retried = false, resent = false, abandoned = false, abandonedReason, asker, workRef, silent = false } = {}) => {
    const label = note ?? 'new message'
    const reportLabel = note ?? 'replies to your post'
    const tag = workRef ? ` #${workRef}` : ''
    // What came back for work another Bot gave this one says where its answer goes.
    const goesOn = asker === undefined ? '' : ` · for the work ${asker} asked you for; your answer goes to ${asker} once everything you handed on is back`
    // Silent one-way notices keep their exact header regardless of deferred/resent flags.
    if (role === 'cancelled') return `[Work${tag} cancelled by ${fromName} · no reply needed]`
    if (role === 'note') return `[Note from ${fromName} · FYI only, no reply needed]`
    if (role === 'stopped') return `[Stopped by ${fromName} · no reply needed]`
    // A wait the user gave up reads as its own thing: the other Bot never answered.
    if (abandoned && abandonedReason === 'restart') return `[Work${tag} · ${fromName} did not complete before restart${goesOn}]`
    if (abandoned) return `[Waiting given up · ${fromName} did not hand back this work; go on with the work it was for${goesOn}]`
    // A quiet hand-back is read with whatever opens the next turn, so it must not ask for
    // a reply of its own. A wait given up still says so, above.
    if (silent && role === 'reply') return `[Reply from ${fromName}${workRef ? ` · #${workRef}` : ''} · FYI only, no reply needed]`
    if (deferred && role === 'reply') return `[Work${tag} completed by ${fromName} · closed · you read it during your last task; go on with the work it is for now${goesOn}]`
    if (deferred && role === 'ask_back') return `[Work${tag} · ${fromName} asked during your last task${goesOn} · call answer_work to unblock or cancel_work to stop]`
    if (deferred && role === 'answer') return `[Work${tag} · ${fromName} answered during your last task · continue and reply when done]`
    if (deferred && role === 'report') return `[Group chat "${roomName}" · ${reportLabel} · you read them during your last task; go on with the work they are for now${goesOn}]`
    if (deferred && role === 'task-report') return `[Background task report · you read it during your last task; go on with the work it is for now${goesOn}]`
    if (deferred && role !== 'room') return `[Work${tag} from ${fromName} · you read it during your last task; complete it now]`
    if (retried && role !== 'room') return '[Your last reply wrote a tool call as text, so nothing ran]'
    if (resumed && role === 'resume') return '[DeepSeek Harness restarted while you were working]'
    if (resumed && role !== 'room') return `[Work${tag} from ${fromName} · DeepSeek Harness restarted while you were working on it]`
    if (resent && role === 'reply') return `[Work${tag} completed by ${fromName} · DeepSeek Harness restarted before it could reach you]`
    if (resent && role === 'ask_back') return `[Work${tag} · ${fromName} asks before continuing · DeepSeek Harness restarted before it could reach you · call answer_work or cancel_work]`
    if (resent && role === 'answer') return `[Work${tag} · ${fromName} answered your question · DeepSeek Harness restarted before it could reach you · continue and reply when done]`
    if (resent && role !== 'room') return `[Work${tag} from ${fromName} · DeepSeek Harness restarted before it could reach you]`
    if (role === 'reply') return `[Work${tag} completed by ${fromName} · closed${goesOn}; reply [PASS] if nothing needs to be told to the user]`
    if (role === 'ask_back') return `[Work${tag} · ${fromName} asks before continuing${goesOn} · call answer_work to unblock or cancel_work to stop]`
    if (role === 'answer') return `[Work${tag} · ${fromName} answered your question · continue and reply when done]`
    if (role === 'room') return `[Group chat "${roomName}" · ${label}]`
    if (role === 'report') return `[Group chat "${roomName}" · ${reportLabel}${goesOn}]`
    if (role === 'kickoff') return '[Bot team setup]'
    if (role === 'continue') return '[Retry after a failed turn]'
    // The editor can be the user or a Bot (its own tool call, or a Main Bot's):
    // the header stays neutral about who changed the profile.
    // The prompt is rebuilt from the Bot record on its next turn, so this note only
    // tells a running Bot that the rules changed: it must not cost a turn of its own.
    if (role === 'update') return '[Your profile was updated — follow the latest version. Do not reply to this note.]'
    if (role === 'secret') return '[Secret card]'
    if (role === 'task') return `[Background task · ${label}]`
    if (role === 'task-followup') return `[Follow-up from your own chat · ${label}]`
    if (role === 'task-report') return `[Background task report · ${label}${goesOn}]`
    if (audience === 'user') return `[Work from ${fromName} · the user sees your reply here]`
    return `[Work${tag} from ${fromName} · reply closes work; call ask_back if blocked]`
  }

  // Silent (zero-wake) messages buffered while a target Session is busy.
  // In real DSH (`dsh-agent-loop`), `agent.inject()` puts messages into `inbox.nextStep`,
  // which while `agent.status === 'running'` forces an extra step or starts a spurious
  // turn when checked at `turnEnds`. Buffering until idle (and prepending before step 1
  // via `agent/pre-step` if another turn starts first) guarantees true zero-wake AND
  // deterministic causal ordering ahead of queued delegations. Persisted in `inflight.json`
  // with no silent drop cap so notices survive restarts and bursts intact.
  /** @type {Map<string, {message:any, ledger?:{book:string, id:string, sessionId:string, failureRequestId?:string, work?:string}}[]>} */
  const pendingSilent = new Map()
  const flushingSilent = new Set()
  const isBusyAgent = (agent, sessionId) => agent?.status === 'running' || rt.live?.get(sessionId)?.turn !== undefined
  const syncSilent = (sessionId) => { rt.noteSilent?.(sessionId, pendingSilent.get(sessionId)) }
  const waitIdleBriefly = (agent, timeoutMs = 2000) => {
    if (typeof agent?.whenIdle !== 'function') return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve() } }
      const timer = setTimeout(done, timeoutMs)
      timer?.unref?.()
      Promise.resolve(agent.whenIdle()).then(done, done)
    })
  }
  const markSilentDelivered = (entries, overrideSessionId) => {
    const writes = []
    for (const entry of entries ?? []) {
      const ledger = entry?.ledger
      if (ledger?.book === undefined) continue
      rt.ledger.append(ledger.book, {
        event: 'delivered',
        id: ledger.id,
        sessionId: overrideSessionId ?? ledger.sessionId,
        time: Date.now(),
        ...(typeof ledger.failureRequestId === 'string' && ledger.failureRequestId !== '' ? { failureRequestId: ledger.failureRequestId } : {}),
        ...(typeof ledger.work === 'string' && ledger.work !== '' ? { work: ledger.work } : {}),
      })
      writes.push(rt.ledger.written(ledger.book).catch(() => {}))
    }
    return writes.length > 0 ? Promise.all(writes) : Promise.resolve()
  }
  const bufferSilent = (sessionId, message, agent, ledger) => {
    const list = pendingSilent.get(sessionId) ?? []
    const exchangeId = message?.source?.exchangeId
    if (exchangeId !== undefined && list.some(item => item?.message?.source?.exchangeId === exchangeId)) return
    list.push({ message, ...(ledger !== undefined ? { ledger } : {}) })
    pendingSilent.set(sessionId, list)
    syncSilent(sessionId)
    if (typeof agent?.whenIdle === 'function') {
      void Promise.resolve(agent.whenIdle()).then(() => flushSilentNotes(sessionId)).catch(() => {})
    }
  }
  const putBackSilentNotes = (sessionId, entries) => {
    if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(entries) || entries.length === 0) return
    const existing = pendingSilent.get(sessionId) ?? []
    const existingIds = new Set(existing.map(item => item?.message?.source?.exchangeId).filter(Boolean))
    const restored = entries.filter(item => {
      if (item?.message === undefined) return false
      const exId = item.message?.source?.exchangeId
      return exId === undefined || !existingIds.has(exId)
    })
    if (restored.length === 0) return
    pendingSilent.set(sessionId, [...restored, ...existing])
    syncSilent(sessionId)
  }
  const pendingMessageIds = (agent) => new Set([
    ...(agent?.inbox?.nextStep ?? []),
    ...(agent?.inbox?.nextTurn ?? []),
  ].map(item => item?.id).filter(Boolean))
  const injectIfNotPending = (agent, message, pendingIds) => {
    if (message?.id !== undefined && pendingIds.has(message.id)) return false
    agent.inject(message)
    if (message?.id !== undefined) pendingIds.add(message.id)
    return true
  }
  async function flushSilentNotes(sessionId, { rethrow = false } = {}) {
    if (!pendingSilent.has(sessionId) || flushingSilent.has(sessionId)) return
    if (rt.live?.get(sessionId)?.turn !== undefined) return
    flushingSilent.add(sessionId)
    let queued
    try {
      const agent = await resolveAgent(sessionId).catch(() => undefined)
      if (agent === undefined) {
        if (rt.selfOf?.(sessionId) === undefined) {
          pendingSilent.delete(sessionId)
          syncSilent(sessionId)
        }
        return
      }
      if (isBusyAgent(agent, sessionId)) {
        if (typeof agent.whenIdle === 'function') {
          void Promise.resolve(agent.whenIdle()).then(() => flushSilentNotes(sessionId)).catch(() => {})
        }
        return
      }
      queued = pendingSilent.get(sessionId)
      if (queued === undefined || queued.length === 0) return
      pendingSilent.delete(sessionId)
      const pendingIds = pendingMessageIds(agent)
      for (const entry of queued) injectIfNotPending(agent, entry.message, pendingIds)
      await ctx.sessions.flush(agent.session)
      syncSilent(sessionId)
      void markSilentDelivered(queued, sessionId)
      queued = undefined
    } catch (error) {
      if (queued !== undefined && queued.length > 0) putBackSilentNotes(sessionId, queued)
      if (rethrow) throw error
      rt.warn('ds-bot: flushing silent notes for %s failed: %s', sessionId, error)
    } finally {
      flushingSilent.delete(sessionId)
    }
  }
  const takeSilentEntries = (sessionId) => {
    const queued = pendingSilent.get(sessionId)
    if (queued === undefined) return []
    pendingSilent.delete(sessionId)
    syncSilent(sessionId)
    return queued
  }
  const takeSilentNotes = (sessionId) => takeSilentEntries(sessionId).map(entry => entry.message)
  const moveSilentNotes = (fromSessionId, toSessionId, { awaitFlush = false, rethrow = false } = {}) => {
    if (fromSessionId === undefined || toSessionId === undefined || fromSessionId === toSessionId) return Promise.resolve()
    const entries = takeSilentEntries(fromSessionId)
    if (entries.length > 0) {
      const targetList = pendingSilent.get(toSessionId) ?? []
      const seenIds = new Set(targetList.map(item => item?.message?.source?.exchangeId).filter(Boolean))
      const seenMsgIds = new Set(targetList.map(item => item?.message?.id).filter(Boolean))
      for (const entry of entries) {
        const exId = entry?.message?.source?.exchangeId
        const msgId = entry?.message?.id
        if ((exId !== undefined && seenIds.has(exId)) || (msgId !== undefined && seenMsgIds.has(msgId))) continue
        if (exId !== undefined) seenIds.add(exId)
        if (msgId !== undefined) seenMsgIds.add(msgId)
        targetList.push({
          message: entry.message,
          ...(entry.ledger !== undefined ? { ledger: { ...entry.ledger, sessionId: toSessionId } } : {}),
        })
      }
      pendingSilent.set(toSessionId, targetList)
      syncSilent(toSessionId)
    }
    if (!pendingSilent.has(toSessionId)) return Promise.resolve()
    if (awaitFlush) return flushSilentNotes(toSessionId, { rethrow })
    queueMicrotask(() => void flushSilentNotes(toSessionId))
    return Promise.resolve()
  }
  async function restoreSilentNotes(savedMap) {
    if (savedMap === null || typeof savedMap !== 'object') return
    const touched = new Set()
    for (const [oldSid, list] of Object.entries(savedMap)) {
      if (!Array.isArray(list) || list.length === 0) continue
      const botId = rt.selfOf?.(oldSid)
      const bot = botId === undefined ? undefined : rt.botOf(botId)
      if (bot === undefined) continue
      const groupOwner = rt.groupOwners?.get(oldSid)
      const destSid = groupOwner !== undefined
        ? (rt.roomOf(groupOwner.roomId)?.sessions?.[botId] ?? oldSid)
        : (threadCurrentOfPart(bot, oldSid) ?? (rt.isBotSession?.(oldSid) ? oldSid : rt.chatOf(botId)))
      if (destSid === undefined) continue
      const destList = pendingSilent.get(destSid) ?? []
      const seenIds = new Set(destList.map(item => item?.message?.source?.exchangeId).filter(Boolean))
      for (const raw of list) {
        const message = raw?.message
        if (message === undefined) continue
        const exId = message?.source?.exchangeId
        if (exId !== undefined && seenIds.has(exId)) continue
        if (exId !== undefined) seenIds.add(exId)
        destList.push({
          message,
          ...(raw.ledger !== undefined ? { ledger: { ...raw.ledger, sessionId: destSid } } : {}),
        })
      }
      if (destList.length > 0) {
        pendingSilent.set(destSid, destList)
        syncSilent(destSid)
        touched.add(destSid)
      }
    }
    for (const sid of touched) await flushSilentNotes(sid)
  }
  const injectSilent = (sessionId, message, agent, ledger) => {
    if (isBusyAgent(agent, sessionId)) {
      bufferSilent(sessionId, message, agent, ledger)
      return false
    }
    injectIfNotPending(agent, message, pendingMessageIds(agent))
    return true
  }

  const NON_WAKING_PRE_STEP_KINDS = new Set([
    'working-directory', 'runtime-context', 'time-context', 'ds-bot-time-context',
    'bot-memory', 'skill-catalog', 'compact-checkpoint', 'snapshot',
  ])
  const isWakingPreStepMessage = (msg) => {
    const src = msg?.source
    if (src === undefined) return true
    if (src.form === 'snapshot' || NON_WAKING_PRE_STEP_KINDS.has(src.kind)) return false
    if (src.kind === SOURCE_KIND && (src.silent === true || ['note', 'cancelled', 'stopped'].includes(src.role))) return false
    return true
  }

  // Deterministically prepend any buffered silent notices before step 1 of a real
  // waking turn so queued work (e.g. `delegate_work` after `note_bot`) never runs
  // ahead of them, while never waking an empty or snapshot-only wake boundary.
  ctx.on('agent/pre-step', async ({ agent, step, messages, signal }, next) => {
    const decision = await next()
    if (decision?.kind === 'reject' || signal?.aborted || !Array.isArray(decision?.messages)) return decision
    if (step !== 1 || !decision.messages.some(isWakingPreStepMessage) || (Array.isArray(messages) && !messages.some(isWakingPreStepMessage))) return decision
    if (!pendingSilent.has(agent.id)) return decision
    const entries = takeSilentEntries(agent.id)
    if (entries.length === 0) return decision
    const alreadyIds = new Set(decision.messages.map(m => m?.id).filter(Boolean))
    const alreadyExchanges = new Set(decision.messages.map(m => m?.source?.exchangeId).filter(Boolean))
    const toPrepend = entries
      .map(entry => entry.message)
      .filter(msg => (msg?.id === undefined || !alreadyIds.has(msg.id))
        && (msg?.source?.exchangeId === undefined || !alreadyExchanges.has(msg.source.exchangeId)))
    void markSilentDelivered(entries, agent.id)
    if (toPrepend.length === 0) return decision
    return {
      ...decision,
      messages: [...toPrepend, ...decision.messages],
    }
  })

  // Roles recorded as team exchanges.
  const EXCHANGE_ROLES = new Set(['request', 'reply', 'stopped', 'ask_back', 'answer', 'cancelled', 'note'])

  // What two Bots say to each other is in the book of the pair (ledger.js), whole, written
  // before the message goes out. A message is shown once a record says it was delivered.
  const pairBook = (a, b) => `pair-${[String(a), String(b)].sort().join('-')}`
  // A pair's book starts from the exchanges a team kept in state.json before the ledger.
  rt.ledger.importer('pair-', book => state.exchanges
    .filter(entry => entry.from !== undefined && entry.to !== undefined && pairBook(entry.from, entry.to) === book)
    .map(entry => ({ ...entry, delivered: true })))
  // Incremental per-pair index cache: advances only over newly appended records and
  // rebuilds in O(1) detection whenever `ledger.js` replaces the array reference
  // (rollback, prepend, drop, or read-only reload).
  const pairCache = new Map()
  function pairRecords(a, b) {
    const book = pairBook(a, b)
    const records = rt.ledger.records(book)
    let cache = pairCache.get(book)
    if (cache === undefined || cache.ref !== records || cache.count > records.length) {
      cache = {
        ref: records,
        peers: [String(a), String(b)],
        count: 0,
        written: new Map(),
        shown: new Map(),
        marks: [],
        replies: new Map(),
        failures: new Map(),
      }
      pairCache.set(book, cache)
    }
    const indexShown = (record) => {
      cache.shown.set(record.id, record)
      if (record.role === 'reply' && typeof record.replyTo === 'string' && record.replyTo !== '') {
        cache.replies.set(`${record.from}\u0000${record.to}\u0000${record.replyTo}`, record)
      }
    }
    for (let i = cache.count; i < records.length; i += 1) {
      const record = records[i]
      if (record.event === 'delivered') {
        const message = cache.written.get(record.id)
        if (message !== undefined) indexShown(message)
        cache.marks.push(record)
        if (typeof record.failureRequestId === 'string' && record.failureRequestId !== '') {
          let list = cache.failures.get(record.failureRequestId)
          if (list === undefined) { list = []; cache.failures.set(record.failureRequestId, list) }
          list.push(record)
        }
      } else if (record.event === undefined) {
        cache.written.set(record.id, record)
        if (record.delivered === true) indexShown(record)
      }
    }
    cache.count = records.length
    return cache
  }
  const pairMessages = (a, b) => [...pairRecords(a, b).shown.values()]

  function dropBotLedgers(botId) {
    if (typeof botId !== 'string' || botId === '') return
    const booksToDrop = new Set()
    for (const otherId of Object.keys(state.bots ?? {})) {
      if (otherId !== botId) booksToDrop.add(pairBook(botId, otherId))
    }
    for (const [book, cache] of pairCache.entries()) {
      if (cache.peers?.includes(botId)) booksToDrop.add(book)
    }
    for (const book of booksToDrop) {
      pairCache.delete(book)
      rt.ledger.drop(book)
    }
    if (Array.isArray(state.exchanges) && state.exchanges.length > 0) {
      state.exchanges = state.exchanges.filter(entry => entry?.from !== botId && entry?.to !== botId)
    }
  }

  // One-time transparent migration for teams saved before the pair ledger (#1316):
  // durably moves legacy `state.exchanges` entries into `bot/ledger/pair-*.jsonl`
  // without losing entries for books that already exist on disk, and keeps any pair's
  // entries fail-closed in `state.exchanges` if its ledger write fails.
  async function migrateLegacyExchanges() {
    if (rt.readOnly?.() !== undefined || !Array.isArray(state.exchanges) || state.exchanges.length === 0) return false
    const snapshot = state.exchanges.slice()
    const byBook = new Map()
    const migratedRefs = new Set()
    for (const entry of snapshot) {
      if (!entry || typeof entry !== 'object') {
        migratedRefs.add(entry)
        continue
      }
      const from = typeof entry.from === 'string' && entry.from !== '' ? entry.from : undefined
      const to = typeof entry.to === 'string' && entry.to !== '' ? entry.to : undefined
      if (from === undefined || to === undefined || rt.botOf(from) === undefined || rt.botOf(to) === undefined) {
        // Legacy records for deleted Bots or non-Bot senders cannot be opened as a pair chat.
        migratedRefs.add(entry)
        continue
      }
      const book = pairBook(from, to)
      let bucket = byBook.get(book)
      if (bucket === undefined) {
        bucket = []
        byBook.set(book, bucket)
      }
      bucket.push(entry)
    }
    for (const [book, entries] of byBook.entries()) {
      const ok = await rt.ledger.mergeRecords(book, entries.map(entry => ({ ...entry, delivered: true })))
      if (ok) {
        for (const entry of entries) migratedRefs.add(entry)
      }
    }
    if (migratedRefs.size === 0) return false
    const before = state.exchanges.length
    state.exchanges = state.exchanges.filter(entry => !migratedRefs.has(entry))
    return state.exchanges.length !== before
  }

  function deliveredReplyOf(fromId, toId, replyTo) {
    if (typeof fromId !== 'string' || fromId === '' || typeof replyTo !== 'string' || replyTo === '') return undefined
    if (typeof toId === 'string' && toId !== '') {
      if (rt.botOf(fromId) !== undefined && rt.botOf(toId) !== undefined) {
        const found = pairRecords(fromId, toId).replies.get(`${fromId}\u0000${toId}\u0000${replyTo}`)
        if (found !== undefined) return found
      }
      return (state.exchanges ?? []).findLast(entry => entry.from === fromId && entry.to === toId && entry.role === 'reply' && entry.replyTo === replyTo)
    }
    if (rt.botOf(fromId) !== undefined) {
      for (const otherId of Object.keys(state.bots ?? {})) {
        if (otherId === fromId) continue
        const found = pairRecords(fromId, otherId).replies.get(`${fromId}\u0000${otherId}\u0000${replyTo}`)
        if (found !== undefined) return found
      }
    }
    return (state.exchanges ?? []).findLast(entry => entry.from === fromId && entry.role === 'reply' && entry.replyTo === replyTo)
  }

  const wasReplyDelivered = (fromId, toId, replyTo) => deliveredReplyOf(fromId, toId, replyTo) !== undefined

  function deliveredFailuresOf(fromId, toId, requestId, targetSessionId, parentWork) {
    if (typeof fromId !== 'string' || typeof toId !== 'string' || typeof requestId !== 'string' || requestId === '') return []
    if (rt.botOf(fromId) === undefined || rt.botOf(toId) === undefined) return []
    const wantedWork = typeof parentWork === 'string' && parentWork !== '' ? parentWork : undefined
    const { written, failures } = pairRecords(fromId, toId)
    const marks = failures.get(requestId)
    if (marks === undefined) return []
    const matches = []
    for (const mark of marks) {
      const markWork = typeof mark.work === 'string' && mark.work !== '' ? mark.work : undefined
      if (markWork !== wantedWork) continue
      const message = written.get(mark.id)
      if (message?.from === fromId && message?.to === toId && sameConversation(state, toId, mark.sessionId, targetSessionId)) {
        matches.push({ id: mark.id, replyTo: message.replyTo, work: markWork, sessionId: mark.sessionId })
      }
    }
    return matches
  }

  const wasFailureRequestDelivered = (fromId, toId, requestId, targetSessionId, parentWork) =>
    deliveredFailuresOf(fromId, toId, requestId, targetSessionId, parentWork).length > 0

  // `sessionId` defaults to the recipient's own chat; group turns name its group Session.
  // `deferred`: a request the Bot already read mid-turn, handed back to answer in a
  // turn of its own; its exchange was recorded when it first arrived. `resumed` and
  // `retried` carry on a turn that a restart cut off or that wrote its tool call as
  // text (resume.js, turns.js); their exchange is recorded already too. `resent` is
  // a message a shutdown cancelled; its first send may not have been recorded.
  // `askedBy` is the member whose @mention called a group turn (groups.js).
  // `fromRoomId`: the group whose Session the sender wrote from; the reply goes back
  // to that Session (turns.js). `images` and `files` go along as image and file blocks,
  // which DSH projects for the recipient's model and tools. `length`: the whole message's
  // length when it went as a file (attachLong). `work`: the work (handoffs.js) a
  // result that came back goes on with. `merged`: a request that takes in an earlier
  // one its recipient had not read, under that one's exchange. `silent` (or `wake:
  // false`, as the work tools say it): a note with no
  // question in it (a profile update, a stop receipt) is put in the queue and read at the
  // recipient's next turn instead of waking it; a turn spent acknowledging a note is a turn
  // the user reads as an answer that never came. `fromPart`: the Session
  // of the sending Bot, which a reply comes back to when that is a background part.
  // A routine receipt from a Bot to a Main Bot is a board line, not a message: the Main
  // Bot reads it with the rest of the board and spends no turn on it. Only the sender can
  // say a message needs no answer, so the marker is explicit (`[[receipt]]`). The board
  // keeps the newest receipt of each Bot — the archive keeps every one — so receipts do
  // not push that Bot's delivery, decision and blocked lines off the three-line board.
  const publishReceipt = (bot, body) => {
    const kept = readTeamBoardLines(undefined, message => rt.warn('ds-bot: %s', message))
      .filter(line => line.bot === bot.name && !String(line.what ?? '').startsWith(RECEIPT_PREFIX))
    const what = `${RECEIPT_PREFIX}${body.replace(/\s+/g, ' ').trim()}`
    writeTeamBoard(bot.name, [{ bot: bot.name, kind: 'delivery', what, at: new Date().toISOString() }, ...kept].slice(0, 3))
  }

  async function deliver({ fromId, fromName: senderName, pairFrom, toId, sessionId, text, role, replyTo, roomId, audience, note, exchangeId = randomUUID(), steer = false, silent = false, queue = false, wake = true, afterCancel = false, deferred = false, resumed = false, retried = false, resent = false, merged = false, abandoned = false, abandonedReason, recordExchange = true, askedBy, fromRoomId, fromPart, images = [], files = [], length, work, workRef, askWork, taskId, attemptId, imOrigin, failureRequestId }) {
    // #1517: a model that writes its tool call in DSML form leaves wire tags in
    // the text it hands delivery; neither the book nor the recipient sees them.
    text = stripWireTags(text)
    const from = rt.botOf(fromId)
    const to = rt.botOf(toId)
    if (to === undefined) throw Object.assign(new Error(`Unknown Bot ${toId}`), { delivered: false })
    // A chat template's stop marker is not part of the message: neither the book nor
    // the recipient sees it (#14).
    text = stripControlMarkers(text)
    // Two spellings of one thing: a note that must not open a turn (roster.js says
    // `silent`, the work tools say `wake: false`).
    const noWake = silent === true || wake === false
    const fromName = senderName ?? from?.name ?? 'You'
    const room = rt.roomOf(roomId)
    const asker = work === undefined ? undefined : rt.botOf(state.works?.[work]?.from)?.name
    const resolvedWorkRef = workRef ?? rt.workRefOf?.(role === 'reply' ? replyTo : askWork ?? work ?? exchangeId)
    // A routine receipt for a Main Bot lands on the board instead of opening a turn (see
    // publishReceipt). The marker is the sender's explicit statement; a reply that only
    // reports "nothing to do" is the same receipt when the sender forgot it, because it
    // carries no work either. A marked message stays a normal message when it answers
    // someone, comes from or goes to a room or the user, carries an attachment, or was
    // merged into an earlier request: those are the cases where someone needs to read it.
    const marked = typeof text === 'string' ? text.match(RECEIPT_MARKER) : null
    const body = marked === null ? text : text.slice(marked[0].length).trim()
    const routine = from !== undefined && rt.isMain(toId)
      && roomId === undefined && audience === undefined && fromRoomId === undefined
      && merged !== true && images.length === 0 && files.length === 0
    const noWork = work === undefined && (role === 'request' || role === 'reply') && isNoWorkStatusText(body)
    const receipt = routine && (noWork || (marked !== null && role === 'request' && replyTo === undefined))
    if (receipt) {
      let onBoard = false
      try {
        publishReceipt(from, body === '' ? '（无正文）' : body)
        onBoard = true
      } catch (error) {
        // A board that cannot be written must not swallow the message: it goes out
        // as the message it would have been.
        rt.warn('ds-bot: a receipt from %s was not written to the team board: %s', from.id, error?.message ?? error)
      }
      if (onBoard) {
        // delegate_work opened a work for this request before delivering it; a receipt
        // gets no answer, so the work goes with the turn it saves.
        try { await rt.dropWork?.(exchangeId) } catch { /* the board line is what matters */ }
        return exchangeId
      }
    }
    // Even when it goes out as a message, the marker is for the board, not the reader.
    if (marked !== null) text = body
    // Session events reject `undefined` members, so optional fields are omitted instead.
    const source = {
      kind: SOURCE_KIND,
      form: 'relay',
      role,
      exchangeId,
      senderName: fromName,
      ...(noWake ? { silent: true } : {}),
      ...(work ? { work } : {}),
      ...(resolvedWorkRef ? { workRef: resolvedWorkRef } : {}),
      ...(askWork ? { askWork } : {}),
      ...(taskId ? { taskId } : {}),
      ...(attemptId ? { attemptId } : {}),
      ...(imOrigin ? { imOrigin } : {}),
      ...(fromId ? { senderSessionId: fromId } : {}),
      ...(fromPart ? { senderPart: fromPart } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(roomId ? { roomId } : {}),
      ...(audience === 'user' ? { audience } : {}),
      ...(deferred ? { deferred: true } : {}),
      ...(resumed ? { resumed: true } : {}),
      ...(resent ? { resent: true } : {}),
      ...(retried ? { retried: true } : {}),
      ...(askedBy ? { askedBy } : {}),
      ...(fromRoomId ? { senderRoomId: fromRoomId } : {}),
      ...(abandoned ? { abandoned: true } : {}),
    }
    const targetSessionId = sessionId ?? rt.chatOf(toId)
    // On disk before it goes out: a message the book could not keep is not sent, so none is
    // delivered with no record of it. A resend keeps the record it has; only a merged request
    // replaces it with its added text.
    const bookPeer = fromId !== undefined && from !== undefined
      ? fromId
      : (pairFrom !== undefined && rt.botOf(pairFrom) !== undefined ? pairFrom : undefined)
    const book = bookPeer !== undefined && recordExchange && EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried ? pairBook(bookPeer, toId) : undefined
    let enqueued = false
    let deliveredNow = true
    const ledgerMeta = book !== undefined
      ? {
          book,
          id: exchangeId,
          sessionId: targetSessionId,
          ...(typeof failureRequestId === 'string' && failureRequestId !== '' ? { failureRequestId } : {}),
          ...(typeof work === 'string' && work !== '' ? { work } : {}),
        }
      : undefined
    // The silent notes are the only ones a mailbox keeps: they never open a turn, so
    // without a record a window that closed before the next turn would drop them. The
    // routing below is unchanged; a reply or a request still goes to its Session.
    if (noWake) {
      await rt.inbox.append(toId, {
        from: fromId ?? null,
        fromName,
        role,
        sessionId: targetSessionId,
        senderRoomId: fromRoomId ?? null,
        exchangeId,
        roomId,
        text,
        time: Date.now(),
      }).catch(error => rt.warn('ds-bot: a silent message to %s was not saved to its mailbox: %s', toId, error?.message ?? error))
    }
    try {
      if (book !== undefined && (merged || !pairRecords(bookPeer, toId).written.has(exchangeId))) {
        rt.ledger.append(book, { id: exchangeId, from: fromId ?? 'user', to: toId, role, text, time: Date.now(), ...(resolvedWorkRef ? { workRef: resolvedWorkRef } : {}), ...(length !== undefined ? { length, files } : {}), ...(replyTo ? { replyTo } : {}), ...(audience === 'user' ? { audience } : {}), ...(roomId ? { roomId } : {}) })
        await rt.ledger.written(book)
      }
      await rt.ensureCapabilities(targetSessionId)
      const agent = await resolveAgent(targetSessionId)
      if (resumed && await rt.workspaceHold?.heldFor(agent.session)) {
        throw Object.assign(new Error('The worktree is held. Return it before resuming.'), { code: 'bot/busy' })
      }
      const busy = rt.live.get(targetSessionId)?.turn !== undefined
      // A window already counting down is still a batch in the making: a note that
      // lands there joins it instead of starting a turn of its own.
      const arming = flushTimers.get(targetSessionId) !== undefined
      if ((busy || arming) && plainRelay({ role, text, replyTo, roomId, audience, work, fromRoomId, silent: noWake, steer, queue, deferred, resumed, retried, merged, abandoned, images, files })) {
        const held = waiting.get(targetSessionId) ?? []
        held.push({ text, role, fromName, roomName: room?.name, audience, note, deferred, replyTo, source, exchangeId, book })
        waiting.set(targetSessionId, held)
        // A first note starts the longest wait; a later one restarts a quiet window
        // already counting down after the turn ended.
        arm(targetSessionId, { deadline: held.length === 1, quiet: flushTimers.get(targetSessionId)?.quiet !== undefined })
        return exchangeId
      }
      // A non-waking note/cancel injects model-facing context ONLY while the target is idle
      // (buffering until idle if the target is currently running, so DSH never runs an extra
      // model step or starts a spurious turn). A steered message cuts into a running turn at
      // its next step; a follow-up queues.
      const message = createUserMessage({
        content: [
          { type: 'text', text: `${headerFor(role, fromName, room?.name, audience, note, deferred, { resumed, retried, resent, abandoned, abandonedReason, asker, workRef: resolvedWorkRef, silent: noWake })}\n${text}` },
          ...images.map(attachment => ({ type: 'image', attachment })),
          ...files.map(attachment => ({ type: 'file', attachment })),
        ],
        source,
      })
      if (noWake) {
        if (afterCancel && isBusyAgent(agent, targetSessionId)) await waitIdleBriefly(agent)
        const injected = injectSilent(targetSessionId, message, agent, ledgerMeta)
        enqueued = true
        if (injected) {
          await ctx.sessions.flush(agent.session)
        } else {
          // Buffered until idle / next pre-step: pair-ledger 'delivered' is written once flushed.
          deliveredNow = false
        }
      } else {
        const takenSilent = !isBusyAgent(agent, targetSessionId) && pendingSilent.has(targetSessionId)
          ? takeSilentEntries(targetSessionId)
          : []
        let woke = false
        try {
          const pendingIds = pendingMessageIds(agent)
          for (const entry of takenSilent) injectIfNotPending(agent, entry.message, pendingIds)
          if (steer) agent.steer(message)
          else agent.followup(message)
          woke = true
          enqueued = true
          await ctx.sessions.flush(agent.session)
        } catch (error) {
          // Restore silent notes only if the waking call itself never ran; once steer/followup
          // woke the turn, already-injected notes sit in the agent's inbox for that turn and
          // must not be re-buffered (which would duplicate them or collide on message.id).
          if (!woke && takenSilent.length > 0) {
            putBackSilentNotes(targetSessionId, takenSilent)
          }
          throw error
        }
        if (takenSilent.length > 0) void markSilentDelivered(takenSilent, targetSessionId)
      }
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.delivered === undefined) {
        error.delivered = enqueued
      }
      throw error
    }
    if (deliveredNow && ledgerMeta !== undefined) {
      await markSilentDelivered([{ ledger: ledgerMeta }])
    }
    return exchangeId
  }

  // The turn ended, or the batch has waited long enough: the notes that waited go out
  // as one message. The newest one keeps its words; replies before it keep theirs under
  // their own headers, and only folded requests are counted as unseen (R59).
  async function flushWaiting(sessionId) {
    const queued = waiting.get(sessionId)
    if (queued === undefined || queued.length === 0) {
      unarm(sessionId)
      return
    }
    unarm(sessionId)
    waiting.delete(sessionId)
    const folded = mergeBacklog(queued)
    if (folded === undefined) return
    if (folded.rest.length > 0) {
      waiting.set(sessionId, folded.rest)
      arm(sessionId, { deadline: true })
    }
    const newest = folded.batch[folded.batch.length - 1]
    // Every exchange the batch took in travels with it, so none is sent again when
    // this process stops before a turn takes the message up (resume.js).
    const source = { ...newest.source, exchangeIds: folded.batch.map(entry => entry.exchangeId) }
    const message = createUserMessage({
      content: [{ type: 'text', text: `${headerFor(newest.role, newest.fromName, newest.roomName, newest.audience, newest.note, newest.deferred)}\n${folded.text}` }],
      source,
    })
    let agent
    try {
      agent = await resolveAgent(sessionId)
    } catch (error) {
      // Not lost: the batch stays queued and is tried again at the Bot's next turn.
      rt.warn('ds-bot: notes held for %s not delivered: %s', sessionId, error)
      waiting.set(sessionId, [...folded.batch, ...folded.rest])
      arm(sessionId, { deadline: true })
      return
    }
    try {
      agent.followup(message)
      await ctx.sessions.flush(agent.session)
    } catch (error) {
      // The batch left `waiting` before it was handed over; putting it back keeps a
      // rejected flush from dropping every reply it carried until the next restart.
      rt.warn('ds-bot: notes held for %s not delivered: %s', sessionId, error)
      waiting.set(sessionId, [...folded.batch, ...(waiting.get(sessionId) ?? [])])
      arm(sessionId, { deadline: true })
      return
    }
    for (const entry of folded.batch) {
      if (entry.book === undefined) continue
      rt.ledger.append(entry.book, { event: 'delivered', id: entry.exchangeId, sessionId, time: Date.now() })
      await rt.ledger.written(entry.book).catch(() => {})
    }
  }

  // A deleted Bot's Sessions will never read what waited for them.
  const dropWaiting = (sessionId) => {
    unarm(sessionId)
    const queued = waiting.get(sessionId)
    waiting.delete(sessionId)
    return queued?.length ?? 0
  }

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const sessionId = agent?.session?.id ?? agent?.id
    if (sessionId === undefined || !waiting.has(sessionId)) return
    // A quiet window, not an immediate send: a note that comes right after the turn
    // ends still joins the same batch.
    arm(sessionId, { quiet: true })
  })

  // A shutdown leaves no timer behind for a batch that can no longer go out.
  ctx.effect?.(() => () => {
    for (const sessionId of flushTimers.keys()) unarm(sessionId)
    waiting.clear()
  }, 'ds-bot: waiting notes')

  // A message between Bots, whole, from the Session it was delivered to: the message
  // there is its header line, then the text. `whole` is false when only the start could
  // be read (the Session is gone, or the message is past what the dialog shows).
  async function exchangeText(entry) {
    // A message of the ledger is whole there, or in its file when it went as one.
    if (entry.ledger === true && entry.files?.length > 0) return await fileText(entry.files[0]) ?? { text: headOf(entry.text, TEXT_SHOW_MAX), whole: false }
    if (entry.ledger === true) return { text: headOf(entry.text, TEXT_SHOW_MAX), whole: entry.text.length <= TEXT_SHOW_MAX }
    if (entry.length === undefined) return { text: entry.text, whole: true }
    if (entry.files?.length > 0) return await fileText(entry.files[0]) ?? { text: entry.text, whole: false }
    try {
      for await (const event of rt.eventsBackwards(entry.sessionId ?? rt.chatOf(entry.to), AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
        if (event.type !== 'user/message' || event.data?.source?.exchangeId !== entry.id) continue
        const delivered = textOf(event.data.content)
        const text = delivered.slice(delivered.indexOf('\n') + 1)
        return { text: headOf(text, TEXT_SHOW_MAX), whole: text.length <= TEXT_SHOW_MAX }
      }
    } catch (error) {
      rt.warn('ds-bot: message %s not read back: %s', entry.id, error)
    }
    return { text: entry.text, whole: false }
  }

  // A message a Bot sends past MESSAGE_INLINE_MAX goes as a DSH file: it is stored once,
  // not in every Session it reaches, and the model reads it with its file tools when it
  // needs it. Undefined when this DSH cannot store files.
  async function attachLong(text, name) {
    if (text.length <= MESSAGE_INLINE_MAX) return { text, files: [] }
    try {
      const file = await ctx.get?.('attachments')?.saveFile({ data: new TextEncoder().encode(text), name })
      if (file === undefined) return undefined
      // The file stays verbatim, so a line past what the read tool shows needs another way.
      const wide = text.split('\n').some(line => line.length > READ_LINE_MAX)
      const note = `[A long message: ${text.length} characters. Its start is below; all of it is in the attached file. Read the file before you act on it.${wide ? ` Some lines are longer than the ${READ_LINE_MAX} characters the read tool shows of a line; read those with a shell command.` : ''}]`
      return { text: `${note}\n${headOf(text, LONG_HEAD)}…`, files: [file], length: text.length }
    } catch (error) {
      rt.warn('ds-bot: long message not stored as a file: %s', error)
      return undefined
    }
  }

  // The text of a stored file, limited to what the dialogs show by default.
  async function fileText(file, maxLength = TEXT_SHOW_MAX) {
    const attachments = ctx.get?.('attachments')
    if (attachments === undefined) return undefined
    const decoder = new TextDecoder()
    let text = ''
    try {
      for await (const chunk of attachments.readFileStream(file, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
        text += decoder.decode(chunk, { stream: true })
        if (text.length > maxLength) return { text: headOf(text, maxLength), whole: false }
      }
    } catch (error) {
      rt.warn('ds-bot: file %s not read: %s', file?.name, error)
      return undefined
    }
    text += decoder.decode()
    return { text, whole: true }
  }

  const exchangesOf = (a, b) => pairMessages(a, b).map((record) => {
    const kept = headOf(record.text ?? '', TEXT_KEPT)
    const { delivered: _delivered, ...rest } = record
    return { ...rest, text: kept, ...(record.length === undefined && kept.length < (record.text ?? '').length ? { length: record.text.length } : {}) }
  })
  const formatExchangeRecord = (record) => {
    if (record === undefined) return undefined
    // Imported from before the ledger: as whole as it was kept then.
    if (record.sessionId !== undefined || (record.length !== undefined && !(record.files?.length > 0))) return record
    return { ...record, ledger: true }
  }
  const exchangeOf = (id, a, b) => formatExchangeRecord(pairRecords(a, b).shown.get(id))
  const exchangeById = (id) => {
    if (typeof id !== 'string' || id === '') return undefined
    for (const cache of pairCache.values()) {
      if (!Array.isArray(cache.peers) || cache.peers.length < 2) continue
      const hit = pairRecords(cache.peers[0], cache.peers[1]).shown.get(id)
      if (hit !== undefined) return formatExchangeRecord(hit)
    }
    const botIds = Object.keys(state.bots ?? {})
    for (let i = 0; i < botIds.length; i += 1) {
      for (let j = i + 1; j < botIds.length; j += 1) {
        const book = pairBook(botIds[i], botIds[j])
        if (pairCache.has(book)) continue
        if (typeof rt.ledger.hasBook === 'function' && !rt.ledger.hasBook(book)) continue
        const hit = pairRecords(botIds[i], botIds[j]).shown.get(id)
        if (hit !== undefined) return formatExchangeRecord(hit)
      }
    }
    return (state.exchanges ?? []).find(item => item?.id === id)
  }

  Object.assign(rt, {
    resolveAgent, deliver, flushWaiting, dropWaiting,
    flushSilentNotes, takeSilentNotes, takeSilentEntries, putBackSilentNotes,
    markSilentDelivered, moveSilentNotes, restoreSilentNotes, injectSilent, dropBotLedgers,
    migrateLegacyExchanges, exchangeText, attachLong, fileText, exchangesOf, exchangeOf, exchangeById,
    deliveredReplyOf, wasReplyDelivered, deliveredFailuresOf, wasFailureRequestDelivered,
  })
}
