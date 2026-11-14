// Score Bot answers against the golden set with an independent judge model.
// The judge sees only the task, the expectations, and the answer. It must not use outside knowledge.
// Usage: node dev/eval/judge.mjs [--ids g01,g02] [--answer-dir answers/base] [--judge claude] [--runs 1] [--out /tmp/judge.json]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname)
const args = process.argv.slice(2)
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)

const rows = fs.readFileSync(path.join(here, 'golden.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
const ids = arg('--ids', '') ? arg('--ids', '').split(',') : rows.map(r => r.id)
const answerDir = path.join(here, arg('--answer-dir', 'answers/base'))
const judge = arg('--judge', 'claude')
const runs = Number(arg('--runs', '1'))
const outFile = arg('--out', '')
const cacheDir = path.join(here, '.judge-cache')
fs.mkdirSync(cacheDir, { recursive: true })

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

function buildPrompt(row, answer) {
  return [
    RUBRIC,
    '',
    `TASK:\n${row.task}`,
    '',
    `CONTEXT:\n${row.context}`,
    '',
    'EXPECTATIONS (the answer should make these true):',
    ...row.expect.map((e, i) => `${i + 1}. ${e}`),
    '',
    `ANSWER:\n${answer.slice(0, 12000)}`
  ].join('\n')
}

function parseJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < 0) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

function judgeOnce(prompt) {
  const key = crypto.createHash('sha256').update(`${judge}\n${prompt}`).digest('hex').slice(0, 32)
  const cacheFile = path.join(cacheDir, `${key}.json`)
  if (fs.existsSync(cacheFile)) return { ...JSON.parse(fs.readFileSync(cacheFile, 'utf8')), cached: true }
  const started = Date.now()
  const proc = spawnSync('claude', ['-p', '--output-format', 'text'], {
    input: prompt,
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  })
  const elapsed = Date.now() - started
  if (proc.error || proc.status !== 0) {
    return { error: proc.error?.message || `exit ${proc.status}: ${(proc.stderr || '').slice(-300)}`, elapsed }
  }
  const parsed = parseJson(proc.stdout)
  const result = parsed ? { ...parsed, elapsed, cached: false } : { error: `unparseable: ${proc.stdout.slice(0, 200)}`, elapsed }
  fs.writeFileSync(cacheFile, JSON.stringify(result))
  return result
}

const results = []
for (const row of rows.filter(r => ids.includes(r.id))) {
  const answerFile = path.join(answerDir, `${row.id}.md`)
  if (!fs.existsSync(answerFile)) { results.push({ id: row.id, error: 'answer missing' }); continue }
  const answer = fs.readFileSync(answerFile, 'utf8')
  const runsOut = []
  for (let i = 0; i < runs; i += 1) runsOut.push(judgeOnce(buildPrompt(row, answer)))
  const ok = runsOut.filter(r => !r.error)
  const avg = criteria => (ok.length ? ok.reduce((s, r) => s + (r[criteria] ?? 0), 0) / ok.length : null)
  const scores = ok.length
    ? { accuracy: avg('accuracy'), completeness: avg('completeness'), usefulness: avg('usefulness'), signal: avg('signal') }
    : null
  results.push({ id: row.id, type: row.type, runs: runsOut.length, scores, runsOut })
  const label = scores ? Object.values(scores).reduce((a, b) => a + b, 0).toFixed(1) : 'ERR'
  console.log(`${row.id} ${row.type} total=${label}`, ok[0]?.reason ? `— ${ok[0].reason}` : '', ok.length < runsOut.length ? '(some runs failed)' : '')
}

if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2))
if (results.some(r => r.error)) process.exitCode = 1
