// Writes the generated blocks of the start page in src/start from the plugin's client modules
// in ../ds-bot (read only, as scripts/icon.mjs does):
// - start.html, between <!-- whale --> markers: the Anbot papercut whale as a static bitmap.
//   The raster itself is regenerated from the committed master assets/anbot-bot.png (and the
//   cut-out basin from anbot-basin.png) into the @2x/@3x files beside it.
// - start.css, between /* image */ markers: the bitmap's background rules.
// - start.css, between /* tokens */ markers: the DeepSeek theme's light and dark colors.
// - start.css, between /* springs */ markers: motion.js's springs as linear() curves.
// - ../page-card.css, between the same two markers: the same colors and springs, scoped to the
//   card that the team window shows in place of a message box, so that the page's own are kept.
// Usage: node scripts/start-assets.mjs [--check]   (--check exits 1 when a block is stale and
// writes nothing)
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INKS } from '../../ds-bot/src/client/inks.js'
import { allThemes, themeCss } from '../../ds-bot/src/client/themes.js'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const client = new URL('../../ds-bot/src/client/', import.meta.url)
const page = new URL('../src/start/', import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = join(root, 'assets')

const THEME_TOKENS = ['--bt-main', '--bt-card', '--bt-ink', '--bt-ink-2', '--bt-line', '--bt-line-2', '--bt-hover', '--bt-accent', '--bt-accent-ink']
// The status colors are the same in both modes; the plugin's base sheet defines them.
const BASE_TOKENS = ['--bt-green', '--bt-danger']
const SPRINGS = ['shape', 'tap', 'pop', 'stretch', 'list']
// The layer of the team window's card (preload.cjs).
const CARD_SCOPE = '.dsb-card-layer'

// The on-screen box is 140 px; the rasters are 2x and 3x of it.
const BOT_BOX = 128
const BOT_SIZES = [BOT_BOX * 2, BOT_BOX * 3]
const botFile = size => `bot@${String(size / BOT_BOX)}x.png`
const hitFile = size => `bot-hit@${String(size / BOT_BOX)}x.png`
// The basin she already wears as a hat, cut from the hatted master: 132 x 56 on screen.
const BASIN = [112, 46]
const BASIN_SIZES = [2, 3]
const basinFile = scale => `basin@${String(scale)}x.png`

// The start bot markup: a static bitmap, sized by the rules in the /* image */ block.
const rig = () => '<div class="whale-img" aria-hidden="true"></div>'

// Regenerate one raster from the committed master: trim the transparent border, then fit the
// cutout on a transparent square at the target size.
async function botRaster(size, master = 'anbot-bot.png') {
  const trimmed = await sharp(join(assetsDir, master)).ensureAlpha().trim().toBuffer({ resolveWithObject: true })
  return sharp(trimmed.data)
    .resize(size, size, { kernel: 'lanczos3', fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

async function basinRaster(scale) {
  const trimmed = await sharp(join(assetsDir, 'anbot-basin.png')).ensureAlpha().trim().toBuffer({ resolveWithObject: true })
  return sharp(trimmed.data)
    .resize(BASIN[0] * scale, BASIN[1] * scale, { kernel: 'lanczos3', fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

function imageCss() {
  return [
    '/* Generated from assets/anbot-bot.png by scripts/start-assets.mjs; do not edit. */',
    `.whale-img,.peek-img{display:block;width:100%;height:100%;background-repeat:no-repeat;background-position:50% 50%;background-size:contain;background-image:url('${botFile(BOT_SIZES[0])}')}`,
    `.basin-img{display:block;width:100%;height:100%;background-repeat:no-repeat;background-position:50% 50%;background-size:contain;background-image:url('${basinFile(BASIN_SIZES[0])}')}`,
    `html[data-hurt] .whale-img{background-image:url('${hitFile(BOT_SIZES[0])}')}`,
    `@media (-webkit-min-device-pixel-ratio:2.5),(min-resolution:2.5dppx){.whale-img,.peek-img{background-image:url('${botFile(BOT_SIZES[1])}')}.basin-img{background-image:url('${basinFile(BASIN_SIZES[1])}')}html[data-hurt] .whale-img{background-image:url('${hitFile(BOT_SIZES[1])}')}}`,
  ]
}

const rules = css => [...css.matchAll(/\{([^}]*)\}/gu)].map(([, body]) => new Map(body.split(';').filter(Boolean).map(item => item.split(/:(.*)/su).slice(0, 2))))
// The start page carries no skin variables, so a surface color that the app writes as
// `var(--bt-skin-main, #fcfcfc)` is copied at its theme fallback here.
const themeFallback = value => {
  const wrapped = /^var\(\s*--[\w-]+\s*,\s*([\s\S]+)\)$/u.exec(value)
  return wrapped === null ? value : wrapped[1].trim()
}
function pick(vars, names, from) {
  return names.map((name) => {
    if (!vars.has(name)) throw new Error(`${from} no longer sets ${name}`)
    return `${name}:${themeFallback(vars.get(name))}`
  }).join(';')
}

function tokens(scope = ':root') {
  const [light, dark] = rules(themeCss(allThemes().deepseek))
  const base = readFileSync(new URL('styles.js', client), 'utf8').match(/^body\{(--bt-[^}]*)\}$/mu)
  if (!base) throw new Error('styles.js: the base body rule was not found')
  const [ink, inkDark] = INKS.deepseek
  return [
    '/* Generated from the DeepSeek theme in ds-bot/src/client/themes.js, inks.js and styles.js by scripts/start-assets.mjs; do not edit. */',
    `${scope}{color-scheme:light dark;${pick(light, THEME_TOKENS, 'themeCss')};--bt-ink-deepseek:${ink};${pick(rules(`{${base[1]}}`)[0], BASE_TOKENS, 'styles.js')}}`,
    `@media (prefers-color-scheme:dark){${scope}{${pick(dark, THEME_TOKENS, 'themeCss')};--bt-ink-deepseek:${inkDark}}}`,
  ]
}

// motion.js imports React for its hooks; its springs are plain arithmetic, so the module runs
// here with the React names stubbed out.
async function motion() {
  const source = readFileSync(new URL('motion.js', client), 'utf8')
  const imports = source.match(/^import .*$/gmu) ?? []
  const react = imports.length === 1 ? imports[0].match(/^import \{([^}]*)\} from 'react'\r?$/u) : null
  if (!react) throw new Error('motion.js: expected its only import to be from react')
  const stub = `const {${react[1].replaceAll(' as ', ': ')}} = {}`
  return import(`data:text/javascript,${encodeURIComponent(source.replace(imports[0], stub))}`)
}

async function springs(scope = ':root') {
  const curves = await motion()
  return [
    '/* Generated from ds-bot/src/client/motion.js by scripts/start-assets.mjs; do not edit. */',
    `${scope} {`,
    ...SPRINGS.flatMap((name) => {
      const curve = curves[`SPRING_${name.toUpperCase()}`]
      if (!curve) throw new Error(`motion.js no longer exports SPRING_${name.toUpperCase()}`)
      return [`  --spring-${name}: ${curve.easing};`, `  --spring-${name}-ms: ${curve.duration}ms;`]
    }),
    '}',
  ]
}

// Replaces what lies between the two markers; a block of lines takes the file's own line ends,
// which git may have turned into CRLF on checkout.
function between(text, open, close, block) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const body = Array.isArray(block) ? `${eol}${block.join(eol)}${eol}` : block
  const a = text.indexOf(open)
  const b = text.indexOf(close, a + open.length)
  if (a < 0 || b < 0) throw new Error(`markers ${open} ${close} not found`)
  return `${text.slice(0, a + open.length)}${body}${text.slice(b)}`
}

const files = {
  'start.html': html => between(html, '<!-- whale -->', '<!-- /whale -->', rig()),
  'start.css': async css => between(between(between(css, '/* tokens */', '/* /tokens */', tokens()), '/* image */', '/* /image */', imageCss()), '/* springs */', '/* /springs */', await springs()),
  '../page-card.css': async css => between(between(css, '/* tokens */', '/* /tokens */', tokens(CARD_SCOPE)), '/* springs */', '/* /springs */', await springs(CARD_SCOPE)),
}
const check = process.argv.includes('--check')
const stale = []
for (const [name, generate] of Object.entries(files)) {
  const file = new URL(name, page)
  const text = readFileSync(file, 'utf8')
  const next = await generate(text)
  if (next === text) continue
  stale.push(name)
  if (!check) writeFileSync(file, next)
}
// The bot rasters: stale when the committed bytes differ from a fresh regeneration.
for (const size of BOT_SIZES) {
  const file = new URL(botFile(size), page)
  const next = await botRaster(size)
  let current = null
  try { current = readFileSync(file) } catch { /* missing */ }
  if (current && current.equals(next)) continue
  stale.push(botFile(size))
  if (!check) writeFileSync(file, next)
}
for (const size of BOT_SIZES) {
  const file = new URL(hitFile(size), page)
  const next = await botRaster(size, 'anbot-bot-hit.png')
  let current = null
  try { current = readFileSync(file) } catch { /* missing */ }
  if (current && current.equals(next)) continue
  stale.push(hitFile(size))
  if (!check) writeFileSync(file, next)
}
for (const scale of BASIN_SIZES) {
  const file = new URL(basinFile(scale), page)
  const next = await basinRaster(scale)
  let current = null
  try { current = readFileSync(file) } catch { /* missing */ }
  if (current && current.equals(next)) continue
  stale.push(basinFile(scale))
  if (!check) writeFileSync(file, next)
}
if (check && stale.length) {
  console.error(`start page: stale generated blocks in ${stale.join(', ')}; run node scripts/start-assets.mjs`)
  process.exit(1)
}
console.log(check ? 'start page: generated blocks are current' : stale.length ? `start page: wrote ${stale.join(', ')}` : 'start page: nothing to write')
