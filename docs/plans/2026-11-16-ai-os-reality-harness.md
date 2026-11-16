# AI OS Reality Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not commit or push until the user explicitly authorizes it.

**Goal:** Build an isolated, evidence-producing task harness that runs the same DS-Bot task manifest against an owned mock bench or an explicitly attached real DS-Bot instance, so “task complete” always means environment evidence, not a Bot's claim.

**Architecture:** The harness is developer infrastructure, not product runtime. It owns manifest validation, process lifecycle for mock benches, authentication, step execution, evidence capture, redaction and result reporting. It calls the existing `/api/bot` API and existing `dev/bench.sh`; it does not add another Agent Runtime, Bot roster, task store or model router.

**Tech Stack:** Node ESM `>=26`, `node:test`, existing `dev/bench.sh`, existing mock LLM, existing DS-Bot HTTP API, SQLite/JSONL artifacts read-only.

**Spec:** [`docs/design/personal-ai-os.md`](../design/personal-ai-os.md)

## Global Constraints

- DSH `0.2.2-rc.1` from `dev/harness/package.json` is the test baseline; global `dsh 0.2.2-rc.3` is not authoritative.
- Automated CI never reads or writes `~/.dsh` or a real user DSH profile.
- Mock mode uses `.dsh-test-aios-<run-id>` under the repository.
- Attached mode only calls an already-running dedicated test instance or a DS-Bot instance the user explicitly authorizes; it never starts, stops or rewrites that instance's profile.
- Cookies, API keys, bearer tokens and DSH_HOME contents never enter manifests, logs, evidence, errors or Git.
- A manifest cannot mark a task complete without at least one execution record and one acceptance record.
- A mock result and an attached/live result use different `dataMode` values and cannot be merged into one completion claim.
- Use `spawn` with `shell: false` for commands. No strings are passed through a shell.
- All started process groups must be stopped in `finally`.
- Do not edit `ds-bot/client.js`; it is generated and this plan does not touch client source.
- No production deploy, external write, commit, push or PR is part of this plan.

---

### Task 1: Manifest contract and validator

**Files:**
- Create: `ds-bot/dev/ai-os/manifest.mjs`
- Create: `ds-bot/test/ai-os-manifest.test.js`

**Interfaces:**
- Consumes: a JSON file path.
- Produces: `loadManifest(path) -> Promise<Manifest>`, `validateManifest(value) -> string[]`, `Mode = 'mock' | 'attached'`.
- `Manifest` fields: `schemaVersion`, `id`, `title`, `modes`, `dataMode`, `workspace`, `steps`, `acceptance`, `timeoutMs`.

- [ ] **Step 1: Write the failing manifest tests**

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateManifest } from '../dev/ai-os/manifest.mjs'

const valid = {
  schemaVersion: 1,
  id: 'restart-team',
  title: 'Restart preserves the team',
  modes: ['mock'],
  dataMode: 'mock',
  workspace: { kind: 'scratch', path: 'workspace' },
  timeoutMs: 30_000,
  steps: [{ id: 'state', kind: 'api', endpoint: 'state', payload: {} }],
  acceptance: [{ id: 'bots', kind: 'json', path: 'state.json', pointer: '/bots', minLength: 1 }],
}

test('a valid manifest has no problems', () => {
  assert.deepEqual(validateManifest(valid), [])
})

test('mock and attached modes have different mandatory inputs', () => {
  assert.match(validateManifest({ ...valid, modes: ['attached'], dataMode: 'live' }).join('\n'), /baseUrl/)
  assert.match(validateManifest({ ...valid, dataMode: 'preview' }).join('\n'), /dataMode/)
})

test('steps reject shell strings and unknown kinds', () => {
  const bad = structuredClone(valid)
  bad.steps = [{ id: 'x', kind: 'shell', command: 'rm -rf /' }]
  assert.match(validateManifest(bad).join('\n'), /unknown step kind/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ds-bot && node --test test/ai-os-manifest.test.js`

Expected: FAIL because `dev/ai-os/manifest.mjs` does not exist.

- [ ] **Step 3: Implement the manifest module**

```js
import { readFile } from 'node:fs/promises'

export const STEP_KINDS = new Set(['api', 'capture', 'wait', 'restart', 'command', 'file'])
export const MODES = new Set(['mock', 'attached'])

const requiredText = (value, name, problems) => {
  if (typeof value !== 'string' || value.trim() === '') problems.push(`${name} must be a non-empty string`)
}

export function validateManifest(value) {
  const problems = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['manifest must be an object']
  if (value.schemaVersion !== 1) problems.push('schemaVersion must be 1')
  requiredText(value.id, 'id', problems)
  requiredText(value.title, 'title', problems)
  if (!Array.isArray(value.modes) || value.modes.length === 0) problems.push('modes must be a non-empty array')
  for (const mode of value.modes ?? []) if (!MODES.has(mode)) problems.push(`unknown mode: ${mode}`)
  if (!['mock', 'live', 'preview'].includes(value.dataMode)) problems.push('dataMode must be mock, live or preview')
  if (value.modes?.includes('attached') && typeof value.baseUrl !== 'string') problems.push('baseUrl is required for attached mode')
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0) problems.push('timeoutMs must be a positive safe integer')
  if (!Array.isArray(value.steps) || value.steps.length === 0) problems.push('steps must be a non-empty array')
  for (const [index, step] of (value.steps ?? []).entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) { problems.push(`steps[${index}] must be an object`); continue }
    requiredText(step.id, `steps[${index}].id`, problems)
    if (!STEP_KINDS.has(step.kind)) problems.push(`steps[${index}]: unknown step kind: ${step.kind}`)
    if (step.kind === 'command') {
      if (!Array.isArray(step.argv) || step.argv.length === 0) problems.push(`steps[${index}].argv must be a non-empty array`)
      if (typeof step.command === 'string') problems.push(`steps[${index}] may not use a shell command string`)
    }
    if (step.kind === 'capture') {
      requiredText(step.endpoint, `steps[${index}].endpoint`, problems)
      requiredText(step.path, `steps[${index}].path`, problems)
    }
  }
  if (!Array.isArray(value.acceptance) || value.acceptance.length === 0) problems.push('acceptance must be a non-empty array')
  for (const [index, check] of (value.acceptance ?? []).entries()) {
    if (!check || typeof check !== 'object' || Array.isArray(check)) { problems.push(`acceptance[${index}] must be an object`); continue }
    requiredText(check.id, `acceptance[${index}].id`, problems)
    if (!['file', 'json'].includes(check.kind)) problems.push(`acceptance[${index}]: unknown acceptance kind: ${check.kind}`)
  }
  return problems
}

export async function loadManifest(path) {
  const value = JSON.parse(await readFile(path, 'utf8'))
  const problems = validateManifest(value)
  if (problems.length > 0) throw Object.assign(new Error(problems.join('\n')), { code: 'AIOS_MANIFEST' })
  return value
}
```

- [ ] **Step 4: Run the manifest tests**

Run: `cd ds-bot && node --test test/ai-os-manifest.test.js`

Expected: PASS 3 tests.

- [ ] **Step 5: Checkpoint without committing**

Run: `git status --short && git diff -- ds-bot/dev/ai-os/manifest.mjs ds-bot/test/ai-os-manifest.test.js`

Expected: only the two task files are shown. Do not commit until authorized.

---

### Task 2: Evidence bundle and redaction

**Files:**
- Create: `ds-bot/dev/ai-os/evidence.mjs`
- Create: `ds-bot/test/ai-os-evidence.test.js`

**Interfaces:**
- Consumes: run directory and metadata.
- Produces: `createBundle({ runDir, manifest, mode }) -> Promise<EvidenceBundle>`, `record(entry)`, `finish(result)`, `sha256File(path)`.
- `events.jsonl` is append-only; `evidence.json` and `result.json` are written atomically.

- [ ] **Step 1: Write failing evidence tests**

```js
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBundle } from '../dev/ai-os/evidence.mjs'

test('events are append-only and secrets are redacted', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'aios-evidence-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const bundle = await createBundle({ runDir, manifest: { id: 'x' }, mode: 'mock', secrets: ['secret-cookie'] })
  await bundle.record({ kind: 'command', command: ['echo', 'secret-cookie'], exitCode: 0 })
  await bundle.finish({ status: 'completed' })
  const events = await readFile(join(runDir, 'events.jsonl'), 'utf8')
  assert.doesNotMatch(events, /secret-cookie/)
  assert.match(events, /\[REDACTED\]/)
  const result = JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8'))
  assert.equal(result.status, 'completed')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ds-bot && node --test test/ai-os-evidence.test.js`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement minimal bundle**

```js
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const atomicWrite = async (path, value) => {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, value, 'utf8')
  await rename(temp, path)
}

export const sha256File = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

export async function createBundle({ runDir, manifest, mode, secrets = [] }) {
  await mkdir(runDir, { recursive: true })
  const redact = (value) => {
    let text = typeof value === 'string' ? value : JSON.stringify(value)
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]')
    return text.replace(/((?:api[_-]?key|token|cookie)=)[^\s&]+/gi, '$1[REDACTED]')
  }
  const eventsPath = join(runDir, 'events.jsonl')
  const rows = []
  await atomicWrite(join(runDir, 'manifest.json'), JSON.stringify({ manifest, mode, startedAt: Date.now() }, null, 2) + '\n')
  return {
    runDir,
    async record(entry) {
      const row = { time: Date.now(), ...entry }
      rows.push(row)
      await appendFile(eventsPath, redact(row) + '\n', 'utf8')
    },
    async finish(result) {
      await atomicWrite(join(runDir, 'evidence.json'), redact(rows) + '\n')
      await atomicWrite(join(runDir, 'result.json'), redact({ ...result, finishedAt: Date.now() }) + '\n')
    },
  }
}
```

- [ ] **Step 4: Run the evidence test**

Run: `cd ds-bot && node --test test/ai-os-evidence.test.js`

Expected: PASS.

- [ ] **Step 5: Checkpoint without committing**

Run: `git status --short ds-bot/dev/ai-os ds-bot/test/ai-os-evidence.test.js`

Expected: only Task 2 files are new.

---

### Task 3: Owned and attached DS-Bot clients

**Files:**
- Create: `ds-bot/dev/ai-os/client.mjs`
- Create: `ds-bot/test/ai-os-client.test.js`

**Interfaces:**
- Consumes: `{ mode, baseUrl?, benchName?, webPort?, mockPort?, cookieFile?, env? }`.
- Produces: `createClient(config) -> Client` with `start()`, `api(endpoint, payload)`, `restart()`, `state()`, `stop()`.
- Owned mode uses `dev/bench.sh`; attached mode never starts, stops or restarts DS-Bot.

- [ ] **Step 1: Write failing client tests**

```js
import assert from 'node:assert/strict'
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
    fetchImpl: async (_url, init) => { seen.push(init.headers.cookie); return new Response(JSON.stringify({ ok: true, value: { ready: true } })) },
  })
  assert.deepEqual(await client.api('state', {}), { ready: true })
  assert.deepEqual(seen, ['secret-cookie'])
  assert.doesNotMatch(client.toString(), /secret-cookie/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ds-bot && node --test test/ai-os-client.test.js`

Expected: FAIL because the client module is absent.

- [ ] **Step 3: Implement the client boundary**

```js
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

export async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

export function createClient(config) {
  const fetchImpl = config.fetchImpl ?? fetch
  const baseUrl = config.baseUrl?.replace(/\/$/, '')
  let cookie = config.cookie
  const api = async (endpoint, payload = {}) => {
    const response = await fetchImpl(`${baseUrl}/api/bot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint, payload }),
    })
    const result = await response.json()
    if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message ?? 'request failed'}`)
    return result.value
  }
  const login = async () => {
    const log = await readFile(join(config.repoRoot, `.dsh-test-${config.benchName}`, 'web.log'), 'utf8')
    const loginUrl = log.match(new RegExp(`http://127\\.0\\.0\\.1:${config.webPort}/\\?token=[^\\s]+`))?.[0]
    if (!loginUrl) throw new Error('no login URL in web.log')
    const response = await fetch(loginUrl, { redirect: 'manual' })
    cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    if (!cookie) throw new Error('login returned no cookie')
  }
  if (config.mode === 'attached') {
    return {
      async start() {
        if (!cookie && config.cookieFile) cookie = (await readFile(config.cookieFile, 'utf8')).trim()
        if (!cookie) throw new Error('attached mode needs DSBOT_RUN_COOKIE or cookieFile')
      },
      api,
      async restart() { throw new Error('attached mode does not own the DS-Bot process and cannot restart it') },
      async state() { return api('state', {}) },
      async stop() {},
      toString: () => 'AttachedClient([redacted])',
    }
  }
  const bench = config.benchScript
  const cwd = config.repoRoot
  let initialized = false
  const runBench = (action) => new Promise((resolve, reject) => {
    const child = spawn(bench, [config.benchName, String(config.webPort), String(config.mockPort), action], { cwd, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`bench ${action} exited ${code}`)))
  })
  return {
    async start() {
      await runBench(initialized ? 'start' : 'reset')
      initialized = true
      await login()
    },
    api,
    async restart() { await runBench('stop'); await runBench('start'); await login() },
    async state() { return api('state', {}) },
    async stop() { await runBench('stop').catch(() => {}) },
    toString: () => 'OwnedBenchClient([redacted])',
  }
}
```

- [ ] **Step 4: Run client tests**

Run: `cd ds-bot && node --test test/ai-os-client.test.js`

Expected: PASS 2 tests.

- [ ] **Step 5: Checkpoint without committing**

Run: `git diff --check && git status --short ds-bot/dev/ai-os/client.mjs ds-bot/test/ai-os-client.test.js`

Expected: no whitespace errors.

---

### Task 4: Step runner and acceptance evaluator

**Files:**
- Create: `ds-bot/dev/ai-os/run.mjs`
- Create: `ds-bot/test/ai-os-run.test.js`

**Interfaces:**
- Consumes: manifest, evidence bundle, client, workspace root.
- Produces: `runManifest({ manifest, mode, client, bundle, workspace }) -> Promise<RunResult>`.
- RunResult fields: `status`, `steps`, `acceptance`, `failure`.

- [ ] **Step 1: Write failing runner tests**

```js
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runManifest } from '../dev/ai-os/run.mjs'

const bundle = () => ({ record: async () => {}, finish: async () => {} })

test('a command step and a file acceptance produce completed', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'aios-run-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const result = await runManifest({
    manifest: {
      schemaVersion: 1, id: 'x', title: 'x', modes: ['mock'], dataMode: 'mock', timeoutMs: 10_000,
      workspace: { kind: 'scratch', path: '.' },
      steps: [{ id: 'write', kind: 'command', argv: ['node', '-e', 'require("fs").writeFileSync("ok.txt","yes")'], cwd: '.', timeoutMs: 5_000 }],
      acceptance: [{ id: 'file', kind: 'file', path: 'ok.txt' }],
    },
    mode: 'mock', client: {}, bundle: bundle(), workspace,
  })
  assert.equal(result.status, 'completed')
})

test('missing acceptance evidence fails the run', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'aios-run-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'bad.txt'), 'no')
  const result = await runManifest({
    manifest: {
      schemaVersion: 1, id: 'x', title: 'x', modes: ['mock'], dataMode: 'mock', timeoutMs: 10_000,
      workspace: { kind: 'scratch', path: '.' }, steps: [], acceptance: [{ id: 'missing', kind: 'file', path: 'ok.txt' }],
    },
    mode: 'mock', client: {}, bundle: bundle(), workspace,
  })
  assert.equal(result.status, 'failed')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ds-bot && node --test test/ai-os-run.test.js`

Expected: FAIL because `runManifest` is absent.

- [ ] **Step 3: Implement the runner**

```js
import { spawn } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

const within = (root, path) => {
  const base = resolve(root)
  const target = resolve(base, path)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes workspace: ${path}`)
  return target
}

const command = (argv, cwd, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`command timed out: ${argv.join(' ')}`)) }, timeoutMs)
  child.once('error', reject)
  child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
})

export async function runManifest({ manifest, client, bundle, workspace }) {
  const steps = []
  try {
    for (const step of manifest.steps) {
      if (step.kind === 'api') {
        const value = await client.api(step.endpoint, step.payload ?? {})
        await bundle.record({ kind: 'api', step: step.id, endpoint: step.endpoint, value })
        steps.push({ id: step.id, kind: step.kind, ok: true })
      } else if (step.kind === 'command') {
        const result = await command(step.argv, within(workspace, step.cwd ?? '.'), step.timeoutMs ?? manifest.timeoutMs)
        await bundle.record({ kind: 'command', step: step.id, argv: step.argv, ...result })
        if (result.code !== 0) throw new Error(`command failed: ${step.id}`)
        steps.push({ id: step.id, kind: step.kind, ok: true })
      } else if (step.kind === 'capture') {
        const value = await client.api(step.endpoint, step.payload ?? {})
        const target = within(workspace, step.path)
        await writeFile(target, JSON.stringify(value, null, 2) + '\n')
        await bundle.record({ kind: 'capture', step: step.id, endpoint: step.endpoint, path: target })
        steps.push({ id: step.id, kind: step.kind, ok: true })
      } else if (step.kind === 'restart') {
        await client.restart()
        await bundle.record({ kind: 'restart', step: step.id })
        steps.push({ id: step.id, kind: step.kind, ok: true })
      } else if (step.kind === 'file') {
        const target = within(workspace, step.path)
        await access(target)
        await bundle.record({ kind: 'file', step: step.id, path: target })
        steps.push({ id: step.id, kind: step.kind, ok: true })
      } else if (step.kind === 'wait') {
        await new Promise(resolve => setTimeout(resolve, step.ms))
        steps.push({ id: step.id, kind: step.kind, ok: true })
      }
      if (step.expect !== undefined) {
        const state = await client.state()
        if (JSON.stringify(state).includes(step.expect) === false) throw new Error(`expectation failed: ${step.id}`)
      }
    }
    const acceptance = []
    for (const check of manifest.acceptance) {
      if (check.kind === 'file') {
        const path = within(workspace, check.path)
        await access(path)
        acceptance.push({ id: check.id, ok: true, path })
      } else if (check.kind === 'json') {
        const root = JSON.parse(await readFile(within(workspace, check.path), 'utf8'))
        const value = (check.pointer ?? '').split('/').filter(Boolean).reduce((node, key) => node?.[key], root)
        const found = check.minLength === undefined || ((Array.isArray(value) || typeof value === 'string') && value.length >= check.minLength) || (check.minLength === 0 && value !== undefined)
        if (!found) throw new Error(`json acceptance failed: ${check.id}`)
        acceptance.push({ id: check.id, ok: true })
      }
    }
    await bundle.finish({ status: 'completed', steps, acceptance })
    return { status: 'completed', steps, acceptance }
  } catch (error) {
    const failure = { message: error.message, code: error.code ?? 'AIOS_RUN' }
    await bundle.finish({ status: 'failed', steps, failure })
    return { status: 'failed', steps, acceptance: [], failure }
  }
}
```

- [ ] **Step 4: Run runner tests**

Run: `cd ds-bot && node --test test/ai-os-run.test.js`

Expected: PASS 2 tests.

- [ ] **Step 5: Checkpoint without committing**

Run: `cd ds-bot && node --test test/ai-os-manifest.test.js test/ai-os-evidence.test.js test/ai-os-client.test.js test/ai-os-run.test.js`

Expected: all harness unit tests pass.

---

### Task 5: First scenario manifests

**Files:**
- Create: `ds-bot/dev/ai-os/scenarios/restart-team.json`
- Create: `ds-bot/dev/ai-os/scenarios/attached-repository-check.json`

**Interfaces:**
- Both manifests validate against Task 1.
- `restart-team` must run only in `mock` mode.
- `attached-repository-check` must run only in `attached` mode and must not contain a restart step.

- [ ] **Step 1: Create the mock restart scenario**

```json
{
  "schemaVersion": 1,
  "id": "restart-team",
  "title": "Team state survives a bench restart",
  "modes": ["mock"],
  "dataMode": "mock",
  "timeoutMs": 120000,
  "workspace": { "kind": "scratch", "path": "workspace" },
  "steps": [
    { "id": "before", "kind": "capture", "endpoint": "state", "payload": {}, "path": "before.json" },
    { "id": "restart", "kind": "restart" },
    { "id": "after", "kind": "capture", "endpoint": "state", "payload": {}, "path": "after.json" }
  ],
  "acceptance": [
    { "id": "bots", "kind": "json", "path": "after.json", "pointer": "/bots", "minLength": 1 }
  ]
}
```

- [ ] **Step 2: Create the attached real-repository scenario**

```json
{
  "schemaVersion": 1,
  "id": "attached-repository-check",
  "title": "Real repository test command",
  "modes": ["attached"],
  "dataMode": "live",
  "baseUrl": "http://127.0.0.1:3080",
  "timeoutMs": 300000,
  "workspace": { "kind": "worktree", "path": "." },
  "steps": [
    { "id": "state", "kind": "api", "endpoint": "state", "payload": {} },
    { "id": "tests", "kind": "command", "argv": ["npm", "test"], "cwd": "ds-bot", "timeoutMs": 300000 }
  ],
  "acceptance": [
    { "id": "tests-pass", "kind": "file", "path": "ds-bot/package.json" }
  ]
}
```

- [ ] **Step 3: Validate both manifests**

Run:

```bash
cd ds-bot
node - <<'NODE'
import { readFile } from 'node:fs/promises'
import { validateManifest } from './dev/ai-os/manifest.mjs'
for (const path of ['dev/ai-os/scenarios/restart-team.json', 'dev/ai-os/scenarios/attached-repository-check.json']) {
  const value = JSON.parse(await readFile(path, 'utf8'))
  const problems = validateManifest(value)
  if (problems.length) throw new Error(`${path}:\n${problems.join('\n')}`)
  console.log(`ok ${path}`)
}
NODE
```

Expected: both manifests print `ok`.

- [ ] **Step 4: Checkpoint without committing**

Run: `git status --short ds-bot/dev/ai-os/scenarios && git diff --check`

Expected: exactly two scenario files.

---

### Task 6: CLI and package scripts

**Files:**
- Create: `ds-bot/dev/ai-os/cli.mjs`
- Modify: `ds-bot/package.json`
- Create: `ds-bot/test/ai-os-cli.test.js`

**Interfaces:**
- CLI: `node dev/ai-os/cli.mjs --manifest <path> --mode <mock|attached> --run-id <id> [--base-url <url>] [--cookie-file <path>] [--keep]`.
- npm scripts: `aios:manifest`, `aios:mock`, `aios:attached`.
- CLI writes no secret to stdout/stderr.

- [ ] **Step 1: Write the failing CLI test**

```js
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('the CLI explains missing attached credentials without a stack trace', () => {
  const result = spawnSync(process.execPath, ['dev/ai-os/cli.mjs', '--manifest', 'dev/ai-os/scenarios/attached-repository-check.json', '--mode', 'attached'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', env: { ...process.env, DSBOT_RUN_COOKIE: '' } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /cookie/i)
  assert.doesNotMatch(result.stderr, /at file:|node:internal/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ds-bot && node --test test/ai-os-cli.test.js`

Expected: FAIL because `cli.mjs` is absent.

- [ ] **Step 3: Implement the CLI**

```js
#!/usr/bin/env node
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadManifest } from './manifest.mjs'
import { createBundle } from './evidence.mjs'
import { createClient, freePort } from './client.mjs'
import { runManifest } from './run.mjs'

const main = async () => {
const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const manifestPath = args.get('--manifest')
const mode = args.get('--mode') ?? 'mock'
if (!manifestPath) throw new Error('--manifest is required')
if (!['mock', 'attached'].includes(mode)) throw new Error('--mode must be mock or attached')
const manifest = await loadManifest(manifestPath)
const runId = (args.get('--run-id') ?? `${manifest.id}-${Date.now()}`).replace(/[^a-z0-9-]/gi, '-').toLowerCase()
const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const runDir = join(repoRoot, '.aios-runs', runId)
const workspace = args.get('--workspace')
  ? resolve(args.get('--workspace'))
  : manifest.workspace.kind === 'scratch' ? join(runDir, 'workspace') : repoRoot
await mkdir(workspace, { recursive: true })
const baseUrl = mode === 'attached' ? (args.get('--base-url') ?? manifest.baseUrl) : undefined
if (mode === 'attached' && !baseUrl) throw new Error('base URL is required for attached mode')
const webPort = mode === 'mock' ? await freePort() : undefined
const mockPort = mode === 'mock' ? await freePort() : undefined
const client = createClient({
  mode, baseUrl,
  benchName: `aios-${runId}`,
  webPort, mockPort,
  cookie: process.env.DSBOT_RUN_COOKIE,
  cookieFile: args.get('--cookie-file'),
  repoRoot,
  benchScript: join(repoRoot, 'ds-bot', 'dev', 'bench.sh'),
})
const bundle = await createBundle({ runDir, manifest, mode, secrets: [process.env.DSBOT_RUN_COOKIE] })
try {
  await client.start()
  const result = await runManifest({ manifest, mode, client, bundle, workspace })
  console.log(JSON.stringify({ runId, runDir, status: result.status, failure: result.failure ?? null }, null, 2))
  process.exitCode = result.status === 'completed' ? 0 : 1
} finally {
  if (mode === 'mock' && !args.has('--keep')) await client.stop()
  if (!args.has('--keep') && mode === 'mock') await rm(workspace, { recursive: true, force: true })
}
}

main().catch(error => { console.error(error.message); process.exitCode = 2 })
```

- [ ] **Step 4: Add package scripts**

Modify `ds-bot/package.json` scripts:

```json
"aios:manifest": "node dev/ai-os/cli.mjs --manifest dev/ai-os/scenarios/restart-team.json --mode mock",
"aios:mock": "node dev/ai-os/cli.mjs --manifest dev/ai-os/scenarios/restart-team.json --mode mock",
"aios:attached": "node dev/ai-os/cli.mjs --manifest dev/ai-os/scenarios/attached-repository-check.json --mode attached"
```

- [ ] **Step 5: Run CLI tests and manifest smoke**

Run:

```bash
cd ds-bot
node --test test/ai-os-cli.test.js
npm run aios:manifest
```

Expected: manifest smoke starts a mock bench, completes or fails with a recorded result, and always stops the bench.

- [ ] **Step 6: Checkpoint without committing**

Run: `git diff --check && git status --short ds-bot/dev/ai-os ds-bot/test/ai-os-cli.test.js ds-bot/package.json`

Expected: no secret, run artifact or generated profile appears.

---

### Task 7: Documentation, cleanup and final gates

**Files:**
- Create: `ds-bot/dev/ai-os/README.md`
- Modify: `ds-bot/dev/check.sh` only if the new commands need a dedicated check step
- Modify: `docs/design/personal-ai-os.md` only if implementation changes a stated interface

**Interfaces:**
- README documents mock vs attached modes, secret handling, artifact retention and cleanup.
- No new production runtime is started.

- [ ] **Step 1: Write the harness README**

Include exact commands:

```bash
cd ds-bot
npm ci
npm run harness
node --test test/ai-os-manifest.test.js test/ai-os-evidence.test.js test/ai-os-client.test.js test/ai-os-run.test.js test/ai-os-cli.test.js
npm run aios:manifest
```

Document:

- Mock mode never proves model quality.
- Attached mode requires `DSBOT_RUN_COOKIE` or `--cookie-file`.
- The harness never reads `~/.dsh`.
- `.aios-runs/` and `.dsh-test-aios-*` are disposable.
- `result.json` is the only machine completion claim.
- A completed mock run and a completed live run are separate records.

- [ ] **Step 2: Run the focused harness suite**

```bash
cd ds-bot
node --test test/ai-os-manifest.test.js test/ai-os-evidence.test.js test/ai-os-client.test.js test/ai-os-run.test.js test/ai-os-cli.test.js
```

Expected: 0 failures.

- [ ] **Step 3: Run the repository gates**

```bash
cd ds-bot
npm test
node scripts/build-client.mjs --check
node scripts/build-link.mjs --check
npm run lint
```

Expected: unit tests pass, generated bundles are fresh, lint exits 0 with existing warnings only.

- [ ] **Step 4: Inspect the run bundle**

```bash
find ../.aios-runs -maxdepth 3 -type f | sort | tail -50
git status --short
ps -Ao pid,command | rg 'dsh|mock-llm' || true
```

Expected:

- only the intended run bundle exists;
- no `.dsh-test-aios-*` process remains;
- no cookie/token appears in artifacts;
- no generated profile or secret is tracked;
- no unrelated user changes are touched.

- [ ] **Step 5: Stop for review without commit**

Do not commit. Report:

- files changed;
- test commands and results;
- the run directory;
- the exact `result.json` status;
- remaining limitations;
- whether the task ran in `mock` or `attached/live` mode.

---

## Self-review

- **Spec coverage:** Phase 0 is covered by manifest validation, evidence, owned/attached clients, runner, scenarios, CLI, docs and gates.
- **Placeholder scan:** no `TODO`, `TBD`, “handle errors” or open-ended implementation steps.
- **Type consistency:** `Manifest`, `EvidenceBundle`, `Client` and `RunResult` names match every task.
- **Boundary check:** the harness calls existing `/api/bot` and `dev/bench.sh`; it does not add a runtime, task store, model route, roster or production path.
- **Security check:** commands use `spawn(..., { shell: false })`; cookies come from environment or an external file; logs redact secrets; tests target isolated or explicitly attached environments.
