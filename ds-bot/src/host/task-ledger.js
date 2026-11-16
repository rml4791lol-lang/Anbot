// The task ledger: one line per piece of work Bots ask of each other, from the moment
// it opens to what became of it. Nothing said in a conversation is written here — only
// ids, who asked whom, when, and whether an answer came back. That is enough to count
// completion, abandonment and how long a wait ran, without reading any session.
//
//   <home>/ledger/tasks-<day>.jsonl
//
// A row that cannot be written must never stop the work it describes: the failure is
// warned and the work goes on.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const TASK_FILE_RE = /^tasks-\d{4}-\d{2}-\d{2}\.jsonl$/
const dayFormats = new Map()
const MAX_DATE_MS = 8_640_000_000_000_000

// The day a row belongs to follows the team's configured time zone, as memory and
// other user-facing dates do. The file name is only an index; the report filters on
// row.time, so moving between time zones cannot hide a row at a day boundary.
const dayFormat = (timeZone) => {
  const key = timeZone ?? ''
  let format = dayFormats.get(key)
  if (format === undefined) {
    const options = { ...(timeZone ? { timeZone } : {}), year: 'numeric', month: '2-digit', day: '2-digit' }
    try {
      format = new Intl.DateTimeFormat('en-CA', options)
    } catch {
      format = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
    }
    dayFormats.set(key, format)
  }
  return format
}

export function taskDay(time = Date.now(), timeZone) {
  const part = Object.fromEntries(dayFormat(timeZone).formatToParts(new Date(time)).map(({ type, value }) => [type, value]))
  return `${part.year}-${part.month}-${part.day}`
}

export const taskRow = (event, time = Date.now(), timeZone) => ({
  ...event,
  day: taskDay(time, timeZone),
  time,
})

const boundDay = (time, timeZone) => taskDay(
  Number.isFinite(time) ? Math.max(-MAX_DATE_MS, Math.min(MAX_DATE_MS, time)) : Date.now(),
  timeZone,
)

const shiftDay = (day, days) => {
  if (!DAY_RE.test(day)) return days < 0 ? '0000-01-01' : '9999-12-31'
  const shifted = new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
  return DAY_RE.test(shifted) ? shifted : days < 0 ? '0000-01-01' : '9999-12-31'
}

export function installTaskLog(rt) {
  const dir = join(rt.home, 'ledger')
  return (event) => {
    if (rt.readOnly?.() !== undefined) return
    const row = taskRow(event, Date.now(), rt.config?.timeZone)
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, `tasks-${row.day}.jsonl`), JSON.stringify(row) + '\n')
    } catch (error) {
      rt.warn?.('ds-bot: task ledger row not written for %s: %s', event.id, error)
    }
  }
}

// Read by event time, not by the file name: the window is half-open [since, until),
// and a bad or unrelated line is skipped rather than stopping the report.
export function readTaskLedger(dir, since, until, warn = () => {}, cache = undefined, timeZone = undefined) {
  let names
  try {
    const present = readdirSync(dir).filter(name => TASK_FILE_RE.test(name)).sort()
    const firstDay = boundDay(since, timeZone)
    const lastDay = until > since ? boundDay(until - 1, timeZone) : undefined
    // A team that changes time zone can move a boundary row one file day either way.
    const firstFileDay = lastDay === undefined ? undefined : shiftDay(firstDay, -1)
    const lastFileDay = lastDay === undefined ? undefined : shiftDay(lastDay, 1)
    names = lastDay === undefined ? [] : present.filter((name) => {
      const fileDay = name.slice('tasks-'.length, -'.jsonl'.length)
      return fileDay >= firstFileDay && fileDay <= lastFileDay
    })
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`task ledger: cannot read ${dir}: ${error.message}`)
    return { rows: [], files: [], days: [] }
  }
  if (cache !== undefined) {
    const present = new Set(names)
    for (const name of cache.keys()) if (!present.has(name)) cache.delete(name)
  }
  const rows = []
  for (const name of names) {
    let fileKey
    try {
      const stat = statSync(join(dir, name))
      fileKey = `${stat.size}:${stat.mtimeMs}`
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`task ledger: cannot stat ${name}: ${error.message}`)
      cache?.delete(name)
      continue
    }
    let parsed = cache?.get(name)
    if (parsed?.key !== fileKey) {
      let text
      try {
        text = readFileSync(join(dir, name), 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') warn(`task ledger: skipped ${name}: ${error.message}`)
        cache?.delete(name)
        continue
      }
      const valid = []
      let badRows = 0
      for (const line of text.split('\n')) {
        if (line === '') continue
        let row
        try {
          row = JSON.parse(line)
        } catch {
          badRows += 1
          continue
        }
        if (row === null || typeof row !== 'object' || Array.isArray(row)) {
          badRows += 1
          continue
        }
        if ((row.kind !== 'open' && row.kind !== 'close') || typeof row.id !== 'string' || row.id === '' || !Number.isFinite(row.time)) {
          badRows += 1
          continue
        }
        valid.push(row)
      }
      parsed = { key: fileKey, rows: valid, badRows }
      cache?.set(name, parsed)
    }
    if (parsed.badRows > 0) warn(`task ledger: skipped ${parsed.badRows} bad row${parsed.badRows === 1 ? '' : 's'} in ${name}`)
    for (const row of parsed.rows) {
      if (row.time >= since && row.time < until) rows.push(row)
    }
  }
  rows.sort((a, b) => a.time - b.time)
  const days = [...new Set(rows.map(row => (DAY_RE.test(row.day) ? row.day : taskDay(row.time))))].sort()
  return { rows, files: names, days }
}

const quantile = (sorted, q) => {
  if (sorted.length === 0) return undefined
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[at]
}

const rate = (part, whole) => (whole === 0 ? 'n/a' : `${part}/${whole} (${((part / whole) * 100).toFixed(1)}%)`)

// Counts what the rows say. A work is opened by its first open row and closed by its
// last close row; a close with no open in the window is left out of the durations
// rather than guessed at. Every ratio carries its denominator.
export function summarizeTasks(rows = []) {
  const byId = new Map()
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || typeof row.id !== 'string') continue
    const item = byId.get(row.id) ?? { id: row.id, open: undefined, close: undefined }
    if (row.kind === 'open' && item.open === undefined) item.open = row
    if (row.kind === 'close' && (item.close === undefined || (Number.isFinite(row.time) && (!Number.isFinite(item.close.time) || row.time >= item.close.time)))) item.close = row
    byId.set(row.id, item)
  }
  const all = [...byId.values()]
  const opened = all.filter(item => item.open !== undefined)
  const closed = opened.filter(item => item.close !== undefined && Number.isFinite(item.open.time) && Number.isFinite(item.close.time) && item.close.time >= item.open.time)
  const answeredRows = closed.filter(item => item.close.outcome === 'answered')
  const abandoned = closed.filter(item => item.close.outcome === 'abandoned')
  const durations = closed.map(item => item.close.time - item.open.time).filter(ms => Number.isFinite(ms) && ms >= 0).sort((a, b) => a - b)
  return {
    opened: opened.length,
    closed: closed.length,
    answered: answeredRows.length,
    abandoned: abandoned.length,
    unclassified: closed.length - answeredRows.length - abandoned.length,
    pending: opened.length - closed.length,
    completion: rate(answeredRows.length, opened.length),
    abandonRate: rate(abandoned.length, opened.length),
    p50Ms: quantile(durations, 0.5),
    p90Ms: quantile(durations, 0.9),
    closedWithoutOpen: all.filter(item => item.open === undefined).length,
  }
}
