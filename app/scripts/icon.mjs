// Rasterizes the committed Anbot SVGs in assets/ into the platform icon files:
// assets/icon.svg, assets/icon.png (1024 px), assets/icon.ico (Windows, 16 to 256 px)
// and the tray marks: assets/tray.ico (Windows), assets/tray.png (Linux),
// assets/trayTemplate.png with its @2x (macOS), and the per-size PNGs in assets/icons/,
// which electron-builder installs into hicolor/<size>x<size>/apps/ for the Linux menu and taskbar.
// Usage: npm run icon. It runs itself again inside Electron, which turns the SVGs into PNGs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(import.meta.url)
const assets = join(dirname(here), '..', 'assets')
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 72, 96, 128, 256]
// The Linux hicolor set: 1024x1024 is not a registered hicolor directory, so a single large
// PNG installs as an unresolvable icon. electron-builder copies these into hicolor/<size>x<size>/apps/.
const HICOLOR_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512]
// The tray icon is small: the sizes a notification area shows, and one plain png for Linux.
const TRAY_ICO_SIZES = [16, 20, 24, 32]
const TRAY_PNG_SIZE = 24
// macOS draws a template image itself, in the colour of the menu bar: a black mark with the
// shape of the Anbot monogram.
const TRAY_TEMPLATE_SIZES = [16, 32]
// Ink for the coloured tray mark (Windows / Linux), matching the cyan of the app icon.
const TRAY_INK = '#2AD4FF'

// Committed vector sources. The SVG in assets/ is the single source of truth for the shape;
// this script only converts it to the raster formats each platform reads.
const appSvg = readFileSync(join(assets, 'icon.svg'), 'utf8')
const trayMarkSvg = readFileSync(join(assets, 'tray-mark.svg'), 'utf8')
// The tray mark ships in black for the macOS template; the Windows and Linux tray repaints it cyan.
const coloredTraySvg = trayMarkSvg.replaceAll('#000', TRAY_INK)

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

// Inside Electron: a page draws each SVG on a canvas of its exact size, so every size is
// drawn from the vectors rather than scaled down from a large bitmap.
async function renderInElectron(jobs) {
  const { BrowserWindow } = await import('electron')
  const page = new BrowserWindow({ show: false })
  await page.loadURL('data:text/html,<!doctype html><title>icon</title>')
  const draw = async (list) => Promise.all(list.map(async ({ svg, size }) => {
    const image = new Image()
    image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    canvas.getContext('2d').drawImage(image, 0, 0, size, size)
    return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length)
  }))
  const pngs = await page.webContents.executeJavaScript(`(${draw.toString()})(${JSON.stringify(jobs)})`)
  page.destroy()
  return pngs.map(data => Buffer.from(data, 'base64'))
}

if (process.versions.electron) {
  const jobs = [
    { svg: appSvg, size: 1024 },
    ...ICO_SIZES.map(size => ({ svg: appSvg, size })),
    ...TRAY_ICO_SIZES.map(size => ({ svg: coloredTraySvg, size })),
    { svg: coloredTraySvg, size: TRAY_PNG_SIZE },
    ...TRAY_TEMPLATE_SIZES.map(size => ({ svg: trayMarkSvg, size })),
    ...HICOLOR_SIZES.map(size => ({ svg: appSvg, size })),
  ]
  // Not awaited at the top: Electron is ready only after the main module has run.
  const { app } = await import('electron')
  app.whenReady().then(() => renderInElectron(jobs)).then(([large, ...rest]) => {
    const small = rest.slice(0, ICO_SIZES.length)
    const hicolorPngs = rest.slice(-HICOLOR_SIZES.length)
    const tray = rest.slice(ICO_SIZES.length, rest.length - HICOLOR_SIZES.length)
    writeFileSync(join(assets, 'icon.png'), large)
    writeFileSync(join(assets, 'icon.ico'), icoFile(ICO_SIZES.map((size, index) => ({ size, png: small[index] }))))
    writeFileSync(join(assets, 'tray.ico'), icoFile(TRAY_ICO_SIZES.map((size, index) => ({ size, png: tray[index] }))))
    writeFileSync(join(assets, 'tray.png'), tray[TRAY_ICO_SIZES.length])
    writeFileSync(join(assets, 'trayTemplate.png'), tray[TRAY_ICO_SIZES.length + 1])
    writeFileSync(join(assets, 'trayTemplate@2x.png'), tray[TRAY_ICO_SIZES.length + 2])
    mkdirSync(join(assets, 'icons'), { recursive: true })
    for (const [index, size] of HICOLOR_SIZES.entries()) {
      writeFileSync(join(assets, 'icons', `${size}x${size}.png`), hicolorPngs[index])
    }
    app.exit(0)
  }).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  mkdirSync(assets, { recursive: true })
  // A terminal inside an Electron-based editor may set ELECTRON_RUN_AS_NODE, which would keep Electron plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  const electron = createRequire(import.meta.url)('electron')
  const run = spawnSync(electron, [here], { stdio: 'inherit', env })
  if (run.status !== 0) process.exit(run.status ?? 1)
  console.log('icon: wrote assets/icon.png, assets/icon.ico, the tray marks and the per-size icons in assets/icons/')
}
