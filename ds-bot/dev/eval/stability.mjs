// Measure whether the rubric judge agrees with itself: run it K times over a sample of
// golden tasks with the cache bypassed, then compare verdicts and scores across runs.
// A prompt change may only be judged by this judge when the measured agreement is at
// least the threshold (0.80); below it the verdict of a comparison is inconclusive.
// Usage:
//   node dev/eval/stability.mjs --limit 12 --runs 3
//   node dev/eval/stability.mjs --ids g01,g02,g03 --runs 3 --out /tmp/stability.json
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const VERDICTS = ['pass', 'partial', 'fail']
export const DIMENSIONS = ['accuracy', 'completeness', 'usefulness', 'signal']
export const DEFAULT_THRESHOLD = 0.8

// One judge run is an array of rows as `judge.mjs --runs 1` writes them.
export function normalizeJudgeRun(rows) {
  return rows.map(row => {
    const first = row.runsOut?.[0] ?? {}
    const message = row.error || first.error || null
    const verdict = message ? 'error' : (VERDICTS.includes(first.verdict) ? first.verdict : 'error')
    const scores = {}
    for (const dim of DIMENSIONS) scores[dim] = typeof first[dim] === 'number' ? first[dim] : null
    return {
      id: row.id,
      verdict,
      scores,
      error: message || (verdict === 'error' ? 'missing verdict' : null)
    }
  })
}

function variance(values) {
  if (values.length === 0) return null
  if (values.length === 1) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
}

export function summarizeStability(runs, { threshold = DEFAULT_THRESHOLD } = {}) {
  const ids = [...new Set(runs.flat().map(r => r.id))]
  const perTask = ids.map(id => {
    const byRun = runs.map(run => run.find(r => r.id === id) || { id, verdict: 'error', scores: {}, error: 'row missing' })
    const verdicts = byRun.map(r => r.verdict)
    // An errored run says nothing about agreement, so it never counts as a comparison.
    const usable = verdicts.filter(v => v !== 'error')
    let agreeing = 0
    let comparisons = 0
    for (let i = 0; i < usable.length; i += 1) {
      for (let j = i + 1; j < usable.length; j += 1) {
        comparisons += 1
        if (usable[i] === usable[j]) agreeing += 1
      }
    }
    const varianceByDimension = {}
    for (const dim of DIMENSIONS) {
      varianceByDimension[dim] = variance(byRun.map(r => r.scores[dim]).filter(v => typeof v === 'number'))
    }
    const message = byRun.map(r => r.error).find(Boolean)
    return {
      id,
      verdicts,
      agreement: comparisons ? agreeing / comparisons : null,
      comparisons,
      agreeing,
      stable: usable.length > 1 ? usable.every(v => v === usable[0]) : null,
      variance: varianceByDimension,
      errors: verdicts.length - usable.length,
      ...(message ? { error: message } : {})
    }
  })

  const comparisons = perTask.reduce((s, t) => s + t.comparisons, 0)
  const agreeing = perTask.reduce((s, t) => s + t.agreeing, 0)
  const agreement = comparisons ? agreeing / comparisons : null

  const dimensions = {}
  for (const dim of DIMENSIONS) {
    const scored = perTask.filter(t => typeof t.variance[dim] === 'number')
    const values = scored.map(t => t.variance[dim])
    const maxVariance = values.length ? Math.max(...values) : null
    dimensions[dim] = {
      meanVariance: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
      maxVariance,
      maxVarianceId: values.length ? scored.find(t => t.variance[dim] === maxVariance)?.id ?? null : null
    }
  }

  const verdictsByRun = runs.map(run => {
    const count = { pass: 0, partial: 0, fail: 0, error: 0 }
    for (const id of ids) {
      const row = run.find(r => r.id === id)
      count[row ? row.verdict : 'error'] += 1
    }
    return count
  })

  return {
    tasks: ids.length,
    runs: runs.length,
    threshold,
    agreement,
    comparisons,
    agreeing,
    unanimousTasks: perTask.filter(t => t.stable === true).length,
    unstable: perTask.filter(t => t.stable === false).map(t => ({ id: t.id, verdicts: t.verdicts })),
    errors: perTask.reduce((s, t) => s + t.errors, 0),
    verdictsByRun,
    dimensions,
    perTask,
    decision: agreement !== null && agreement >= threshold ? 'trustworthy' : 'inconclusive'
  }
}

const USAGE = `usage: node dev/eval/stability.mjs --ids g01,g02 --runs 3
       node dev/eval/stability.mjs --limit 12 --runs 3
  --ids         comma-separated golden ids
  --limit       first N golden ids (the sample size decides the cost)
  --runs        judge runs per task, default 3, at least 2
  --threshold   agreement needed to call the judge trustworthy, default 0.80
  --out         write the full JSON summary here
  --answer-dir  directory of answers, default answers/base`

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) { console.log(USAGE); return }
  const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)

  const rows = fs.readFileSync(path.join(here, 'golden.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  const known = rows.map(r => r.id)
  const idsArg = arg('--ids', '')
  const limit = Number(arg('--limit', '0'))
  if (!idsArg && !(limit > 0)) { process.stderr.write(`${USAGE}\n`); process.exitCode = 1; return }
  const ids = idsArg ? idsArg.split(',') : known.slice(0, limit)
  const unknown = ids.filter(id => !known.includes(id))
  if (unknown.length) throw new Error(`unknown ids: ${unknown.join(', ')} (known: ${known.join(', ')})`)

  const runs = Number(arg('--runs', '3'))
  if (!Number.isInteger(runs) || runs < 2) throw new Error('--runs must be an integer of at least 2')
  const threshold = Number(arg('--threshold', String(DEFAULT_THRESHOLD)))
  const outFile = arg('--out', '')
  const answerArg = arg('--answer-dir', '')
  const answerDir = answerArg ? path.relative(here, path.resolve(process.cwd(), answerArg)) : ''

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-stability-'))
  const perRun = []
  try {
    for (let run = 0; run < runs; run += 1) {
      const file = path.join(work, `run-${run + 1}.json`)
      process.stderr.write(`run ${run + 1}/${runs} over ${ids.length} tasks… `)
      const judgeArgs = [path.join(here, 'judge.mjs'), '--runs', '1', '--no-cache', '--ids', ids.join(','), '--out', file]
      if (answerDir) judgeArgs.push('--answer-dir', answerDir)
      const proc = spawnSync(process.execPath, judgeArgs, {
        cwd: path.resolve(here, '..', '..'),
        encoding: 'utf8',
        timeout: 240_000 * ids.length + 30_000,
        maxBuffer: 16 * 1024 * 1024
      })
      if (proc.error || proc.status !== 0) {
        throw new Error(`judge run ${run + 1} failed: ${proc.error?.message || `exit ${proc.status}: ${(proc.stderr || '').slice(-400)}`}`)
      }
      perRun.push(normalizeJudgeRun(JSON.parse(fs.readFileSync(file, 'utf8'))))
      process.stderr.write('done\n')
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }

  const summary = summarizeStability(perRun, { threshold })
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary))
  const agreement = summary.agreement === null ? 'n/a' : summary.agreement.toFixed(2)
  console.log(`agreement ${agreement} over ${summary.tasks} tasks, ${summary.runs} runs`)
  console.log(`decision: ${summary.decision} (threshold ${threshold.toFixed(2)}, ${summary.unstable.length} unstable task(s), ${summary.errors} error(s))`)
  if (summary.agreement === null) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
