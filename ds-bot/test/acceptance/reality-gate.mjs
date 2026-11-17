// A deterministic component-level acceptance run over the real DS Bot runtime and
// official MCP loopback. The DSH AgentLoop is not executed here: only the agents'
// Session event and model/tool stream is scripted, while team tools, durable goal/work
// records, restart queue, task-detail projection and MCP client are real.
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRuntime } from '../../index.js'
import { fakeContext } from '../fake-ctx.js'
import { diffDigest } from '../../src/host/task-evidence.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = dirname(dirname(HERE))
const REPO = dirname(PLUGIN)
const SLEEP = ms => new Promise(resolve => setTimeout(resolve, ms))
const textBlock = text => [{ type: 'text', text }]
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const digest = value => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
const outputOf = run => [run.stdout, run.stderr].filter(Boolean).join('\n').trim()

function command(cwd, line) {
  const env = { ...process.env, NO_COLOR: '1' }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync('/bin/zsh', ['-lc', line], {
    cwd,
    encoding: 'utf8',
    env,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    command: line,
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ok: result.status === 0,
  }
}

function checked(cwd, line) {
  const result = command(cwd, line)
  if (!result.ok) throw new Error(`${line}\n${outputOf(result)}`)
  return result
}

function replaceOnce(path, from, to) {
  const source = readFileSync(path, 'utf8')
  if (!source.includes(from)) throw new Error(`fixture marker not found in ${path}`)
  writeFileSync(path, source.replace(from, to), 'utf8')
}

function prepareWorktree(runRoot) {
  const seed = join(runRoot, 'seed')
  const worktree = join(runRoot, 'forge-worktree')
  mkdirSync(seed)
  checked(REPO, `git archive HEAD | tar -x -C ${JSON.stringify(seed)}`)

  const sourceMcp = join(PLUGIN, 'src/host/local-agents/mcp.js')
  const seedMcp = join(seed, 'ds-bot/src/host/local-agents/mcp.js')
  cpSync(sourceMcp, seedMcp)
  cpSync(join(HERE, 'fixtures'), join(seed, 'ds-bot/test/acceptance/fixtures'), { recursive: true })
  replaceOnce(seedMcp, "    .filter(tool => tool.name.startsWith('mcp__'))\n", '')

  checked(seed, "git init -q && git config user.name 'Reality Gate' && git config user.email 'reality-gate@local' && git add -A && git commit -qm 'Seed MCP inventory drift'")
  const baseline = checked(seed, 'git rev-parse HEAD').stdout.trim()
  checked(seed, `git worktree add --detach ${JSON.stringify(worktree)} HEAD`)
  symlinkSync(join(PLUGIN, 'node_modules'), join(worktree, 'ds-bot/node_modules'), 'dir')

  const baselineText = readFileSync(seedMcp, 'utf8')
  const repairedText = baselineText.replace(
    "  const facts = tools\n    .map(tool => ({",
    "  const facts = tools\n    .filter(tool => tool.name.startsWith('mcp__'))\n    .map(tool => ({",
  )
  return {
    seed,
    worktree,
    baseline,
    baselineText,
    repairedText,
    expectedDiffDigest: diffDigest([{
      path: 'ds-bot/src/host/local-agents/mcp.js',
      oldText: baselineText,
      newText: repairedText,
    }]),
  }
}

function seedState() {
  const bot = (id, name, role) => ({ id, name, role, sessionId: id, createdAt: Date.now() })
  return {
    version: 1,
    mainBotIds: ['chief'],
    bots: {
      chief: bot('chief', 'Chief', 'Coordinator'),
      forge: bot('forge', 'Forge', 'Engineer'),
      prism: bot('prism', 'Prism', 'Reviewer'),
    },
    rooms: {
      r1: {
        id: 'r1', name: 'Reality Gate', members: ['chief', 'forge', 'prism'],
        mode: 'admin', admin: 'chief', named: true, log: [], seq: 0, seen: {},
      },
    },
    agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
}

async function startHost(home, durableLogs) {
  const ctx = fakeContext()
  const agents = new Map()
  let sequence = [...durableLogs.values()].flat().reduce((max, event) => Math.max(max, event.seq ?? 0), 0)
  let route
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId },
        calls,
        status: 'idle',
        inbox: { nextStep: [], nextTurn: [], remove: () => false },
        followup(message) { calls.push(message) },
        steer(message) { calls.push(message) },
        send(message) { calls.push(message) },
        cancel() {},
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      inspect: async sessionId => ({ events: durableLogs.get(sessionId) ?? [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })

  const emit = (sessionId, type, data = {}) => {
    const event = { type, seq: ++sequence, time: Date.now(), data }
    durableLogs.set(sessionId, [...(durableLogs.get(sessionId) ?? []), event])
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id: sessionId }, event)
    }
  }
  const tool = (name, args, sessionId, exec = {}) => (rt.teamTools.find(item => item.name === name) ?? ctx.registeredTools.get(name)).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    const result = await response.json()
    if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message ?? JSON.stringify(result)}`)
    return result.value
  }
  const nextTurn = sessionId => 1 + (durableLogs.get(sessionId) ?? []).filter(event => event.type === 'turn/start').length
  const turn = () => {
    let active
    return {
      begin(sessionId, message) {
        active = { sessionId, turn: nextTurn(sessionId) }
        emit(sessionId, 'turn/start', { turn: active.turn })
        emit(sessionId, 'user/message', { content: message.content, source: message.source })
        return active.turn
      },
      finish(text = '') {
        if (text !== '') emit(active.sessionId, 'assistant/message', { message: { content: textBlock(text) } })
        emit(active.sessionId, 'turn/end', { turn: active.turn, reason: { kind: 'completed' } })
      },
      get current() { return active },
    }
  }
  const stop = async () => {
    await rt.save()
    await ctx.dispose()
  }
  await tool('list_bots', {}, 'chief')
  return { ctx, rt, agents, agentOf, emit, tool, call, turn, stop }
}

async function waitFor(check, timeout = 8000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const value = await check()
    if (value) return value
    await SLEEP(25)
  }
  throw new Error('acceptance condition timed out')
}

function emitCommand(host, sessionId, turn, item) {
  const callId = `${sessionId}-${turn}-${item.command.replace(/\W+/g, '-').slice(0, 40)}`
  host.emit(sessionId, 'tool/call', { callId, name: 'bash', arguments: JSON.stringify({ command: item.command }) })
  const output = outputOf(item)
  host.emit(sessionId, 'tool/result', {
    callId,
    exitCode: item.exitCode,
    message: { ok: item.ok, exitCode: item.exitCode, content: textBlock(output) },
    ...(item.diffs?.length ? { meta: { diffs: item.diffs } } : {}),
  })
}

async function assign(host, { from, to, roomId, taskId, attemptId, name, text }) {
  const workId = randomUUID()
  host.rt.openWork(workId, { from, to, room: roomId, name })
  await host.rt.deliver({
    fromId: from, toId: to, role: 'request', exchangeId: workId,
    taskId, attemptId, text,
  })
  return workId
}

function emitEdit(host, sessionId, turn, diff) {
  const callId = `${sessionId}-${turn}-edit`
  host.emit(sessionId, 'tool/call', { callId, name: 'edit', arguments: JSON.stringify({ path: diff.path }) })
  host.emit(sessionId, 'tool/result', {
    callId,
    exitCode: 0,
    message: { ok: true, exitCode: 0, content: textBlock(`edited ${diff.path}`) },
    meta: { diffs: [diff] },
  })
}

function emitArtifact(host, sessionId, path, content) {
  host.emit(sessionId, 'deliverables/presented', {
    files: [{ path, name: path.split('/').pop(), digest: digest(JSON.stringify(content)) }],
  })
}

export async function runRealityGate() {
  const runRoot = mkdtempSync(join(tmpdir(), 'ds-bot-reality-gate-'))
  const home = join(runRoot, 'dsh-home')
  mkdirSync(home)
  const logs = new Map()
  let worktree
  let first
  let second
  try {
    worktree = prepareWorktree(runRoot)
    writeFileSync(join(home, 'state.json'), JSON.stringify(seedState()))
    first = await startHost(home, logs)

    const existingDiff = command(worktree.worktree, 'git diff --name-only HEAD')
    if (existingDiff.stdout.trim() !== '') throw new Error('the isolated worktree must start clean')
    const before = command(join(worktree.worktree, 'ds-bot'), 'node test/acceptance/fixtures/mcp-inventory-e2e.mjs')
    if (before.exitCode === 0) throw new Error('the MCP drift fixture must fail before Forge repairs it')

    const stageOneChecks = [
      { id: 'repair-diff', kind: 'diff', label: 'MCP inventory filter repaired', path: 'ds-bot/src/host/local-agents/mcp.js', expect: { digest: worktree.expectedDiffDigest } },
      { id: 'repair-command', kind: 'command', label: 'MCP repair command', command: 'node test/acceptance/fixtures/repair-mcp-drift.mjs', expect: { exitCode: 0 } },
      { id: 'forge-handoff', kind: 'artifact', label: 'Structured Forge handoff', path: 'forge-handoff.json' },
    ]
    const stageTwoChecks = [
      { id: 'review-diff', kind: 'diff', label: 'Prism inspected the actual diff', path: 'ds-bot/src/host/local-agents/mcp.js', expect: { digest: worktree.expectedDiffDigest } },
      { id: 'review-tests', kind: 'command', label: 'MCP inventory tests', command: 'node --test test/acceptance/fixtures/mcp-inventory.test.mjs', expect: { exitCode: 0 } },
      { id: 'review-inventory', kind: 'command', label: 'Official MCP inventory behavior', command: 'node test/acceptance/fixtures/mcp-inventory-e2e.mjs', expect: { exitCode: 0 } },
      { id: 'no-dsh-patch', kind: 'command', label: 'No DSH source or data patch', command: 'node test/acceptance/fixtures/no-dsh-patch.mjs', expect: { exitCode: 0 } },
      { id: 'prism-review', kind: 'artifact', label: 'Structured Prism review', path: 'prism-review.json' },
    ]
    const startReply = await first.tool('group_goal', {
      group: 'Reality Gate', action: 'start', title: 'Repair MCP inventory drift',
      objective: 'Repair the drifted MCP inventory in an isolated worktree and independently verify it.',
      acceptance: 'Forge returns a structured repair artifact; Prism verifies the actual diff, official MCP inventory behavior, tests and the no-DSH-patch invariant.',
      checks: [{ id: 'review-package', kind: 'artifact', label: 'Prism review package', path: 'prism-review.json' }],
      constraints: ['Do not patch DeepSeek Harness.', 'Do not read or write a user DSH home.'],
      stages: [
        { title: 'Repair', acceptance: 'Forge repairs MCP inventory drift and returns paths, commands, results and limitations.', checks: stageOneChecks, tasks: [{ bot: 'Forge', task: 'Repair MCP inventory drift in a temporary worktree.', checks: stageOneChecks }] },
        { title: 'Review', acceptance: 'Prism verifies the actual diff, MCP inventory, tests and no-DSH-patch invariant.', checks: stageTwoChecks, tasks: [{ bot: 'Prism', task: 'Independently review the Forge repair.', checks: stageTwoChecks }] },
      ],
    }, 'chief')
    const started = readJson(join(home, 'state.json')).rooms.r1.goal
    if (!started || started.status !== 'active' || started.stages.length !== 2) throw new Error(startReply)
    const goalId = started.id
    const definitionOfDone = started.acceptance
    await first.tool('group_goal', { group: 'Reality Gate', action: 'task', bot: 'Forge', status: 'working', note: 'Owns the repair stage.' }, 'chief')
    const forgeTask = readJson(join(home, 'state.json')).rooms.r1.goal.stages[0].tasks[0]
    const forgeTaskId = `goal:${goalId}:${started.stages[0].id}:${forgeTask.id}`
    const forgeAttemptId = forgeTask.attempt.id
    await assign(first, {
      from: 'chief', to: 'forge', roomId: 'r1', taskId: forgeTaskId, attemptId: forgeAttemptId,
      name: 'Repair MCP inventory drift',
      text: 'Repair the MCP inventory drift in the isolated worktree. Return structured changed paths, commands, results and limitations.',
    })
    const forgeCall = first.agentOf('forge').calls[0]
    const forgeTurn = first.turn()
    forgeTurn.begin('forge', forgeCall)

    const repairCommand = command(join(worktree.worktree, 'ds-bot'), 'node test/acceptance/fixtures/repair-mcp-drift.mjs')
    if (!repairCommand.ok) throw new Error(outputOf(repairCommand))
    const after = command(join(worktree.worktree, 'ds-bot'), 'node test/acceptance/fixtures/mcp-inventory-e2e.mjs')
    if (!after.ok) throw new Error(outputOf(after))
    const diffCheck = command(worktree.worktree, 'git diff --check')
    if (!diffCheck.ok) throw new Error(outputOf(diffCheck))
    const changedPaths = command(worktree.worktree, 'git diff --name-only HEAD').stdout.split('\n').filter(Boolean)
    const newText = readFileSync(join(worktree.worktree, 'ds-bot/src/host/local-agents/mcp.js'), 'utf8')
    const actualDiff = {
      path: changedPaths[0],
      oldText: worktree.baselineText,
      newText,
    }
    const forgeHandoff = {
      schema: 1,
      owner: { name: 'Forge', role: 'Engineer' },
      changedPaths,
      commands: [before, repairCommand, after, diffCheck].map(item => ({ command: item.command, exitCode: item.exitCode, result: outputOf(item).replaceAll(runRoot, '<temporary-run>').slice(0, 4000) })),
      results: { inventory: JSON.parse(after.stdout.trim()), diffDigest: diffDigest([actualDiff]) },
      limitations: 'The model turn is scripted DSH Session data; source edits, official MCP loopback behavior, team tools, persistence and restart recovery are executed by the acceptance harness.',
    }
    writeFileSync(join(runRoot, 'forge-handoff.json'), JSON.stringify(forgeHandoff, null, 2))
    emitCommand(first, 'forge', forgeTurn.current.turn, repairCommand)
    emitEdit(first, 'forge', forgeTurn.current.turn, actualDiff)
    emitCommand(first, 'forge', forgeTurn.current.turn, after)
    emitArtifact(first, 'forge', 'forge-handoff.json', forgeHandoff)
    forgeTurn.finish('Forge repaired the drift and returned the structured handoff.')
    await waitFor(() => first.agentOf('chief').calls.length === 1)
    const forgeResult = first.agentOf('chief').calls[0]
    const forgedTask = first.rt.roomOf('r1').goal.stages[0].tasks[0]
    const passedOne = await first.tool('group_goal', { group: 'Reality Gate', action: 'pass', evidence: 'Forge command, diff and handoff artifact passed typed checks.' }, 'chief')
    const afterStageOne = readJson(join(home, 'state.json')).rooms.r1.goal
    if (afterStageOne.stages[0].verification?.state !== 'verified' || afterStageOne.current !== 1) throw new Error(`${passedOne}\n${JSON.stringify({ task: forgedTask, saved: afterStageOne.stages[0].tasks[0] }, null, 2)}`)

    const chiefTurn = first.turn()
    chiefTurn.begin('chief', forgeResult)
    await first.tool('group_goal', { group: 'Reality Gate', action: 'task', bot: 'Prism', status: 'working', note: 'Owns independent review.' }, 'chief')
    const prismTaskState = readJson(join(home, 'state.json')).rooms.r1.goal.stages[1].tasks[0]
    const prismTaskId = `goal:${goalId}:${started.stages[1].id}:${prismTaskState.id}`
    const prismAttemptId = prismTaskState.attempt.id
    const prismWorkId = await assign(first, {
      from: 'chief', to: 'prism', roomId: 'r1', taskId: prismTaskId, attemptId: prismAttemptId,
      name: 'Review the MCP repair',
      text: 'Review the Forge repair. Check the actual diff, MCP inventory behavior, tests and the no-DSH-patch invariant.',
    })
    chiefTurn.finish('Review assigned to Prism after Forge returned.')
    const queued = await waitFor(() => {
      try { return (readJson(join(home, 'inflight.json')).queued?.prism ?? []).length > 0 } catch { return false }
    })
    if (!queued) throw new Error('the Prism handoff was not durable before restart')
    const prismPickupsBeforeRestart = 0
    if (logs.get('prism')?.some(event => event.type === 'user/message' && event.data?.source?.taskId === prismTaskId)) {
      throw new Error('Prism started before the forced restart')
    }
    await first.stop()
    first = undefined

    second = await startHost(home, logs)
    const prismCall = await waitFor(() => second.agentOf('prism').calls[0], 10_000)
    await SLEEP(250)
    assertNoDuplicates(second.agentOf('prism').calls)
    const prismTurn = second.turn()
    prismTurn.begin('prism', prismCall)
    const recoveryDetail = await waitFor(async () => {
      const detail = await second.call('task-detail', { taskId: prismTaskId })
      const handoff = await second.call('task-detail', { taskId: `handoff:${prismWorkId}` })
      return detail.recovery?.records?.length > 0 ? { ...detail, handoff: handoff.handoff } : false
    })
    const prismPickupsAfterRestart = durableLogsFor(logs, 'prism').filter(event => event.type === 'user/message' && event.data?.source?.taskId === prismTaskId).length
    if (prismPickupsAfterRestart !== 1) throw new Error(`Prism picked up ${prismPickupsAfterRestart} times`)

    const reviewDiff = command(worktree.worktree, 'git diff --check')
    const reviewTests = command(join(worktree.worktree, 'ds-bot'), 'node --test test/acceptance/fixtures/mcp-inventory.test.mjs')
    const reviewInventory = command(join(worktree.worktree, 'ds-bot'), 'node test/acceptance/fixtures/mcp-inventory-e2e.mjs')
    const noDshPatch = command(join(worktree.worktree, 'ds-bot'), 'node test/acceptance/fixtures/no-dsh-patch.mjs')
    for (const item of [reviewDiff, reviewTests, reviewInventory, noDshPatch]) {
      if (!item.ok) throw new Error(outputOf(item))
    }
    const review = {
      schema: 1,
      owner: { name: 'Prism', role: 'Reviewer' },
      taskId: prismTaskId,
      attemptId: prismAttemptId,
      checks: {
        diff: { verified: diffDigest([actualDiff]) === worktree.expectedDiffDigest, command: reviewDiff.command, exitCode: reviewDiff.exitCode },
        tests: { verified: reviewTests.exitCode === 0, command: reviewTests.command, exitCode: reviewTests.exitCode, result: outputOf(reviewTests).replaceAll(runRoot, '<temporary-run>').slice(0, 4000) },
        inventory: { verified: reviewInventory.exitCode === 0, result: JSON.parse(reviewInventory.stdout.trim()), command: reviewInventory.command },
        noDshPatch: { verified: noDshPatch.exitCode === 0, result: JSON.parse(noDshPatch.stdout.trim()), command: noDshPatch.command },
      },
      limitations: 'This is a mock-model acceptance run, not evidence of a paid production model turn.',
    }
    writeFileSync(join(runRoot, 'prism-review.json'), JSON.stringify(review, null, 2))
    emitCommand(second, 'prism', prismTurn.current.turn, { ...reviewDiff, diffs: [actualDiff] })
    emitCommand(second, 'prism', prismTurn.current.turn, reviewTests)
    emitCommand(second, 'prism', prismTurn.current.turn, reviewInventory)
    emitCommand(second, 'prism', prismTurn.current.turn, noDshPatch)
    emitArtifact(second, 'prism', 'prism-review.json', review)
    prismTurn.finish('Prism verified the repair and returned the typed review package.')
    const passedTwo = await second.tool('group_goal', { group: 'Reality Gate', action: 'pass', evidence: 'Prism verified diff, inventory, tests and the no-DSH-patch invariant.' }, 'chief')
    const afterStageTwo = readJson(join(home, 'state.json')).rooms.r1.goal
    if (afterStageTwo.stages[1].verification?.state !== 'verified') throw new Error(passedTwo)
    const completeReply = await second.tool('group_goal', {
      group: 'Reality Gate', action: 'complete',
      evidence: 'Prism review package passed every typed stage and overall check.',
      summary: 'MCP inventory drift repaired and independently verified in an isolated worktree.',
    }, 'chief')
    const completed = readJson(join(home, 'state.json')).rooms.r1.goal
    if (completed.status !== 'complete') throw new Error(completeReply)

    const activity = await second.call('team-activity')
    const prismGoalTask = activity.tasks.find(task => task.source === 'goal' && task.ownerName === 'Prism')
    const detail = await second.call('task-detail', { taskId: prismGoalTask.id })
    if (detail.verification?.status !== 'verified') throw new Error(`unexpected verification: ${JSON.stringify(detail.verification)}`)
    const typedEvidence = detail.evidence.filter(item => ['executed', 'verified'].includes(item.trust))
    const result = {
      schema: 2,
      scenario: 'chief-forge-prism-mcp-repair',
      generatedAt: new Date().toISOString(),
      outcome: 'component-verified',
      mocking: 'scripted-model-acceptance-only',
      agentLoop: {
        executed: false,
        mode: 'scripted-session-events',
        seam: 'The DSH Session event and model/tool stream is supplied by this harness instead of @deepseek-ai/dsh-agent-loop-testkit.',
      },
      followUpGate: {
        required: true,
        status: 'not-run',
        requirement: 'Before claiming end-to-end AgentLoop or production-model verification, run this scenario through @deepseek-ai/dsh-agent-loop-testkit with the real DS Bot tools and real DSH Session events.',
      },
      chief: {
        role: 'Coordinator',
        view: 'Reality Gate',
        stages: [
          { title: 'Repair', owner: 'Forge', checks: stageOneChecks.map(check => check.id) },
          { title: 'Review', owner: 'Prism', checks: stageTwoChecks.map(check => check.id) },
        ],
        definitionOfDone,
      },
      forge: {
        role: 'Engineer',
        taskId: `goal:${goalId}:${completed.stages[0].id}:${completed.stages[0].tasks[0].id}`,
        attemptId: forgeAttemptId,
        worktree: { isolated: true, baselineCommit: worktree.baseline, changedPaths },
        handoff: forgeHandoff,
      },
      restart: {
        boundary: 'after-forge-durable-result-before-prism-pickup',
        hostStarts: 2,
        sameTaskId: prismTaskId,
        sameAttemptId: prismAttemptId,
        queuedBeforeRestart: true,
        prismPickupsBeforeRestart,
        prismPickupsAfterRestart,
        recoveryKind: recoveryDetail.recovery.records[0].kind,
      },
      prism: {
        taskId: prismTaskId,
        attemptId: prismAttemptId,
        handoffTaskId: `handoff:${prismWorkId}`,
        checks: review.checks,
        review,
      },
      detail: {
        owner: { role: recoveryDetail.owner.role },
        attempt: recoveryDetail.attempt,
        handoff: recoveryDetail.handoff,
        checkpoint: recoveryDetail.checkpoint,
        recovery: recoveryDetail.recovery,
      },
      verification: { status: detail.verification.status, reason: detail.verification.reason },
      typedEvidence: typedEvidence.map(item => ({ id: item.id, trust: item.trust, title: item.title, text: item.text, sourceId: item.sourceId })),
      mockSeams: [
        'scripted DSH Session events replace a paid model response',
        'in-memory DSH agent handles replace Desktop/Web GUI processes',
        'temporary DSH_HOME is created under the OS temp directory and removed',
        'the isolated git worktree is created and removed only by this harness',
      ],
      limitations: [
        'The DSH AgentLoop is not executed; its Session events and model/tool choice are scripted, and no production model claim is made.',
        'This is component-level evidence for the existing DS Bot runtime, team tools, persistence, recovery, task projections and official MCP loopback under that scripted seam.',
        'A real AgentLoop testkit run remains a required follow-up gate before calling this end-to-end or production verification.',
        'No commit, push, deployment, external message or paid operation is performed.',
      ],
    }
    return result
  } finally {
    if (first) await first.stop().catch(() => {})
    if (second) await second.stop().catch(() => {})
    if (worktree) {
      command(worktree.seed, `git worktree remove --force ${JSON.stringify(worktree.worktree)}`)
      command(worktree.seed, 'git worktree prune')
    }
    rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

function durableLogsFor(logs, sessionId) {
  return logs.get(sessionId) ?? []
}

function assertNoDuplicates(calls) {
  if (calls.length !== 1) throw new Error(`expected one queued Prism delivery, got ${calls.length}`)
}
