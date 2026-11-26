// Builds the Anbot built-in bitmap marks into a client module.
//
//   node dev/anbot-assets.mjs        writes src/client/marks/anbot-assets.js
//
// Frame pipeline:
//   source cutout webp (assets/marks/<slot>-512.webp, 512x512 RGBA)
//     -> assets/marks/<slot>-160.webp  (bundled) and <slot>-512.webp (retina spare)
//
// Only the 160px open frame is inlined here; the 512px frame is kept on disk for
// future 2x retina avatars and is not bundled. These slots ship no blink frame,
// so `closed` is null for every one. The generated module is committed, like
// characters.js.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const ASSETS = join(PLUGIN, 'assets', 'marks')
const OUT = join(PLUGIN, 'src', 'client', 'marks', 'anbot-assets.js')

// Picker order matches PICKER_SHAPES in characters.js; anbot-girl is the default.
const SLOTS = [
  ['anbot-girl', 'Girl'],
  ['ds-headphone', 'Headphones'],
  ['ds-glasses', 'Glasses'],
  ['ds-scarf', 'Scarf'],
  ['ds-nightcap', 'Nightcap'],
  ['ds-overalls', 'Overalls'],
  ['ds-chef', 'Chef'],
  ['ds-wizard', 'Wizard'],
  ['ds-astro', 'Astro'],
  ['ds-detective', 'Detective'],
  ['ds-painter', 'Painter'],
  ['ds-gardener', 'Gardener'],
  ['ds-barista', 'Barista'],
  ['ds-skater', 'Skater'],
  ['ds-raincoat', 'Raincoat'],
]

const dataUrl = file => {
  const bytes = readFileSync(join(ASSETS, file))
  return `data:image/webp;base64,${bytes.toString('base64')}`
}

const entries = SLOTS.map(([id, label]) => {
  const open = dataUrl(`${id}-160.webp`)
  return [id, { label, open, closed: null }]
})

const body = `// Generated from assets/marks by \`node dev/anbot-assets.mjs\`. Do not edit by hand.
// Built-in bitmap marks: 160px open webp frames inlined as data URLs.
// \`closed\` is null: these slots ship no blink frame.
export const ANBOT_MARKS = {
${entries.map(([id, slot]) => `  ${JSON.stringify(id)}: { label: ${JSON.stringify(slot.label)}, open: ${JSON.stringify(slot.open)}, closed: null },`).join('\n')}
}
`

writeFileSync(OUT, body)
console.log(`wrote ${OUT} (${entries.length} slots)`)
