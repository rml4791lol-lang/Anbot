// Facts behind the team overview's project and Agent views. Project membership
// stays the sidebar's sections; this module adds the parts the roster does not
// carry: memory summaries, AGENTS.md evidence, recorded changes, and the checks a
// project has made available. It reads project files without writing them and
// never invents a pass rate.
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

const STANDARD_FILES = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md']
const CHECK_NAMES = ['test', 'lint', 'typecheck', 'check', 'build']
const FILE_MAX = 64 * 1024
const RECENT_MAX = 4
const TOPICS_MAX = 8
const QUALITY_FILE = '.ds-bot/quality.json'
const READ_CONCURRENCY = 6
const MANIFEST_FILE = '.ds-bot/standards.json'
const INTEGRATIONS_FILE = '.ds-bot/integrations.json'
const DOC_FILES = ['README.md', 'CONTRIBUTING.md']
const PROFILE_MARKERS = {
  miniprogram: ['project.config.json', 'app.json', 'app.js', 'app.ts', 'app.wxss', 'sitemap.json'],
  video: ['BRIEF.md', 'STORYBOARD.md', 'SCRIPT.md', 'hyperframes.json', 'remotion.config.ts'],
  web: ['package.json', 'index.html', 'vite.config.js', 'vite.config.ts', 'next.config.js', 'next.config.ts'],
  app: ['electron-builder.yml', 'tauri.conf.json', 'app.json'],
  backend: ['package.json', 'Dockerfile', 'openapi.yaml', 'openapi.json'],
}
const VIDEO_FILE = /\.(?:mp4|mov|mxf|prproj|fcpxml|aep|mkv|webm)$/i

const clip = (text, max = 160) => (text.length > max ? `${text.slice(0, max)}…` : text)
const unique = values => [...new Set(values.filter(Boolean))]

// A team can have many Bots and project folders. Read a few at a time so one
// overview refresh cannot exhaust file descriptors or fill the host's work queue.
async function mapLimit(items, limit, run) {
  const results = Array.from({ length: items.length })
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { status: 'fulfilled', value: await run(items[index], index) }
      } catch (error) {
        results[index] = { status: 'rejected', reason: error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export function standardsManifest(text) {
  let value
  try {
    value = JSON.parse(String(text ?? ''))
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const strings = (items, max, length) => (Array.isArray(items)
    ? items.filter(item => typeof item === 'string' && item.trim() !== '').slice(0, max).map(item => item.trim().slice(0, length))
    : [])
  const sources = Array.isArray(value.sources)
    ? value.sources.filter(source => source && typeof source.name === 'string')
      .slice(0, 30)
      .map(source => ({
        name: source.name.slice(0, 120),
        url: typeof source.url === 'string' && /^https?:\/\//.test(source.url) ? source.url.slice(0, 500) : null,
        scope: strings(source.scope, 12, 80),
        version: typeof source.version === 'string' ? source.version.slice(0, 80) : null,
        checkedAt: typeof source.checkedAt === 'string' || Number.isFinite(source.checkedAt) ? source.checkedAt : null,
      }))
    : []
  return {
    profile: typeof value.profile === 'string' ? value.profile.trim().slice(0, 40) : null,
    name: typeof value.name === 'string' ? value.name.trim().slice(0, 160) : null,
    sources,
    requiredFiles: strings(value.requiredFiles, 40, 160).filter(file => !file.startsWith('/') && !file.includes('..')),
    requiredChecks: strings(value.requiredChecks, 20, 80),
  }
}

export function documentSummary(text) {
  const raw = String(text ?? '').replace(/```[\s\S]*?```/g, ' ')
  const headings = raw.split(/\r?\n/).map(line => /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1]?.trim()).filter(Boolean).slice(0, 8)
  const excerpt = raw.replace(/^#{1,6}\s+/gm, '').replace(/[*_`>#-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180)
  return { headings, excerpt }
}

export function detectProjectProfile(names, manifest) {
  const set = new Set(names)
  if (manifest?.profile && Object.hasOwn(PROFILE_MARKERS, manifest.profile)) return { id: manifest.profile, declared: true }
  if (PROFILE_MARKERS.miniprogram.some(file => set.has(file))) return { id: 'miniprogram', declared: false }
  if (PROFILE_MARKERS.video.some(file => set.has(file)) || names.some(name => VIDEO_FILE.test(name))) return { id: 'video', declared: false }
  if (set.has('electron-builder.yml') || set.has('tauri.conf.json')) return { id: 'app', declared: false }
  if (set.has('vite.config.js') || set.has('vite.config.ts') || set.has('next.config.js') || set.has('next.config.ts')) return { id: 'web', declared: false }
  if (set.has('openapi.yaml') || set.has('openapi.json') || set.has('Dockerfile')) return { id: 'backend', declared: false }
  return { id: 'generic', declared: false }
}

export function standardSummary(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const headings = lines
    .map(line => /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1]?.trim())
    .filter(Boolean)
    .slice(0, 8)
  const allRuleLines = lines.filter(line => /^\s*(?:[-*+]|\d+\.)\s+\S/.test(line))
  const ruleLines = allRuleLines
    .slice(0, 8)
    .map(line => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').replace(/[*_`]/g, '').trim().slice(0, 180))
  const sources = unique((String(text ?? '').match(/https?:\/\/[^\s)>\]]+/g) ?? [])
    .map(url => url.replace(/[.,;:]+$/, '')))
    .slice(0, 12)
  return { headings, rules: allRuleLines.length, ruleLines, sources }
}


// An optional report written by the project's own CI or check runner. This
// endpoint never runs commands: it only shows a result the project recorded.
export function qualitySummary(text) {
  let value
  try {
    value = JSON.parse(String(text ?? ''))
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const number = key => (Number.isFinite(value[key]) && value[key] >= 0 ? Math.floor(value[key]) : undefined)
  const expected = number('expected')
  const total = number('total')
  const passed = number('passed')
  const checks = Array.isArray(value.checks)
    ? value.checks.filter(check => check && typeof check.name === 'string')
      .slice(0, 20)
      .map(check => ({ name: check.name.slice(0, 80), status: typeof check.status === 'string' ? check.status.slice(0, 24) : 'unknown' }))
    : []
  if (expected === undefined && total === undefined && passed === undefined && checks.length === 0) return undefined
  return {
    checkedAt: typeof value.checkedAt === 'string' || Number.isFinite(value.checkedAt) ? value.checkedAt : null,
    expected: expected ?? total ?? passed,
    passed: passed ?? checks.filter(check => check.status === 'passed').length,
    total: total ?? expected ?? passed,
    checks,
  }
}

export function packageChecks(text) {
  let value
  try {
    value = JSON.parse(String(text ?? ''))
  } catch {
    return []
  }
  const scripts = value?.scripts
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return []
  return CHECK_NAMES.flatMap(name => (typeof scripts[name] === 'string'
    ? [{ name, command: scripts[name].slice(0, 240) }]
    : []))
}

export function memoryOwnerSummary(view, scope) {
  const entries = (view?.entries ?? []).filter(entry => entry.scope === scope)
  const topics = unique(entries.map(entry => entry.topic).filter(Boolean)).slice(0, TOPICS_MAX)
  const recent = [...entries]
    .sort((a, b) => String(b.added ?? '').localeCompare(String(a.added ?? '')))
    .slice(0, RECENT_MAX)
    .map(entry => ({ text: clip(entry.text), topic: entry.topic ?? null, added: entry.added ?? null }))
  return {
    count: entries.length,
    size: Number(view?.sizes?.[scope] ?? 0),
    limit: Number(view?.limits?.[scope] ?? 0),
    topics,
    recent,
  }
}

async function smallFile(path) {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > FILE_MAX) return undefined
    return { text: await readFile(path, 'utf8'), updatedAt: info.mtimeMs, size: info.size }
  } catch {
    return undefined
  }
}

async function folderFacts(rt, folder, fresh) {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  const names = entries.map(entry => entry.name)
  const standards = await Promise.all(STANDARD_FILES.map(async file => ({ file, ...await smallFile(join(folder, file)) })))
  const standard = standards.find(entry => entry.text !== undefined)
  const pkg = await smallFile(join(folder, 'package.json'))
  const qualityFile = await smallFile(join(folder, QUALITY_FILE))
  const manifestFile = await smallFile(join(folder, MANIFEST_FILE))
  const integrationsFile = await smallFile(join(folder, INTEGRATIONS_FILE))
  const changes = typeof rt.projectChangeFacts === 'function'
    ? await rt.projectChangeFacts(folder).catch(() => null)
    : null
  const workItems = typeof rt.projectWorkItems === 'function'
    ? await rt.projectWorkItems(folder, { fresh }).catch(() => null)
    : null
  const manifest = manifestFile === undefined ? undefined : standardsManifest(manifestFile.text)
  const profile = detectProjectProfile(names, manifest)
  const documents = (await Promise.all(DOC_FILES.map(async file => {
    const found = await smallFile(join(folder, file))
    return found === undefined ? undefined : { path: file, ...documentSummary(found.text), updatedAt: found.updatedAt, size: found.size }
  }))).filter(Boolean)
  const git = await access(join(folder, '.git')).then(() => true, () => false)
  const summary = standard === undefined ? { headings: [], rules: 0, ruleLines: [], sources: [] } : standardSummary(standard.text)
  const markers = (PROFILE_MARKERS[profile.id] ?? []).map(path => ({ path, exists: names.includes(path) }))
  const required = await Promise.all((manifest?.requiredFiles ?? []).map(async path => ({ path, exists: await access(join(folder, path)).then(() => true, () => false) })))
  const adoptedFiles = [
    ...(standard === undefined ? [] : [{ path: standard.file, role: 'rules', exists: true, updatedAt: standard.updatedAt, size: standard.size, findings: summary }]),
    ...documents.map(doc => ({ path: doc.path, role: 'description', exists: true, updatedAt: doc.updatedAt, size: doc.size, findings: { headings: doc.headings } })),
    ...(pkg === undefined ? [] : [{ path: 'package.json', role: 'commands', exists: true, updatedAt: pkg.updatedAt, size: pkg.size }]),
    ...(manifestFile === undefined ? [] : [{ path: MANIFEST_FILE, role: 'standards', exists: true, updatedAt: manifestFile.updatedAt, size: manifestFile.size }]),
    ...(integrationsFile === undefined ? [] : [{ path: INTEGRATIONS_FILE, role: 'integration', exists: true, updatedAt: integrationsFile.updatedAt, size: integrationsFile.size }]),
    ...(qualityFile === undefined ? [] : [{ path: QUALITY_FILE, role: 'results', exists: true, updatedAt: qualityFile.updatedAt, size: qualityFile.size }]),
    ...markers.filter(marker => marker.exists).map(marker => ({ path: marker.path, role: 'project', exists: true })),
    ...required.filter(file => !file.exists).map(file => ({ path: file.path, role: 'required', exists: false })),
  ]
  return {
    folder,
    name: basename(folder) || folder,
    git,
    profile: {
      ...profile,
      name: manifest?.name || profile.id,
      markers,
      required,
      sources: manifest?.sources ?? [],
      requiredChecks: manifest?.requiredChecks ?? [],
    },
    manifest: manifest ?? null,
    documents,
    adoptedFiles,
    standards: {
      file: standard?.file ?? null,
      updatedAt: standard?.updatedAt ?? null,
      size: standard?.size ?? 0,
      ...summary,
    },
    checks: pkg === undefined ? [] : packageChecks(pkg.text),
    quality: qualityFile === undefined ? null : qualitySummary(qualityFile.text) ?? null,
    changes,
    workItems,
    packageUpdatedAt: pkg?.updatedAt ?? null,
  }
}

export function install(rt) {
  const { state } = rt
  let cached
  let cachedAt = 0
  let pending

  async function memoryFacts() {
    if (rt.memoryEnabled === false || typeof rt.memoryView !== 'function') {
      return { owners: {}, team: { count: 0, size: 0, limit: 0, topics: [], recent: [] }, total: 0 }
    }
    const owners = [
      ...Object.values(state.bots ?? {}).map(bot => ({ id: bot.id, kind: 'bot', body: { botId: bot.id } })),
      ...Object.values(state.rooms ?? {}).map(room => ({ id: room.id, kind: 'room', body: { roomId: room.id } })),
    ]
    const results = await mapLimit(owners, READ_CONCURRENCY, owner => rt.memoryView(owner.body))
    const byOwner = {}
    let team
    for (let i = 0; i < owners.length; i += 1) {
      const result = results[i]
      if (result.status !== 'fulfilled') continue
      const owner = owners[i]
      const scope = owner.kind === 'room' ? 'group' : 'own'
      byOwner[owner.id] = { kind: owner.kind, ...memoryOwnerSummary(result.value, scope) }
      team ??= memoryOwnerSummary(result.value, 'team')
    }
    team ??= { count: 0, size: 0, limit: 0, topics: [], recent: [] }
    const total = Object.values(byOwner).reduce((sum, owner) => sum + owner.count, 0) + team.count
    return { owners: byOwner, team, total }
  }

  async function folderFactsAll(fresh) {
    const folders = unique([
      ...Object.values(state.bots ?? {}).map(bot => bot.workDir),
      ...Object.values(state.rooms ?? {}).map(room => room.workDir),
    ].filter(folder => typeof folder === 'string' && folder !== ''))
    const rows = await mapLimit(folders, READ_CONCURRENCY, folder => folderFacts(rt, folder, fresh))
    const failed = rows.find(row => row.status === 'rejected')
    if (failed !== undefined) rt.warn?.('ds-bot: a project folder could not be read: %s', failed.reason?.message ?? failed.reason)
    const present = rows.flatMap(row => (row.status === 'fulfilled' ? [row.value] : []))
    return Object.fromEntries(present.map(row => [row.folder, row]))
  }

  async function read(fresh) {
    const [memory, folders] = await Promise.all([memoryFacts(), folderFactsAll(fresh)])
    return { at: Date.now(), memory, folders }
  }

  rt.overviewInsights = async (fresh = false) => {
    const now = Date.now()
    if (!fresh && cached !== undefined && now - cachedAt < 2_000) return cached
    if (pending !== undefined) return pending
    pending = read(fresh).then(value => {
      cached = value
      cachedAt = Date.now()
      return value
    }).finally(() => { pending = undefined })
    return pending
  }
}
