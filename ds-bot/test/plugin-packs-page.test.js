import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/plugin-packs-page.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat(Infinity) } }),
  useEffect() {}, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => name === 'react' ? react : {},
})
const { PluginPacksPage } = module.exports

const Section = ({ title, action, children }) => ({ type: 'section', props: { title, action, children } })
const Row = ({ label, hint, children }) => ({ type: 'row', props: { children: [label, hint, children] } })
const view = {
  available: true,
  lastChange: null,
  lanes: [
    { id: 'team', title: 'Team', description: 'Stable tools', packs: ['forge', 'local', 'memory'] },
    { id: 'code-lab', title: 'Code Lab', description: 'Repository tools', packs: [] },
  ],
  packs: [
    { id: 'forge', title: 'Forge', description: 'Runs and evidence', kind: 'tool', scope: 'profile', status: 'enabled', enabled: true, canToggle: true, canInstall: false, version: '1.2.3', conflicts: [] },
    { id: 'local', title: 'Local only', description: 'A local bundle', kind: 'engine', scope: 'bot', status: 'missing', installed: false, canToggle: false, canInstall: false, installable: false, conflicts: [] },
    { id: 'memory', title: 'Mnemon', description: 'Memory provider', kind: 'memory', scope: 'bot', status: 'disabled', enabled: false, canToggle: false, canInstall: false, authority: 'memory', authorityOwner: 'DS-Bot memory', conflicts: [] },
  ],
}
const flatten = (node, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => flatten(child, out)); return out }
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (typeof node.type === 'function') { flatten(node.type(node.props), out); return out }
  flatten(node.props?.children, out)
  return out
}
const collect = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => collect(child, match, out)); return out }
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (typeof node.type === 'function') { collect(node.type(node.props), match, out); return out }
  if (match(node)) out.push(node)
  collect(node.props?.children, match, out)
  return out
}
const page = (roster = { pluginPacks: view }, actions = {}) => PluginPacksPage({ roster, actions, Section, Row })
const text = node => flatten(node).join(' ')
const button = (tree, label) => collect(tree, node => node.type === 'button' && text(node) === label)

test('the page groups packs by lane and shows status, version, scope and authority ownership', () => {
  const tree = page()
  assert.match(text(tree), /Plugin packs.*Team.*Code Lab.*Forge.*Runs and evidence.*Profile-wide.*Tool.*v1\.2\.3.*Enabled/s)
  assert.match(text(tree), /Mnemon.*Bot.*Memory.*Managed by DS Bot: DS-Bot memory/s)
  assert.match(text(tree), /Local only.*Local package is not installed/s)
  assert.equal(button(tree, 'Disable').length, 1)
  assert.equal(button(tree, 'Install').length, 0)
})

test('a missing registry pack installs through the page and an installed pack toggles', async () => {
  const calls = []
  const registryPack = { ...view.packs[0], id: 'media', title: 'Media', status: 'missing', enabled: false, canToggle: false, canInstall: true, installable: true }
  const next = { ...view, packs: [registryPack], lanes: [{ id: 'team', title: 'Team', description: '', packs: ['media'] }] }
  const actions = {
    installPluginPack: id => { calls.push(['install', id]); return Promise.resolve(next) },
    setPluginPack: (id, enabled) => { calls.push(['set', id, enabled]); return Promise.resolve(next) },
  }
  let tree = page({ pluginPacks: next }, actions)
  button(tree, 'Install')[0].props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(calls, [['install', 'media']])
  const installed = { ...registryPack, status: 'disabled', canInstall: false, canToggle: true, enabled: false }
  tree = page({ pluginPacks: { ...next, packs: [installed] } }, actions)
  button(tree, 'Enable')[0].props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(calls, [['install', 'media'], ['set', 'media', true]])
})

test('an unavailable native manager still shows the catalog and offers the DSH route', () => {
  const opened = []
  const tree = page({ pluginPacks: { ...view, available: false } }, { openSettings: (...args) => opened.push(args) })
  assert.match(text(tree), /Native plugin manager unavailable/)
  button(tree, 'Open Plugins')[0].props.onClick()
  assert.deepEqual(opened, [['dsh', 'plugins']])
})

test('a restart-required native change is visible after the toggle', () => {
  const tree = page({ pluginPacks: { ...view, lastChange: { application: 'restart-required', restartReason: 'no-hmr' } } })
  assert.match(text(tree), /Restart DSH to load the change in this profile.*no-hmr/s)
})
