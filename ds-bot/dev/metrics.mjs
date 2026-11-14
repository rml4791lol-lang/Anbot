// Daily production metrics: Bot turns, tools, answers, context and token use.
//
// Read-only and offline. The numbers come from three places the Bot team already keeps:
// the turn ledger (one row per turn), the chat index (Bot replies and user messages) and
// the usage table (model calls). Every ratio prints its own denominator; a ratio with no
// data prints n/a, never 0% — "no failures" and "no turns" are different facts.
//
// Usage: node dev/metrics.mjs [--day 2026-11-15] [--ledger-dir DIR] [--json]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const LEDGER_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const CORRECTION_WINDOW_MS = 10 * 60_000
// In the chat index the Bot reading its own chat is "you"; "user" is the human and
// "bot" is a message from another Bot.
const BOT_REPLY_WHO = 'you'
const USER_WHO = 'user'

// One rule for "the user pushed back": a negation or a request to redo/repeat. Kept in
// one place and printed verbatim with every report, so a rate can be traced to its rule.
export const CORRECTION_RE =
  /不对|不是(?:这个|这样|我要的|让你)|错了|搞错|弄错|说错|写错|又错|还是错|没对|不行|没用(?!过)|不好用|不能用|用不了|算了|没必要|重做|重写|重来|重新(?:做|写|生成|来|看|试|回答)?|再来|再试|再改|改一下|改改|漏了|漏掉|少(?:了|写|做)|没做|没完成|没做完|没解决|没处理|没改|没听懂|没看懂|没理解|看不懂|答非所问|跑题|你确定|确定吗|我说的是|我的意思是|不是让你|谁让你|你不是说|忘了|记不住|没记住|不够(?:好|完善|全面|清楚|准确|具体|深入)|没有(?:真正|仔细|中心|重点|条理|逻辑|按|做|改|完成|解决|处理|回答|回复)|根本不会|不会(?:调研|思考|做|写|用)|不过脑子|短视|发不明白|说不明白|讲不明白|为什么(?:还|又|没|不)|怎么(?:还|又|没)|刚才.*(?:错|不对|没)|上一条.*(?:错|不对|没)|前面.*(?:错|不对|没)|重问|再问|重复(?:一下|一遍)|再说一遍/i

export const share = (n, m) => (m === 0 ? 'n/a' : `${n}/${m} (${Math.round((n / m) * 100)}%)`)

export const quantile = (values, p) => {
  if (values.length === 0) return 'n/a'
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.round((sorted.length - 1) * p)]
}

export const localDay = (now = new Date()) => {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const date = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${date}`
}

// Local midnight to the next local midnight, so a day keeps its length across DST too.
export const dayWindow = (day) => {
  const [year, month, date] = day.split('-').map(Number)
  return { start: new Date(year, month - 1, date).getTime(), end: new Date(year, month - 1, date + 1).getTime() }
}

const namesOf = row => (Array.isArray(row.tools?.used) ? row.tools.used.filter(name => typeof name === 'string') : [])
const isBotTurn = row => typeof row.bot === 'string' && row.bot !== ''

// Every dated ledger file, rows filtered by event time: a file holds the day it was
// written for, but the turn/start time decides which day a turn belongs to.
export function readLedger(ledgerDir, start, end) {
  if (!fs.existsSync(ledgerDir)) return []
  const rows = []
  for (const name of fs.readdirSync(ledgerDir).sort()) {
    if (!LEDGER_FILE_RE.test(name)) continue
    const text = fs.readFileSync(path.join(ledgerDir, name), 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      if (typeof row.ts !== 'number' || row.ts < start || row.ts >= end) continue
      rows.push(row)
    }
  }
  return rows
}

// Model calls of the sessions that had a Bot turn that day. Other sessions in the same
// profile (maintenance runs, eval runs) are not production traffic.
function readUsage(home, start, end, sessions) {
  const empty = { input: 'n/a', output: 'n/a', calls: 0 }
  if (sessions.size === 0) return empty
  const file = path.join(home, 'bot', 'usage.sqlite')
  if (!fs.existsSync(file)) return empty
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = db.prepare('SELECT session, input, output FROM calls WHERE time >= ? AND time < ?').all(start, end)
    const mine = rows.filter(row => sessions.has(row.session))
    if (mine.length === 0) return empty
    return {
      input: mine.reduce((sum, row) => sum + (Number(row.input) || 0), 0),
      output: mine.reduce((sum, row) => sum + (Number(row.output) || 0), 0),
      calls: mine.length
    }
  } finally {
    db.close()
  }
}

// Proxy for a user correction: the Bot reply has a later user message, and the next user
// message arrives within 10 minutes and matches CORRECTION_RE. The denominator is replies
// with a user follow-up, not all replies (plan §10); a follow-up after the window is
// eligible but not a hit.
function readCorrections(home, start, end) {
  const result = { n: 0, m: 0, value: 'n/a', windowMinutes: CORRECTION_WINDOW_MS / 60_000, regex: String(CORRECTION_RE) }
  const file = path.join(home, 'bot', 'chat-index.sqlite')
  if (!fs.existsSync(file)) return result
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = db.prepare('SELECT session, seq, time, who, text FROM lines ORDER BY session, time, seq').all()
    const bySession = new Map()
    for (const row of rows) {
      const list = bySession.get(row.session)
      if (list) list.push(row)
      else bySession.set(row.session, [row])
    }
    for (const list of bySession.values()) {
      for (let index = 0; index < list.length; index += 1) {
        const reply = list[index]
        if (reply.who !== BOT_REPLY_WHO || reply.time < start || reply.time >= end) continue
        let next = index + 1
        while (next < list.length && list[next].who !== USER_WHO) next += 1
        if (next === list.length) continue
        result.m += 1
        const followUp = list[next]
        if (followUp.time - reply.time <= CORRECTION_WINDOW_MS && CORRECTION_RE.test(followUp.text ?? '')) result.n += 1
      }
    }
    result.value = share(result.n, result.m)
    return result
  } finally {
    db.close()
  }
}

export function collectMetrics({ day, ledgerDir, home }) {
  const { start, end } = dayWindow(day)
  const rows = readLedger(ledgerDir, start, end)
  const turns = rows.filter(isBotTurn)
  const toolCalls = turns.reduce((sum, row) => sum + namesOf(row).length, 0)
  const toolErrors = turns.reduce((sum, row) => sum + (Number.isFinite(row.tools?.errors) ? row.tools.errors : 0), 0)
  const zeroTool = turns.filter(row => namesOf(row).length === 0).length
  const emptyAnswers = turns.filter(row => (row.final_chars ?? 0) === 0).length
  const durations = turns.map(row => row.duration_ms).filter(value => Number.isFinite(value) && value >= 0)
  const injected = turns.map(row => row.context?.bytes).filter(value => Number.isFinite(value) && value >= 0)
  const skillCalls = turns.reduce((sum, row) => sum + namesOf(row).filter(name => name === 'skill').length, 0)
  const sessions = new Set(turns.map(row => row.session).filter(id => typeof id === 'string'))
  return {
    day,
    ledgerRows: rows.length,
    botTurns: turns.length,
    zeroTool: { n: zeroTool, m: turns.length, value: share(zeroTool, turns.length) },
    toolErrorRate: { n: toolErrors, m: toolCalls, value: share(toolErrors, toolCalls) },
    emptyAnswerRate: { n: emptyAnswers, m: turns.length, value: share(emptyAnswers, turns.length) },
    durationMs: { p50: quantile(durations, 0.5), p90: quantile(durations, 0.9), n: durations.length },
    injectedChars: { p90: quantile(injected, 0.9), n: injected.length },
    skillCalls: { n: skillCalls, m: turns.length },
    tokens: readUsage(home, start, end, sessions),
    userCorrections: readCorrections(home, start, end)
  }
}

export function renderSummary(metrics) {
  const tokens = metrics.tokens.calls === 0
    ? 'n/a (0 calls)'
    : `input ${metrics.tokens.input} · output ${metrics.tokens.output} (${metrics.tokens.calls} calls)`
  return [
    `day ${metrics.day}: ${metrics.botTurns} Bot turns (${metrics.ledgerRows} ledger rows)`,
    `zero-tool ${metrics.zeroTool.value} · tool-error ${metrics.toolErrorRate.value} · empty-answer ${metrics.emptyAnswerRate.value}`,
    `duration ms: p50 ${metrics.durationMs.p50} · p90 ${metrics.durationMs.p90} (n=${metrics.durationMs.n}) · injected chars p90 ${metrics.injectedChars.p90} (n=${metrics.injectedChars.n})`,
    `skill calls: ${metrics.skillCalls.n} over ${metrics.skillCalls.m} turns`,
    `tokens: ${tokens}`,
    `user correction proxy: ${metrics.userCorrections.value} (next user message within ${metrics.userCorrections.windowMinutes} min; ${metrics.userCorrections.m} replies had one)`,
    `correction regex: ${metrics.userCorrections.regex}`
  ].join('\n')
}

const args = process.argv.slice(2)
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)

const main = () => {
  const day = arg('--day', localDay())
  if (typeof day !== 'string' || !DAY_RE.test(day)) {
    console.error('usage: node dev/metrics.mjs [--day YYYY-MM-DD] [--ledger-dir DIR] [--json]')
    process.exit(2)
  }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const ledgerDir = arg('--ledger-dir', path.join(home, 'bot', 'ledger'))
  const metrics = collectMetrics({ day, ledgerDir, home })
  console.log(args.includes('--json') ? JSON.stringify(metrics) : renderSummary(metrics))
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main()
