import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { APP_ID, configureIdentity, LEGACY_PRODUCT_NAMES, PRODUCT_NAME } from '../src/legacy.mjs'

const UPSTREAM_APP_ID = 'io.github.fei2411.dsbot'
const UPSTREAM_INSTALLER_GUID = '32c46dfc-ed78-5d41-85a4-a3c7f083f2e0'

function fixture({ existing = [], packaged = true } = {}) {
  const app = new EventEmitter()
  const appData = join(tmpdir(), 'anbot-identity-fixture')
  const current = join(appData, PRODUCT_NAME)
  const paths = { appData, userData: current }
  const names = []
  Object.assign(app, {
    isPackaged: packaged,
    getPath: name => paths[name],
    setPath: (name, value) => { paths[name] = value },
    setName: name => names.push(name),
    setAppUserModelId: id => { app.id = id },
  })
  const exists = path => existing.includes(path)
  return { app, paths, names, current, appData, exists }
}

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: an upstream DS Bot installation keeps its shell data and encryption identity`, () => {
    const f = fixture()
    const previous = join(f.appData, 'DS Bot')
    let created
    const options = { env: {}, platform, mkdir: path => { created = path }, exists: path => path === previous }
    assert.deepEqual(configureIdentity(f.app, options), { userData: previous, legacy: true, legacyName: 'DS Bot' })
    assert.equal(f.paths.sessionData, previous)
    assert.equal(created, previous)
    if (platform === 'win32') {
      assert.equal(f.app.id, APP_ID)
      assert.deepEqual(f.names, [])
    } else {
      assert.deepEqual(f.names, ['DS Bot'])
      f.app.emit('ready')
      assert.deepEqual(f.names, ['DS Bot', PRODUCT_NAME])
    }
  })
}

test('the older DeepSeek Bot installation is reused when DS Bot has no shell directory', () => {
  const f = fixture()
  const previous = join(f.appData, 'DeepSeek Bot')
  const result = configureIdentity(f.app, { env: {}, platform: 'darwin', mkdir: () => {}, exists: path => path === previous })
  assert.deepEqual(result, { userData: previous, legacy: true, legacyName: 'DeepSeek Bot' })
  assert.deepEqual(f.names, ['DeepSeek Bot'])
})

test('DS Bot wins when both earlier shell directories exist', () => {
  const f = fixture()
  const dsBot = join(f.appData, 'DS Bot')
  const deepSeek = join(f.appData, 'DeepSeek Bot')
  const result = configureIdentity(f.app, { env: {}, platform: 'linux', mkdir: () => {}, exists: path => [dsBot, deepSeek].includes(path) })
  assert.equal(result.userData, dsBot)
  assert.equal(result.legacyName, 'DS Bot')
  assert.deepEqual([...LEGACY_PRODUCT_NAMES], ['DS Bot', 'DeepSeek Bot'])
})

test('a fresh installation uses the Anbot shell directory', () => {
  const f = fixture()
  assert.deepEqual(configureIdentity(f.app, { env: {}, platform: 'linux', mkdir: () => {}, exists: f.exists }), {
    userData: f.current, legacy: false, legacyName: undefined,
  })
  assert.deepEqual(f.names, [])
})

test('an already configured Anbot installation wins when the earlier directories also exist', () => {
  const f = fixture()
  const existing = [join(f.appData, 'DS Bot'), join(f.appData, 'DeepSeek Bot'), join(f.current, 'locations.json')]
  assert.deepEqual(configureIdentity(f.app, { env: {}, platform: 'linux', mkdir: () => {}, exists: path => existing.includes(path) }), {
    userData: f.current, legacy: false, legacyName: undefined,
  })
})

test('an explicit shell directory never probes installed user data', () => {
  const f = fixture()
  const explicit = join(tmpdir(), 'anbot-custom-shell')
  assert.deepEqual(configureIdentity(f.app, { env: { DS_BOT_SHELL_DATA: explicit }, mkdir: () => {}, exists: () => { throw new Error('must not probe') } }), {
    userData: explicit, legacy: false, legacyName: undefined,
  })
  assert.equal(f.paths.sessionData, explicit)
})

test('an isolated data run never probes an installed application', () => {
  const f = fixture({ packaged: false })
  assert.equal(configureIdentity(f.app, { env: { DS_BOT_HOME: '/tmp/anbot-test-data' }, mkdir: () => {}, exists: () => { throw new Error('must not probe') } }).userData, f.current)
})

test('a source installation also keeps an earlier shell directory', () => {
  const f = fixture({ packaged: false })
  const previous = join(f.appData, 'DS Bot')
  assert.equal(configureIdentity(f.app, { env: {}, mkdir: () => {}, exists: path => path === previous }).userData, previous)
})

test('the package and builder use the Anbot identity while retaining the installed-app upgrade path', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'anbot')
  assert.equal(pkg.private, true)
  assert.equal(pkg.productName, PRODUCT_NAME)
  assert.equal(pkg.homepage, 'https://github.com/rml4791lol-lang/Anbot')
  assert.equal(pkg.dependencies['ds-bot'], 'file:../ds-bot')
  assert.equal(config.appId, UPSTREAM_APP_ID, "Preserve the macOS installation identity")
  assert.equal(config.productName, PRODUCT_NAME)
  assert.equal(config.artifactName, 'Anbot-${version}-${os}-${arch}.${ext}')
  assert.equal(config.publish.owner, 'rml4791lol-lang')
  assert.equal(config.publish.repo, 'Anbot')
  assert.equal(config.nsis.guid, UPSTREAM_INSTALLER_GUID)
  for (const oldPackage of ['dsbot', 'deepseek-bot']) {
    assert.ok(config.deb.fpm.includes(`--replaces=${oldPackage}`) || config.deb.fpm.some((value, index, all) => value === '--replaces' && all[index + 1] === oldPackage), oldPackage)
    assert.ok(config.deb.fpm.includes(`--conflicts=${oldPackage}`) || config.deb.fpm.some((value, index, all) => value === '--conflicts' && all[index + 1] === oldPackage), oldPackage)
  }
})
