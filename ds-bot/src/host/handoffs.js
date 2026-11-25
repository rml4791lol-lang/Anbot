// Hand-offs: the work Bots give each other, and what each Bot is doing right now.
//
// A Bot's request to another Bot is a piece of work. What the recipient hands on while
// it works on it hangs below it, and the recipient's answer goes up only once all of
// that came back, together with what came back. Results find their way up by
// themselves, so no Bot needs to message one that waits for it, and that is the one
// hand-off refused. The open works are kept in state.json so a restart waits on.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isAckLikeText, LATE_ANSWER, PAIR_LOOP_TTL_MS, TEXT_KEPT, WORK_ASK_BACK_LIMIT, WORK_REWORK_CHECKPOINT } from './constants.js'
import { normalizeImOrigin, sameImOrigin } from './im/origin.js'
import { headOf } from './text.js'
import { installTaskLog } from './task-ledger.js'
import { PendingCallCache, clearRecoveryNeeded, evidenceFromEvents, noteAttemptRecovery, noteRecoveryNeeded, progressAfterTurn, progressFingerprint, verifyAcceptance } from './task-evidence.js'
import { isActiveTask, ownChatSessions, threadCurrentOfPart, threadOfPart } from './threads.js'

const own = (obj, key) => (obj != null && typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined)
const safeKey = key => typeof key === 'string' && key !== '' && key !== '__proto__' && key !== 'constructor' && key !== 'prototype'

const minutes = since => {
  const count = Math.floor((Date.now() - since) / 60_000)
  return count < 1 ? 'for less than a minute' : `for ${count} min`
}
const MAX_ACCEPTANCE_REWORKS = 2
const REWORK_TEXT_MAX = 1200
// A card can wait for days.
const forHowLong = since => {
  const hours = Math.floor((Date.now() - since) / 3_600_000)
  if (hours < 1) return minutes(since)
  if (hours < 24) return `for ${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.floor(hours / 24)
  return `for ${days} day${days === 1 ? '' : 's'}`
}

export function install(rt) {
  const { ctx, state } = rt
  const logTask = installTaskLog(rt)
  const works = () => (state.works ??= {})
  const callsBySession = new PendingCallCache()
  const closedWorks = () => (state.closedWorks ??= {})
  const pairLoops = () => (state.pairLoops ??= {})
  const CLOSED_KEPT = 100
  // What came back, whole; state.json keeps the start of each.
  const whole = new Map()
  const save = ({ required = false } = {}) => required
    ? rt.save({ required: true })
    : rt.save().catch(() => {})
  const nameOf = id => rt.botOf(id)?.name
  const pairKey = (a, b) => [String(a), String(b)].sort().join(':')
  const nextWorkRef = () => {
    state.workSeq = (Number.isInteger(state.workSeq) && state.workSeq >= 0 ? state.workSeq : 0) + 1
    return `W${state.workSeq}`
  }
  const rememberClosed = (id, entry) => {
    if (!safeKey(id)) return
    const map = closedWorks()
    map[id] = entry
    const ids = Object.keys(map)
    if (ids.length > CLOSED_KEPT) {
      for (const old of ids.sort((a, b) => (map[a].at ?? 0) - (map[b].at ?? 0)).slice(0, ids.length - CLOSED_KEPT)) delete map[old]
    }
  }
  const normalizeRef = ref => {
    const text = String(ref ?? '').trim()
    const match = /^#?(w\d+)$/i.exec(text)
    return match === null ? undefined : match[1].toUpperCase()
  }
  function resolveWork(refOrId) {
    const key = String(refOrId ?? '').trim()
    if (key === '') return undefined
    const direct = own(works(), key)
    if (direct !== undefined) return { id: key, work: direct }
    const ref = normalizeRef(key)
    if (ref === undefined) return undefined
    for (const [id, work] of Object.entries(works())) {
      if (work?.ref === ref) return { id, work }
    }
    return undefined
  }
  function closedWorkOf(refOrId) {
    const key = String(refOrId ?? '').trim()
    if (key === '') return undefined
    const direct = own(closedWorks(), key)
    if (direct !== undefined) return direct
    const ref = normalizeRef(key)
    if (ref === undefined) return undefined
    return Object.values(closedWorks()).find(entry => entry?.ref === ref)
  }

  // The whole result of a work, in a file of its own: state.json is written whole on
  // every save, so it keeps only the start of a long result, and a restart would cut
  // that result short before it reached the Bot that asked for it.
  const resultsDir = join(rt.home, 'handoff-results')
  const resultPath = name => join(resultsDir, name)
  // A work id is a UUID, but a saved team could carry any name: it stays inside the
  // folder, and one that is not plain falls back to a hash of the id.
  const resultName = id => {
    const text = String(id)
    return `${/^[A-Za-z0-9_-]{1,80}$/.test(text) ? text : createHash('sha256').update(text).digest('hex')}.txt`
  }
  const keptName = file => (typeof file === 'string' && /^[A-Za-z0-9_-]+\.txt$/.test(file) ? file : undefined)
  const writes = () => rt.readOnly?.() === undefined
  let savedWrites = 0
  const tracksSaved = typeof rt.onSaved === 'function'
  if (tracksSaved) rt.onSaved(() => { savedWrites += 1 })

  // The result of a work, whole, in a file of its own. The file is written before the
  // team file names it, so a result that is claimed to exist is there.
  function keepResult(id, text) {
    if (text.length <= TEXT_KEPT || !writes()) return undefined
    const name = resultName(id)
    const path = resultPath(name)
    const temp = `${path}.${process.pid}.tmp`
    try {
      mkdirSync(resultsDir, { recursive: true })
      writeFileSync(temp, text, 'utf8')
      renameSync(temp, path)
      return name
    } catch (error) {
      rt.warn('ds-bot: result of work %s not kept whole: %s', id, error)
      try {
        rmSync(temp, { force: true })
      } catch {}
      return undefined
    }
  }

  const referencedInWorks = (table) => {
    const used = new Set()
    for (const work of Object.values(table ?? {})) {
      for (const result of work?.results ?? []) {
        const name = keptName(result?.file)
        if (name !== undefined) used.add(name)
      }
    }
    return used
  }

  // Drops result files that are no longer needed once the replacement state actually
  // reached disk. When `store.js` tracks real writes via `rt.onSaved`, avoids blocking
  // the event loop with a synchronous `readFileSync` + `JSON.parse(state.json)` per file.
  const dropResults = (results, savedBefore) => {
    const names = [...new Set((results ?? []).map(result => keptName(result?.file)).filter(Boolean))]
    if (names.length === 0 || !writes()) return
    if (tracksSaved) {
      // save() resolved without writing to disk (shutdown / read-only): keep durable files.
      if (savedWrites === savedBefore) return
      const live = referencedInWorks(works())
      for (const name of names) {
        if (live.has(name)) continue
        void rm(resultPath(name), { force: true }).catch(() => {})
      }
      return
    }
    try {
      // Standalone unit-test fallback (without store.js onSaved): read state.json once per batch.
      const saved = JSON.parse(readFileSync(join(rt.home, 'state.json'), 'utf8'))
      const durable = referencedInWorks(saved.works)
      for (const name of names) {
        if (durable.has(name)) continue
        rmSync(resultPath(name), { force: true })
      }
    } catch {}
  }

  // Startup async sweep for orphan `handoff-results/*.txt` files left behind by a crash.
  async function pruneOrphanResultFiles() {
    if (!writes()) return
    let entries
    try {
      entries = await readdir(resultsDir)
    } catch {
      return
    }
    const referenced = referencedInWorks(works())
    for (const file of entries) {
      const name = keptName(file)
      if (name === undefined || referenced.has(name)) continue
      await rm(resultPath(name), { force: true }).catch(() => {})
    }
  }

  // What came back for a work: the whole result if it is still to be found, else the
  // start of it. A result that a restart cut, or whose file is gone, is reported as
  // such and not passed on as if it were whole.
  function resultText(result) {
    if (whole.has(result.id)) return { text: whole.get(result.id), whole: true }
    if (result.length === undefined) return { text: result.text ?? '', whole: true }
    const name = keptName(result.file)
    if (name !== undefined) {
      try {
        const text = readFileSync(resultPath(name), 'utf8')
        if (text.length === result.length) return { text, whole: true }
      } catch {
        // The file is gone or unreadable: the start of the result is all there is.
      }
    }
    return { text: result.text ?? '', whole: false }
  }

  // The work a turn does: the request it answers, or the work a result that came back
  // (or a turn picked up again) goes on with.
  const workOf = info => (info === undefined ? undefined
    : info.role === 'request' && info.audience !== 'user' ? info.exchangeId : info.work)

  // `parent`: the work the sender was doing when it sent this one. `child`: the
  // session id of the subagent a run of this work belongs to — the run, not the
  // child, is the sub-work, so a child that is continued hands up a result per run.
  // `fromPart`: the part of the sender's own chat it wrote from, which its answer goes
  // back to when that is a background part. `imOrigin`: the IM chat that asked the
  // sender for this work, kept out of public views and Session logs.
  function openWork(id, { from, to, parent, fromRoom, room, name, child, goalTask, fromPart, toSession, toTaskId, imOrigin, goal, state: initialState = 'open', paused, checks = [], acceptance = '' }) {
    if (!safeKey(id)) return undefined
    const above = parent === undefined ? undefined : own(works(), parent)
    const cleanOrigin = normalizeImOrigin(imOrigin)
    // Only assign visible #W… refs to Bot-to-Bot delegations, not internal subagents,
    // background tasks, or group posts, so user-facing work numbers stay contiguous.
    const ref = from !== undefined && to !== undefined && room === undefined && child === undefined ? nextWorkRef() : undefined
    const now = Date.now()
    const attempt = { id: `${id}:a1`, n: 1, status: 'working', startedAt: now, updatedAt: now }
    const goalTaskId = typeof goalTask?.taskId === 'string' ? goalTask.taskId : ''
    const goalTaskAttemptId = typeof goalTask?.attemptId === 'string' ? goalTask.attemptId : ''
    const requiredChecks = Array.isArray(checks) ? checks.filter(check => check?.required !== false) : []
    const verification = requiredChecks.length > 0
      ? {
          state: 'pending', status: 'pending', manual: false, checkEvidence: {}, evidenceIds: [],
          checks: requiredChecks.map(check => ({ id: check.id, status: 'pending' })),
          missing: requiredChecks.map(check => check.id),
          reason: 'Waiting for matching executed evidence for every acceptance check.',
        }
      : { state: 'pending', status: 'pending', manual: true, evidenceIds: [], checks: [], missing: [], reason: 'No typed acceptance checks were declared for this hand-off.' }
    const record = {
      ...(ref !== undefined ? { ref } : {}),
      state: initialState,
      ...(from ? { from } : {}), ...(to ? { to } : {}), ...(room ? { room } : {}), ...(above ? { parent } : {}),
      ...(fromRoom ? { fromRoom } : {}), ...(fromPart ? { fromPart } : {}), ...(toSession ? { toSession } : {}), ...(toTaskId ? { toTaskId } : {}),
      ...(name ? { name } : {}), ...(child ? { child } : {}),
      ...(cleanOrigin ? { imOrigin: cleanOrigin } : {}),
      ...(typeof goal === 'string' && goal.trim() !== '' ? { goal: headOf(goal.trim().replace(/\s+/g, ' '), 80) } : {}),
      ...(paused !== undefined ? { paused } : {}),
      ...(goalTaskId ? { goalTask: { taskId: goalTaskId, ...(goalTaskAttemptId ? { attemptId: goalTaskAttemptId } : {}) } } : {}),
      ...(acceptance ? { acceptance } : {}),
      ...(Array.isArray(checks) && checks.length > 0 ? { checks } : {}),
      rounds: 0,
      worked: false,
      open: [], results: [], at: now,
      attempt,
      checkpoint: { at: now, attemptId: attempt.id, kind: 'progress', summary: 'Work started.', nextAction: name ?? 'Complete the requested work.' },
      progress: { state: 'moving', fingerprint: progressFingerprint([]), lastTurnFingerprint: progressFingerprint([]), unchangedTurns: 0, changedAt: now },
      verification,
      ...(requiredChecks.length > 0 ? { rework: [], reworkCount: 0, maxReworks: MAX_ACCEPTANCE_REWORKS } : {}),
      evidence: [],
    }
    works()[id] = record
    if (above !== undefined) above.open.push(id)
    const forget = () => {
      if (works()[id] === record) delete works()[id]
      const parentWork = own(works(), parent)
      const at = parentWork?.open?.indexOf(id) ?? -1
      if (at >= 0) parentWork.open.splice(at, 1)
    }
    return save({ required: true }).then(() => {
      logTask({ kind: 'open', id, from, to, parent, room, child, name })
      return record
    }, error => {
      forget()
      throw error
    })
  }

  function setWorkTargetSession(id, toSession, toTaskId) {
    const work = own(works(), id)
    if (work === undefined) return
    if (toSession) work.toSession = toSession
    else if (toSession === null || toSession === '') delete work.toSession
    if (toTaskId) work.toTaskId = toTaskId
    else if (toTaskId === null || toTaskId === '') delete work.toTaskId
    save()
  }

  const workRefOf = id => own(works(), id)?.ref ?? own(closedWorks(), id)?.ref
  const workStateOf = id => {
    const work = own(works(), id)
    return work === undefined ? undefined : (work.state ?? 'open')
  }
  function markWorkWorked(id) {
    const work = own(works(), id)
    if (work === undefined || work.worked === true) return
    work.worked = true
    save()
  }

  // Pair loop guard: tracks consecutive Bot-to-Bot delegations between (a, b) since the
  // last user message to either Bot, expiring after PAIR_LOOP_TTL_MS of inactivity.
  // Reciprocal zero-work bounces (B -> A right after A -> B) or ACK/wrap-up ping-pong
  // pause immediately at 2 (after 1 empty round-trip); same-direction substantive
  // pure-LLM delegations (neither call nor reply is ack-like) are governed by
  // WORK_REWORK_CHECKPOINT (4) so multi-section drafting/translation/review runs smoothly.
  function noteWorkCompleted(fromId, toId, { worked = false, id, text = '' } = {}) {
    if (!fromId || !toId || fromId === toId) return
    const key = pairKey(fromId, toId)
    const map = pairLoops()
    const now = Date.now()
    for (const [entryKey, item] of Object.entries(map)) {
      if (entryKey !== key && now - (item?.lastAt ?? 0) > PAIR_LOOP_TTL_MS) delete map[entryKey]
    }
    const prev = own(map, key)
    const fresh = prev !== undefined && now - (prev.lastAt ?? 0) <= PAIR_LOOP_TTL_MS
    const entry = fresh ? prev : { idleBounces: 0, reworkBounces: 0, lastAt: 0 }
    entry.reworkBounces = (entry.reworkBounces ?? 0) + 1
    entry.idleBounces = worked === true ? 0 : (entry.idleBounces ?? 0) + 1
    entry.lastWorked = worked === true
    entry.lastFrom = fromId
    entry.lastTo = toId
    entry.lastAck = worked !== true && isAckLikeText(text)
    entry.lastAt = now
    if (id !== undefined) entry.lastWorkId = id
    map[key] = entry
    save()
  }
  function resetPairLoop(a, b) {
    if (!a || !b) return
    const key = pairKey(a, b)
    if (own(pairLoops(), key) === undefined) return
    delete pairLoops()[key]
    save()
  }
  function resetBotLoops(botId) {
    if (!botId) return
    const map = pairLoops()
    let changed = false
    for (const key of Object.keys(map)) {
      const [a, b] = key.split(':')
      if (a === botId || b === botId) {
        delete map[key]
        changed = true
      }
    }
    if (changed) save()
  }
  function checkPairLoop(fromId, toId, { callerWorked = false, text = '' } = {}) {
    if (!fromId || !toId || fromId === toId) return { ok: true }
    for (const [id, work] of Object.entries(works())) {
      if (work?.state === 'paused' && ((work.from === fromId && work.to === toId) || (work.from === toId && work.to === fromId))) {
        return { blocked: 'already_paused', id, work }
      }
    }
    const entry = own(pairLoops(), pairKey(fromId, toId))
    if (entry === undefined) return { ok: true }
    if (Date.now() - (entry.lastAt ?? 0) > PAIR_LOOP_TTL_MS) return { ok: true }
    if (!callerWorked) {
      const idleBounces = entry.idleBounces ?? 0
      const reciprocalOrAck = entry.lastFrom === toId || entry.lastAck === true || isAckLikeText(text)
      if (idleBounces >= 1 && reciprocalOrAck) {
        return { pause: 'idle_loop', bounces: idleBounces + 1 }
      }
    }
    if ((entry.reworkBounces ?? 0) >= WORK_REWORK_CHECKPOINT) {
      return { pause: 'rework_limit', bounces: entry.reworkBounces }
    }
    return { ok: true }
  }

  // Worker asks the caller a blocking question without closing the work.
  // Bounded by WORK_ASK_BACK_LIMIT (and pauses earlier if bouncing with zero real work).
  function askBackWork(id, question, { worked = false, text, files, length } = {}) {
    const work = own(works(), id)
    if (work === undefined) return { error: 'not_found' }
    const current = work.state ?? 'open'
    if (current !== 'open') return { error: `state_${current}`, work }
    if (!work.from || !work.to) return { error: 'no_caller', work }
    const didWork = worked === true || work.worked === true
    const rounds = (work.rounds ?? 0) + 1
    work.rounds = rounds
    const boundedQuestion = headOf(String(question ?? '').trim(), 400)
    work.question = boundedQuestion
    // Pause if clarifications hit the checkpoint, or on a 2nd ask_back with 0 real work.
    if (rounds > WORK_ASK_BACK_LIMIT || (!didWork && rounds >= 2)) {
      work.state = 'paused'
      work.paused = {
        reason: 'ask_back_limit',
        kind: 'ask_back',
        question: boundedQuestion,
        ...(typeof text === 'string' && text !== '' ? { text } : {}),
        ...(Array.isArray(files) && files.length > 0 ? { files } : {}),
        ...(length !== undefined ? { length } : {}),
        rounds,
        at: Date.now(),
      }
      save()
      return { status: 'paused', id, work }
    }
    work.state = 'need_input'
    save()
    return { status: 'asked', id, work }
  }

  // Caller answers an ask_back question and hands control back to the worker.
  function answerWork(id) {
    const work = own(works(), id)
    if (work === undefined) return { error: 'not_found' }
    if ((work.state ?? 'open') !== 'need_input') return { error: `state_${work.state ?? 'open'}`, work }
    work.state = 'open'
    delete work.question
    work.worked = false
    save()
    return { status: 'answered', id, work }
  }

  // Cancels an open, need_input, or paused work cleanly (terminal state).
  function cancelWork(id, { reason = '', by } = {}) {
    const work = own(works(), id)
    if (work === undefined) return undefined
    const snapshot = { id, ...work }
    const { parent } = work
    delete works()[id]
    rememberClosed(id, {
      id,
      ref: work.ref,
      from: work.from,
      to: work.to,
      status: 'cancelled',
      ...(by ? { by } : {}),
      ...(reason ? { reason: headOf(reason, 200) } : {}),
      at: Date.now(),
    })
    for (const child of Object.values(works())) if (child.parent === id) delete child.parent
    const above = own(works(), parent)
    if (above !== undefined) above.open = above.open.filter(other => other !== id)
    for (const result of work.results ?? []) whole.delete(result.id)
    const savedBefore = savedWrites
    void rt.save().then(() => {
      dropResults(work.results, savedBefore)
    }).catch(() => {})
    return snapshot
  }

  // Owner Bot of a work node: the delegated worker `to`, or for a task sub-work (`child`),
  // the Bot running that background task (`from`).
  const ownerBotOfWork = work => work?.to ?? (work?.child !== undefined ? work.from : undefined)
  // Upstream Bot that originally requested a work node, walking past internal task wrappers.
  const rootAsker = (work) => {
    const seen = new Set()
    let cur = work
    while (cur !== undefined && cur.to === undefined && cur.child !== undefined && cur.parent !== undefined && !seen.has(cur.parent)) {
      seen.add(cur.parent)
      cur = own(works(), cur.parent)
    }
    return cur?.from
  }

  // Resolves an active background task thread that initiated a top-level work (`parent === undefined`).
  const activeTaskThreadOf = (work) => {
    const callerBot = work?.from === undefined ? undefined : rt.botOf(work.from)
    if (callerBot === undefined || work.fromPart === undefined) return undefined
    const taskThread = threadOfPart(callerBot, work.fromPart)
    const task = taskThread?.thread === 'task' ? callerBot.tasks?.[taskThread.index] : undefined
    if (task === undefined || !isActiveTask(task)) return undefined
    const targetSession = threadCurrentOfPart(callerBot, work.fromPart) ?? task.sessionId
    return { callerBot, task, targetSession }
  }

  // Wakes a waiting parent work (or an active background task thread) when one of its
  // delegated children is cancelled or stopped externally, so it never hangs forever.
  function notifyParentCancelled(snapshot, { reason = '', by, bySession, byLabel = 'the user' } = {}) {
    const targetName = rt.botOf(snapshot?.to)?.name ?? snapshot?.name ?? 'the teammate'
    const label = snapshot?.ref ? ` #${snapshot.ref}` : ''
    const why = reason.trim()
    const summary = `Delegated work${label} to ${targetName} was cancelled by ${byLabel}${why ? ` (${why})` : ''}. Continue with your own work without waiting for ${targetName}.`
    if (snapshot?.parent === undefined) {
      const waitingTask = activeTaskThreadOf(snapshot)
      if (waitingTask === undefined) return Promise.resolve(false)
      const { callerBot, targetSession } = waitingTask
      if (by === callerBot.id && targetSession !== undefined && bySession === targetSession && rt.live?.get(targetSession)?.turn !== undefined) {
        return Promise.resolve(false)
      }
      return rt.deliver({
        fromId: rt.botOf(snapshot.to)?.id,
        fromName: targetName,
        toId: callerBot.id,
        ...(targetSession ? { sessionId: targetSession } : {}),
        text: summary,
        role: 'reply',
        replyTo: snapshot.id,
        ...(snapshot.ref ? { workRef: snapshot.ref } : {}),
        recordExchange: false,
        exchangeId: randomUUID(),
      }).then(() => true, (error) => {
        rt.warn('ds-bot: task continuation after cancel failed: %s', error)
        return false
      })
    }
    const parent = own(works(), snapshot.parent)
    const parentBotId = ownerBotOfWork(parent)
    if (parent === undefined || parentBotId === undefined) return Promise.resolve(false)
    const parentBot = rt.botOf(parentBotId)
    if (parentBot === undefined) return Promise.resolve(false)
    const backRoom = rt.roomOf(snapshot.fromRoom)?.sessions?.[parentBotId]
    const targetSession = backRoom
      ?? (snapshot.fromPart ? threadCurrentOfPart(parentBot, snapshot.fromPart) : undefined)
      ?? (parent.toSession ? threadCurrentOfPart(parentBot, parent.toSession) : undefined)
      ?? rt.chatOf(parentBotId)
    // If the parent Bot itself cancelled this child while actively running the same turn,
    // its current turn already knows and will finish the parent naturally when the turn ends.
    const targetLive = targetSession === undefined ? undefined : rt.live?.get(targetSession)
    const sameTurn = by === parentBotId && targetLive?.turn !== undefined && (
      bySession !== undefined
        ? bySession === targetSession
        : rt.workOf?.(targetLive.info) === snapshot.parent
    )
    if (sameTurn) return Promise.resolve(false)
    parent.results = [...(parent.results ?? []), { id: snapshot.id, name: targetName, text: headOf(summary, TEXT_KEPT), cancelled: true, at: Date.now() }]
    save()
    return rt.deliver({
      fromId: rt.botOf(snapshot.to)?.id,
      fromName: targetName,
      toId: parentBotId,
      ...(targetSession ? { sessionId: targetSession } : {}),
      text: summary,
      role: 'reply',
      replyTo: snapshot.id,
      work: snapshot.parent,
      ...(snapshot.ref ? { workRef: snapshot.ref } : {}),
      recordExchange: false,
      exchangeId: randomUUID(),
    }).then(() => true, (error) => {
      rt.warn('ds-bot: parent continuation after cancel failed: %s', error)
      return false
    })
  }

  const needInputWorksFor = (callerId) => Object.entries(works())
    .filter(([, work]) => work?.from === callerId && work.state === 'need_input')
    .map(([id, work]) => ({ id, work }))
  const openWorksBetween = (fromId, toId) => Object.entries(works())
    .filter(([, work]) => work?.from === fromId && work.to === toId && (work.state ?? 'open') !== 'closed')
    .map(([id, work]) => ({ id, work }))

  function pausedWorksView() {
    const out = []
    for (const [id, work] of Object.entries(works())) {
      if (work?.state !== 'paused' || work.paused === undefined) continue
      out.push({
        id,
        ref: work.ref ?? null,
        from: work.from ?? null,
        fromName: nameOf(work.from) ?? null,
        to: work.to ?? null,
        toName: nameOf(work.to) ?? null,
        reason: work.paused.reason,
        kind: work.paused.kind,
        goal: work.goal ?? headOf(work.paused.text ?? '', 200),
        ...(work.paused.question ? { question: headOf(work.paused.question, 200) } : {}),
        ...(work.paused.bounces !== undefined ? { bounces: work.paused.bounces } : {}),
        ...(work.paused.rounds !== undefined ? { rounds: work.paused.rounds } : {}),
        at: work.paused.at ?? work.at ?? Date.now(),
      })
    }
    return out.sort((a, b) => a.at - b.at)
  }

  const workImOrigin = (id) => {
    const work = own(works(), id)
    if (work === undefined) return undefined
    if (work.imOriginMixed === true) return { mixed: true }
    return work.imOrigin
  }

  // Merging a second unread request into an open work keeps the IM origin only when both
  // requests come from the same IM chat; mixing Web and IM or two IM chats clears it.
  function mergeWorkImOrigin(id, nextImOrigin) {
    const work = own(works(), id)
    if (work === undefined) return
    if (work.imOriginMixed === true) {
      if (work.imOrigin !== undefined) {
        delete work.imOrigin
        save()
      }
      return
    }
    const cleanNext = normalizeImOrigin(nextImOrigin)
    if (work.imOrigin === undefined && cleanNext === undefined) return
    if (!sameImOrigin(work.imOrigin, cleanNext)) {
      delete work.imOrigin
      work.imOriginMixed = true
      save()
    }
  }

  // Bounded store of IM origins for returning replies/reports, kept in state.json
  // (never in public views or Session logs) so deferred redelivery and post-restart
  // resends can still reclaim the originating IM chat.
  const IM_REPLY_ORIGINS_KEPT = 200
  const IM_REPLY_ORIGIN_TTL_MS = 24 * 60 * 60_000
  const imReplyOrigins = () => (state.imReplyOrigins ??= {})
  function rememberImReplyOrigin(id, imOrigin) {
    const isMixed = imOrigin?.mixed === true
    const cleanOrigin = isMixed ? undefined : normalizeImOrigin(imOrigin)
    if (typeof id !== 'string' || id === '' || (!isMixed && cleanOrigin === undefined)) return
    const map = imReplyOrigins()
    const now = Date.now()
    for (const [key, entry] of Object.entries(map)) {
      if (now - (entry?.at ?? 0) > IM_REPLY_ORIGIN_TTL_MS) delete map[key]
    }
    map[id] = isMixed ? { mixed: true, at: now } : { ...cleanOrigin, at: now }
    const keys = Object.keys(map)
    if (keys.length > IM_REPLY_ORIGINS_KEPT) {
      for (const old of keys.sort((a, b) => (map[a].at ?? 0) - (map[b].at ?? 0)).slice(0, keys.length - IM_REPLY_ORIGINS_KEPT)) delete map[old]
    }
    save()
  }
  function imReplyOrigin(id) {
    if (typeof id !== 'string' || id === '') return undefined
    const map = state.imReplyOrigins
    if (map === undefined || !Object.hasOwn(map, id)) return undefined
    const entry = map[id]
    if (entry === undefined) return undefined
    if (Date.now() - (entry.at ?? 0) > IM_REPLY_ORIGIN_TTL_MS) {
      delete map[id]
      save()
      return undefined
    }
    return entry
  }

  // The answer to work `id` is on its way, with `result` from `name`. Returns the work
  // it goes on with. That work keeps waiting until a turn reads the answer (`taken`).
  function closeWork(id, name, text, extra = {}) {
    const work = own(works(), id)
    if (work === undefined) return undefined
    const workWorked = work.worked === true || extra?.worked === true
    const { worked: _worked, ...storedExtra } = extra ?? {}
    delete works()[id]
    const verification = extra.verification ?? work.verification
    logTask({
      kind: 'close', id, from: work.from, to: work.to, parent: work.parent, room: work.room,
      outcome: extra.abandoned === true ? 'abandoned' : 'answered', chars: text.length,
      attemptId: work.attempt?.id, sessionId: work.attempt?.sessionId,
      ...(verification?.state === 'verified' ? { verified: true } : {}),
      ...(verification?.state === 'needs-review' ? { needsReview: true } : {}),
      ...(Number.isInteger(work.reworkCount) && work.reworkCount > 0 ? { reworks: work.reworkCount } : {}),
      ...(Array.isArray(verification?.checks) ? {
        checks: {
          total: verification.checks.length,
          verified: verification.checks.filter(check => check?.status === 'verified').length,
        },
      } : {}),
    })
    rememberClosed(id, { id, ref: work.ref, from: work.from, to: work.to, status: 'closed', at: Date.now() })
    // What it still waits for comes back to it alone.
    for (const child of Object.values(works())) if (child.parent === id) delete child.parent
    const above = own(works(), work.parent)
    if (above !== undefined) {
      // Propagate real work progress up the delegation tree so coordinating Bots
      // that delegate to workers executing real tools are not paused as idle loops.
      if (workWorked) above.worked = true
      // The whole result goes into a file of its own before the team file names it.
      const file = keepResult(id, text)
      above.results.push({ id, name, text: headOf(text, TEXT_KEPT), ...(work.child ? { child: work.child } : {}), ...(text.length > TEXT_KEPT ? { length: text.length } : {}), ...(file ? { file } : {}), at: Date.now(), ...storedExtra })
      whole.set(id, text)
    }
    for (const result of work.results ?? []) whole.delete(result.id)
    // Old state can still name these files until the replacement state lands.
    // A failed save must leave them available to the next host.
    const savedBefore = savedWrites
    void rt.save().then(() => {
      dropResults(work.results, savedBefore)
    }).catch(() => {})
    return above === undefined ? undefined : work.parent
  }
  // The subagent run a settlement notice names. The notice carries only the
  // child's id, and a child's runs end one after another, so it is the earliest
  // settled run of that child not read yet, else a run of it still out.
  const subWorkRun = (id, exclude) => {
    let settled
    let live
    for (const [workId, work] of Object.entries(works())) {
      for (const openId of work.open) {
        if (exclude?.has(openId)) continue
        const result = work.results?.find(result => result.id === openId)
        if ((result?.child ?? own(works(), openId)?.child ?? openId) !== id) continue
        if (result === undefined) live ??= { id: openId, parent: workId }
        else if (settled === undefined || (result.at ?? 0) < settled.at) settled = { id: openId, parent: workId, at: result.at ?? 0 }
      }
    }
    return settled ?? live
  }
  // A settled run is handed back like a teammate's reply: its closing text joins
  // the results of the work it hung under. `id` is the run's id, `child` the
  // child's, which named the sub-work before runs did.
  function settleSubWork(id, text, child) {
    const key = own(works(), id) !== undefined ? id : child
    const work = own(works(), key)
    if (work === undefined) {
      // The wait was already given up: the run's closing text still reaches the
      // Bot that waited, marked late, and settles nothing a second time.
      lateSubWorkResult(id, child, text)
      return undefined
    }
    const { parent } = work
    closeWork(key, work.name ?? 'subagent', text)
    return parent
  }
  // The closing text of a run whose wait was given up: delivered like a late reply,
  // and only while the Bot that waited is still on the team.
  function lateSubWorkResult(id, child, text) {
    const late = takeAbandoned(id) ?? takeAbandoned(child)
    if (late === undefined || text === '') return
    const waiting = late.waiting ?? own(works(), late.parent)?.to
    if (waiting === undefined || rt.botOf(waiting) === undefined) return
    void rt.deliver({
      fromName: late.name ?? 'the subagent', toId: waiting, text: LATE_ANSWER + text, role: 'reply',
      exchangeId: randomUUID(), recordExchange: false,
    }).catch(error => rt.warn('ds-bot: the late result of %s did not reach %s: %s', late.name ?? 'a subagent', waiting, error))
  }
  // A fast child can settle before its tool result identifies the call that made it.
  const nameSubWork = (id, name) => {
    const work = Object.entries(works()).find(([key, work]) => (work.child ?? key) === id)?.[1]
      ?? Object.values(works()).flatMap(work => work.results ?? []).find(result => (result.child ?? result.id) === id)
    if (work === undefined || work.name === name) return
    work.name = name
    save()
  }

  const dropWork = (id, { required = false } = {}) => {
    const work = own(works(), id)
    if (work === undefined) return Promise.resolve()
    const { parent } = work
    delete works()[id]
    for (const child of Object.values(works())) if (child.parent === id) delete child.parent
    const above = own(works(), parent)
    if (above !== undefined) above.open = above.open.filter(other => other !== id)
    for (const result of work.results ?? []) whole.delete(result.id)
    const savedBefore = savedWrites
    return save({ required }).then(() => {
      dropResults(work.results, savedBefore)
    })
  }

  function taken(workId, id) {
    const work = own(works(), workId)
    if (work === undefined || !work.open.includes(id)) return
    work.open = work.open.filter(other => other !== id)
    save()
  }

  // A delivery the restart delayed is marked, so the answer that comes back for
  // the work says the request only arrived then.
  function lateWork(id) {
    const work = own(works(), id)
    if (work === undefined || work.late === true) return
    work.late = true
    save()
  }

  const evidenceOf = work => (Array.isArray(work?.evidence) ? work.evidence : [])
    .filter(item => work?.attempt?.id === undefined || item.attemptId === work.attempt.id)

  const currentFingerprint = (progress, fingerprint) => ({
    ...progress,
    lastTurnFingerprint: progress?.lastTurnFingerprint ?? progress?.fingerprint ?? progressFingerprint([]),
    fingerprint,
    state: 'moving',
  })

  function ensureAttempt(id, work, now = Date.now()) {
    if (work.attempt === undefined) {
      work.attempt = { id: `${id}:a1`, n: 1, status: 'working', startedAt: now, updatedAt: now }
      work.checkpoint ??= { at: now, attemptId: work.attempt.id, kind: 'progress', summary: 'Recovered work.', nextAction: work.name ?? 'Continue the requested work.' }
      work.progress ??= { state: 'moving', fingerprint: progressFingerprint([]), lastTurnFingerprint: progressFingerprint([]), unchangedTurns: 0, changedAt: now }
      if (work.verification === undefined) {
        const required = (Array.isArray(work.checks) ? work.checks : []).filter(check => check?.required !== false)
        work.verification = required.length > 0
          ? {
              state: 'pending', status: 'pending', manual: false, checkEvidence: {}, evidenceIds: [],
              checks: required.map(check => ({ id: check.id, status: 'pending' })), missing: required.map(check => check.id),
              reason: 'Waiting for matching executed evidence for every acceptance check.',
            }
          : { state: 'pending', status: 'pending', manual: true, evidenceIds: [], checks: [], missing: [], reason: 'No typed acceptance checks were declared for this hand-off.' }
      }
      if (Array.isArray(work.checks) && work.checks.some(check => check?.required !== false)) {
        work.rework ??= []
        work.reworkCount ??= work.rework.length
        work.maxReworks ??= MAX_ACCEPTANCE_REWORKS
      }
      work.evidence ??= []
    }
    return work.attempt
  }

  const requiredChecksOf = work => (Array.isArray(work?.checks) ? work.checks : [])
    .filter(check => check?.required !== false)

  const checkText = (check) => {
    if (check?.kind === 'command') return `${check.id}: command "${check.command}" must exit ${check.expect?.exitCode ?? 0}`
    if (check?.kind === 'artifact') return `${check.id}: artifact "${check.path}" must be presented with a digest${check.expect?.digest ? ' matching the pinned digest' : ''}`
    if (check?.kind === 'diff') return `${check.id}: a diff for "${check.path}" must be executed${check.expect?.digest ? ' and match the pinned digest' : ''}`
    return String(check?.id ?? '')
  }

  const pendingAcceptance = (checks, reason, attemptId) => {
    const required = checks.filter(check => check?.required !== false)
    return {
      state: 'pending', status: 'pending', manual: false, checkEvidence: {}, evidenceIds: [],
      checks: required.map(check => ({ id: check.id, status: 'pending' })),
      missing: required.map(check => check.id), reason, attemptId,
    }
  }

  const verificationWithChecks = (work, verification) => {
    const details = new Map(requiredChecksOf(work).map(check => [check.id, check]))
    return (Array.isArray(verification?.checks) ? verification.checks : []).map((check) => {
      const detail = details.get(check.id) ?? {}
      return {
        ...detail,
        id: check.id,
        status: check.status,
        ...(check.evidenceId ? { evidenceId: check.evidenceId } : {}),
      }
    })
  }

  function markAccepted(work, verification, now) {
    const checks = verificationWithChecks(work, verification)
    const ids = new Set(Object.values(verification.checkEvidence ?? {}))
    for (const item of Array.isArray(work.evidence) ? work.evidence : []) {
      if (!ids.has(item.id)) continue
      item.trust = 'verified'
      item.kind = 'verified'
      item.verifiedAt = now
    }
    work.verification = {
      ...verification,
      state: 'verified',
      status: 'verified',
      manual: false,
      checks,
      reason: 'All required acceptance checks matched fresh executed evidence.',
      attemptId: work.attempt?.id,
    }
    if (work.attempt !== undefined) work.attempt.status = 'verified'
    work.checkpoint = {
      ...work.checkpoint,
      at: now,
      attemptId: work.attempt?.id,
      kind: 'verified',
      summary: `Acceptance verified: ${checks.filter(check => check.status === 'verified').length}/${checks.length} checks.`,
      nextAction: 'Hand the verified result back to the Bot that asked for it.',
    }
    return work.verification
  }

  function archiveAttempt(work) {
    if (work.attempt === undefined) return
    work.attempts = [...(Array.isArray(work.attempts) ? work.attempts : []), { ...work.attempt }].slice(-8)
  }

  // Decide whether an answer may close a hand-off. A typed check is evaluated against
  // executed evidence from the current attempt only. A failed check starts a new attempt
  // with the worker, instead of letting a convincing sentence close the work.
  function reviewWorkAcceptance(id, now = Date.now()) {
    const work = works()[id]
    if (work === undefined) return { kind: 'missing' }
    const checks = requiredChecksOf(work)
    if (checks.length === 0) return { kind: 'manual' }
    const verification = verifyAcceptance({ checks, evidence: evidenceOf(work), now })
    if (verification.state === 'verified') {
      return { kind: 'verified', verification: markAccepted(work, verification, now), reworks: work.reworkCount ?? 0 }
    }
    const missing = Array.isArray(verification.missing) && verification.missing.length > 0
      ? verification.missing.map((checkId) => checkText(checks.find(check => check.id === checkId))).join('; ')
      : 'required executed evidence is missing'
    const maxReworks = Number.isInteger(work.maxReworks) ? work.maxReworks : MAX_ACCEPTANCE_REWORKS
    const reworks = Number.isInteger(work.reworkCount) ? work.reworkCount : 0
    if (reworks < maxReworks) {
      const previous = work.attempt
      archiveAttempt(work)
      const next = {
        id: `${id}:a${(previous?.n ?? 1) + 1}`,
        n: (previous?.n ?? 1) + 1,
        status: 'working',
        startedAt: now,
        updatedAt: now,
      }
      const feedback = headOf(`Acceptance check failed: ${missing}. Run the required check again and leave executed evidence that matches the declaration.`, REWORK_TEXT_MAX)
      work.attempt = next
      work.reworkCount = reworks + 1
      work.rework = [...(Array.isArray(work.rework) ? work.rework : []), {
        at: now,
        attemptId: next.id,
        previousAttemptId: previous?.id,
        missing: verification.missing ?? [],
        feedback,
      }].slice(-8)
      work.verification = pendingAcceptance(checks, feedback, next.id)
      work.progress = {
        state: 'moving', fingerprint: progressFingerprint([]), lastTurnFingerprint: progressFingerprint([]),
        unchangedTurns: 0, changedAt: now,
      }
      work.checkpoint = {
        at: now, attemptId: next.id, kind: 'rework', summary: feedback,
        nextAction: 'Run the failed acceptance check and leave fresh executed evidence.',
      }
      delete work.held
      const fromName = nameOf(work.from) ?? 'the Bot that asked'
      const reworkText = headOf(
        `[Acceptance check failed · attempt ${next.n} of ${maxReworks + 1}]\nThis work is still open; do not send it back to ${fromName} yet.\n\n${feedback}`,
        REWORK_TEXT_MAX,
      )
      return {
        kind: 'rework',
        verification: work.verification,
        persist: () => save({ required: true })
          .then(() => rt.deliver({
            fromId: work.from,
            fromName,
            toId: work.to,
            text: reworkText,
            role: 'request',
            exchangeId: id,
            taskId: `handoff:${id}`,
            attemptId: next.id,
            recordExchange: false,
          }))
          .catch((error) => {
            noteRecoveryNeeded(work, {
              attemptId: next.id,
              reason: 'The acceptance rework could not be delivered after the check failed; recover this work before accepting it.',
            })
            save()
            throw error
          }),
      }
    }
    const reason = headOf(`Acceptance was not met after ${reworks} rework${reworks === 1 ? '' : 's'}: ${missing}.`, REWORK_TEXT_MAX)
    work.verification = {
      ...verification,
      state: 'needs-review',
      status: 'needs-review',
      manual: false,
      checks: verificationWithChecks(work, verification),
      reason,
      attemptId: work.attempt?.id,
    }
    if (work.attempt !== undefined) work.attempt.status = 'needs-review'
    work.checkpoint = {
      at: now, attemptId: work.attempt?.id, kind: 'needs-review', summary: reason,
      nextAction: 'Report the acceptance failure; start a new hand-off if the work should be tried again.',
    }
    return { kind: 'needs-review', verification: work.verification, reworks, text: reason }
  }

  // A message that joined an unread request can add or replace its acceptance
  // declaration before the receiver starts. The new declaration is the one the
  // receiver sees in the joined text, so it is also the one the host must enforce.
  function setWorkAcceptance(id, checks = [], acceptance = '') {
    const work = works()[id]
    if (work === undefined) return Promise.resolve(false)
    if (Array.isArray(checks) && checks.length > 0) {
      work.checks = checks
      work.verification = pendingAcceptance(checks, 'Waiting for matching executed evidence for every acceptance check.', work.attempt?.id)
      work.rework = []
      work.reworkCount = 0
      work.maxReworks = MAX_ACCEPTANCE_REWORKS
    }
    if (acceptance !== '') work.acceptance = acceptance
    return save({ required: true }).then(() => true)
  }

  // A failed or stopped worker did not produce a result to verify. Do not spend two
  // reworks on an infrastructure failure: keep the honest needs-review state and let
  // the asker decide whether to retry.
  function rejectWorkAcceptance(id, reason, now = Date.now()) {
    const work = works()[id]
    const checks = requiredChecksOf(work)
    if (work === undefined || checks.length === 0) return undefined
    const previous = work.verification ?? {}
    const checkDetails = verificationWithChecks(work, previous)
    work.verification = {
      ...previous,
      state: 'needs-review', status: 'needs-review', manual: false,
      checks: checkDetails.length > 0 ? checkDetails : checks.map(check => ({ ...check, status: 'pending' })),
      missing: Array.isArray(previous.missing) && previous.missing.length > 0 ? previous.missing : checks.map(check => check.id),
      reason,
      attemptId: work.attempt?.id,
    }
    if (work.attempt !== undefined) work.attempt.status = 'needs-review'
    work.checkpoint = {
      at: now, attemptId: work.attempt?.id, kind: 'needs-review', summary: reason,
      nextAction: 'Report the failure; start a new hand-off if the work should be tried again.',
    }
    return { kind: 'needs-review', verification: work.verification, text: reason }
  }

  function workForSession(info) {
    const id = workOf(info)
    const work = id === undefined ? undefined : works()[id]
    return work === undefined ? undefined : { id, work }
  }

  function noteEvidence(sessionId, event, info, now = Date.now()) {
    if (rt.readOnly?.() !== undefined) return false
    const callId = String(event?.data?.callId ?? '')
    if (event?.type === 'tool/call' && callId !== '') {
      callsBySession.remember(sessionId, callId, {
        seq: Number.isInteger(event.seq) ? event.seq - 1 : 0,
        type: 'tool/call',
        time: event.time,
        data: event.data,
      })
      return false
    }
    const events = []
    if (event?.type === 'tool/result') {
      const call = callsBySession.take(sessionId, callId)
      if (call !== undefined) events.push(call)
    }
    events.push(event)
    const evidence = evidenceFromEvents({ sessionId, actor: { sessionId }, events })
    if (evidence.length === 0) return false
    const target = workForSession(info)
    if (target === undefined) return false
    const { work } = target
    ensureAttempt(target.id, work, now)
    const tagged = evidence.map(item => ({ ...item, attemptId: work.attempt.id }))
    const known = new Set((Array.isArray(work.evidence) ? work.evidence : []).map(item => item.id))
    const added = tagged.filter(item => !known.has(item.id))
    if (added.length === 0) return false
    work.evidence = [...(Array.isArray(work.evidence) ? work.evidence : []), ...added].slice(-64)
    const last = added.at(-1)
    work.checkpoint = {
      at: now,
      attemptId: work.attempt.id,
      kind: last.state,
      summary: last.command?.text ?? last.artifact?.path ?? last.diff?.paths?.join(', ') ?? headOf(last.summary, TEXT_KEPT),
      nextAction: work.name ?? 'Continue the requested work.',
      sessionId,
      evidenceId: last.id,
      progressFingerprint: progressFingerprint(evidenceOf(work)),
    }
    work.attempt.updatedAt = now
    work.progress = currentFingerprint(work.progress, work.checkpoint.progressFingerprint)
    save()
    return true
  }

  function bindAttempt(sessionId, info, turn) {
    if (rt.readOnly?.() !== undefined) return undefined
    const target = workForSession(info)
    if (target === undefined) return undefined
    const now = Date.now()
    ensureAttempt(target.id, target.work, now)
    target.work.attempt.sessionId = sessionId
    if (info?.exchangeId !== undefined) target.work.attempt.exchangeId = info.exchangeId
    if (Number.isInteger(turn)) target.work.attempt.turn = turn
    target.work.attempt.updatedAt = now
    noteAttemptRecovery(target.work, { attemptId: target.work.attempt.id, info, sessionId, now })
    save()
    return { taskId: `handoff:${target.id}`, attemptId: target.work.attempt.id }
  }

  const binding = id => works()[id]?.attempt === undefined ? undefined : {
    taskId: `handoff:${id}`,
    attemptId: works()[id].attempt.id,
  }

  function finishTurn(sessionId, info, outcome = 'completed') {
    callsBySession.clearSession(sessionId)
    if (rt.readOnly?.() !== undefined || outcome !== 'completed') return false
    const target = workForSession(info)
    if (target === undefined) return false
    const now = Date.now()
    ensureAttempt(target.id, target.work, now)
    target.work.progress = progressAfterTurn(target.work.progress, evidenceOf(target.work), { now })
    if (target.work.progress.state === 'stalled') {
      target.work.verification = { state: 'needs-review', status: 'needs-review', reason: 'Two completed turns produced no new diff, command, artifact, or evidence.', missing: [] }
      target.work.checkpoint = { at: now, attemptId: target.work.attempt.id, kind: 'reported', summary: 'No measurable progress in repeated turns.', nextAction: 'Change the approach or report a blocker; do not repeat the same work.', sessionId }
      target.work.attempt.status = 'stalled'
      target.work.attempt.updatedAt = now
      save()
      return true
    }
    target.work.attempt.updatedAt = now
    save()
    return false
  }

  function reconcileEvidence(sessionId, events, trigger) {
    if (rt.readOnly?.() !== undefined || !Array.isArray(events) || events.length === 0) return false
    const taskId = String(trigger?.taskId ?? '')
    const id = taskId.startsWith('handoff:') ? taskId.slice('handoff:'.length) : String(trigger?.work ?? '') || undefined
    const work = id === undefined ? undefined : works()[id]
    if (work === undefined || (trigger?.attemptId !== undefined && work.attempt?.id !== trigger.attemptId)) return false
    ensureAttempt(id, work)
    const turns = new Set()
    let turn
    for (const event of events) {
      if (event.type === 'turn/start' && Number.isInteger(event.data?.turn)) turn = event.data.turn
      else if (Number.isInteger(event.data?.turn)) turn = event.data.turn
      if (event.type !== 'user/message') continue
      const source = event.data?.source ?? {}
      if ((trigger?.exchangeId === undefined || source.exchangeId === trigger.exchangeId)
        && (trigger?.taskId === undefined || source.taskId === trigger.taskId)
        && (trigger?.attemptId === undefined || source.attemptId === trigger.attemptId)
        && Number.isInteger(turn)) turns.add(turn)
    }
    if (turns.size === 0) {
      noteRecoveryNeeded(work, {
        attemptId: work.attempt?.id,
        sessionId,
        reason: 'Session events could not be matched to this hand-off attempt after a restart; recover it before accepting the result.',
      })
      save()
      return false
    }
    const scoped = events.filter(event => Number.isInteger(event.data?.turn) && turns.has(event.data.turn))
    const evidence = evidenceFromEvents({ sessionId, actor: { sessionId }, events: scoped })
      .map(item => ({ ...item, attemptId: work.attempt.id }))
    const known = new Set((Array.isArray(work.evidence) ? work.evidence : []).map(item => item.id))
    const added = evidence.filter(item => !known.has(item.id))
    if (added.length === 0) return false
    clearRecoveryNeeded(work)
    work.evidence = [...(Array.isArray(work.evidence) ? work.evidence : []), ...added].slice(-64)
    const last = added.at(-1)
    work.checkpoint = {
      at: last.at ?? Date.now(),
      attemptId: work.attempt.id,
      kind: last.state,
      summary: last.command?.text ?? last.artifact?.path ?? last.diff?.paths?.join(', ') ?? headOf(last.summary, TEXT_KEPT),
      nextAction: work.name ?? 'Continue the requested work.',
      sessionId,
      evidenceId: last.id,
      progressFingerprint: progressFingerprint(evidenceOf(work)),
    }
    work.progress = currentFingerprint(work.progress, work.checkpoint.progressFingerprint)
    save()
    return true
  }

  // The reply carrying a result never reached the asker: the failure reaches it
  // as an input instead (turns.js), which ends the wait when it is read like any
  // reply. The result kept with the work it was for is marked, so the answer
  // that goes up names it.
  function answerMissed(id) {
    for (const work of Object.values(works())) {
      if (!work.open.includes(id)) continue
      const result = (work.results ?? []).find(item => item.id === id)
      if (result !== undefined) result.failed = true
      save()
      return
    }
  }

  const owns = (botId, workId) => workId !== undefined && own(works(), workId)?.to === botId
  const waits = workId => (own(works(), workId)?.open.length ?? 0) > 0
  function hold(workId, text) {
    const work = own(works(), workId)
    if (work === undefined || text === '') return
    work.held = headOf(text, TEXT_KEPT)
    save()
  }
  // Who asked for the work, as the turn that answers a request sees its trigger.
  const askedBy = workId => {
    const work = own(works(), workId)
    return work === undefined ? undefined : { kind: 'bot', role: 'request', exchangeId: workId, ...(work.ref ? { workRef: work.ref } : {}), senderSessionId: work.from, ...(work.fromPart ? { senderPart: work.fromPart } : {}), ...(work.fromRoom ? { senderRoomId: work.fromRoom } : {}) }
  }
  // The answer that goes up: what the Bot said last for this work, then what came back.
  function answerText(workId, reply, botName) {
    const work = own(works(), workId)
    const said = reply !== '' ? reply : work?.held ?? ''
    const results = (work?.results ?? []).map(result => {
      const { text, whole } = resultText(result)
      const cut = whole ? '' : `\n[cut; ${result.length} characters in all, the rest was not kept]`
      if (result.failed === true) return `${result.name} could not send its reply to you; what it had answered:\n${text}${cut}`
      return `${result.name}:\n${text}${cut}`
    })
    const body = results.length === 0 ? said || `${botName} finished without a reply.`
      : [said || `${botName} finished and wrote nothing more.`, `[Handed back to ${botName} for this work]`, ...results].join('\n\n')
    // The request reached its target only after a restart; the answer says so.
    return work?.late === true ? `[This request reached ${botName} only after DeepSeek Harness restarted.]\n\n${body}` : body
  }

  // The Bots waiting for the result of these works: whoever asked for each, and on up.
  function upstreamOf(workIds) {
    const bots = new Set()
    for (const workId of workIds) {
      const seen = new Set()
      for (let id = workId; id !== undefined && !seen.has(id) && own(works(), id) !== undefined; id = own(works(), id).parent) {
        seen.add(id)
        if (own(works(), id).from) bots.add(own(works(), id).from)
      }
    }
    return bots
  }

  // Two requests from one sender belong to the same work when they were sent for it.
  const sameWork = (id, parent) => (own(works(), id)?.parent ?? undefined) === (own(works(), parent) === undefined ? undefined : parent)

  // The works their Bots wait on, outside a turn that does them (`busy`): each with what
  // it handed on that has not come back yet. One that came back waits only to be read.
  const held = busy => Object.entries(works())
    .filter(([id, work]) => ownerBotOfWork(work) !== undefined && work.open.length > 0 && !busy.has(id))
    .map(([id, work]) => ({ id, work, out: work.open.map(childId => ({ id: childId, work: own(works(), childId) })).filter(child => child.work !== undefined) }))
  const busyWith = sessionIds => {
    const active = new Set()
    for (const sessionId of sessionIds) {
      const entry = rt.live.get(sessionId)
      if (entry?.turn === undefined) continue
      const primary = workOf(entry.info)
      if (primary) active.add(primary)
      const taskWork = rt.taskBySession?.(sessionId)?.task?.workId
      if (taskWork) active.add(taskWork)
    }
    return active
  }

  // Per Bot, the Bots and groups it waits for, and the Bots it does that work for.
  function waitingView() {
    const view = {}
    const add = (list, id) => { if (id !== undefined && !list.includes(id)) list.push(id) }
    for (const { work, out } of held(busyWith([...rt.live.keys()]))) {
      if (out.length === 0) continue
      const owner = ownerBotOfWork(work)
      const entry = view[owner] ??= { bots: [], rooms: [], for: [], waits: [] }
      for (const { id, work: child } of out) {
        add(child.room ? entry.rooms : entry.bots, child.room ?? child.to)
        entry.waits.push({ id, ...(child.room ? { room: child.room, name: rt.roomOf(child.room)?.name } : { to: child.to, name: nameOf(child.to) ?? child.name }) })
      }
      const asker = rootAsker(work)
      if (asker !== owner) add(entry.for, asker)
    }
    return view
  }

  // Works whose wait was given up, kept so a reply that arrives afterwards is known
  // for a late answer instead of a new one. Small: a reply uses one up, and only the
  // newest are kept.
  const ABANDONED_KEPT = 100
  const abandonedWorks = () => (state.abandonedWorks ??= {})
  function rememberAbandoned(id, entry) {
    if (!safeKey(id)) return
    const map = abandonedWorks()
    map[id] = entry
    const ids = Object.keys(map)
    if (ids.length > ABANDONED_KEPT) {
      for (const old of ids.sort((a, b) => (map[a].at ?? 0) - (map[b].at ?? 0)).slice(0, ids.length - ABANDONED_KEPT)) delete map[old]
    }
    save()
  }
  // The abandoned wait a late reply is for, if any. One reply only: the note is used up.
  function takeAbandoned(id) {
    const map = abandonedWorks()
    const entry = own(map, id)
    if (entry === undefined) return undefined
    delete map[id]
    save()
    return entry
  }
  const cap = text => text.charAt(0).toUpperCase() + text.slice(1)
  const labelOfWork = work => (work.room !== undefined
    ? `the group chat "${rt.roomOf(work.room)?.name ?? 'a group chat'}"`
    : nameOf(work.to) ?? work.name ?? 'the other Bot')

  // Giving up one wait: the sub-work closes with an explicit result that says no reply
  // came back, so the work above it goes on. Only this branch settles; the parent's
  // other open works stay. `gone` is the startup sweep whose target no longer exists;
  // `restart` is startup reconciliation of an orphaned leaf work with no active turn.
  function abandonWork(id, reason = 'user') {
    const work = own(works(), id)
    if (work === undefined) return false
    const parent = work.parent === undefined ? undefined : own(works(), work.parent)
    const waitingParent = parent !== undefined && parent.open.includes(id) ? parent : undefined
    const waitingTask = waitingParent === undefined && work.parent === undefined ? activeTaskThreadOf(work) : undefined
    if (waitingParent === undefined && waitingTask === undefined) {
      if (reason !== 'restart' || work.parent !== undefined) return false
    }
    const target = labelOfWork(work)
    const name = rt.botOf(work.to)?.name ?? work.name ?? (work.room !== undefined ? rt.roomOf(work.room)?.name : undefined) ?? 'the other Bot'
    const tag = work.ref ? ` #${work.ref}` : ''
    const text = reason === 'gone'
      ? cap(target) + ' is no longer on the team, so no reply can come back for the work handed to it. The user gave up waiting for that answer: this counts as its result. Go on with the work you were given, and say plainly that this answer is missing.'
      : reason === 'restart'
        ? `Work${tag} handed to ${target} did not complete before DeepSeek Harness restarted and has no active turn remaining. This counts as its result: go on with the work you were given, and say plainly that this answer is missing.`
        : 'No reply came back from ' + target + ', and the user gave up waiting for it. This counts as its result: go on with the work you were given, and say plainly that this answer is missing.'
    const origin = workImOrigin(id)
    if (origin !== undefined) rememberImReplyOrigin(id, origin)
    if (reason === 'gone') rt.dropRoomReport?.(id)
    const waitingBot = waitingParent !== undefined ? ownerBotOfWork(waitingParent) : waitingTask !== undefined ? waitingTask.callerBot.id : work.from
    rememberAbandoned(id, { at: Date.now(), from: work.from, to: work.to, room: work.room, ...(work.parent !== undefined ? { parent: work.parent } : {}), name, reason, ...(waitingBot !== undefined ? { waiting: waitingBot } : {}) })
    closeWork(id, name, text, { abandoned: true, abandonedAt: Date.now(), abandonedReason: reason })
    // The wait is over now, not when the Bot next reads the result.
    if (waitingParent !== undefined) waitingParent.open = waitingParent.open.filter(other => other !== id)
    save()
    // The Bot that waited goes on with its work now, the same way a reply brings it back.
    if (waitingBot !== undefined && rt.botOf(waitingBot) !== undefined) {
      const said = reason === 'gone'
        ? target + ' is no longer on the team, so the work you handed it has no answer. The user gave up waiting for it; this is its result. Go on with the work you were given.'
        : reason === 'restart'
          ? (waitingParent !== undefined || waitingTask !== undefined
            ? `Work${tag} handed to ${target} did not complete before DeepSeek Harness restarted and has no active turn remaining. This is its result: go on with the work you were given.`
            : `Work${tag} handed to ${target} did not complete before DeepSeek Harness restarted and has no active turn remaining. Tell the user or delegate again if needed.`)
          : 'No reply came back from ' + target + ', and the user gave up waiting for it. This is its result: go on with the work you were given.'
      const backRoom = rt.roomOf(work.fromRoom)?.sessions?.[waitingBot]
      const targetSession = waitingParent !== undefined
        ? (backRoom
          ?? (work.fromPart === undefined ? undefined : threadCurrentOfPart(rt.botOf(waitingBot), work.fromPart))
          ?? (waitingParent.toSession === undefined ? undefined : threadCurrentOfPart(rt.botOf(waitingBot), waitingParent.toSession)))
        : waitingTask !== undefined
          ? waitingTask.targetSession
          : (backRoom
            ?? (work.fromPart === undefined ? undefined : threadCurrentOfPart(rt.botOf(waitingBot), work.fromPart))
            ?? rt.chatOf(waitingBot))
      void rt.deliver({
        fromId: work.to !== undefined && rt.botOf(work.to) !== undefined ? work.to : undefined,
        fromName: name, toId: waitingBot, ...(targetSession ? { sessionId: targetSession } : {}), text: said, role: 'reply', replyTo: id,
        exchangeId: randomUUID(), ...(waitingParent !== undefined ? { work: work.parent } : {}), ...(work.ref ? { workRef: work.ref } : {}), abandoned: true, ...(reason === 'restart' ? { abandonedReason: 'restart' } : {}), recordExchange: false,
      }).catch(error => rt.warn('ds-bot: giving up the wait for %s was not delivered: %s', waitingBot, error))
    }
    return true
  }

  // A restart settles the waits whose target no longer exists, with the same path as a
  // user giving up: a deleted Bot or a deleted group. Those are the targets the team
  // file states for certain. A subagent run is left to the menu: whether its Session
  // still exists cannot be told apart from a DSH that cannot read Sessions, and a
  // running child must not be given up on a guess.
  function reconcileLostWorks() {
    if (rt.readOnly?.() !== undefined) return
    for (const [id, work] of Object.entries(works())) {
      if (work?.state === 'paused') {
        const targetGone = work.to !== undefined && rt.botOf(work.to) === undefined
        const senderGone = work.from !== undefined && rt.botOf(work.from) === undefined
        const canAbandon = targetGone && !senderGone
          && ((work.parent !== undefined && own(works(), work.parent)?.open?.includes(id))
            || (work.parent === undefined && activeTaskThreadOf(work) !== undefined))
        if (canAbandon) {
          abandonWork(id, 'gone')
        } else if (targetGone || senderGone) {
          dropWork(id)
        }
        continue
      }
      const hasWaitingParent = work.parent !== undefined && own(works(), work.parent)?.open?.includes(id) === true
      const hasWaitingTask = work.parent === undefined && activeTaskThreadOf(work) !== undefined
      if (!hasWaitingParent && !hasWaitingTask) continue
      const gone = work.room !== undefined ? rt.roomOf(work.room) === undefined
        : work.to !== undefined ? rt.botOf(work.to) === undefined
          : false
      if (gone) abandonWork(id, 'gone')
    }
  }
  const offAdopted = rt.onAdopted?.(() => whole.clear())
  // A host without a context (the narrow tests) has no startup to reconcile. The sweep
  // waits a tick: the team file loads through every module's own setup, and this module
  // is installed before the ones that load it.
  ctx?.effect?.(() => {
    const timer = setTimeout(() => {
      void rt.load()
        .then(() => {
          reconcileLostWorks()
          rt.pruneOrphanRequests?.()
          return pruneOrphanResultFiles()
        })
        .catch(error => rt.warn('ds-bot: lost waits not settled: %s', error))
    }, 0)
    return () => {
      clearTimeout(timer)
      offAdopted?.()
      whole.clear()
    }
  }, 'ds-bot: lost hand-offs')

  // A deleted Bot answers no more work and waits for none.
  function forgetBot(botId, { onOutgoing } = {}) {
    resetBotLoops(botId)
    const waiting = Object.entries(works()).filter(([, work]) => work.to === botId && work.state !== 'paused').map(([id]) => askedBy(id))
    const outgoing = []
    for (const [id, work] of Object.entries(works())) {
      if (work.to === botId && work.state === 'paused') {
        const parent = work.parent === undefined ? undefined : own(works(), work.parent)
        const wakesParent = parent !== undefined && ownerBotOfWork(parent) !== botId && parent.open.includes(id)
        const wakesTask = work.parent === undefined && work.from !== botId && activeTaskThreadOf(work) !== undefined
        if (wakesParent || wakesTask) {
          abandonWork(id, 'gone')
        } else {
          dropWork(id)
        }
      } else if (work.from === botId && work.to !== botId) {
        if (typeof onOutgoing === 'function') {
          const snapshot = cancelWork(id, { by: botId, reason: 'The calling Bot was deleted.' })
          if (snapshot !== undefined) outgoing.push(snapshot)
        } else {
          dropWork(id)
        }
      }
    }
    if (typeof onOutgoing === 'function') onOutgoing(outgoing)
    return waiting
  }

  // What a Bot is doing, in one line for the Bots that work with it.
  function statusOf(botId) {
    const chat = rt.chatOf(botId)
    // A Bot's own chat may keep parts running in the background, as its group Sessions
    // may run: a Bot working there is not idle, and the line says where.
    const bot = rt.botOf(botId)
    const own = bot === undefined ? [chat] : ownChatSessions(bot)
    const sessions = [...new Set([...own, ...(rt.groupSessionsOf?.(botId) ?? [])])]
    const place = sessionId => {
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      if (room) return `in group "${room.name}"`
      const task = rt.taskBySession?.(sessionId)?.task
      if (task !== undefined) return `in background task "${task.title}"`
      return 'in its own chat'
    }
    const forWhom = (sessionId, info) => {
      if (rt.groupOwners.has(sessionId)) return info?.askedBy && nameOf(info.askedBy) ? `, for ${nameOf(info.askedBy)}` : ''
      const asker = info?.role === 'request' || info?.role === 'stopped' ? info.senderSessionId : Object.hasOwn(works(), String(workOf(info) ?? '')) ? works()[workOf(info)]?.from : undefined
      if (asker !== undefined) return nameOf(asker) ? `, for ${nameOf(asker)}` : ''
      return info === undefined ? ', for the user' : ''
    }
    const doing = (entry) => {
      const what = rt.doingOf?.(entry) ?? {}
      if (what.tool) return `: running ${what.tool}${what.target ? ` on ${what.target}` : ''}`
      return what.said ? `: "${what.said.slice(0, 100)}"` : ''
    }
    const lines = []
    const approval = (rt.approvalsView?.() ?? []).find(entry => entry.botId === botId)
    const switching = [...(rt.switchJobs?.() ?? [])].find(job => job.botId === botId)
    const running = sessions.filter(sessionId => rt.live.get(sessionId)?.turn !== undefined)
    if (approval !== undefined) lines.push(`waiting for the user's approval to run ${approval.tool || 'a tool'} ${place(approval.sessionId)} (${minutes(approval.at)})`)
    else if (switching !== undefined) lines.push(`moving on to a fresh part of its ${switching.roomId ? `conversation in group "${rt.roomOf(switching.roomId)?.name ?? '?'}"` : 'own chat'}`)
    for (const sessionId of approval === undefined && switching === undefined ? running : []) {
      const entry = rt.live.get(sessionId)
      lines.push(`working ${place(sessionId)} ${minutes(entry.since ?? Date.now())}${forWhom(sessionId, entry.info)}${doing(entry)}`)
    }
    for (const { work, out } of held(busyWith(running))) {
      if (ownerBotOfWork(work) !== botId) continue
      const asker = rootAsker(work)
      const forName = asker !== botId && nameOf(asker) ? `, for ${nameOf(asker)}` : ''
      const on = [...new Set(out.map(({ work: child }) => (child.room ? `group "${rt.roomOf(child.room)?.name ?? 'a group'}"` : child.name ?? nameOf(child.to) ?? 'a teammate')))]
      lines.push(on.length > 0 ? `waiting for ${on.join(' and ')} to hand back work${forName}` : `about to go on with work${forName}, whose results came back`)
    }
    for (const [id, work] of Object.entries(works())) {
      if (work?.state === 'need_input' && work.to === botId) {
        lines.push(`waiting for ${nameOf(work.from) ?? 'the caller'} to answer a question on ${work.ref ?? id}`)
      } else if (work?.state === 'paused' && (work.from === botId || work.to === botId)) {
        const peer = work.from === botId ? (nameOf(work.to) ?? 'a teammate') : (nameOf(work.from) ?? 'a teammate')
        lines.push(`paused work ${work.ref ?? id} with ${peer} (waiting for the user to continue or cancel)`)
      }
    }
    if (lines.length === 0) lines.push('idle')
    for (const [kind, card] of [['question', state.questions?.[chat]], ['view', state.views?.[chat]]]) {
      if (card !== undefined) lines.push(`a ${kind} card in its own chat has waited for the user's answer ${forHowLong(card.askedAt)}`)
    }
    const unread = new Map()
    for (const args of rt.unreadOf?.(chat) ?? []) {
      const name = nameOf(args.fromId)
      if (name !== undefined) unread.set(name, (unread.get(name) ?? 0) + 1)
    }
    if (unread.size > 0) lines.push(`not read yet: ${[...unread].map(([name, count]) => `${count} from ${name}`).join(', ')}`)
    return lines.join('; ')
  }

  Object.assign(rt, {
    workOf, openWork, setWorkTargetSession, closeWork, dropWork, takenWork: taken, lateWork, answerMissed,
    ownsWork: owns, waitsWork: waits, holdWork: hold, workAsker: askedBy,
    workImOrigin, mergeWorkImOrigin, rememberImReplyOrigin, imReplyOrigin,
    answerText, upstreamOf, sameWork, forgetBotWork: forgetBot, statusOf, waitingView,
    settleSubWork, subWorkRun, nameSubWork, abandonWork, abandonedWork: takeAbandoned,
    resolveWork, closedWorkOf, workRefOf, workStateOf, markWorkWorked,
    askBackWork, answerWork, cancelWork, notifyParentCancelled, needInputWorksFor, openWorksBetween,
    noteWorkCompleted, checkPairLoop, resetPairLoop, resetBotLoops, pausedWorksView,
    workBinding: binding, noteWorkEvidence: noteEvidence, bindWorkAttempt: bindAttempt, finishWorkTurn: finishTurn,
    reconcileWorkEvidence: reconcileEvidence, reviewWorkAcceptance, setWorkAcceptance, rejectWorkAcceptance,
  })
}
