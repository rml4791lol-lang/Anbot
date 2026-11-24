const routeOf = (provider, model) => provider && model ? `${provider}/${model}` : null

function lastRequestRoute(session) {
  const events = session.snapshotEvents?.() ?? []
  const first = Number.isSafeInteger(session.inheritedEventCount) ? session.inheritedEventCount : 0
  for (let i = events.length - 1; i >= first; i -= 1) {
    const event = events[i]
    const config = event.type === 'request/context' ? event.data
      : event.type === 'request/header' ? event.data?.header?.config : undefined
    const route = routeOf(config?.provider, config?.model)
    if (route !== null) return route
  }
  return null
}

function availabilityOf(item, at) {
  const reason = item.reason
  if (item.status === 'ready') return { status: 'observed', value: 'loaded', at, source: 'session-capabilities' }
  if (item.status === 'needs-approval') return { status: 'observed', value: 'approval-required', at, source: 'session-capabilities' }
  if (item.status === 'error' || item.status === 'connecting' || item.status === 'unavailable') {
    return { status: 'observed', value: 'not-loaded', at, source: 'session-capabilities', ...(reason ? { reason } : {}) }
  }
  return {
    status: 'unavailable',
    reason: reason ?? 'DSH did not establish whether this extension is available in the Session.',
    source: 'session-capabilities',
  }
}

/** @returns {import('./harness-contracts.js').EffectiveExtension[]} */
function effectiveExtensions(capabilities) {
  if (!capabilities || capabilities.status === 'unavailable') return []
  const at = capabilities.observedAt ?? Date.now()
  return [
    ...(capabilities.skills ?? []).map(item => ({ ...item, kind: item.kind ?? 'skill' })),
    ...(capabilities.mcp ?? []).map(item => ({ ...item, kind: item.kind ?? 'mcp' })),
  ].map(item => ({
    id: item.name,
    kind: item.kind,
    availability: availabilityOf(item, at),
    observations: item.observations,
  }))
}

export async function observeBotRuntime(rt, botId, sessionId) {
  const { ctx } = rt
  const bot = rt.botOf(botId)
  if (!bot) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })
  const registry = ctx.get?.('agents')
  const agent = registry?.get?.(sessionId)
  const current = () => rt.chatOf(botId) === sessionId && registry?.get?.(sessionId) === agent
  if (!current()) throw Object.assign(new Error('This Bot moved to another Session.'), { code: 'bot/stale' })
  if (!agent?.session) return { sessionId, status: 'unavailable' }
  const selection = agent.model?.current?.()
  const route = routeOf(selection?.provider, selection?.model)
  const lastRoute = lastRequestRoute(agent.session)
  const selectedLocal = rt.isLocalAgentRoute?.(selection?.provider) === true
  const local = selectedLocal || (route === null && rt.isLocalAgentSession?.(sessionId) === true)
  const localRoute = selectedLocal ? selection.provider : local ? rt.engineOfBot?.(bot) : undefined
  const preset = ctx.get?.('agentPresets')?.inspectCompositions?.(agent.ctx)?.[0]
  const sandbox = local ? null : ctx.get?.('sandboxPolicy')?.resolve?.({ session: agent.session })?.mode ?? null
  const context = local ? null : await rt.contextBudgetOf?.(agent.session) ?? null
  const capabilities = local ? null : await rt.observeSessionCapabilities(bot, agent, selection).catch(error => ({
    status: 'unavailable', catalogObserved: false, skills: [], mcp: [], reason: rt.redactSecrets?.(error.message) ?? 'DSH could not inspect this Session.',
  }))
  const cli = localRoute ? await rt.observeLocalAgent?.(localRoute) ?? null : null
  if (!current()) throw Object.assign(new Error('This Bot moved to another Session.'), { code: 'bot/stale' })
  return { sessionId, status: 'observed', route, lastRoute, local, cli, sandbox, capabilities, extensions: effectiveExtensions(capabilities), context, recovery: rt.interruptedTurnState?.(sessionId) ?? null,
    preset: preset ? { id: preset.id, modules: [...new Set(preset.modules.map(module => module.moduleName))] } : null }
}

export { effectiveExtensions }
