const EMPTY_WORK = { bots: {}, rooms: {}, approvals: [], waiting: {} }

const toolState = name => (/^(message_bot|stop_bot|create_bot|update_bot|create_group|update_group|delete_group|post_to_group)$/.test(name ?? '') ? 'sending'
  : /search|fetch|browse|read|grep|glob|list|recall/i.test(name ?? '') ? 'searching' : 'working')

const sessionState = (map, id) => (map?.get?.(id) ?? map?.[id] ?? {})
const nameOf = (roster, id) => roster.byId?.[id]?.name ?? roster.roomsById?.[id]?.name ?? id
const questionOwner = (roster, sessionId) => roster.byId?.[sessionId] ?? roster.roomsById?.[sessionId]

// A read-only projection of the live team. It uses only fields DS Bot already
// publishes: roster sections and tails, work from the turn engine, approvals,
// question cards and per-Session status. It never invents a task record.
export function overviewModel(roster, work = EMPTY_WORK, sessionStatus = new Map()) {
  const source = { ...EMPTY_WORK, ...work, approvals: work?.approvals ?? [], waiting: work?.waiting ?? {}, bots: work?.bots ?? {}, rooms: work?.rooms ?? {} }
  const approvalsByBot = new Map()
  const approvalsByRoom = new Map()
  for (const approval of source.approvals) {
    const map = approval.roomId === undefined ? approvalsByBot : approvalsByRoom
    const id = approval.roomId ?? approval.botId
    map.set(id, [...(map.get(id) ?? []), approval])
  }

  const questions = Object.entries(roster.questions ?? {}).flatMap(([sessionId, question]) => {
    const owner = questionOwner(roster, sessionId)
    if (owner === undefined || question === undefined) return []
    return [{ sessionId, owner, question, at: question.askedAt ?? 0 }]
  })
  const questionsByOwner = new Map()
  for (const entry of questions) questionsByOwner.set(entry.owner.id, [...(questionsByOwner.get(entry.owner.id) ?? []), entry])

  const bots = (roster.bots ?? []).map(bot => {
    const doing = source.bots[bot.id]
    const waits = source.waiting[bot.id]
    const approvals = approvalsByBot.get(bot.id) ?? []
    const ownersQuestions = questionsByOwner.get(bot.id) ?? []
    const waitsOn = [...(waits?.bots ?? []), ...(waits?.rooms ?? [])]
    const running = doing !== undefined
    const alert = approvals.length > 0 || ownersQuestions.length > 0
    const activity = doing?.switching ? 'thinking' : doing ? toolState(doing.tool ?? '') : waitsOn.length > 0 ? 'waiting' : undefined
    const status = sessionState(sessionStatus, bot.sessionId ?? bot.id)
    return {
      bot,
      doing,
      approvals,
      questions: ownersQuestions,
      alert,
      running,
      waits: waits ?? null,
      waitsOn: waitsOn.map(id => nameOf(roster, id)),
      unread: status.completionUnread === true || status.pendingInteraction !== undefined,
      pendingInteraction: status.pendingInteraction,
      state: alert ? 'alert' : running ? activity : waitsOn.length > 0 ? 'waiting' : 'idle',
    }
  })
  const botRows = new Map(bots.map(row => [row.bot.id, row]))

  const activities = [
    ...Object.entries(source.bots).flatMap(([botId, doing]) => {
      const row = botRows.get(botId)
      return row ? [{ key: `bot:${botId}`, kind: 'bot', row, bot: row.bot, doing, since: doing.since, room: roster.roomsById?.[doing.roomId] }] : []
    }),
    ...Object.entries(source.rooms).flatMap(([roomId, members]) => {
      const room = roster.roomsById?.[roomId]
      if (room === undefined) return []
      return members.flatMap(member => {
        const row = botRows.get(member.botId)
        return row ? [{ key: `room:${roomId}:${member.botId}`, kind: 'room', row, bot: row.bot, room, doing: member, since: member.since }] : []
      })
    }),
  ].sort((a, b) => (a.since ?? 0) - (b.since ?? 0))

  const rooms = (roster.rooms ?? []).map(room => {
    const members = source.rooms[room.id] ?? []
    const approvals = approvalsByRoom.get(room.id) ?? []
    const status = sessionState(sessionStatus, room.sessionId ?? room.id)
    return {
      room,
      members,
      approvals,
      running: members.length > 0,
      unread: status.completionUnread === true || status.pendingInteraction !== undefined,
      lastAt: room.lastAt ?? 0,
      preview: room.preview ?? '',
    }
  })
  const roomRows = new Map(rooms.map(row => [row.room.id, row]))

  const entries = [
    ...bots.map(row => ({ kind: 'bot', id: row.bot.id, sectionId: row.bot.sectionId, row })),
    ...rooms.map(row => ({ kind: 'room', id: row.room.id, sectionId: row.room.sectionId, row })),
  ]
  const sectionIds = new Set((roster.sections ?? []).map(section => section.id))
  const ungrouped = entries.filter(entry => entry.sectionId === undefined || !sectionIds.has(entry.sectionId))
  const sections = [
    ...(ungrouped.length > 0 ? [{ id: '__ungrouped__', name: null, entries: ungrouped }] : []),
    ...(roster.sections ?? []).map(section => ({ ...section, entries: entries.filter(entry => entry.sectionId === section.id) })).filter(section => section.entries.length > 0),
  ]

  const recent = [
    ...bots.filter(row => row.bot.lastAt).map(row => ({ key: `bot:${row.bot.id}`, kind: 'bot', id: row.bot.id, at: row.bot.lastAt, preview: row.bot.preview ?? '', name: row.bot.name, row })),
    ...rooms.filter(row => row.lastAt).map(row => ({ key: `room:${row.room.id}`, kind: 'room', id: row.room.id, at: row.lastAt, preview: row.preview, name: row.room.name, row })),
  ].sort((a, b) => b.at - a.at)

  const approvals = [...source.approvals].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  const primaryState = row => row.alert || row.approvals?.length > 0 ? 'needs'
    : row.running ? 'working'
      : row.waitsOn?.length > 0 ? 'waiting'
        : row.unread ? 'unread' : 'idle'
  const pulse = { working: 0, needs: 0, waiting: 0, unread: 0, idle: 0 }
  for (const row of bots) pulse[primaryState(row)] += 1
  for (const row of rooms) pulse[primaryState(row)] += 1
  return {
    roster,
    sessionStatus,
    learning: roster.learning ?? {},
    bots,
    botRows,
    rooms,
    roomRows,
    sections,
    activities,
    recent,
    approvals,
    questions: questions.sort((a, b) => b.at - a.at),
    counts: {
      bots: bots.length,
      running: new Set(activities.map(entry => entry.bot.id)).size,
      waiting: bots.filter(row => row.waitsOn.length > 0 && !row.running && !row.alert).length,
      approvals: approvals.length,
      questions: questions.length,
      unread: bots.filter(row => row.unread).length + rooms.filter(row => row.unread).length,
      groups: rooms.length,
      pulse: { ...pulse, total: bots.length + rooms.length },
    },
  }
}

export function workDetail(doing) {
  if (!doing) return ''
  if (doing.switching) return doing.folder ? 'Moving this chat to its new folder' : 'Moving to a fresh Session'
  return doing.said ?? doing.note ?? doing.target ?? doing.tool ?? ''
}

const RUNNING_GOAL = new Set(['active', 'paused'])
const uniqueValues = values => [...new Set(values.filter(Boolean))]
const memoryOf = (insights, id) => insights?.memory?.owners?.[id]
const folderOf = (insights, path) => (typeof path === 'string' ? insights?.folders?.[path] : undefined)
const memoryPairs = (insights, ids) => ids.map(id => [id, memoryOf(insights, id)]).filter(([, memory]) => memory !== undefined)

function projectGoal(rooms) {
  const goals = rooms.flatMap(({ room }) => (room.goal === undefined ? [] : [{ room, goal: room.goal }]))
  const primary = goals.find(({ goal }) => RUNNING_GOAL.has(goal.status))
    ?? goals.find(({ goal }) => goal.status === 'complete')
    ?? goals[0]
  const total = goals.reduce((sum, { goal }) => sum + (goal.stages?.length ?? 0), 0)
  const passed = goals.reduce((sum, { goal }) => sum + (goal.stages ?? []).filter(stage => stage.status === 'passed').length, 0)
  const stage = primary?.goal.stages?.[primary.goal.current]
  return {
    count: goals.length,
    title: primary?.goal.title ?? '',
    status: primary?.goal.status ?? null,
    current: RUNNING_GOAL.has(primary?.goal.status) ? stage?.title ?? '' : '',
    passed,
    total,
    room: primary?.room ?? null,
    stages: (primary?.goal.stages ?? []).map((entry, index) => ({
      title: entry.title,
      status: entry.status,
      current: index === primary?.goal.current && RUNNING_GOAL.has(primary?.goal.status),
    })),
  }
}

function projectStandards(insights, folders) {
  const facts = uniqueValues(folders).map(path => folderOf(insights, path)).filter(Boolean)
  const requiredFiles = facts.flatMap(fact => (fact.profile?.required ?? []).map(file => ({ ...file, folder: fact.folder })))
  const configuredChecks = facts.flatMap(fact => fact.checks.map(check => ({ ...check, folder: fact.folder, required: false })))
  const requiredChecks = uniqueValues(facts.flatMap(fact => fact.profile?.requiredChecks ?? []))
  const checks = [
    ...configuredChecks,
    ...requiredChecks.filter(name => !configuredChecks.some(check => check.name === name)).map(name => ({ name, command: '', folder: facts[0]?.folder, required: true })),
  ]
  const sourceUrls = uniqueValues(facts.flatMap(fact => fact.standards.sources ?? []))
  const sourceDetails = [
    ...facts.flatMap(fact => (fact.profile?.sources ?? []).map(source => ({ ...source, folder: fact.folder }))),
    ...sourceUrls.map(url => ({ name: url, url, scope: ['.ds-bot/rules'], version: null, checkedAt: null, folder: facts[0]?.folder })),
  ].filter((source, index, all) => (source.url || source.name)
    && all.findIndex(entry => (entry.url || entry.name) === (source.url || source.name)) === index)
  const rules = facts.reduce((sum, fact) => sum + (fact.standards.rules ?? 0), 0)
  const quality = facts.map(fact => fact.quality).find(Boolean) ?? null
  const profiles = uniqueValues(facts.map(fact => fact.profile?.id))
  const profileFacts = profiles.map(id => facts.find(fact => fact.profile?.id === id)?.profile).filter(Boolean)
  const profile = profiles.length === 0 ? { id: 'generic', name: 'Generic', declared: false, sources: [] }
    : profiles.length === 1 ? profileFacts[0]
      : { id: 'mixed', name: 'Mixed', declared: profileFacts.some(entry => entry.declared), sources: [] }
  const adoptedFiles = []
  const seenFiles = new Set()
  for (const fact of facts) {
    for (const file of fact.adoptedFiles ?? []) {
      const key = `${fact.folder}:${file.path}:${file.role}`
      if (seenFiles.has(key)) continue
      seenFiles.add(key)
      adoptedFiles.push({ ...file, folder: fact.folder })
    }
  }
  const documents = facts.flatMap(fact => (fact.documents ?? []).map(doc => ({ ...doc, folder: fact.folder })))
  const evidence = [
    facts.length > 0,
    rules > 0,
    sourceDetails.length > 0,
    checks.length > 0,
  ]
  return {
    folders: facts,
    profile,
    adoptedFiles,
    documents,
    requiredFiles,
    missingFiles: adoptedFiles.filter(file => !file.exists),
    rules,
    sources: sourceUrls,
    sourceDetails,
    checks,
    quality,
    evidence,
    covered: evidence.filter(Boolean).length,
    updatedAt: Math.max(0, ...facts.flatMap(fact => [
      fact.standards.updatedAt ?? 0,
      fact.packageUpdatedAt ?? 0,
      ...(fact.documents ?? []).map(doc => doc.updatedAt ?? 0),
    ])),
  }
}

function projectChanges(insights, folders) {
  const facts = uniqueValues(folders).map(path => folderOf(insights, path)).filter(Boolean)
  const entries = facts.flatMap(fact => fact.changes?.entries ?? [])
    .filter((entry, index, all) => all.findIndex(other => other.id === entry.id) === index)
    .sort((a, b) => b.at - a.at)
  return {
    entries,
    count: entries.length,
    updatedAt: entries[0]?.at ?? 0,
    git: facts.some(fact => fact.changes?.git?.available === true),
    working: facts.reduce((sum, fact) => sum + (fact.changes?.git?.working ?? 0), 0),
    recorded: entries.filter(entry => entry.sourceKind === 'bot').length,
    automatic: entries.filter(entry => entry.sourceKind === 'automatic' || entry.sourceKind === 'filesystem').length,
  }
}

function projectWorkItems(insights, folders) {
  const facts = uniqueValues(folders).map(path => folderOf(insights, path)?.workItems).filter(Boolean)
  const items = facts.flatMap(fact => (fact.items ?? []).map(item => ({ ...item, repo: fact.repo })))
    .filter((item, index, all) => all.findIndex(other => other.type === item.type && other.number === item.number && other.repo?.slug === item.repo?.slug) === index)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const usable = facts.filter(fact => fact.status === 'ok' || (fact.items?.length ?? 0) > 0)
  const status = usable.length > 0
    ? (usable.every(fact => fact.stale === true) ? 'stale' : 'ok')
    : ['needs-auth', 'gh-missing', 'not-found', 'unavailable', 'disabled', 'not-linked'].find(candidate => facts.some(fact => fact.status === candidate)) ?? 'not-linked'
  const repos = []
  const seenRepos = new Set()
  for (const fact of usable) {
    if (!fact.repo?.slug || seenRepos.has(fact.repo.slug)) continue
    seenRepos.add(fact.repo.slug)
    repos.push(fact.repo)
  }
  return {
    status,
    stale: usable.some(fact => fact.stale === true),
    error: facts.find(fact => fact.error)?.error ?? null,
    source: usable.find(fact => fact.source)?.source ?? null,
    fetchedAt: Math.max(0, ...usable.map(fact => fact.fetchedAt ?? 0)),
    refreshSeconds: Math.min(600, 60, ...facts.map(fact => fact.refreshSeconds).filter(Number.isFinite)),
    viewer: usable.find(fact => fact.viewer)?.viewer ?? null,
    repos,
    repo: repos.length === 1 ? repos[0] : null,
    items,
    counts: {
      issues: items.filter(item => item.type === 'issue').length,
      pullRequests: items.filter(item => item.type === 'pr').length,
      mine: items.filter(item => item.mine).length,
      review: items.filter(item => item.needsReview).length,
      attention: items.filter(item => item.checks?.status === 'failed' || item.reviewDecision === 'changes_requested').length,
      open: items.filter(item => item.state === 'open').length,
    },
  }
}

function standardsLibrary(projects) {
  const byProfile = new Map()
  for (const project of projects) {
    const profile = project.standards.profile
    const id = profile?.id ?? 'generic'
    const entry = byProfile.get(id) ?? {
      id,
      name: profile?.name && profile.name !== id ? profile.name : id,
      projects: 0,
      files: 0,
      sources: 0,
      rules: 0,
      skills: 0,
      updatedAt: 0,
    }
    entry.projects += 1
    entry.files += project.standards.adoptedFiles.filter(file => file.exists).length
    entry.sources += project.standards.sourceDetails.length
    entry.rules += project.standards.rules
    entry.skills += project.learning.approved
    entry.updatedAt = Math.max(entry.updatedAt, project.standards.updatedAt)
    byProfile.set(id, entry)
  }
  return [...byProfile.values()]
    .filter(entry => entry.files > 0 || entry.sources > 0 || entry.rules > 0 || entry.skills > 0)
    .sort((a, b) => b.projects - a.projects || b.updatedAt - a.updatedAt)
}

function projectState(bots, rooms) {
  const needs = bots.filter(row => row.alert).length + rooms.reduce((sum, room) => sum + room.approvals.length, 0)
  const running = bots.filter(row => row.running).length + rooms.filter(room => room.running).length
  const waiting = bots.filter(row => row.state === 'waiting').length
  const unread = bots.filter(row => row.unread).length + rooms.filter(room => room.unread).length
  const state = needs > 0 ? 'needs' : running > 0 ? 'working' : waiting > 0 ? 'waiting' : unread > 0 ? 'unread' : 'idle'
  return { needs, running, waiting, unread, state }
}

const timestampOf = value => Number.isFinite(value) ? value : (Date.parse(String(value ?? '')) || 0)

function projectLearning(roster, bots) {
  const settled = bots.flatMap(({ bot }) => (roster.learningSettled?.[bot.id] ?? []).map(entry => ({ ...entry, botId: bot.id, bot })))
  const pending = bots.flatMap(({ bot }) => (roster.learning?.[bot.id] ?? []).map(entry => ({ ...entry, botId: bot.id, bot })))
  return {
    pending: pending.length,
    approved: settled.filter(entry => entry.outcome === 'approved').length,
    declined: settled.filter(entry => entry.outcome === 'declined').length,
    settled,
  }
}

function projectCompletion(goal, standards, state, learning) {
  const quality = standards.quality
  const required = standards.requiredFiles ?? []
  const present = required.filter(file => file.exists).length
  const missing = required.length - present
  const recorded = new Map((quality?.checks ?? []).map(check => [check.name, check.status]))
  const checkRows = standards.checks.map(check => ({ name: check.name, status: recorded.get(check.name) ?? 'unverified', required: check.required === true }))
  const extra = (quality?.checks ?? []).filter(check => !standards.checks.some(configured => configured.name === check.name))
  checkRows.push(...extra.map(check => ({ name: check.name, status: check.status, required: false })))
  const requiredRows = checkRows.filter(check => check.required)
  const missingCheckRecords = requiredRows.filter(check => check.status === 'unverified' || check.status === 'unknown').length
  const expected = quality?.expected ?? quality?.total ?? 0
  const passed = quality?.passed ?? 0
  const failed = Math.max(0, expected - passed)
  const status = missing > 0 || missingCheckRecords > 0 ? 'standards'
    : goal.status === 'complete' ? 'complete'
      : expected > 0 && passed >= expected ? 'verified'
        : state.needs > 0 ? 'attention'
          : expected > 0 && failed > 0 ? 'failing'
            : state.working > 0 ? 'working'
              : goal.status === 'paused' ? 'paused'
                : goal.total > 0 ? 'planned' : 'unplanned'
  return {
    status,
    goal: { passed: goal.passed, total: goal.total, current: goal.current, title: goal.title },
    checks: { expected, passed, failed, rows: checkRows },
    evidence: { covered: standards.covered, total: 4 },
    learning: { approved: learning.approved, pending: learning.pending },
    requirements: { present, total: required.length, missing, checksExpected: requiredRows.length, checksRecorded: requiredRows.length - missingCheckRecords, checksMissing: missingCheckRecords },
  }
}

function projectExperience(projectBots, projectRooms, memory, standards, learning, changes) {
  const goalEvents = projectRooms.flatMap(({ room }) => [room.goal, ...(room.pastGoals ?? [])].filter(Boolean).flatMap(goal => {
    const stages = new Map((goal.stages ?? []).map(stage => [stage.id, stage.title]))
    return (goal.events ?? []).map(event => ({
      kind: 'goal', action: event.kind, at: event.at, ownerId: room.id,
      title: stages.get(event.stage) || goal.title || room.name,
      reason: ['rework', 'revise', 'stop'].includes(event.kind) ? event.text || '' : '',
      evidence: event.kind === 'pass' ? event.text || '' : '',
      source: 'Goal',
      text: event.text || '',
    }))
  }))
  const events = [
    ...changes.entries.map(entry => ({
      kind: entry.kind,
      action: entry.action,
      at: entry.at,
      ownerId: entry.actorId,
      title: entry.summary,
      reason: entry.reason,
      evidence: (entry.evidence ?? []).join(' · '),
      source: entry.source,
      sourceKind: entry.sourceKind,
      verification: entry.verification,
      files: entry.files ?? [],
      before: entry.progress?.before ?? '',
      after: entry.progress?.after ?? '',
      contributors: entry.contributors ?? [],
      text: '',
    })),
    ...goalEvents,
    ...memory.recent.map(entry => ({
      kind: 'memory', action: 'memory', at: timestampOf(entry.added), ownerId: entry.ownerId,
      title: entry.topic || '', text: entry.text, reason: entry.text,
      source: entry.topic ? `${'Memory'} · ${entry.topic}` : 'Memory', evidence: '',
    })),
    ...learning.settled.filter(entry => entry.outcome === 'approved').map(entry => ({
      kind: entry.kind === 'agents' ? 'rules' : 'skill', action: 'approved',
      at: timestampOf(entry.settledAt || entry.createdAt), ownerId: entry.botId,
      title: entry.name || entry.folder || '', reason: entry.why || entry.description || '',
      source: 'Learning', evidence: '', text: entry.description || entry.why || '',
    })),
    ...standards.folders.flatMap(fact => (fact.standards.file && fact.standards.updatedAt
      ? [{
        kind: 'rules', action: 'updated', at: fact.standards.updatedAt, title: fact.standards.file,
        reason: fact.standards.ruleLines?.slice(0, 3).join(' · ') || '', source: fact.standards.file,
        evidence: fact.standards.sources?.join(' · ') || '', text: fact.standards.ruleLines?.slice(0, 2).join(' · ') || '',
      }]
      : [])),
    ...standards.documents.flatMap(doc => (doc.updatedAt
      ? [{
        kind: 'document', action: 'updated', at: doc.updatedAt, title: doc.path,
        reason: doc.excerpt || '', source: doc.path, evidence: '', text: doc.excerpt || doc.headings?.slice(0, 2).join(' · ') || '',
      }]
      : [])),
    ...standards.sourceDetails.filter(source => source.checkedAt).map(source => ({
      kind: 'source', action: 'reviewed', at: timestampOf(source.checkedAt), title: source.name,
      reason: '', source: source.name, evidence: source.url || '', text: source.version ? `v${source.version}` : '',
    })),
    ...(standards.quality?.checkedAt ? [{
      kind: 'check', action: 'recorded', at: timestampOf(standards.quality.checkedAt), title: '',
      reason: '', source: '.ds-bot/quality.json',
      evidence: `${standards.quality.passed}/${standards.quality.expected}`,
      text: `${standards.quality.passed}/${standards.quality.expected}`,
    }] : []),
    ...projectBots.filter(row => row.bot.lastAt).map(row => ({
      kind: 'work', action: 'recorded', at: row.bot.lastAt, ownerId: row.bot.id, title: row.bot.name,
      reason: '', source: row.bot.name, evidence: '', text: row.bot.preview || '',
    })),
    ...projectRooms.filter(row => row.room.lastAt).map(row => ({
      kind: 'work', action: 'recorded', at: row.room.lastAt, ownerId: row.room.id, title: row.room.name,
      reason: '', source: row.room.name, evidence: '', text: row.preview || '',
    })),
  ].filter(event => event.at > 0).sort((a, b) => b.at - a.at).slice(0, 16)
  return {
    count: memory.count + standards.rules + standards.sources.length + learning.approved,
    changes: changes.count,
    updatedAt: events[0]?.at ?? 0,
    events,
    knowledge: [
      { kind: 'memory', count: memory.count },
      { kind: 'rules', count: standards.rules },
      { kind: 'sources', count: standards.sources.length },
      { kind: 'skills', count: learning.approved },
      { kind: 'checks', count: standards.checks.length },
      { kind: 'verified', count: standards.quality?.passed ?? 0 },
    ],
  }
}

// Project rows use the sections the user already made. A section with no entries
// stays visible: that is a project the user can populate, not an error.
export function projectModel(base, insights) {
  const bots = base.bots
  const rooms = base.rooms
  const sections = [...(base.roster.sections ?? [])]
  const buildProject = (id, section, projectBots, projectRooms) => {
    const folders = uniqueValues([...projectBots.map(row => row.bot.workDir), ...projectRooms.map(row => row.room.workDir)])
    const ids = [...projectBots.map(row => row.bot.id), ...projectRooms.map(row => row.room.id)]
    const memories = memoryPairs(insights, ids)
    const standards = projectStandards(insights, folders)
    const changes = projectChanges(insights, folders)
    const workItems = projectWorkItems(insights, folders)
    const goal = projectGoal(projectRooms)
    const state = projectState(projectBots, projectRooms)
    const learning = projectLearning(base.roster, projectBots)
    const target = goal.room ?? projectRooms.find(room => room.approvals.length > 0)?.room
      ?? projectBots.find(row => row.alert)?.bot ?? projectRooms.find(room => room.running)?.room
      ?? projectBots.find(row => row.running)?.bot ?? projectRooms[0]?.room ?? projectBots[0]?.bot ?? null
    const memory = {
      count: memories.reduce((sum, [, entry]) => sum + entry.count, 0),
      topics: uniqueValues(memories.flatMap(([, entry]) => entry.topics ?? [])).slice(0, 10),
      recent: memories.flatMap(([ownerId, entry]) => (entry.recent ?? []).map(item => ({ ...item, ownerId })))
        .sort((a, b) => String(b.added ?? '').localeCompare(String(a.added ?? ''))).slice(0, 6),
      owners: memories.length,
    }
    const completion = projectCompletion(goal, standards, state, learning)
    const experience = projectExperience(projectBots, projectRooms, memory, standards, learning, changes)
    return {
      id,
      name: section?.name ?? null,
      color: section?.color ?? null,
      bots: projectBots,
      rooms: projectRooms,
      entries: projectBots.length + projectRooms.length,
      folders,
      goal,
      state,
      memory,
      standards,
      changes,
      workItems,
      learning,
      completion,
      experience,
      target,
      lastAt: Math.max(experience.updatedAt, changes.updatedAt),
    }
  }
  const rows = sections.map(section => buildProject(
    section.id,
    section,
    bots.filter(row => row.bot.sectionId === section.id),
    rooms.filter(row => row.room.sectionId === section.id),
  ))
  const rawUngroupedBots = bots.filter(row => row.bot.sectionId === undefined || !sections.some(section => section.id === row.bot.sectionId))
  const rawUngroupedRooms = rooms.filter(row => row.room.sectionId === undefined || !sections.some(section => section.id === row.room.sectionId))
  const ungrouped = rawUngroupedBots.length + rawUngroupedRooms.length === 0
    ? null
    : buildProject('__ungrouped__', null, rawUngroupedBots, rawUngroupedRooms)
  const projects = [...(ungrouped ? [ungrouped] : []), ...rows]
  return {
    projects,
    standardsLibrary: standardsLibrary(projects),
    counts: {
      total: projects.length,
      active: projects.filter(project => project.state?.working || project.state?.needs).length,
      needs: projects.reduce((sum, project) => sum + project.state.needs, 0),
      agents: bots.length,
      memory: insights?.memory?.total ?? 0,
      standards: projects.filter(project => project.standards.rules > 0).length,
      experience: projects.reduce((sum, project) => sum + project.experience.count, 0),
      changes: projects.reduce((sum, project) => sum + project.changes.count, 0),
      work: projects.reduce((sum, project) => sum + project.workItems.counts.open, 0),
      verified: projects.filter(project => project.completion.status === 'verified' || project.completion.status === 'complete').length,
    },
  }
}

function settledCounts(rows) {
  return {
    approved: rows.filter(row => row.outcome === 'approved').length,
    declined: rows.filter(row => row.outcome === 'declined').length,
  }
}

// One row per Bot (and the separate DSH Agent when the team has one). Health is
// the live runtime state; the quality strip is evidence actually found in the
// project folder, never a fabricated pass percentage.
export function agentBoardModel(base, insights) {
  const rows = base.bots.map(({ bot, ...row }) => {
    const facts = folderOf(insights, bot.workDir)
    const memory = memoryOf(insights, bot.id) ?? { count: 0, size: 0, limit: 0, topics: [], recent: [] }
    const proposals = base.roster.learning?.[bot.id] ?? []
    const settled = base.roster.learningSettled?.[bot.id] ?? []
    const outcomes = settledCounts(settled)
    const standards = facts === undefined ? projectStandards(insights, []) : projectStandards(insights, [facts.folder])
    const evidence = [
      Boolean(bot.workDir),
      (facts?.standards.rules ?? 0) > 0,
      (facts?.standards.sources?.length ?? 0) > 0,
      (facts?.checks?.length ?? 0) > 0,
    ]
    return {
      kind: 'bot',
      id: bot.id,
      bot,
      name: bot.name,
      role: bot.role ?? '',
      model: bot.model ?? bot.appliedModel ?? '',
      engine: bot.engine,
      row,
      folder: bot.workDir,
      standards,
      evidence,
      evidenceCount: evidence.filter(Boolean).length,
      memory,
      learning: { pending: proposals.length, ...outcomes, total: proposals.length + settled.length },
      health: bot.blocked !== undefined ? 'blocked' : row.state,
    }
  })
  for (const agent of base.roster.agents ?? []) {
    const sessionIds = agent.sessions ?? []
      const statuses = sessionIds.map(id => sessionState(base.sessionStatus, id))
    const status = statuses.find(entry => entry?.pendingInteraction !== undefined || entry?.completionUnread === true)
      ?? statuses.find(entry => entry?.running === true) ?? {}
    rows.push({
      kind: 'dsh', id: agent.id, agent, name: agent.name, role: 'DSH Agent', model: '',
      row: { state: status.running ? 'working' : status.completionUnread || status.pendingInteraction ? 'unread' : 'idle', running: status.running === true, unread: status.completionUnread === true || status.pendingInteraction !== undefined, alert: false, waitsOn: [] },
      sessionId: sessionIds.at(-1) ?? null,
      health: status.pendingInteraction ? 'needs' : status.running ? 'working' : status.completionUnread ? 'unread' : 'idle',
      standards: projectStandards(insights, []), evidence: [false, false, false, false], evidenceCount: 0,
      memory: { count: 0, size: 0, limit: 0, topics: [], recent: [] },
      learning: { pending: 0, approved: 0, declined: 0, total: 0 },
    })
  }
  return {
    rows,
    counts: {
      total: rows.length,
      needs: rows.filter(row => row.health === 'needs' || row.health === 'blocked').length,
      working: rows.filter(row => row.health === 'working').length,
      improving: rows.reduce((sum, row) => sum + row.learning.pending, 0),
      evidence: rows.reduce((sum, row) => sum + row.evidenceCount, 0),
    },
  }
}
