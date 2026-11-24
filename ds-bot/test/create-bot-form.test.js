import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createPayload } from '../src/client/bot-draft.js'
import { engineeringPresets } from '../src/shared/engineering-presets.js'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// The Create Bot form, bundled once and rendered with the minimal React stand-in of
// connectors-page.test.js: hooks are numbered by expansion order, effects never run.
const { outputFiles } = await build({
  stdin: { contents: "export { CreateBot } from './src/client/create-bot.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const slots = []
let idx = 0
let concrete = null
let props = {}
const expand = (node) => {
  if (node === null || node === undefined || node === false || node === true) return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
}
const rerender = () => { idx = 0; concrete = expand(module.exports.CreateBot(props)) }
const react = {
  createElement: (type, p, ...children) => ({ type, props: { ...p, children } }),
  Fragment: 'fragment',
  useCallback: fn => fn,
  useEffect() {}, useLayoutEffect() {},
  useState: (init) => {
    const i = idx++
    if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
    return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; rerender() }]
  },
  useRef: (current) => {
    const i = idx++
    if (!(i in slots)) slots[i] = { current }
    return slots[i]
  },
}
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: dom.window.document,
  window: { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})

const flatten = (node, out = []) => {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { node.forEach(n => flatten(n, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  flatten(node.props?.children, out)
  return out
}
const collect = (match) => {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || node === false || node === true) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object') return
    if (match(node)) out.push(node)
    walk(node.props?.children)
  }
  walk(concrete)
  return out
}
const button = text => collect(n => n.type === 'button' && flatten(n).join('') === text)[0]
const buttonByLabel = label => collect(n => n.type === 'button' && n.props['aria-label'] === label)[0]
const render = (roster) => {
  slots.length = 0
  props = { roster: { bots: [], rooms: [], prefs: {}, ...roster }, actions: {}, onBack() {}, onCreated() {} }
  rerender()
}

const MODELS = [
  { ref: 'ds/flash', provider: 'ds', id: 'flash', name: 'Flash', providerName: 'DS' },
  { ref: 'local-codex-cli/default', provider: 'local-codex-cli', id: 'default', name: 'CLI default', providerName: 'Codex CLI' },
]

test('the form opens on Anbot models and can create at once', () => {
  render({ models: MODELS })
  assert.equal(button('Anbot model').props['aria-pressed'], true)
  assert.equal(button('Local agent').props['aria-pressed'], false)
  assert.equal(button('Create').props.disabled, false)
})

test('a name another Bot has blocks Create on both sides', () => {
  render({ models: MODELS, bots: [{ id: 'a', name: 'Ada' }] })
  collect(n => n.type === 'input' && n.props['aria-label'] === 'Name')[0].props.onChange({ target: { value: 'Ada' } })
  assert.match(flatten(concrete).join(' '), /A Bot named Ada already exists/)
  assert.equal(button('Create').props.disabled, true)
  button('Local agent').props.onClick()
  assert.equal(button('Create').props.disabled, true)
})

test('on Local agent, Create waits for a CLI', () => {
  render({ models: MODELS })
  button('Local agent').props.onClick()
  assert.equal(button('Local agent').props['aria-pressed'], true)
  assert.match(flatten(concrete).join(' '), /Looking for agent CLIs/)
  assert.equal(button('Create').props.disabled, true)
  button('Anbot model').props.onClick()
  assert.equal(button('Create').props.disabled, false)
})

test('creation sends editable instructions and only the explicitly selected profile skills', async () => {
  render({ models: MODELS, skillCatalog: [
    { name: 'review', description: 'Review source changes' },
    { name: 'private-skill', description: 'Private', bots: ['existing'] },
  ] })
  let payload
  props.actions.createBot = async value => { payload = value; return { id: 'new' } }
  const input = collect(node => node.type === 'textarea' && node.props['aria-label'] === 'Methods')[0]
  assert.ok(input)
  input.props.onChange({ target: { value: 'Verify changes against their tests.' } })
  const selected = collect(node => node.type === 'input' && node.props.value === 'review')[0]
  assert.ok(selected)
  assert.equal(collect(node => node.type === 'input' && node.props.value === 'private-skill').length, 0)
  selected.props.onChange({ target: { checked: true } })
  button('Create').props.onClick()
  await Promise.resolve()
  assert.equal(payload?.instructions, 'Verify changes against their tests.')
  assert.equal(JSON.stringify(payload?.skills), JSON.stringify([{ name: 'review', purpose: 'Review source changes' }]))
})

test('a native preset recommendation fills editable fields and preserves an existing skill', async () => {
  render({ models: MODELS, skillCatalog: [
    { name: 'anbot-debugging', description: 'Reproduce a defect' },
    { name: 'test-suite', description: 'Run focused tests' },
  ] })
  let payload
  props.actions.createBot = async value => { payload = value; return { id: 'new' } }
  const field = () => collect(node => node.type === 'textarea' && node.props['aria-label'] === 'Methods')[0]
  field().props.onChange({ target: { value: 'Keep my constraints.' } })
  collect(node => node.type === 'input' && node.props.value === 'test-suite')[0].props.onChange({ target: { checked: true } })
  buttonByLabel('Development and debugging').props.onClick()
  buttonByLabel('Development and debugging').props.onClick()
  assert.match(field().props.value, /^Keep my constraints\.\n\nHandle software defects/u)
  assert.equal(collect(node => node.type === 'input' && node.props['aria-label'] === 'Role')[0].props.value, 'Software developer')
  field().props.onChange({ target: { value: 'Use my edited methods.' } })
  collect(node => node.type === 'textarea' && node.props['aria-label'] === 'Acceptance')[0].props.onChange({ target: { value: 'Focused checks pass.' } })
  collect(node => node.type === 'textarea' && node.props['aria-label'] === 'Output')[0].props.onChange({ target: { value: 'Report changed files and results.' } })
  button('Create').props.onClick()
  await Promise.resolve()
  assert.equal(payload?.instructions, 'Use my edited methods.\n\nAcceptance criteria\nFocused checks pass.\n\nExpected output\nReport changed files and results.')
  assert.equal(payload?.skills.map(skill => skill.name).join(','), 'test-suite,anbot-debugging')
  assert.equal(payload?.role, 'Software developer')
})

test('recommendations stay visible and mark Skills that the live catalog does not serve', () => {
  const ui = { name: 'anbot-ui-review', description: 'Review a running interface' }
  const coordination = { name: 'anbot-coordination', description: 'Hand off work to team Bots' }
  render({ models: MODELS, skillCatalog: [ui] })
  for (const item of engineeringPresets) assert.ok(buttonByLabel(item.label), item.id)
  assert.doesNotMatch(flatten(buttonByLabel('UI and product')).join(' '), /Unavailable/u)
  assert.match(flatten(buttonByLabel('Project coordination')).join(' '), /Unavailable anbot-coordination/u)
  render({ models: MODELS, skillCatalog: [coordination] })
  assert.doesNotMatch(flatten(buttonByLabel('Project coordination')).join(' '), /Unavailable/u)
  assert.match(flatten(buttonByLabel('UI and product')).join(' '), /Unavailable anbot-ui-review/u)
})

test('a partially available recommendation separates applied, advisory and unavailable guidance', () => {
  render({ models: MODELS, skillCatalog: [{ name: 'anbot-debugging', description: 'Reproduce a defect' }] })
  buttonByLabel('Self-maintenance').props.onClick()
  assert.equal(collect(node => node.type === 'input' && node.props['aria-label'] === 'Role')[0].props.value, 'Anbot maintainer')
  assert.equal(JSON.stringify(collect(node => node.type === 'input' && node.props.checked).map(node => node.props.value)), JSON.stringify(['anbot-debugging']))
  const status = collect(node => node.props?.['aria-label'] === 'Recommendation status')[0]
  assert.ok(status)
  const text = flatten(status).join(' ')
  assert.match(text, /Applied/u)
  assert.match(text, /Advisory/u)
  assert.match(text, /Plugin\s+·\s+Use the repository checks/u)
  assert.match(text, /Permission\s+·\s+Workspace write limited to owned files/u)
  assert.match(text, /Unavailable\s+·\s+Recommended Skills that this profile does not serve: anbot-code-review/u)
})

test('the create payload keeps combined briefs and an explicitly selected working folder', () => {
  const payload = createPayload({
    name: 'Maintainer', look: { shape: 'star', color: 'blue' }, model: 'ds/flash',
    role: 'Anbot maintainer', methods: 'Inspect the owning source.', acceptance: 'Focused tests pass.', output: 'Report evidence.', workDir: '/tmp/owned-checkout',
  })
  assert.equal(payload.role, 'Anbot maintainer')
  assert.equal(payload.workDir, '/tmp/owned-checkout')
  assert.equal(payload.instructions, 'Inspect the owning source.\n\nAcceptance criteria\nFocused tests pass.\n\nExpected output\nReport evidence.')
})
