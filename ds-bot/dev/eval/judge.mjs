// Score Bot answers against the golden set.
// Two modes, deliberately kept apart:
//   effect: run the golden row's `checks` — mechanical, no model.
//   pair:   show a judge two answers to the same task in both orders; a disagreement is a tie.
// Usage:
//   node dev/eval/judge.mjs --checks
//   node dev/eval/judge.mjs --pair-dir answers/candidate --answer-dir answers/base --ids g01,g02
//   node dev/eval/judge.mjs --ids g01 --runs 1 --out /tmp/judge.json     (single-answer rubric, for triage)
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { runChecks, allowedCommands } from './checks.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const args = process.argv.slice(2)
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const has = name => args.includes(name)

const rows = fs.readFileSync(path.join(here, 'golden.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
const ids = arg('--ids', '') ? arg('--ids', '').split(',') : rows.map(r => r.id)
const answerDir = path.join(here, arg('--answer-dir', 'answers/base'))
const pairDir = arg('--pair-dir', '') ? path.join(here, arg('--pair-dir', '')) : ''
const outFile = arg('--out', '')
const runs = Number(arg('--runs', '1'))
const cacheDir = path.join(here, '.judge-cache')
fs.mkdirSync(cacheDir, { recursive: true })

const SELECTED = rows.filter(r => ids.includes(r.id))

if (has('--checks')) {
  const results = SELECTED.map(row => runChecks(row, { cwd: process.cwd() }))
  const withChecks = results.filter(r => r.total > 0)
  const passed = withChecks.filter(r => r.passed)
  for (const r of results) {
    const label = r.total === 0 ? 'no checks (skipped)' : r.passed ? 'pass' : `fail — ${r.results.find(x => !x.ok)?.detail}`
    console.log(`${r.id} ${label}`)
  }
  console.log(`effect: ${passed.length}/${withChecks.length} tasks, ${results.length - withChecks.length} without checks`)
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2))
  process.exit(0)
}

const RUBRIC = `You are grading one answer from a team of software agents.
Judge only what the answer itself shows. Do not add facts from your own knowledge.

Score each criterion 0-2 (0 missing, 1 partial, 2 met):
- accuracy: every claim is either backed by evidence shown in the answer (paths, commands, numbers, sources) or explicitly marked as unverified.
- completeness: the answer covers the task's expectations listed below.
- usefulness: the reader can act on it without asking a follow-up question.
- signal: no filler, no restating the request, no narration of tools, no self-congratulation.

Also list unsupported claims: short quotes of statements that assert facts without evidence in the answer.

Reply with one JSON object and nothing else, exactly this shape:
{"accuracy":0-2,"completeness":0-2,"usefulness":0-2,"signal":0-2,"unsupported":["..."],"verdict":"pass|partial|fail","reason":"one sentence"}`

const PAIR = `You are comparing two answers to the same task, written by two different versions of a team of software agents.
Judge only what each answer shows. Do not add facts from your own knowledge.

Answer the question: which answer would let a reader act correctly with fewer follow-up questions?
Weigh: does it show evidence for its claims (paths, commands, numbers, sources) instead of asserting them;
does it cover the task's expectations; is it free of filler and tool narration.

Reply with one JSON object and nothing else, exactly this shape:
{"winner":"first|second|tie","reason":"one sentence, name the deciding gap"}`

const taskBlock = row => [
  `TASK:\n${row.task}`,
  '',
  `CONTEXT:\n${row.context}`,
  '',
  'EXPECTATIONS (the answer should make these true):',
  ...row.expect.map((e, i) => `${i + 1}. ${e}`)
].join('\n')

function parseJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < 0) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

function ask(prompt) {
  const key = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 32)
  const cacheFile = path.join(cacheDir, `${key}.json`)
  if (fs.existsSync(cacheFile)) return { ...JSON.parse(fs.readFileSync(cacheFile, 'utf8')), cached: true }
  const started = Date.now()
  const proc = spawnSync('claude', ['-p', '--output-format', 'text'], { input: prompt, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024 })
  const elapsed = Date.now() - started
  if (proc.error || proc.status !== 0) return { error: proc.error?.message || `exit ${proc.status}: ${(proc.stderr || '').slice(-300)}`, elapsed }
  const result = parseJson(proc.stdout)
  const out = result ? { ...result, elapsed, cached: false } : { error: `unparseable: ${proc.stdout.slice(0, 200)}`, elapsed }
  fs.writeFileSync(cacheFile, JSON.stringify(out))
  return out
}

if (pairDir) {
  const results = []
  for (const row of SELECTED) {
    const a = path.join(answerDir, `${row.id}.md`)
    const b = path.join(pairDir, `${row.id}.md`)
    if (!fs.existsSync(a) || !fs.existsSync(b)) { console.log(`${row.id} skipped (missing answer)`); continue }
    const A = fs.readFileSync(a, 'utf8')
    const B = fs.readFileSync(b, 'utf8')
    const first = ask(`${PAIR}\n\n${taskBlock(row)}\n\nFIRST ANSWER:\n${A.slice(0, 12000)}\n\nSECOND ANSWER:\n${B.slice(0, 12000)}`)
    const second = ask(`${PAIR}\n\n${taskBlock(row)}\n\nFIRST ANSWER:\n${B.slice(0, 12000)}\n\nSECOND ANSWER:\n${A.slice(0, 12000)}`)
    const pick = (run, swapped) => {
      if (run.error) return 'error'
      if (run.winner === 'tie') return 'tie'
      const picksFirst = run.winner === 'first'
      return (picksFirst !== swapped) ? 'A' : 'B'
    }
    const one = pick(first, false)
    const two = pick(second, true)
    const verdict = one === two ? one : 'tie'
    results.push({ id: row.id, verdict, detail: { one, two }, reasons: [first.reason, second.reason] })
    console.log(`${row.id} → ${verdict}`, `(${one}/${two})`, first.reason || first.error || '')
  }
  const decided = results.filter(r => r.verdict !== 'tie' && r.verdict !== 'error')
  const wins = decided.filter(r => r.verdict === 'A').length
  console.log(`pair: A wins ${wins}, B wins ${decided.length - wins}, ties ${results.length - decided.length} (n=${decided.length})`)
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2))
  process.exit(decided.length ? 0 : 1)
}

const results = []
for (const row of SELECTED) {
  const answerFile = path.join(answerDir, `${row.id}.md`)
  if (!fs.existsSync(answerFile)) { results.push({ id: row.id, error: 'answer missing' }); continue }
  const answer = fs.readFileSync(answerFile, 'utf8')
  const runsOut = []
  for (let i = 0; i < runs; i += 1) runsOut.push(ask(`${RUBRIC}\n\n${taskBlock(row)}\n\nANSWER:\n${answer.slice(0, 12000)}`))
  const ok = runsOut.filter(r => !r.error)
  const avg = k => (ok.length ? ok.reduce((s, r) => s + (r[k] ?? 0), 0) / ok.length : null)
  const scores = ok.length ? { accuracy: avg('accuracy'), completeness: avg('completeness'), usefulness: avg('usefulness'), signal: avg('signal') } : null
  results.push({ id: row.id, type: row.type, scores, runsOut })
  console.log(`${row.id} ${row.type} total=${scores ? Object.values(scores).reduce((a, b) => a + b, 0).toFixed(1) : 'ERR'}`, ok[0]?.reason ? `— ${ok[0].reason}` : '')
}
if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2))
