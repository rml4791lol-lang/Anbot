// The boot path must not touch the Keychain: neither the app's own safe-storage record nor a
// browser cookie Keychain item. Any unlock prompt shown at startup would come from one of those.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'
import { app, state, storageCalls } from './helpers/fake-electron.mjs'
import { host } from './helpers/fake-host-process.mjs'
import { startApp, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

const require = createRequire(import.meta.url)
const cp = require('node:child_process')
const securityCalls = []
const recordSecurity = (cmd, args) => {
  if (String(cmd).includes('security') || (Array.isArray(args) && args.includes('find-generic-password'))) {
    securityCalls.push([cmd, args])
  }
}
const originalExecFile = cp.execFile
cp.execFile = (cmd, args, opts, cb) => {
  recordSecurity(cmd, args)
  return originalExecFile(cmd, args, opts, cb)
}
const originalSpawn = cp.spawn
cp.spawn = (cmd, args, options) => {
  recordSecurity(cmd, args)
  return originalSpawn(cmd, args, options)
}

const zeroStorage = () => {
  assert.equal(storageCalls.isEncryptionAvailable, 0, 'safeStorage.isEncryptionAvailable is not called at boot')
  assert.equal(storageCalls.getSelectedStorageBackend, 0, 'safeStorage.getSelectedStorageBackend is not called at boot')
  assert.equal(storageCalls.encryptString, 0, 'safeStorage.encryptString is not called at boot')
  assert.equal(storageCalls.decryptString, 0, 'safeStorage.decryptString is not called at boot')
}

before(async () => { await startApp() })

after(() => {
  app.emit('will-quit')
  cp.execFile = originalExecFile
  cp.spawn = originalSpawn
})

test('boot touches neither the app keychain nor browser cookie keychains', async () => {
  await waitFor(() => state.windows.length > 0, 'open a window')
  zeroStorage()
  assert.deepEqual(securityCalls, [], 'no security find-generic-password at boot')
})

test('a plain ChatGPT status query stays in memory and still touches no keychain', async () => {
  const engine = host()
  assert.ok(engine, 'the Host started')
  engine.emit({ type: 'ds-bot:chatgpt', id: 'boot-status', method: 'chatgpt:status' })
  // The bridge answers asynchronously; let the reply settle before counting again.
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  zeroStorage()
  assert.deepEqual(securityCalls, [], 'no security find-generic-password for a status query')
})
