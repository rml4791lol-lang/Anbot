// Resume: Bot work that DeepSeek Harness dropped when it closed or restarted. DSH closes
// a turn it never finished as interrupted when the Session next opens, and a clean
// shutdown also cancels the messages still waiting in a Session's inbox; nothing would
// ever run either again, and whoever waited for them was not told. DS Bot notes each
// running Bot turn and each message it delivers until a turn takes it up, in
// inflight.json; what is still noted at the next start is picked up once.
//
// A turn that ends while DS Bot is not watching it (the plugin reloaded, DSH went on)
// is settled from the Session's durable log: an answer that was produced goes to the Bot
// that waits for it, and an outcome that cannot be read is said to be unknown. The
// request itself is never sent again there.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HISTORY_TIMEOUT_MS, MESSAGE_INLINE_MAX, SOURCE_KIND, STEER_CUT } from './constants.js'
import { replaceFile } from './files.js'
import { answerSender, cutOffText, failureLine, turnFailure } from './turns.js'
import { textOf } from './text.js'

// Long enough for DSH to finish opening its workspaces after a start.
export const RESUME_DELAY_MS = 3000

export const resumeText = record => [
  'DeepSeek Harness restarted while you were working on this, so your last turn stopped before it finished.',
  record.approval ? `You were waiting for the user's approval to run ${record.approval.tool || 'a tool'}${record.approval.reason ? ` (${record.approval.reason})` : ''}; that request is gone, so ask again if you still need it.` : '',
  'Check what is already done (files, commands, messages) before you repeat anything, then finish the task and give your reply.',
].filter(Boolean).join(' ')

// The turns of a Session's durable log, each with the exchanges it took up, what it
// said and how it ended.
export function turnsOf(events) {
  const turns = []
  let current
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data?.turn, took: [], texts: [], reason: undefined }
      turns.push(current)
      continue
    }
    if (current === undefined) continue
    if (event.type === 'step/start') {
      current.stepFrom = current.texts.length
      continue
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.exchangeId !== undefined) current.took.push(source)
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') current.texts.push(text)
      continue
    }
    if (event.type === 'turn/end') current.reason = event.data?.reason
  }
  return turns
}

// The last turn that took up an exchange: what it said and how it ended. A turn cut
// by a user steer keeps going in the turn that starts right after it, so the reason
// that counts is the continuation's.
export function turnOf(events, exchangeId) {
  const turns = turnsOf(events)
  const steerCut = turn => turn?.reason?.kind === 'aborted'
    && turn.reason.reason?.kind === 'hook'
    && turn.reason.reason?.reason === STEER_CUT
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    if (!turns[at].took.some(source => source.exchangeId === exchangeId)) continue
    let found = turns[at]
    let next = at + 1
    // A steer cut lands inside a step's model call, so the cut turn's last step left
    // an interrupted draft: texts before the last step/start stay, the rest is a
    // fragment the continuation replaces.
    const finished = turn => turn.texts.slice(0, turn.stepFrom ?? turn.texts.length)
    while (steerCut(found) && next < turns.length) {
      const follow = turns[next]
      const kept = finished(found)
      found = { ...follow, took: [...found.took, ...follow.took], texts: [...kept, ...follow.texts], stepFrom: kept.length + (follow.stepFrom ?? follow.texts.length) }
      next += 1
    }
    return steerCut(found) ? { ...found, texts: finished(found), reason: undefined } : found
  }
  return undefined
}

// Whether a Session already holds the answer to an exchange.
export function answeredIn(events, exchangeId) {
  return events.some(event => event.type === 'user/message' && event.data?.source?.replyTo === exchangeId)
}

// The trigger fields a resumed turn needs to answer the same sender.
const triggerOf = info => ({
  role: info.role,
  ...(info.exchangeId ? { exchangeId: info.exchangeId } : {}),
  ...(info.senderSessionId ? { senderSessionId: info.senderSessionId } : {}),
  ...(info.roomId ? { roomId: info.roomId } : {}),
  ...(info.work ? { work: info.work } : {}),
  ...(info.taskId ? { taskId: info.taskId } : {}),
  ...(info.attemptId ? { attemptId: info.attemptId } : {}),
  ...(info.audience ? { audience: info.audience } : {}),
  ...(info.askedBy ? { askedBy: info.askedBy } : {}),
  ...(info.senderRoomId ? { senderRoomId: info.senderRoomId } : {}),
})

// The notes are the only record of a turn or a delivery that was on its way: a file
// that cannot be read is kept, never written over, since it may still be read by hand.
const keepAside = (file, reason, warn) => {
  let aside = `${file}.corrupt-${Date.now()}`
  for (let at = 1; existsSync(aside); at += 1) aside = `${file}.corrupt-${Date.now()}-${at}`
  try {
    renameSync(file, aside)
  } catch (error) {
    warn('ds-bot: %s could not be read (%s), and it could not be kept aside: %s', file, reason, error)
    return
  }
  warn('ds-bot: %s could not be read (%s); it was kept as %s', file, reason, aside)
}

// What the last run left: the turns it was running and the messages it was delivering.
export const readNotes = (file, warn = () => {}) => {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    // A start with no notes is a start with nothing to pick up.
    if (error?.code !== 'ENOENT') warn('ds-bot: %s could not be read: %s', file, error)
    return { turns: {}, queued: {} }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    keepAside(file, error.message, warn)
    return { turns: {}, queued: {} }
  }
  const object = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    keepAside(file, 'it holds no JSON object', warn)
    return { turns: {}, queued: {} }
  }
  // A member that is not an object is a note that cannot be read: writing over it would
  // lose what the last run was doing. An absent member is a start with nothing there.
  const member = value => value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value))
  if (!member(parsed.turns) || !member(parsed.queued)) {
    keepAside(file, 'a member holds no JSON object', warn)
    return { turns: {}, queued: {} }
  }
  return { turns: object(parsed.turns), queued: object(parsed.queued) }
}

// Replaced whole: written beside the file and moved over it, so a kill part way through
// leaves the last whole notes in place instead of half of the new ones.
export const writeNotes = async (file, snapshot) => {
  const temp = `${file}.${process.pid}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temp, snapshot, 'utf8')
    await replaceFile(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

export function install(rt) {
  const { ctx, home } = rt
  const file = join(home, 'inflight.json')

  // What the last run left; read before this run notes anything.
  let interrupted = readNotes(file, rt.warn)

  /** @type {Record<string, {botId:string, roomId?:string, since:number, trigger?:any, approval?:{tool:string, reason:string}, resumed?:boolean}>} */
  const startupTurns = interrupted.turns
  let turns = { ...startupTurns }
  // The delayed scan still owns these records. A turn of the same Session may start
  // and end while it waits, but must not replace or erase the record the scan will
  // dispatch. Once recovery replaces one, normal event tracking resumes.
  const isStartupTurn = id => Object.hasOwn(startupTurns, id) && turns[id] === startupTurns[id]
  const resuming = new Set()
  // A new delivery can persist before recovery runs; it must keep the old queue.
  /** @type {Record<string, {at:number, args:any}[]>} deliveries no turn has taken up, by Session */
  let queued = interrupted.queued
  let writing = Promise.resolve()
  let stopped = false
  let latest
  let due = false
  const persist = () => {
    // Only the host that saves the team runs its work again.
    if (stopped || rt.readOnly() !== undefined) return
    latest = JSON.stringify({ turns, queued })
    // One write waits at a time and takes the latest notes, so a busy round does not
    // write the file once per change.
    if (due) return
    due = true
    // Each write replaces the file whole: what a kill part way through leaves is the
    // notes of one moment, never half of them.
    writing = writing.then(async () => {
      due = false
      const snapshot = latest
      await writeNotes(file, snapshot)
    }).catch(error => rt.warn('ds-bot: noting running turns failed: %s', error))
  }
  const persistRecovery = async () => {
    if (stopped || rt.readOnly() !== undefined) throw new Error('This host cannot reserve recovery.')
    // Write the reservation before dispatch. A later coalesced write must see
    // the same reservation, and cannot run ahead of this write.
    latest = JSON.stringify({ turns, queued })
    const reserved = writing.then(() => {
      if (stopped || rt.readOnly() !== undefined) throw new Error('This host cannot reserve recovery.')
      return writeNotes(file, latest)
    })
    writing = reserved.catch(error => rt.warn('ds-bot: reserving recovery failed: %s', error))
    await reserved
  }
  const update = (id, change) => {
    const next = change(turns[id])
    if (next === turns[id]) return
    turns = { ...turns }
    if (next === undefined) delete turns[id]
    else turns[id] = next
    persist()
  }
  // A folded batch carries every exchange it took in: the Session took them all up
  // together, so all of them are done with at once.
  const idsOf = source => Array.isArray(source?.exchangeIds) ? source.exchangeIds
    : source?.exchangeId === undefined ? [] : [source.exchangeId]
  // Every note of the exchange goes, not just the first: a send that failed is noted
  // again when the same exchange is sent again, and a note left behind sends it once
  // more at the next start.
  const forgetQueued = (exchangeId) => {
    let found = false
    const next = {}
    for (const [sessionId, list] of Object.entries(queued)) {
      const rest = list.filter(item => !idsOf(item?.args).includes(exchangeId))
      if (rest.length === list.length) {
        next[sessionId] = list
        continue
      }
      found = true
      if (rest.length > 0) next[sessionId] = rest
    }
    if (!found) return
    queued = next
    persist()
  }
  // Every exchange a Session's durable log shows a turn took up and finished. A turn
  // that DSH stopped as it shut down is not counted: it did not settle, its own note
  // picks it up, and an older delivery of the exchange must not swallow a note that was
  // never sent.
  const consumedInLog = turns => new Set(turns
    .filter(turn => turn.reason !== undefined && !(turn.reason.kind === 'aborted' && turn.reason.reason?.kind === 'disposed'))
    .flatMap(turn => turn.took.flatMap(source => idsOf(source))))
  const forgetIds = (ids) => {
    for (const id of ids) forgetQueued(id)
  }

  const deliver = rt.deliver
  rt.deliver = async (args) => {
    const noted = { ...args, exchangeId: args.exchangeId ?? randomUUID() }
    const sessionId = noted.sessionId ?? rt.chatOf(noted.toId)
    // Noted before it is sent: a turn may take it up before the send returns. Notes
    // are kept whole; nothing waits out a delivery silently.
    queued = { ...queued, [sessionId]: [...(queued[sessionId] ?? []), { at: Date.now(), args: noted }] }
    persist()
    try {
      return await deliver(noted)
    } catch (error) {
      // A delivery that never reached the inbox stays noted: the next start sends
      // it again. One whose Bot is gone is dropped, since it can never be sent.
      if (rt.botOf(noted.toId) === undefined) forgetQueued(noted.exchangeId)
      throw error
    }
  }

  // What a Session was sent and no turn has read yet.
  rt.unreadOf = sessionId => (queued[sessionId] ?? []).map(item => item.args)
  rt.forgetDelivery = forgetQueued

  // A message is done with once a turn takes it up, or once it leaves the inbox untaken
  // while DS Bot runs: the user stopped the Bot, or DS Bot moved or withdrew it.
  ctx.on('agent/inbox/discarded', ({ message } = {}) => {
    if (message?.source?.kind === SOURCE_KIND) forgetIds(idsOf(message.source))
  })
  // Exchanges a turn took up since this start, until the resends are done, so a resend
  // never repeats one.
  let taken = Object.keys(interrupted.queued).length > 0 ? new Set() : undefined
  // The first turn event of each Session since this start, until the noted turns are
  // picked up. A turn that ends, or still runs, before one starts here outlived the
  // last run: only DS Bot restarted (the plugin reloaded) and DSH went on.
  let firstTurn = Object.keys(interrupted.turns).length > 0 ? new Map() : undefined
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if ((event.type === 'turn/start' || event.type === 'turn/end') && firstTurn?.has(id) === false) {
      firstTurn.set(id, { type: event.type, turn: event.data?.turn, reason: event.data?.reason })
    }
    if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND) {
      for (const id of idsOf(event.data.source)) {
        taken?.add(id)
        forgetQueued(id)
      }
    }
    if (!rt.isBotSession(id)) return
    switch (event.type) {
      case 'turn/start': {
        if (isStartupTurn(id)) break
        const owner = rt.groupOwners.get(id)
        const botId = owner?.botId ?? rt.chatOwners.get(id)
        // turns.js runs first and has already claimed or restored the trigger.
        const info = rt.live.get(id)?.info
        update(id, prior => ({ botId, ...(owner ? { roomId: owner.roomId } : {}), since: event.time ?? Date.now(), ...(info !== undefined ? { trigger: triggerOf(info) } : {}),
          ...(info?.resumed || (prior?.resumed && resuming.has(id)) ? { resumed: true } : {}) }))
        break
      }
      case 'user/message': {
        if (event.data?.source?.kind !== SOURCE_KIND) break
        if (isStartupTurn(id)) break
        // turns.js, installed earlier, has already claimed the turn's trigger.
        const info = rt.live.get(id)?.info
        update(id, record => {
          if (record === undefined) return record
          const trigger = record.trigger === undefined && info !== undefined ? triggerOf(info) : undefined
          const resumed = event.data.source.resumed === true && !record.resumed
          return trigger || resumed ? { ...record, ...(trigger ? { trigger } : {}), ...(resumed ? { resumed: true } : {}) } : record
        })
        break
      }
      case 'turn/end': {
        // DSH stops every turn as it shuts down; that one is picked up at the next start.
        const reason = event.data?.reason
        if (reason?.kind === 'aborted' && reason.reason?.kind === 'disposed') break
        if (isStartupTurn(id)) break
        update(id, () => undefined)
        break
      }
    }
  })

  // An approval the restart drops is named when the turn is picked up.
  rt.noteApproval = (sessionId, approval) => update(sessionId, record => (record === undefined ? record
    : approval === undefined ? (({ approval: _, ...rest }) => rest)(record) : { ...record, approval }))

  function targetForResume(sessionId, record) {
    if (record.roomId === undefined) return rt.chatOf(record.botId)
    return rt.roomOf(record.roomId)?.sessions?.[record.botId] ?? sessionId
  }

  async function resumeTurn(sessionId, record, { manual = false } = {}) {
    const bot = rt.botOf(record.botId)
    if (bot === undefined) return
    if (turns[sessionId] !== record || resuming.has(sessionId)) return false
    const target = targetForResume(sessionId, record)
    if (target === undefined) return
    const room = record.roomId === undefined ? undefined : rt.roomOf(record.roomId)
    if (record.roomId !== undefined && (!room || !room.members.includes(bot.id))) return
    resuming.add(sessionId)
    try {
      return await dispatchRecovery(sessionId, record, target, bot, room, manual)
    } finally { resuming.delete(sessionId) }
  }

  async function dispatchRecovery(sessionId, record, target, bot, room, manual) {
    const targetAgent = await rt.resolveAgent(target)
    if (targetAgent.status === 'running' || turns[sessionId] !== record) return false
    const held = await rt.workspaceHold?.heldFor(targetAgent.session)
    if (turns[sessionId] !== record) return false
    if (held || (!manual && (record.resumed || record.paused))) {
      const paused = held ? 'worktree-held' : record.paused ?? 'limit-reached'
      update(sessionId, () => ({ ...record, paused }))
      if (room && !record.paused && !held) await rt.postToRoom(room, bot, '', { resumed: true, quiet: true, again: true })
      return false
    }
    const reserved = { ...record, resumed: true, paused: 'limit-reached' }
    update(sessionId, () => reserved)
    await persistRecovery()
    if (turns[sessionId] !== reserved) return false
    if (await rt.workspaceHold?.heldFor(targetAgent.session) || turns[sessionId] !== reserved) return false
    const text = resumeText(record)
    const identity = {
      ...(record.trigger?.taskId ? { taskId: record.trigger.taskId } : {}),
      ...(record.trigger?.attemptId ? { attemptId: record.trigger.attemptId } : {}),
    }
    if (room !== undefined) {
      await rt.postToRoom(room, bot, '', { resumed: true, quiet: true })
      await rt.deliver({ toId: bot.id, sessionId: target, role: 'room', roomId: room.id, note: 'picking up after a restart', resumed: true, text, ...identity, ...(record.trigger?.askedBy ? { askedBy: record.trigger.askedBy } : {}) })
      update(sessionId, current => current === reserved ? undefined : current)
      return true
    }
    const trigger = record.trigger
    if ((trigger?.role === 'request' || trigger?.role === 'stopped') && trigger.senderSessionId && trigger.audience !== 'user' && rt.botOf(trigger.senderSessionId)) {
      // The sender still waits for this turn's answer, so it goes on under the same exchange.
      await rt.deliver({ fromId: trigger.senderSessionId, toId: bot.id, sessionId: target, role: trigger.role, ...(trigger.exchangeId ? { exchangeId: trigger.exchangeId } : {}), ...(trigger.senderRoomId ? { fromRoomId: trigger.senderRoomId } : {}), ...identity, resumed: true, text })
      update(sessionId, current => current === reserved ? undefined : current)
      return true
    }
    // A turn that went on with work another Bot asked for still owes that Bot its answer.
    await rt.deliver({ toId: bot.id, sessionId: target, role: 'resume', resumed: true, text, ...(trigger?.work ? { work: trigger.work } : {}), ...identity })
    update(sessionId, current => current === reserved ? undefined : current)
    return true
  }

  rt.interruptedTurnState = sessionId => turns[sessionId]?.paused ?? null
  rt.continueInterrupted = async botId => {
    const sessionId = rt.chatOf(botId)
    const record = turns[sessionId]
    if (!record?.paused || record.botId !== botId) return false
    const accepted = await resumeTurn(sessionId, record, { manual: true })
    if (!accepted) throw Object.assign(new Error('The interrupted Session cannot resume yet.'), { code: 'bot/busy' })
    return true
  }

  // Where a queued note goes now: its Session if it still is one, else the
  // current Session of its Bot, or of its group when the message went to one.
  const sessionFor = (sessionId, args) => (rt.isBotSession(sessionId) ? sessionId
    : args?.roomId === undefined ? rt.chatOf(args?.toId) : rt.roomOf(args.roomId)?.sessions?.[args.toId])

  // A hard stop keeps the inbox, which the Session runs once it wakes; only what DSH
  // cancelled is sent again. The notes stay queued until a turn takes the messages
  // up, so a send that fails here, or a Session that cannot be opened, leaves them
  // for the next start instead of losing them.
  async function resendQueued(sessionId, list) {
    const fresh = list.filter((item) => {
      const ids = idsOf(item.args)
      return rt.botOf(item.args?.toId) !== undefined
        && sessionFor(sessionId, item.args) !== undefined && !ids.some(id => taken?.has(id) === true)
    })
    if (fresh.length === 0) return
    const target = sessionFor(sessionId, fresh[0].args)
    const agent = await rt.resolveAgent(target)
    if (await rt.workspaceHold?.heldFor(agent.session)) return
    // Every exchange of a folded batch is in its one message: that message in the
    // inbox means the whole batch already has a turn to run in.
    const waiting = new Set([...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].flatMap(message => idsOf(message.source)))
    for (const { args } of fresh) {
      const ids = idsOf(args)
      if (ids.some(id => waiting.has(id))) continue
      if (ids.some(id => taken?.has(id) === true)) {
        forgetIds(ids)
        continue
      }
      // A request that waited through a restart reaches its target late: the work
      // it is for is marked, so the answer that comes back says so.
      if (args.role === 'request' || args.role === 'stopped') rt.lateWork?.(args.exchangeId)
      await deliver({ ...args, sessionId: sessionFor(sessionId, args), steer: false, resent: true })
        .catch(error => rt.warn('ds-bot: sending again what %s was sent failed: %s', sessionId, error))
    }
  }

  // A Session's durable log, as DSH keeps it: what happened there, and what it said.
  // Undefined when this DSH cannot read it, or when the Session is gone.
  async function logOf(sessionId) {
    const inspect = ctx.sessionController?.inspect
    if (typeof inspect !== 'function') return undefined
    const seen = await inspect(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS)).catch(() => undefined)
    return Array.isArray(seen?.events) ? seen.events : undefined
  }

  // A turn that ended while DS Bot was not watching it: its answer may exist and never
  // have gone to the Bot that waits for it. The Session's durable log says what it did;
  // the work it was for is settled once, the way a finished turn settles it.
  async function reconcileEnded(sessionId, record, ended) {
    // DSH stops a turn as it shuts down; that is not the turn settling. The note stays
    // and the turn is picked up in this same pass, so the caller must not drop it.
    if (ended.reason?.kind === 'aborted' && ended.reason.reason?.kind === 'disposed') return true
    const trigger = record.trigger
    if (trigger === undefined) return
    const workId = rt.workOf(trigger)
    if (!rt.ownsWork(record.botId, workId)) return
    const exchangeId = trigger.exchangeId
    const asker = rt.workAsker(workId)
    const sender = asker?.senderSessionId
    if (exchangeId === undefined || sender === undefined || rt.botOf(sender) === undefined) return
    const name = rt.botOf(rt.selfOf(sessionId))?.name ?? 'The other Bot'
    const events = await logOf(sessionId)
    if (events === undefined) {
      // The record of that work cannot be read: whether it answered cannot be
      // established. The sender is told that, and the work is not run again.
      const why = 'the record of that work could not be read'
      const text = `${name} could not answer your message: ${why}, so what it did is unknown (its session is ${sessionId}). It may have done part of the work. Tell the user if it matters; do not run the work again without asking.`
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      rt.noteFailure?.({
        level: 'warn',
        source: 'turn',
        text: `the result of the work ${name} was given is unknown`,
        bot: name,
        where: room === undefined ? 'own chat' : `group "${room.name}"`,
        sessionId,
      })
      answerSender(rt, sessionId, asker, text)
      return
    }
    const turn = turnOf(events, exchangeId)
    // The request was never taken up: it is still waiting, and the delivery that is
    // waiting for it keeps what it had.
    if (turn === undefined) return
    const said = turn.texts.join('\n\n')
    // The answer went up in another run: the work closes with what it said, and
    // nothing is sent twice.
    const back = rt.roomOf(asker.senderRoomId)?.sessions?.[sender]
    const sent = await logOf(back ?? rt.chatOf(sender))
    if (sent !== undefined && answeredIn(sent, workId)) {
      rt.closeWork?.(workId, name, rt.answerText(workId, said, name))
      return
    }
    const reason = turn.reason
    // A turn that went on to a fresh part goes on there; it is not settled here.
    if (reason?.kind === 'blocked') return
    // The turn was cut off before it finished: the work is picked up again, as after
    // a restart that cut it off.
    if (reason === undefined || reason.kind === 'interrupted') {
      if (turns[sessionId] === undefined) update(sessionId, () => record)
      await resumeTurn(sessionId, record)
      return
    }
    if (reason.kind === 'error') {
      const failure = turnFailure(reason.error)
      answerSender(rt, sessionId, asker, `${name} could not answer your message: its model call failed (${failureLine(failure)}). Tell the user if it matters; do not retry right away.`)
      return
    }
    if (reason.kind === 'aborted') {
      // The turn was stopped before it could answer: the sender is told, as it is told
      // when DS Bot watches the turn end.
      answerSender(rt, sessionId, asker, `${name} was stopped before it could answer your message.`)
      return
    }
    // A turn cut off at the output limit is not a finish: the answer says so, and the
    // diagnostics record it, with the route the Session's log holds for it.
    const cutOff = reason?.kind === 'max-tokens'
    const withoutText = cutOff && turn.texts.length === 0
    if (cutOff) {
      rt.noteCutOffTurn?.(sessionId, { withoutText })
      const context = events.findLast(event => event?.type === 'request/context')?.data
      const ref = context?.provider && context?.model ? `${context.provider}/${context.model}` : undefined
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      rt.noteFailure?.({
        level: 'warn',
        source: 'turn',
        code: 'MAX_TOKENS',
        text: `${withoutText
          ? 'the turn was cut off at the output limit before it wrote anything'
          : 'the turn was cut off at the output limit, so its answer is not complete'}${ref ? ` (${ref})` : ''}`,
        bot: name,
        where: room === undefined ? 'own chat' : `group "${room.name}"`,
        sessionId,
      })
    }
    const answer = cutOff ? cutOffText(said) : said
    // The turn ended with what it said: the answer goes up the way a finished turn's
    // does, with the results that came back for it and the text it held. A work that
    // still waits for what it handed on keeps its part until that comes back.
    if (rt.waitsWork(workId)) {
      rt.holdWork(workId, answer)
      return
    }
    const text = rt.answerText(workId, answer, name)
    const long = text.length > MESSAGE_INLINE_MAX ? await rt.attachLong(text, `Answer from ${name}.txt`) : undefined
    answerSender(rt, sessionId, asker, text, long)
  }

  // A turn the log shows cut off with no note: DS Bot was down when the Session took the
  // message up, so nothing here noted it. It is noted again, and picked up in this pass.
  const noteCutTurn = (sessionId, logTurns, exchangeId) => {
    if (turns[sessionId] !== undefined) return undefined
    const botId = rt.selfOf(sessionId)
    if (botId === undefined) return undefined
    const turn = logTurns.findLast(entry => entry.reason?.kind === 'interrupted'
      && entry.took.some(source => idsOf(source).includes(exchangeId)))
    if (turn === undefined) return undefined
    const source = turn.took.find(source => idsOf(source).includes(exchangeId))
    const owner = rt.groupOwners.get(sessionId)
    const record = {
      botId,
      ...(owner?.roomId ? { roomId: owner.roomId } : {}),
      since: Date.now(),
      trigger: triggerOf(source),
      ...(source.resumed ? { resumed: true } : {}),
    }
    turns = { ...turns, [sessionId]: record }
    persist()
    return record
  }

  async function resumeAll() {
    await rt.load()
    if (rt.readOnly() !== undefined) return
    const { turns: noted, queued: dropped } = interrupted
    interrupted = { turns: {}, queued: {} }
    // Every note is noted again as this run's own before anything is written: a start
    // that stops part way through picking them up leaves them all on disk, and the next
    // start picks up what this one did not settle. Each is dropped once it is settled.
    // What the last run still had on the way is noted again first, under the
    // Session it would go to now: nothing is cleared before it is handed over.
    // A Bot that is gone takes its notes with it; what a turn already read here
    // is done with.
    const pending = queued
    queued = {}
    for (const [oldId, list] of Object.entries(pending)) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const ids = idsOf(item?.args)
        if (ids.length === 0 || ids.some(id => taken?.has(id) === true) || rt.botOf(item.args.toId) === undefined) continue
        const key = sessionFor(oldId, item.args) ?? oldId
        queued = { ...queued, [key]: [...(queued[key] ?? []), item] }
      }
    }
    for (const [sessionId, record] of Object.entries(noted)) {
      const events = await logOf(sessionId).catch((error) => {
        rt.warn('ds-bot: evidence for %s could not be read after restart: %s', sessionId, error)
        return undefined
      })
      if (events === undefined) continue
      rt.reconcileGoalEvidence?.(sessionId, events, record.trigger)
      rt.reconcileWorkEvidence?.(sessionId, events, record.trigger)
    }
    persist()
    // Agents and inboxes are read before anything wakes their Sessions.
    const cut = []
    for (const [sessionId, record] of Object.entries(noted)) {
      const first = firstTurn.get(sessionId)
      if (first?.type === 'turn/end') {
        // The turn ended while DS Bot was not watching it: what it did is settled from
        // the Session's durable log. A turn DSH disposed as it shut down did not settle,
        // so its note stays and the turn is picked up in this pass.
        const pickUp = await reconcileEnded(sessionId, record, first).catch((error) => {
          rt.warn('ds-bot: settling the work of %s failed: %s', sessionId, error)
          return false
        })
        if (pickUp === true) {
          cut.push([sessionId, record])
          continue
        }
        // Whatever the log could tell, the note is done with: the turn is not resumed.
        update(sessionId, current => current === record ? undefined : current)
        continue
      }
      // Still running: the note stays as it is, as if it had started here.
      if (first === undefined && (await rt.resolveAgent(sessionId).catch(() => undefined))?.status === 'running') continue
      cut.push([sessionId, record])
    }
    firstTurn = undefined
    // A Session may have taken up a noted exchange while DS Bot was not running: that
    // message is not in its inbox any more and no event here saw it. Its durable log
    // says which ones were read to the end, so they are not sent again, and their
    // notes are done with.
    for (const [sessionId, list] of Object.entries(dropped)) {
      const ids = Array.isArray(list) ? [...new Set(list.flatMap(item => idsOf(item?.args)))] : []
      if (ids.length === 0) continue
      const events = await logOf(sessionId)
      if (events === undefined) continue
      const logTurns = turnsOf(events)
      const consumed = consumedInLog(logTurns)
      for (const id of ids) {
        if (!consumed.has(id)) continue
        taken ??= new Set()
        taken.add(id)
        forgetQueued(id)
        // The log, not a note, is what says this turn was cut off: note it now so the
        // message it read is not lost with nothing to show for it.
        const record = noteCutTurn(sessionId, logTurns, id)
        if (record !== undefined) cut.push([sessionId, record])
      }
    }
    for (const [sessionId, list] of Object.entries(dropped)) {
      if (!Array.isArray(list)) continue
      await resendQueued(sessionId, list).catch(error => rt.warn('ds-bot: sending again what %s was sent failed: %s', sessionId, error))
    }
    taken = undefined
    for (const [sessionId, record] of cut) {
      // A turn picked up here that fails keeps its note: the next start has it again.
      await resumeTurn(sessionId, record).catch(error => {
        rt.warn('ds-bot: picking up the turn of %s failed: %s', sessionId, error)
      })
    }
    // What a group's members were asked for and will not pick up is settled now.
    await rt.settleRoomBatches?.()
  }

  ctx.effect(() => {
    const pending = Object.keys(interrupted.turns).length > 0 || Object.keys(interrupted.queued).length > 0
    // With nothing to pick up, the group batches a restart left are settled at once.
    const timer = pending
      ? setTimeout(() => void resumeAll().catch(error => rt.warn('ds-bot: picking up interrupted work failed: %s', error)), RESUME_DELAY_MS)
      : setTimeout(() => void rt.load().then(() => rt.settleRoomBatches?.()).catch(error => rt.warn('ds-bot: settling group batches failed: %s', error)), 0)
    timer?.unref?.()
    // What the turns stopped by this shutdown left stays as last noted.
    return () => {
      stopped = true
      clearTimeout(timer)
      return writing
    }
  }, 'ds-bot: resume interrupted turns')
}
