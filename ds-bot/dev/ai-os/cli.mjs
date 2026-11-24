#!/usr/bin/env node
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createBundle } from './evidence.mjs'
import { createClient, freePort } from './client.mjs'
import { loadManifest } from './manifest.mjs'
import { runManifest } from './run.mjs'

export function clientModeFor(mode) {
  if (mode === 'mock') return 'owned'
  if (mode === 'attached') return 'attached'
  throw new Error('--mode must be mock or attached')
}

function parse(argv) {
  const options = { keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--keep') {
      options.keep = true
      continue
    }
    if (!arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    options[arg.slice(2)] = value
    index += 1
  }
  return options
}

async function main() {
  const options = parse(process.argv.slice(2))
  const manifestPath = options.manifest
  const mode = options.mode ?? 'mock'
  if (!manifestPath) throw new Error('--manifest is required')
  clientModeFor(mode)
  const manifest = await loadManifest(manifestPath)
  if (!manifest.modes.includes(mode)) throw new Error(`${manifest.id} does not support ${mode} mode`)

  const baseUrl = mode === 'attached' ? (options['base-url'] ?? manifest.baseUrl) : undefined
  if (mode === 'attached' && !baseUrl) throw new Error('base URL is required for attached mode')
  const cookieFile = options['cookie-file']
  const envCookie = process.env.DSBOT_RUN_COOKIE
  const cookie = envCookie || (cookieFile ? (await readFile(cookieFile, 'utf8')).trim() : undefined)
  if (mode === 'attached' && !cookie) throw new Error('attached mode needs a session cookie or cookie file')

  const runId = (options['run-id'] ?? `${manifest.id}-${Date.now()}`).replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  if (runId === '') throw new Error('--run-id must contain a letter or digit')
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
  const runDir = join(repoRoot, '.aios-runs', runId)
  const workspace = options.workspace
    ? resolve(options.workspace)
    : manifest.workspace.kind === 'scratch'
      ? join(runDir, 'workspace')
      : resolve(repoRoot, manifest.workspace.path)
  await mkdir(workspace, { recursive: true })
  const webPort = mode === 'mock' ? await freePort() : undefined
  const mockPort = mode === 'mock' ? await freePort() : undefined
  const client = createClient({
    mode: clientModeFor(mode),
    baseUrl,
    benchName: `aios-${runId}`,
    webPort,
    mockPort,
    cookie,
    cookieFile,
    repoRoot,
    fetchImpl: fetch,
    benchScript: join(repoRoot, 'ds-bot', 'dev', 'bench.sh'),
  })
  const bundle = await createBundle({ runDir, manifest, mode, secrets: [envCookie, cookie] })
  try {
    await client.start()
    const result = await runManifest({ manifest, mode, client, bundle, workspace })
    console.log(JSON.stringify({ runId, runDir, status: result.status, failure: result.failure ?? null }, null, 2))
    process.exitCode = result.status === 'completed' ? 0 : 1
  } finally {
    if (mode === 'mock' && !options.keep) await client.stop()
    if (mode === 'mock' && manifest.workspace.kind === 'scratch' && !options.keep) {
      await rm(workspace, { recursive: true, force: true })
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error?.message ?? String(error))
    process.exitCode = 2
  })
}
