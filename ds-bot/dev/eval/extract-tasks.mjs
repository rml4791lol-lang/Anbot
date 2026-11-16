// Extract user tasks from Bot sessions so a golden set can be built from real turns.
// Usage: node dev/eval/extract-tasks.mjs [--since YYYY-MM-DD] [--json]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
const args = process.argv.slice(2)
const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : null
const botsOnly = args.includes('--bots')
const json = args.includes('--json')
const sinceMs = since ? new Date(`${since}T00:00:00+08:00`).getTime() : 0

/** Read one zstd session log as parsed events. */
function readSession(file) {
  const text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/** Pull user-authored turns: text, turn number, and the tools that ran in that turn. */
function userTurns(events) {
  const turns = []
  let pending = null
  for (const ev of events) {
    if (ev.type === 'agent/inbox/spliced' && ev.data?.inserted) {
      for (const msg of ev.data.inserted) {
        if (msg.source?.kind !== 'user') continue
        const text = (msg.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
        if (text) pending = { text, time: ev.time }
      }
      continue
    }
    if (ev.type === 'turn/start' && pending) {
      turns.push({ ...pending, turn: ev.data.turn, tools: 0 })
      pending = null
      continue
    }
    if (ev.type === 'turn/end' && turns.length) {
      const last = turns[turns.length - 1]
      if (last.turn === ev.data.turn) last.endedAt = ev.time
      continue
    }
    if (ev.type === 'tool/call' && turns.length && turns[turns.length - 1].turn === ev.data.turn) {
      turns[turns.length - 1].tools += 1
      const names = (turns[turns.length - 1].toolNames ||= [])
      if (!names.includes(ev.data.name)) names.push(ev.data.name)
    }
  }
  return turns
}

let botSessions = null
if (botsOnly) {
  const state = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'bot', 'state.json'), 'utf8'))
  botSessions = new Set()
  for (const bot of Object.values(state.bots || {})) {
    if (bot.sessionId) botSessions.add(bot.sessionId)
    for (const seg of bot.segments || []) if (seg.sessionId) botSessions.add(seg.sessionId)
  }
  for (const room of Object.values(state.rooms || {})) {
    if (room.sessionId) botSessions.add(room.sessionId)
    for (const id of Object.values(room.sessions || {})) botSessions.add(id)
  }
}

const out = []
for (const dir of fs.readdirSync(sessionsRoot)) {
  const folder = path.join(sessionsRoot, dir)
  if (!fs.statSync(folder).isDirectory()) continue
  for (const name of fs.readdirSync(folder)) {
    const file = path.join(folder, name, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(file)) continue
    const events = readSession(file)
    if (!events.length) continue
    if (botSessions && !botSessions.has(path.basename(path.dirname(file)))) continue
    const first = events[0]
    if (first.type !== 'session') continue
    const isBot = /\.dsh[\\/]bot[\\/]workspace|bot-workspace/.test(first.cwd || '') ||
      (first.cwd || '').includes('.dsh/bot/workspace')
    const turns = userTurns(events.map(e => ({ ...e, __file: file })))
    for (const t of turns) {
      if (t.time < sinceMs) continue
      out.push({
        session: path.basename(path.dirname(file)),
        cwd: first.cwd,
        isBot,
        turn: t.turn,
        time: new Date(t.time).toISOString(),
        tools: t.tools,
        toolNames: t.toolNames || [],
        text: t.text
      })
    }
  }
}

out.sort((a, b) => (a.time < b.time ? 1 : -1))
if (json) {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
} else {
  const bySession = new Map()
  for (const t of out) bySession.set(t.session, (bySession.get(t.session) || 0) + 1)
  console.log(`${out.length} user turns across ${bySession.size} sessions`)
  for (const t of out.slice(0, 30)) {
    console.log(`${t.time.slice(0, 16)} t${t.turn} tools=${t.tools} ${t.text.replace(/\s+/g, ' ').slice(0, 90)}`)
  }
}
