// macOS updates without a Developer ID. The installed app is ad-hoc signed, so Squirrel.Mac
// (electron-updater) cannot verify a newer build: an ad-hoc bundle has no Team ID and its
// designated requirement collapses to a cdhash that changes with every build. This module
// checks the feed, downloads the zip, and checks an Ed25519 signature over the zip's sha256 —
// our own trust anchor, not Apple's. A detached shell script that outlives the app swaps the
// bundle the way app/scripts/install-local.sh does, and puts the old one back on any failure.
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { isNewer } from './updates.mjs'

/** The release asset that carries a self-updating build for this architecture. */
export const selfUpdateAsset = arch => version => `Anbot-${version}-mac-${arch}-selfupdate.zip`

/**
 * Check a feed for a newer self-updating build.
 * @param {{ current: string, arch: string, fetch?: typeof fetch, feed: string, log?: Console }} options
 * @returns {Promise<{ version: string, asset: string, url: string, signatureUrl: string } | undefined>}
 */
export async function findSelfUpdate({ current, arch, fetch = globalThis.fetch, feed, log = console }) {
  const assetName = selfUpdateAsset(arch)
  let response
  try {
    response = await fetch(feed, { headers: { 'user-agent': `Anbot/${current}` } })
  } catch (error) {
    log.error(`Anbot: update check failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  if (!response.ok) {
    log.error(`Anbot: update check failed: HTTP ${response.status}`)
    return undefined
  }
  const releases = await response.json().catch(() => undefined)
  if (!Array.isArray(releases)) {
    log.error('Anbot: update check failed: releases response is not an array')
    return undefined
  }
  let found
  for (const release of releases) {
    if (release === null || typeof release !== 'object' || release.draft === true || release.prerelease === true) continue
    const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/u, '') : ''
    if (!isNewer(version, current)) continue
    const asset = assetName(version)
    const entry = Array.isArray(release.assets) ? release.assets.find(candidate => candidate?.name === asset) : undefined
    if (entry === undefined || typeof entry.browser_download_url !== 'string') continue
    if (found === undefined || isNewer(version, found.version)) {
      found = { version, asset, url: entry.browser_download_url, signatureUrl: `${entry.browser_download_url}.sig` }
    }
  }
  return found
}

/** The key as the release pipeline writes it: base64 of the raw 32 bytes. */
export function publicKeyFromBase64(text) {
  const raw = Buffer.from(String(text).trim(), 'base64')
  if (raw.length !== 32) throw new Error('the update public key is not 32 bytes')
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
}

/** The public key the app ships in its resources; a missing one means no update installs. */
export async function readPublicKey(path) {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined || text.trim() === '') return undefined
  try {
    return publicKeyFromBase64(text)
  } catch {
    return undefined
  }
}

/** The same, for the startup path that decides whether this build can update itself at all. */
export function readPublicKeySync(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  if (text.trim() === '') return undefined
  try {
    return publicKeyFromBase64(text)
  } catch {
    return undefined
  }
}

/**
 * Download a zip and its detached signature, and check both. The signature covers the zip's
 * sha256, so it is checked after the download streams to disk and never needs the whole file
 * in memory. A signature that does not verify is the same failure as a tampered zip: the file
 * is deleted and nothing is installed.
 * @returns {Promise<{ zip: string, sha256: string }>}
 */
export async function downloadSelfUpdate({ found, dir, publicKey, fetch = globalThis.fetch, log = console }) {
  await mkdir(dir, { recursive: true })
  const zip = join(dir, found.asset)
  const response = await fetch(found.url, { headers: { 'user-agent': 'Anbot/self-update' } })
  if (!response.ok) throw new Error(`${found.url} returned HTTP ${response.status}`)
  const hash = createHash('sha256')
  await pipeline(response.body, async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk)
      yield chunk
    }
  }, createWriteStream(zip))
  const sha256 = hash.digest('hex')
  const signature = await fetch(found.signatureUrl, { headers: { 'user-agent': 'Anbot/self-update' } })
  if (!signature.ok) {
    await rm(zip, { force: true })
    throw new Error(`${found.signatureUrl} returned HTTP ${signature.status}`)
  }
  const signed = Buffer.from(await signature.text(), 'base64')
  if (!verifySignature(null, Buffer.from(sha256), publicKey, signed)) {
    await rm(zip, { force: true })
    throw new Error(`${found.asset} signature does not verify`)
  }
  log.info(`Anbot: update ${found.version} downloaded, signature verified`)
  return { zip, sha256 }
}

/** Where the download and the plan live: beside the app's own data, not in a temp folder. */
export const selfUpdateDir = userData => join(userData, 'self-update')

// The swap script runs detached after the app quits, so it must not depend on anything the
// bundle held. The plan is a shell file it sources: JSON would need an interpreter macOS does
// not ship.
const SWAP_SCRIPT = `#!/bin/bash
set -euo pipefail
. "$1"
old="$stage/previous.app"
restore() {
  if [[ -e "$old" && ! -e "$target" ]]; then /bin/mv "$old" "$target"; fi
  /bin/rm -rf "$stage"
}
trap restore ERR
/bin/rm -rf "$stage"
/bin/mkdir -p "$stage/extract"
/usr/bin/ditto -x -k "$zip" "$stage/extract"
new="$stage/extract/Anbot.app"
[[ -d "$new" ]] || { echo 'the zip holds no Anbot.app' >&2; exit 4; }
actual=$(/usr/bin/shasum -a 256 "$zip" | /usr/bin/awk '{print $1}')
[[ "$actual" == "$sha256" ]] || { echo 'the zip changed after the check' >&2; exit 5; }
/usr/bin/codesign --verify --deep --strict "$new"
/bin/chmod 755 "$stage"
if [[ -e "$target" ]]; then /bin/mv "$target" "$old"; fi
/bin/mv "$new" "$target"
trap - ERR
/bin/rm -rf "$stage"
/usr/bin/open "$target"
`

const shellQuote = value => `'${String(value).replaceAll("'", `'\\''`)}'`

/**
 * Write the plan and the swap script. The stage is created beside the app because a rename
 * cannot cross file systems, and the swap keeps the install path from being empty.
 * @param {{ dir: string, target: string, zip: string, sha256: string }} options
 * @returns {Promise<{ script: string, plan: string }>}
 */
export async function prepareSwap({ dir, target, zip, sha256 }) {
  const stage = await mkdtemp(join(dirname(target), '.anbot-update-'))
  const plan = join(dir, 'plan.sh')
  await writeFile(plan, [
    `target=${shellQuote(target)}`,
    `stage=${shellQuote(stage)}`,
    `zip=${shellQuote(zip)}`,
    `sha256=${shellQuote(sha256)}`,
    '',
  ].join('\n'))
  const script = join(dir, 'swap.sh')
  await writeFile(script, SWAP_SCRIPT)
  await chmod(script, 0o755)
  return { script, plan }
}

/** Leftovers of an update that never finished: the download folder and a stage beside the app. */
export async function clearSelfUpdate({ dir, stage }) {
  await rm(dir, { recursive: true, force: true })
  if (typeof stage === 'string' && stage !== '') await rm(stage, { recursive: true, force: true })
}

const CHECK_EVERY_MS = 4 * 60 * 60_000
const UPDATE_BUSY = new Set(['checking', 'downloading', 'downloaded'])

/**
 * The macOS updater, with the surface main.mjs drives on every platform: a check on a timer or
 * on demand, a download, and an install that quits the app into the swap script.
 * @param {{
 *   current: string, arch: string, feed: string, target: string, publicKey: import('node:crypto').KeyObject,
 *   dir: string, beforeInstall: () => Promise<void>, quit: () => void,
 *   ask?: (version: string) => Promise<boolean>, autoUpdate?: boolean,
 *   fetch?: typeof fetch, log?: Console,
 * }} options `ask` answers whether to restart now; without it the update installs at the next
 *   quit through `install`. `beforeInstall` stops the Host, which runs from the files the swap
 *   replaces, and `quit` ends the app.
 */
export function watchSelfUpdate(options) {
  const {
    current, arch, feed, target, publicKey, dir, beforeInstall, quit,
    ask, fetch = globalThis.fetch, log = console,
  } = options
  let auto = options.autoUpdate !== false
  let timer = null
  let found
  let asked
  let latest = Promise.resolve(null)
  let state = { phase: auto ? 'checking' : 'idle', autoUpdate: auto }
  const listeners = new Set()
  const set = (next) => {
    state = { ...next, autoUpdate: auto }
    for (const listener of [...listeners]) {
      try { listener(state) } catch (error) { log.error(`Anbot: an update state listener failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }

  const install = async () => {
    if (found === undefined) return
    const { zip, sha256 } = found
    const { script, plan } = await prepareSwap({ dir, target, zip, sha256 })
    await beforeInstall()
    const child = spawn('/bin/bash', [script, plan], { detached: true, stdio: 'ignore' })
    child.unref()
    quit()
  }

  const download = async () => {
    if (found === undefined) return false
    set({ phase: 'downloading', version: found.version })
    const { zip, sha256 } = await downloadSelfUpdate({ found, dir, publicKey, fetch, log })
    found = { ...found, zip, sha256 }
    set({ phase: 'downloaded', version: found.version })
    if (ask === undefined || asked === found.version) return true
    asked = found.version
    void ask(found.version).then(now => (now ? install() : undefined))
      .catch((error) => { log.error(`Anbot: update ${found.version} not installed: ${error instanceof Error ? error.message : String(error)}`) })
    return true
  }

  const run = async () => {
    set({ phase: 'checking' })
    const next = await findSelfUpdate({ current, arch, fetch, feed, log })
    if (next === undefined) {
      set({ phase: 'current' })
      return null
    }
    found = next
    log.info(`Anbot: update ${next.version} available`)
    set({ phase: 'available', version: next.version })
    if (auto) await download().catch((error) => {
      log.error(`Anbot: update ${next.version} not downloaded: ${error instanceof Error ? error.message : String(error)}`)
      set({ phase: 'failed', version: next.version, error: error instanceof Error ? error.message : String(error) })
    })
    return next
  }

  const check = () => {
    if (UPDATE_BUSY.has(state.phase)) return
    latest = Promise.resolve().then(run).catch(() => null)
  }
  const startTimer = () => {
    if (timer !== null || !auto) return
    timer = setInterval(() => { if (auto && !UPDATE_BUSY.has(state.phase)) check() }, CHECK_EVERY_MS)
    timer.unref?.()
  }
  const setAutoUpdate = (enabled) => {
    const wanted = Boolean(enabled)
    if (wanted === auto) return state
    auto = wanted
    if (auto) {
      startTimer()
      if (state.phase === 'idle' || state.phase === 'failed') check()
      else set({ ...state })
    } else {
      if (timer !== null) { clearInterval(timer); timer = null }
      latest = Promise.resolve(null)
      set({ phase: 'idle' })
    }
    return state
  }
  if (auto) {
    latest = Promise.resolve().then(run).catch(() => null)
    startTimer()
  }
  return {
    stop: () => { if (timer !== null) { clearInterval(timer); timer = null } },
    latest: () => latest, state: () => state, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    check, download, install, setAutoUpdate,
  }
}
