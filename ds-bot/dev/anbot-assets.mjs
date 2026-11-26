// Builds the Anbot built-in bitmap marks into a client module.
//
//   node dev/anbot-assets.mjs        writes src/client/marks/anbot-assets.js
//
// The source frames live in assets/marks/ (160px webp, open + closed). The 512px
// frames are not bundled in this phase; no static asset route is served to the
// browser yet. The generated module is committed, like characters.js.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const ASSETS = join(PLUGIN, 'assets', 'marks')
const OUT = join(PLUGIN, 'src', 'client', 'marks', 'anbot-assets.js')

// Picker order matches PICKER_SHAPES in characters.js; anbot is the main mark only.
const SLOTS = [
  ['gpt', 'Gpt'],
  ['qwen', 'Qwen'],
  ['kimi', 'Kimi'],
  ['claude', 'Claude'],
  ['gemini', 'Gemini'],
  ['glm', 'Glm'],
  ['anbot', 'Anbot'],
]

const dataUrl = file => {
  const bytes = readFileSync(join(ASSETS, file))
  return `data:image/webp;base64,${bytes.toString('base64')}`
}

const entries = SLOTS.map(([id, label]) => {
  const open = dataUrl(`${id === 'anbot' ? 'anbot-160' : `${id}-160`}.webp`)
  const closedFile = `${id}-160-closed.webp`
  let closed = null
  try { closed = dataUrl(closedFile) } catch { closed = null }
  return [id, { label, open, closed }]
})

const markSvg = readFileSync(join(ASSETS, 'anbot-mark.svg'), 'utf8').trim()

const body = `// Generated from assets/marks by \`node dev/anbot-assets.mjs\`. Do not edit by hand.
// Built-in bitmap marks: 160px open/closed webp frames inlined as data URLs.
// \`closed\` is null when the slot ships no blink frame (the main mark).
export const ANBOT_MARKS = {
${entries.map(([id, slot]) => `  ${id}: { label: ${JSON.stringify(slot.label)}, open: ${JSON.stringify(slot.open)}, closed: ${slot.closed ? JSON.stringify(slot.closed) : 'null'} },`).join('\n')}
}

// True-vector main brand tile (dark plate baked in), used by the sidebar brand seat.
export const ANBOT_MARK_SVG = ${JSON.stringify(markSvg)}
`

writeFileSync(OUT, body)
console.log(`wrote ${OUT} (${entries.length} slots)`)
