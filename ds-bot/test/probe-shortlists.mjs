// Verify every Bot's shortlist names through the SAME two layers the host uses.
//
// `update_bot` validates a shortlist against the union of
//   1. the host skill catalog (the DSH profile providers), and
//   2. the Bot's live Agent catalog: DS-Bot skills saved as capabilities
//      (`capabilities.items[].kind === 'skill'`), skills shipped in
//      `src/host/skills/`, and skills an installed DSH plugin registers in the
//      Agent scope (a `skills/<name>/SKILL.md` asset, or `ctx.skills.register()`
//      with a literal `name: '<skill>'`).
//
// This probe mounts the host side with the same providers cordis.patch.yml uses
// and reads the Agent side from those sources on disk, so a name the real
// update_bot path accepts is not reported as a failure here.
//
// Usage, from ds-bot/:
//   node --import ./test/harness-resolve.mjs test/probe-shortlists.mjs <shortlist.json> [purposes.json] [cwd] [--state <path>] [--dsh-home <dir>]
//
// shortlist.json is `{ "cases": { "<Bot>": ["<skill>", ...] } }` or a plain
// `{ "<Bot>": [...] }` map. purposes.json is `{ "<skill>": "<one line>" }`; a
// missing purpose falls back to a generic line so the shape check still runs.
// `--state` defaults to `$DSH_HOME/bot/state.json`; `--dsh-home` defaults to
// `$DSH_HOME` or `~/.dsh`. Both are read only, never written.
// Exits 1 when a name resolves in none of the layers.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as FsSkill from '@deepseek-ai/dsh-skill-filesystem'
import { catalogEntries, validateShortlistAgainstCatalog } from '../src/host/skill-catalog.js'

const argv = process.argv.slice(2)
const positional = []
const flags = {}
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (!arg.startsWith('--')) {
    positional.push(arg)
    continue
  }
  const [key, inline] = arg.slice(2).split('=')
  flags[key] = inline ?? argv[++index]
}
const [shortlistPath, purposesPath, cwd = process.cwd()] = positional
if (shortlistPath === undefined) {
  console.error('usage: node --import ./test/harness-resolve.mjs test/probe-shortlists.mjs <shortlist.json> [purposes.json] [cwd] [--state <path>] [--dsh-home <dir>]')
  process.exit(2)
}

const dshHome = resolve(flags['dsh-home'] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const statePath = flags.state === undefined ? join(dshHome, 'bot', 'state.json') : resolve(flags.state)

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function listDirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

// Layer 2a: DS-Bot capabilities saved as skills on the team state.
function capabilitySkillNames() {
  const state = readJson(statePath)
  const items = state?.capabilities?.items ?? {}
  const names = new Map()
  for (const item of Object.values(items)) {
    if (item?.kind !== 'skill') continue
    if (typeof item.name !== 'string' || item.name === '') continue
    names.set(item.name, `capability:${statePath}`)
  }
  return names
}

// Layer 2b: skills shipped with DS-Bot itself.
const builtinRoot = fileURLToPath(new URL('../src/host/skills/', import.meta.url))
function builtinSkillNames() {
  const names = new Map()
  for (const name of listDirs(builtinRoot)) {
    if (existsSync(join(builtinRoot, name, 'SKILL.md'))) names.set(name, 'builtin:src/host/skills')
  }
  return names
}

// Layer 2c: skills an installed DSH plugin ships as assets.
function packageSkillNames(packageDir, label) {
  const names = new Map()
  for (const sub of ['skills', 'lib/skills', 'assets', 'lib/assets']) {
    const root = join(packageDir, sub)
    for (const name of listDirs(root)) {
      if (existsSync(join(root, name, 'SKILL.md'))) names.set(name, `${label}`)
    }
  }
  return names
}

function installedPluginPackages() {
  const packages = []
  const profilesRoot = join(dshHome, 'profiles')
  for (const profile of listDirs(profilesRoot)) {
    const manifest = readJson(join(profilesRoot, profile, 'package.json'))
    for (const dep of Object.keys(manifest?.dependencies ?? {})) {
      const dir = join(profilesRoot, profile, 'node_modules', ...dep.split('/'))
      if (isDir(dir)) packages.push({ dir, label: `plugin:${dep}` })
    }
  }
  return packages
}

function hostPackageSkillNames() {
  const names = new Map()
  const cacheRoot = join(dshHome, 'cache', 'host-packages')
  for (const id of listDirs(cacheRoot)) {
    const nodeModules = join(cacheRoot, id, 'node_modules')
    const scopes = listDirs(nodeModules)
    for (const scope of scopes) {
      const scopeDir = join(nodeModules, scope)
      if (!scope.startsWith('@')) continue
      for (const pkg of listDirs(scopeDir)) {
        const dir = join(scopeDir, pkg)
        for (const [name, label] of packageSkillNames(dir, `host-package:${pkg}`)) names.set(name, label)
      }
    }
  }
  return names
}

function walkJsFiles(root, depth, out, limit = 4000) {
  if (depth < 0 || out.length >= limit) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= limit) return
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walkJsFiles(path, depth - 1, out, limit)
    } else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
      out.push(path)
    }
  }
}

// Layer 2d: skills a plugin registers from code, e.g.
//   ctx.skills.register(GRAPHLINT_SKILL)  with  name: 'graphlint'
function codeRegisteredSkillNames(packages) {
  const names = new Map()
  for (const { dir, label } of packages) {
    const files = []
    walkJsFiles(join(dir, 'lib'), 4, files)
    for (const file of files) {
      let text
      try {
        if (statSync(file).size > 512 * 1024) continue
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      // Only the object handed to skills.register() counts. A file that also
      // declares tools (name: 'od_skills', ...) must not make those names look
      // like skills.
      const relative = file.slice(dir.length + 1)
      for (const call of text.matchAll(/skills\.register\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
        const identifier = call[1]
        const start = text.indexOf(`const ${identifier} = {`)
        if (start === -1) continue
        const rest = text.slice(start, start + 4000)
        const end = rest.indexOf('\n};')
        const body = end === -1 ? rest : rest.slice(0, end)
        const name = body.match(/name:\s*'([^']+)'/)
        if (name !== null) names.set(name[1], `${label}:${relative}`)
      }
    }
  }
  return names
}

const purposes = purposesPath === undefined
  ? {}
  : JSON.parse(readFileSync(purposesPath, 'utf8'))
const parsed = JSON.parse(readFileSync(shortlistPath, 'utf8'))
const botLists = parsed.cases ?? parsed

const ctx = new Context()
await ctx.plugin(SkillRegistry)
await ctx.plugin(FsSkill, { providerName: 'ds-bot-profile' })

const profile = await ctx.skills.list({ cwd })
const catalog = catalogEntries(profile)
console.log(`profileEntries ${profile.length} catalogEntries ${catalog.length}`)
const hostNames = new Set(catalog.map(skill => skill.name))

const pluginPackages = installedPluginPackages()
const agentNames = new Map()
for (const layer of [
  capabilitySkillNames(),
  builtinSkillNames(),
  hostPackageSkillNames(),
  ...pluginPackages.map(({ dir, label }) => packageSkillNames(dir, label)),
  codeRegisteredSkillNames(pluginPackages),
]) {
  for (const [name, source] of layer) {
    if (!agentNames.has(name)) agentNames.set(name, source)
  }
}
console.log(`agentLayer capability=${capabilitySkillNames().size} builtin=${builtinSkillNames().size} plugins=${pluginPackages.length} agentNames=${agentNames.size}`)
console.log(`state ${existsSync(statePath) ? statePath : `absent (${statePath})`}`)

if (process.env.PROBE_VERBOSE === '1') {
  for (const [name, source] of [...agentNames].sort(([a], [b]) => a.localeCompare(b))) console.log(`agent ${name} <- ${source}`)
}

for (const probe of ['test-driven-development', 'ppt-studio', 'graphlint', 'office-docx', 'goal-grill', 'bot-dispatch-and-reporting']) {
  const layer = hostNames.has(probe) ? 'host' : agentNames.has(probe) ? 'agent' : 'none'
  console.log(`name ${probe} present=${layer !== 'none'} layer=${layer}`)
}

// Names the Agent layer resolves but the host catalog lacks: validate them with
// the host's own gate by adding the resolved entries to the catalog view.
const synthetic = [...agentNames]
  .filter(([name]) => !hostNames.has(name))
  .map(([name, source]) => ({ name, description: `Resolved from ${source}.`, provider: source, source: 'agent', modelInvocable: true }))
const unionCatalog = [...catalog, ...synthetic]
console.log(`unionEntries ${unionCatalog.length} agentOnly ${synthetic.length}`)

let failures = 0
const applied = {}
for (const [bot, list] of Object.entries(botLists)) {
  const shaped = list.map(name => ({ name, purpose: purposes[name] ?? `Use ${name} when the task calls for it.` }))
  try {
    const checked = validateShortlistAgainstCatalog(shaped, unionCatalog)
    applied[bot] = checked
    const labelled = checked.map(skill => `${skill.name}[${hostNames.has(skill.name) ? 'host' : 'agent'}]`)
    console.log(`OK ${bot} n=${checked.length} ${labelled.join(',')}`)
  } catch (error) {
    failures += 1
    const unresolved = []
    for (const name of list) {
      if (!hostNames.has(name) && !agentNames.has(name)) unresolved.push(name)
    }
    console.log(`FAIL ${bot} ${error.message}${unresolved.length === 0 ? '' : ` unresolved=${unresolved.join(',')}`}`)
  }
}
console.log(`bots ${Object.keys(botLists).length} failures ${failures}`)
process.stdout.write('\n===APPLIED_JSON===\n' + JSON.stringify(applied, null, 2) + '\n')
await ctx.fiber.dispose()
process.exit(failures === 0 ? 0 : 1)
