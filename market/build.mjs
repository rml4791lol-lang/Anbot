// Builds the catalog site from index.json and page.html.
// The page is a single file with the index inlined, so it opens by double-click
// and needs no server. Run: node market/build.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'))
const page = readFileSync(join(root, 'page.html'), 'utf8')

const html = page
  .replaceAll('__ANBOT_INDEX__', JSON.stringify(index).replace(/</g, '\\u003c'))
  .replaceAll('__INDEX_URL__', index.indexUrl)
  .replaceAll('__INSTALL_CMD__', index.install)

const out = join(root, 'site')
mkdirSync(join(out, 'assets', 'anbot'), { recursive: true })

writeFileSync(join(out, 'index.html'), html)
writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 2) + '\n')
for (const f of ['mascot.webp', 'mascot-face.webp']) copyFileSync(join(root, 'assets', f), join(out, 'assets', f))

for (const f of readdirSync(join(root, 'assets', 'anbot'))) {
  if (!f.endsWith('-160.webp')) continue
  copyFileSync(join(root, 'assets', 'anbot', f), join(out, 'assets', 'anbot', f))
}

console.log(`built ${index.items.length} items → site/index.html`)
