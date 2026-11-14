// Weekly digest: read the turn ledger, write the numbers, list what deserves attention.
//
// Every ratio carries its own denominator (n/m). A rate with m=0 prints n/a, never 0% —
// "no data" and "no failures" are different facts and only one is good news.
//
// Usage: node dev/digest.mjs [--days 7] [--out <dir>] [--check-proposal <file.md>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const has = name => args.includes(name)

const REQUIRED_PROPOSAL_SECTIONS = ['假设', '证据', '改动', '预期指标', '回滚']

export const parseLedger = text => text.split('\n').filter(Boolean).map(line => {
  try { return JSON.parse(line) } catch { return null }
}).filter(Boolean)

export const share = (n, m) => (m === 0 ? 'n/a' : `${n}/${m} (${Math.round((n / m) * 100)}%)`)

const quantile = (sorted, p) => (sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) * p)])

export function summarize(rows) {
  const turns = rows.filter(r => r.bot)
  const ctx = turns.map(r => r.context?.bytes ?? 0).sort((a, b) => a - b)
  const used = turns.map(r => (r.tools?.used ?? []).length)
  const sources = {}
  for (const r of turns) for (const [k, v] of Object.entries(r.context?.sources ?? {})) sources[k] = (sources[k] ?? 0) + v
  const days = [...new Set(turns.map(r => new Date(r.ts).toISOString().slice(0, 10)))].sort()
  const seeds = {}
  for (const r of turns) { const k = r.seed?.kind ?? 'none'; seeds[k] = (seeds[k] ?? 0) + 1 }
  return {
    days,
    turns: turns.length,
    seeds,
    context: { p50: quantile(ctx, 0.5), p90: quantile(ctx, 0.9), max: ctx.at(-1) ?? null, sources },
    tools: {
      mean: turns.length ? Number((used.reduce((a, b) => a + b, 0) / turns.length).toFixed(2)) : 0,
      zero: share(used.filter(n => n === 0).length, turns.length),
      errors: share(turns.filter(r => (r.tools?.errors ?? 0) > 0).length, turns.length)
    },
    emptyAnswers: share(turns.filter(r => (r.final_chars ?? 0) === 0).length, turns.length),
    aborted: share(turns.filter(r => r.outcome && r.outcome !== 'completed' && r.outcome !== 'open').length, turns.length)
  }
}

// Turns worth reading this week: something failed, nothing was said, or the turn paid for
// an unusually large injection. Ordered so the most expensive problems come first.
export function candidates(rows, limit = 20) {
  const turns = rows.filter(r => r.bot)
  const scored = turns.map(r => {
    let score = 0
    if ((r.tools?.errors ?? 0) > 0) score += 3
    if ((r.final_chars ?? 0) === 0) score += 2
    if ((r.context?.bytes ?? 0) > 15000) score += 1
    return { r, score }
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || (b.r.context?.bytes ?? 0) - (a.r.context?.bytes ?? 0))
  return scored.slice(0, limit).map(x => ({
    turn: `${x.r.session}#${x.r.turn}`,
    bot: x.r.bot,
    seed: x.r.seed?.kind ?? null,
    score: x.score,
    chars: x.r.final_chars ?? 0,
    errors: x.r.tools?.errors ?? 0,
    context: x.r.context?.bytes ?? 0
  }))
}

export function checkProposal(text) {
  // Split on headings instead of matching with a lookahead: under /m, `$` also matches at
  // every line end, so a regex like (\n([\s\S]*?)(?=^#|$)) always captures an empty body.
  const sections = new Map()
  let current = null
  for (const line of text.split('\n')) {
    const heading = line.match(/^#{1,4}\s*(.+?)\s*$/)
    if (heading) { current = heading[1].trim(); sections.set(current, []); continue }
    if (current) sections.get(current).push(line)
  }
  const missing = REQUIRED_PROPOSAL_SECTIONS.filter(name => {
    const body = ([...sections.entries()].find(([key]) => key.startsWith(name)) ?? [null, []])[1]
    return body.join('\n').trim() === ''
  })
  return { ok: missing.length === 0, missing }
}

const main = () => {
  const checkFile = arg('--check-proposal', null)
  if (checkFile) {
    const verdict = checkProposal(fs.readFileSync(checkFile, 'utf8'))
    console.log(JSON.stringify(verdict))
    process.exit(verdict.ok ? 0 : 1)
  }
  const days = Number(arg('--days', '7'))
  const outDir = arg('--out', path.join(os.homedir(), '.dsh', 'bot', 'digest'))
  const ledgerDir = arg('--ledger-dir', path.join(os.homedir(), '.dsh', 'bot', 'ledger'))
  const since = Date.now() - days * 86_400_000
  const rows = []
  const dayNames = []
  if (fs.existsSync(ledgerDir)) {
    for (const name of fs.readdirSync(ledgerDir).sort()) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue
      dayNames.push(name.slice(0, 10))
      for (const row of parseLedger(fs.readFileSync(path.join(ledgerDir, name), 'utf8'))) if (typeof row.ts === 'number' && row.ts >= since) rows.push(row)
    }
  }
  const summary = summarize(rows)
  if (dayNames.length) summary.days = [...new Set(dayNames)].sort()
  const picks = candidates(rows)
  const stamp = new Date().toISOString().slice(0, 10)
  const lines = [
    `# Bot 轮次 digest · ${stamp}`,
    '',
    `窗口：最近 ${days} 天，${summary.turns} 个 Bot 轮（${summary.days.length} 天有数据）`,
    '',
    '## 来源',
    '',
    '| seed | 轮数 |',
    '| --- | --- |',
    ...Object.entries(summary.seeds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## 上下文注入',
    '',
    `p50 ${summary.context.p50} · p90 ${summary.context.p90} · max ${summary.context.max} 字符（注入字节，不含系统提示与历史）`,
    '',
    '| 来源 | 字符 |',
    '| --- | --- |',
    ...Object.entries(summary.context.sources).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## 过程指标',
    '',
    `工具调用均值 ${summary.tools.mean}；零工具 ${summary.tools.zero}；有工具错误 ${summary.tools.errors}；空回答 ${summary.emptyAnswers}；非正常结束 ${summary.aborted}`,
    '',
    '## 本周候选样本',
    '',
    '| session#turn | bot | seed | 分 | 正文字符 | 工具错误 | 注入字节 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...picks.map(p => `| ${p.turn} | ${p.bot ?? '-'} | ${p.seed ?? '-'} | ${p.score} | ${p.chars} | ${p.errors} | ${p.context} |`),
    '',
    '写提议时复制 `dev/digest-proposal.md`，五节缺一不可；`node dev/digest.mjs --check-proposal <file>` 会拒绝缺「回滚」的提议。'
  ]
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `${stamp}-digest.md`)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  console.log(JSON.stringify({ file, turns: summary.turns, seeds: summary.seeds, zeroTool: summary.tools.zero, candidates: picks.length }))
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (invokedDirectly) main()
