import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readNotes, writeNotes } from '../src/host/resume.js'

// The notes file is the only record that a Bot turn or a delivery was on its way: a
// start that cannot read it, or a write that leaves it half, loses work nobody can
// recover. These tests pin the two properties: it is replaced whole, and a file that
// cannot be read is kept instead of being written over.
const notes = { turns: { b: { botId: 'b', since: 1 } }, queued: {} }

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-inflight-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('notes are replaced whole: a write that fails leaves the file before it', async (t) => {
  const dir = scratch(t)
  const file = join(dir, 'inflight.json')
  writeFileSync(file, JSON.stringify(notes))
  // The place the new notes are written first is taken: this write cannot finish,
  // and the file the last run left stays as it is.
  const temp = `${file}.${process.pid}.tmp`
  mkdirSync(temp)
  await assert.rejects(writeNotes(file, JSON.stringify({ turns: {}, queued: {} })))
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), notes)

  // Once the place is free, the next write replaces the file whole and leaves no part
  // of itself behind.
  rmSync(temp, { recursive: true })
  await writeNotes(file, JSON.stringify({ turns: {}, queued: {} }))
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { turns: {}, queued: {} })
  assert.deepEqual(readdirSync(dir), ['inflight.json'])
})

test('notes that cannot be read are kept aside, and the read is reported', (t) => {
  const dir = scratch(t)
  const file = join(dir, 'inflight.json')
  // A torn file: what a write cut off part way leaves.
  const torn = '{"turns":{"b":{"botId":"b"}},"queued":'
  writeFileSync(file, torn)
  const warned = []
  const warn = (...args) => warned.push(args)
  assert.deepEqual(readNotes(file, warn), { turns: {}, queued: {} })
  // Nothing is written over it: the file is moved aside, whole.
  assert.equal(existsSync(file), false)
  const aside = readdirSync(dir).filter(name => name.startsWith('inflight.json.corrupt-'))
  assert.equal(aside.length, 1)
  const [line] = warned.at(-1)
  assert.match(line, /could not be read/)
  assert.match(line, /kept as/)
  assert.equal(readFileSync(join(dir, aside[0]), 'utf8'), torn)

  // A file that is not a JSON object is kept the same way, next to the first one.
  writeFileSync(file, '[]')
  assert.deepEqual(readNotes(file, warn), { turns: {}, queued: {} })
  assert.equal(readdirSync(dir).filter(name => name.startsWith('inflight.json.corrupt-')).length, 2)
  assert.equal(existsSync(file), false)
})

test('no notes file is a start with nothing to pick up, and is not reported', (t) => {
  const dir = scratch(t)
  const warned = []
  assert.deepEqual(readNotes(join(dir, 'inflight.json'), (...args) => warned.push(args)), { turns: {}, queued: {} })
  assert.deepEqual(warned, [])
})

test('notes that are read keep the shape the last run wrote', (t) => {
  const dir = scratch(t)
  const file = join(dir, 'inflight.json')
  writeFileSync(file, JSON.stringify({ turns: notes.turns, queued: { b: [{ at: 1, args: { toId: 'b' } }] } }))
  assert.deepEqual(readNotes(file, () => assert.fail('must not warn')), {
    turns: notes.turns,
    queued: { b: [{ at: 1, args: { toId: 'b' } }] },
  })
})
