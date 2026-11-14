// R59: a Bot that has several notes waiting reads them as one message instead of
// spending a turn on each. Replies keep their words and say which exchange each one
// answers; requests are read as their newest one plus a count. Anything that carries
// something of its own (an image, a file, a room, a work item, a reply target that is
// not a reply) is delivered as it came, and so is anything the plugin injects into a
// Session.
export const BACKLOG_LIMIT = 5

// How long a batch waits after the turn ends, so a burst that keeps arriving is read
// once, and the longest it may wait while a turn never ends.
export const WAITING_QUIET_MS = 2000
export const WAITING_MAX_MS = 30_000

// The line that says the rest came along. Written after the newest text, so what the
// recipient reads first is still the message itself, word for word.
export const backlogNote = count => `${count} more message${count === 1 ? '' : 's'} came along in this batch.`

// A folded reply keeps its sender and the exchange it answers, so the recipient can
// name one of them when it answers rather than the batch as a whole.
export const replyHeader = (entry) => {
  const short = id => String(id ?? '').slice(0, 8)
  const re = entry.replyTo === undefined ? '' : ` · re ${short(entry.replyTo)}`
  const ex = entry.exchangeId === undefined ? '' : ` · ex ${short(entry.exchangeId)}`
  return `[Reply from ${entry.fromName ?? 'the other Bot'}${re}${ex}]`
}

const PLAIN_ROLES = new Set(['request', 'reply'])

// Everything that makes a message more than a plain relay. A message with any of it
// would lose something by being folded into another one.
export function plainRelay(delivery) {
  if (delivery === undefined || delivery === null) return false
  if (!PLAIN_ROLES.has(delivery.role)) return false
  // A reply is a plain relay even with its target: the target is what its own header
  // line says, and the exchange ids travel with the folded message's source.
  if (delivery.replyTo !== undefined && delivery.role !== 'reply') return false
  if (delivery.roomId !== undefined) return false
  if (delivery.audience !== undefined) return false
  if (delivery.work !== undefined) return false
  if (delivery.fromRoomId !== undefined) return false
  // A task is not a note: folded into a batch it would end up as a counting line,
  // and its content is what the recipient has to work on. It goes on its own.
  if (delivery.queue === true) return false
  if (delivery.silent === true || delivery.steer === true) return false
  if (delivery.deferred === true || delivery.resumed === true || delivery.retried === true) return false
  if (delivery.merged === true || delivery.abandoned === true) return false
  if ((delivery.images?.length ?? 0) > 0 || (delivery.files?.length ?? 0) > 0) return false
  if (typeof delivery.text !== 'string' || delivery.text === '') return false
  return true
}

// Groups what is waiting by the Session it goes to: a note for one Bot never rides
// along with a note for another, and a note that is not a plain relay never rides at
// all. Keys are the Session (or the Bot, before its Session is known).
export function mergeBySession(deliveries, limit = BACKLOG_LIMIT) {
  const groups = new Map()
  for (const delivery of deliveries ?? []) {
    if (!plainRelay(delivery)) continue
    const key = delivery.sessionId ?? delivery.toId
    if (key === undefined) continue
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [delivery])
    else group.push(delivery)
  }
  const merged = new Map()
  for (const [key, group] of groups) merged.set(key, mergeBacklog(group, limit))
  return merged
}

// Folds the notes waiting for one Session, oldest first. The newest one is delivered
// as it was written. Replies before it keep their words, each under its own header;
// requests before it are only counted. At most `limit` notes go in one round: the rest
// stay queued for the next one, so a flood is read over several turns instead of one
// enormous one.
export function mergeBacklog(entries, limit = BACKLOG_LIMIT) {
  const queue = Array.isArray(entries) ? entries.filter(entry => typeof entry?.text === 'string' && entry.text !== '') : []
  if (queue.length === 0) return undefined
  const size = Math.max(1, Math.min(limit, queue.length))
  const batch = queue.slice(0, size)
  const rest = queue.slice(size)
  const newest = batch[batch.length - 1]
  let text = newest.text
  if (batch.length > 1) {
    const parts = []
    for (const entry of batch.slice(0, -1)) {
      if (entry.role === 'reply') parts.push(`${replyHeader(entry)}\n${entry.text}`)
    }
    parts.push(newest.role === 'reply' ? `${replyHeader(newest)}\n${newest.text}` : newest.text)
    parts.push(backlogNote(batch.length - 1))
    // Parallel replies answer different requests: say that answering one of them is
    // enough for the one it answers, so nobody feels bound to answer every line.
    const targets = new Set(batch.filter(entry => entry.role === 'reply' && entry.replyTo !== undefined).map(entry => entry.replyTo))
    if (targets.size > 1) parts.push('Reply only to the exchanges you actually need; the rest are recorded.')
    text = parts.join('\n\n')
  }
  return { text, batch, rest, count: batch.length }
}
