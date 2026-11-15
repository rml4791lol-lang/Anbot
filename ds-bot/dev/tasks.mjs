#!/usr/bin/env node
// How much of the work Bots hand each other actually comes back.
//
//   node dev/tasks.mjs [--days 7] [--now ISO] [--json]
//
// Reads <home>/ledger/tasks-<day>.jsonl, written by src/host/task-ledger.js. Reads
// only: no session, no message text, no state.json.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readTaskLedger, summarizeTasks } from '../src/host/task-ledger.js'
import { readTeamBoardArchive } from '../src/host/team-board-feed.js'

const home = process.env.DS_BOT_HOME ?? join(homedir(), '.dsh', 'bot')
const args = process.argv.slice(2)
const daysArg = args.indexOf('--days')
const days = daysArg === -1 ? 7 : Number(args[daysArg + 1])
if (!Number.isInteger(days) || days < 1) { console.error('--days needs a positive integer'); process.exit(2) }
const nowArg = args.indexOf('--now')
const now = nowArg === -1 ? Date.now() : Date.parse(args[nowArg + 1])
if (!Number.isFinite(now)) { console.error('--now needs an ISO date and time'); process.exit(2) }

const since = now - days * 86_400_000
const { rows, files, days: daysSeen } = readTaskLedger(join(home, 'ledger'), since, now)

const summary = summarizeTasks(rows)

// The board's own record of what Bots reported as done. Kept apart from the work
// ledger: a delivery line says something finished, a closed work says an answer came
// back. Counting them together would report one thing twice.
const allBoard = readTeamBoardArchive()
const board = allBoard.filter((line) => {
  const at = Date.parse(String(line.at ?? ''))
  return Number.isFinite(at) && at >= since && at < now
})
const undatedBoard = allBoard.length - allBoard.filter(line => Number.isFinite(Date.parse(String(line.at ?? '')))).length
const kindCount = kind => board.filter(line => line.kind === kind).length

if (args.includes('--json')) {
  console.log(JSON.stringify({
    days,
    since: new Date(since).toISOString(),
    until: new Date(now).toISOString(),
    files,
    daysSeen,
    ...summary,
    board: { total: board.length, delivery: kindCount('delivery'), decision: kindCount('decision'), blocked: kindCount('blocked'), undated: undatedBoard },
  }, null, 2))
  process.exit(0)
}

const secs = ms => (ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(1)}s`)
console.log(`task ledger: last ${days} day(s), ${files.length} file(s), ${rows.length} row(s), ${daysSeen.length} day(s) with rows`)
console.log(`opened      ${summary.opened}`)
console.log(`closed      ${summary.closed}`)
console.log(`answered    ${summary.answered}`)
console.log(`abandoned   ${summary.abandoned}`)
if (summary.unclassified) console.log(`unclassified ${summary.unclassified}`)
console.log(`pending     ${summary.pending}`)
console.log(`completion  ${summary.completion}`)
console.log(`abandon     ${summary.abandonRate}`)
console.log(`open→close  p50 ${secs(summary.p50Ms)}  p90 ${secs(summary.p90Ms)}`)
console.log(`board       ${board.length} line(s): ${kindCount('delivery')} delivery, ${kindCount('decision')} decision, ${kindCount('blocked')} blocked`)
if (summary.closedWithoutOpen) console.log(`note        ${summary.closedWithoutOpen} close row(s) had no open row in the window`)
if (undatedBoard) console.log(`note        ${undatedBoard} board row(s) have no readable timestamp`)
