import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createClient } from '../dev/ai-os/client.mjs'

test('attached mode refuses restart because the harness does not own the process', async () => {
  const client = createClient({ mode: 'attached', baseUrl: 'http://127.0.0.1:9999', cookie: 'test-cookie' })
  await assert.rejects(() => client.restart(), /does not own/)
})

test('attached mode sends the cookie but never exposes it', async () => {
  const seen = []
  const client = createClient({
    mode: 'attached', baseUrl: 'http://127.0.0.1:9999', cookie: 'secret-cookie',
    fetchImpl: async (_url, init) => {
      seen.push(init.headers.cookie)
      return new Response(JSON.stringify({ ok: true, value: { ready: true } }))
    },
  })
  await client.start()
  assert.deepEqual(await client.api('state', {}), { ready: true })
  assert.deepEqual(seen, ['secret-cookie'])
  assert.doesNotMatch(client.toString(), /secret-cookie/)
})

test('attached mode requires a cookie and redacts it from request failures', async () => {
  await assert.rejects(createClient({ mode: 'attached', baseUrl: 'http://127.0.0.1:9999' }).start(), /cookie/)
  const client = createClient({
    mode: 'attached', baseUrl: 'http://127.0.0.1:9999', cookie: 'secret-cookie',
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: { message: 'rejected secret-cookie' } })),
  })
  await client.start()
  await assert.rejects(client.api('state'), error => /\[REDACTED\]/.test(error.message) && !/secret-cookie/.test(error.message))
})

test('owned mode resets once, logs in, and can restart its own bench', async () => {
  const actions = []
  const requests = []
  let logins = 0
  const client = createClient({
    mode: 'owned', repoRoot: '/tmp/owned', benchName: 'aios', webPort: 3123, mockPort: 8823,
    runBench: async (_name, _web, _mock, action) => { actions.push(action) },
    login: async () => { logins += 1; return 'owned-cookie' },
    fetchImpl: async (url, init) => {
      requests.push({ url, cookie: init.headers.cookie })
      return new Response(JSON.stringify({ ok: true, value: { ready: true } }))
    },
  })
  await client.start()
  assert.deepEqual(await client.state(), { ready: true })
  await client.restart()
  await client.stop()
  assert.deepEqual(actions, ['reset', 'stop', 'start', 'stop'])
  assert.equal(logins, 2)
  assert.deepEqual(requests, [
    { url: 'http://127.0.0.1:3123/api/bot', cookie: 'owned-cookie' },
  ])
  assert.match(client.toString(), /OwnedBenchClient/)
  assert.doesNotMatch(client.toString(), /owned-cookie/)
})

test('owned mode reads the bench login URL and returns its session cookie', async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'aios-client-login-'))
  t.after(() => rm(repoRoot, { recursive: true, force: true }))
  await mkdir(join(repoRoot, '.dsh-test-aios-login'))
  await writeFile(join(repoRoot, '.dsh-test-aios-login', 'web.log'), 'dsh web: http://127.0.0.1:3210/?token=secret-token\n')
  const requests = []
  const client = createClient({
    mode: 'owned', repoRoot, benchName: 'aios-login', webPort: 3210, mockPort: 8810,
    runBench: async () => {},
    fetchImpl: async (url, init) => {
      if (String(url).includes('?token=')) {
        return new Response('', { status: 303, headers: { location: './', 'set-cookie': 'session=secret-cookie; Path=/; HttpOnly' } })
      }
      requests.push(init.headers.cookie)
      return new Response(JSON.stringify({ ok: true, value: { ready: true } }))
    },
  })
  await client.start()
  assert.deepEqual(await client.state(), { ready: true })
  assert.deepEqual(requests, ['session=secret-cookie'])
  assert.doesNotMatch(client.toString(), /secret/)
  await client.stop()
})
