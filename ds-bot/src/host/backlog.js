// R59: a Bot that has several notes waiting reads them as one message instead of
// spending a turn on each. Only whole turns are saved this way: a note that carries
// anything of its own (an image, a file, a reply target, a room, a work item) is
// delivered as it came, and so is anything the plugin injects into a Session.
export const BACKLOG_LIMIT = 5

// The line that says the rest came along. Written after the newest text, so what the
// recipient reads first is still the message itself, word for word.
export const backlogNote = count => `另有 ${count} 条并入本轮`

const PLAIN_ROLES = new Set(['request'])

// Everything that makes a message more than a plain relay. A message with any of it
// would lose something by being folded into another one.
export function plainRelay(delivery) {
  if (delivery === undefined || delivery === null) return false
  if (!PLAIN_ROLES.has(delivery.role)) return false
  if (delivery.replyTo !== undefined) return false
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
// as it was written; the ones before it are counted in a last line. At most `limit`
// notes go in one round: the rest stay queued for the next one, so a flood is read
// over several turns instead of one enormous one.
export function mergeBacklog(entries, limit = BACKLOG_LIMIT) {
  const queue = Array.isArray(entries) ? entries.filter(entry => typeof entry?.text === 'string' && entry.text !== '') : []
  if (queue.length === 0) return undefined
  const size = Math.max(1, Math.min(limit, queue.length))
  const batch = queue.slice(0, size)
  const rest = queue.slice(size)
  const newest = batch[batch.length - 1]
  const text = batch.length === 1 ? newest.text : `${newest.text}\n\n${backlogNote(batch.length - 1)}`
  return { text, batch, rest, count: batch.length }
}
