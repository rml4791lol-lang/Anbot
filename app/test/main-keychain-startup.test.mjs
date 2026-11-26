// The boot path must not touch the Keychain: neither the app's own safe-storage record nor a
// browser cookie Keychain item. Any unlock prompt shown at startup would come from one of those.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'
import { app, safeStorage, state } from './helpers/fake-electron.mjs'
import { startApp, waitFor } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

const require = createRequire(import.meta.url)
const cp = require('node:child_process')
const securityCalls = []
const originalExecFile = cp.execFile
cp.execFile = (cmd, args, opts, cb) => {
  if (String(cmd).includes('security') || (Array.isArray(args) && args.includes('find-generic-password'))) {
    securityCalls.push([cmd, args])
  }
  return originalExecFile(cmd, args, opts, cb)
}

const storageCalls = { decrypt: 0, encrypt: 0 }
safeStorage.decryptString = () => { storageCalls.decrypt += 1; throw new Error('decryptString must not run at boot') }
safeStorage.encryptString = () => { storageCalls.encrypt += 1; throw new Error('encryptString must not run at boot') }

before(async () => { await startApp() })

after(() => {
  app.emit('will-quit')
  cp.execFile = originalExecFile
})

test('boot touches neither the app keychain nor browser cookie keychains', async () => {
  await waitFor(() => state.windows.length > 0, 'open a window')
  assert.equal(storageCalls.decrypt, 0, 'safeStorage.decryptString is not called at boot')
  assert.equal(storageCalls.encrypt, 0, 'safeStorage.encryptString is not called at boot')
  assert.deepEqual(securityCalls, [], 'no security find-generic-password -w at boot')
})
