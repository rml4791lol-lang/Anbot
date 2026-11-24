import { isLocalAgentRoute } from './local-agents/engines.js'
import { checkpointTaskRef, normalizeTaskRef, sameTaskRef } from './bot-checkpoint.js'

export async function createCheckpointSession(ctx, record, worktree, id, writable) {
  const agents = ctx.get('agents')
  const presets = ctx.get('agentPresets')
  const query = ctx.get('sessionQuery')
  const directories = ctx.get('workingDirectory')
  const permissions = ctx.get('permissionPresets')
  const sandbox = ctx.get('sandboxPolicy')
  const models = ctx.get('agentDefaultModel')
  if (!agents || !presets || !query || !directories || !permissions || !sandbox || !models) {
    throw new Error('This DSH profile cannot create an isolated writable checkpoint Session.')
  }
  const [{ installModelSelection }, { buildForkSeed, SessionId, SessionLogOffset, SessionSeq }] = await Promise.all([
    import('@deepseek-ai/dsh-agent'), import('@deepseek-ai/dsh-session'),
  ])
  const mode = writable ? 'workspace-write' : 'read-only'
  permissions.resolve(mode)
  const observation = await query.observeSession(record.sessionId)
  let seed
  let preset
  try {
    const through = SessionSeq(record.throughSequence)
    if (observation.events[through]?.seq !== through) throw new Error('The checkpoint conversation boundary no longer exists.')
    // Capture verified the live task or close ledger. A later attempt or
    // ledger rotation cannot invalidate the task stored in the durable prefix.
    if (record.task !== undefined) {
      const boundaryTask = checkpointTaskRef(observation.events, record.throughSequence)
      if (!sameTaskRef(boundaryTask, normalizeTaskRef(record.task))) {
        throw new Error('The checkpoint Session boundary does not belong to its recorded TaskRef.')
      }
    }
    seed = buildForkSeed(observation.events, through)
    preset = (await presets.resolve(observation.projections?.values.agentPreset ?? undefined)).id
  } finally { observation[Symbol.dispose]() }

  const sessionId = SessionId(id)
  const handle = await agents.create({
    sessionId,
    seed,
    inheritedEventCount: SessionLogOffset(record.throughSequence + 1),
    meta: { cwd: worktree, isSeeded: true, agentPreset: preset },
    agentOptions: models.currentSelection(),
    setup: async (scope, agent) => {
      installModelSelection(scope)
      await presets.mount(scope, preset)
      if (isLocalAgentRoute(agent.model.current()?.provider)) throw new Error('The checkpoint uses a local Agent without writable restore support.')
      await directories.set(agent, worktree)
      permissions.set(agent.session, mode)
      const policy = sandbox.resolve({ session: agent.session })
      if (policy.mode !== mode || policy.workspaceRoot !== worktree || policy.additionalWritableRoots?.length) {
        throw new Error('DSH could not constrain the restored Session to its worktree.')
      }
      await ctx.sessions.flush(agent.session)
    },
  })
  return handle
}
