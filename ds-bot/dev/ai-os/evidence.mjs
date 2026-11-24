import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

async function atomicWrite(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, value, 'utf8')
  try {
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

export async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export async function createBundle({ runDir, manifest, mode, secrets = [] }) {
  await mkdir(runDir, { recursive: true })
  const knownSecrets = secrets.filter(secret => typeof secret === 'string' && secret !== '')
  const sensitiveKey = key => /^(?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(key)
  const redactText = (value) => {
    let text = String(value)
    for (const secret of knownSecrets) text = text.split(secret).join('[REDACTED]')
    text = text.replace(/\b((?:api[_-]?key|token|cookie|authorization|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}&]+)/gi, '$1[REDACTED]')
    return text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
  }
  const clean = (value) => {
    if (typeof value === 'string') return redactText(value)
    if (Array.isArray(value)) return value.map(clean)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sensitiveKey(key) ? '[REDACTED]' : clean(child)]))
    }
    return value
  }
  const redact = value => typeof value === 'string' ? redactText(value) : JSON.stringify(clean(value))
  const eventsPath = join(runDir, 'events.jsonl')
  const rows = []
  let finished = false
  await atomicWrite(join(runDir, 'manifest.json'), `${JSON.stringify({ manifest, mode, startedAt: Date.now() }, null, 2)}\n`)
  return {
    runDir,
    eventsPath,
    async record(entry) {
      if (finished) throw new Error('The evidence bundle is already finished.')
      const row = { time: Date.now(), ...entry }
      rows.push(row)
      await appendFile(eventsPath, `${redact(row)}\n`, 'utf8')
    },
    async finish(result) {
      if (finished) throw new Error('The evidence bundle is already finished.')
      finished = true
      const finishedAt = Date.now()
      await atomicWrite(join(runDir, 'evidence.json'), `${redact(rows)}\n`)
      await atomicWrite(join(runDir, 'result.json'), `${redact({ ...result, finishedAt })}\n`)
    },
  }
}
