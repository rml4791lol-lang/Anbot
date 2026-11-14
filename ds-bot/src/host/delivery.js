// Delivery: how one Bot, the user, or DS Bot itself puts a message into a Bot Session.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HISTORY_TIMEOUT_MS, LONG_HEAD, MESSAGE_INLINE_MAX, READ_LINE_MAX, SOURCE_KIND, TEXT_KEPT, TEXT_SHOW_MAX } from './constants.js'
import { headOf, stripControlMarkers, textOf } from './text.js'
import { mergeBacklog, plainRelay } from './backlog.js'
import { stripWireTags } from '../shared/wire-tags.js'

export function install(rt) {
  const { ctx, state } = rt

  const resolveAgent = async (sessionId) => {
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw Object.assign(new Error(resolved.error?.message ?? 'Session unavailable'), { code: resolved.error?.code })
    rt.hideBotUnusedTools(resolved.agent)
    return resolved.agent
  }

  // R59: what a Bot was told while it was in the middle of a turn. Plain notes wait here
  // and are read together when that turn ends, so a burst of notes costs one turn, not one
  // turn each. Anything with a reply target, an image or a room goes out as it came.
  const waiting = new Map()

  const headerFor = (role, fromName, roomName, audience, note = 'new message', deferred = false, { resumed = false, retried = false, resent = false, abandoned = false, asker } = {}) => {
    // What came back for work another Bot gave this one says where its answer goes.
    const goesOn = asker === undefined ? '' : ` · for the work ${asker} asked you for; your answer goes to ${asker} once everything you handed on is back`
    // A wait the user gave up reads as its own thing: the other Bot never answered.
    if (abandoned) return `[Waiting given up · ${fromName} did not hand back this work; go on with the work it was for${goesOn}]`
    if (deferred && role === 'reply') return `[Reply from ${fromName} · you read it during your last task; go on with the work it is for now${goesOn}]`
    if (deferred && role === 'report') return `[Group chat "${roomName}" · replies to your post · you read them during your last task; go on with the work they are for now${goesOn}]`
    if (deferred && role !== 'room') return `[Message from ${fromName} · you read it during your last task; answer it now]`
    if (retried && role !== 'room') return '[Your last reply wrote a tool call as text, so nothing ran]'
    if (resumed && role === 'resume') return '[DeepSeek Harness restarted while you were working]'
    if (resumed && role !== 'room') return `[Message from ${fromName} · DeepSeek Harness restarted while you were working on it]`
    if (resent && role === 'reply') return `[Reply from ${fromName} · DeepSeek Harness restarted before it could reach you]`
    if (resent && role !== 'room') return `[Message from ${fromName} · DeepSeek Harness restarted before it could reach you]`
    if (role === 'reply') return `[Reply from ${fromName}${goesOn}]`
    if (role === 'stopped') return `[Stopped by ${fromName}]`
    if (role === 'room') return `[Group chat "${roomName}" · ${note}]`
    if (role === 'report') return `[Group chat "${roomName}" · replies to your post${goesOn}]`
    if (role === 'kickoff') return '[Bot team setup]'
    if (role === 'continue') return '[Retry after a failed turn]'
    // The editor can be the user or a Bot (its own tool call, or a Main Bot's):
    // the header stays neutral about who changed the profile.
    // The prompt is rebuilt from the Bot record on its next turn, so this note only
    // tells a running Bot that the rules changed: it must not cost a turn of its own.
    if (role === 'update') return '[Your profile was updated — follow the latest version. Do not reply to this note.]'
    if (role === 'secret') return '[Secret card]'
    if (audience === 'user') return `[Message from ${fromName} · the user sees your reply here]`
    return `[Message from ${fromName}]`
  }

  // Roles recorded as team exchanges.
  const EXCHANGE_ROLES = new Set(['request', 'reply', 'stopped'])

  // What two Bots say to each other is in the book of the pair (ledger.js), whole, written
  // before the message goes out. A message is shown once a record says it was delivered.
  const pairBook = (a, b) => `pair-${[String(a), String(b)].sort().join('-')}`
  // A pair's book starts from the exchanges a team kept in state.json before the ledger.
  rt.ledger.importer('pair-', book => state.exchanges
    .filter(entry => entry.from !== undefined && entry.to !== undefined && pairBook(entry.from, entry.to) === book)
    .map(entry => ({ ...entry, delivered: true })))
  // A message shows the text its delivery carried: the last record of its id written before
  // a delivery mark. A merged request whose replacement never went out keeps the text that did.
  function pairMessages(a, b) {
    const written = new Map()
    const shown = new Map()
    for (const record of rt.ledger.records(pairBook(a, b))) {
      if (record.event === 'delivered') {
        if (written.has(record.id)) shown.set(record.id, written.get(record.id))
      } else if (record.event === undefined) {
        written.set(record.id, record)
        if (record.delivered === true) shown.set(record.id, record)
      }
    }
    return [...shown.values()]
  }

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
  // one its recipient had not read, under that one's exchange. `silent`: a note with no
  // question in it (a profile update, a stop receipt) is put in the queue and read at the
  // recipient's next turn instead of waking it; a turn spent acknowledging a note is a turn
  // the user reads as an answer that never came.
  async function deliver({ fromId, fromName: senderName, toId, sessionId, text, role, replyTo, roomId, audience, note, exchangeId = randomUUID(), steer = false, silent = false, deferred = false, resumed = false, retried = false, resent = false, merged = false, abandoned = false, recordExchange = true, askedBy, fromRoomId, images = [], files = [], length, work }) {
    // #1517: a model that writes its tool call in DSML form leaves wire tags in
    // the text it hands delivery; neither the book nor the recipient sees them.
    text = stripWireTags(text)
    const from = rt.botOf(fromId)
    const to = rt.botOf(toId)
    if (to === undefined) throw new Error(`Unknown Bot ${toId}`)
    // A chat template's stop marker is not part of the message: neither the book nor
    // the recipient sees it (#14).
    text = stripControlMarkers(text)
    const fromName = senderName ?? from?.name ?? 'You'
    const room = rt.roomOf(roomId)
    const asker = work === undefined ? undefined : rt.botOf(state.works?.[work]?.from)?.name
    // Session events reject `undefined` members, so optional fields are omitted instead.
    const source = {
      kind: SOURCE_KIND,
      form: 'relay',
      role,
      exchangeId,
      senderName: fromName,
      ...(work ? { work } : {}),
      ...(fromId ? { senderSessionId: fromId } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(roomId ? { roomId } : {}),
      ...(audience === 'user' ? { audience } : {}),
      ...(deferred ? { deferred: true } : {}),
      ...(resumed ? { resumed: true } : {}),
      ...(retried ? { retried: true } : {}),
      ...(askedBy ? { askedBy } : {}),
      ...(fromRoomId ? { senderRoomId: fromRoomId } : {}),
      ...(abandoned ? { abandoned: true } : {}),
    }
    const targetSessionId = sessionId ?? rt.chatOf(toId)
    // On disk before it goes out: a message the book could not keep is not sent, so none is
    // delivered with no record of it. A resend keeps the record it has; only a merged request
    // replaces it with its added text.
    const book = fromId !== undefined && from !== undefined && recordExchange && EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried ? pairBook(fromId, toId) : undefined
    if (book !== undefined && (merged || !rt.ledger.records(book).some(record => record.event === undefined && record.id === exchangeId))) {
      rt.ledger.append(book, { id: exchangeId, from: fromId, to: toId, role, text, time: Date.now(), ...(length !== undefined ? { length, files } : {}), ...(replyTo ? { replyTo } : {}), ...(audience === 'user' ? { audience } : {}), ...(roomId ? { roomId } : {}) })
      await rt.ledger.written(book)
    }
    await rt.ensureCapabilities(targetSessionId)
    const agent = await resolveAgent(targetSessionId)
    // A steered message cuts into a running turn at its next step; a follow-up
    // queues for the next turn (see turns.js for how each is routed); a silent note
    // queues the same way but without waking the Bot, so it is read at its next turn
    // and costs no turn of its own.
    const message = createUserMessage({
      content: [
        { type: 'text', text: `${headerFor(role, fromName, room?.name, audience, note, deferred, { resumed, retried, resent, abandoned, asker })}\n${text}` },
        ...images.map(attachment => ({ type: 'image', attachment })),
        ...files.map(attachment => ({ type: 'file', attachment })),
      ],
      source,
    })
    const busy = rt.live.get(targetSessionId)?.turn !== undefined
    if (busy && plainRelay({ role, text, replyTo, roomId, audience, work, fromRoomId, silent, steer, deferred, resumed, retried, merged, abandoned, images, files })) {
      const queued = waiting.get(targetSessionId) ?? []
      queued.push({ text, role, fromName, roomName: room?.name, audience, note, deferred, source, exchangeId, book })
      waiting.set(targetSessionId, queued)
      return exchangeId
    }
    if (steer) agent.steer(message)
    else if (silent) agent.send(message, 'next-turn', false)
    else agent.followup(message)
    await ctx.sessions.flush(agent.session)
    if (book !== undefined) {
      rt.ledger.append(book, { event: 'delivered', id: exchangeId, sessionId: targetSessionId, time: Date.now() })
      // The message went out either way; a mark that is lost only hides it from the dialog.
      await rt.ledger.written(book).catch(() => {})
    } else if (recordExchange && EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried) {
      // A message no Bot of the team sent keeps the record it had before the ledger.
      // Recorded once the message is in the Session: an earlier record would show
      // a failed delivery as delivered. The whole text is in its file, or in the
      // Session it goes to; exchangeText reads it back there. Resends keep any
      // existing record; only a merged request replaces it with its added text.
      const kept = headOf(text, TEXT_KEPT)
      const whole = length !== undefined ? { length, files } : kept.length < text.length ? { length: text.length, sessionId: targetSessionId } : {}
      const entry = { id: exchangeId, from: fromId, to: toId, text: kept, ...whole, role, time: Date.now(), ...(replyTo ? { replyTo } : {}), ...(audience === 'user' ? { audience } : {}) }
      const earlier = state.exchanges.findIndex(other => other.id === exchangeId)
      if (earlier === -1) state.exchanges.push(entry)
      else if (merged) state.exchanges[earlier] = entry
      void rt.save().catch(() => {})
    }
    return exchangeId
  }

  // The turn ended: the notes that waited go out as one message. The newest one keeps
  // its words; the line after it says how many others came along (R59).
  async function flushWaiting(sessionId) {
    const queued = waiting.get(sessionId)
    if (queued === undefined || queued.length === 0) return
    waiting.delete(sessionId)
    const folded = mergeBacklog(queued)
    if (folded === undefined) return
    if (folded.rest.length > 0) waiting.set(sessionId, folded.rest)
    const newest = folded.batch[folded.batch.length - 1]
    const message = createUserMessage({
      content: [{ type: 'text', text: `${headerFor(newest.role, newest.fromName, newest.roomName, newest.audience, newest.note, newest.deferred)}\n${folded.text}` }],
      source: newest.source,
    })
    let agent
    try {
      agent = await resolveAgent(sessionId)
    } catch (error) {
      // Not lost: the batch stays queued and is tried again at the Bot's next turn.
      rt.warn('ds-bot: notes held for %s not delivered: %s', sessionId, error)
      waiting.set(sessionId, [...folded.batch, ...folded.rest])
      return
    }
    agent.followup(message)
    await ctx.sessions.flush(agent.session)
    for (const entry of folded.batch) {
      if (entry.book === undefined) continue
      rt.ledger.append(entry.book, { event: 'delivered', id: entry.exchangeId, sessionId, time: Date.now() })
      await rt.ledger.written(entry.book).catch(() => {})
    }
  }

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const sessionId = agent?.session?.id ?? agent?.id
    if (sessionId === undefined || !waiting.has(sessionId)) return
    void flushWaiting(sessionId)
  })

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

  // The text of a stored file, up to what the dialogs show.
  async function fileText(file) {
    const attachments = ctx.get?.('attachments')
    if (attachments === undefined) return undefined
    const decoder = new TextDecoder()
    let text = ''
    try {
      for await (const chunk of attachments.readFileStream(file, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) {
        text += decoder.decode(chunk, { stream: true })
        if (text.length > TEXT_SHOW_MAX) return { text: headOf(text, TEXT_SHOW_MAX), whole: false }
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
  const exchangeOf = (id, a, b) => {
    const record = pairMessages(a, b).find(item => item.id === id)
    if (record === undefined) return undefined
    // Imported from before the ledger: as whole as it was kept then.
    if (record.sessionId !== undefined || (record.length !== undefined && !(record.files?.length > 0))) return record
    return { ...record, ledger: true }
  }

  Object.assign(rt, { resolveAgent, deliver, exchangeText, attachLong, fileText, exchangesOf, exchangeOf })
}
