// The team board's lines. Each Bot owns one file under the team's state directory, so
// two Bots writing at once cannot lose each other's lines; the host merges them into
// one read-only feed. The directory lives outside the Bot home because the same files
// are also edited by hand and by scripts.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The one place the team's state directory is decided; DSH_ATLAS_STATE_DIR points the
// board at a copy somewhere else (a test, or another machine).
export const atlasStateDir = () => process.env.DSH_ATLAS_STATE_DIR ?? join(homedir(), 'Desktop', 'Atlas', '任务标准规范规则', '状态')
export const teamBoardDir = () => join(atlasStateDir(), 'board')

const KINDS = new Set(['delivery', 'decision', 'blocked'])
const FIELDS = ['bot', 'kind', 'what', 'number', 'evidence', 'needs', 'default', 'deadline', 'at']
const PER_BOT = 3

const asText = value => (value === undefined || value === null ? null : String(value))
const asTime = value => {
  const time = Date.parse(String(value ?? ''))
  return Number.isFinite(time) ? time : -Infinity
}
// A Bot name becomes one file name; anything a path could read as a directory is folded.
export const boardFileName = bot => `${String(bot).replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'bot'}.json`

// Missing fields are stored as null, so a reader never has to guess: null means the
// line has no number, no deadline, nothing to decide.
export function normalizeBoardLine(item, bot) {
  const line = {}
  for (const field of FIELDS) line[field] = asText(item?.[field])
  line.bot = bot
  return line
}

// Replaces this Bot's own file and nothing else: a Bot writes only the lines the board
// shows for it, and the other Bots' files stay as they are. Every line the Bot sends is
// also kept in the archive beside the board: the board shows three, the archive keeps
// what was reported done, so a later count does not depend on what is still on screen.
export function writeTeamBoard(bot, lines, dir = teamBoardDir()) {
  const rows = (Array.isArray(lines) ? lines : [])
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => normalizeBoardLine(item, bot))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, boardFileName(bot))
  const next = `${file}.${process.pid}.tmp`
  writeFileSync(next, `${JSON.stringify(rows, null, 2)}\n`)
  renameSync(next, file)
  try {
    archiveTeamBoardLines(bot, rows, boardArchiveDir(dir))
  } catch { /* the board itself is written; a missing archive is not a failed write */ }
  return rows.length
}

export const boardArchiveDir = (boardDir = teamBoardDir()) => join(boardDir, 'archive')
export function teamBoardArchiveSignature(dir = boardArchiveDir()) {
  try {
    return readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort().map((name) => {
      const stat = statSync(join(dir, name))
      return `${name}:${stat.size}:${stat.mtimeMs}`
    }).join('|')
  } catch (error) {
    return error?.code === 'ENOENT' ? '' : `error:${error?.code}:${error?.message}`
  }
}
const archiveFile = (bot, dir) => join(dir, boardFileName(bot).replace(/\.json$/, '') + '.jsonl')
const lineKey = line => `${line.bot}\u0000${line.at ?? ''}\u0000${line.what ?? ''}\u0000${line.kind ?? ''}`

export function archiveTeamBoardLines(bot, lines, dir = boardArchiveDir()) {
  const rows = (Array.isArray(lines) ? lines : []).filter(line => KINDS.has(line?.kind))
  if (rows.length === 0) return 0
  mkdirSync(dir, { recursive: true })
  const file = archiveFile(bot, dir)
  const seen = new Set()
  try {
    for (const row of readFileSync(file, 'utf8').split('\n')) {
      if (row === '') continue
      try { seen.add(lineKey(JSON.parse(row))) } catch { /* old torn row */ }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const fresh = []
  for (const line of rows) {
    const key = lineKey(line)
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(line)
  }
  if (fresh.length > 0) appendFileSync(file, fresh.map(line => JSON.stringify(line) + '\n').join(''))
  return fresh.length
}

// Every archived line once, oldest first. A line sent twice is one line here; a broken
// row is skipped, because the archive is a record, not the source of truth.
export function readTeamBoardArchive(dir = boardArchiveDir(), warn = () => {}) {
  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`team board archive: cannot read ${dir}: ${error.message}`)
    return []
  }
  const seen = new Set()
  const lines = []
  for (const name of names.sort()) {
    if (!name.endsWith('.jsonl')) continue
    let text
    try {
      text = readFileSync(join(dir, name), 'utf8')
    } catch (error) {
      warn(`team board archive: skipped ${name}: ${error.message}`)
      continue
    }
    let badRows = 0
    for (const row of text.split('\n')) {
      if (row === '') continue
      let line
      try {
        line = JSON.parse(row)
      } catch {
        badRows += 1
        continue
      }
      if (line === null || typeof line !== 'object' || Array.isArray(line) || !KINDS.has(line.kind) || typeof line.bot !== 'string' || line.bot === '' || typeof line.what !== 'string') {
        badRows += 1
        continue
      }
      const key = lineKey(line)
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(line)
    }
    if (badRows > 0) warn(`team board archive: skipped ${badRows} bad row${badRows === 1 ? '' : 's'} in ${name}`)
  }
  lines.sort((a, b) => asTime(a.at) - asTime(b.at))
  return lines
}

// A missing directory, a file that does not parse, or a line of an unknown kind is
// skipped with a warning: the board shows what is readable instead of nothing.
export function readTeamBoardLines(dir = teamBoardDir(), warn = () => {}) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const lines = []
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    const owner = name.slice(0, -'.json'.length)
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch (error) {
      warn(`team board: skipped ${name}: ${error.message}`)
      continue
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !KINDS.has(item.kind)) {
        warn(`team board: skipped a line in ${name}: kind ${item?.kind}`)
        continue
      }
      const line = normalizeBoardLine(item, asText(item.bot) ?? owner)
      lines.push(line)
    }
  }
  // Newest first. The sort is stable, so lines with the same timestamp keep file order.
  lines.sort((a, b) => asTime(b.at) - asTime(a.at))
  const counts = new Map()
  return lines.filter((line) => {
    const seen = counts.get(line.bot) ?? 0
    if (seen >= PER_BOT) return false
    counts.set(line.bot, seen + 1)
    return true
  })
}
