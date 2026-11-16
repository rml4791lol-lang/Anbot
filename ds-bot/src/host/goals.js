// Group goals: one outcome the whole group works toward, checked stage by stage.
// The state lives on the room (room.goal, archived into room.pastGoals), the admin
// runs it with the group_goal tool, the user steers it from the goal endpoints,
// and the relay wakes the admin when nothing runs and the goal is not done.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GOAL_IDLE_NUDGES, SOURCE_KIND } from './constants.js'
import { headOf } from './text.js'
import { output } from './tools.js'
import {
  evidenceFromEvents,
  invalidateAcceptance,
  progressAfterTurn,
  progressFingerprint,
  verifyAcceptance,
} from './task-evidence.js'

const TITLE_MAX = 80
const BRIEF_MAX = 2000
const TEXT_MAX = 2000
const RULE_MAX = 300
const RULES_MAX = 20
const STAGES_MAX = 20
const STAGE_TITLE_MAX = 80
const STAGE_ACCEPTANCE_MAX = 1000
const TASKS_MAX = 12
const TASK_MAX = 500
const NOTE_MAX = 300
const REASON_MAX = 300
const FEEDBACK_MAX = 1000
const EVENT_TEXT_MAX = 300
const EVENTS_MAX = 50
const PAST_MAX = 5
const CHECKS_MAX = 12
const CHECK_LABEL_MAX = 300
const CHECK_PATH_MAX = 500
const EVIDENCE_MAX = 32

const tooLong = (what, max) => `${what} is too long: at most ${max}.`
const tooMany = (what, max) => `At most ${max} ${what}.`
const required = (field, action) => `${field} is required for ${action}.`
const noGoal = room => `"${room.name}" has no goal. Start one with group_goal draft or start.`
const wrongState = (room, goal, action, allowed) => `The goal of "${room.name}" is ${goal.status}; ${action} needs it to be ${allowed}.`
const pausedRun = room => `The goal of "${room.name}" is paused. The user resumes it; until then, talk with the user and write their corrections in with revise.`
const allPassed = room => `Every stage of "${room.name}" has passed. Call group_goal complete with the evidence and a summary.`

export const TASK_LABEL = { pending: 'not started', working: 'working', reported: 'reported', done: 'done', 'needs-review': 'needs review' }

const goalId = () => `goal-${randomUUID().replace(/-/g, '').slice(0, 8)}`

const attemptId = (task, n) => `${task.id}:a${n}`

const pendingVerification = (checks = []) => ({
  state: 'pending',
  status: 'pending',
  checkEvidence: {},
  evidenceIds: [],
  checks: checks.filter(check => check.required !== false).map(check => ({ id: check.id, status: 'pending' })),
  missing: checks.filter(check => check.required !== false).map(check => check.id),
})

const artifactFacts = (evidence = []) => {
  const artifacts = {}
  const diffs = {}
  for (const item of evidence) {
    if (item?.artifact?.path && item.artifact.digest) artifacts[item.artifact.path] = item.artifact.digest
    for (const path of item?.diff?.paths ?? []) if (item.diff.digest) diffs[path] = item.diff.digest
  }
  return { artifacts, diffs }
}

const currentEvidence = task => (Array.isArray(task?.evidence) ? task.evidence : [])
  .filter(item => task?.attempt?.id === undefined || item?.attemptId === task.attempt.id)

function cleanChecks(list, stageNumber, action) {
  if (list === undefined) return {}
  const place = stageNumber === 0 ? 'the goal' : `stage ${stageNumber}`
  if (!Array.isArray(list)) return { error: required(`${place} checks`, action) }
  if (list.length > CHECKS_MAX) return { error: tooMany(`checks in ${place}`, CHECKS_MAX) }
  const checks = []
  for (const [index, item] of list.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `A check in ${place} must be an object.` }
    }
    const kind = String(item.kind ?? '').trim()
    if (!['command', 'artifact', 'diff', 'review', 'manual'].includes(kind)) {
      return { error: `A check in ${place} needs kind command, artifact, diff, review, or manual.` }
    }
    const id = String(item.id ?? `c${index + 1}`).trim()
    if (id === '' || id.length > 80) return { error: `A check in ${place} has an invalid id.` }
    const label = String(item.label ?? item.command ?? item.path ?? id).trim()
    if (label.length > CHECK_LABEL_MAX) return { error: tooLong(`a check label in ${place}`, CHECK_LABEL_MAX) }
    const command = String(item.command ?? '').trim()
    const path = String(item.path ?? '').trim()
    if (kind === 'command' && command === '') return { error: `A command check in ${place} needs command.` }
    if ((kind === 'artifact' || kind === 'diff') && path === '') return { error: `An ${kind} check in ${place} needs path.` }
    if (path.length > CHECK_PATH_MAX) return { error: tooLong(`a check path in ${place}`, CHECK_PATH_MAX) }
    checks.push({
      id,
      kind,
      label,
      required: item.required !== false,
      ...(command === '' ? {} : { command }),
      ...(path === '' ? {} : { path }),
      ...(item.expect && typeof item.expect === 'object' ? { expect: item.expect } : {}),
    })
  }
  const ids = new Set()
  for (const check of checks) {
    if (ids.has(check.id)) return { error: `Check id ${check.id} is repeated in ${place}.` }
    ids.add(check.id)
  }
  return { checks }
}

// The goal's own stamp on every change: a new revision the client polls, the
// change in its event list, and the idle bookkeeping reset.
export function touchGoal(goal, event, now = Date.now(), { keepNudges = false } = {}) {
  goal.revision += 1
  goal.updatedAt = now
  if (!keepNudges) {
    goal.nudges = 0
    delete goal.idle
  }
  if (event !== undefined) goal.events = [...(goal.events ?? []), { at: now, ...event }].slice(-EVENTS_MAX)
}

export function archiveGoal(room) {
  const goal = room.goal
  if (goal === undefined) return
  room.pastGoals = [...(room.pastGoals ?? []), goal].slice(-PAST_MAX)
  delete room.goal
}

function newGoal({ brief = '', title, by = 'user', event = 'draft' } = {}, now) {
  const text = String(brief).trim()
  const goal = {
    id: goalId(),
    revision: 0,
    status: 'drafting',
    title: (title !== undefined && String(title).trim() !== '' ? String(title).trim() : text.split('\n')[0]).slice(0, TITLE_MAX),
    ...(text !== '' ? { brief: text.slice(0, BRIEF_MAX) } : {}),
    objective: '',
    acceptance: '',
    constraints: [],
    stages: [],
    current: -1,
    nudges: 0,
    by,
    createdAt: now,
    updatedAt: now,
    events: [],
    // Stage and task ids are never reused inside a goal, not even by a revise
    // that drops the stages they were on.
    counter: { stage: 0, task: 0 },
  }
  if (event !== undefined) touchGoal(goal, { kind: event, by }, now)
  return goal
}

// What every task's bot must be: a current member, named exactly. `memberOf`
// resolves a name to the member or undefined; `memberNames` is for the refusal.
function cleanStages(room, list, action, memberOf, memberNames) {
  if (!Array.isArray(list) || list.length === 0) return { error: required('stages', action) }
  if (list.length > STAGES_MAX) return { error: tooMany('stages', STAGES_MAX) }
  const stages = []
  for (const [index, item] of list.entries()) {
    const n = index + 1
    const title = String(item?.title ?? '').trim()
    if (title === '') return { error: required(`stage ${n} title`, action) }
    if (title.length > STAGE_TITLE_MAX) return { error: tooLong(`stage ${n} title`, STAGE_TITLE_MAX) }
    const acceptance = String(item?.acceptance ?? '').trim()
    if (acceptance === '') return { error: required(`stage ${n} acceptance`, action) }
    if (acceptance.length > STAGE_ACCEPTANCE_MAX) return { error: tooLong(`stage ${n} acceptance`, STAGE_ACCEPTANCE_MAX) }
    const checked = cleanChecks(item?.checks, n, action)
    if (checked.error !== undefined) return checked
    const items = Array.isArray(item?.tasks) ? item.tasks : []
    if (items.length === 0) return { error: required(`stage ${n} tasks`, action) }
    if (items.length > TASKS_MAX) return { error: tooMany(`tasks in stage ${n}`, TASKS_MAX) }
    const tasks = []
    for (const entry of items) {
      const name = String(entry?.bot ?? '').trim()
      const task = String(entry?.task ?? '').trim()
      if (task === '') return { error: required(`a task of stage ${n}`, action) }
      if (task.length > TASK_MAX) return { error: tooLong(`a task in stage ${n}`, TASK_MAX) }
      const bot = memberOf(name)
      if (bot === undefined) return { error: `${name} is not a member of "${room.name}". Members: ${memberNames.join(', ')}.` }
      const taskChecks = cleanChecks(entry?.checks, n, action)
      if (taskChecks.error !== undefined) return taskChecks
      tasks.push({ botId: bot.id, task, ...(taskChecks.checks === undefined ? {} : { checks: taskChecks.checks }) })
    }
    stages.push({ title, acceptance, tasks, ...(checked.checks === undefined ? {} : { checks: checked.checks }) })
  }
  return { stages }
}

function cleanConstraints(list, action) {
  if (list === undefined) return {}
  if (!Array.isArray(list)) return { error: required('constraints', action) }
  if (list.length > RULES_MAX) return { error: tooMany('constraints', RULES_MAX) }
  const constraints = []
  for (const item of list) {
    const text = String(item ?? '').trim()
    if (text === '') continue
    if (text.length > RULE_MAX) return { error: tooLong('a constraint', RULE_MAX) }
    constraints.push(text)
  }
  return { constraints }
}

function cleanFields(input, fields) {
  for (const [field, max] of fields) {
    const value = input[field]
    if (value === undefined) continue
    if (String(value).trim().length > max) return { error: tooLong(field, max) }
  }
  return {}
}

// A cleaned stage becomes a stored one: fresh ids, tasks pending unless the same
// member had the same task in the stage this one replaces (a revise keeps it).
function buildStage(goal, stage, position, previous, status) {
  const stored = {
    id: `s${++goal.counter.stage}`,
    title: stage.title,
    acceptance: stage.acceptance,
    status,
    tasks: stage.tasks.map((task) => {
      const kept = previous?.tasks.find(old => old.botId === task.botId && old.task === task.task)
      const sameChecks = JSON.stringify(kept?.checks ?? null) === JSON.stringify(task.checks ?? null)
      const preserve = kept !== undefined && sameChecks
      return {
        id: `t${++goal.counter.task}`,
        ...task,
        status: preserve ? kept.status : 'pending',
        verification: pendingVerification(task.checks ?? []),
        ...(preserve && kept.attempt ? { attempt: kept.attempt } : {}),
        ...(preserve && kept.checkpoint ? { checkpoint: kept.checkpoint } : {}),
        ...(preserve && kept.progress ? { progress: kept.progress } : {}),
        ...(preserve && kept.evidence ? { evidence: kept.evidence } : {}),
      }
    }),
    reworks: 0,
    verification: pendingVerification(stage.checks ?? []),
  }
  if (stage.checks !== undefined) stored.checks = stage.checks
  return stored
}

export function draftGoal(room, { brief = '', title, by = 'user' } = {}, now = Date.now()) {
  const goal = room.goal
  if (goal !== undefined && (goal.status === 'active' || goal.status === 'paused')) {
    return { error: wrongState(room, goal, 'draft', 'new or drafting') }
  }
  const text = String(brief ?? '').trim()
  if (text === '') return { error: required('brief', 'draft') }
  if (text.length > BRIEF_MAX) return { error: tooLong('brief', BRIEF_MAX) }
  const cut = cleanFields({ title }, [['title', TITLE_MAX]])
  if (cut.error !== undefined) return cut
  if (['complete', 'stopped', 'needs-review'].includes(goal?.status)) archiveGoal(room)
  const drafting = room.goal?.status === 'drafting' ? room.goal : undefined
  if (drafting !== undefined) {
    drafting.brief = text
    drafting.title = (title !== undefined && String(title).trim() !== '' ? String(title).trim() : text.split('\n')[0]).slice(0, TITLE_MAX)
    touchGoal(drafting, { kind: 'draft', by, text: headOf(text, EVENT_TEXT_MAX) }, now)
    return { goal: drafting, reply: { event: 'draft', title: drafting.title, count: drafting.stages.length } }
  }
  const next = newGoal({ brief: text, title, by }, now)
  room.goal = next
  return { goal: next, reply: { event: 'draft', title: next.title, count: 0 } }
}

export function startGoal(room, input, by, memberOf, memberNames, now = Date.now()) {
  const goal = room.goal
  if (goal !== undefined && (goal.status === 'active' || goal.status === 'paused')) {
    return { error: wrongState(room, goal, 'start', 'new or drafting') }
  }
  const objective = String(input.objective ?? '').trim()
  if (objective === '') return { error: required('objective', 'start') }
  const acceptance = String(input.acceptance ?? '').trim()
  if (acceptance === '') return { error: required('acceptance', 'start') }
  const cut = cleanFields(input, [['objective', TEXT_MAX], ['acceptance', TEXT_MAX], ['title', TITLE_MAX]])
  if (cut.error !== undefined) return cut
  const rules = cleanConstraints(input.constraints, 'start')
  if (rules.error !== undefined) return rules
  const checks = cleanChecks(input.checks, 0, 'start')
  if (checks.error !== undefined) return checks
  const cleaned = cleanStages(room, input.stages, 'start', memberOf, memberNames)
  if (cleaned.error !== undefined) return cleaned
  if (goal?.status === 'complete' || goal?.status === 'stopped') archiveGoal(room)
  const draft = room.goal?.status === 'drafting' ? room.goal : undefined
  const next = draft ?? newGoal({ by, event: undefined }, now)
  if (draft === undefined) room.goal = next
  next.status = 'active'
  next.objective = objective
  next.acceptance = acceptance
  next.constraints = rules.constraints ?? []
  if (checks.checks === undefined) delete next.checks
  else next.checks = checks.checks
  next.title = String(input.title ?? '').trim() || next.title || objective.split('\n')[0].slice(0, TITLE_MAX)
  delete next.brief
  next.stages = cleaned.stages.map((stage, index) => buildStage(next, stage, index, undefined, index === 0 ? 'active' : 'pending'))
  next.current = 0
  next.startedAt = now
  delete next.endedAt
  delete next.summary
  delete next.evidence
  delete next.reason
  delete next.pausedBy
  delete next.verification
  touchGoal(next, { kind: 'start', by }, now)
  return { goal: next, reply: { event: 'start', title: next.title, stage: 1, count: next.stages.length, next: next.stages[0].title } }
}

export function reviseGoal(room, input, by, memberOf, memberNames, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (!['active', 'paused', 'needs-review'].includes(goal.status)) return { error: wrongState(room, goal, 'revise', 'active, paused or needs-review') }
  const reason = String(input.reason ?? '').trim()
  if (reason === '') return { error: required('reason', 'revise') }
  if (reason.length > FEEDBACK_MAX) return { error: tooLong('reason', FEEDBACK_MAX) }
  const cut = cleanFields(input, [['title', TITLE_MAX], ['objective', TEXT_MAX], ['acceptance', TEXT_MAX]])
  if (cut.error !== undefined) return cut
  if (input.objective !== undefined && String(input.objective).trim() === '') return { error: required('objective', 'revise') }
  if (input.acceptance !== undefined && String(input.acceptance).trim() === '') return { error: required('acceptance', 'revise') }
  const rules = cleanConstraints(input.constraints, 'revise')
  if (rules.error !== undefined) return rules
  const checks = cleanChecks(input.checks, 0, 'revise')
  if (checks.error !== undefined) return checks
  // Everything validates before anything changes: a refused revise leaves the goal as it was.
  let cleaned
  let keep = []
  if (input.stages !== undefined) {
    cleaned = cleanStages(room, input.stages, 'revise', memberOf, memberNames)
    if (cleaned.error !== undefined) return cleaned
    keep = goal.stages.slice(0, Math.max(0, goal.current))
    if (keep.length + cleaned.stages.length > STAGES_MAX) return { error: tooMany('stages', STAGES_MAX) }
  }
  if (input.title !== undefined && String(input.title).trim() !== '') goal.title = String(input.title).trim()
  if (input.objective !== undefined) goal.objective = String(input.objective).trim()
  if (input.acceptance !== undefined) goal.acceptance = String(input.acceptance).trim()
  if (rules.constraints !== undefined) goal.constraints = rules.constraints
  if (checks.checks !== undefined) goal.checks = checks.checks
  delete goal.verification
  if (cleaned !== undefined) {
    const previous = goal.stages[goal.current]
    const replacement = cleaned.stages.map((stage, index) => {
      const position = keep.length + index
      return buildStage(goal, stage, position, position === goal.current ? previous : undefined, position === goal.current ? 'active' : 'pending')
    })
    goal.stages = [...keep, ...replacement]
  }
  touchGoal(goal, { kind: 'revise', by, text: headOf(reason, EVENT_TEXT_MAX) }, now)
  return { goal, reply: { event: 'revise', title: goal.title, count: goal.stages.length, text: reason } }
}

export function taskGoal(room, input, by, memberOf, memberNames, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (!['active', 'needs-review'].includes(goal.status)) return { error: wrongState(room, goal, 'task', 'active or needs-review') }
  const number = input.stage === undefined ? goal.current + 1 : Number(input.stage)
  const stage = Number.isInteger(number) ? goal.stages[number - 1] : undefined
  if (stage === undefined) return { error: `The goal of "${room.name}" has no stage ${number}.` }
  const name = String(input.bot ?? '').trim()
  if (name === '') return { error: required('bot', 'task') }
  const bot = memberOf(name)
  if (bot === undefined) return { error: `${name} is not a member of "${room.name}". Members: ${memberNames.join(', ')}.` }
  const task = stage.tasks.find(item => item.botId === bot.id)
  if (task === undefined) return { error: `${name} has no task in stage ${number} of "${room.name}".` }
  const status = input.status === undefined ? undefined : String(input.status)
  const note = input.note === undefined ? undefined : String(input.note).trim()
  if (status === undefined && note === undefined) return { error: required('status or note', 'task') }
  if (note !== undefined && note.length > NOTE_MAX) return { error: tooLong('note', NOTE_MAX) }
  if (status !== undefined) {
    if (status === 'working' && task.status !== 'working') startTaskAttempt(task, now)
    task.status = status
    if (task.attempt !== undefined) task.attempt.status = status === 'done' ? 'reported' : status
    if (task.attempt !== undefined) task.attempt.updatedAt = now
  }
  if (note !== undefined) {
    if (note === '') delete task.note
    else task.note = note
  }
  touchGoal(goal, { kind: 'task', by, stage: stage.id, text: headOf(note ?? status, EVENT_TEXT_MAX) }, now, { keepNudges: true })
  return { goal }
}

function startTaskAttempt(task, now, extra = {}) {
  const n = (task.attempt?.n ?? 0) + 1
  task.attempt = {
    id: attemptId(task, n),
    n,
    status: 'working',
    startedAt: now,
    updatedAt: now,
    ...extra,
  }
  task.progress = {
    state: 'moving',
    fingerprint: progressFingerprint(currentEvidence(task)),
    unchangedTurns: 0,
    changedAt: now,
  }
  task.checkpoint = {
    at: now,
    attemptId: task.attempt.id,
    kind: 'progress',
    summary: 'Task attempt started.',
    nextAction: task.task,
    ...extra,
    progressFingerprint: task.progress.fingerprint,
  }
  return task.attempt
}

function mergeVerified(results) {
  const checkEvidence = {}
  const artifactDigests = {}
  const diffDigests = {}
  const missing = []
  let verifiedAt
  for (const result of results) {
    Object.assign(checkEvidence, result.checkEvidence ?? {})
    Object.assign(artifactDigests, result.artifactDigests ?? {})
    Object.assign(diffDigests, result.diffDigests ?? {})
    missing.push(...(result.missing ?? []))
    if (result.verifiedAt !== undefined) verifiedAt = Math.max(verifiedAt ?? 0, result.verifiedAt)
  }
  const evidenceIds = [...new Set(Object.values(checkEvidence))]
  const checks = results.flatMap(result => result.checks ?? [])
  return missing.length === 0 && results.length > 0
    ? { state: 'verified', status: 'verified', checkEvidence, evidenceIds, checks, artifactDigests, diffDigests, missing: [], verifiedAt }
    : { state: 'pending', status: 'pending', checkEvidence, evidenceIds, checks, artifactDigests, diffDigests, missing: [...new Set(missing)] }
}

function markBoundEvidence(stage, verification) {
  if (verification?.state !== 'verified') return
  const ids = new Set(verification.evidenceIds ?? Object.values(verification.checkEvidence ?? {}))
  for (const task of stage.tasks) {
    for (const item of task.evidence ?? []) {
      if (ids.has(item.id)) {
        item.trust = 'verified'
        item.kind = 'verified'
      }
    }
  }
}

function verifyStage(stage, now) {
  const aggregate = stage.tasks.flatMap(currentEvidence)
  const results = []
  let structured = false
  if (Array.isArray(stage.checks) && stage.checks.length > 0) {
    structured = true
    const result = verifyAcceptance({ checks: stage.checks, evidence: aggregate, now })
    markBoundEvidence(stage, result)
    results.push(result)
  }
  for (const task of stage.tasks) {
    if (Array.isArray(task.checks) && task.checks.length > 0) {
      structured = true
      task.verification = verifyAcceptance({ checks: task.checks, evidence: currentEvidence(task), now })
      markBoundEvidence(stage, task.verification)
      results.push(task.verification)
    } else if (results.length > 0) {
      task.verification = results[0]
    }
  }
  if (!structured) {
    const manual = { state: 'pending', status: 'pending', manual: true, checkEvidence: {}, evidenceIds: [], checks: [], missing: [], reason: 'Legacy acceptance is manual and cannot be verified automatically.' }
    for (const task of stage.tasks) task.verification = manual
    stage.verification = manual
    return manual
  }
  stage.verification = mergeVerified(results)
  for (const task of stage.tasks) if (task.verification === undefined) task.verification = stage.verification
  return stage.verification
}

export function passGoal(room, input, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status === 'paused') return { error: pausedRun(room) }
  if (!['active', 'needs-review'].includes(goal.status)) return { error: wrongState(room, goal, 'pass', 'active or needs-review') }
  const stage = goal.stages[goal.current]
  if (stage === undefined) return { error: allPassed(room) }
  const evidence = String(input.evidence ?? '').trim()
  if (evidence === '') return { error: required('evidence', 'pass') }
  if (evidence.length > TEXT_MAX) return { error: tooLong('evidence', TEXT_MAX) }
  const verification = verifyStage(stage, now)
  if (stage.verification?.manual !== true && verification.state !== 'verified') {
    const missing = verification.missing.length > 0 ? verification.missing.join(', ') : 'required checks'
    return { error: `Acceptance checks are not verified: ${missing}. Supply matching command, artifact, diff, or independent review evidence.` }
  }
  goal.status = 'active'
  stage.status = 'passed'
  stage.evidence = evidence
  stage.passedAt = now
  for (const task of stage.tasks) {
    task.status = 'done'
    if (task.attempt !== undefined) {
      task.attempt.status = task.verification?.state === 'verified' ? 'verified' : 'reported'
      task.attempt.updatedAt = now
    }
    task.checkpoint = {
      at: now,
      attemptId: task.attempt?.id,
      kind: task.verification?.state === 'verified' ? 'verified' : 'reported',
      summary: task.verification?.state === 'verified' ? 'Stage acceptance verified.' : 'Stage passed by reported/manual acceptance.',
      nextAction: 'Wait for the next stage.',
      evidenceId: Object.values(task.verification?.checkEvidence ?? {})[0],
      progressFingerprint: progressFingerprint(currentEvidence(task)),
    }
  }
  goal.current += 1
  const next = goal.stages[goal.current]
  if (next !== undefined) next.status = 'active'
  touchGoal(goal, { kind: 'pass', by, stage: stage.id, text: headOf(evidence, EVENT_TEXT_MAX) }, now)
  return { goal, reply: { event: 'pass', title: goal.title, stage: goal.current, count: goal.stages.length, ...(next !== undefined ? { next: next.title } : {}), text: evidence } }
}

export function reworkGoal(room, input, by, memberOf, memberNames, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status === 'paused') return { error: pausedRun(room) }
  if (!['active', 'needs-review'].includes(goal.status)) return { error: wrongState(room, goal, 'rework', 'active or needs-review') }
  const stage = goal.stages[goal.current]
  if (stage === undefined) return { error: allPassed(room) }
  const reason = String(input.reason ?? '').trim()
  if (reason === '') return { error: required('reason', 'rework') }
  if (reason.length > FEEDBACK_MAX) return { error: tooLong('reason', FEEDBACK_MAX) }
  let only
  if (input.bot !== undefined && String(input.bot).trim() !== '') {
    const name = String(input.bot).trim()
    only = memberOf(name)
    if (only === undefined) return { error: `${name} is not a member of "${room.name}". Members: ${memberNames.join(', ')}.` }
  }
  for (const task of stage.tasks) {
    if (only !== undefined && task.botId !== only.id) continue
    task.status = 'pending'
    task.verification = pendingVerification(task.checks ?? [])
    if (task.attempt !== undefined) task.attempt.status = 'reported'
    delete task.note
  }
  stage.reworks += 1
  stage.feedback = reason
  stage.verification = pendingVerification(stage.checks ?? [])
  delete goal.verification
  goal.status = 'active'
  touchGoal(goal, { kind: 'rework', by, stage: stage.id, text: headOf(reason, EVENT_TEXT_MAX) }, now)
  return { goal, reply: { event: 'rework', title: goal.title, stage: goal.current + 1, count: goal.stages.length, text: reason } }
}

export function completeGoal(room, input, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status === 'paused') return { error: pausedRun(room) }
  if (goal.status !== 'active') return { error: wrongState(room, goal, 'complete', 'active') }
  const open = goal.stages.findIndex(stage => stage.status !== 'passed')
  if (open !== -1) return { error: `Stage ${open + 1} "${goal.stages[open].title}" has not passed yet. Pass every stage before complete.` }
  const evidence = String(input.evidence ?? '').trim()
  if (evidence === '') return { error: required('evidence', 'complete') }
  if (evidence.length > TEXT_MAX) return { error: tooLong('evidence', TEXT_MAX) }
  const summary = String(input.summary ?? '').trim()
  if (summary === '') return { error: required('summary', 'complete') }
  if (summary.length > TEXT_MAX) return { error: tooLong('summary', TEXT_MAX) }
  const results = goal.stages
    .map(stage => stage.verification)
    .filter(result => result !== undefined && result.manual !== true)
  let overall
  if (Array.isArray(goal.checks) && goal.checks.length > 0) {
    const evidence = goal.stages.flatMap(stage => stage.tasks.flatMap(currentEvidence))
    overall = verifyAcceptance({ checks: goal.checks, evidence, now })
    if (overall.state !== 'verified') {
      const missing = overall.missing.length > 0 ? overall.missing.join(', ') : 'required checks'
      return { error: `Overall acceptance checks are not verified: ${missing}. Supply matching command, artifact, diff, or independent review evidence.` }
    }
    const ids = new Set(overall.evidenceIds ?? Object.values(overall.checkEvidence ?? {}))
    for (const stage of goal.stages) {
      for (const task of stage.tasks) {
        for (const item of task.evidence ?? []) {
          if (!ids.has(item.id)) continue
          item.trust = 'verified'
          item.kind = 'verified'
        }
      }
    }
    results.push(overall)
  }
  goal.status = 'complete'
  goal.summary = summary
  goal.evidence = evidence
  goal.endedAt = now
  goal.verification = results.length > 0 && results.every(result => result.state === 'verified')
    ? mergeVerified(results)
    : { state: 'pending', status: 'pending', manual: true, checkEvidence: {}, evidenceIds: [], checks: [], missing: [], reason: 'One or more stages use reported/manual acceptance.' }
  touchGoal(goal, { kind: 'complete', by }, now)
  return { goal, reply: { event: 'complete', title: goal.title, count: goal.stages.length, text: summary } }
}

export function pauseGoal(room, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status !== 'active') return { error: wrongState(room, goal, 'pause', 'active') }
  goal.status = 'paused'
  goal.pausedBy = by
  touchGoal(goal, { kind: 'pause', by }, now)
  return { goal, reply: { event: 'pause', title: goal.title, count: goal.stages.length } }
}

export function resumeGoal(room, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status !== 'paused') return { error: wrongState(room, goal, 'resume', 'paused') }
  goal.status = 'active'
  delete goal.pausedBy
  touchGoal(goal, { kind: 'resume', by }, now)
  return { goal, reply: { event: 'resume', title: goal.title, count: goal.stages.length } }
}

export function stopGoal(room, reason, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (!['drafting', 'active', 'paused', 'needs-review'].includes(goal.status)) {
    return { error: wrongState(room, goal, 'stop', 'drafting, active, paused or needs-review') }
  }
  const text = String(reason ?? '').trim()
  if (text === '') return { error: required('reason', 'stop') }
  if (text.length > REASON_MAX) return { error: tooLong('reason', REASON_MAX) }
  goal.status = 'stopped'
  goal.reason = text
  goal.endedAt = now
  touchGoal(goal, { kind: 'stop', by, text: headOf(text, EVENT_TEXT_MAX) }, now)
  return { goal, reply: { event: 'stop', title: goal.title, count: goal.stages.length, text } }
}

// Automatic task status, from what happens in the room rather than the tool:
// the admin calling a member moves its task to working, the member's answer
// moves it to reported, and a failure or a user stop puts it back to pending.
// No log line, no round reply — only a new revision.
export function markTasks(room, botId, from, to, note, now = Date.now()) {
  const goal = room.goal
  if (goal?.status !== 'active') return false
  const stage = goal.stages[goal.current]
  if (stage === undefined) return false
  let changed = false
  for (const task of stage.tasks) {
    if (task.botId !== botId || task.status !== from) continue
    task.status = to
    if (note === undefined) delete task.note
    else task.note = note
    changed = true
  }
  if (!changed) return false
  goal.nudges = 0
  delete goal.idle
  goal.revision += 1
  goal.updatedAt = now
  return true
}

const DUTY_ACTIVE = 'You run this goal. Hand each task of the current stage to its member with @Name; members you call in one message start together. When they report back, check the results against the stage\'s "done when" yourself or have a reviewing member check them. Then call group_goal pass with the evidence and hand out the next stage in the same reply, or call group_goal rework with what is missing and call the members again. Keep all work inside the objective and the rules. When the user corrects the direction, call group_goal revise first. Ask the user only for decisions you cannot make.'
const DUTY_PASSED = 'Every stage passed. Check the overall "done when", then call group_goal complete with the evidence and a summary for the user.'
const DUTY_PAUSED = 'The user paused this goal. Do not hand out stage work or pass stages. Talk with the user, and write their corrections into the goal with group_goal revise. The user resumes it.'
const dutyOf = goal => (goal.status === 'paused' ? DUTY_PAUSED : goal.stages[goal.current] === undefined ? DUTY_PASSED : DUTY_ACTIVE)

const DUTY_DRAFT = [
  'Align with the user before you write it, following the goal-grill skill:',
  '1. Find the facts yourself (files, code, records) or ask members with @Name. Never ask the user what you can look up.',
  '2. List the decisions only the user can make. Ask them in one message, numbered, each with your recommended answer, so the user can reply "as recommended". Skip this when nothing is open.',
  '3. Then call group_goal start: the objective, how to check it is done (commands, tests, files, evidence), the rules to keep, and the stages in order, each with its own check and its tasks for named members.',
].join('\n')
const NUDGE_LINE = 'Goal check from DS Bot: nothing is running in this group and the goal is not finished. Take the next step now: hand out the current stage\'s tasks that are not done, check a stage whose members have reported, or complete the goal if every stage passed. If you are waiting for the user, reply [PASS].'
const RESUME_LINE = 'The user resumed the goal. Take the next step now.'

export function install(rt) {
  const { ctx, state } = rt
  const callsBySession = new Map()

  const memberOf = room => (ref) => {
    const bot = rt.findBot(ref)
    return bot !== undefined && room.members.includes(bot.id) ? bot : undefined
  }
  const memberNames = room => room.members.map(id => rt.botOf(id)?.name).filter(Boolean)
  const nameOf = id => rt.botOf(id)?.name ?? 'a member'

  // The admin's ledger: the whole goal, for the prompt block and the tool's answer.
  function ledgerLines(goal) {
    const lines = [`Goal: ${goal.title}`, `Objective: ${goal.objective}`, `Done when: ${goal.acceptance}`]
    if (goal.constraints.length > 0) lines.push('Rules:', ...goal.constraints.map(rule => `- ${rule}`))
    lines.push('Stages:')
    goal.stages.forEach((stage, index) => {
      const n = index + 1
      if (stage.status === 'passed') lines.push(`[passed] ${n}. ${stage.title}`)
      else if (index === goal.current) {
        lines.push(`[current] ${n}. ${stage.title} — done when: ${stage.acceptance}`)
        for (const task of stage.tasks) lines.push(`  - ${nameOf(task.botId)}: ${task.task} [${TASK_LABEL[task.status]}]${task.note ? ` — ${task.note}` : ''}`)
        if (stage.reworks > 0) lines.push(`  Sent back ${stage.reworks} ${stage.reworks === 1 ? 'time' : 'times'}. Latest feedback: ${stage.feedback ?? ''}`)
      } else lines.push(`[next] ${n}. ${stage.title}: ${[...new Set(stage.tasks.map(task => nameOf(task.botId)))].join(', ')}`)
    })
    const corrections = (goal.events ?? []).filter(event => event.kind === 'revise' && event.text).slice(-3).map(event => event.text)
    if (corrections.length > 0) lines.push(`Latest corrections from the user: ${corrections.join(' / ')}`)
    return lines
  }

  // A member's share of the goal: the current stage and its own task in it.
  function memberLines(room, goal, member) {
    const count = goal.stages.length
    const stage = goal.stages[goal.current]
    const lines = [
      `The group works toward: ${goal.title} — ${headOf(goal.objective, 600)}`,
      ...(goal.constraints.length > 0 ? [`Rules: ${goal.constraints.join('; ')}`] : []),
    ]
    if (stage === undefined) lines.push('Every stage passed; the admin is checking the whole goal.')
    else {
      lines.push(`Current stage ${goal.current + 1} "${stage.title}", done when: ${stage.acceptance}`)
      const tasks = stage.tasks.filter(task => task.botId === member.id)
      if (tasks.length === 0) lines.push('You have no task in this stage.')
      else for (const task of tasks) lines.push(`Your task in it: ${task.task} (${TASK_LABEL[task.status]}).`)
    }
    lines.push('Work only toward this. When you finish your task, end your reply with the evidence: the files you changed, the commands you ran and what they printed.')
    if (goal.status === 'paused') lines.push('The goal is paused: finish only what you are doing now and start no new stage work.')
    return { lines, stage: `${stage === undefined ? count : goal.current + 1}/${count}` }
  }

  // The <group_goal> block in every round's prompt; nudge and resume add a line
  // after it for the admin. No block at all with no goal or a finished one.
  function goalBlock(room, member, { nudge = false, resume = false } = {}) {
    const goal = room.goal
    if (goal === undefined || goal.status === 'complete' || goal.status === 'stopped') return ''
    const isAdmin = rt.isAdminOf(room, member.id)
    let block
    if (goal.status === 'drafting') {
      block = isAdmin
        ? ['<group_goal status="drafting">', `The user wants this group to reach a goal: ${goal.brief ?? ''}`, DUTY_DRAFT, '</group_goal>'].join('\n')
        : ['<group_goal status="drafting">', `The admin is aligning a new goal for this group with the user: ${headOf(goal.brief ?? '', 300)}. Help with facts when you are asked.`, '</group_goal>'].join('\n')
    } else if (isAdmin) {
      block = [`<group_goal status="${goal.status}">`, ...ledgerLines(goal), dutyOf(goal), '</group_goal>'].join('\n')
    } else {
      const view = memberLines(room, goal, member)
      block = [`<group_goal status="${goal.status}" stage="${view.stage}">`, ...view.lines, '</group_goal>'].join('\n')
    }
    if (isAdmin && nudge) block += `\n${NUDGE_LINE}`
    if (isAdmin && resume) block += `\n${RESUME_LINE}`
    return block
  }

  // The tool's answer: the ledger as the caller sees it, without the block's tags.
  function goalLedger(room, member) {
    const goal = room.goal
    if (goal === undefined) return noGoal(room)
    if (goal.status === 'complete') return `Goal "${goal.title}" is complete.`
    if (goal.status === 'stopped') return `Goal "${goal.title}" was stopped${goal.reason ? `: ${goal.reason}` : ''}.`
    if (goal.status === 'drafting') {
      return rt.isAdminOf(room, member.id)
        ? `The user wants this group to reach a goal: ${goal.brief ?? ''}`
        : `The admin is aligning a new goal for this group with the user: ${headOf(goal.brief ?? '', 300)}. Help with facts when you are asked.`
    }
    if (rt.isAdminOf(room, member.id)) return ledgerLines(goal).join('\n')
    return memberLines(room, goal, member).lines.join('\n')
  }

  // Every non-task change is a group event: a notice the members read, which the
  // group chat shows as a goal row.
  const announce = (room, reply) => {
    rt.logRoom?.(room, { who: 'DS Bot', kind: 'notice', reason: 'goal', ...reply })
  }

  // A goal message into the room's own Session, which relays it as a new round:
  // the user's draft request, a resume after the user continues, or an idle nudge.
  async function queueGoalRelay(room, goal, text, senderName = 'You') {
    const agent = await rt.resolveAgent(rt.sessionOfRoom(room))
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND, form: 'relay', role: 'goal', goal, goalId: room.goal?.id, exchangeId: randomUUID(), senderName, roomId: room.id },
    }))
    await ctx.sessions.flush(agent.session)
  }

  // goal-draft { roomId, text }: the user's one-line ask opens a drafting goal.
  async function goalDraft(roomId, text) {
    const room = rt.roomOf(roomId)
    if (room === undefined) return { error: 'Unknown group chat' }
    const input = String(text ?? '').trim()
    if (input === '' || input.length > BRIEF_MAX) return { error: 'Write what this group should achieve, in at most 2000 characters.', code: 'bot/invalid' }
    const admin = room.members.map(rt.botOf).filter(Boolean).find(bot => rt.isAdminOf(room, bot.id))
    if (admin === undefined) return { error: 'This group has no admin. Set one in the group settings first.' }
    if (room.goal !== undefined && (room.goal.status === 'active' || room.goal.status === 'paused')) {
      return { error: 'This group already has a goal. Stop it first.' }
    }
    const result = draftGoal(room, { brief: input, by: 'user' })
    if (result.error !== undefined) return { error: result.error }
    announce(room, result.reply)
    await rt.save()
    await queueGoalRelay(room, 'draft', `[Goal request]\n${input}`)
    return {}
  }

  // goal-control { roomId, goalId, action, stopWork? }: the user's pause, resume,
  // stop and clear from the goal panel.
  async function goalControl(roomId, body = {}) {
    const room = rt.roomOf(roomId)
    if (room === undefined) return { error: 'Unknown group chat' }
    const goal = room.goal
    if (goal === undefined || goal.id !== String(body.goalId ?? '')) return { error: 'The goal has changed. Look again.', code: 'bot/stale' }
    const action = String(body.action ?? '')
    if (action === 'pause') {
      if (goal.status !== 'active') return { error: wrongState(room, goal, 'pause', 'active') }
      const result = pauseGoal(room, 'user')
      announce(room, result.reply)
      await rt.save()
      if (body.stopWork === true) await rt.stopRoomWork(room.id)
      return {}
    }
    if (action === 'resume') {
      if (goal.status !== 'paused') return { error: wrongState(room, goal, 'resume', 'paused') }
      const result = resumeGoal(room, 'user')
      announce(room, result.reply)
      await rt.save()
      await queueGoalRelay(room, 'resume', '[Goal resumed]')
      return {}
    }
    if (action === 'stop') {
      if (!['drafting', 'active', 'paused'].includes(goal.status)) return { error: wrongState(room, goal, 'stop', 'drafting, active or paused') }
      const result = stopGoal(room, 'Stopped by the user', 'user')
      announce(room, result.reply)
      await rt.save()
      await rt.stopRoomWork(room.id)
      return {}
    }
    if (action === 'clear') {
      if (goal.status === 'active' || goal.status === 'paused') {
        return { error: `The goal of "${room.name}" is ${goal.status}; clear needs it to be drafting, complete or stopped.` }
      }
      if (goal.status === 'drafting') delete room.goal
      else archiveGoal(room)
      await rt.save()
      return {}
    }
    return { error: 'Nothing to do', code: 'bot/invalid' }
  }

  // The idle driver: once a round ends with the goal active and nothing running,
  // wake the admin for a goal check. Progress — a user message or a member's work
  // (the admin's own tools do not count) — only resets the check count; the round
  // still gets its check. An admin that passes waits for the user, and two checks
  // without progress mark the goal idle until something happens.
  async function goalDrive(room, round) {
    const goal = room.goal
    const admin = room.admin === undefined || room.admin === null ? undefined : rt.botOf(room.admin)
    if (goal === undefined || goal.status !== 'active' || goal.idle === true || admin === undefined || !room.members.includes(admin.id)) return
    // A round nobody spoke in — e.g. a stop notice or a stale check — never nudges.
    if (round.stoppedOnly === true || round.slots.length === 0) return
    if (round.userMessage === true || round.slots.some(slot => slot.worked === true && slot.id !== admin.id)) goal.nudges = 0
    if (round.goalNudge === true && round.slots.some(slot => slot.id === admin.id && slot.status === 'passed')) {
      goal.idle = true
      goal.revision += 1
      goal.updatedAt = Date.now()
      await rt.save()
      return
    }
    if ((rt.workingInRoom?.(room) ?? []).length > 0) return
    if (rt.roomBatchPending?.(room.id) === true) return
    if ((rt.roomInbox.get(room.id)?.length ?? 0) > 0) return
    if (goal.nudges >= GOAL_IDLE_NUDGES) {
      goal.idle = true
      goal.revision += 1
      goal.updatedAt = Date.now()
      await rt.save()
      return
    }
    goal.nudges += 1
    goal.revision += 1
    goal.updatedAt = Date.now()
    await rt.save()
    await queueGoalRelay(room, 'nudge', '[Goal check]', 'DS Bot')
  }

  // Member work can outlive the round it grew out of; the round-end check then
  // skips the room, and nothing else would wake the admin when the last of it
  // settles. Settle — no round running, nobody working, no call batch, an
  // empty inbox — runs the same check once: the fake round's one worked slot
  // only says progress happened (the work that just ended), so the check gets
  // a fresh budget.
  const SETTLE_ROUND = Object.freeze({ stoppedOnly: false, slots: Object.freeze([{ id: '', worked: true }]) })

  async function goalSettled(room) {
    if (room === undefined) return
    if ([...rt.roomProgress.values()].some(round => round.roomId === room.id)) return
    await goalDrive(room, SETTLE_ROUND)
  }

  // The user pressed stop in the group: the goal waits for them instead of
  // waking the admin through the stop-notice round.
  const goalUserStopped = (roomId) => {
    const goal = rt.roomOf(roomId)?.goal
    if (goal?.status !== 'active') return
    goal.idle = true
    goal.revision += 1
    goal.updatedAt = Date.now()
    void rt.save().catch(() => {})
  }

  // A user post in the room — its own message or a goal draft — brings the goal
  // out of its idle wait and resets the count of fruitless wakes.
  const goalUserMessage = (roomId) => {
    const goal = rt.roomOf(roomId)?.goal
    if (goal === undefined || (goal.idle === undefined && goal.nudges === 0)) return
    delete goal.idle
    goal.nudges = 0
    goal.revision += 1
    goal.updatedAt = Date.now()
    void rt.save().catch(() => {})
  }

  function taskTarget(roomId, botId) {
    const room = rt.roomOf(roomId)
    const goal = room?.goal
    if (room === undefined || goal?.status !== 'active') return undefined
    const stage = goal.stages[goal.current]
    const tasks = (stage?.tasks ?? []).filter(task => task.botId === botId && task.status !== 'done')
    if (tasks.length !== 1) return undefined
    return { room, goal, stage, task: tasks[0] }
  }

  function targetForSession(sessionId) {
    const owner = rt.groupOwners.get(sessionId)
    if (owner !== undefined) return taskTarget(owner.roomId, owner.botId)
    for (const room of Object.values(state.rooms ?? {})) {
      for (const botId of room.members ?? []) {
        if (room.sessions?.[botId] === sessionId) return taskTarget(room.id, botId)
      }
    }
    return undefined
  }

  function addEvidence(sessionId, event, now = Date.now()) {
    if (rt.readOnly() !== undefined) return false
    const callId = String(event?.data?.callId ?? '')
    if (event?.type === 'tool/call' && callId !== '') {
      callsBySession.set(`${sessionId}:${callId}`, {
        seq: Number.isInteger(event.seq) ? event.seq - 1 : 0,
        type: 'tool/call',
        time: event.time,
        data: event.data,
      })
      return false
    }
    const events = []
    if (event?.type === 'tool/result') {
      const call = callsBySession.get(`${sessionId}:${callId}`)
      if (call !== undefined) events.push(call)
    }
    events.push(event)
    const evidence = evidenceFromEvents({ sessionId, actor: { sessionId }, events })
    if (evidence.length === 0) return false
    const paths = evidence.flatMap(item => [item.artifact?.path, ...(item.diff?.paths ?? [])]).filter(Boolean)
    const invalidated = paths.length > 0 ? invalidatePaths(paths, evidence, now) : false
    const target = targetForSession(sessionId)
    if (target === undefined) return invalidated
    const { task } = target
    if (task.attempt === undefined) startTaskAttempt(task, now, { sessionId })
    const tagged = evidence.map(item => ({ ...item, attemptId: task.attempt.id }))
    const known = new Set((task.evidence ?? []).map(item => item.id))
    const added = tagged.filter(item => !known.has(item.id))
    if (added.length === 0) return invalidated
    task.evidence = [...(task.evidence ?? []), ...added].slice(-EVIDENCE_MAX)
    const last = added.at(-1)
    task.checkpoint = {
      at: now,
      attemptId: task.attempt.id,
      kind: last.state,
      summary: last.command?.text ?? last.artifact?.path ?? last.diff?.paths?.join(', ') ?? headOf(last.summary, NOTE_MAX),
      nextAction: task.task,
      sessionId,
      evidenceId: last.id,
      progressFingerprint: progressFingerprint(currentEvidence(task)),
    }
    task.attempt.updatedAt = now
    task.progress = { ...task.progress, fingerprint: task.checkpoint.progressFingerprint, state: 'moving' }
    touchGoal(target.goal, { kind: 'evidence', by: task.botId, stage: target.stage.id, text: headOf(task.checkpoint.summary, EVENT_TEXT_MAX) }, now, { keepNudges: true })
    void rt.save().catch(() => {})
    return true
  }

  function invalidatePaths(paths, evidence, now) {
    const wanted = new Set(paths)
    const facts = artifactFacts(evidence)
    let anyChanged = false
    for (const room of Object.values(state.rooms ?? {})) {
      for (const goal of [room.goal, ...(room.pastGoals ?? [])]) {
        if (goal === undefined) continue
        let changed = false
        for (const [index, stage] of goal.stages.entries()) {
          for (const task of stage.tasks) {
            if (task.verification?.state !== 'verified') continue
            const pathsForTask = new Set([
              ...Object.keys(task.verification.artifactDigests ?? {}),
              ...Object.keys(task.verification.diffDigests ?? {}),
            ])
            if (![...pathsForTask].some(path => wanted.has(path))) continue
            task.verification = invalidateAcceptance(task.verification, facts, now)
            if (task.verification.state !== 'stale') continue
            task.status = 'reported'
            task.checkpoint = { at: now, attemptId: task.attempt?.id, kind: 'reported', summary: 'A verified artifact or diff changed; acceptance must be checked again.', nextAction: `Re-run: ${stage.acceptance}` }
            stage.verification = { ...stage.verification, state: 'stale', status: 'stale', invalidatedAt: now, invalidated: task.verification.invalidated }
            if (stage.status === 'passed') stage.status = 'active'
            if (goal.current > index) goal.current = index
            for (const later of goal.stages.slice(index + 1)) if (later.status === 'passed') later.status = 'pending'
            if (goal.status === 'complete') goal.status = 'needs-review'
            goal.verification = { ...goal.verification, state: 'stale', status: 'stale', invalidatedAt: now, invalidated: task.verification.invalidated }
            touchGoal(goal, { kind: 'stale', stage: stage.id, text: 'A verified artifact or diff changed; the stage needs review.' }, now)
            changed = true
          }
        }
        if (goal.verification?.state === 'verified') {
          const boundPaths = [
            ...Object.keys(goal.verification.artifactDigests ?? {}),
            ...Object.keys(goal.verification.diffDigests ?? {}),
          ]
          if (boundPaths.some(path => wanted.has(path))) {
            goal.verification = invalidateAcceptance(goal.verification, facts, now)
            if (goal.verification.state === 'stale') {
              const index = goal.stages.findIndex(stage => stage.tasks.some(task => (task.evidence ?? []).some(item =>
                wanted.has(item.artifact?.path) || wanted.has(item.diff?.paths?.find(path => wanted.has(path))))))
              if (index !== -1) {
                const stage = goal.stages[index]
                stage.status = 'active'
                goal.current = index
                for (const later of goal.stages.slice(index + 1)) if (later.status === 'passed') later.status = 'pending'
                for (const task of stage.tasks) {
                  if (task.verification?.state === 'verified') continue
                  task.status = 'reported'
                  task.verification = { state: 'stale', status: 'stale', reason: 'A verified overall artifact or diff changed.', invalidatedAt: now }
                }
              }
              if (goal.status === 'complete') goal.status = 'needs-review'
              touchGoal(goal, { kind: 'stale', text: 'A verified overall artifact or diff changed; the goal needs review.' }, now)
              changed = true
            }
          }
        }
        if (changed) {
          anyChanged = true
          void rt.save().catch(() => {})
        }
      }
    }
    return anyChanged
  }

  function taskByIdentity(taskId, attemptId) {
    for (const room of Object.values(state.rooms ?? {})) {
      for (const goal of [room.goal, ...(room.pastGoals ?? [])]) {
        if (goal === undefined) continue
        for (const [stageIndex, stage] of goal.stages.entries()) {
          for (const task of stage.tasks) {
            if (`goal:${goal.id}:${stage.id}:${task.id}` !== taskId) continue
            if (attemptId !== undefined && task.attempt?.id !== attemptId) continue
            return { room, goal, stage, stageIndex, task }
          }
        }
      }
    }
    return undefined
  }

  function matchingTurns(events, trigger) {
    const turns = new Set()
    let turn
    for (const event of events) {
      if (event.type === 'turn/start' && Number.isInteger(event.data?.turn)) turn = event.data.turn
      else if (Number.isInteger(event.data?.turn)) turn = event.data.turn
      if (event.type !== 'user/message') continue
      const source = event.data?.source ?? {}
      const sameExchange = trigger?.exchangeId === undefined || source.exchangeId === trigger.exchangeId
      const sameTask = trigger?.taskId === undefined || source.taskId === trigger.taskId
      const sameAttempt = trigger?.attemptId === undefined || source.attemptId === trigger.attemptId
      if (sameExchange && sameTask && sameAttempt && Number.isInteger(turn)) turns.add(turn)
    }
    return turns
  }

  function reconcileEvidence(sessionId, events, trigger) {
    if (rt.readOnly() !== undefined || !Array.isArray(events) || events.length === 0) return false
    let target = trigger?.taskId === undefined ? targetForSession(sessionId) : taskByIdentity(trigger.taskId, trigger.attemptId)
    if (target === undefined && trigger?.taskId === undefined) {
      target = targetForSession(sessionId)
    }
    if (target === undefined) return false
    const turns = matchingTurns(events, trigger)
    const scoped = events.filter((event) => {
      const turn = event.data?.turn
      return turns.size === 0 || (Number.isInteger(turn) && turns.has(turn))
    })
    const evidence = evidenceFromEvents({
      sessionId,
      actor: { botId: target.task.botId, sessionId },
      events: scoped,
    }).map(item => ({ ...item, attemptId: target.task.attempt.id }))
    if (evidence.length === 0) return false
    const known = new Set((target.task.evidence ?? []).map(item => item.id))
    const added = evidence.filter(item => !known.has(item.id))
    if (added.length === 0) return false
    target.task.evidence = [...(target.task.evidence ?? []), ...added].slice(-EVIDENCE_MAX)
    const last = added.at(-1)
    target.task.checkpoint = {
      at: last.at ?? Date.now(),
      attemptId: target.task.attempt.id,
      kind: last.state,
      summary: last.command?.text ?? last.artifact?.path ?? last.diff?.paths?.join(', ') ?? headOf(last.summary, NOTE_MAX),
      nextAction: target.task.task,
      sessionId,
      evidenceId: last.id,
      progressFingerprint: progressFingerprint(currentEvidence(target.task)),
    }
    target.task.progress = { ...target.task.progress, fingerprint: target.task.checkpoint.progressFingerprint, state: 'moving' }
    touchGoal(target.goal, { kind: 'evidence', by: target.task.botId, stage: target.stage.id, text: 'Recovered pending evidence after restart.' }, Date.now(), { keepNudges: true })
    void rt.save().catch(() => {})
    return true
  }

  function bind(sessionId, info, turn) {
    if (rt.readOnly() !== undefined) return undefined
    const target = targetForSession(sessionId)
    if (target === undefined) return undefined
    const now = Date.now()
    if (target.task.attempt === undefined) startTaskAttempt(target.task, now, { sessionId })
    else target.task.attempt.sessionId = sessionId
    if (info?.exchangeId !== undefined) target.task.attempt.exchangeId = info.exchangeId
    if (Number.isInteger(turn)) target.task.attempt.turn = turn
    target.task.attempt.updatedAt = now
    void rt.save().catch(() => {})
    return { taskId: `goal:${target.goal.id}:${target.stage.id}:${target.task.id}`, attemptId: target.task.attempt.id }
  }

  function finishTurn(sessionId, outcome = 'completed') {
    if (rt.readOnly() !== undefined || outcome !== 'completed') return false
    const target = targetForSession(sessionId)
    if (target === undefined || target.task.attempt === undefined) return false
    const now = Date.now()
    target.task.progress = progressAfterTurn(target.task.progress, currentEvidence(target.task), { now })
    const stalled = target.task.progress.state === 'stalled'
    if (stalled) {
      target.task.verification = { state: 'needs-review', status: 'needs-review', reason: 'Two completed turns produced no new diff, command, artifact, or evidence.', missing: target.task.checks?.map(check => check.id) ?? [] }
      target.task.status = 'reported'
      target.task.checkpoint = { at: now, attemptId: target.task.attempt.id, kind: 'reported', summary: 'No measurable progress in repeated turns.', nextAction: 'Change the approach or report a blocker; do not repeat the same work.' }
      touchGoal(target.goal, { kind: 'stalled', stage: target.stage.id, text: `${target.task.id} made no measurable progress in two turns.` }, now)
    } else {
      target.task.attempt.updatedAt = now
    }
    void rt.save().catch(() => {})
    return stalled
  }

  const mark = (roomId, botId, from, to, note, sessionId) => {
    if (rt.readOnly() !== undefined) return false
    const room = rt.roomOf(roomId)
    if (room === undefined || !markTasks(room, botId, from, to, note)) return false
    const target = taskTarget(roomId, botId)
    if (target?.task !== undefined) {
      if (to === 'working' && target.task.attempt === undefined) startTaskAttempt(target.task, Date.now(), sessionId ? { sessionId } : undefined)
      if (target.task.attempt !== undefined) target.task.attempt.status = to === 'done' ? 'reported' : to
      if (to === 'reported' && target.task.attempt !== undefined) target.task.checkpoint = { at: Date.now(), attemptId: target.task.attempt.id, kind: 'reported', summary: note ?? 'Task reported complete.', nextAction: 'Verify the declared acceptance checks.' }
    }
    void rt.save().catch(() => {})
    return true
  }

  rt.teamTools.push(defineTool({
    name: 'group_goal',
    description: 'Set and run a group chat\'s goal: one outcome for the whole group, how to check it is done, and stages whose tasks go to members. Only the group\'s admin or a Main Bot changes it; any member can show it. Inside that group\'s own conversation the group is implied; elsewhere name it. Actions: show; draft (you are aligning the goal with the user before writing it); start (write it and begin stage 1); revise (change it when the user corrects the direction; reason required); task (set one member\'s task status or note); pass (the current stage meets its check; evidence required); rework (the current stage falls short; reason required); complete (every stage passed and the overall check is met; evidence and summary required); pause; resume; stop (reason required).',
    parameters: {
      group: { type: 'string', description: 'Exact group chat name from list_bots; leave out inside that group' },
      action: { type: 'string', required: true, enum: ['show', 'draft', 'start', 'revise', 'task', 'pass', 'rework', 'complete', 'pause', 'resume', 'stop'], description: 'What to do' },
      title: { type: 'string', description: 'Short title, up to 80 characters' },
      brief: { type: 'string', description: 'draft: what the user wants, in their words' },
      objective: { type: 'string', description: 'start, revise: the one outcome the group must reach' },
      acceptance: { type: 'string', description: 'start, revise: how to check the whole goal is done: commands or tests to run, files or results to look at, and the evidence to show' },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: ['command', 'artifact', 'diff', 'review', 'manual'] },
            label: { type: 'string' },
            required: { type: 'boolean' },
            command: { type: 'string' },
            path: { type: 'string' },
            expect: { type: 'object', additionalProperties: true },
          },
        },
        description: 'start, revise: typed overall acceptance checks in addition to each stage check',
      },
      constraints: { type: 'array', items: { type: 'string' }, description: 'start, revise: rules every member keeps, including the user\'s corrections. Replaces the list' },
      stages: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          // Not schema-required so a missing field gets the refusal text the
          // caller can fix, not a bare argument error.
          properties: {
            title: { type: 'string' },
            acceptance: { type: 'string' },
            checks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  id: { type: 'string' },
                  kind: { type: 'string', enum: ['command', 'artifact', 'diff', 'review', 'manual'] },
                  label: { type: 'string' },
                  required: { type: 'boolean' },
                  command: { type: 'string' },
                  path: { type: 'string' },
                  expect: { type: 'object', additionalProperties: true },
                },
              },
              description: 'start, revise: typed acceptance checks. command needs command and expect.exitCode; artifact/diff need path and may pin expect.digest; review needs an independent reviewer; manual is never auto-verified',
            },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  bot: { type: 'string' },
                  task: { type: 'string' },
                  checks: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: true,
                      properties: {
                        id: { type: 'string' },
                        kind: { type: 'string', enum: ['command', 'artifact', 'diff', 'review', 'manual'] },
                        label: { type: 'string' },
                        required: { type: 'boolean' },
                        command: { type: 'string' },
                        path: { type: 'string' },
                        expect: { type: 'object', additionalProperties: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        description: 'start: every stage, in order. revise: replaces the current stage and every stage after it; passed stages stay. Each stage has a title, its own check (how to tell this stage is done) and its tasks, each for one member by exact name',
      },
      bot: { type: 'string', description: 'task: the member whose task changes. rework: only this member\'s task goes back' },
      stage: { type: 'integer', description: 'task: stage number, 1 for the first; the current stage when left out' },
      status: { type: 'string', enum: ['pending', 'working', 'reported', 'done'], description: 'task: the task\'s new status' },
      note: { type: 'string', description: 'task: where the task stands, in a few words' },
      evidence: { type: 'string', description: 'pass, complete: what shows it is done: test output, changed files, check results' },
      reason: { type: 'string', description: 'revise, rework, stop: why' },
      summary: { type: 'string', description: 'complete: what the group delivered, for the user' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const member = rt.botOf(self)
      if (member === undefined) return 'Only Bots on the team can use group_goal.'
      const action = String(args.action ?? '')
      let room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId)
      if (room === undefined) {
        if (String(args.group ?? '').trim() === '') return required('group', action)
        const picked = rt.pickRoom(args.group, self)
        if (picked.error !== undefined) return picked.error
        room = picked.room
      }
      const admin = room.members.map(rt.botOf).filter(Boolean).find(bot => rt.isAdminOf(room, bot.id))
      const change = action !== 'show'
      if (change && !rt.isMain(self) && !rt.isAdminOf(room, self)) {
        return admin !== undefined
          ? `Only ${admin.name}, the admin of "${room.name}", or a Main Bot changes its goal. Tell the admin in the group.`
          : `Only a Main Bot changes the goal of "${room.name}".`
      }
      if ((action === 'draft' || action === 'start') && admin === undefined) {
        return `"${room.name}" has no admin, and a goal needs one to run it. Set an admin with update_group first.`
      }
      const of = memberOf(room)
      const names = memberNames(room)
      let result
      let next = ''
      let post
      switch (action) {
        case 'show':
          return goalLedger(room, member)
        case 'draft':
          result = draftGoal(room, { brief: args.brief, title: args.title, by: self })
          next = 'Aligning. Ask the user only what is still open, then call group_goal start.'
          break
        case 'start':
          result = startGoal(room, args, self, of, names)
          next = 'Started. Hand out the tasks of stage 1 now, with @Name in your reply.'
          break
        case 'revise':
          result = reviseGoal(room, args, self, of, names)
          next = 'Changed. Tell the group what changed, and go on with the current stage.'
          break
        case 'task':
          result = taskGoal(room, args, self, of, names)
          break
        case 'pass':
          result = passGoal(room, args, self)
          next = result.goal === undefined ? ''
            : result.goal.stages[result.goal.current] !== undefined
              ? `Stage ${result.goal.current} passed. Stage ${result.goal.current + 1} "${result.goal.stages[result.goal.current].title}" is current: hand out its tasks with @Name in this reply.`
              : 'Every stage passed. Check the overall "done when", then call group_goal complete with the evidence and a summary for the user.'
          break
        case 'rework':
          result = reworkGoal(room, args, self, of, names)
          next = 'Sent back. Call the members again with @Name and say what is missing.'
          break
        case 'complete':
          result = completeGoal(room, args, self)
          next = 'Complete. Tell the user what was delivered.'
          break
        case 'pause':
          result = pauseGoal(room, self)
          next = 'Paused. Hand out no stage work until the goal is resumed.'
          break
        case 'resume':
          result = resumeGoal(room, self)
          next = 'Resumed. Take the next step now.'
          break
        case 'stop':
          result = stopGoal(room, args.reason, self)
          next = 'Stopped.'
          // The caller keeps running; the other members' work stops.
          post = async () => {
            for (const id of room.members.filter(other => other !== self)) await rt.stopMemberWork?.(room.id, id)
          }
          break
        default:
          return `Unknown action ${action}.`
      }
      if (result.error !== undefined) return result.error
      if (result.reply !== undefined) announce(room, result.reply)
      await rt.save()
      if (post !== undefined) await post()
      const ledger = goalLedger(room, member)
      return next === '' ? ledger : `${ledger}\n${next}`
    },
  }))

  Object.assign(rt, {
    goalBlock, goalLedger, goalDraft, goalControl, goalDrive, goalSettled, goalUserMessage, goalUserStopped,
    goalTaskWorking: (roomId, botId, sessionId) => mark(roomId, botId, 'pending', 'working', undefined, sessionId),
    goalTaskReported: (roomId, botId) => mark(roomId, botId, 'working', 'reported'),
    goalTaskReset: (roomId, botId, note) => mark(roomId, botId, 'working', 'pending', note),
    goalTaskBinding: (roomId, botId) => {
      const target = taskTarget(roomId, botId)
      return target?.task?.attempt === undefined ? undefined : {
        taskId: `goal:${target.goal.id}:${target.stage.id}:${target.task.id}`,
        attemptId: target.task.attempt.id,
      }
    },
    noteGoalEvidence: addEvidence,
    reconcileGoalEvidence: reconcileEvidence,
    bindGoalAttempt: bind,
    finishGoalTurn: finishTurn,
  })
}
