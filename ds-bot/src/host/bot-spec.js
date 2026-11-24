import { randomUUID } from 'node:crypto'

export const SPEC_MAX_CHARS = 4000
export const CHECKLIST_MAX_CHARS = 2000
const refuse = (code, message) => Object.assign(new Error(message), { code: `bot/${code}` })

export function botSpecPrompt(spec) {
  if (!spec?.objective && !spec?.checklist) return ''
  return ['## Current task spec from the user', 'Use this scope for the current task. Checklist markers are the user’s notes, not execution evidence.', spec.objective, spec.checklist && `Checklist:\n${spec.checklist}`].filter(Boolean).join('\n\n')
}

export function createBotSpecAccess(rt) {
  const saving = new Set()
  const ownChat = (botId, sessionId) => {
    const bot = rt.botOf(botId)
    if (bot === undefined) throw refuse('not-found', 'Unknown Bot')
    if (rt.chatOf(botId) !== sessionId) throw refuse('stale', 'The Bot moved to a different Session. Reopen its current conversation.')
    return bot
  }

  const get = (botId, sessionId) => ownChat(botId, sessionId).taskSpec ?? null

  async function save(botId, sessionId, { revision, objective, checklist }) {
    const bot = ownChat(botId, sessionId)
    if (saving.has(botId) || (bot.taskSpec?.revision ?? null) !== revision) {
      throw refuse('stale', 'The task spec changed. Reload it before saving.')
    }
    if (typeof objective !== 'string' || objective.length > SPEC_MAX_CHARS || typeof checklist !== 'string' || checklist.length > CHECKLIST_MAX_CHARS) {
      throw refuse('invalid', 'Keep the task spec within 4000 characters and the checklist within 2000 characters.')
    }
    const previous = bot.taskSpec
    const next = { revision: randomUUID(), objective: objective.trim(), checklist: checklist.trim(), updatedAt: Date.now() }
    saving.add(botId)
    bot.taskSpec = next
    try {
      await rt.save({ required: true })
      return next
    } catch (error) {
      if (previous === undefined) delete bot.taskSpec
      else bot.taskSpec = previous
      throw error
    } finally {
      saving.delete(botId)
    }
  }

  return { get, save }
}
