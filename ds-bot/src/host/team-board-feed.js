// The team board's lines. Each Bot owns one file under the team's state directory, so
// two Bots writing at once cannot lose each other's lines; the host merges them into
// one read-only feed. The directory lives outside the Bot home because the same files
// are also edited by hand and by scripts.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
// shows for it, and the other Bots' files stay as they are.
export function writeTeamBoard(bot, lines, dir = teamBoardDir()) {
  const rows = (Array.isArray(lines) ? lines : [])
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => normalizeBoardLine(item, bot))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, boardFileName(bot))
  const next = `${file}.${process.pid}.tmp`
  writeFileSync(next, `${JSON.stringify(rows, null, 2)}\n`)
  renameSync(next, file)
  return rows.length
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
