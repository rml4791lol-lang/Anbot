import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultPresetBase, presetBaseName, presetBases, presetLoadState } from '../src/client/agent-preset-bases.js'

const presets = [
  { id: 'standard', name: 'Standard', isDefault: false },
  { id: 'ptc', name: 'PTC', isDefault: true },
  { id: 'broken', name: 'Broken', broken: 'failed' },
  { id: 'dsbot-bot-copy', name: 'Another Bot' },
  { id: 'dsbot-group-relay', name: 'Relay' },
  { id: 'custom', description: 'A preset made in Creator mode' },
]

test('the Bot picker offers healthy native DSH presets only', () => {
  assert.deepEqual(presetBases(presets).map(preset => preset.id), ['standard', 'ptc', 'custom'])
  assert.deepEqual(presetBases(undefined), [])
  assert.deepEqual(presetBases([null, {}, { id: '', name: 'Empty' }]), [])
})

test('the Bot picker starts on the preset DSH marks as default', () => {
  assert.equal(defaultPresetBase(presets), 'ptc')
  assert.equal(defaultPresetBase([{ id: 'custom', name: 'Custom' }]), 'custom')
  assert.equal(defaultPresetBase([]), '')
})

test('a preset without a published name falls back to its id', () => {
  assert.equal(presetBaseName(presets.at(-1)), 'custom')
  assert.equal(presetBaseName({ id: 'ptc', name: 'PTC' }), 'PTC')
})

test('a deployment without preset service stays available, while an empty native roster blocks', () => {
  assert.deepEqual(presetLoadState({ available: false, presets: [] }), { status: 'unavailable', presets: [] })
  assert.deepEqual(presetLoadState(undefined), { status: 'unavailable', presets: [] })
  assert.deepEqual(presetLoadState({ available: true, presets: [] }), { status: 'ready', presets: [] })
  assert.deepEqual(presetLoadState({ available: true, presets }).presets.map(preset => preset.id), ['standard', 'ptc', 'custom'])
})
