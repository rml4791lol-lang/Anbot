import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { CORRECTION_RE, collectMetrics, quantile, share } from '../dev/metrics.mjs'

const METRICS = fileURLToPath(new URL('../dev/metrics.mjs', import.meta.url))
const DAY = '2026-11-14'
const dayStart = new Date(2026, 10, 14).getTime()
const at = minutes => dayStart + minutes * 60_000

const botRow = overrides => ({
  ts: at(0),
  bot: 'Antbot',
  room: null,
  session: 's1',
  turn: 1,
  seed: { kind: 'user' },
  context: { bytes: 100, sources: [] },
  tools: { offered: [], used: ['bash'], errors: 0 },
  files: [],
  duration_ms: 1000,
  final_chars: 10,
  final_hash: 'h',
  outcome: 'completed',
  ...overrides
})

const writeLedger = (ledgerDir, lines) => {
  fs.writeFileSync(path.join(ledgerDir, `${DAY}.jsonl`), `${lines.join('\n')}\n`)
}

const writeUsage = (home, rows) => {
  const db = new DatabaseSync(path.join(home, 'bot', 'usage.sqlite'))
  db.exec('CREATE TABLE calls (key TEXT PRIMARY KEY, session TEXT, time INTEGER, provider TEXT, model TEXT, kind TEXT, live INTEGER, input INTEGER, cache_read INTEGER, cache_write INTEGER, output INTEGER)')
  const add = db.prepare('INSERT INTO calls VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  rows.forEach((row, index) => add.run(`k${index}`, row.session, row.time, 'p', 'm', 'chat', 1, row.input, 0, 0, row.output))
  db.close()
}

const writeChat = (home, rows) => {
  const db = new DatabaseSync(path.join(home, 'bot', 'chat-index.sqlite'))
  db.exec('CREATE TABLE lines (session TEXT, seq INTEGER, time REAL, who TEXT, text TEXT)')
  const add = db.prepare('INSERT INTO lines VALUES (?,?,?,?,?)')
  rows.forEach(row => add.run(row.session, row.seq, row.time, row.who, row.text))
  db.close()
}

const fixture = t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-bot-metrics-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  fs.mkdirSync(path.join(home, 'bot', 'ledger'), { recursive: true })
  return home
}

const ledgerRows = [
  botRow({ session: 's1', turn: 1, ts: at(0), duration_ms: 1000, context: { bytes: 100 }, tools: { used: ['bash'], errors: 0 }, final_chars: 10 }),
  botRow({ session: 's1', turn: 2, ts: at(10), duration_ms: 2000, context: { bytes: 200 }, tools: { used: [], errors: 0 }, final_chars: 0 }),
  botRow({ session: 's2', turn: 1, ts: at(20), duration_ms: 3000, context: { bytes: 300 }, tools: { used: ['skill'], errors: 0 }, final_chars: 5 }),
  botRow({ session: 's2', turn: 2, ts: at(30), duration_ms: null, context: { bytes: 400 }, tools: { used: ['bash'], errors: 1 }, final_chars: 0, outcome: 'open' }),
  botRow({ bot: null, session: 'mn-run', turn: 1, ts: at(40), tools: { used: ['bash', 'bash'], errors: 5 }, duration_ms: 9000, final_chars: 0 }),
  '{broken line',
  JSON.stringify({ ts: at(50), bot: 42, session: 'weird', turn: 1 }),
  JSON.stringify(botRow({ bot: 'Tomorrow', session: 's3', ts: at(24 * 60 + 1) }))
].map(line => (typeof line === 'string' ? line : JSON.stringify(line)))

const chatRows = [
  { session: 's1', seq: 1, time: at(1), who: 'you', text: 'done' },
  { session: 's1', seq: 2, time: at(2), who: 'bot', text: 'hello' },
  { session: 's1', seq: 3, time: at(5), who: 'user', text: '不对，重做' },
  { session: 's1', seq: 4, time: at(20), who: 'you', text: 'second' },
  { session: 's1', seq: 5, time: at(31), who: 'user', text: '错了' },
  { session: 's1', seq: 6, time: at(40), who: 'you', text: 'third' },
  { session: 's1', seq: 7, time: at(42), who: 'user', text: '好的，谢谢' },
  { session: 's1', seq: 8, time: at(60), who: 'you', text: 'fourth' },
  { session: 's1', seq: 9, time: at(70), who: 'user', text: '还是不对' },
  { session: 's1', seq: 10, time: at(80), who: 'you', text: 'fifth' }
]

const usageRows = [
  { session: 's1', time: at(6), input: 1000, output: 100 },
  { session: 's2', time: at(16), input: 2000, output: 200 },
  { session: 'mn-run', time: at(26), input: 99999, output: 999 },
  { session: 's1', time: at(24 * 60 + 6), input: 5000, output: 500 }
]

test('a ratio with no denominator is n/a, never 0%', () => {
  assert.equal(share(0, 0), 'n/a')
  assert.equal(share(0, 4), '0/4 (0%)')
  assert.equal(share(1, 3), '1/3 (33%)')
  assert.equal(quantile([], 0.5), 'n/a')
  assert.equal(quantile([1, 2, 3], 0.5), 2)
})

test('collects a day, ignoring unrelated ledger files, bad lines and other sessions', t => {
  const home = fixture(t)
  const ledgerDir = path.join(home, 'bot', 'ledger')
  writeLedger(ledgerDir, ledgerRows)
  fs.writeFileSync(path.join(ledgerDir, 'pair-session-abc.jsonl'), `${JSON.stringify(botRow({ bot: 'Ghost', session: 'ghost' }))}\n`)
  fs.writeFileSync(path.join(ledgerDir, 'notes.txt'), 'not a ledger\n')
  fs.writeFileSync(path.join(ledgerDir, `${DAY}.jsonl.bak`), `${JSON.stringify(botRow({ bot: 'Backup', session: 'backup' }))}\n`)
  writeUsage(home, usageRows)
  writeChat(home, chatRows)

  const metrics = collectMetrics({ day: DAY, ledgerDir, home })
  assert.equal(metrics.day, DAY)
  assert.equal(metrics.ledgerRows, 6)
  assert.equal(metrics.botTurns, 4)
  assert.deepEqual(metrics.zeroTool, { n: 1, m: 4, value: '1/4 (25%)' })
  assert.deepEqual(metrics.toolErrorRate, { n: 1, m: 3, value: '1/3 (33%)' })
  assert.deepEqual(metrics.emptyAnswerRate, { n: 2, m: 4, value: '2/4 (50%)' })
  assert.deepEqual(metrics.durationMs, { p50: 2000, p90: 3000, n: 3 })
  assert.deepEqual(metrics.injectedChars, { p90: 400, n: 4 })
  assert.deepEqual(metrics.skillCalls, { n: 1, m: 4 })
  assert.deepEqual(metrics.tokens, { input: 3000, output: 300, calls: 2 })
})

test('a correction is the next user message within 10 minutes, not another Bot message', t => {
  const home = fixture(t)
  const ledgerDir = path.join(home, 'bot', 'ledger')
  writeLedger(ledgerDir, ledgerRows)
  writeChat(home, chatRows)

  const { userCorrections } = collectMetrics({ day: DAY, ledgerDir, home })
  assert.equal(userCorrections.m, 4)
  assert.equal(userCorrections.n, 2)
  assert.equal(userCorrections.value, '2/4 (50%)')
  assert.equal(userCorrections.windowMinutes, 10)
  assert.equal(userCorrections.regex, String(CORRECTION_RE))
})

test('a day without turns reports n/a everywhere and still prints the regex', t => {
  const home = fixture(t)
  const ledgerDir = path.join(home, 'bot', 'ledger')
  writeLedger(ledgerDir, ledgerRows)
  writeChat(home, chatRows)

  const metrics = collectMetrics({ day: '2026-11-13', ledgerDir, home })
  assert.equal(metrics.botTurns, 0)
  assert.deepEqual(metrics.zeroTool, { n: 0, m: 0, value: 'n/a' })
  assert.deepEqual(metrics.toolErrorRate, { n: 0, m: 0, value: 'n/a' })
  assert.deepEqual(metrics.emptyAnswerRate, { n: 0, m: 0, value: 'n/a' })
  assert.deepEqual(metrics.durationMs, { p50: 'n/a', p90: 'n/a', n: 0 })
  assert.deepEqual(metrics.injectedChars, { p90: 'n/a', n: 0 })
  assert.deepEqual(metrics.tokens, { input: 'n/a', output: 'n/a', calls: 0 })
  assert.equal(metrics.userCorrections.value, 'n/a')

  const output = execFileSync(process.execPath, [METRICS, '--day', '2026-11-13', '--ledger-dir', ledgerDir], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8'
  })
  assert.match(output, /zero-tool n\/a/)
  assert.match(output, /duration ms: p50 n\/a/)
  assert.match(output, /correction regex: \//)
})

test('the CLI prints one JSON object for --json', t => {
  const home = fixture(t)
  const ledgerDir = path.join(home, 'bot', 'ledger')
  writeLedger(ledgerDir, ledgerRows)
  writeUsage(home, usageRows)
  writeChat(home, chatRows)

  const output = execFileSync(process.execPath, [METRICS, '--day', DAY, '--ledger-dir', ledgerDir, '--json'], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8'
  })
  assert.equal(output.trim().split('\n').length, 1)
  const parsed = JSON.parse(output)
  assert.equal(parsed.botTurns, 4)
  assert.equal(parsed.userCorrections.value, '2/4 (50%)')
  assert.equal(parsed.userCorrections.regex, String(CORRECTION_RE))
})
