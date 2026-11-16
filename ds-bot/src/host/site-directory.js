// The user's published products and sites. This is a durable inventory, not a
// deployment runner: it records where each product lives and what the last
// reachability check saw. Project folders and Bots stay in their existing stores.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ENVIRONMENTS = new Set(['production', 'preview', 'local', 'docs'])
const HEALTH = new Set(['unknown', 'online', 'auth', 'error', 'offline'])
const NAME_MAX = 100
const URL_MAX = 1200
const NOTES_MAX = 2000
const TAGS_MAX = 12
const CHECK_TIMEOUT_MS = 8_000

const text = (value, max) => String(value ?? '').replaceAll('\u0000', '').trim().slice(0, max)
const timestamp = value => Number.isFinite(value) && value > 0 ? Math.floor(value) : Date.now()
const pathKey = home => join(home, 'sites.json')

function webUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    if (url.hostname === '') return undefined
    url.hash = ''
    return url.href.slice(0, URL_MAX)
  } catch {
    return undefined
  }
}

function repositoryUrl(value) {
  const raw = text(value, URL_MAX)
  if (raw === '') return null
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(raw)) return raw
  return webUrl(raw)?.replace(/\/$/, '') ?? null
}

function healthEntry(value) {
  const status = HEALTH.has(value?.status) ? value.status : 'unknown'
  const httpStatus = Number.isInteger(value?.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : null
  const latencyMs = Number.isFinite(value?.latencyMs) && value.latencyMs >= 0 ? Math.round(value.latencyMs) : null
  return {
    status,
    httpStatus,
    latencyMs,
    checkedAt: Number.isFinite(value?.checkedAt) && value.checkedAt > 0 ? value.checkedAt : null,
    error: text(value?.error, 300) || null,
  }
}

export function siteEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = text(value.id, 120)
  const name = text(value.name, NAME_MAX)
  const url = webUrl(value.url)
  if (id === '' || name === '' || url === undefined) return undefined
  const environment = ENVIRONMENTS.has(value.environment) ? value.environment : 'production'
  const createdAt = timestamp(value.createdAt)
  const updatedAt = Number.isFinite(value.updatedAt) && value.updatedAt >= createdAt ? Math.floor(value.updatedAt) : createdAt
  return {
    id,
    name,
    url,
    environment,
    groupId: text(value.groupId, 120) || null,
    projectPath: text(value.projectPath, 1200) || null,
    repoUrl: repositoryUrl(value.repoUrl),
    tags: [...new Set((Array.isArray(value.tags) ? value.tags : []).map(tag => text(tag, 40)).filter(Boolean))].slice(0, TAGS_MAX),
    notes: text(value.notes, NOTES_MAX),
    favorite: value.favorite === true,
    order: Number.isFinite(value.order) && value.order >= 0 ? Math.floor(value.order) : 0,
    archived: value.archived === true,
    health: healthEntry(value.health),
    createdAt,
    updatedAt,
  }
}

function groupEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = text(value.id, 120)
  const name = text(value.name, NAME_MAX)
  if (id === '' || name === '') return undefined
  const createdAt = timestamp(value.createdAt)
  const updatedAt = Number.isFinite(value.updatedAt) && value.updatedAt >= createdAt ? Math.floor(value.updatedAt) : createdAt
  return {
    id,
    name,
    color: text(value.color, 24) || null,
    order: Number.isFinite(value.order) && value.order >= 0 ? Math.floor(value.order) : 0,
    createdAt,
    updatedAt,
  }
}

function countsOf(sites, groups) {
  const visible = sites.filter(site => !site.archived)
  return {
    total: visible.length,
    production: visible.filter(site => site.environment === 'production').length,
    preview: visible.filter(site => site.environment === 'preview').length,
    local: visible.filter(site => site.environment === 'local').length,
    docs: visible.filter(site => site.environment === 'docs').length,
    online: visible.filter(site => site.health.status === 'online').length,
    auth: visible.filter(site => site.health.status === 'auth').length,
    attention: visible.filter(site => site.health.status === 'error' || site.health.status === 'offline').length,
    unknown: visible.filter(site => site.health.status === 'unknown').length,
    favorites: visible.filter(site => site.favorite).length,
    archived: sites.filter(site => site.archived).length,
    groups: groups.length,
  }
}

export function normalizeSiteDirectory(value) {
  const rawGroups = Array.isArray(value?.groups) ? value.groups : []
  const groups = []
  const groupIds = new Set()
  for (const candidate of rawGroups) {
    const group = groupEntry(candidate)
    if (group === undefined || groupIds.has(group.id)) continue
    groupIds.add(group.id)
    groups.push(group)
  }
  groups.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
  const rawSites = Array.isArray(value?.sites) ? value.sites : []
  const sites = []
  const siteIds = new Set()
  for (const candidate of rawSites) {
    const site = siteEntry(candidate)
    if (site === undefined || siteIds.has(site.id)) continue
    siteIds.add(site.id)
    if (site.groupId !== null && !groupIds.has(site.groupId)) site.groupId = null
    sites.push(site)
  }
  sites.sort((left, right) => Number(right.favorite) - Number(left.favorite) || left.order - right.order || left.name.localeCompare(right.name))
  return { version: 1, groups, sites, counts: countsOf(sites, groups) }
}

export async function probeSite(url, timeoutMs = CHECK_TIMEOUT_MS, request = fetch) {
  const started = Date.now()
  const target = webUrl(url)
  if (target === undefined) return { status: 'offline', httpStatus: null, latencyMs: 0, checkedAt: Date.now(), error: 'Invalid URL' }
  try {
    const options = { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) }
    let response = await request(target, options)
    if (response.status === 405 || response.status === 501) {
      await response.body?.cancel?.()
      response = await request(target, { ...options, method: 'GET' })
    }
    await response.body?.cancel?.()
    const status = response.status >= 200 && response.status < 400 ? 'online'
      : response.status === 401 || response.status === 403 ? 'auth'
        : 'error'
    return { status, httpStatus: response.status, latencyMs: Date.now() - started, checkedAt: Date.now(), error: null }
  } catch (error) {
    return { status: 'offline', httpStatus: null, latencyMs: Date.now() - started, checkedAt: Date.now(), error: text(error?.message ?? error, 300) || 'Could not reach the site' }
  }
}

export function install(rt) {
  const path = pathKey(rt.home)
  let loaded
  let writing = Promise.resolve()
  let mutating = Promise.resolve()

  const load = () => loaded ??= readFile(path, 'utf8').then(JSON.parse).then(normalizeSiteDirectory).catch(() => normalizeSiteDirectory())
  const persist = (data) => {
    const write = writing.then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify(data, null, 2), 'utf8')
      await rename(temp, path)
    })
    writing = write.catch(error => rt.warn?.(`ds-bot: saving the site directory failed: ${error?.message ?? error}`))
    return write
  }
  const view = async () => normalizeSiteDirectory(await load())
  const mutate = (change) => {
    const run = mutating.then(async () => {
      const current = normalizeSiteDirectory(await load())
      const next = normalizeSiteDirectory(await change(current) ?? current)
      await persist(next)
      loaded = next
      return next
    })
    mutating = run.catch(() => {})
    return run
  }
  const siteOf = (data, id) => data.sites.find(site => site.id === id)

  Object.assign(rt, {
    siteDirectoryView: view,
    async siteGroupSave(body = {}) {
      let row
      const next = await mutate(data => {
        const existing = body.id === undefined ? undefined : data.groups.find(group => group.id === body.id)
        row = groupEntry({
          ...existing,
          ...body,
          id: existing?.id ?? randomUUID(),
          order: body.order ?? existing?.order ?? data.groups.length,
          createdAt: existing?.createdAt,
          updatedAt: Date.now(),
        })
        if (row === undefined) throw new Error('A site group needs a name')
        return { ...data, groups: [...data.groups.filter(group => group.id !== row.id), row] }
      })
      return { ...next, group: row }
    },
    async siteGroupDelete(id) {
      const next = await mutate(data => ({
        ...data,
        groups: data.groups.filter(group => group.id !== id),
        sites: data.sites.map(site => site.groupId === id ? { ...site, groupId: null, updatedAt: Date.now() } : site),
      }))
      return next
    },
    async siteSave(body = {}) {
      let row
      const next = await mutate(data => {
        const existing = body.id === undefined ? undefined : siteOf(data, body.id)
        if (body.id !== undefined && existing === undefined) throw new Error('No such site')
        row = siteEntry({
          ...existing,
          ...body,
          id: existing?.id ?? randomUUID(),
          environment: body.environment ?? existing?.environment ?? 'production',
          order: body.order ?? existing?.order ?? data.sites.length,
          createdAt: existing?.createdAt,
          updatedAt: Date.now(),
        })
        if (row === undefined) throw new Error('A site needs a name and an http or https URL without credentials')
        if (row.groupId !== null && !data.groups.some(group => group.id === row.groupId)) throw new Error('That site group no longer exists')
        return { ...data, sites: [...data.sites.filter(site => site.id !== row.id), row] }
      })
      return { ...next, site: row }
    },
    async siteArchive(id, archived = true) {
      let row
      const next = await mutate(data => {
        const existing = siteOf(data, id)
        if (existing === undefined) throw new Error('No such site')
        row = { ...existing, archived: archived === true, updatedAt: Date.now() }
        return { ...data, sites: data.sites.map(site => site.id === id ? row : site) }
      })
      return { ...next, site: row }
    },
    async siteCheck(id) {
      const current = await view()
      const existing = siteOf(current, id)
      if (existing === undefined) throw new Error('No such site')
      const health = await probeSite(existing.url, CHECK_TIMEOUT_MS, rt.siteFetch ?? fetch)
      let row
      const next = await mutate(data => {
        const latest = siteOf(data, id)
        if (latest === undefined) throw new Error('No such site')
        // An edit while the request was in flight must not be replaced by its old row.
        row = latest.url === existing.url ? { ...latest, health, updatedAt: Date.now() } : latest
        return { ...data, sites: data.sites.map(site => site.id === id ? row : site) }
      })
      return { ...next, site: row }
    },
  })
}
