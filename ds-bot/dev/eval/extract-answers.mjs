// Pull the final answer each golden task actually got, so the judge has a baseline.
// Usage: node dev/eval/extract-answers.mjs [--out answers/base]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const here = path.dirname(new URL(import.meta.url).pathname)
const args = process.argv.slice(2)
const outDir = path.join(here, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'answers/base')

const rows = fs.readFileSync(path.join(here, 'golden.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
const index = new Map()
for (const dir of fs.readdirSync(sessionsRoot)) {
  const folder = path.join(sessionsRoot, dir)
  if (!fs.statSync(folder).isDirectory()) continue
  for (const name of fs.readdirSync(folder)) {
    const file = path.join(folder, name, 'session.v4.jsonl.zstd')
    if (fs.existsSync(file)) index.set(name, file)
  }
}

fs.mkdirSync(outDir, { recursive: true })
let written = 0
for (const row of rows) {
  const [session, turnPart] = String(row.source).split('#turn')
  const turn = Number(turnPart)
  const file = index.get(session)
  if (!file) { console.log(`${row.id}: session missing`); continue }
  const events = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
  const texts = []
  for (const ev of events) {
    if (ev.type !== 'assistant/message' || ev.data?.turn !== turn) continue
    const text = (ev.data.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
    if (text) texts.push(text)
  }
  if (!texts.length) { console.log(`${row.id}: no assistant text`); continue }
  fs.writeFileSync(path.join(outDir, `${row.id}.md`), texts.join('\n\n') + '\n')
  written += 1
}
console.log(`${written}/${rows.length} answers written to ${path.relative(process.cwd(), outDir)}`)
