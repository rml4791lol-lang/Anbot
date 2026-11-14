import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { TEAM_TOOLS } from '../src/host/constants.js'

// The operations doc lists every tool a Bot can be given. A tool added to
// TEAM_TOOLS without a row there, or a row for a tool that no longer exists, is
// a silent drift: the Bot reads a catalog it cannot use, or misses one it has.
const doc = readFileSync(new URL('../../docs/design/bot-operations.md', import.meta.url), 'utf8')

const listed = new Set()
const section = doc.slice(doc.indexOf('## 2.'), doc.indexOf('## 3.'))
for (const line of section.split('\n')) {
  const match = /^\| `([a-z_]+)` \|/.exec(line)
  if (match) listed.add(match[1])
}

test('every team tool has a row in the operations doc', () => {
  const missing = TEAM_TOOLS.filter(name => !listed.has(name))
  assert.deepEqual(missing, [], `tools without a row: ${missing.join(', ')}`)
})

test('the operations doc lists no tool the plugin does not define', () => {
  const extra = [...listed].filter(name => !TEAM_TOOLS.includes(name))
  assert.deepEqual(extra, [], `rows for unknown tools: ${extra.join(', ')}`)
})
