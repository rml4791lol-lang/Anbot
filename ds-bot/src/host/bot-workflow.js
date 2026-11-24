import { evidenceFromEvents } from './task-evidence.js'

const META = { name: 'anbot-session-evidence', description: 'Inspect a Bot Session for evidence of completed tool calls.' }
const SCRIPT = `
const summary = { commands: 0, failures: 0, diffs: 0, deliverables: 0 }
for (const item of args) {
  if (typeof item.exitCode === 'number') {
    summary.commands++
    if (item.exitCode !== 0) summary.failures++
  }
  if (item.diff) summary.diffs++
  if (item.deliverable) summary.deliverables++
}
return summary
`
const EVENT_WINDOW = 300
const RUN_TIMEOUT_MS = 20_000

export function install(rt) {
  const { ctx } = rt
  const entries = new Map()
  let closed = false

  function botWorkflowView(botId) {
    const live = entries.get(botId)?.view
    if (live) return live
    const saved = rt.botOf(botId)?.workflowEvidence
    if (saved?.botId !== botId) return null
    if (['completed', 'cancelled', 'error'].includes(saved.status)) return saved
    return { ...saved, status: 'interrupted' }
  }

  async function persist(view) {
    const bot = rt.botOf(view.botId)
    if (bot === undefined) throw new Error('The Workflow Bot was removed')
    const previous = bot.workflowEvidence
    bot.workflowEvidence = { ...view }
    try {
      await rt.save({ required: true })
    } catch (error) {
      if (rt.botOf(view.botId) === bot) {
        if (previous === undefined) delete bot.workflowEvidence
        else bot.workflowEvidence = previous
      }
      throw error
    }
  }

  async function startBotWorkflow(botId) {
    const bot = rt.botOf(botId)
    if (bot === undefined) throw new Error('Unknown Bot')
    const sessionId = rt.chatOf(botId)
    if (entries.get(botId)?.settled !== undefined) throw new Error('A Workflow is already running for this Bot')
    if (closed) throw new Error('The Workflow service is shutting down')
    const controller = new AbortController()
    /** @type {import('./bot-workflow.js').BotWorkflowView} */
    const view = { botId, sessionId, runId: null, throughSequence: null, status: 'preparing' }
    const entry = { view, controller, settled: Promise.resolve() }
    entries.set(botId, entry)
    const prepared = Promise.withResolvers()
    entry.settled = (async () => {
      let run
      let result
      try {
        await persist(view)
        const parent = await rt.resolveAgent(sessionId)
        controller.signal.throwIfAborted()
        if (rt.botOf(botId) === undefined || rt.chatOf(botId) !== sessionId) throw new Error('The Bot Session changed. Start the Workflow again.')
        const engine = ctx.get?.('agentPresets')?.serviceFor?.(parent, 'workflowEngine') ?? ctx.get?.('workflowEngine')
        if (typeof engine?.start !== 'function') throw new Error('This DSH Agent preset has no Workflow engine. Choose a Workflow-capable preset.')
        const events = parent.session.snapshotEvents().slice(-EVENT_WINDOW)
        const args = evidenceFromEvents({ sessionId, events }).filter(item => item.state === 'executed').map(item => ({
          ...(Number.isInteger(item.command?.exitCode) ? { exitCode: item.command.exitCode } : {}),
          diff: item.diff !== undefined,
          deliverable: item.artifact !== undefined,
        }))
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)])
        run = engine.start({ parent, meta: META, script: SCRIPT, args, signal, maxTotalAgents: 1 })
        Object.assign(view, { runId: run.id, throughSequence: events.at(-1)?.seq ?? null, status: 'running' })
        await persist(view)
        prepared.resolve({ ...view })
        result = await run.result
      } catch (error) {
        result = { stopReason: controller.signal.aborted ? 'cancelled' : 'error', error: error.message }
        controller.abort(error)
      } finally {
        try {
          await run?.dispose()
        } catch (error) {
          result = { stopReason: 'error', error: 'DSH could not finish Workflow cleanup.' }
          rt.warn('ds-bot: Workflow cleanup failed for %s: %s', sessionId, error)
        }
        const final = { ...view, status: result.stopReason }
        if (result.stopReason === 'completed') final.result = result.value
        else if (typeof result.error === 'string') final.reason = rt.redactSecrets?.(result.error) ?? result.error
        try {
          await persist(final)
        } catch (error) {
          rt.warn('ds-bot: Workflow result could not be recorded for %s: %s', sessionId, error)
          final.status = 'error'
          final.reason = 'The Workflow result could not be saved.'
          delete final.result
        }
        Object.assign(view, final)
        delete entry.settled
        prepared.reject(new Error(final.reason ?? 'The Workflow did not start.'))
      }
    })()
    return prepared.promise
  }

  async function cancelBotWorkflow(botId, runId) {
    const entry = entries.get(botId)
    if (entry?.view.runId !== runId || typeof runId !== 'string') throw new Error('This Workflow run is no longer current')
    if (entry.settled !== undefined) {
      entry.view.status = 'cancelling'
      entry.controller.abort(new Error('Workflow cancelled by the user'))
      await entry.settled
    }
    return entry.view
  }

  ctx.effect(() => async () => {
    closed = true
    const active = [...entries.values()].filter(entry => entry.settled !== undefined)
    for (const entry of active) entry.controller.abort(new Error('Anbot is shutting down'))
    await Promise.allSettled(active.map(entry => entry.settled))
  }, 'ds-bot: Bot workflows')

  Object.assign(rt, { startBotWorkflow, cancelBotWorkflow, botWorkflowView })
}
