import { spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const MAX_OUTPUT = 1024 * 1024

function within(root, path) {
  const base = resolve(root)
  const target = resolve(base, path)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes workspace: ${path}`)
  return target
}

function appendCapped(current, chunk) {
  if (current.length >= MAX_OUTPUT) return current
  return (current + chunk.toString()).slice(0, MAX_OUTPUT)
}

function command(argv, cwd, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout = appendCapped(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = appendCapped(stderr, chunk) })
    child.once('error', error => finish(reject, error))
    child.once('close', code => {
      if (timedOut) finish(reject, Object.assign(new Error('command timed out'), { code: 'AIOS_TIMEOUT', stdout, stderr }))
      else finish(resolvePromise, { code: code ?? -1, stdout, stderr })
    })
  })
}

function pointerOf(root, pointer = '') {
  return pointer.split('/').filter(Boolean).reduce((node, raw) => {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    return node == null ? undefined : node[key]
  }, root)
}

function meets(check, value) {
  if (check.minLength === undefined) return value !== undefined
  if (value === undefined || value === null) return false
  if (Array.isArray(value) || typeof value === 'string') return value.length >= check.minLength
  return check.minLength === 0
}

export async function runManifest({ manifest, mode, client, bundle, workspace }) {
  const steps = []
  const acceptance = []
  let active
  try {
    for (const step of manifest.steps ?? []) {
      active = step.id
      if (step.kind === 'api') {
        const value = await client.api(step.endpoint, step.payload ?? {})
        await bundle.record({ kind: 'api', step: step.id, endpoint: step.endpoint, value })
      } else if (step.kind === 'command') {
        const cwd = within(workspace, step.cwd ?? '.')
        const result = await command(step.argv, cwd, step.timeoutMs ?? manifest.timeoutMs)
        await bundle.record({ kind: 'command', step: step.id, argv: step.argv, cwd, ...result })
        if (result.code !== 0) throw Object.assign(new Error(`command failed: ${step.id}`), { code: 'AIOS_COMMAND', stdout: result.stdout, stderr: result.stderr })
      } else if (step.kind === 'capture') {
        const value = await client.api(step.endpoint, step.payload ?? {})
        const target = within(workspace, step.path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
        await bundle.record({ kind: 'capture', step: step.id, endpoint: step.endpoint, path: target })
      } else if (step.kind === 'restart') {
        await client.restart()
        await bundle.record({ kind: 'restart', step: step.id })
      } else if (step.kind === 'file') {
        const target = within(workspace, step.path)
        await access(target)
        await bundle.record({ kind: 'file', step: step.id, path: target })
      } else if (step.kind === 'wait') {
        await new Promise(done => setTimeout(done, step.ms))
        await bundle.record({ kind: 'wait', step: step.id, ms: step.ms })
      } else {
        throw new Error(`unknown step kind: ${step.kind}`)
      }
      if (step.expect !== undefined) {
        const state = await client.state()
        if (!JSON.stringify(state).includes(step.expect)) throw new Error(`expectation failed: ${step.id}`)
      }
      steps.push({ id: step.id, kind: step.kind, ok: true })
    }
    active = undefined
    for (const check of manifest.acceptance ?? []) {
      active = check.id
      if (check.kind === 'file') {
        const path = within(workspace, check.path)
        await access(path)
        acceptance.push({ id: check.id, ok: true, path })
      } else if (check.kind === 'json') {
        const root = JSON.parse(await readFile(within(workspace, check.path), 'utf8'))
        const value = pointerOf(root, check.pointer)
        if (!meets(check, value)) throw new Error(`json acceptance failed: ${check.id}`)
        acceptance.push({ id: check.id, ok: true })
      } else {
        throw new Error(`unknown acceptance kind: ${check.kind}`)
      }
      await bundle.record({ kind: 'acceptance', ...acceptance.at(-1) })
    }
    await bundle.finish({ status: 'completed', mode, steps, acceptance })
    return { status: 'completed', steps, acceptance }
  } catch (error) {
    const failure = {
      message: error?.message ?? String(error),
      code: error?.code ?? 'AIOS_RUN',
      ...(active === undefined ? {} : { step: active }),
      ...(error?.stdout === undefined ? {} : { stdout: error.stdout }),
      ...(error?.stderr === undefined ? {} : { stderr: error.stderr }),
    }
    await bundle.finish({ status: 'failed', mode, steps, acceptance, failure })
    return { status: 'failed', steps, acceptance, failure }
  }
}
