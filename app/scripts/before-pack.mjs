// electron-builder's beforePack hook. The native modules go into the package as npm installed them
// (npmRebuild: false), so they fit only the architecture of the Node that ran npm. An app built for
// another architecture would carry them and not start, so such a build stops here.
import { Arch } from 'electron-builder'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { x as extractTar } from 'tar'
import { preparePrimaryRuntime, runtimeTarget } from './prepare-runtime.mjs'

const WHERE = {
  darwin: { x64: 'on an Intel Mac, or under Rosetta with an x64 Node', arm64: 'on a Mac with Apple silicon' },
}

/** @returns {string | undefined} why this Node cannot build an app for `target` */
export function archProblem({ target, platform, host = process.arch, targets = [] }) {
  // electron-builder packs a universal app one architecture at a time: the hook only sees the
  // inner x64/arm64 builds, so a universal request is known from the requested targets.
  if (target === 'universal' || targets.includes('universal')) return 'A universal app would need the native modules of both architectures. Build one app per architecture.'
  if (target === host) return undefined
  const where = WHERE[platform]?.[target] ?? `with an ${target} Node`
  return `This Node runs on ${host}, so npm installed ${host} native modules, and an ${target} app with them would not start. Install the dependencies and build ${where}.`
}

/**
 * The Office payload the package ships next to the asar through extraResources; it must
 * match the package's own platform and architecture, which the arch check guarantees.
 * @param {*} context - electron-builder's beforePack context.
 * @returns {{ target: string, output: string, cache: string, version: string }}
 */
export function officeRuntimeRequest(context) {
  const target = runtimeTarget(context.electronPlatformName, Arch[context.arch])
  if (target === undefined) throw new Error(`No Office runtime payload for ${context.electronPlatformName} ${Arch[context.arch]}.`)
  // The context's packager is the PlatformPackager; the app directory lives on its Packager
  // (.info), exposed directly as projectDir. For this one-package app they are the same.
  const appDir = context.packager.appDir ?? context.packager.projectDir
  return {
    target,
    output: join(appDir, 'build', 'runtime'),
    cache: process.env.DS_BOT_RUNTIME_CACHE ?? join(appDir, 'build', 'runtime-cache'),
    version: context.packager?.appInfo?.version
      ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  }
}

/**
 * npm is npm.cmd on Windows, which a shell-less spawn cannot find. Prefer the entry script npm put
 * in the environment and run it with the same Node; fall back to the plain command elsewhere.
 * @returns {{ command: string, lead: string[] }}
 */
function npmInvocation() {
  const cli = process.env.npm_execpath
  if (cli !== undefined && cli.endsWith('.js')) return { command: process.execPath, lead: [cli] }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', lead: [] }
}

/**
 * Refresh the installed file dependency from the package's published file list. npm does not
 * recopy a `file:../ds-bot` dependency when only its source changes, which would silently ship
 * an older plugin than the one tested in this checkout.
 * @param {{ appDir?: string, run?: typeof execFileSync, extract?: typeof extractTar }} [options]
 * @returns {Promise<string>} the refreshed package directory
 */
export async function syncDsBotPackage({ appDir = process.cwd(), run = execFileSync, extract = extractTar } = {}) {
  const source = join(appDir, '..', 'ds-bot')
  const destination = join(appDir, 'node_modules', 'ds-bot')
  const staging = mkdtempSync(join(tmpdir(), 'ds-bot-package-'))
  const npm = npmInvocation()
  try {
    const packed = JSON.parse(run(npm.command, [...npm.lead, 'pack', '--json', '--pack-destination', staging], {
      cwd: source,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }))
    const filename = Array.isArray(packed) ? packed[0]?.filename : packed?.filename
    if (typeof filename !== 'string' || filename === '') throw new Error('ds-bot package: npm pack returned no filename.')
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
    await extract({ file: join(staging, filename), cwd: destination, strip: 1 })
    return destination
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export async function beforePack(context, prepare = preparePrimaryRuntime, sync = syncDsBotPackage) {
  const targets = []
  for (const archToNames of context.packager?.packagerOptions?.targets?.values() ?? [])
    for (const arch of archToNames.keys()) targets.push(Arch[arch])
  const problem = archProblem({ target: Arch[context.arch], platform: context.electronPlatformName, targets })
  if (problem !== undefined) throw new Error(problem)
  const appDir = context.packager.appDir ?? context.packager.projectDir
  await sync({ appDir })
  await prepare(officeRuntimeRequest(context))
}
