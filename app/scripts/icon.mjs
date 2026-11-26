// Rebuilds the raster icon files from the committed 1024 px master assets/icon.png:
// assets/icon.ico (Windows, 16 to 256 px, 32bpp PNG entries) and the per-size PNGs in
// assets/icons/, which electron-builder installs into hicolor/<size>x<size>/apps/ for the
// Linux menu and taskbar. The tray products (tray.ico, tray.png, trayTemplate.png and its
// @2x) are committed source rasters and are not regenerated here.
// Usage: npm run icon.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(import.meta.url)
const assets = join(dirname(here), '..', 'assets')
// Windows picks the nearest entry; 256 is the largest the .ico container stores by width byte.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
// The Linux hicolor set: 1024x1024 is not a registered hicolor directory, so a single large
// PNG installs as an unresolvable icon.
const HICOLOR_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512]

const require = createRequire(import.meta.url)
const sharp = require('sharp')

// PNG entries in an .ico file, which Windows reads since Vista.
function icoFile(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, png }, index) => {
    const at = 6 + 16 * index
    head.writeUInt8(size >= 256 ? 0 : size, at)
    head.writeUInt8(size >= 256 ? 0 : size, at + 1)
    head.writeUInt16LE(1, at + 4)
    head.writeUInt16LE(32, at + 6)
    head.writeUInt32LE(png.length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...images.map(image => image.png)])
}

async function pngAt(size) {
  return sharp(join(assets, 'icon.png'))
    .resize(size, size, { kernel: 'lanczos3', fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

const icoPngs = await Promise.all(ICO_SIZES.map(pngAt))
writeFileSync(join(assets, 'icon.ico'), icoFile(ICO_SIZES.map((size, index) => ({ size, png: icoPngs[index] }))))

mkdirSync(join(assets, 'icons'), { recursive: true })
for (const size of HICOLOR_SIZES) {
  writeFileSync(join(assets, 'icons', `${size}x${size}.png`), await pngAt(size))
}

console.log('icon: rebuilt assets/icon.ico and assets/icons/ from assets/icon.png')
