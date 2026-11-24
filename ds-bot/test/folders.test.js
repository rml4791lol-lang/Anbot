import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/folders.js'

test('a Bot project workspace remains below explicit member, Bot, and group folders', () => {
  const team = join('/', 'team')
  const automatic = join(team, '.agents', 'worktrees', 'anbot-builder')
  const explicit = join('/', 'explicit')
  const member = join('/', 'member')
  const group = join('/', 'group')
  const state = {
    workspaceId: 'w1',
    bots: {
      builder: { id: 'builder', workDir: automatic, projectWorkspace: { workingDir: automatic } },
      explicit: { id: 'explicit', workDir: explicit },
      plain: { id: 'plain' },
    },
    rooms: {
      shared: { id: 'shared', workDir: group, members: ['builder'], memberDirs: { builder: member }, sessions: { builder: 'group-builder' } },
    },
  }
  const rt = {
    ctx: { workspaceRegistry: { get: id => id === 'w1' ? { id, path: team } : undefined } },
    state,
    botOf: id => state.bots[id],
    roomOf: id => state.rooms[id],
    selfOf: id => id === 'group-builder' ? 'builder' : id in state.bots ? id : undefined,
    groupOwners: new Map([['group-builder', { roomId: 'shared' }]]),
  }
  install(rt)

  assert.equal(rt.workDirOf({ botId: 'builder' }), automatic)
  assert.equal(rt.workDirOf({ botId: 'explicit' }), explicit)
  assert.equal(rt.workDirOf({ botId: 'plain' }), undefined)
  assert.equal(rt.workDirOf({ botId: 'builder', roomId: 'shared' }), group)

  delete state.rooms.shared.workDir
  assert.equal(rt.workDirOf({ botId: 'builder', roomId: 'shared' }), member)
  delete state.rooms.shared.memberDirs
  assert.equal(rt.workDirOf({ botId: 'builder', roomId: 'shared' }), automatic)
  assert.equal(rt.sessionFolder({ id: 'group-builder', header: {} }), automatic)
  assert.equal(rt.sessionFolder({ id: 'builder', header: { cwd: automatic } }), automatic)
})
