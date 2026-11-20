// Classify a failed golden task as a process failure or a content failure.
// A process failure means the Bot never got to deliver: the loop spun, a tool was
// blocked, the step or context budget ran out, or the run errored. A content failure
// means it delivered, and the delivery was wrong or unverifiable.
// Fix process failures in the harness before spending anything on weights.
//
//   node dev/eval/failures.mjs --answers answers/base
//   node dev/eval/failures.mjs --answers answers/base --out /tmp/failures.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChecks } from './checks.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

export const KINDS = ['process', 'content']

// One marker per way the harness can stop a Bot short, in the order the checker tries them.
// Patterns are matched against the answer text and the failing check's detail.
export const MARKERS = [
  { kind: 'process', class: 'repeat-call', re: /\b(same|identical|repeated)\b[^.\n]{0,40}\b(tool call|command|file read)\b|\bloop detected\b|\bstuck in a loop\b/i },
  { kind: 'process', class: 'tool-blocked', re: /\b(permission denied|not in checks\.allow|operation not permitted|EACCES|command not allowed|tool (is )?(blocked|disabled))\b/i },
  { kind: 'process', class: 'step-limit', re: /\b(max(imum)? steps|step limit|step budget|out of steps|max-steps)\b/i },
  { kind: 'process', class: 'context-limit', re: /\b(context (window|limit)|context_length_exceeded|too many tokens|truncated)\b/i },
  { kind: 'process', class: 'turn-crash', re: /\b(turn (failed|aborted)|run errored|model error|stream (error|closed)|timeout after)\b/i },
  // Everything else that failed a check delivered the wrong thing.
  { kind: 'content', class: 'wrong-delivery' }
]

export function classify({ delivered, text = '', detail = '' }) {
  if (!delivered) {
    const hay = `${text}\n${detail}`
    const hit = MARKERS.filter(m => m.re).find(m => m.re.test(hay))
    return { kind: 'process', class: hit?.class ?? 'no-delivery', evidence: hit ? (hay.match(hit.re)?.[0] ?? '') : '' }
  }
  const hay = `${text}\n${detail}`
  const hit = MARKERS.find(m => m.re && m.re.test(hay))
  if (hit) return { kind: 'process', class: hit.class, evidence: hay.match(hit.re)?.[0] ?? '' }
  return { kind: 'content', class: 'wrong-delivery', evidence: detail.slice(0, 200) }
}

// Turns judge results ({ id, error }) and check results ({ id, total, passed, results })
// into one row per golden id. `delivered` is the judge's answer: did the Bot produce an
// answer at all. A task that passed its checks is not a failure and gets no class.
export function classifyRun({ ids, answers, checks, judged = new Map() }) {
  return ids.map(id => {
    const check = checks.get(id)
    const judge = judged.get(id)
    if (check?.passed) return { id, failed: false, kind: null, class: null, evidence: '' }
    const file = path.join(answers, `${id}.md`)
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const delivered = judge ? !judge.error : text.trim() !== ''
    const detail = check?.total ? (check.results.find(r => !r.ok)?.detail ?? '') : (judge?.error ?? (text.trim() === '' ? 'no answer file' : 'no checks, judge did not run'))
    const result = classify({ delivered, text, detail })
    return { id, failed: true, ...result, detail }
  })
}

export function summarize(rows) {
  const failed = rows.filter(r => r.failed)
  const count = (key) => failed.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] ?? 0) + 1 }), {})
  return {
    tasks: rows.length,
    failed: failed.length,
    byKind: count('kind'),
    byClass: count('class'),
    rows: failed
  }
}

function checksFor(answers) {
  const rows = fs.readFileSync(path.join(here, 'golden.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  return new Map(rows.map(row => [row.id, runChecks(row, { cwd: process.cwd(), answers })]))
}

const USAGE = `usage: node dev/eval/failures.mjs --answers answers/base [--out file]
  --answers   directory of answer files, one <id>.md per golden row
  --judge     path to a judge JSON (judge.mjs --out) so an errored run counts as not delivered
  --out       write the full JSON summary here`

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) { console.log(USAGE); return }
  const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
  const answers = path.resolve(process.cwd(), arg('--answers', 'answers/base'))
  const checks = checksFor(answers)
  const judged = new Map()
  const judgeFile = arg('--judge', '')
  if (judgeFile) for (const row of JSON.parse(fs.readFileSync(path.resolve(process.cwd(), judgeFile), 'utf8'))) judged.set(row.id, row)
  const summary = summarize(classifyRun({ ids: [...checks.keys()], answers, checks, judged }))
  const outFile = arg('--out', '')
  if (outFile) fs.writeFileSync(path.resolve(process.cwd(), outFile), JSON.stringify(summary, null, 2))
  for (const row of summary.rows) console.log(`${row.id} ${row.kind}/${row.class}${row.evidence ? ` — ${row.evidence}` : ''}`)
  console.log(`failures: ${summary.failed}/${summary.tasks}, process ${summary.byKind.process ?? 0}, content ${summary.byKind.content ?? 0}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
