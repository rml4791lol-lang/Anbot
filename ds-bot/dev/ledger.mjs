// The turn ledger: one line per Bot turn, written on the host, read by everyone.
//
// This is the observation record the improvement loop runs on. It is append-only and
// idempotent: re-running the same day rewrites nothing, and a turn already in the file
// is skipped. Messages are never copied in — only sizes, hashes, tool names and paths.
//
// Usage: node dev/ledger.mjs [--day 2026-11-14] [--out ~/.dsh/bot/ledger]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

const args = process.argv.slice(2)
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const day = arg('--day', new Date().toISOString().slice(0, 10))
const outDir = arg('--out', path.join(os.homedir(), '.dsh', 'bot', 'ledger'))
const home = path.join(os.homedir(), '.dsh')
const dayStart = new Date(`${day}T00:00:00+08:00`).getTime()
const dayEnd = dayStart + 86_400_000

const state = JSON.parse(fs.readFileSync(path.join(home, 'bot', 'state.json'), 'utf8'))
const botOf = new Map()
const roomOf = new Map()
for (const bot of Object.values(state.bots ?? {})) {
  for (const id of [bot.sessionId, ...(bot.segments ?? []).map(s => s.sessionId)]) if (id) botOf.set(id, bot.name)
  for (const room of Object.values(state.rooms ?? {})) for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) if (botId === bot.id) roomOf.set(sessionId, room.name)
}
const sessionsRoot = path.join(home, 'sessions')
const files = []
for (const dir of fs.readdirSync(sessionsRoot)) {
  const folder = path.join(sessionsRoot, dir)
  if (!fs.statSync(folder).isDirectory()) continue
  for (const name of fs.readdirSync(folder)) {
    const file = path.join(folder, name, 'session.v4.jsonl.zstd')
    if (fs.existsSync(file)) files.push({ id: name, file })
  }
}

// A source label from the head of an injected message, so the ledger says what it paid for.
const sourceOf = text => {
  const head = text.slice(0, 200)
  if (head.includes('<openviking-context')) return 'openviking'
  if (head.includes('Available skills') || head.includes('SKILL.md')) return 'skills'
  if (head.trimStart().startsWith('# Global Instructions') || head.includes('AGENTS.md')) return 'agents-md'
  if (head.includes('[Your profile was updated')) return 'note'
  if (head.includes('Group chat')) return 'group'
  return 'other'
}

const records = []
for (const { id, file } of files) {
  const events = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
  let turn = null
  const flush = () => {
    if (turn !== null && turn.start >= dayStart && turn.start < dayEnd) records.push(turn)
    turn = null
  }
  for (const ev of events) {
    const time = ev.time ?? 0
    if (ev.type === 'turn/start') { flush(); turn = { session: id, turn: ev.data?.turn, start: time, tools: [], files: [], injected: {}, seed: null, chars: 0, hash: '' } ; continue }
    if (turn === null) continue
    if (ev.type === 'turn/end') { turn.end = time; turn.outcome = ev.data?.reason ?? 'completed'; flush(); continue }
    if (ev.type === 'agent/inbox/spliced' && time >= turn.start) {
      for (const item of ev.data?.inserted ?? []) {
        const kind = item.source?.kind
        if (['user', 'bot', 'schedule', 'tool-jobs', 'user-question-reply'].includes(kind)) {
          turn.seed ??= { kind, role: item.source?.role ?? null, form: item.source?.form ?? null }
        } else {
          const text = item.text ?? (item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('')
          if (text) { const label = sourceOf(text); turn.injected[label] = (turn.injected[label] ?? 0) + text.length }
        }
      }
      continue
    }
    if (ev.type === 'user/message' && time >= turn.start && !turn.seed) {
      const source = ev.data?.source ?? {}
      const content = ev.data?.message?.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(c => c.text ?? '').join('') : ''
      if (source.kind === 'user' || source.kind === 'bot' || source.kind === 'schedule' || source.kind === 'tool-jobs') {
        turn.seed = { kind: source.kind, role: source.role ?? null, form: source.form ?? null }
      } else if (text) {
        const label = sourceOf(text)
        turn.injected[label] = (turn.injected[label] ?? 0) + text.length
      }
      continue
    }
    if (ev.type === 'tool/call') {
      turn.tools.push(ev.data?.name ?? '?')
      try {
        const argsObj = JSON.parse(ev.data?.arguments ?? '{}')
        for (const key of ['path', 'file', 'file_path', 'target']) if (typeof argsObj[key] === 'string') turn.files.push(argsObj[key])
      } catch { /* arguments are opaque */ }
      continue
    }
    if (ev.type === 'tool/result' && ev.data?.message?.isError) turn.toolErrors = (turn.toolErrors ?? 0) + 1
    if (ev.type === 'assistant/message') {
      const text = (ev.data?.message?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('')
      if (text) { turn.chars += text.length; turn.hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) }
    }
  }
  flush()
}

const outFile = path.join(outDir, `${day}.jsonl`)
fs.mkdirSync(outDir, { recursive: true })
const known = new Set()
if (fs.existsSync(outFile)) for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
  if (!line) continue
  try { const r = JSON.parse(line); known.add(`${r.session}#${r.turn}`) } catch { /* half-written */ }
}
const fresh = records.filter(r => !known.has(`${r.session}#${r.turn}`))
const lines = fresh.map(r => JSON.stringify({
  ts: r.start,
  bot: botOf.get(r.session) ?? null,
  room: roomOf.get(r.session) ?? null,
  session: r.session,
  turn: r.turn,
  seed: r.seed,
  context: { bytes: Object.values(r.injected).reduce((a, b) => a + b, 0), sources: r.injected },
  tools: { offered: [], used: r.tools, errors: r.toolErrors ?? 0 },
  files: r.files,
  duration_ms: r.end ? r.end - r.start : null,
  final_chars: r.chars,
  final_hash: r.hash,
  outcome: r.outcome ?? 'open'
}))
fs.appendFileSync(outFile, lines.join('\n') + (lines.length ? '\n' : ''))
console.log(JSON.stringify({ day, turns: records.length, appended: fresh.length, file: outFile }))
