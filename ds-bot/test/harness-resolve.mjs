// Tests import web-search.js outside a dsh profile, so its @deepseek-ai peers resolve from a
// DeepSeek Harness, as a profile would supply them: DSH_HARNESS, else the packages that
// `npm run harness` installs in dev/harness, else the nearest deepseek-harness/ checkout in a
// folder above ds-bot, else the same search from ds-bot's place in the main worktree (a git
// worktree has no checkout of its own).
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const plugin = resolve(import.meta.dirname, '..')
const installed = join(plugin, 'dev', 'harness')
// The DSH version the tests are written against, as `npm run harness` pins it. A checkout
// found in a folder above ds-bot is only used at that version: an older join left there
// used to satisfy the imports, so the suite passed against a DSH the plugin does not
// support. An explicit DSH_HARNESS stays the caller's choice, unversioned.
const pinned = (() => {
  try {
    const wanted = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).dependencies?.['@deepseek-ai/dsh']
    return typeof wanted === 'string' ? wanted.replace(/^[~^]/, '') : undefined
  } catch {
    return undefined
  }
})()
const versionOf = (dir) => {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version } catch { return undefined }
}
const ignored = []
const isPinned = (dir) => {
  if (pinned === undefined) return true
  const version = versionOf(dir)
  if (version === pinned || version === `v${pinned}`) return true
  ignored.push(`${dir} (${version ?? 'no package.json'})`)
  return false
}
const above = (start) => {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, 'deepseek-harness')
    if (existsSync(candidate) && isPinned(candidate)) return candidate
    if (dirname(dir) === dir) return undefined
  }
}
const findHarness = () => {
  if (process.env.DSH_HARNESS) return process.env.DSH_HARNESS
  if (existsSync(join(installed, 'node_modules'))) return installed
  const near = above(dirname(plugin))
  if (near) return near
  const beside = resolve(plugin, '../deepseek-harness')
  try {
    const git = (...args) => execFileSync('git', ['-C', dirname(plugin), 'rev-parse', ...args], { encoding: 'utf8' }).trim()
    const fromWorktree = above(join(dirname(git('--path-format=absolute', '--git-common-dir')), git('--show-prefix')))
    if (fromWorktree) return fromWorktree
  } catch {}
  if (existsSync(beside) && isPinned(beside)) return beside
  // Nothing usable: say so once, clearly, instead of letting every test fail on a missing
  // package and hiding the cause.
  throw new Error([
    `test: no DeepSeek Harness ${pinned ?? ''} found, so the suite cannot load its packages — a setup problem, not a test failure.`,
    ignored.length > 0 ? `  ignored: ${[...new Set(ignored)].join(', ')}` : '',
    '  fix: npm run harness   (installs the pinned DSH into ds-bot/dev/harness)',
    '       or: DSH_HARNESS=/path/to/deepseek-harness npm test',
  ].filter(Boolean).join('\n'))
}
const harness = findHarness()
// Tests that load other harness packages (jsdom) read the same checkout.
process.env.DSH_HARNESS = harness
// An npm install links the packages at its root; a pnpm checkout keeps each workspace
// package in its own folder, where Node's self-reference rule resolves its exports.
const base = resolve(harness, 'packages/bundle/base/package.json')
const anchor = pathToFileURL(existsSync(base) ? base : resolve(harness, 'package.json')).href
const workspacePackages = new Map()
if (existsSync(base)) {
  const dirs = [
    ...['apps', 'vendor'].flatMap(group => existsSync(join(harness, group))
      ? readdirSync(join(harness, group), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(harness, group, entry.name))
      : []),
    ...(existsSync(join(harness, 'packages'))
      ? readdirSync(join(harness, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory())
        .flatMap(group => readdirSync(join(harness, 'packages', group.name), { withFileTypes: true })
          .filter(entry => entry.isDirectory()).map(entry => join(harness, 'packages', group.name, entry.name)))
      : []),
  ]
  for (const dir of dirs) {
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8'))
      if (typeof name === 'string') workspacePackages.set(name, pathToFileURL(manifest).href)
    } catch {}
  }
}
const packageNameOf = specifier => specifier.split('/').slice(0, 2).join('/')
const pluginUrl = `${pathToFileURL(plugin).href}/`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(pluginUrl)) {
      const parentURL = workspacePackages.get(packageNameOf(specifier)) ?? anchor
      return nextResolve(specifier, { ...context, parentURL })
    }
    return nextResolve(specifier, context)
  },
})

// With --test-force-exit, Node's test runner calls process.exit() right after the reporter unpipes
// from process.stdout, before buffered serialized frames finish draining. Wait for stdout and
// stderr write queues to flush in child test contexts while preserving exit code validation.
const flushStream = (stream, done) => {
  if (!stream || stream.destroyed || stream.writableEnded || stream.writableFinished || !stream.writable) {
    done()
    return
  }
  let settled = false
  const finish = () => {
    if (settled) return
    settled = true
    stream.off('close', finish)
    done()
  }
  while (stream.writableCorked > 0) stream.uncork()
  // Keep a persistent error listener while exiting so an async EPIPE on one stream cannot crash
  // before the other stream finishes flushing.
  stream.on('error', finish)
  stream.once('close', finish)
  try {
    stream.write('', finish)
  } catch {
    finish()
  }
}

const testContext = process.env.NODE_TEST_CONTEXT
if (testContext === 'child-v8' || testContext === 'child') {
  const originalExit = process.exit
  let exiting = false
  process.exit = function exit(code) {
    if (exiting) return
    if (arguments.length !== 0) process.exitCode = code
    exiting = true
    const streams = [process.stdout, process.stderr]
    let pending = streams.length
    const onFlushed = () => {
      if (--pending !== 0) return
      process.exit = originalExit
      originalExit.call(process)
    }
    for (const stream of streams) flushStream(stream, onFlushed)
  }
}
