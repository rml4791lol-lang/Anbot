import test from 'node:test'
import assert from 'node:assert/strict'
import { agentBoardModel, overviewModel, projectModel, workDetail } from '../src/client/team-overview-model.js'

const bot = (id, name, patch = {}) => ({ id, name, sessionId: id, ...patch })

function rosterFixture() {
  const bots = [
    bot('main', 'Main'),
    bot('research', 'Research', { sectionId: 'lab', lastAt: 30, preview: 'Found the first source' }),
    bot('builder', 'Builder', { sectionId: 'ship' }),
    bot('reviewer', 'Reviewer', { sectionId: 'ship', lastAt: 20, preview: 'Ready for review' }),
    bot('waiter', 'Waiter', { sectionId: 'lab' }),
  ]
  const rooms = [{ id: 'room', name: 'Launch', sessionId: 'room', members: ['builder', 'reviewer'], sectionId: 'ship', lastAt: 10, preview: 'Builder: shipped it', workDir: '/work/ship', goal: { title: 'Ship v1', status: 'active', current: 1, stages: [{ id: 's1', title: 'Build', status: 'passed' }, { id: 's2', title: 'Review', status: 'working' }], events: [{ at: 15, kind: 'pass', stage: 's1', text: 'Build evidence recorded' }, { at: 14, kind: 'rework', stage: 's1', text: 'Missing release note' }] } }]
  return {
    bots,
    rooms,
    sections: [{ id: 'lab', name: 'Research' }, { id: 'ship', name: 'Delivery' }],
    byId: Object.fromEntries([...bots, ...rooms].map(item => [item.id, item])),
    roomsById: { room: rooms[0] },
    questions: { reviewer: { id: 'q1', question: 'Ship it?', askedAt: 100 } },
    learning: { research: [{ id: 'p1', name: 'Source checks' }] },
    learningSettled: { research: [{ id: 'p2', outcome: 'approved' }, { id: 'p3', outcome: 'declined' }] },
    agents: [{ id: 'dsh', name: 'DSH Agent', sessions: ['dsh-session'] }],
  }
}

test('overviewModel projects live work, approvals, questions and sections', () => {
  const roster = rosterFixture()
  const model = overviewModel(roster, {
    bots: {
      research: { tool: 'web_search', target: 'docs.example', since: 10 },
      builder: { switching: true, since: 12 },
    },
    rooms: { room: [{ botId: 'reviewer', tool: 'shell', since: 13 }] },
    approvals: [{ id: 'a1', botId: 'main', tool: 'shell', reason: 'Run tests', at: 50 }],
    waiting: { waiter: { bots: ['reviewer'], rooms: ['room'], for: ['main'], waits: [] } },
  }, new Map([['room', { completionUnread: true }]]))

  assert.equal(model.counts.bots, 5)
  assert.equal(model.counts.running, 3)
  assert.equal(model.counts.approvals, 1)
  assert.equal(model.counts.questions, 1)
  assert.equal(model.counts.waiting, 1)
  assert.equal(model.counts.unread, 1)
  assert.deepEqual(model.counts.pulse, { working: 3, needs: 2, waiting: 1, unread: 0, idle: 0, total: 6 })
  assert.deepEqual(model.activities.map(entry => entry.key), ['bot:research', 'bot:builder', 'room:room:reviewer'])
  assert.equal(model.botRows.get('reviewer').state, 'alert')
  assert.equal(model.botRows.get('research').state, 'searching')
  assert.equal(model.botRows.get('builder').state, 'thinking')
  assert.deepEqual(model.sections.map(section => section.name), [null, 'Research', 'Delivery'])
  assert.deepEqual(model.sections[1].entries.map(entry => entry.id), ['research', 'waiter'])
  assert.equal(model.recent[0].name, 'Research')
})

test('overviewModel survives an empty team and missing work', () => {
  const model = overviewModel({ bots: [], rooms: [], sections: [], byId: {}, roomsById: {}, questions: {}, learning: {} })
  assert.deepEqual(model.activities, [])
  assert.deepEqual(model.sections, [])
  assert.deepEqual(model.recent, [])
  assert.equal(model.counts.bots, 0)
})

test('workDetail prefers what the Bot is working on', () => {
  assert.equal(workDetail({ said: 'Checking the page', tool: 'web_fetch' }), 'Checking the page')
  assert.equal(workDetail({ switching: true, folder: true }), 'Moving this chat to its new folder')
  assert.equal(workDetail(undefined), '')
})


test('projectModel turns sections into live project cards with memory and standards evidence', () => {
  const roster = rosterFixture()
  const base = overviewModel(roster, {
    bots: { research: { tool: 'web_search', since: 10 } },
    rooms: { room: [{ botId: 'reviewer', tool: 'test', since: 13 }] },
  }, new Map([['room', { running: true }]]))
  const insights = {
    memory: {
      total: 7,
      owners: {
        research: { count: 3, size: 100, limit: 8000, topics: ['Sources'], recent: [{ text: 'Prefer primary sources', added: '2026-11-16' }] },
        room: { count: 2, size: 80, limit: 12000, topics: ['Release'], recent: [{ text: 'Release on Friday', added: '2026-11-15' }] },
      },
      team: { count: 2 },
    },
    folders: {
      '/work/ship': {
        folder: '/work/ship', name: 'ship', standards: { file: 'AGENTS.md', rules: 4, sources: ['https://example.com/spec'], updatedAt: 20 },
        checks: [{ name: 'test', command: 'node --test' }], quality: { expected: 2, passed: 2, total: 2, checks: [] }, packageUpdatedAt: 10,
        profile: { id: 'miniprogram', name: 'WeChat mini program', declared: true, sources: [{ name: 'Design guide', url: 'https://example.com/spec', scope: ['UI'], checkedAt: '2026-11-16' }], required: [{ path: 'app.json', exists: true }, { path: 'app.wxss', exists: false }], requiredChecks: ['privacy'] },
        adoptedFiles: [{ path: 'AGENTS.md', role: 'rules', exists: true, findings: { rules: 4 } }, { path: 'app.json', role: 'project', exists: true }, { path: 'app.wxss', role: 'required', exists: false }],
        documents: [{ path: 'README.md', headings: ['Product guide'], excerpt: 'A mini program', updatedAt: 30 }],
        changes: {
          git: { available: true, working: 1 },
          entries: [{
            id: 'bot:call-1', at: 40, project: '/work/ship', kind: 'progress', action: 'recorded',
            actor: 'Builder', actorId: 'builder', contributors: [], summary: 'Checkout flow works',
            reason: 'Finish the conversion path', files: ['pages/checkout.js'], evidence: ['npm test'],
            progress: { before: 'Form only', after: 'Checkout works' }, source: 'Builder', sourceKind: 'bot',
            verification: 'reported',
          }],
        },
        workItems: {
          status: 'ok', stale: false, error: null, source: 'gh', fetchedAt: 50, refreshSeconds: 60, viewer: 'Builder',
          repo: { host: 'github.com', owner: 'acme', name: 'ship', slug: 'acme/ship', url: 'https://github.com/acme/ship' },
          items: [{ type: 'pr', number: 42, title: 'Ship checkout', state: 'open', draft: false, author: 'Builder', assignees: [], reviewRequests: [], labels: [], updatedAt: 45, url: 'https://github.com/acme/ship/pull/42', mine: true, needsReview: false, checks: { status: 'passed', total: 2, passed: 2, failed: 0, pending: 0 }, reviewDecision: '' }],
          counts: { issues: 0, pullRequests: 1, mine: 1, review: 0, attention: 0, open: 1 },
        },
      },
    },
  }
  const model = projectModel(base, insights)
  assert.equal(model.projects.length, 3)
  const ship = model.projects.find(project => project.id === 'ship')
  assert.equal(ship.goal.title, 'Ship v1')
  assert.equal(ship.goal.passed, 1)
  assert.equal(ship.goal.total, 2)
  assert.equal(ship.standards.rules, 4)
  assert.equal(ship.standards.covered, 4)
  assert.equal(ship.standards.quality.passed, 2)
  assert.equal(ship.standards.profile.id, 'miniprogram')
  assert.equal(ship.standards.sourceDetails[0].name, 'Design guide')
  assert.equal(ship.standards.adoptedFiles.length, 3)
  assert.equal(ship.standards.missingFiles.length, 1)
  assert.equal(model.standardsLibrary.find(profile => profile.id === 'miniprogram').projects, 1)
  assert.equal(ship.completion.status, 'standards')
  assert.equal(ship.completion.requirements.missing, 1)
  assert.equal(ship.completion.requirements.checksMissing, 1)
  assert.equal(ship.completion.checks.passed, 2)
  assert.equal(ship.completion.evidence.covered, 4)
  assert.equal(ship.experience.knowledge.find(item => item.kind === 'verified').count, 2)
  assert.ok(ship.experience.events.some(event => event.kind === 'memory'))
  assert.ok(ship.experience.events.some(event => event.kind === 'rules'))
  assert.ok(ship.experience.events.some(event => event.kind === 'goal' && event.action === 'pass' && event.evidence === 'Build evidence recorded'))
  assert.ok(ship.experience.events.some(event => event.kind === 'goal' && event.action === 'rework' && event.reason === 'Missing release note'))
  assert.equal(ship.changes.count, 1)
  assert.equal(ship.changes.git, true)
  assert.equal(ship.workItems.status, 'ok')
  assert.equal(ship.workItems.counts.pullRequests, 1)
  assert.equal(ship.workItems.items[0].repo.slug, 'acme/ship')
  assert.equal(model.counts.work, 1)
  assert.ok(ship.experience.events.some(event => event.kind === 'progress' && event.files[0] === 'pages/checkout.js' && event.after === 'Checkout works'))
  assert.equal(ship.memory.count, 2)
  assert.equal(ship.state.running, 1)
  assert.equal(model.counts.standards, 1)
})

test('agentBoardModel shows live health, learning outcomes and standards evidence', () => {
  const roster = rosterFixture()
  const base = overviewModel(roster, {}, new Map([['dsh-session', { running: true }]]))
  const insights = {
    memory: { owners: { research: { count: 2, size: 40, limit: 8000, topics: ['Sources'], recent: [] } } },
    folders: {},
  }
  const model = agentBoardModel(base, insights)
  const research = model.rows.find(row => row.id === 'research')
  assert.equal(research.learning.pending, 1)
  assert.equal(research.learning.approved, 1)
  assert.equal(research.learning.declined, 1)
  assert.equal(research.memory.count, 2)
  assert.equal(model.rows.find(row => row.id === 'dsh').health, 'working')
})
