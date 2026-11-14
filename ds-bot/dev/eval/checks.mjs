// Effect-layer checks: did the work actually leave a trace on disk?
// Every check is mechanical. No model is involved, and a task either passes all of
// its checks or it fails — partial credit would let a mostly-empty answer look fine.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ALLOW = path.join(path.dirname(new URL(import.meta.url).pathname), 'checks.allow')

export const allowedCommands = () => {
  try {
    return fs.readFileSync(ALLOW, 'utf8').split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
  } catch { return [] }
}

const allowList = allowedCommands

export function runChecks(row, { cwd = process.cwd(), allow = allowList(), answers = null } = {}) {
  const checks = Array.isArray(row.checks) ? row.checks : []
  const results = []
  for (const check of checks) {
    const result = runOne(check, cwd, allow, answers, row.id)
    results.push({ check, ...result })
    if (!result.ok) break
  }
  const total = checks.length
  return {
    id: row.id,
    total,
    passed: total > 0 && results.every(r => r.ok),
    results
  }
}

function runOne(check, cwd, allow, answers, id) {
  try {
    if (check.kind === 'file_exists') {
      const target = path.resolve(cwd, check.path)
      return fs.existsSync(target) ? { ok: true } : { ok: false, detail: `missing ${target}` }
    }
    if (check.kind === 'grep') {
      const target = path.resolve(cwd, check.path)
      if (!fs.existsSync(target)) return { ok: false, detail: `missing ${target}` }
      const text = fs.readFileSync(target, 'utf8')
      return new RegExp(check.pattern).test(text) ? { ok: true } : { ok: false, detail: `no match for ${check.pattern}` }
    }
    if (check.kind === 'exit_zero') {
      const cmd = String(check.cmd || '')
      if (!allow.includes(cmd)) return { ok: false, detail: 'command not in checks.allow' }
      execFileSync('/bin/sh', ['-c', cmd], { cwd, stdio: 'pipe', timeout: 120_000 })
      return { ok: true }
    }
    if (check.kind === 'answer_matches') {
      // Mechanical, not semantic: it only proves the answer addressed the question at all.
      // Every pattern in `all` must match; the model never sees this check.
      if (!answers) return { ok: false, detail: 'answers directory not given' }
      const target = path.join(answers, `${id}.md`)
      if (!fs.existsSync(target)) return { ok: false, detail: `missing ${target}` }
      const text = fs.readFileSync(target, 'utf8')
      for (const pattern of check.all ?? [check.pattern]) {
        if (!new RegExp(pattern, check.flags ?? '').test(text)) return { ok: false, detail: `no match for ${pattern}` }
      }
      return { ok: true }
    }
    if (check.kind === 'http_ok') {
      return { ok: false, detail: 'http_ok needs the async runner' }
    }
    return { ok: false, detail: `unknown kind ${check.kind}` }
  } catch (error) {
    return { ok: false, detail: String(error.message || error).slice(0, 200) }
  }
}

// http_ok is the only check that needs the network, so it lives in its own pass.
export async function runChecksAsync(row, { cwd = process.cwd(), allow = allowList(), answers = null, timeoutMs = 8000 } = {}) {
  const checks = Array.isArray(row.checks) ? row.checks : []
  const results = []
  for (const check of checks) {
    if (check.kind !== 'http_ok') {
      const result = runOne(check, cwd, allow, answers, row.id)
      results.push({ check, ...result })
    } else {
      const started = Date.now()
      try {
        const res = await fetch(check.url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
        results.push({ check, ok: res.ok, detail: `${res.status} in ${Date.now() - started}ms` })
      } catch (error) {
        results.push({ check, ok: false, detail: String(error.message || error).slice(0, 200) })
      }
    }
    if (!results.at(-1).ok) break
  }
  const total = checks.length
  return { id: row.id, total, passed: total > 0 && results.every(r => r.ok), results }
}
