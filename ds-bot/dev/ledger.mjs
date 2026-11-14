// The turn ledger: one line per Bot turn, written on the host, read by everyone.
//
// Append-only and idempotent: re-running a day rewrites nothing and skips turns already
// recorded. Messages are never copied in — only sizes, hashes, tool names and paths.
//
// Attribution: the host queues an injection before the turn it belongs to. A `next-turn`
// item belongs to the next turn/start, a `next-step` item to the turn already running.
// Both are counted, so context.bytes answers "what did this turn actually have to work with".
//
// Usage: node dev/ledger.mjs [--day 2026-11-14] [--out ~/.dsh/bot/ledger]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { TEAM_TOOLS } from '../src/host/constants.js'

const args = process.argv.slice(2)
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const day = arg('--day', new Date().toISOString().slice(0, 10))
const outDir = arg('--out', path.join(os.homedir(), '.dsh', 'bot', 'ledger'))
const home = path.join(os.homedir(), '.dsh')
const dayStart = new Date(`${day}T00:00:00+08:00`).getTime()
const dayEnd = dayStart + 86_400_000

const state = JSON.parse(fs.readFileSync(path.join(home, 'bot', 'state.json'), 'utf8'))
const capsOf = new Map()
for (const bot of Object.values(state.bots ?? {})) {
  capsOf.set(bot.name ?? bot.id, (bot.capabilities ?? []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean))
}
// Offered = the team tools plus whatever the bot mounted. Tools a capability brings
// beyond its own name are counted by the capability's name; the used[] side stays exact.
const offeredFor = name => {
  const extra = capsOf.get(name) ?? []
  return [...TEAM_TOOLS, ...extra.filter(n => !TEAM_TOOLS.includes(n))]
}
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
const textOf = item => item.text ?? (item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('')
const SEEDS = new Set(['user', 'bot', 'schedule', 'tool-jobs', 'user-question-reply'])

const records = []
for (const { id, file } of files) {
  const events = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
  const turns = []
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].type === 'turn/start') turns.push({ index: i, turn: events[i].data?.turn, start: events[i].time, injected: {}, seed: null, tools: [], files: [], chars: 0, hash: '' })
  }
  if (!turns.length) continue
  // The turn running at `index`, or the next one when the item is queued ahead of a start.
  const running = index => {
    let lo = 0; let hi = turns.length - 1; let found = null
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (turns[mid].index <= index) { found = turns[mid]; lo = mid + 1 } else hi = mid - 1 }
    return found
  }
  const next = index => turns.find(t => t.index > index) ?? null
  const ownerOf = (index, target) => (target === 'next-turn' ? next(index) : (running(index) ?? next(index)))

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]
    if (ev.type === 'turn/end') {
      const turn = running(i)
      if (turn) { turn.end = ev.time; turn.outcome = ev.data?.reason?.kind ?? (typeof ev.data?.reason === 'string' ? ev.data.reason : 'completed') }
      continue
    }
    if (ev.type === 'agent/inbox/spliced') {
      const target = ev.data?.target
      const turn = ownerOf(i, target)
      if (!turn) continue
      for (const item of ev.data?.inserted ?? []) {
        const kind = item.source?.kind
        const text = textOf(item)
        if (!text) continue
        if (SEEDS.has(kind)) { turn.seed ??= { kind, role: item.source?.role ?? null, form: item.source?.form ?? null } }
        else { const label = sourceOf(text); turn.injected[label] = (turn.injected[label] ?? 0) + text.length }
      }
      continue
    }
    if (ev.type === 'tool/call') {
      const turn = running(i)
      if (!turn) continue
      turn.tools.push(ev.data?.name ?? '?')
      try {
        const callArgs = JSON.parse(ev.data?.arguments ?? '{}')
        for (const key of ['path', 'file', 'file_path', 'target']) if (typeof callArgs[key] === 'string') turn.files.push(callArgs[key])
      } catch { /* arguments are opaque */ }
      continue
    }
    if (ev.type === 'tool/result' && ev.data?.message?.isError) { const turn = running(i); if (turn) turn.toolErrors = (turn.toolErrors ?? 0) + 1; continue }
    if (ev.type === 'assistant/message') {
      const turn = running(i)
      if (!turn) continue
      const text = (ev.data?.message?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('')
      if (text) { turn.chars += text.length; turn.hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) }
    }
  }
  for (const turn of turns) if (turn.start >= dayStart && turn.start < dayEnd) records.push({ session: id, ...turn })
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
  tools: { offered: offeredFor(botOf.get(r.session) ?? ''), used: r.tools, errors: r.toolErrors ?? 0 },
  files: r.files,
  duration_ms: r.end ? r.end - r.start : null,
  final_chars: r.chars,
  final_hash: r.hash,
  outcome: r.outcome ?? 'open'
}))
fs.appendFileSync(outFile, lines.join('\n') + (lines.length ? '\n' : ''))
console.log(JSON.stringify({ day, turns: records.length, appended: fresh.length, file: outFile }))
