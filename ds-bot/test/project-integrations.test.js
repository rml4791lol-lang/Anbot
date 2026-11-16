import test from 'node:test'
import assert from 'node:assert/strict'
import { checkSummary, githubRepoFromRemote, integrationsConfig, normalizeWorkItems, workItemTransitions } from '../src/host/project-integrations.js'

test('GitHub remotes and integration config normalize to one repository identity', () => {
  assert.deepEqual(githubRepoFromRemote('git@github.com:Fei2411/DS-Bot.git'), {
    host: 'github.com', owner: 'Fei2411', name: 'DS-Bot', slug: 'Fei2411/DS-Bot', url: 'https://github.com/Fei2411/DS-Bot',
  })
  assert.equal(githubRepoFromRemote('https://github.com/Fei2411/DS-Bot.git').slug, 'Fei2411/DS-Bot')
  assert.equal(githubRepoFromRemote('github.example.com/team/project').slug, 'github.example.com/team/project')
  const config = integrationsConfig(JSON.stringify({ github: { repo: 'Fei2411/DS-Bot', refreshSeconds: 5, limit: 500, state: 'all' } }))
  assert.equal(config.github.repo.slug, 'Fei2411/DS-Bot')
  assert.equal(config.github.refreshSeconds, 20)
  assert.equal(config.github.limit, 80)
  assert.equal(config.github.state, 'all')
})

test('check summaries distinguish failures, pending work, success and unavailable checks', () => {
  assert.deepEqual(checkSummary([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }]), {
    status: 'failed', total: 4, passed: 2, failed: 1, pending: 1,
  })
  assert.equal(checkSummary([]).status, 'none')
  assert.equal(checkSummary(undefined).status, 'unknown')
})

test('work items keep PR checks, review ownership, issue assignment and my-work filters', () => {
  const data = normalizeWorkItems({
    viewer: 'alice',
    repo: githubRepoFromRemote('Fei2411/DS-Bot'),
    fetchedAt: 100,
    pullRequests: [{
      number: 12, title: 'Keep the checks visible', state: 'OPEN', isDraft: false,
      author: { login: 'bob' }, assignees: [], reviewRequests: [{ login: 'alice' }],
      reviewDecision: 'REVIEW_REQUIRED', updatedAt: '2026-11-16T10:00:00Z', url: 'https://github.com/Fei2411/DS-Bot/pull/12',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }],
    }],
    issues: [{ number: 13, title: 'Record project changes', state: 'OPEN', author: { login: 'bob' }, assignees: [{ login: 'alice' }], labels: [{ name: 'feature' }], updatedAt: '2026-11-16T09:00:00Z', url: 'https://github.com/Fei2411/DS-Bot/issues/13' }],
  })
  assert.equal(data.items.length, 2)
  assert.equal(data.counts.review, 1)
  assert.equal(data.counts.mine, 2)
  assert.equal(data.counts.attention, 1)
  assert.equal(data.items.find(item => item.type === 'pr').checks.failed, 1)
  assert.equal(data.items.find(item => item.type === 'issue').labels[0], 'feature')
})

test('GitHub state transitions become project history entries', () => {
  const repo = githubRepoFromRemote('Fei2411/DS-Bot')
  const previous = {
    repo,
    items: [{ type: 'pr', number: 12, title: 'Record project changes', state: 'open', checks: 'passed', reviewDecision: 'review_required', assignees: [], reviewRequests: [] }],
  }
  const next = {
    repo, fetchedAt: 200, project: '/tmp/project',
    items: [{ type: 'pr', number: 12, title: 'Record project changes', state: 'merged', updatedAt: 150, url: 'https://github.com/Fei2411/DS-Bot/pull/12', checks: { status: 'failed' }, reviewDecision: 'approved', assignees: [], reviewRequests: [] }],
  }
  const rows = workItemTransitions(previous, next)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sourceKind, 'github')
  assert.match(rows[0].summary, /is now merged/)
  assert.equal(rows[0].evidence[0], next.items[0].url)
})

test('newly visible older items and unknown check data do not create false history', () => {
  const repo = githubRepoFromRemote('Fei2411/DS-Bot')
  const previous = {
    repo,
    fetchedAt: 1_000,
    items: [{ type: 'pr', number: 12, title: 'Known PR', state: 'open', checks: 'unknown', reviewDecision: '', assignees: [], reviewRequests: [] }],
  }
  const next = {
    repo, fetchedAt: 2_000, project: '/tmp/project',
    items: [
      { type: 'pr', number: 12, title: 'Known PR', state: 'open', updatedAt: 1_500, url: 'https://example.com/12', checks: { status: 'none' }, reviewDecision: '', assignees: [], reviewRequests: [] },
      { type: 'issue', number: 2, title: 'Older item entering this page', state: 'open', updatedAt: 900, url: 'https://example.com/2' },
    ],
  }
  assert.deepEqual(workItemTransitions(previous, next), [])
})
