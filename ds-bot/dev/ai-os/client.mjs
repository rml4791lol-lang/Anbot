import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

export async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

function spawnBench(benchScript, cwd) {
  return (benchName, webPort, mockPort, action) => new Promise((resolve, reject) => {
    const child = spawn(benchScript, [benchName, String(webPort), String(mockPort), action], { cwd, shell: false, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`bench ${action} exited with code ${code}`)))
  })
}

function redact(value, secrets) {
  let text = String(value)
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]')
  return text
}

export function createClient(config) {
  if (config?.mode !== 'attached' && config?.mode !== 'owned') throw new Error('client mode must be attached or owned')
  const fetchImpl = config.fetchImpl ?? fetch
  let cookie = config.cookie
  let started = false
  let initialized = false
  let baseUrl = config.baseUrl?.replace(/\/$/, '')
  if (config.mode === 'owned') {
    if (typeof config.repoRoot !== 'string' || config.repoRoot === '') throw new Error('owned mode needs repoRoot')
    if (!Number.isInteger(config.webPort) || !Number.isInteger(config.mockPort)) throw new Error('owned mode needs webPort and mockPort')
    baseUrl = `http://127.0.0.1:${config.webPort}`
  }
  if (baseUrl === undefined || baseUrl === '') throw new Error('attached mode needs baseUrl')
  const secrets = () => [cookie].filter(Boolean)
  const failure = (message) => new Error(redact(message, secrets()))

  const api = async (endpoint, payload = {}) => {
    if (!started) throw new Error('The client is not started.')
    if (!cookie) throw new Error('The client has no session cookie.')
    const response = await fetchImpl(`${baseUrl}/api/bot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint, payload }),
    })
    let result
    try {
      result = await response.json()
    } catch {
      throw failure(`${endpoint}: the server returned an invalid JSON response (${response.status})`)
    }
    if (result?.ok !== true) throw failure(`${endpoint}: ${result?.error?.message ?? `request failed (${response.status})`}`)
    return result.value
  }

  const loginFromBench = async () => {
    const log = await readFile(join(config.repoRoot, `.dsh-test-${config.benchName}`, 'web.log'), 'utf8')
    const loginUrl = log.match(new RegExp(`http://127\\.0\\.0\\.1:${config.webPort}/\\?token=[^\\s]+`))?.[0]
    if (!loginUrl) throw new Error('no login URL in web.log')
    const response = await fetchImpl(loginUrl, { redirect: 'manual' })
    const values = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean)
    const next = values.map(value => value.split(';')[0]).filter(Boolean).join('; ')
    if (response.status !== 303 || !next) throw new Error(`login returned no cookie (HTTP ${response.status})`)
    cookie = next
    return cookie
  }
  const login = config.login ?? loginFromBench
  const benchScript = config.benchScript ?? join(config.repoRoot ?? '', 'ds-bot', 'dev', 'bench.sh')
  const runBench = config.runBench ?? spawnBench(benchScript, config.repoRoot)

  const startOwned = async () => {
    const action = initialized ? 'start' : 'reset'
    await runBench(config.benchName, config.webPort, config.mockPort, action)
    initialized = true
    try {
      cookie = await login()
      if (!cookie) throw new Error('login returned no cookie')
      started = true
    } catch (error) {
      started = false
      await runBench(config.benchName, config.webPort, config.mockPort, 'stop').catch(() => {})
      initialized = false
      throw error
    }
  }

  if (config.mode === 'attached') {
    return {
      async start() {
        if (!cookie && config.cookieFile) cookie = (await readFile(config.cookieFile, 'utf8')).trim()
        if (!cookie) throw new Error('attached mode needs a session cookie or cookieFile')
        started = true
      },
      api,
      async restart() { throw new Error('attached mode does not own the DS-Bot process and cannot restart it') },
      async state() { return api('state', {}) },
      async stop() { started = false },
      toString: () => 'AttachedClient([redacted])',
    }
  }

  return {
    async start() {
      await startOwned()
    },
    api,
    async restart() {
      if (!started) throw new Error('The client is not started.')
      await runBench(config.benchName, config.webPort, config.mockPort, 'stop')
      await runBench(config.benchName, config.webPort, config.mockPort, 'start')
      initialized = true
      try {
        cookie = await login()
        if (!cookie) throw new Error('login returned no cookie')
        started = true
      } catch (error) {
        started = false
        await runBench(config.benchName, config.webPort, config.mockPort, 'stop').catch(() => {})
        initialized = false
        throw error
      }
    },
    async state() { return api('state', {}) },
    async stop() {
      if (!initialized) {
        started = false
        return
      }
      initialized = false
      started = false
      await runBench(config.benchName, config.webPort, config.mockPort, 'stop').catch(() => {})
    },
    toString: () => 'OwnedBenchClient([redacted])',
  }
}
