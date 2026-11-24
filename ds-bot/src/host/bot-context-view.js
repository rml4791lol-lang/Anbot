/**
 * Follow DSH's retained nodes and explicit citations. A positional replacement's
 * endpoints describe the surface, so the numeric interval can contain unrelated log events.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @returns {Omit<import('./bot-context-view.js').ContextProjection, 'usedTokens' | 'limitTokens'> | undefined}
 */
function captureProjection(session) {
  const nodes = session.surface?.nodes
  if (nodes === undefined) return undefined
  const events = session.snapshotEvents()
  const retainedMessageIds = nodes.flatMap(seq => {
    const message = session.deriveEventMessage(events[seq])
    return message === null ? [] : [message.id]
  })
  const pending = [...nodes]
  const sources = new Set()
  const replacements = []
  while (pending.length > 0) {
    const sequence = pending.pop()
    if (sources.has(sequence)) continue
    const event = events[sequence]
    sources.add(sequence)
    for (const source of event.sourceEventSeqs ?? []) pending.push(source)
    const op = event.surfaceOp
    if (op?.op === 'replace') {
      replacements.push({ sequence, start: op.startSeq, end: op.endSeq, sourceSequences: [...event.sourceEventSeqs] })
    }
  }
  const sourceRanges = []
  for (const seq of [...sources].sort((a, b) => a - b)) {
    const last = sourceRanges.at(-1)
    if (last?.through === seq - 1) last.through = seq
    else sourceRanges.push({ from: seq, through: seq })
  }
  replacements.sort((a, b) => a.sequence - b.sequence)
  return { sessionId: session.id, throughSequence: events.length - 1, retainedMessageIds, sourceRanges, replacements }
}

/**
 * Report the same pressure and thresholds the Bot's context steward uses.
 * Snapshot the native meter before resolving the request's model limits.
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {{ measure: (session: import('@deepseek-ai/dsh-session').Session) => ReturnType<import('@deepseek-ai/dsh-token-meter').TokenMeter['measure']> | undefined,
 *   limits: (route: { provider: string, model: string, maxTokens?: number }) => Promise<{ window: number, usable: number, check: number, hard: number } | undefined> }} reader
 * @returns {Promise<import('./bot-context-view.js').ContextBudget>}
 */
export async function observeContextBudget(session, { measure, limits }) {
  const projection = captureProjection(session)
  const route = session.requestHeader()?.config
  const hasRoute = Boolean(route?.provider && route?.model)
  const snapshot = hasRoute ? measure(session) : undefined
  const at = Date.now()
  const measured = snapshot?.nodes && Number.isSafeInteger(snapshot.logRevision) && Number.isFinite(snapshot.totalTokens)
    && (projection === undefined || snapshot.logRevision === projection.throughSequence + 1)
  const capacity = hasRoute && (measured || projection !== undefined) ? await limits(route).catch(() => undefined) : undefined
  const reason = !hasRoute ? 'no-request' : !measured ? 'meter-unavailable' : 'capacity-unavailable'
  /** @type {{ projection?: import('./bot-context-view.js').ContextProjection }} */
  const evidence = projection === undefined ? {} : {
    projection: {
      ...projection,
      usedTokens: measured ? { status: 'observed', value: snapshot.totalTokens, at, source: 'DSH TokenMeter' }
        : { status: 'unavailable', reason: hasRoute ? 'meter-unavailable' : 'no-request' },
      limitTokens: capacity === undefined ? { status: 'unavailable', reason: hasRoute ? 'capacity-unavailable' : 'no-request' }
        : { status: 'observed', value: capacity.window, at, source: 'DSH model catalog' },
    },
  }
  if (!measured || capacity === undefined) return { status: 'unavailable', reason, ...evidence }
  return { status: 'observed', throughSequence: snapshot.logRevision - 1, usedTokens: snapshot.totalTokens,
    measuredFrom: snapshot.baseline.kind, ...capacity, surfaceNodes: snapshot.nodes.length, ...evidence }
}
