import assert from 'node:assert/strict'
import { test } from 'node:test'

import { activityDays, buildTeamActivity } from '../src/host/team-activity.js'

const NOW = Date.parse('2026-11-16T12:00:00+08:00')
const day = (offset, hour = 12) => Date.parse(`2026-11-${String(16 + offset).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+08:00`)

test('buildTeamActivity projects goal tasks and open handoffs as real source rows', () => {
  const state = {
    mainBotIds: ['chief'],
    bots: {
      chief: { id: 'chief', name: 'Chief', role: 'Coordinator', color: 'deepseek', avatar: { shape: 'whale' }, sectionId: 'core' },
      forge: { id: 'forge', name: 'Forge', role: 'Engineer', sectionId: 'engineering' },
    },
    rooms: {
      r1: {
        id: 'r1',
        name: 'Delivery',
        admin: 'chief',
        members: ['chief', 'forge'],
        goal: {
          id: 'g1',
          revision: 4,
          status: 'active',
          title: 'Ship MCP',
          updatedAt: NOW - 1_000,
          stages: [{
            id: 's1',
            title: 'Build the bridge',
            acceptance: 'tests pass',
            status: 'active',
            tasks: [{ id: 't1', botId: 'forge', task: 'Implement the bridge', status: 'working' }],
          }],
        },
      },
    },
    works: {
      w1: { from: 'chief', to: 'forge', at: NOW - 2_000, open: [], results: [] },
      w2: { from: 'chief', room: 'r1', at: NOW - 3_000, open: [], results: [] },
    },
  }

  const value = buildTeamActivity({ state, board: [], ledger: [], now: NOW, timeZone: 'Asia/Shanghai' })
  assert.equal(value.schema, 1)
  assert.deepEqual(value.roles.map(role => [role.id, role.main, role.permission]), [['chief', true, 'Main Bot'], ['forge', false, 'Member']])
  assert.deepEqual(value.roles[0].avatar, { shape: 'whale' })
  assert.equal(value.roles[0].color, 'deepseek')
  assert.deepEqual(value.filters.attentionStatuses, ['waiting', 'pending', 'paused', 'reported', 'blocked', 'failed', 'unknown'])
  assert.deepEqual(value.tasks.map(task => [task.source, task.sourceId, task.sourceStatus]).sort(), [
    ['goal', 'goal:g1:s1:t1', 'working'],
    ['handoff', 'handoff:w1', 'active'],
    ['handoff', 'handoff:w2', 'active'],
  ])
  const goal = value.tasks.find(task => task.source === 'goal')
  assert.equal(goal.ownerId, 'forge')
  assert.equal(goal.ownerName, 'Forge')
  assert.equal(goal.roomName, 'Delivery')
  assert.equal(goal.stageTitle, 'Build the bridge')
  assert.equal(goal.acceptance, 'tests pass')
  const work = value.tasks.find(task => task.id === 'handoff:w1')
  assert.equal(work.ownerId, 'forge')
  assert.equal(work.ownerMain, false)
  assert.equal(work.parentId, null)
  assert.equal(work.statusSource, 'work.open')
  assert.equal(work.displayState, 'working')
  assert.match(work.title, /Forge/)
  const groupWork = value.tasks.find(task => task.id === 'handoff:w2')
  assert.equal(groupWork.ownerId, null)
  assert.equal(groupWork.ownerName, 'Delivery')
  assert.equal(groupWork.ownerKind, 'group')
  assert.equal(groupWork.roomName, 'Delivery')
})

test('buildTeamActivity creates deterministic seven-day buckets from real activity times', () => {
  const state = {
    mainBotIds: [],
    bots: { ops: { id: 'ops', name: 'Ops', role: 'Operator' } },
    rooms: {},
    works: {},
  }
  const board = [
    { bot: 'Ops', kind: 'delivery', what: 'today', at: '2026-11-16T09:00:00+08:00' },
    { bot: 'Ops', kind: 'decision', what: 'yesterday', at: '2026-11-15T09:00:00+08:00' },
    { bot: 'Ops', kind: 'blocked', what: 'too old', at: '2026-11-08T09:00:00+08:00' },
  ]
  const ledger = [
    { id: 'w1', kind: 'open', time: day(-2), from: 'ops', to: 'ops' },
    { id: 'w1', kind: 'close', time: day(-2, 13), outcome: 'answered' },
  ]

  const value = buildTeamActivity({ state, board, ledger, now: NOW, timeZone: 'Asia/Shanghai' })
  assert.equal(value.heatmap.length, 7)
  assert.deepEqual(value.heatmap.map(item => item.day), [
    '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16',
  ])
  assert.equal(value.heatmap.find(item => item.day === '2026-11-16').count, 1)
  assert.equal(value.heatmap.find(item => item.day === '2026-11-15').count, 1)
  assert.equal(value.heatmap.find(item => item.day === '2026-11-14').count, 2)
  assert.equal(value.heatmap.find(item => item.day === '2026-11-10').count, 0)
  assert.equal(value.activity[0].text, 'today')
  assert.equal(value.activity[0].source, 'board')
  assert.ok(value.activity.some(item => item.source === 'ledger' && item.text.includes('w1')))
  assert.ok(!value.activity.some(item => item.text === 'too old'))
})

test('buildTeamActivity keeps partial legacy data visible without inventing completion', () => {
  const state = {
    bots: { forge: { name: 'Forge', role: 'Engineer' } },
    rooms: { r1: { id: 'r1', name: 'Delivery', goal: { id: 'g1', stages: [{ id: 's1', title: 'Build', tasks: [{ id: 't1', botId: 'ghost', task: 'Recover', status: 'blocked' }] }] } } },
    works: { orphan: { from: 'missing', at: NOW - 500, open: ['child'], results: [] } },
  }
  const value = buildTeamActivity({ state, board: [], ledger: [], now: NOW, timeZone: 'Asia/Shanghai' })
  assert.equal(value.tasks.length, 2)
  const handoff = value.tasks.find(task => task.source === 'handoff')
  const goal = value.tasks.find(task => task.source === 'goal')
  assert.equal(handoff.sourceStatus, 'waiting')
  assert.equal(handoff.ownerId, null)
  assert.equal(handoff.ownerName, '')
  assert.equal(handoff.ownerKind, 'unknown')
  assert.equal(handoff.title, 'missing')
  assert.equal(goal.ownerName, '')
  assert.equal(goal.ownerKind, 'unknown')
  assert.equal(value.partial, true)
  assert.deepEqual(value.warnings.map(item => item.taskId), ['handoff:orphan', 'goal:g1:s1:t1'])
  assert.equal(value.summary.reported, 0)
  assert.equal(value.summary.verified, 0)
})

test('buildTeamActivity carries source-read warnings into the partial state', () => {
  const value = buildTeamActivity({
    state: { bots: {}, rooms: {}, works: {} },
    sourceWarnings: ['team board archive: skipped 1 bad row in ops.jsonl'],
    now: NOW,
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(value.partial, true)
  assert.deepEqual(value.warnings, [{ taskId: null, message: 'team board archive: skipped 1 bad row in ops.jsonl' }])
})

test('activityDays keeps seven unique calendar days across DST', () => {
  const spring = activityDays(Date.parse('2026-03-10T04:30:00Z'), 'America/New_York')
  assert.deepEqual(spring, ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'])
  const fall = activityDays(Date.parse('2026-11-02T12:00:00Z'), 'America/New_York')
  assert.deepEqual(fall, ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
})

test('buildTeamActivity marks board rows without a real time as partial', () => {
  const value = buildTeamActivity({
    state: { bots: {}, rooms: {}, works: {} },
    board: [{ bot: 'Ops', kind: 'delivery', what: 'unknown time' }],
    now: NOW,
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(value.partial, true)
  assert.match(value.warnings[0].message, /without a valid time/)
})
