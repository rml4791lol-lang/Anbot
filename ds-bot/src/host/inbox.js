// Inbox: a record store, not a delivery router. A profile update or a stop receipt
// reaches its Bot without starting a turn; it is kept here so the Bot can read it at
// the start of a later turn with read_inbox. Replies, requests and user messages keep
// going through their Session as before.
//
// Each Bot has one append-only file, one record per line:
//
//   <home>/inbox/<botId>.jsonl
//
// Read state lives beside it in <botId>.cursor.json and is the last line read. No
// message line is ever rewritten, and a crash after a message lands but before the
// cursor does leaves it unread rather than lost.
//
// A note the disk refuses is a hole in that mailbox. It is written down in a ledger
// book (<home>/ledger/inbox-<botId>.jsonl) instead of being forgotten: one `failed`
// record per note, and one `resumed` record when the mailbox takes a write again.
// gaps() reads those marks back, so a Bot that reads its mailbox can tell a quiet
// team from a stretch of notes that never landed.
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// What one read_inbox call shows, and the most it may ask for. A mailbox is read at
// the start of a turn; more than this would spend the turn on old notes.
export const INBOX_READ_MAX = 20
const LIST_DEFAULT = 10
// A mailbox keeps what was said, not the whole of a long report: the Session copy is
// the one that matters for those. This keeps one line from growing without bound.
const INBOX_TEXT_MAX = 20_000

const safeName = (botId) => {
  const id = String(botId)
  return /^[\w-]{1,160}$/.test(id) ? id : createHash('sha256').update(id).digest('hex').slice(0, 32)
}

// The message records of a mailbox, oldest first, each with the physical line it came
// from so the cursor can point at it. A line cut by an interruption, a blank line and
// a record missing its id or text are not messages.
export const parseInbox = (text) => {
  const entries = []
  const rows = String(text ?? '').split('\n')
  for (let at = 0; at < rows.length; at += 1) {
    if (rows[at] === '') continue
    let record
    try {
      record = JSON.parse(rows[at])
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object') continue
    if (typeof record.id !== 'string' || typeof record.text !== 'string') continue
    entries.push({ ...record, line: at + 1 })
  }
  return entries
}

export function install(rt) {
  const dir = join(rt.home, 'inbox')
  const pathOf = (botId) => join(dir, `${safeName(botId)}.jsonl`)
  const cursorPathOf = (botId) => join(dir, `${safeName(botId)}.cursor.json`)
  const bookOf = (botId) => `inbox-${safeName(botId)}`
  const writable = () => rt.readOnly?.() === undefined
  /** @type {Map<string, Promise<unknown>>} */
  const writing = new Map()

  function textOf(botId) {
    try {
      return readFileSync(pathOf(botId), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') rt.warn?.('ds-bot: inbox of %s could not be read: %s', botId, error?.message ?? error)
      return ''
    }
  }

  function cursorOf(botId) {
    try {
      const data = JSON.parse(readFileSync(cursorPathOf(botId), 'utf8'))
      return Number.isInteger(data?.cursor) && data.cursor >= 0 ? data.cursor : 0
    } catch {
      return 0
    }
  }

  function writeCursor(botId, cursor) {
    mkdirSync(dir, { recursive: true })
    const path = cursorPathOf(botId)
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({ cursor, time: Date.now() })}\n`, 'utf8')
    renameSync(temp, path)
  }

  // The write queue of one Bot: its mailbox is the chat Session it belongs to, so two
  // messages that reach it at once keep the order they were sent in.
  function queued(botId, run) {
    const previous = writing.get(botId) ?? Promise.resolve()
    const next = previous.then(run)
    writing.set(botId, next.catch(() => {}))
    return next
  }

  // A note that did not land is named in the ledger: its exchange, when, and why. The
  // delivery still goes on (the Bot sees the note in its Session), but nothing pretends
  // the mailbox kept it.
  function noteGap(botId, entry, error) {
    if (rt.ledger === undefined) return
    const book = bookOf(botId)
    try {
      rt.ledger.append(book, {
        event: 'failed',
        id: typeof entry.exchangeId === 'string' && entry.exchangeId !== '' ? entry.exchangeId : null,
        from: entry.from ?? null,
        role: entry.role ?? null,
        reason: String(error?.message ?? error),
        time: Number.isFinite(entry.time) ? entry.time : Date.now(),
      })
      void rt.ledger.written(book).catch(() => {})
    } catch (failure) {
      rt.warn?.('ds-bot: the lost note of %s could not be noted: %s', botId, failure?.message ?? failure)
    }
  }

  // The first note that lands again ends the stretch: no note is written down here on
  // the normal path, only the one `resumed` mark that closes a hole.
  function closeGap(botId) {
    if (rt.ledger === undefined) return
    const book = bookOf(botId)
    if (rt.ledger.records(book).at(-1)?.event !== 'failed') return
    rt.ledger.append(book, { event: 'resumed', time: Date.now() })
    void rt.ledger.written(book).catch(() => {})
  }

  // The stretches a mailbox is missing, oldest first: consecutive failed notes are one
  // hole, from the first of them to the write that ended it (`to` is null while it
  // has not ended). Derived from the ledger, so it survives a restart.
  function gaps(botId) {
    if (rt.ledger === undefined) return []
    const found = []
    let open
    for (const record of rt.ledger.records(bookOf(botId))) {
      if (record.event === 'failed') {
        if (open === undefined) open = { from: record.time, to: null, reason: record.reason, count: 0 }
        open.count += 1
      } else if (record.event === 'resumed' && open !== undefined) {
        open.to = record.time
        found.push(open)
        open = undefined
      }
    }
    if (open !== undefined) found.push(open)
    return found
  }

  // Adds one message. A resend carries the exchange it belongs to; the first record
  // already in the file wins, so a retried delivery does not write a second line.
  async function append(botId, entry) {
    let record
    try {
      if (!writable()) throw new Error('The Bot team is open in another dsh, so the mailbox cannot be written.')
      record = await queued(botId, () => {
        const path = pathOf(botId)
        const existing = textOf(botId)
        const exchangeId = typeof entry.exchangeId === 'string' && entry.exchangeId !== '' ? entry.exchangeId : null
        if (exchangeId !== null) {
          const found = parseInbox(existing).find(record => record.exchangeId === exchangeId)
          if (found !== undefined) return found
        }
        const record = {
          id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : randomUUID(),
          from: entry.from ?? null,
          fromName: entry.fromName ?? 'another Bot',
          role: entry.role ?? 'update',
          sessionId: entry.sessionId ?? null,
          senderRoomId: entry.senderRoomId ?? null,
          exchangeId,
          roomId: entry.roomId ?? null,
          text: String(entry.text ?? '').slice(0, INBOX_TEXT_MAX),
          time: Number.isFinite(entry.time) ? entry.time : Date.now(),
        }
        mkdirSync(dir, { recursive: true })
        // One write. A line cut by an interruption gets its end first, so the new record
        // still starts on a line of its own and the cut line stays a bad line.
        const prefix = existing !== '' && !existing.endsWith('\n') ? '\n' : ''
        appendFileSync(path, `${prefix}${JSON.stringify(record)}\n`, 'utf8')
        return record
      })
    } catch (error) {
      noteGap(botId, entry, error)
      throw error
    }
    closeGap(botId)
    return record
  }

  // The oldest messages first: a mailbox is read as a queue, so a window that stops at
  // its limit never skips an older unread note.
  function list(botId, { unreadOnly = false, limit = LIST_DEFAULT } = {}) {
    const asked = Number.isFinite(limit) ? Math.trunc(limit) : LIST_DEFAULT
    const max = Math.min(Math.max(asked, 1), INBOX_READ_MAX)
    const cursor = cursorOf(botId)
    const entries = parseInbox(textOf(botId)).map(entry => ({ ...entry, unread: entry.line > cursor }))
    return (unreadOnly ? entries.filter(entry => entry.unread) : entries).slice(0, max)
  }

  // Moves the cursor to the last of the given messages read, never back. Returns how
  // many of them were still unread.
  async function markRead(botId, ids) {
    if (!writable()) return 0
    const wanted = new Set((Array.isArray(ids) ? ids : [ids]).filter(id => typeof id === 'string'))
    if (wanted.size === 0) return 0
    return queued(botId, () => {
      const cursor = cursorOf(botId)
      const unread = parseInbox(textOf(botId)).filter(entry => entry.line > cursor && wanted.has(entry.id))
      if (unread.length === 0) return 0
      const next = Math.max(...unread.map(entry => entry.line))
      if (next > cursor) writeCursor(botId, next)
      return unread.length
    })
  }

  function unreadCount(botId) {
    const cursor = cursorOf(botId)
    return parseInbox(textOf(botId)).filter(entry => entry.line > cursor).length
  }

  async function flush(botId) {
    if (botId !== undefined) return writing.get(botId)
    await Promise.all(writing.values())
  }

  const inbox = { append, list, markRead, unreadCount, gaps, flush }
  rt.inbox = inbox
  // What is still on its way to disk lands before the plugin goes.
  rt.ctx?.effect?.(() => () => flush(), 'ds-bot: inbox')
}
