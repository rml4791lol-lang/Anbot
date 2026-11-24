import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as dshSession from '@deepseek-ai/dsh-session'
import { SOURCE_KIND } from './constants.js'

const RECORD = 'plugin:anbot/model-retry'
const sameSelection = (left, right) => left?.provider === right.provider && left?.model === right.model && left?.reasoningEffort === right.reasoningEffort
const modelSelection = (provider, model, reasoningEffort) => ({ provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
const refuse = (message, code = 'bot/stale') => Object.assign(new Error(message), { code })

// A retry owns the native selection only until a later selection is recorded.
function pendingRetry(session) {
  const events = session.snapshotEvents()
  const selected = events.findLastIndex(event => event.type === 'model/selection')
  if (selected < 1) return undefined
  const record = events[selected - 1]
  if (record.type !== RECORD || record.ignorable !== true) return undefined
  const { sessionId, turn, original, selection } = record.data ?? {}
  if (sessionId !== session.id || !Number.isSafeInteger(turn) || !original?.provider || !original?.model || !selection?.provider || !selection?.model) return undefined
  return sameSelection(events[selected].data, selection) ? record.data : undefined
}

export function createModelRetry(rt) {
  const { ctx } = rt
  const watched = new WeakMap()

  function restore(agent) {
    const retry = pendingRetry(agent.session)
    if (!retry || !sameSelection(agent.model.current(), retry.selection)) return
    const bot = retry.botId ? rt.botOf?.(retry.botId) : undefined
    if (bot && (bot.model !== retry.botModel || bot.effort !== retry.botEffort)) return
    agent.model.select(retry.original)
  }

  function adopt({ agent }) {
    if (!agent?.session?.snapshotEvents || !agent.model) return
    const retry = pendingRetry(agent.session)
    if (!retry) return
    if (agent.status === 'running') watched.set(agent.session, { agent, turn: retry.turn })
    else restore(agent)
  }

  ctx.on('agent/created', adopt)
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const active = watched.get(session)
    if (!active || !(event.data?.turn >= active.turn)) return
    // Session publication forbids appending inside its observers. The loop awaits
    // the end of this turn before it can claim input for the queued one.
    queueMicrotask(() => {
      if (watched.get(session) !== active) return
      watched.delete(session)
      try { restore(active.agent) } catch (error) {
        rt.warn('anbot: failed to restore the Session model after retry: %s', error)
        active.agent.cancel({ kind: 'hook', reason: 'anbot/model-retry-restore' }, { keepInbox: true })
      }
    })
  })
  for (const agent of ctx.get?.('agents')?.list?.() ?? []) adopt({ agent })

  return async function retryBotModel(bot, { sessionId, turn, model, effort }) {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw refuse(readOnly, 'bot/read-only')
    if (rt.chatOf(bot.id) !== sessionId || !Number.isSafeInteger(turn)) throw refuse('This chat moved past the failed turn.')

    const served = (await rt.catalog({ fresh: true })).find(entry => entry.ref === model && !entry.needsKey)
    if (!served || rt.isLocalAgentRef?.(model)) throw refuse('The selected retry model is unavailable.', 'bot/model-unavailable')
    if (effort !== undefined && (typeof effort !== 'string' || effort.trim() === '')) throw refuse('Choose a valid thinking level.', 'bot/model-unavailable')
    const reasoningEffort = effort === undefined ? undefined : await rt.resolveEffort(model, effort)
    const selection = modelSelection(served.provider, served.id, reasoningEffort)
    await rt.ensureCapabilities?.(sessionId)
    const agent = await rt.resolveAgent(sessionId)
    if (await rt.workspaceHold.heldFor(agent.session)) throw refuse('Return the worktree before retrying.', 'bot/busy')
    rt.workspaceHold.assertUnheld(sessionId)
    if (rt.chatOf(bot.id) !== sessionId || rt.botOf(bot.id) !== bot) throw refuse('This chat moved past the failed turn.')
    if (agent.status !== 'idle' || agent.inbox.hasPending || bot.kickoff || rt.greetingOut?.(bot.id) || rt.interruptedTurnState?.(sessionId)) {
      throw refuse('Wait for this Session to finish its current work before retrying.', 'bot/busy')
    }
    const last = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
    if (last?.type !== 'turn/end' || last.data.turn !== turn || last.data.reason?.kind !== 'error'
      || rt.state.exchangeTurns?.[sessionId]?.includes(turn)) throw refuse('This chat moved past the failed turn.')
    const original = agent.model.current()
    if (!original || rt.isLocalAgentRoute?.(original.provider) || sameSelection(original, selection)) {
      throw refuse('Choose a different DSH model or thinking level for this retry.', 'bot/model-unavailable')
    }
    dshSession.appendPluginRecord(agent.session, RECORD, { sessionId, turn: turn + 1, original, selection,
      botId: bot.id, ...(bot.model !== undefined ? { botModel: bot.model } : {}), ...(bot.effort !== undefined ? { botEffort: bot.effort } : {}) })
    const active = { agent, turn: turn + 1 }
    watched.set(agent.session, active)
    try {
      agent.model.select(selection)
      agent.followup(createUserMessage({
        source: { kind: SOURCE_KIND, form: 'relay', role: 'continue', senderName: 'You', exchangeId: randomUUID() },
        content: [{ type: 'text', text: '[Retry after a failed turn]\nAnswer the user’s last unanswered message.' }],
      }))
    } catch (error) {
      watched.delete(agent.session)
      restore(agent)
      throw error
    }
    await ctx.sessions.flush(agent.session)
  }
}

export function install(rt) {
  if (typeof dshSession.appendPluginRecord === 'function') rt.retryBotModel = createModelRetry(rt)
}
