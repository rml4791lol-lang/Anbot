import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { parse } from 'yaml'
import { APP_PATCH_NAME, APP_PATCH_ROWS, writeAppPatch } from '../src/app-patch.mjs'
import { loadAppProfile } from '../src/profile.mjs'
import { composeOwnedRow } from '../src/profile-overlay.mjs'

test('owned overlays merge mappings and replace arrays and Cordis expressions as units', () => {
  const id = { id: 'owned', name: 'plugin' }
  const current = { ...id, config: { preferences: { unchanged: 1, flags: { a: true, b: true } }, paths: ['old'], condition: { __jsExpr: 'true' } } }
  const override = { ...id, config: { preferences: { flags: { a: false } }, paths: [], condition: { value: 'fixed' } } }
  assert.deepEqual(composeOwnedRow(current, override), {
    ...id, config: { preferences: { unchanged: 1, flags: { a: false, b: true } }, paths: [], condition: { value: 'fixed' } },
  })
  assert.equal(current.config.preferences.flags.a, true)
  assert.equal(composeOwnedRow({ ...current, name: 'different-plugin' }, override), undefined)
})

test('owned overlays refuse nested provider keys, routes and unsafe object keys', () => {
  const row = { id: 'owned', name: 'plugin', config: { enabled: true } }
  for (const key of ['apiKey', 'X-API-Key', 'base_url', 'authorization', '__proto__']) {
    const config = { profiles: [{ [key]: 'fixture-only' }] }
    assert.equal(composeOwnedRow({ ...row, config }, row), undefined)
    assert.equal(composeOwnedRow(row, { ...row, config }), undefined)
  }
  assert.equal(Object.prototype['fixture-only'], undefined)
})

test('owned overlays leave opaque header and environment configuration in its original layer', () => {
  const row = { id: 'owned', name: 'plugin', config: { enabled: true } }
  const protectedConfigs = [
    { transport: { extra: [{ headers: { 'X-Private': 'fixture-only' } }] } },
    { tool: { env: { SERVICE_VALUE: 'fixture-only' } } },
    { service: { SERVICE_TOKEN: 'fixture-only' } },
    { service: { signingPrivateKey: 'fixture-only' } },
  ]
  for (const config of protectedConfigs) {
    assert.equal(composeOwnedRow({ ...row, config }, row), undefined)
    assert.equal(composeOwnedRow(row, { ...row, config }), undefined)
  }
})

// Every row of an entry list, with the rows inside groups.
function rows(entries) {
  return entries.flatMap((entry) => [
    entry,
    ...rows(Array.isArray(entry.config) ? entry.config : []),
    ...rows(Array.isArray(entry.config?.plugins) ? entry.config.plugins : []),
  ])
}

describe('writeAppPatch', () => {
  let home
  before(() => { home = mkdtempSync(join(tmpdir(), 'ds-bot-app-patch-')) })
  after(() => { rmSync(home, { recursive: true, force: true }) })

  test('writes one row that turns off the automatic credential step, next to the profiles', () => {
    const dir = join(home, 'profiles', 'ds-bot')
    mkdirSync(dir, { recursive: true })
    const [file, ...more] = writeAppPatch({ dir, patchPath: join(dir, 'cordis.patch.yml') })
    assert.deepEqual(more, [])
    // Outside the profile directory itself, so DSH only reads it through patchFiles.
    assert.equal(file, join(home, 'profiles', APP_PATCH_NAME))
    assert.deepEqual(parse(readFileSync(file, 'utf8')), [
      { id: 'ui-settings-models', name: '@deepseek-ai/dsh-client-ui-settings-models', config: { credentialOnboarding: false } },
    ])
  })

  test('writes the file again on every launch and never carries a Settings page row', () => {
    const dir = join(home, 'profiles', 'ds-bot')
    const file = join(home, 'profiles', APP_PATCH_NAME)
    writeFileSync(file, '- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: x\n')
    writeAppPatch({ dir })
    const written = parse(readFileSync(file, 'utf8'))
    assert.deepEqual(written, APP_PATCH_ROWS)
    assert.equal(written.some(row => row.id === 'ui-settings-general'), false)
  })
})

describe('the overlay on the pinned DSH', () => {
  let home
  let profile
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'ds-bot-app-patch-profile-'))
    process.env.DSH_HOME = home
    profile = loadAppProfile()
  })
  after(() => { rmSync(home, { recursive: true, force: true }) })

  // A row DSH renamed would only log a warning, and a config key DSH added would be wiped.
  test('targets a row the app profile mounts, whose whole config it restates', () => {
    const entries = rows(composeEntries([...profile.layers.map(layer => layer.patches), profile.patches]))
    const [patched] = APP_PATCH_ROWS
    const row = entries.find(entry => entry.id === patched.id)
    assert.ok(row, `${patched.id} is in the app profile`)
    assert.equal(row.name, patched.name)
    assert.notEqual(row.disabled, true)
    assert.deepEqual(Object.keys(row.config ?? {}).filter(key => !(key in patched.config)), [])
  })

  test('sets credentialOnboarding to false once laid over the profile', () => {
    const [file] = writeAppPatch(profile)
    assert.equal(dirname(file), dirname(profile.dir))
    const layers = [...profile.layers.map(layer => layer.patches), profile.patches, parse(readFileSync(file, 'utf8'))]
    const row = rows(composeEntries(layers)).find(entry => entry.id === 'ui-settings-models')
    assert.deepEqual(row.config, { credentialOnboarding: false })
  })

  test('preserves existing model-settings options when the desktop adds its own override', () => {
    const patch = { id: 'ui-settings-models', config: { credentialOnboarding: true, custom: { keep: ['one'] } } }
    const configured = { ...profile, patches: [...profile.patches, patch] }
    const [file] = writeAppPatch(configured)
    const layers = [...configured.layers.map(layer => layer.patches), configured.patches, parse(readFileSync(file, 'utf8'))]
    const row = rows(composeEntries(layers)).find(entry => entry.id === patch.id)
    assert.deepEqual(row.config, { credentialOnboarding: false, custom: { keep: ['one'] } })
  })

  test('drops the generated file when the effective row can no longer be restated safely', () => {
    const [file] = writeAppPatch(profile)
    assert.ok(existsSync(file))
    const configured = { ...profile, patches: [...profile.patches, {
      id: 'ui-settings-models', config: { credentialOnboarding: true, custom: { apiKey: 'fixture-only' } },
    }] }
    assert.deepEqual(writeAppPatch(configured), [])
    assert.equal(existsSync(file), false)
  })
})
