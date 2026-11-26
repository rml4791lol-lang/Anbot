// Builds the Anbot built-in bitmap marks into a client module.
//
//   node dev/anbot-assets.mjs        writes src/client/marks/anbot-assets.js
//
// Frame pipeline:
//   source cutout webp (assets/marks/<slot>-512.webp, 512x512 RGBA)
//     -> assets/marks/<slot>-160.webp  (bundled open frame) and <slot>-closed-160.webp
//        (bundled blink frame); the 512px open/closed frames are kept on disk for
//        future 2x retina avatars and are not bundled.
//
// Each slot inlines both the 160px open frame and the 160px closed (blink) frame as
// data URLs. The generated module is committed, like characters.js.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const ASSETS = join(PLUGIN, 'assets', 'marks')
const OUT = join(PLUGIN, 'src', 'client', 'marks', 'anbot-assets.js')

// Picker order matches PICKER_SHAPES in characters.js; anbot is the default.
const SLOTS = [
  ['anbot', 'Anbot'],
  ['headphone', 'Headphones'],
  ['glasses', 'Glasses'],
  ['scarf', 'Scarf'],
  ['nightcap', 'Nightcap'],
  ['overalls', 'Overalls'],
  ['chef', 'Chef'],
  ['wizard', 'Wizard'],
  ['astro', 'Astro'],
  ['detective', 'Detective'],
  ['painter', 'Painter'],
  ['gardener', 'Gardener'],
  ['barista', 'Barista'],
  ['skater', 'Skater'],
  ['raincoat', 'Raincoat'],
]

const dataUrl = file => {
  const bytes = readFileSync(join(ASSETS, file))
  return `data:image/webp;base64,${bytes.toString('base64')}`
}

const entries = SLOTS.map(([id, label]) => [id, {
  label,
  open: dataUrl(`${id}-160.webp`),
  closed: dataUrl(`${id}-closed-160.webp`),
}])

const body = `// Generated from assets/marks by \`node dev/anbot-assets.mjs\`. Do not edit by hand.
// Built-in bitmap marks: 160px open and closed (blink) webp frames inlined as data URLs.
export const ANBOT_MARKS = {
${entries.map(([id, slot]) => `  ${JSON.stringify(id)}: { label: ${JSON.stringify(slot.label)}, open: ${JSON.stringify(slot.open)}, closed: ${JSON.stringify(slot.closed)} },`).join('\n')}
}
`

writeFileSync(OUT, body)
console.log(`wrote ${OUT} (${entries.length} slots, open + closed frames each)`)
