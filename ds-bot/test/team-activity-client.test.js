import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'fragment',
  useState: initial => [initial, () => {}],
  useEffect: () => {},
  useMemo: make => make(),
  useRef: initial => ({ current: initial }),
  useLayoutEffect: () => {},
  useCallback: fn => fn,
  useContext: value => value,
  useId: () => 'test-id',
}
const require = (name) => {
  const platform = {
    react,
    'react-dom': { createPortal: node => node },
    './api.js': { call: async () => ({ schema: 1, mode: 'live', tasks: [], activity: [], heatmap: [] }) },
    './mark.js': { BotAvatar: () => null },
    './motion.js': { reducedMotion: () => true, SPRING_SHAPE: { duration: 420, easing: 'linear(0, 1)' } },
    './i18n.js': { t: key => key, hostText: key => `host:${key}` },
    './overlay-hooks.js': { useEscape: () => {} },
  }
  if (!(name in platform)) throw new Error(`no platform module ${name}`)
  return platform[name]
}
const bundled = async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/team-activity.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom'],
  })
  const module = { exports: {} }
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require, setTimeout, clearTimeout, URL, URLSearchParams })
  return module.exports
}
const mod = await bundled()

const text = node => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node !== 'object') return String(node)
  if (typeof node.type === 'function') return text(node.type(node.props))
  return (node.children ?? []).map(text).join('')
}
const all = (node, cls, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (typeof node.type === 'function') return all(node.type(node.props), cls, out)
  if ((node.props?.className ?? '').split(' ').includes(cls)) out.push(node)
  for (const child of node.children ?? []) all(child, cls, out)
  return out
}
const data = {
  schema: 1, mode: 'live', generatedAt: 1,
  roles: [{ id: 'chief', name: 'Chief', role: 'Coordinator', color: 'deepseek', avatar: { shape: 'whale' }, main: true, permission: 'Main Bot' }, { id: 'forge', name: 'Forge', role: 'Engineer', color: 'orange', avatar: { shape: 'fox' }, main: false, permission: 'Member' }],
  tasks: [
    { id: 'goal:g1:s1:t1', sourceId: 'goal:g1:s1:t1', source: 'goal', kind: 'goal_task', title: 'Ship MCP', subtitle: 'Ship', stageTitle: 'Bridge', parentId: 'goal:g1', ownerId: 'forge', ownerName: 'Forge', ownerRole: 'Engineer', ownerMain: false, ownerKind: 'bot', roomName: 'Delivery', sourceStatus: 'working', displayState: 'working', statusSource: 'goal.task', acceptance: 'tests pass', updatedAt: 10 },
    { id: 'handoff:w1', sourceId: 'handoff:w1', source: 'handoff', kind: 'handoff', title: 'Chief to Forge', parentId: null, ownerId: 'forge', ownerName: 'Forge', ownerRole: 'Engineer', ownerMain: false, ownerKind: 'bot', roomName: 'Delivery', sourceStatus: 'waiting', displayState: 'waiting', statusSource: 'work.open', updatedAt: 20 },
    { id: 'handoff:w2', sourceId: 'handoff:w2', source: 'handoff', kind: 'handoff', title: 'Review bridge', parentId: 'handoff:w1', ownerId: 'chief', ownerName: 'Chief', ownerRole: 'Coordinator', ownerMain: true, ownerKind: 'bot', roomName: 'Delivery', sourceStatus: 'active', displayState: 'working', statusSource: 'work.open', updatedAt: 30 },
  ],
  activity: [
    { id: 'a1', source: 'board', kind: 'delivery', text: 'Delivered the bridge', botName: 'Forge', at: 10 },
  ],
  heatmap: ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'].map(day => ({ day, count: day === '2026-11-16' ? 1 : 0 })),
  summary: { active: 1, waiting: 1, attention: 0, reported: 0, verified: 0, activity: 1 },
  filters: { sources: ['goal', 'handoff'], statuses: ['working', 'waiting', 'active'], roles: ['chief', 'forge'], attentionStatuses: ['waiting', 'pending', 'paused', 'reported', 'blocked', 'failed', 'unknown'] },
}
const roster = { byId: { chief: { id: 'chief', name: 'Chief', role: 'Coordinator' }, forge: { id: 'forge', name: 'Forge', role: 'Engineer' } }, bots: [data.roles[0], data.roles[1]], roomsById: { r1: { id: 'r1', name: 'Delivery' } }, mainBotId: 'chief' }

test('TeamActivityView renders real task rows, heatmap, and selected source detail', () => {
  const view = mod.TeamActivityView({ data, roster, status: 'ready', selectedId: 'handoff:w1', filters: { role: 'all', source: 'all', status: 'all', attention: false }, onSelect: () => {}, onFilter: () => {}, onClose: () => {} })
  assert.ok(view.props.className.split(' ').includes('bt-team-activity'))
  assert.equal(all(view, 'bt-activity-heat-cell').length, 7)
  assert.equal(all(view, 'bt-activity-task').length, 3)
  assert.match(text(view), /Team roster/)
  assert.match(text(view), /Coordinator/)
  assert.match(text(view), /Main Bot/)
  assert.match(text(view), /Engineer/)
  assert.match(text(view), /Member/)
  assert.match(text(view), /Review bridge/)
  assert.match(text(view), /Source ID/)
  assert.match(text(view), /handoff:w1/)
  assert.match(text(view), /Seven-day activity/)
  assert.match(text(view), /Activity records, not task completion/)
  assert.match(text(view), /Live data/)
  assert.match(text(view), /Team board · delivery · Delivered the bridge/)
})

test('TeamActivityView makes empty, filtered, partial, stale, demo, and error states explicit', () => {
  const common = { roster, onSelect: () => {}, onFilter: () => {}, onClose: () => {} }
  const empty = mod.TeamActivityView({ data: { ...data, tasks: [], activity: [], summary: { active: 0, waiting: 0, attention: 0, reported: 0, verified: 0, activity: 0 } }, status: 'ready', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(empty), /No team activity yet/)
  const activityOnly = mod.TeamActivityView({ data: { ...data, tasks: [] }, status: 'ready', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(activityOnly), /No current tasks/)
  const loading = mod.TeamActivityView({ data: null, status: 'loading', selectedId: null, filters: {}, ...common })
  assert.equal(all(loading, 'bt-activity-skeleton').length, 1)
  const filtered = mod.TeamActivityView({ data, status: 'ready', selectedId: null, filters: { role: 'ghost', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(filtered), /No tasks match these filters/)
  const partialData = { ...data, tasks: data.tasks.map((task, index) => index === 0 ? { ...task, warnings: ['missing owner ghost'] } : task) }
  const partial = mod.TeamActivityView({ data: partialData, status: 'ready', selectedId: 'goal:g1:s1:t1', filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(partial), /Partial data/)
  assert.match(text(partial), /missing owner ghost/)
  const stale = mod.TeamActivityView({ data, status: 'ready', error: 'network down', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(stale), /Could not refresh. Showing the last good result/)
  assert.match(text(stale), /network down/)
  const demo = mod.TeamActivityView({ data: { ...data, mode: 'demo' }, status: 'ready', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(demo), /Demo data/)
  const locked = mod.TeamActivityView({ data, status: 'ready', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common, roster: { ...roster, readOnly: 'Another host owns this team' } })
  assert.match(text(locked), /Read-only host/)
  assert.match(text(locked), /Another host owns this team/)
  const error = mod.TeamActivityView({ data: null, status: 'error', error: 'Team activity could not be read', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(error), /Team activity could not be read/)
  assert.equal(error.props.role, 'dialog')
  assert.equal(all(error, 'bt-activity-skeleton').length, 0)
})

test('filterActivityModel keeps only matching source, role, status, and attention tasks', () => {
  const filtered = mod.filterActivityModel(data, { role: 'forge', source: 'goal', status: 'working', attention: false })
  assert.deepEqual(filtered.tasks.map(task => task.id), ['goal:g1:s1:t1'])
  const waiting = mod.filterActivityModel(data, { role: 'all', source: 'handoff', status: 'all', attention: true })
  assert.deepEqual(waiting.tasks.map(task => task.id), ['handoff:w1'])
  const pending = { ...data, tasks: [{ ...data.tasks[0], id: 'goal:pending', sourceStatus: 'pending', displayState: 'idle' }] }
  assert.deepEqual(mod.filterActivityModel(pending, { role: 'all', source: 'all', status: 'all', attention: true }).tasks.map(task => task.id), ['goal:pending'])
})

test('TeamActivity forwards the closing state to the rendered dialog', () => {
  const shell = mod.TeamActivity({ roster, onClose: () => {}, leaving: true, callImpl: async () => data })
  assert.equal(shell.props.className, 'bt-activity-layer')
  assert.equal(shell.props['data-leaving'], true)
  assert.equal(shell.children[0].props.className, 'bt-scrim')
  assert.equal(shell.children[1].type.name, 'TeamActivityView')
})

test('the team activity sheet owns a unique root class', () => {
  assert.match(mod.TEAM_ACTIVITY_CSS, /\.bt-team-activity\{/)
  assert.doesNotMatch(mod.TEAM_ACTIVITY_CSS, /\.bt-activity\{/)
})

test('the team activity surface uses the shared dialog and accessibility primitives', () => {
  const view = mod.TeamActivityView({ data, roster, status: 'ready', selectedId: 'handoff:w1', filters: { role: 'all', source: 'all', status: 'all', attention: false }, onSelect: () => {}, onFilter: () => {}, onClose: () => {} })
  assert.deepEqual(all(view, 'bt-select').map(node => node.props.className), ['bt-select', 'bt-select', 'bt-select'])
  assert.equal(all(view, 'bt-soft-sm').length >= 2, true)
  assert.match(mod.TEAM_ACTIVITY_CSS, /@media\(prefers-reduced-motion:reduce\)/)
  assert.match(mod.TEAM_ACTIVITY_CSS, /focus-visible\{outline:2px solid var\(--bt-accent\)/)
  assert.doesNotMatch(mod.TEAM_ACTIVITY_CSS, /font-size:(?:19|18|9)px/)
})

test('unknown and group owners do not invent member permissions', () => {
  const common = { roster, status: 'ready', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, onSelect: () => {}, onFilter: () => {}, onClose: () => {} }
  const missingTask = { ...data.tasks[0], id: 'goal:missing', ownerId: 'ghost', ownerName: '', ownerKind: 'unknown', ownerRole: '', warnings: ['missing owner ghost'] }
  const missing = mod.TeamActivityView({ data: { ...data, tasks: [missingTask], activity: [], summary: { ...data.summary, active: 0, waiting: 0, attention: 0, activity: 0 } }, ...common })
  assert.match(text(missing), /No owner/)
  assert.doesNotMatch(text(missing), /Member · Member/)
  const groupTask = { ...data.tasks[1], id: 'handoff:group', title: 'Prepare release', ownerId: null, ownerName: 'Delivery', ownerKind: 'group', ownerRole: '' }
  const group = mod.TeamActivityView({ data: { ...data, tasks: [groupTask], activity: [], summary: { ...data.summary, active: 0, waiting: 0, attention: 0, activity: 0 } }, ...common })
  assert.match(text(group), /Group chat/)
  assert.doesNotMatch(text(group), /Member · Member/)
})
