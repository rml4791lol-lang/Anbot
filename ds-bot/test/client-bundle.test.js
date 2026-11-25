import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { bundleClient, bundleOffice } from '../scripts/build-client.mjs'

const committed = () => readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const committedOffice = () => readFileSync(new URL('../office.js', import.meta.url), 'utf8')

test('client.js is the build of src/client', async () => {
  assert.equal(await bundleClient(), committed(), 'client.js is stale: run `npm run build` and commit it')
})

test('office.js is the build of src/office', async () => {
  assert.equal(await bundleOffice(), committedOffice(), 'office.js is stale: run `npm run build` and commit it')
})

// dsh runs client.js as a classic script that hands a factory to the module loader; the
// factory's `require` answers only the shell's platform modules.
test('client.js registers a factory that exports apply and inject', () => {
  const registrations = []
  runInNewContext(committed(), { window: { __ModuleLoader__: { load: registration => registrations.push(registration) } } })
  assert.equal(registrations.length, 1)
  const [{ id, factory, ...rest }] = registrations
  assert.equal(id, 'ds-bot')
  assert.deepEqual(Object.keys(rest), [])

  const requested = []
  const platform = {
    'react': { Component: class {}, createElement: () => null, Fragment: Symbol('Fragment'), useState: initial => [initial, () => {}], useEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, useRef: current => ({ current }), useId: () => 'id', useSyncExternalStore: (sub, get) => get(), createContext: initial => ({ value: initial, Provider: () => null }), useContext: ctx => ctx.value },
    'react-dom': { createPortal: node => node },
    '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
  }
  const exports = factory((specifier) => {
    requested.push(specifier)
    if (!(specifier in platform)) throw new Error(`no platform module ${specifier}`)
    return platform[specifier]
  })
  assert.deepEqual([...new Set(requested)].sort(), Object.keys(platform).sort())
  assert.equal(Object.prototype.toString.call(exports), '[object Module]')
  assert.deepEqual(Object.keys(exports), ['apply', 'inject'])
  assert.equal(typeof exports.apply, 'function')
  // No `configForms`: the client never writes the user's DSH settings, such as the
  // work-details mode it once held at `verbose`.
  assert.deepEqual(Array.from(exports.inject), ['sessions', 'uiWorkspace', 'uiConversation', 'slots', 'theme', 'layout'])
})

const clientFiles = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name)
  return entry.isDirectory() ? clientFiles(path) : entry.name.endsWith('.js') ? [path] : []
})

test('client code reaches DSH primitives only through the adapter', () => {
  const root = fileURLToPath(new URL('../src/client/', import.meta.url))
  const adapter = join(root, 'dsh-primitives.js')
  const direct = clientFiles(root)
    .filter(path => path !== adapter && readFileSync(path, 'utf8').includes('@deepseek-ai/dsh-client-ui-primitives'))
    .map(path => relative(root, path))
  assert.deepEqual(direct, [], 'client files must import dsh-primitives.js instead')
})

// The rightbar slot is single: the shell's own session panel already holds it, so
// claiming the seat throws at registration and the shell group rolls back whole.
// The board rides the overlay list instead, where it can never collide with a seat.
test('the team board stays out of DSH\'s single right seat', () => {
  const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  assert.equal(source.includes("shadow('rightbar'"), false, 'the rightbar seat belongs to the shell')
  assert.equal(source.includes("shadow('shell.overlay', { id: 'bot-team-board'"), true, 'the board renders in the overlay list')
})

test('the team board starts closed and its close control is clickable in a draggable app', () => {
  const board = readFileSync(new URL('../src/client/team-board.js', import.meta.url), 'utf8')
  const host = readFileSync(new URL('../src/client/team-board-host.js', import.meta.url), 'utf8')
  assert.match(board, /DEFAULT_CONFIG\s*=\s*Object\.freeze\(\{[^}]*defaultOpen: false/)
  assert.match(board, /\.tb-close\{[^}]*app-region:no-drag/)
  assert.match(host, /\.tbh-toggle\{[^}]*app-region:no-drag/)
  assert.match(host, /\.tbh\{[^}]*app-region:no-drag/)
})
