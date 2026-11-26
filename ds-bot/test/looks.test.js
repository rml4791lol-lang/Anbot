import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { DEFAULT_COLORS, DEFAULT_SHAPES, FALLBACK_SHAPE, MAIN_LOOK, PICKER_SHAPES, defaultColor, defaultShape, lookOf, resolveShape } from '../src/client/characters.js'
import { ANBOT_MARKS } from '../src/client/marks/anbot-assets.js'
import { indexRoster } from '../src/client/sources.js'

const ASSETS = join(import.meta.dirname, '..', 'assets', 'marks')
// Mean per-channel abs diff (64x64 RGBA) below this means the open and closed frames
// are effectively the same image, so the blink would show no change.
const BLINK_DIFF_MIN = 2
// Frames known to be defective in the current source drop: their open frame reads as
// closed-eyed and needs re-rendering. Listed here so the check can still flag any
// *new* regression; do not add slots without a re-issued source frame.
const KNOWN_BLINK_DEFECTS = ['headphone', 'gardener']

const resolveSharp = () => {
  const candidates = [
    join(process.env.DSH_HARNESS ?? '', 'node_modules', 'sharp'),
    join(import.meta.dirname, '..', 'dev', 'harness', 'node_modules', 'sharp'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try { return createRequire(import.meta.url)(candidate) } catch { /* try next */ }
    }
  }
  return undefined
}

const ids = Array.from({ length: 3000 }, (_, index) => `session-${index.toString(16).padStart(8, '0')}-look`)

test('a Bot with no look of its own never gets the whale, gray, brown, or black', () => {
  assert.ok(!DEFAULT_SHAPES.includes('whale'))
  for (const color of ['gray', 'brown', 'black', 'aurora']) assert.ok(!DEFAULT_COLORS.includes(color), color)
  const shapes = new Set(ids.map(defaultShape))
  const colors = new Set(ids.map(defaultColor))
  assert.deepEqual([...shapes].sort(), [...DEFAULT_SHAPES].sort())
  assert.deepEqual([...colors].sort(), [...DEFAULT_COLORS].sort())
})

const roster = (bots, mainBotIds) => indexRoster({ bots, rooms: [], mainBotIds, mainBotId: mainBotIds[0] ?? null })

test('the whale is only a stored look: the browser gives no Bot a look by its place in the team', () => {
  const chief = { id: 'chief', name: 'Chief', createdAt: 1, color: 'deepseek', avatar: { shape: 'whale' } }
  const writer = { id: 'writer', name: 'Writer', createdAt: 2 }
  assert.deepEqual(lookOf(roster([writer, chief], ['chief']).byId.chief), { ...MAIN_LOOK, image: undefined })
  // The first Main Bot left, with no stored look, keeps the look its id gives it.
  const left = roster([writer], ['writer']).byId.writer
  assert.deepEqual(lookOf(left), { shape: defaultShape('writer'), color: defaultColor('writer'), image: undefined })
  const photo = lookOf({ id: 'chief', avatar: { image: 'data:image/png;base64,AA==' } })
  assert.equal(photo.image, 'data:image/png;base64,AA==')
  assert.equal(photo.shape, defaultShape('chief'))
})

test('the picker lists the fifteen Anbot presets, anbot first, with no vendor slots', () => {
  assert.deepEqual(PICKER_SHAPES, [
    'anbot', 'headphone', 'glasses', 'scarf', 'nightcap',
    'overalls', 'chef', 'wizard', 'astro', 'detective',
    'painter', 'gardener', 'barista', 'skater', 'raincoat',
  ])
  assert.equal(Object.keys(ANBOT_MARKS).length, 15)
  assert.deepEqual(Object.keys(ANBOT_MARKS), PICKER_SHAPES)
  for (const slot of Object.values(ANBOT_MARKS)) {
    assert.ok(slot.open && slot.closed, 'every slot bundles open and closed frames')
    assert.notEqual(slot.open, slot.closed, 'open and closed frames must differ')
  }
  for (const retired of ['gpt', 'qwen', 'kimi', 'claude', 'gemini', 'glm', 'anbot-girl', 'ds-headphone']) {
    assert.ok(!PICKER_SHAPES.includes(retired), retired)
    assert.ok(!Object.hasOwn(ANBOT_MARKS, retired), retired)
  }
})

test('default and fallback look resolve to the anbot preset', () => {
  assert.equal(FALLBACK_SHAPE, 'anbot')
  assert.equal(MAIN_LOOK.shape, 'anbot')
  assert.equal(resolveShape(undefined), 'anbot')
  assert.equal(resolveShape(null), 'anbot')
})

test('retired v1, vendor, and vector shapes remap to one of the current presets', () => {
  const legacy = [
    'anbot-girl', 'ds-headphone', 'ds-glasses', 'ds-scarf', 'ds-nightcap',
    'ds-overalls', 'ds-chef', 'ds-wizard', 'ds-astro', 'ds-detective',
    'ds-painter', 'ds-gardener', 'ds-barista', 'ds-skater', 'ds-raincoat',
    'anbot', 'gpt', 'qwen', 'kimi', 'claude', 'gemini', 'glm', 'whale',
    'star', 'moon', 'wave', 'squircle', 'zed', 'hex',
  ]
  for (const item of legacy) {
    const resolved = resolveShape(item, 'writer')
    assert.ok(PICKER_SHAPES.includes(resolved), `${item} -> ${resolved}`)
  }
  assert.equal(resolveShape('anbot-girl'), 'anbot')
  assert.equal(resolveShape('ds-headphone'), 'headphone')
  assert.equal(resolveShape('anbot'), 'anbot')
})

test('open and closed blink frames are not the same image', async t => {
  const sharp = resolveSharp()
  if (sharp === undefined) {
    t.skip('sharp unavailable; install dev/harness to run the blink pixel check')
    return
  }
  const suspicious = []
  for (const id of PICKER_SHAPES) {
    const open = await sharp(join(ASSETS, `${id}-160.webp`)).resize(64, 64).raw().toBuffer({ resolveWithObject: true })
    const closed = await sharp(join(ASSETS, `${id}-closed-160.webp`)).resize(64, 64).raw().toBuffer({ resolveWithObject: true })
    let diff = 0
    for (let i = 0; i < open.data.length; i += 1) diff += Math.abs(open.data[i] - closed.data[i])
    const mean = diff / open.data.length
    if (mean < BLINK_DIFF_MIN) suspicious.push(`${id} (${mean.toFixed(2)})`)
  }
  const unknown = suspicious.filter(entry => !KNOWN_BLINK_DEFECTS.includes(entry.split(' ')[0]))
  assert.deepEqual(unknown, [], `suspicious blink frames: ${suspicious.join(', ')}`)
})

test('Bot settings is the only settings entry; nothing is called Team settings', () => {
  const dir = new URL('../src/client/', import.meta.url)
  const sources = readdirSync(dir).filter(name => name.endsWith('.js')).map(name => [name, readFileSync(new URL(name, dir), 'utf8')])
  for (const [name, text] of [...sources, ['client.js', readFileSync(new URL('../client.js', import.meta.url), 'utf8')]]) {
    assert.ok(!text.includes('Team settings'), `${name} still names Team settings`)
  }
  const text = name => sources.find(([file]) => file === name)[1]
  assert.match(text('sidebar.js'), /\[t\('Settings'\), GearIcon, \(\) => actions\.openSettings\('overview'\)\]/)
  assert.match(text('palette.js'), /title: t\('Settings'\), run: \(\) => actions\.openSettings\('overview'\)/)
  // One Bot's own entries open that Bot, so they read Edit Bot instead.
  assert.match(text('context-menu.js'), /\[t\('Edit Bot'\), GearIcon, \(\) => actions\.openSettings\('bots', bot\.id\)\]/)
  assert.match(text('details-drawer.js'), /'aria-label': bot \? t\('Edit Bot'\) : t\('Group settings'\), title: bot \? t\('Edit Bot'\) : t\('Group settings'\)/)
  // A group chat's entries open its own settings the same way.
  assert.match(text('context-menu.js'), /\[t\('Group settings'\), GearIcon, \(\) => actions\.openSettings\('groups', room\.id\)\]/)
  assert.ok(!text('mark.js').includes('WhaleLogo'))
})
