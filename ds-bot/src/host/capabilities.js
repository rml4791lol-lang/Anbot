import { createHash } from 'node:crypto'
import { encodeUrlComponent } from './secrets.js'
import { own } from './store.js'
import { catalogEntries, catalogSignature, validateShortlistAgainstCatalog } from './skill-catalog.js'
import { fitSkillShortlist, readSkillShortlist, SKILL_PURPOSE_MAX, SKILL_SHORTLIST_MAX } from './skill-shortlist.js'
import { activeTasksOf } from './threads.js'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SECRET_REFERENCE = /\$DSH_SECRET_([A-Z][A-Z0-9_]*)/g
const ENSURE_TIMEOUT_MS = 15_000
const CATALOG_READ_ATTEMPTS = 5
const CATALOG_READ_RETRY_MS = 25
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/

// DSH injects a directly invoked skill's body from its own `agent/pre-step`
// listener. Denying the `skill` tool does not cover that path, so a strict mask
// failure must reject a step that carries such a gesture until reconciliation
// succeeds. Ordinary messages still run without skill access.
export function skillMaskPreStepGate(unavailable) {
  return async function rejectUnavailableSkillGestures({ agent, messages }, next) {
    if (!unavailable.has(agent)) return next()
    const invokesSkill = (Array.isArray(messages) ? messages : []).some(message =>
      message?.source?.kind === 'user'
      && Array.isArray(message.content)
      && message.content.some(block => block?.type === 'text'
        && typeof block.text === 'string'
        && SKILL_GESTURE.test(block.text)))
    return invokesSkill ? { kind: 'reject' } : next()
  }
}

// Connector ids are reserved: a capability named like one would collide with
// its mcp__<id>__* tool prefix. The connectors module registers its ids here.
export const CONNECTOR_IDS = new Set(['github', 'mail'])
export function validateCapabilityName(value, reserved = CONNECTOR_IDS) {
  const name = String(value ?? '').trim()
  if (name.length > 32 || !NAME.test(name) || name === 'github' || reserved.has(name)) {
    throw new Error('Use a capability name with lowercase letters, digits, and single hyphens; connector names are reserved.')
  }
  return name
}

export function expandCapabilityNames(capabilities, library) {
  const expanded = new Set()
  for (const name of capabilities ?? []) {
    const item = own(library, name)
    if (!item) throw new Error(`No capability named ${name}.`)
    if (item.kind === 'pack') {
      for (const childName of item.items ?? []) {
        const child = own(library, childName)
        if (!child || !['mcp', 'skill'].includes(child.kind)) throw new Error(`Pack ${name} refers to an unavailable capability ${childName}.`)
        expanded.add(childName)
      }
    } else if (item.kind === 'mcp' || item.kind === 'skill') {
      expanded.add(name)
    } else {
      throw new Error(`Capability ${name} has an unknown kind.`)
    }
  }
  return expanded
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const strings = value => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Arguments must be a list of text values.')
  return [...value]
}
const stringMap = (value, label) => {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some(item => typeof item !== 'string')) throw new Error(`${label} must contain text values.`)
  return Object.fromEntries(Object.entries(value))
}

export function install(rt) {
  const { ctx, state } = rt
  const agents = new Map()
  // Mounted fibers live in each Agent's own context, so they outlive this plugin unless
  // its cleanup disposes them; a strong map keeps them reachable for that.
  const mounts = new Map()
  // One reconcile chain per Agent: a slow MCP server holds up only its own Agent.
  const chains = new WeakMap()
  const queued = new WeakSet()
  const sessionStatuses = new Map()
  const loaded = new Map()
  const pendingDrops = new Map()
  const frozenCatalogs = new Map()
  let statusesCache
  let statusesKey
  let pluginPromise
  let scheduled = null
  let loadingSecrets = 0
  let stopped = false
  // Mask fibers per Agent: profile skills hidden by a Bot's shortlist.
  const skillMasks = new Map()
  const skillMaskUnavailable = new Map()
  let masking = 0
  let skillChangePending = false
  let catalogCache = []
  // Every mask registers skill entries in the Agent scope, which invalidates
  // the global skill catalog revision. Two Agents doing that at once would make
  // a strict snapshot permanently look incomplete during startup.
  let maskChain = Promise.resolve()
  let newBotCatalog = []

  const library = () => state.capabilities.items
  const ensureLibrary = () => {
    state.capabilities ??= { items: {} }
    state.capabilities.items ??= {}
    return library()
  }
  const writeCheck = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
  }
  const allowedToEdit = (item, botId) => rt.isMain(botId) || item.createdBy === botId
  const usedByOthers = (name, botId) => Object.values(state.bots).some(bot => bot.id !== botId
    && [...(bot.capabilities ?? []), ...(bot.packs ?? [])].some((attached) => {
      const item = own(library(), attached)
      return attached === name || (item?.kind === 'pack' && (item.items ?? []).includes(name))
    })
    || (own(library(), name)?.kind === 'skill'
      && bot.id !== botId && (bot.skillShortlist ?? []).some(skill => skill.name === name)))
  const skillItems = () => Object.values(library()).filter(item => item?.kind === 'skill' && typeof item.name === 'string')
  // DSH's catalog is a merge over providers and follows symbolic links; never a
  // directory scan. An Agent's own scope is the only place masks are registered.
  const skillCwd = ({ agent, botId } = {}) => {
    try {
      return agent?.session?.header?.cwd
        ?? (botId === undefined ? undefined : rt.workDirOf?.({ botId }))
        ?? rt.teamFolder?.()
        ?? process.cwd()
    } catch {
      // A host without its workspace services still has a process folder.
      return process.cwd()
    }
  }
  // A preset publishes its services in a per-session scope. `agent.ctx.skills`
  // does not necessarily address that instance, so ask the preset roster for
  // the agent's own service first; the host-plane registry is the fallback for
  // callers that have no live agent (the settings picker before a session).
  const presetSkillService = (agent) => {
    if (agent === undefined) return undefined
    try { return ctx.get?.('agentPresets')?.serviceFor?.(agent, 'skills') } catch { return undefined }
  }
  const hostSkillService = () => {
    try { return ctx.get?.('skills') } catch { return undefined }
  }
  const scopedSkillService = (agent) => {
    let service = presetSkillService(agent)
    try { service ??= agent?.ctx?.skills } catch { /* the caller has no skill scope */ }
    return service
  }
  const listProfileSkills = async ({ agent, cwd, strict = false } = {}) => {
    // An agent-scoped read sees the preset's providers; a host read sees the
    // root `ds-bot-profile` provider mounted by cordis.patch.yml. A test
    // embedder with neither simply has no profile catalog.
    const service = scopedSkillService(agent) ?? hostSkillService()
    if (typeof service?.list !== 'function' && typeof service?.snapshot !== 'function') return []
    if (strict && typeof service.snapshot !== 'function') throw new Error('This DSH cannot verify the skill catalog.')
    const options = { cwd, ...(agent === undefined ? {} : { scope: agent }) }
    try {
      if (typeof service.snapshot === 'function') {
        let snapshot
        for (let attempt = 0; attempt < CATALOG_READ_ATTEMPTS; attempt += 1) {
          snapshot = await service.snapshot(options)
          if (!strict || snapshot?.complete === true) break
          if (attempt + 1 < CATALOG_READ_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, CATALOG_READ_RETRY_MS * (2 ** attempt)))
          }
        }
        if (strict && snapshot?.complete !== true) throw new Error('The skill catalog is incomplete.')
        if (Array.isArray(snapshot?.skills)) return snapshot.skills
      }
      return typeof service.list === 'function' ? await service.list(options) : []
    } catch (error) {
      if (agent === undefined || strict) throw error
      // A scope that cannot be read falls back to the profile view rather than
      // hiding the whole catalog from validation.
      if (typeof service.snapshot === 'function') {
        try {
          const snapshot = await service.snapshot({ cwd })
          if (Array.isArray(snapshot?.skills)) return snapshot.skills
        } catch { /* fall through to list */ }
      }
      return typeof service.list === 'function' ? service.list({ cwd }) : []
    }
  }
  // Reportable before/after evidence for the host-side catalog: the service
  // exists, but an empty provider layer is the failure this fixes.
  rt.skillCatalogDiagnostics = async () => {
    const host = hostSkillService()
    const out = { hostService: host !== undefined, hostProviderRead: false }
    if (typeof host?.list !== 'function') return out
    try {
      const skills = await host.list({ cwd: skillCwd({}) })
      out.hostProviderRead = true
      out.hostSkillCount = skills.length
      out.hostSkillNames = skills.slice(0, 8).map(skill => skill.name)
    } catch (error) {
      out.hostError = error instanceof Error ? error.message : String(error)
    }
    return out
  }
  const buildCatalog = async (options = {}) => catalogEntries(
    await listProfileSkills({ agent: options.agent, cwd: options.cwd ?? skillCwd(options), strict: options.strict === true }),
    skillItems(),
    { includeMasked: options.includeMasked === true, strict: options.strict === true },
  )
  async function refreshSkillCatalog({ publish = true } = {}) {
    const before = rt.skillCatalogSignature()
    try {
      const bots = Object.values(state.bots ?? {})
      const byCwd = new Map()
      const merged = new Map()
      const readAt = async cwd => {
        if (!byCwd.has(cwd)) byCwd.set(cwd, await buildCatalog({ cwd }))
        return byCwd.get(cwd)
      }
      const defaultCatalog = await readAt(skillCwd({}))
      if (bots.length === 0) {
        catalogCache = defaultCatalog
      } else {
        for (const bot of bots) {
          for (const skill of await readAt(skillCwd({ botId: bot.id }))) {
            const previous = merged.get(skill.name)
            const variant = { ...skill }
            if (previous === undefined) {
              merged.set(skill.name, { ...variant, bots: [bot.id], byBot: { [bot.id]: variant } })
            } else {
              if (!previous.bots.includes(bot.id)) previous.bots.push(bot.id)
              previous.byBot[bot.id] = variant
            }
          }
        }
        catalogCache = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
      }
      newBotCatalog = defaultCatalog
    } catch (error) {
      rt.warn('ds-bot: skill catalog could not be read: %s', error)
    }
    // Do not make every save look like a catalog change. The live key is only
    // useful when the catalog actually moved (install, remove, rename, or scope).
    if (publish && rt.skillCatalogSignature() !== before) rt.publishFeed?.('live', {})
    return catalogCache
  }
  // Validation and masking read the same view, so a name the picker shows is a
  // name the host accepts and a name the picker omits is a name execution hides.
  // The client filters `bots` for its Bot; a no-id caller still sees the union.
  rt.skillCatalogView = botId => botId === undefined
    ? catalogCache
    : catalogCache
      .filter(skill => !Array.isArray(skill.bots) || skill.bots.includes(botId))
      .map(skill => skill.byBot?.[botId] === undefined ? skill : { ...skill, ...skill.byBot[botId] })
  rt.newBotSkillCatalogView = () => newBotCatalog
  rt.skillCatalogSignature = () => JSON.stringify([catalogSignature(catalogCache), catalogSignature(newBotCatalog)])
  rt.refreshSkillCatalog = refreshSkillCatalog
  // Plugin-provided skills (ppt-studio, graphlint, office-docx, …) are registered
  // in the Agent's own scope by the preset's plugins and never reach the host
  // registry. Masking already runs at that layer, so validation has to see the
  // same names: read the Bot's live Agents and accept their union with the host
  // catalog. A Bot with no Agent yet keeps the host-only result.
  const liveBotAgents = async botId => {
    const live = []
    const add = sessionId => {
      const agent = typeof sessionId === 'string' ? agents.get(sessionId)?.deref() : undefined
      if (agent !== undefined && !live.includes(agent)) live.push(agent)
    }
    try {
      add(rt.chatOf(botId))
    } catch (error) {
      rt.warn('ds-bot: skill validation chat session for %s unreadable: %s', botId, error)
    }
    try {
      for (const sessionId of rt.groupSessionsOf(botId) ?? []) add(sessionId)
    } catch (error) {
      rt.warn('ds-bot: skill validation group sessions for %s unreadable: %s', botId, error)
    }
    if (live.length > 0) return live
    // Saving a policy already resolves this Agent before mounting, so the same
    // lookup here cannot create a Session the Bot would not have had.
    try {
      const agent = await rt.resolveAgent(rt.chatOf(botId))
      if (agent !== undefined) {
        try { trackAgent(agent) } catch { /* an Agent this build cannot track is still readable */ }
        live.push(agent)
      }
    } catch (error) {
      rt.warn('ds-bot: skill validation Agent for %s could not be resolved: %s', botId, error)
    }
    return live
  }
  rt.validateSkillShortlist = async (list, options = {}) => {
    if (list === undefined) return undefined
    const cwd = options.cwd ?? skillCwd(options)
    let catalog = await buildCatalog({ ...options, cwd })
    if (options.botId !== undefined) {
      const byName = new Map(catalog.map(skill => [skill.name, skill]))
      for (const agent of await liveBotAgents(options.botId)) {
        let scoped
        try {
          scoped = catalogEntries(await listProfileSkills({ agent, cwd }), skillItems(), { includeMasked: true })
        } catch (error) {
          rt.warn('ds-bot: skill validation catalog for %s unreadable: %s', options.botId, error)
          continue
        }
        for (const skill of scoped) if (!byName.has(skill.name)) byName.set(skill.name, skill)
      }
      catalog = [...byName.values()]
    }
    // A sixth selection is fitted, not refused: the capability skills in this catalog
    // keep their slots, and the remaining ones go to the most recently added. The
    // caller gets the list it can save, and the Bot's diagnostics say what went.
    const capability = new Set(catalog.filter(skill => skill.source === 'capability').map(skill => skill.name))
    const { list: fitted, dropped } = fitSkillShortlist(list, { capability })
    // Checked before the log, so a name that fails here leaves no "trimmed" note behind.
    const checked = validateShortlistAgainstCatalog(fitted, catalog)
    if (dropped.length > 0) {
      rt.warn('ds-bot: skill shortlist for %s trimmed to %d; dropped %s', options.label ?? options.botId ?? 'a Bot', SKILL_SHORTLIST_MAX, dropped.join(', '))
    }
    return checked
  }
  // Hide every profile skill this Bot did not choose. Registration goes through a
  // plugin mounted in the Agent's own context, so the mask lands in the Agent layer
  // and outranks the global profile entry; copied SKILL.md text would not.
  async function applySkillMasksNow(agent, bot, mountedSkills = new Set()) {
    if (!agent?.ctx) return
    const current = skillMasks.get(agent)
    const hide = new Map()
    if (Array.isArray(bot?.skillShortlist)) {
      const chosen = new Set(bot.skillShortlist.map(skill => skill.name))
      const profile = catalogEntries(
        await listProfileSkills({ agent, botId: bot.id, cwd: skillCwd({ agent, botId: bot.id }), strict: true }),
        [],
        { includeMasked: true },
      )
      const capabilities = new Set(skillItems().map(skill => skill.name))
      for (const skill of profile) {
        // A chosen name is only exempt when it is a profile skill, or when a
        // same-name DS-Bot capability actually mounted. If that mount failed,
        // keep the profile skill masked instead of silently falling back.
        if (!chosen.has(skill.name) || (capabilities.has(skill.name) && !mountedSkills.has(skill.name))) {
          hide.set(skill.name, skill)
        }
      }
    }
    // One plugin registers the whole mask set. A profile with 100+ skills used
    // to create one fiber per hidden name; one scoped plugin is enough because
    // all registrations land in the same Agent layer.
    const key = [...hide].map(([name, skill]) => `${name}\0${skill.description}`).join('\n')
    if (current?.key === key) return
    masking += 1
    try {
      if (current?.fiber) {
        try { await current.fiber.dispose?.() } catch { /* the Agent may already be gone */ }
      }
      if (hide.size === 0) {
        skillMasks.delete(agent)
        return
      }
      const plugin = {
        name: 'ds-bot-skill-mask',
        inject: ['skills'],
        apply(c) {
          c.effect(() => {
            const disposers = []
            for (const [name, skill] of hide) {
              disposers.push(c.skills.register({
                name,
                description: skill.description || `Skill hidden by ${bot.name}'s shortlist`,
                source: 'shortlist-mask',
                content: '',
                invocation: { modelInvocable: false, userInvocable: false },
              }))
            }
            return () => { for (const dispose of disposers.reverse()) dispose?.() }
          })
        },
      }
      const fiber = agent.ctx.plugin(plugin)
      await fiber?.await?.()
      skillMasks.set(agent, { key, fiber })
    } finally {
      masking -= 1
      if (masking === 0 && skillChangePending) {
        skillChangePending = false
        catalogChanged()
      }
    }
  }
  // The catalog revision is global even though each mask is Agent-scoped. Apply
  // masks one at a time so every strict read sees the previous registrations settled.
  const applySkillMasks = (...args) => {
    const next = maskChain.then(() => applySkillMasksNow(...args))
    maskChain = next.catch(() => {})
    return next
  }
  rt.applySkillMasks = applySkillMasks
  // If a strict scoped snapshot cannot be applied, do not leave the DSH
  // `skill` loader as a fail-open path. The catalog and loader are connected
  // through this tool, so hiding it retires the model-facing skill surface
  // until a later catalog change can reconcile successfully.
  const setSkillUnavailable = (agent, unavailable) => {
    if (unavailable) {
      if (skillMaskUnavailable.has(agent)) return
      let dispose
      try {
        dispose = agent.ctx?.tools?.restrict?.({ deny: ['skill'] })
      } catch (error) {
        rt.warn('ds-bot: could not disable the skill loader for %s: %s', agent.session?.id, error)
      }
      // Keep the gate armed even when this DSH has no tool restriction API.
      skillMaskUnavailable.set(agent, typeof dispose === 'function' ? dispose : null)
      return
    }
    if (skillMaskUnavailable.has(agent)) {
      const current = skillMaskUnavailable.get(agent)
      try { current() } catch { /* the Agent may already be gone */ }
      skillMaskUnavailable.delete(agent)
    }
  }
  // A creator that is not a Main Bot could otherwise rewrite what a Main Bot runs.
  const editCheck = (item, botId, verb) => {
    if (!allowedToEdit(item, botId)) throw new Error(`Only ${item.createdBy ? 'its creator or a Main Bot' : 'a Main Bot'} can ${verb} ${item.name}.`)
    if (!rt.isMain(botId) && usedByOthers(item.name, botId)) throw new Error(`Another Bot uses ${item.name}, so only a Main Bot can ${verb} it.`)
  }
  const itemInput = (body, { botId, ui }) => {
    const name = validateCapabilityName(body.name)
    const kind = body.kind
    if (!['mcp', 'skill', 'pack'].includes(kind)) throw new Error('Choose an MCP server, skill, or pack.')
    const items = ensureLibrary()
    const previous = own(items, name)
    if (previous && !ui) editCheck(previous, botId, 'change')
    if (previous && previous.kind !== kind) throw new Error('A capability cannot change its kind. Delete it and save a new one.')
    const now = Date.now()
    const item = {
      name,
      kind,
      description: String(body.description ?? '').trim().slice(0, 2000),
      createdBy: previous?.createdBy ?? (ui ? null : botId),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    if (kind === 'mcp') {
      const transport = body.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
      if (transport === 'stdio') {
        const command = String(body.command ?? '').trim()
        if (command === '') throw new Error('Enter a command for the MCP server.')
        const args = strings(body.args)
        const env = stringMap(body.env, 'Environment variables')
        const changed = !previous || previous.kind !== 'mcp' || previous.transport !== 'stdio'
          || previous.command !== command || !same(previous.args ?? [], args) || !same(previous.env ?? {}, env)
        Object.assign(item, { transport, command, args, env, approved: ui ? true : changed ? false : previous.approved === true })
      } else {
        const url = String(body.url ?? '').trim()
        try {
          const parsed = new URL(url)
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error()
        } catch { throw new Error('Enter a valid HTTP or HTTPS URL.') }
        Object.assign(item, { transport, url, headers: stringMap(body.headers, 'Headers'), approved: true })
      }
    } else if (kind === 'skill') {
      item.content = String(body.content ?? '').trim()
    } else {
      const names = [...new Set(strings(body.items))]
      for (const childName of names) {
        const child = own(items, childName)
        if (!child || !['mcp', 'skill'].includes(child.kind)) throw new Error(`Packs can include only saved MCP servers and skills. ${childName} is not one.`)
      }
      item.items = names
    }
    items[name] = item
    return item
  }
  const capabilitySave = async (body, options = {}) => {
    await rt.load()
    writeCheck()
    const item = itemInput(body ?? {}, options)
    await rt.save()
    return item
  }
  const capabilityDelete = async (name, { botId, ui } = {}) => {
    await rt.load()
    writeCheck()
    const items = ensureLibrary()
    const item = own(items, String(name ?? ''))
    if (!item) throw new Error(`No capability named ${name}.`)
    if (!ui) editCheck(item, botId, 'delete')
    delete items[item.name]
    for (const pack of Object.values(items)) if (pack.kind === 'pack') pack.items = (pack.items ?? []).filter(child => child !== item.name)
    for (const bot of Object.values(state.bots)) {
      bot.capabilities = (bot.capabilities ?? []).filter(attached => attached !== item.name)
      bot.packs = (bot.packs ?? []).filter(attached => attached !== item.name)
    }
    await rt.save()
    return true
  }
  // Called with the Bot being deleted, after it left the team. The shared list belongs to
  // the user, so only a local MCP this Bot added, nobody approved and no other Bot or pack
  // uses goes: no one is left to ask for it, and approving it would start a server for no one.
  // Anything a pack lists stays.
  const dropOrphanCapabilities = (bot) => {
    const items = library()
    const packed = name => Object.values(items).some(item => item.kind === 'pack' && (item.items ?? []).includes(name))
    for (const name of new Set([...(bot.capabilities ?? []), ...(bot.packs ?? [])])) {
      const item = own(items, name)
      if (item === undefined || item.kind !== 'mcp' || item.transport !== 'stdio' || item.approved === true) continue
      if (item.createdBy !== bot.id || usedByOthers(name, bot.id) || packed(name)) continue
      delete items[item.name]
    }
  }
  const changeAttachment = async (endpoint, { name, bot: targetRef, mode }, callerId) => {
    await rt.load()
    writeCheck()
    const caller = rt.botOf(callerId)
    if (!caller) throw new Error('Only Bots on the team can change capabilities.')
    const target = targetRef ? rt.findBot(targetRef) : caller
    if (!target) throw new Error(`No Bot named ${targetRef}.`)
    if (target.id !== caller.id && target.private === true) throw new Error('Other Bots cannot change a private Bot’s capabilities.')
    if (target.id !== caller.id && !rt.isMain(callerId)) throw new Error('Only a Main Bot can change another Bot’s capabilities.')
    const item = own(ensureLibrary(), String(name ?? ''))
    if (!item) throw new Error(`No capability named ${name}.`)
    await setAttached(target, item.name, endpoint === 'attach', mode)
    return { bot: target.name, attached: endpoint === 'attach' }
  }
  // Changes one name against the saved list, so two quick changes both land.
  const shortlistPurpose = item => {
    const text = String(item.description || item.name).replace(/\s+/g, ' ').trim()
    return text.length <= SKILL_PURPOSE_MAX ? text : `${text.slice(0, SKILL_PURPOSE_MAX - 3)}...`
  }
  const setAttached = async (bot, name, attached, mode = 'always') => {
    if (!['always', 'catalog'].includes(mode)) throw new Error('Capability mode must be always or catalog.')
    const item = own(library(), name)
    bot.capabilities ??= []
    bot.packs ??= []
    const wasEmpty = bot.capabilities.length === 0
    bot.capabilities = bot.capabilities.filter(entry => entry !== name)
    bot.packs = bot.packs.filter(entry => entry !== name)
    if (attached) bot[mode === 'catalog' ? 'packs' : 'capabilities'].push(name)
    let shortlist = bot.skillShortlist
    let shortlistChanged = false
    if (item?.kind === 'skill' && Array.isArray(shortlist)) {
      shortlist = [...shortlist]
      const selected = shortlist.findIndex(skill => skill.name === name)
      if (attached && selected < 0) {
        shortlist.push({ name, purpose: shortlistPurpose(item) })
        shortlistChanged = true
      }
      if (!attached && selected >= 0) {
        shortlist.splice(selected, 1)
        shortlistChanged = true
      }
      // Capabilities are another editing surface for the same five-item
      // shortlist. A sixth attach is fitted in, not refused: every capability
      // skill keeps a slot, and the rest go to the most recently added.
      shortlist = readSkillShortlist(shortlist)
      const skillCapabilities = new Set(Object.values(library()).filter(entry => entry.kind === 'skill').map(entry => entry.name))
      const { list: fitted, dropped } = fitSkillShortlist(shortlist, { capability: skillCapabilities })
      if (dropped.length > 0) {
        rt.warn('ds-bot: skill shortlist for %s trimmed to %d; dropped %s', bot.name, SKILL_SHORTLIST_MAX, dropped.join(', '))
      }
      shortlist = fitted
    }
    if (shortlist !== undefined) bot.skillShortlist = shortlist
    await rt.save()
    if ((wasEmpty && bot.capabilities.length > 0) || shortlistChanged) {
      await trackBotAgents(bot)
      void scheduleReconcile()
    }
    return bot.capabilities
  }

  const statusSet = (botId, itemName, sessionId, status) => {
    statusesCache = undefined
    let byItem = sessionStatuses.get(botId)
    if (!byItem) sessionStatuses.set(botId, byItem = new Map())
    let bySession = byItem.get(itemName)
    if (!bySession) byItem.set(itemName, bySession = new Map())
    bySession.set(sessionId, status)
  }
  const clearStatus = (botId, itemName, sessionId) => {
    statusesCache = undefined
    const byItem = sessionStatuses.get(botId)
    const bySession = byItem?.get(itemName)
    bySession?.delete(sessionId)
    if (bySession?.size === 0) byItem.delete(itemName)
    if (byItem?.size === 0) sessionStatuses.delete(botId)
  }
  const clearSession = sessionId => {
    statusesCache = undefined
    for (const [botId, byItem] of sessionStatuses) {
      for (const [name, bySession] of byItem) {
        bySession.delete(sessionId)
        if (bySession.size === 0) byItem.delete(name)
      }
      if (byItem.size === 0) sessionStatuses.delete(botId)
    }
  }
  const statusFor = (botId, name) => {
    const values = [...(sessionStatuses.get(botId)?.get(name)?.values() ?? [])]
    if (values.some(status => status.state === 'error')) return values.find(status => status.state === 'error')
    if (values.some(status => status.state === 'needs-approval')) return { state: 'needs-approval' }
    if (values.some(status => status.state === 'connecting')) return { state: 'connecting' }
    return values.length > 0 ? { state: 'ready' } : undefined
  }

  const observed = (value, source, at, reason) => ({
    status: 'observed',
    value,
    at,
    source,
    ...(reason ? { reason } : {}),
  })
  const unavailable = (reason, source) => ({ status: 'unavailable', reason, source })
  const redacted = (error, fallback) => rt.redactSecrets(
    [error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ') || fallback,
  ).slice(0, 300)
  const authorizationOf = item => item.kind === 'skill' ? 'not-required'
    : item.kind === 'mcp' && item.transport === 'stdio' ? item.approved === true ? 'allowed' : 'approval-required'
      : undefined
  const toolNamesOf = view => {
    if (view === undefined) return undefined
    try {
      const names = typeof view.keys === 'function' ? [...view.keys()]
        : Array.isArray(view) ? view.map(tool => typeof tool === 'string' ? tool : tool?.name)
          : undefined
      return names?.every(name => typeof name === 'string') ? new Set(names) : undefined
    } catch {
      return undefined
    }
  }
  const observeResponse = (botId, name, sessionId) => {
    const status = sessionStatuses.get(botId)?.get(name)?.get(sessionId)
    return status ? { ...status } : undefined
  }

  async function observeSessionCapabilities(bot, agent, selection) {
    const { id: sessionId } = agent.session
    const at = Date.now()
    const names = bot.skillShortlist?.map(skill => skill.name) ?? []
    // The host registry also accepts an exact Agent scope when the preset
    // shares it. Never use an unscoped profile catalog as Session evidence.
    const service = scopedSkillService(agent) ?? hostSkillService()
    const cwd = rt.sessionFolder?.(agent.session, { observedOnly: true }) ?? skillCwd({ agent })
    let snapshot
    let snapshotError
    try {
      snapshot = await service?.snapshot?.({ scope: agent, cwd, signal: AbortSignal.timeout(3000) })
    } catch (error) {
      snapshotError = redacted(error, 'DSH could not read the scoped Skill catalog.')
    }
    const list = Array.isArray(snapshot?.skills) ? snapshot.skills : undefined
    const complete = list !== undefined && snapshot.complete === true
    const configured = bot.skillShortlist === undefined ? list?.filter(skill => skill.invocation?.modelInvocable === true).map(skill => skill.name) ?? [] : names
    let toolSet
    let toolsError
    try {
      toolSet = selection && typeof ctx.tools?.resolve === 'function'
        ? await ctx.tools.resolve({ agent, modelSelection: selection, signal: AbortSignal.timeout(3000) })
        : undefined
    } catch (error) {
      toolsError = redacted(error, 'DSH could not resolve the Session tool policy.')
    }
    let toolNames
    if (toolSet !== undefined) {
      try { toolNames = toolNamesOf(toolSet.view(agent)) } catch (error) {
        toolsError = redacted(error, 'DSH could not read the resolved Session tool policy.')
      }
    }
    const loader = toolNames?.has('skill')
    const mcp = [...expandCapabilityNames(bot.capabilities, library())]
      .filter(name => own(library(), name)?.kind === 'mcp')
      .map(name => {
        const current = observeResponse(bot.id, name, sessionId) ?? {}
        const authorization = authorizationOf(own(library(), name))
        const liveness = current.liveness ?? (current.state === 'error' ? 'failed' : 'unobserved')
        const legacy = authorization === 'approval-required' ? 'needs-approval'
          : liveness === 'failed' || current.state === 'error' ? 'error'
            : liveness === 'reconnecting' ? 'connecting' : 'unobserved'
        const reason = current.error ?? (authorization === 'approval-required' ? 'This local MCP server needs user approval.' : undefined)
        return {
          name,
          kind: 'mcp',
          status: legacy,
          ...(reason ? { reason } : {}),
          observations: {
            cataloged: observed(true, 'capability-library', at),
            loaderAdmitted: current.loaderAdmitted === true ? observed(true, 'mcp-loader', at)
              : current.loaderAdmitted === false ? observed(false, 'mcp-loader', at)
                : unavailable('The MCP loader has not reported whether it admitted this extension.', 'mcp-loader'),
            bodyLoadable: current.bodyLoadable === true ? observed(true, 'mcp-activation', at)
              : current.bodyLoadable === false ? observed(false, 'mcp-activation', at, current.error)
                : unavailable('The MCP plugin has not reported whether its body loaded.', 'mcp-activation'),
            initialConnected: typeof current.initialConnected === 'boolean'
              ? observed(current.initialConnected, 'mcp-mount', at, current.error)
              : unavailable('No completed initial MCP connection was observed.', 'mcp-mount'),
            liveness: ['connected', 'reconnecting', 'failed'].includes(liveness)
              ? observed(liveness, 'mcp-transport', at, current.error)
              : unavailable(current.error ?? 'No live MCP transport lifecycle observation is available.', 'mcp-transport'),
            authorization: authorization === undefined
              ? unavailable('DSH did not report authorization for this remote MCP server.', 'capability-authorization')
              : observed(authorization, 'capability-authorization', at),
          },
        }
      })
    const bodies = await Promise.all(configured.map(async name => {
      const skill = list?.find(item => item.name === name)
      if (!skill) return skill === undefined && !complete
        ? unavailable('The scoped Skill catalog is incomplete; absence cannot be established.', 'dsh-skills')
        : unavailable('The Skill is not present in the scoped catalog.', 'dsh-skills')
      if (skill.invocation?.modelInvocable !== true) return unavailable('DSH marks this Skill as unavailable to the model.', 'dsh-skills')
      if (loader === false) return unavailable('The Session tool policy denied the Skill loader; body loading was skipped.', 'skill-body')
      if (typeof service?.get !== 'function') return unavailable('This DSH cannot load Skill bodies.', 'skill-body')
      try {
        const definition = await service.get(name, { scope: agent, cwd, signal: AbortSignal.timeout(3000) })
        return definition && typeof definition.content === 'string'
          ? observed(true, 'skill-body', at)
          : observed(false, 'skill-body', at, 'DSH listed the Skill but did not return a loadable body.')
      } catch (error) {
        return observed(false, 'skill-body', at, redacted(error, 'DSH could not load the Skill body.'))
      }
    }))
    try {
      const skills = configured.map((name, index) => {
        const skill = list?.find(item => item.name === name)
        const cataloged = skill === undefined
          ? complete ? observed(false, 'dsh-skills', at) : unavailable(snapshotError ?? 'The scoped Skill catalog is incomplete.', 'dsh-skills')
          : observed(true, 'dsh-skills', at)
        const loaderAdmitted = loader === undefined
          ? unavailable(toolsError ?? 'The Session tool policy was not available.', 'dsh-tool-policy')
          : observed(loader, 'dsh-tool-policy', at)
        const bodyLoadable = bodies[index]
        const masked = cataloged.status === 'observed' && cataloged.value === true && skill?.invocation?.modelInvocable !== true
        const loaderDenied = loaderAdmitted.status === 'observed' && loaderAdmitted.value === false
        const status = cataloged.status === 'observed' && cataloged.value === false ? 'unavailable'
          : masked || loaderDenied || (bodyLoadable.status === 'observed' && bodyLoadable.value === false) ? 'unavailable'
            : cataloged.status !== 'observed' || loaderAdmitted.status !== 'observed' || bodyLoadable.status !== 'observed'
              ? 'unobserved'
              : cataloged.value && loaderAdmitted.value && bodyLoadable.value ? 'ready' : 'unavailable'
        const unavailableObservation = [bodyLoadable, loaderAdmitted, cataloged].find(item => item.status === 'unavailable')
        const reason = masked ? 'DSH marks this Skill as unavailable to the model.'
          : loaderDenied ? 'DSH did not admit the Skill loader for this Session.'
            : bodyLoadable.reason ?? unavailableObservation?.reason
        return {
          name,
          kind: 'skill',
          status,
          ...(reason ? { reason } : {}),
          observations: {
            cataloged,
            loaderAdmitted,
            bodyLoadable,
            initialConnected: unavailable('MCP connection state does not apply to a Skill.', 'mcp-mount'),
            liveness: unavailable('MCP liveness does not apply to a Skill.', 'dsh-tools'),
            authorization: observed('not-required', 'capability-authorization', at),
          },
        }
      })
      return {
        status: 'observed',
        catalogObserved: complete,
        observedAt: at,
        mcp,
        skills,
        ...(snapshotError && !complete ? { catalogReason: snapshotError } : {}),
      }
    } finally { toolSet?.dispose() }
  }
  const capabilityStatusesView = () => {
    // The returned view is shared and cached; callers must not mutate it.
    // Store adoption and in-place attachment/pack edits need no separate notification.
    const key = JSON.stringify(Object.values(state.bots).map(bot => [bot.id,
      (bot.capabilities ?? []).map(name => {
        const item = own(library(), name)
        return [name, item?.kind, item?.kind === 'pack' ? item.items : undefined]
      }),
      // A shortlist change repaints the same rows, so it belongs in the key too.
      (bot.skillShortlist ?? []).map(skill => skill.name),
    ]))
    if (statusesCache && statusesKey === key) return statusesCache
    const result = {}
    for (const bot of Object.values(state.bots)) {
      const statuses = {}
      const names = new Set(bot.capabilities ?? [])
      // A shortlisted DS-Bot skill is effective even though it is not a
      // manual attachment. Show its real mount status and ownership.
      for (const skill of bot.skillShortlist ?? []) {
        if (own(library(), skill.name)?.kind === 'skill') names.add(skill.name)
      }
      for (const name of names) {
        const item = own(library(), name)
        if (!item) continue
        if (item.kind !== 'pack') {
          const status = statusFor(bot.id, name)
          if (status) statuses[name] = status
          continue
        }
        const expected = (item.items ?? []).length
        const children = (item.items ?? []).map(child => statusFor(bot.id, child)).filter(Boolean)
        const error = children.find(status => status.state === 'error')
        if (error) {
          statuses[name] = error
          continue
        }
        const approval = children.find(status => status.state === 'needs-approval')
        if (approval) {
          statuses[name] = approval
          continue
        }
        if (children.length > 0 && children.length < expected) {
          statuses[name] = { state: 'partial' }
          continue
        }
        const status = children.find(status => status.state === 'connecting') ?? children[0]
        if (status) statuses[name] = status
      }
      result[bot.id] = statuses
    }
    statusesKey = key
    statusesCache = result
    return result
  }
  const libraryView = () => Object.values(library()).map(item => ({
    ...item,
    ...(item.env ? { env: { ...item.env } } : {}),
    ...(item.headers ? { headers: { ...item.headers } } : {}),
    ...(item.items ? { items: [...item.items] } : {}),
  }))

  async function loadMcpPlugin() {
    if (!pluginPromise) {
      pluginPromise = (async () => {
        const loader = ctx.get?.('loader')
        if (typeof loader?.import !== 'function') throw new Error('This DSH cannot load MCP servers.')
        const exports = await loader.import(MCP_CLIENT)
        return loader.unwrapExports?.(exports) ?? exports?.default ?? exports
      })()
    }
    return pluginPromise
  }
  function secretFor(name, botId) {
    const value = rt.canUseSecret(name, botId) ? rt.secretValue(name) : undefined
    if (value === undefined) throw new Error(`Secret ${name} is missing or unavailable for this Bot.`)
    return value
  }
  function resolveValues(values, botId) {
    const resolved = {}
    for (const [key, raw] of Object.entries(values ?? {})) {
      resolved[key] = String(raw).replace(SECRET_REFERENCE, (_match, name) => secretFor(name, botId))
    }
    return resolved
  }
  const resolveUrl = (url, botId) => String(url).replace(SECRET_REFERENCE, (_match, name) => encodeUrlComponent(secretFor(name, botId)))
  const resolveList = (list, botId) => (list ?? []).map(raw => String(raw).replace(SECRET_REFERENCE, (_match, name) => secretFor(name, botId)))
  const configFor = (item, botId) => {
    if (item.kind === 'skill') return { name: item.name, description: item.description, content: item.content, provider: 'ds-bot' }
    if (item.transport === 'stdio') return { transport: 'stdio', serverName: item.name, command: item.command, args: resolveList(item.args, botId), env: resolveValues(item.env, botId), failOnStartupError: true }
    return { transport: 'streamable-http', serverName: item.name, url: resolveUrl(item.url, botId), headers: resolveValues(item.headers, botId), failOnStartupError: true }
  }
  const disposeMount = async mount => {
    if (mount) {
      mount.active = false
      for (const unregister of mount.registrations) unregister()
    }
    if (mount?.fiber) await Promise.resolve().then(() => mount.fiber.dispose()).catch(() => {})
  }
  const mountOne = async (agent, bot, agentMounts, name) => {
    const sessionId = agent.session.id
    const item = own(library(), name)
    if (!item) return
    const authorization = authorizationOf(item)
    const drop = async () => {
      await disposeMount(agentMounts.get(name))
      agentMounts.delete(name)
    }
    if (item.kind === 'mcp' && item.transport === 'stdio' && item.approved !== true) {
      await drop()
      statusSet(bot.id, name, sessionId, {
        state: 'needs-approval',
        cataloged: true,
        authorization,
        liveness: 'unobserved',
      })
      return
    }
    let config
    try {
      config = configFor(item, bot.id)
    } catch (error) {
      await drop()
      statusSet(bot.id, name, sessionId, {
        state: 'error',
        error: rt.redactSecrets(error.message).slice(0, 300),
        cataloged: true,
        authorization,
        liveness: 'unobserved',
      })
      return
    }
    const key = `${name}:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}`
    if (agentMounts.get(name)?.key === key) return
    await drop()
    if (stopped || agents.get(sessionId)?.deref() !== agent || !desiredFor(agent, botOfSession(sessionId)).has(name)) return
    statusSet(bot.id, name, sessionId, {
      state: 'connecting',
      cataloged: true,
      authorization,
      liveness: 'unobserved',
    })
    const mounted = { key, active: true, registrations: new Set() }
    agentMounts.set(name, mounted)
    let loaderAdmitted
    let bodyLoadable
    let loaderAttempted = false
    let bodyAttempted = false
    try {
      const register = create => {
        if (!mounted.active) return () => {}
        const unregister = create()
        const remove = () => {
          mounted.registrations.delete(remove)
          return unregister()
        }
        mounted.registrations.add(remove)
        return remove
      }
      let plugin
      if (item.kind === 'skill') {
        plugin = {
          name: `ds-bot-capability-skill-${name}`,
          inject: ['skills'],
          apply(c) {
            c.effect(() => register(() => c.skills.register({ name: config.name, description: config.description, source: 'runtime', provider: config.provider, content: config.content })))
          },
        }
      } else {
        loaderAttempted = true
        plugin = await loadMcpPlugin()
        loaderAdmitted = true
        bodyLoadable = true
      }
      if (stopped || agents.get(sessionId)?.deref() !== agent || agentMounts.get(name) !== mounted) return
      if (!desiredFor(agent, botOfSession(sessionId)).has(name)) {
        await drop()
        return
      }
      let mountContext = agent.ctx
      if (item.kind === 'mcp') {
        const tools = agent.ctx.tools
        const scopedTools = Object.create(tools ?? null)
        scopedTools.register = (...args) => register(() => tools.register(...args))
        mountContext = agent.ctx.extend({ tools: scopedTools })
      }
      bodyAttempted = true
      const fiber = item.kind === 'skill' ? mountContext.plugin(plugin) : mountContext.plugin(plugin, config)
      mounted.fiber = fiber
      await fiber.await()
      if (stopped || agents.get(sessionId)?.deref() !== agent || agentMounts.get(name) !== mounted) return
      if (item.kind === 'skill') {
        // Instrumentation is not enough: DSH runtime registrations are
        // first-wins within one Agent layer. Verify the winner is this
        // capability, otherwise a same-name runtime skill is still callable.
        const winner = (await listProfileSkills({
          agent,
          cwd: skillCwd({ agent, botId: bot.id }),
          strict: true,
        })).find(skill => skill.name === name)
        if (winner?.provider !== config.provider) {
          throw new Error(`The DS-Bot skill ${name} did not become the visible catalog entry.`)
        }
        bodyLoadable = true
      }
      const prior = {
        state: 'ready',
        cataloged: true,
        loaderAdmitted,
        bodyLoadable,
        authorization,
        liveness: 'unobserved',
      }
      const status = item.kind === 'mcp'
        ? { ...prior, initialConnected: true }
        : prior
      statusSet(bot.id, name, sessionId, status)
    } catch (error) {
      if (agentMounts.get(name) !== mounted) return
      await drop()
      const message = redacted(error, 'Connection failed')
      if (loaderAttempted && loaderAdmitted === undefined) loaderAdmitted = false
      if (bodyAttempted && bodyLoadable === undefined) bodyLoadable = false
      statusSet(bot.id, name, sessionId, {
        state: 'error',
        error: message,
        cataloged: true,
        loaderAdmitted,
        bodyLoadable,
        ...(item.kind === 'mcp' ? { initialConnected: false, liveness: 'failed' } : { liveness: 'unobserved' }),
        authorization,
      })
    }
  }
  const desiredFor = (agent, bot) => {
    const sessionId = agent.session.id
    const shortlist = bot?.skillShortlist
    const chosen = Array.isArray(shortlist) ? new Set(shortlist.map(skill => skill.name)) : undefined
    const attached = new Set(bot ? expandCapabilityNames(bot.capabilities, library()) : [])
    // A shortlisted DS-Bot capability is an effective attachment without
    // rewriting the user's manual capability list.
    for (const skill of shortlist ?? []) {
      const item = own(library(), skill.name)
      if (item?.kind === 'skill') attached.add(item.name)
    }
    // MCPs and packs stay mounted. The shortlist only narrows skill items:
    // a manual skill attachment outside the shortlist is hidden, while a
    // shortlisted skill is effective. An empty shortlist must not unmount MCPs.
    const desired = new Set([...attached].filter(name => {
      const item = own(library(), name)
      return item?.kind !== 'skill' || chosen === undefined || chosen.has(name)
    }))
    const entries = loaded.get(sessionId)
    if (agent.status !== 'running') {
      for (const root of entries?.keys() ?? []) {
        if (!bot?.packs?.includes(root) || !own(library(), root)) entries.delete(root)
        else entries.set(root, expandCapabilityNames([root], library()))
      }
      if (entries?.size === 0) loaded.delete(sessionId)
    }
    for (const [root, leaves] of entries ?? []) {
      if (bot?.packs?.includes(root) && own(library(), root)) {
        for (const name of expandCapabilityNames([root], library())) leaves.add(name)
      }
      for (const name of leaves) desired.add(name)
    }
    return desired
  }
  const pruneAgent = agent => {
    const sessionId = agent.session.id
    if (stopped || agents.get(sessionId)?.deref() !== agent) return
    const bot = botOfSession(sessionId)
    const desired = desiredFor(agent, bot)
    if (bot) {
      for (const name of sessionStatuses.get(bot.id)?.keys() ?? []) {
        if (!desired.has(name)) clearStatus(bot.id, name, sessionId)
      }
    } else {
      clearSession(sessionId)
    }
    const agentMounts = mounts.get(agent)
    for (const [name, mount] of agentMounts ?? []) {
      if (desired.has(name)) continue
      agentMounts.delete(name)
      void disposeMount(mount)
    }
  }
  const reconcileAgent = async (agent, bot) => {
    await pruneAgent(agent)
    const desired = desiredFor(agent, bot)
    const agentMounts = mounts.get(agent) ?? new Map()
    if (desired.size > 0) mounts.set(agent, agentMounts)
    await Promise.all([...desired].map(name => mountOne(agent, bot, agentMounts, name)))
    if (agentMounts.size === 0 && mounts.get(agent) === agentMounts) mounts.delete(agent)
    // Profile skills are hidden after capability mounts, so a DS-Bot skill of the
    // same name has already won the Agent layer and the mask cannot displace it.
    const mountedSkills = new Set(bot ? [...agentMounts.keys()].filter(name =>
      own(library(), name)?.kind === 'skill' && statusFor(bot.id, name)?.state === 'ready') : [])
    try {
      await applySkillMasks(agent, bot, mountedSkills)
      setSkillUnavailable(agent, false)
    } catch (error) {
      if (bot?.skillShortlist === undefined) throw error
      const firstFailure = !skillMaskUnavailable.has(agent)
      setSkillUnavailable(agent, true)
      if (firstFailure) {
        rt.warn('ds-bot: skill mask for %s is unavailable; the skill loader is disabled: %s', agent.session.id, error)
      }
    }
  }
  const botOfSession = sessionId => (rt.isBotSession(sessionId) ? rt.botOf(rt.selfOf(sessionId)) : undefined)
  // At most one run waits behind the running one; it reads the latest state when it starts.
  const reconcileOne = async agent => {
    await pruneAgent(agent)
    if (queued.has(agent)) return chains.get(agent)
    queued.add(agent)
    const run = (chains.get(agent) ?? Promise.resolve()).then(async () => {
      queued.delete(agent)
      const sessionId = agent.session.id
      if (stopped || agents.get(sessionId)?.deref() !== agent) return
      await reconcileAgent(agent, botOfSession(sessionId))
    }).catch(error => rt.warn('ds-bot: capability reconcile for %s failed: %s', agent.session?.id, error))
    chains.set(agent, run)
    return run
  }
  const loadInputs = async () => {
    await rt.load()
    loadingSecrets += 1
    try {
      await rt.loadSecrets()
    } finally {
      loadingSecrets -= 1
    }
  }
  async function reconcile() {
    if (stopped) return
    await loadInputs()
    if (stopped) return
    lastReconcileFingerprint = capabilityFingerprint()
    const runs = []
    for (const [sessionId, reference] of agents) {
      const agent = reference.deref()
      if (agent) {
        runs.push(reconcileOne(agent))
        continue
      }
      agents.delete(sessionId)
      clearSession(sessionId)
      loaded.delete(sessionId)
      pendingDrops.delete(sessionId)
      frozenCatalogs.delete(sessionId)
    }
    await Promise.all(runs)
  }
  const scheduleReconcile = () => {
    if (!scheduled) {
      scheduled = new Promise(resolve => queueMicrotask(() => {
        scheduled = null
        resolve(reconcile().catch(error => rt.warn('ds-bot: capability reconcile failed: %s', error)))
      }))
    }
    return scheduled
  }
  // A profile skill installed, removed, or renamed changes both the picker and
  // the mask behind every live Agent. Refresh the picker before reconciling so
  // the next state answer carries the new catalog.
  function catalogChanged() {
    if (stopped) return
    if (masking > 0) {
      skillChangePending = true
      return
    }
    void refreshSkillCatalog()
    void scheduleReconcile()
  }
  // Run before the skill tool's own pre-step listener so a failed strict mask
  // rejects a direct `/name` invocation before its body can be injected.
  ctx.on?.('agent/pre-step', skillMaskPreStepGate(skillMaskUnavailable), { prepend: true })
  ctx.on?.('skills/change', catalogChanged)
  // A run that outlasts the limit goes on in the background, and later requests for the
  // same Agent do not wait for it again.
  const stalled = new WeakSet()
  const prepare = async (agent, sessionId) => {
    await pruneAgent(agent)
    const run = loadInputs().then(() => reconcileOne(agent)).then(() => true, error => {
      rt.warn('ds-bot: capability mount for %s failed: %s', sessionId, error)
      return true
    })
    if (stalled.has(agent)) return
    const timeoutMs = rt.capabilityEnsureTimeoutMs ?? ENSURE_TIMEOUT_MS
    let timer
    const completed = await Promise.race([run, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs, false) })])
    clearTimeout(timer)
    if (completed) return
    stalled.add(agent)
    void run.then(() => stalled.delete(agent))
    rt.warn('ds-bot: capability mount for %s did not finish within %dms; continuing', sessionId, timeoutMs)
  }
  async function ensureCapabilities(sessionId) {
    await rt.load()
    const bot = botOfSession(sessionId)
    if (!bot) return
    if ((bot.capabilities ?? []).length === 0 && bot.skillShortlist === undefined && !loaded.get(sessionId)?.size && !mounts.get(agents.get(sessionId)?.deref())?.size) return
    let agent
    try {
      agent = await rt.resolveAgent(sessionId)
    } catch (error) {
      rt.warn('ds-bot: capability Agent for %s could not be resolved: %s', sessionId, rt.redactSecrets(String(error)))
      return
    }
    trackAgent(agent)
    await prepare(agent, sessionId)
  }
  const trackAgent = agent => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || !agent.ctx) return
    if (agents.get(sessionId)?.deref() === agent) return
    agents.set(sessionId, new WeakRef(agent))
    agent.ctx.effect(() => () => {
      if (agents.get(sessionId)?.deref() === agent) {
        agents.delete(sessionId)
        clearSession(sessionId)
        loaded.delete(sessionId)
        pendingDrops.delete(sessionId)
        frozenCatalogs.delete(sessionId)
      }
      for (const mount of mounts.get(agent)?.values() ?? []) void disposeMount(mount)
      mounts.delete(agent)
      void skillMasks.get(agent)?.fiber?.dispose?.()
      skillMasks.delete(agent)
      setSkillUnavailable(agent, false)
    }, `ds-bot: capabilities ${sessionId}`)
    // Profile skill changes are observed by the root skills/change listener.
    // Keeping this listener off the Agent context avoids adding a scoped prompt
    // listener for every Bot Session.
  }
  const trackBotAgents = async bot => {
    const sessionIds = new Set()
    try {
      const sessionId = rt.chatOf(bot.id)
      if (typeof sessionId === 'string') sessionIds.add(sessionId)
    } catch (error) {
      rt.warn('ds-bot: capability chat session for %s could not be read: %s', bot.id, error)
    }
    try {
      for (const sessionId of rt.groupSessionsOf(bot.id) ?? []) {
        if (typeof sessionId === 'string') sessionIds.add(sessionId)
      }
    } catch (error) {
      rt.warn('ds-bot: capability group sessions for %s could not be read: %s', bot.id, error)
    }
    for (const sessionId of sessionIds) {
      try {
        trackAgent(await rt.resolveAgent(sessionId))
      } catch (error) {
        rt.warn('ds-bot: capability Agent for %s could not be resolved: %s', sessionId, error)
      }
    }
  }

  // A Bot may already have a live Agent that was not tracked at startup because it
  // had neither attachments nor a shortlist. Saving its first policy must find that
  // Agent before the next model step, not wait for a new Session.
  rt.capabilityChanged = async botId => {
    const bot = rt.botOf(botId)
    if (!bot) return
    await trackBotAgents(bot)
    await scheduleReconcile()
  }
  async function capabilityEndpoint(endpoint, body = {}) {

    if (endpoint === 'capability-save') return capabilitySave(body, { ui: true })
    if (endpoint === 'capability-delete') return capabilityDelete(body.name, { ui: true })
    if (endpoint === 'capability-approve') {
      await rt.load()
      writeCheck()
      const item = own(library(), String(body.name ?? ''))
      if (!item || item.kind !== 'mcp' || item.transport !== 'stdio') throw new Error(`No unapproved stdio MCP named ${body.name}.`)
      item.approved = true
      item.updatedAt = Date.now()
      await rt.save()
      return item
    }
    if (endpoint === 'bot-capability') {
      await rt.load()
      writeCheck()
      const bot = rt.botOf(String(body.botId ?? ''))
      if (!bot) throw new Error('Unknown Bot')
      const name = String(body.name ?? '')
      if (!own(library(), name)) throw new Error(`No capability named ${name}.`)
      return setAttached(bot, name, body.attached === true, body.mode)
    }
    throw new Error('Unknown capability operation.')
  }
  let secretsRev = 0
  let lastReconcileFingerprint = null
  const capabilityFingerprint = () => JSON.stringify([
    secretsRev,
    library(),
    Object.values(state.bots ?? {}).map(bot => [
      bot.id,
      bot.sessionId,
      bot.capabilities,
      bot.packs,
      activeTasksOf(bot).map(task => task.sessionId),
    ]),
    Object.values(state.rooms ?? {}).map(room => [room.id, room.sessions]),
  ])
  const secretsChanged = rt.secretsChanged
  rt.secretsChanged = () => {
    secretsRev += 1
    secretsChanged?.()
    if (loadingSecrets === 0) void scheduleReconcile()
  }
  rt.capabilitiesStateSaved = () => {
    void refreshSkillCatalog()
    const fingerprint = capabilityFingerprint()
    if (fingerprint === lastReconcileFingerprint) return
    void scheduleReconcile()
  }
  const renderCatalog = sessionId => {
    const bot = botOfSession(sessionId)
    if (!bot) return ''
    const lines = [...(bot.packs ?? [])].sort().flatMap(name => {
      const item = own(library(), name)
      if (!item) return []
      const summary = String(item.description || (item.kind === 'mcp' ? 'MCP server' : item.kind === 'skill' ? 'Skill instructions' : `Includes ${(item.items ?? []).join(', ') || 'no items'}`)).replace(/\s+/g, ' ').trim().slice(0, 120)
      return [`- ${name}: ${summary}`]
    })
    return lines.length ? ['# Feature packs', ...lines, 'Call use_pack when a task needs one of these packs.'].join('\n') : ''
  }
  const catalogFor = sessionId => {
    if (!botOfSession(sessionId)) return ''
    if (frozenCatalogs.has(sessionId)) return frozenCatalogs.get(sessionId)
    const text = renderCatalog(sessionId)
    frozenCatalogs.set(sessionId, text)
    return text
  }
  ctx.systemPrompt.section({ name: 'feature-packs', order: 10310, text: ({ agent }) => {
    if (agent?.ctx) trackAgent(agent)
    return catalogFor(agent?.id)
  } })
  const usePack = async (sessionId, name) => {
    await rt.load()
    const bot = botOfSession(sessionId)
    if (!bot) throw new Error('Only Bots on the team can use feature packs.')
    writeCheck()
    if (bot.capabilities?.includes(name)) return `${name} is already always on.`
    if (!bot.packs?.includes(name)) throw new Error(`${name} is not in your feature pack catalog.`)
    const leaves = expandCapabilityNames([name], library())
    const agent = await rt.resolveAgent(sessionId)
    trackAgent(agent)
    let entries = loaded.get(sessionId)
    if (!entries) loaded.set(sessionId, entries = new Map())
    for (const child of entries.get(name) ?? []) leaves.add(child)
    entries.set(name, leaves)
    pendingDrops.get(sessionId)?.delete(name)
    let timer
    const completed = await Promise.race([
      reconcileOne(agent).then(() => true),
      new Promise(resolve => { timer = setTimeout(resolve, rt.capabilityEnsureTimeoutMs ?? ENSURE_TIMEOUT_MS, false) }),
    ]).finally(() => clearTimeout(timer))
    return [...leaves].map(child => {
      const status = sessionStatuses.get(bot.id)?.get(child)?.get(sessionId)
      if (!status || status.state === 'connecting') return `${child}: error (${completed ? 'mount did not publish a status' : 'mount did not finish within the time limit'})`
      return `${child}: ${status.state}${status.error ? ` (${status.error})` : ''}`
    }).join('\n') || `${name}: ready (empty pack)`
  }
  const dropPack = async (sessionId, name) => {
    await rt.load()
    if (!botOfSession(sessionId)) throw new Error('Only Bots on the team can use feature packs.')
    writeCheck()
    if (!loaded.get(sessionId)?.has(name)) return `${name} is not loaded in this session.`
    let drops = pendingDrops.get(sessionId)
    if (!drops) pendingDrops.set(sessionId, drops = new Set())
    drops.add(name)
    return `${name} will be dropped at the end of this turn.`
  }
  ctx.on('session/event', async function finishFeaturePacks(session, event) {
    if (event.type !== 'turn/start' && event.type !== 'turn/end') return
    const sessionId = session?.id
    if (frozenCatalogs.has(sessionId) && frozenCatalogs.get(sessionId) !== renderCatalog(sessionId)) frozenCatalogs.delete(sessionId)
    if (event.type !== 'turn/end') return
    const entries = loaded.get(sessionId)
    if (!entries) return
    const bot = botOfSession(sessionId)
    for (const name of entries.keys()) {
      if (pendingDrops.get(sessionId)?.has(name) || !bot?.packs?.includes(name) || !own(library(), name)) entries.delete(name)
      else entries.set(name, expandCapabilityNames([name], library()))
    }
    pendingDrops.delete(sessionId)
    if (!entries.size) {
      loaded.delete(sessionId)
      rt.syncScopedSession?.(sessionId)
    }
    const agent = agents.get(sessionId)?.deref()
    if (agent) {
      await pruneAgent(agent)
      void reconcileOne(agent).catch(error => rt.warn('ds-bot: capability reconcile for %s failed: %s', sessionId, error))
    }
  })
  // Creation waits for these listeners, so a new Agent's first request already has its
  // tools and skill catalog. agent/pre-step is too late: a step assembles its tools first.
  ctx.on('agent/created', async function prepareCapabilities({ agent }) {
    trackAgent(agent)
    try {
      await rt.load()
      const bot = botOfSession(agent.session.id)
      if ((bot?.capabilities ?? []).length > 0 || bot?.skillShortlist !== undefined) await prepare(agent, agent.session.id)
    } catch (error) {
      rt.warn('ds-bot: capability load failed: %s', error)
    }
  })
  ctx.effect(() => {
    void rt.load().then(async () => {
      await refreshSkillCatalog({ publish: false })
      for (const bot of Object.values(state.bots)) {
        if ((bot.capabilities ?? []).length > 0 || bot.skillShortlist !== undefined) await trackBotAgents(bot)
      }
      await scheduleReconcile()
    }).catch(error => rt.warn('ds-bot: capability startup failed: %s', error))
    return async () => {
      stopped = true
      const live = [...mounts.values()]
      mounts.clear()
      agents.clear()
      sessionStatuses.clear()
      for (const record of skillMasks.values()) void record.fiber?.dispose?.()
      skillMasks.clear()
      for (const dispose of skillMaskUnavailable.values()) void dispose?.()
      skillMaskUnavailable.clear()
      loaded.clear()
      pendingDrops.clear()
      frozenCatalogs.clear()
      statusesCache = undefined
      await Promise.all(live.flatMap(agentMounts => [...agentMounts.values()].map(disposeMount)))
    }
  }, 'ds-bot: capabilities')
  Object.assign(rt, {
    capabilitySave,
    capabilityDelete,
    dropOrphanCapabilities,
    capabilityEndpoint,
    capabilityLibraryView: libraryView,
    capabilityStatusesView,
    observeSessionCapabilities,
    reconcileCapabilities: reconcile,
    scheduleCapabilitiesReconcile: scheduleReconcile,
    ensureCapabilities,
    expandCapabilities: names => expandCapabilityNames(names, library()),
    changeCapabilityAttachment: changeAttachment,
    usePack,
    dropPack,
    hasLoadedPacks: sessionId => (loaded.get(sessionId)?.size ?? 0) > 0,
  })
}
