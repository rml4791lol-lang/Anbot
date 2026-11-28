// The macOS self-update: a feed check, a signed download, and the plan for the swap script.
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import {
  clearSelfUpdate, downloadSelfUpdate, findSelfUpdate, prepareSwap, publicKeyFromBase64,
  readPublicKey, readPublicKeySync, selfUpdateAsset, selfUpdateDir, watchSelfUpdate,
} from '../src/self-update.mjs'

const quiet = { info() {}, error() {} }

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-self-update-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'jwk' }).x
  return { publicKey, privateKey, base64: Buffer.from(raw, 'base64url').toString('base64') }
}

const release = (version, arch, url = `https://example.test/v${version}/Anbot-${version}-mac-${arch}.zip`) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: [{ name: selfUpdateAsset(arch)(version), browser_download_url: url }],
})

const feedOf = releases => async () => new Response(JSON.stringify(releases), { status: 200, headers: { 'content-type': 'application/json' } })

describe('self-update', () => {
  test('finds the newest self-updating build and ignores other architectures and drafts', async () => {
    const fetch = feedOf([
      release('0.0.4', 'arm64'),
      release('0.0.5', 'arm64'),
      release('0.0.6', 'arm64'),
      { ...release('0.0.9', 'arm64'), draft: true },
      { ...release('0.1.0', 'arm64'), prerelease: true },
    ])
    const found = await findSelfUpdate({ current: '0.0.3', arch: 'arm64', fetch, feed: 'https://example.test/feed', log: quiet })
    assert.equal(found.version, '0.0.6')
    assert.equal(found.asset, 'Anbot-0.0.6-mac-arm64.zip')
    assert.equal(found.signatureUrl, `${found.url}.sig`)
  })

  test('a release without our asset does not count, and an older one is not offered', async () => {
    const fetch = feedOf([{ tag_name: 'v9.9.9', draft: false, prerelease: false, assets: [{ name: 'other.zip', browser_download_url: 'https://example.test/x.zip' }] }])
    assert.equal(await findSelfUpdate({ current: '0.0.3', arch: 'arm64', fetch, feed: 'https://example.test/feed', log: quiet }), undefined)
    const older = feedOf([release('0.0.2', 'arm64')])
    assert.equal(await findSelfUpdate({ current: '0.0.3', arch: 'arm64', fetch: older, feed: 'https://example.test/feed', log: quiet }), undefined)
  })

  test('a failed check is reported and returns nothing', async () => {
    const errors = []
    const log = { info() {}, error: message => errors.push(message) }
    assert.equal(await findSelfUpdate({ current: '0.0.3', arch: 'arm64', fetch: async () => new Response('no', { status: 500 }), feed: 'f', log }), undefined)
    assert.equal(await findSelfUpdate({ current: '0.0.3', arch: 'arm64', fetch: async () => { throw new Error('offline') }, feed: 'f', log }), undefined)
    assert.equal(errors.length, 2)
  })

  test('downloads only when the signature over the digest verifies', async (t) => {
    const dir = tmp(t)
    const { privateKey, base64 } = keys()
    const body = Buffer.from('the zip bytes')
    const digest = createHash('sha256').update(body).digest('hex')
    const signature = sign(null, Buffer.from(digest), privateKey).toString('base64')
    const fetch = async (url) => {
      if (url.endsWith('.sig')) return new Response(signature, { status: 200 })
      return new Response(body, { status: 200 })
    }
    const found = { version: '0.0.4', asset: 'Anbot-0.0.4-mac-arm64.zip', url: 'https://example.test/x.zip', signatureUrl: 'https://example.test/x.zip.sig' }
    const result = await downloadSelfUpdate({ found, dir, publicKey: publicKeyFromBase64(base64), fetch, log: quiet })
    assert.equal(result.sha256, digest)
    assert.equal(readFileSync(result.zip).toString(), body.toString())
  })

  test('a wrong signature leaves nothing on disk', async (t) => {
    const dir = tmp(t)
    const { base64 } = keys()
    const other = keys()
    const digest = createHash('sha256').update('bytes').digest('hex')
    const signature = sign(null, Buffer.from(digest), other.privateKey).toString('base64')
    const fetch = async (url) => (url.endsWith('.sig') ? new Response(signature, { status: 200 }) : new Response('bytes', { status: 200 }))
    const found = { version: '0.0.4', asset: 'Anbot-0.0.4-mac-arm64.zip', url: 'https://example.test/x.zip', signatureUrl: 'https://example.test/x.zip.sig' }
    await assert.rejects(
      downloadSelfUpdate({ found, dir, publicKey: publicKeyFromBase64(base64), fetch, log: quiet }),
      /signature does not verify/u,
    )
    assert.equal(existsSync(join(dir, found.asset)), false)
  })

  test('a public key has to be 32 bytes', () => {
    assert.throws(() => publicKeyFromBase64(Buffer.from('short').toString('base64')), /32 bytes/u)
    assert.equal(publicKeyFromBase64(keys().base64).asymmetricKeyType, 'ed25519')
  })

  test('a missing or broken key file reads as no key', async (t) => {
    const dir = tmp(t)
    assert.equal(await readPublicKey(join(dir, 'missing')), undefined)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'bad'), 'not a key')
    assert.equal(await readPublicKey(join(dir, 'bad')), undefined)
    writeFileSync(join(dir, 'good'), keys().base64)
    assert.equal((await readPublicKey(join(dir, 'good'))).asymmetricKeyType, 'ed25519')
  })

  test('the swap plan quotes every path and the script is executable', async (t) => {
    const dir = tmp(t)
    const appDir = join(dir, 'Applications with a space')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(appDir, { recursive: true })
    const target = join(appDir, "Anbot's.app")
    const { script, plan } = await prepareSwap({ dir, target, zip: join(dir, 'update.zip'), sha256: 'a'.repeat(64) })
    const text = readFileSync(plan, 'utf8')
    assert.match(text, /^target='.*Anbot'\\''s\.app'$/mu)
    assert.match(text, /^sha256='[a-f]{64}'$/mu)
    assert.match(text, /^stage='\/.*\.anbot-update-/mu)
    assert.equal(statSync(script).mode & 0o777, 0o755)
    assert.match(readFileSync(script, 'utf8'), /codesign --verify --deep --strict/u)
    await clearSelfUpdate({ dir, stage: /^stage='(.*)'$/mu.exec(text)[1] })
    assert.equal(existsSync(dir), false)
    assert.equal(existsSync(/^stage='(.*)'$/mu.exec(text)[1]), false)
  })

  test('the download folder sits under userData', () => {
    assert.equal(selfUpdateDir('/Users/x/Library/Application Support/Anbot'), '/Users/x/Library/Application Support/Anbot/self-update')
  })

  test('a check with autoUpdate on downloads at once and installs on a yes', async (t) => {
    const dir = tmp(t)
    const appDir = join(dir, 'Anbot.app')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(appDir, { recursive: true })
    const { privateKey, base64 } = keys()
    const body = Buffer.from('zip')
    const digest = createHash('sha256').update(body).digest('hex')
    const signature = sign(null, Buffer.from(digest), privateKey).toString('base64')
    const fetch = async (url) => {
      if (String(url).includes('/releases')) return new Response(JSON.stringify([release('0.0.4', 'arm64')]), { status: 200 })
      if (String(url).endsWith('.sig')) return new Response(signature, { status: 200 })
      return new Response(body, { status: 200 })
    }
    const asked = []
    let quit = 0
    const watcher = watchSelfUpdate({
      current: '0.0.3', arch: 'arm64', feed: 'https://example.test/releases', target: appDir,
      publicKey: publicKeyFromBase64(base64), dir: join(dir, 'downloads'), fetch, log: quiet,
      beforeInstall: async () => {}, quit: () => { quit += 1 },
      ask: async (version) => { asked.push(version); return false },
    })
    t.after(() => watcher.stop())
    await watcher.latest()
    assert.equal(watcher.state().phase, 'downloaded')
    assert.equal(watcher.state().version, '0.0.4')
    await new Promise(resolve => { setTimeout(resolve, 10) })
    assert.deepEqual(asked, ['0.0.4'])
    assert.equal(quit, 0)
  })

  test('a failed signature leaves the state failed and the feed check on demand works', async (t) => {
    const dir = tmp(t)
    const appDir = join(dir, 'Anbot.app')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(appDir, { recursive: true })
    const { base64 } = keys()
    const fetch = async (url) => {
      if (String(url).includes('/releases')) return new Response(JSON.stringify([release('0.0.4', 'arm64')]), { status: 200 })
      if (String(url).endsWith('.sig')) return new Response(sign(null, Buffer.from('nope'), keys().privateKey).toString('base64'), { status: 200 })
      return new Response('zip', { status: 200 })
    }
    const watcher = watchSelfUpdate({
      current: '0.0.3', arch: 'arm64', feed: 'https://example.test/releases', target: appDir,
      publicKey: publicKeyFromBase64(base64), dir: join(dir, 'downloads'), fetch, log: quiet,
      beforeInstall: async () => {}, quit: () => {}, autoUpdate: false,
    })
    t.after(() => watcher.stop())
    await watcher.latest()
    assert.equal(watcher.state().phase, 'idle')
    watcher.check()
    await watcher.latest()
    assert.equal(watcher.state().phase, 'available')
    await assert.rejects(watcher.download(), /signature does not verify/u)
    assert.equal(watcher.state().phase, 'downloading')
  })

  test('the sync key reader matches the async one', async (t) => {
    const dir = tmp(t)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'key'), keys().base64)
    const sync = readPublicKeySync(join(dir, 'key'))
    const async = await readPublicKey(join(dir, 'key'))
    assert.equal(sync.asymmetricKeyType, 'ed25519')
    assert.equal(sync.export({ format: 'jwk' }).x, async.export({ format: 'jwk' }).x)
    assert.equal(readPublicKeySync(join(dir, 'missing')), undefined)
  })
})
