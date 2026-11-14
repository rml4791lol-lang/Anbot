// Validate the golden set: shape, type coverage, and that every source turn exists.
// Usage: node dev/eval/check-golden.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const file = new URL('./golden.jsonl', import.meta.url)
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const problems = []

const TYPES = ['交付', '调研', '代码', '群协作', '记忆', '排查']
const ids = new Set()
const counts = Object.fromEntries(TYPES.map(t => [t, 0]))

const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
const index = new Map()
for (const dir of fs.readdirSync(sessionsRoot)) {
  const folder = path.join(sessionsRoot, dir)
  if (!fs.statSync(folder).isDirectory()) continue
  for (const name of fs.readdirSync(folder)) {
    if (fs.existsSync(path.join(folder, name, 'session.v4.jsonl.zstd'))) index.set(name, path.join(folder, name, 'session.v4.jsonl.zstd'))
  }
}

for (const row of rows) {
  for (const key of ['id', 'type', 'task', 'context', 'expect', 'source', 'version']) {
    if (!(key in row)) problems.push(`${row.id || '?'}: missing ${key}`)
  }
  if (ids.has(row.id)) problems.push(`${row.id}: duplicate id`)
  ids.add(row.id)
  if (!TYPES.includes(row.type)) problems.push(`${row.id}: unknown type ${row.type}`)
  else counts[row.type] += 1
  if (!Array.isArray(row.expect) || row.expect.length < 2) problems.push(`${row.id}: expect needs at least two checks`)
  const [session, turnPart] = String(row.source).split('#turn')
  const turn = Number(turnPart)
  const sessionFile = index.get(session)
  if (!sessionFile) { problems.push(`${row.id}: session ${session} not found`); continue }
  const events = zlib.zstdDecompressSync(fs.readFileSync(sessionFile)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
  if (!events.some(e => e.type === 'turn/start' && e.data?.turn === turn)) problems.push(`${row.id}: turn ${turn} not found in ${session}`)
}

if (rows.length !== 24) problems.push(`expected 24 rows, found ${rows.length}`)
for (const t of TYPES) if (counts[t] < 3) problems.push(`type ${t} has ${counts[t]}, need at least 3`)

console.log(JSON.stringify({ rows: rows.length, counts, problems }, null, 2))
if (problems.length) process.exitCode = 1
