// Project work items from the same source-control system the code lives in.
// GitHub CLI is preferred because it handles multiple accounts and Enterprise;
// the GitHub connector token is a read-only fallback when gh is unavailable.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { writeProjectChange } from './project-records.js'

const runFile = promisify(execFile)
const CONFIG_FILE = '.ds-bot/integrations.json'
const CACHE_MAX_ITEMS = 80
const DEFAULT_LIMIT = 40
const DEFAULT_REFRESH = 60
const GH_TIMEOUT = 15_000
const GH_MAX_BUFFER = 2 * 1024 * 1024
const PR_FIELDS = 'number,title,state,isDraft,author,assignees,reviewRequests,reviewDecision,mergeStateStatus,statusCheckRollup,updatedAt,url,headRefName,baseRefName'
const ISSUE_FIELDS = 'number,title,state,author,assignees,labels,updatedAt,url'
const PASSED_CHECKS = new Set(['success', 'neutral', 'skipped'])
const FAILED_CHECKS = new Set(['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure'])
const PENDING_CHECKS = new Set(['pending', 'queued', 'in_progress', 'requested', 'waiting', 'expected'])
const unique = values => [...new Set(values.filter(Boolean))]
const hash = value => createHash('sha256').update(String(value)).digest('hex')
const clamp = (value, max) => String(value ?? '').trim().slice(0, max)
const parseTime = value => Number.isFinite(value) ? value : (Date.parse(String(value ?? '')) || 0)

function repoOfParts(host, owner, repo) {
  const cleanHost = clamp(host, 200).toLowerCase()
  const cleanOwner = clamp(owner, 120)
  const cleanRepo = clamp(repo, 160).replace(/\.git$/i, '')
  if (!cleanHost || !/^[a-z0-9.-]+$/i.test(cleanHost) || !/^[a-z0-9_.-]+$/i.test(cleanOwner) || !/^[a-z0-9_.-]+$/i.test(cleanRepo)) return null
  return {
    host: cleanHost,
    owner: cleanOwner,
    name: cleanRepo,
    slug: cleanHost === 'github.com' ? `${cleanOwner}/${cleanRepo}` : `${cleanHost}/${cleanOwner}/${cleanRepo}`,
    url: `https://${cleanHost}/${cleanOwner}/${cleanRepo}`,
  }
}

export function githubRepoFromRemote(remote) {
  const value = String(remote ?? '').trim()
  let match = /^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(value)
  if (match) return repoOfParts(match[1], match[2], match[3])
  match = /^(?:[^@]+@)?([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(value)
  if (match) return repoOfParts(match[1], match[2], match[3])
  match = /^([^/\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(value)
  if (match) return repoOfParts(match[1], match[2], match[3])
  match = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(value)
  if (match) return repoOfParts('github.com', match[1], match[2])
  return null
}

export function integrationsConfig(text) {
  let value
  try { value = JSON.parse(String(text ?? '')) } catch { value = undefined }
  const raw = value?.github !== null && typeof value?.github === 'object' && !Array.isArray(value.github) ? value.github : {}
  const repo = raw.repo === undefined || raw.repo === null || raw.repo === '' ? null : githubRepoFromRemote(raw.repo)
  const limit = Number.isFinite(raw.limit) ? Math.max(1, Math.min(CACHE_MAX_ITEMS, Math.floor(raw.limit))) : DEFAULT_LIMIT
  const refreshSeconds = Number.isFinite(raw.refreshSeconds) ? Math.max(20, Math.min(600, Math.floor(raw.refreshSeconds))) : DEFAULT_REFRESH
  const state = ['open', 'closed', 'merged', 'all'].includes(raw.state) ? raw.state : 'open'
  return {
    github: {
      enabled: raw.enabled !== false,
      repo,
      limit,
      refreshSeconds,
      state,
    },
  }
}

export function checkSummary(rollup) {
  if (rollup === undefined || rollup === null) return { status: 'unknown', total: 0, passed: 0, failed: 0, pending: 0 }
  const checks = Array.isArray(rollup) ? rollup : []
  let passed = 0
  let failed = 0
  let pending = 0
  for (const check of checks) {
    const value = String(check?.conclusion ?? check?.state ?? check?.status ?? '').toLowerCase()
    if (FAILED_CHECKS.has(value)) failed += 1
    else if (PENDING_CHECKS.has(value)) pending += 1
    else if (PASSED_CHECKS.has(value) || !value) passed += 1
  }
  const total = checks.length
  const status = failed > 0 ? 'failed' : pending > 0 ? 'pending' : total > 0 ? 'passed' : 'none'
  return { status, total, passed, failed, pending }
}

const loginOf = value => typeof value?.login === 'string' ? value.login : typeof value === 'string' ? value : ''
const loginsOf = values => unique((Array.isArray(values) ? values : []).flatMap(value => {
  const login = loginOf(value)
  if (login) return [login]
  const name = value?.name ?? value?.slug
  return typeof name === 'string' && name !== '' ? [name] : []
}))
const reviewLoginsOf = requests => unique((Array.isArray(requests) ? requests : []).flatMap((request) => {
  const reviewer = request?.requestedReviewer ?? request
  return [loginOf(reviewer), reviewer?.name, reviewer?.slug].filter(value => typeof value === 'string' && value !== '')
}))

function itemBase(value, type, viewer) {
  const author = loginOf(value?.author) || null
  const assignees = loginsOf(value?.assignees)
  const reviewRequests = reviewLoginsOf(value?.reviewRequests)
  const number = Number(value?.number)
  if (!Number.isInteger(number) || number < 1) return undefined
  const state = type === 'pr' && (value?.mergedAt ?? value?.merged_at) ? 'merged' : String(value?.state ?? '').toLowerCase()
  return {
    type,
    number,
    title: clamp(value?.title, 500) || `#${number}`,
    state: type === 'pr' && state === 'merged' ? 'merged' : state || 'unknown',
    draft: value?.isDraft === true,
    author,
    assignees,
    reviewRequests,
    labels: type === 'issue' ? loginsOf(value?.labels) : [],
    updatedAt: parseTime(value?.updatedAt),
    url: /^https:\/\//i.test(String(value?.url ?? '')) ? String(value.url).slice(0, 1000) : null,
    mine: [author, ...assignees, ...reviewRequests].includes(viewer),
    needsReview: type === 'pr' && viewer !== null && reviewRequests.includes(viewer),
  }
}

export function normalizeWorkItems({ pullRequests = [], issues = [], viewer = null, repo, fetchedAt = Date.now(), source = 'gh' } = {}) {
  const prs = (Array.isArray(pullRequests) ? pullRequests : []).flatMap((value) => {
    const base = itemBase(value, 'pr', viewer)
    if (base === undefined) return []
    return [{
      ...base,
      checks: checkSummary(value?.statusCheckRollup),
      reviewDecision: clamp(value?.reviewDecision, 40).toLowerCase(),
      mergeStateStatus: clamp(value?.mergeStateStatus, 40).toLowerCase(),
      head: clamp(value?.headRefName, 240),
      base: clamp(value?.baseRefName, 240),
    }]
  })
  const openIssues = (Array.isArray(issues) ? issues : []).filter(value => value?.pull_request === undefined).flatMap((value) => {
    const base = itemBase(value, 'issue', viewer)
    return base === undefined ? [] : [base]
  })
  const items = [...prs, ...openIssues]
    .filter((item, index, all) => all.findIndex(other => other.type === item.type && other.number === item.number) === index)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, CACHE_MAX_ITEMS)
  return {
    status: 'ok',
    stale: false,
    error: null,
    source,
    fetchedAt,
    viewer,
    repo: repo ?? null,
    items,
    counts: {
      issues: openIssues.length,
      pullRequests: prs.length,
      mine: items.filter(item => item.mine).length,
      review: items.filter(item => item.needsReview).length,
      attention: items.filter(item => item.checks?.status === 'failed' || item.reviewDecision === 'changes_requested').length,
      open: items.filter(item => item.state === 'open').length,
    },
  }
}

function cleanError(rt, error) {
  const text = [error?.stderr, error?.message, error?.code].filter(Boolean).join(' ')
  return (rt.redactSecrets?.(text) ?? text).replace(/\s+/g, ' ').trim().slice(0, 300)
}

async function command(folder, name, args) {
  try {
    const result = await runFile(name, args, {
      cwd: folder,
      encoding: 'utf8',
      timeout: GH_TIMEOUT,
      maxBuffer: GH_MAX_BUFFER,
      windowsHide: true,
    })
    return { ok: true, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } catch (error) {
    return { ok: false, error }
  }
}

async function gitRemote(folder) {
  const origin = await command(folder, 'git', ['remote', 'get-url', 'origin'])
  if (origin.ok && origin.stdout.trim() !== '') return origin.stdout.trim()
  const all = await command(folder, 'git', ['remote', '-v'])
  if (!all.ok) return ''
  return all.stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/)[1]).find(Boolean) ?? ''
}

async function resolveRepo(folder, config) {
  if (config?.repo) return { repo: config.repo, configured: true }
  return { repo: githubRepoFromRemote(await gitRemote(folder)), configured: false }
}

function ghFailure(rt, error) {
  const text = cleanError(rt, error).toLowerCase()
  if (String(error?.code ?? '') === 'ENOENT') return 'gh-missing'
  if (/auth|login|credential|token/.test(text)) return 'needs-auth'
  if (/not found|could not resolve repository|repository .* unavailable/.test(text)) return 'not-found'
  return 'unavailable'
}

async function viaGh(folder, repo, config, rt) {
  const viewer = await command(folder, 'gh', ['api', 'user', '--jq', '.login'])
  if (!viewer.ok) return { status: ghFailure(rt, viewer.error), error: cleanError(rt, viewer.error) }
  const prState = config.state === 'all' ? 'all' : config.state === 'closed' ? 'closed' : config.state === 'merged' ? 'merged' : 'open'
  const issueState = config.state === 'merged' ? 'closed' : config.state === 'all' ? 'all' : config.state === 'closed' ? 'closed' : 'open'
  const [prs, issues] = await Promise.all([
    command(folder, 'gh', ['pr', 'list', '-R', repo.slug, '--state', prState, '--limit', String(config.limit), '--json', PR_FIELDS]),
    command(folder, 'gh', ['issue', 'list', '-R', repo.slug, '--state', issueState, '--limit', String(config.limit), '--json', ISSUE_FIELDS]),
  ])
  if (!prs.ok) return { status: ghFailure(rt, prs.error), error: cleanError(rt, prs.error) }
  if (!issues.ok) return { status: ghFailure(rt, issues.error), error: cleanError(rt, issues.error) }
  try {
    return normalizeWorkItems({
      pullRequests: JSON.parse(prs.stdout),
      issues: JSON.parse(issues.stdout),
      viewer: viewer.stdout.trim() || null,
      repo,
      fetchedAt: Date.now(),
      source: 'gh',
    })
  } catch (error) {
    return { status: 'unavailable', error: cleanError(rt, error) }
  }
}

async function githubJson(rt, path) {
  const token = rt.secretValue?.('GITHUB_TOKEN')
  if (typeof token !== 'string' || token === '') return { status: 'needs-auth', error: 'GitHub connector is not connected' }
  const api = rt.config.github?.api ?? 'https://api.github.com'
  try {
    const response = await fetch(`${String(api).replace(/\/$/, '')}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ds-bot', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(GH_TIMEOUT),
    })
    if (response.status === 401) return { status: 'needs-auth', error: 'GitHub did not accept this token' }
    if (response.status === 404) return { status: 'not-found', error: 'GitHub repository was not found' }
    if (!response.ok) return { status: 'unavailable', error: `GitHub answered ${response.status}` }
    return { status: 'ok', value: await response.json() }
  } catch (error) {
    return { status: 'unavailable', error: cleanError(rt, error) }
  }
}

async function viaConnector(rt, repo, config) {
  if (repo.host !== 'github.com') return { status: 'gh-missing', error: 'GitHub CLI is needed for this GitHub host' }
  const viewer = await githubJson(rt, '/user')
  if (viewer.status !== 'ok') return viewer
  const pullState = config.state === 'all' ? 'all' : config.state === 'closed' ? 'closed' : 'open'
  const issueState = config.state === 'merged' ? 'closed' : config.state === 'all' ? 'all' : config.state === 'closed' ? 'closed' : 'open'
  const [pullRequests, issues] = await Promise.all([
    githubJson(rt, `/repos/${repo.owner}/${repo.name}/pulls?state=${pullState}&sort=updated&direction=desc&per_page=${config.limit}`),
    githubJson(rt, `/repos/${repo.owner}/${repo.name}/issues?state=${issueState}&sort=updated&direction=desc&per_page=${config.limit}`),
  ])
  if (pullRequests.status !== 'ok') return pullRequests
  if (issues.status !== 'ok') return issues
  return normalizeWorkItems({
    pullRequests: pullRequests.value,
    issues: issues.value.filter(item => item?.pull_request === undefined),
    viewer: viewer.value?.login ?? null,
    repo,
    fetchedAt: Date.now(),
    source: 'connector',
  })
}

function snapshotOf(data) {
  return {
    fetchedAt: data.fetchedAt,
    viewer: data.viewer,
    repo: data.repo,
    items: data.items.map(item => ({
      type: item.type,
      number: item.number,
      title: item.title,
      state: item.state,
      draft: item.draft,
      author: item.author,
      assignees: item.assignees,
      reviewRequests: item.reviewRequests,
      checks: item.checks?.status ?? 'none',
      reviewDecision: item.reviewDecision,
      updatedAt: item.updatedAt,
      url: item.url,
    })),
  }
}

function transitionText(previous, next) {
  const before = previous.items.find(item => item.type === next.type && item.number === next.number)
  const label = next.type === 'pr' ? 'PR' : 'Issue'
  const title = `#${next.number} ${next.title}`.trim()
  if (before === undefined) return next.updatedAt > (previous.fetchedAt ?? 0) ? `Opened ${label.toLowerCase()} ${title}` : ''
  if (before.state !== next.state) return `${label} ${title} is now ${next.state}`
  const checksBefore = before.checks ?? 'unknown'
  const checksAfter = next.checks?.status ?? 'unknown'
  if (next.type === 'pr' && checksBefore !== checksAfter && checksBefore !== 'unknown' && checksAfter !== 'unknown') {
    const checks = checksAfter
    return `PR ${title} checks are ${checks === 'none' ? 'not configured' : checks}`
  }
  if (next.type === 'pr' && before.reviewDecision !== next.reviewDecision) {
    const review = next.reviewDecision || 'not decided'
    return `PR ${title} review is ${review.replaceAll('_', ' ')}`
  }
  if (JSON.stringify(before.assignees) !== JSON.stringify(next.assignees)) return `${label} ${title} assignees changed`
  if (JSON.stringify(before.reviewRequests) !== JSON.stringify(next.reviewRequests)) return `PR ${title} review requests changed`
  if (before.title !== next.title) return `${label} #${next.number} renamed`
  return ''
}

export function workItemTransitions(previous, next) {
  if (previous === undefined || previous === null) return []
  return next.items.flatMap((item) => {
    const summary = transitionText(previous, item)
    if (summary === '') return []
    const evidence = item.url ? [item.url] : []
    return [{
      id: `github:${next.repo?.slug ?? 'repo'}:${item.type}:${item.number}:${hash(summary)}`,
      at: item.updatedAt || next.fetchedAt,
      project: next.project,
      kind: 'change',
      action: 'detected',
      actor: 'GitHub',
      actorId: null,
      contributors: unique([item.author, ...(item.assignees ?? [])]),
      summary,
      reason: '',
      files: [],
      evidence,
      progress: { before: '', after: '' },
      source: `GitHub ${next.repo?.slug ?? ''}`.trim(),
      sourceKind: 'github',
      verification: 'observed',
      sessionId: null,
      roomId: null,
    }]
  }).slice(0, 20)
}

async function snapshotPath(home, folder) {
  const dir = join(home, 'project-records', 'integrations')
  await mkdir(dir, { recursive: true })
  return join(dir, `${hash(resolve(folder))}.json`)
}

async function persistTransition(rt, folder, data) {
  if (rt.readOnly?.() !== undefined) return
  const path = await snapshotPath(rt.home, folder)
  const previous = await readFile(path, 'utf8').then(JSON.parse).catch(() => undefined)
  const next = { version: 1, project: resolve(folder), ...snapshotOf(data) }
  if (previous !== undefined && previous.repo?.slug === next.repo?.slug) {
    const project = resolve(folder)
    for (const entry of workItemTransitions(previous, { ...next, project })) {
      await writeProjectChange(rt.home, entry)
    }
  }
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(next), 'utf8')
  await rename(temp, path)
}

const pending = new Map()
const cached = new Map()

async function readConfig(folder) {
  const text = await readFile(join(folder, CONFIG_FILE), 'utf8').catch(() => '')
  return integrationsConfig(text)
}

async function loadWorkItems(rt, folder, fresh = false) {
  const absolute = resolve(folder)
  const config = await readConfig(absolute)
  const configKey = `${config.github.repo?.slug ?? 'auto'}:${config.github.state}:${config.github.limit}`
  const cache = cached.get(absolute)
  if (!fresh && cache?.key === configKey && Date.now() - cache.at < config.github.refreshSeconds * 1000) return cache.value
  if (pending.has(absolute)) return pending.get(absolute)
  if (rt.config.github === false || config.github.enabled === false) {
    return { status: 'disabled', stale: false, error: null, source: null, fetchedAt: 0, viewer: null, repo: null, items: [], counts: { issues: 0, pullRequests: 0, mine: 0, review: 0, attention: 0, open: 0 }, refreshSeconds: config.github.refreshSeconds }
  }
  const work = (async () => {
    const { repo, configured } = await resolveRepo(absolute, config.github)
    if (repo === null) {
      return { status: 'not-linked', stale: false, error: null, source: null, fetchedAt: 0, viewer: null, repo: null, items: [], counts: { issues: 0, pullRequests: 0, mine: 0, review: 0, attention: 0, open: 0 }, refreshSeconds: config.github.refreshSeconds }
    }
    let data = await viaGh(absolute, repo, config.github, rt)
    if (!data || data.status !== 'ok') {
      const fallback = await viaConnector(rt, repo, config.github)
      if (fallback.status === 'ok') data = fallback
      else if (!data || data.status === 'gh-missing') data = fallback
    }
    if (data.status !== 'ok') {
      const old = cached.get(absolute)
      if (old?.key === configKey && old.value?.items?.length > 0) return { ...old.value, stale: true, error: data.error ?? data.status, refreshSeconds: config.github.refreshSeconds }
      return { status: data.status, stale: false, error: data.error ?? null, source: null, fetchedAt: Date.now(), viewer: null, repo, configured, items: [], counts: { issues: 0, pullRequests: 0, mine: 0, review: 0, attention: 0, open: 0 }, refreshSeconds: config.github.refreshSeconds }
    }
    const value = { ...data, configured, refreshSeconds: config.github.refreshSeconds }
    await persistTransition(rt, absolute, value).catch(error => rt.warn?.('ds-bot: GitHub work item history was not saved: %s', error?.message ?? error))
    cached.set(absolute, { at: Date.now(), key: configKey, value })
    return value
  })().finally(() => pending.delete(absolute))
  pending.set(absolute, work)
  return work
}

export function install(rt) {
  Object.assign(rt, {
    projectWorkItems: (folder, { fresh = false } = {}) => folder ? loadWorkItems(rt, folder, fresh) : Promise.resolve(undefined),
  })
}
