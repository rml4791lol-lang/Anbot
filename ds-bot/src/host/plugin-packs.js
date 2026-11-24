// A curated view over the profile's native DSH bundle manager. DS Bot owns the
// catalog, grouping, authority and conflict policy; DSH owns installation and
// enablement. Alternative authorities are never toggled from the generic pack
// switch: they change only through setAuthority(), which disables the competing
// implementation first and restores it if the selected one cannot start.
export const PACKS = [
  { id: 'forge', title: 'Forge', kind: 'tool', lanes: ['team', 'code-lab'], bundles: ['@deepseek-ai/dsh-experimental-forge-bundle'], description: 'Task runs, worktrees and evidence.' },
  { id: 'worktree', title: 'Worktree', kind: 'tool', lanes: ['team', 'code-lab'], bundles: ['@deepseek-ai/dsh-experimental-tool-worktree'], description: 'Isolated worktrees for repository work.' },
  { id: 'session-search', title: 'Session search', kind: 'tool', lanes: ['team', 'long-context'], bundles: ['@deepseek-ai/dsh-experimental-session-search'], description: 'Search earlier DSH sessions.' },
  { id: 'session-titles', title: 'Session titles', kind: 'tool', lanes: ['team', 'long-context'], bundles: ['@deepseek-ai/dsh-experimental-session-titles-bundle'], description: 'Readable titles for long-lived Sessions.' },
  { id: 'auto-review', title: 'Auto review', kind: 'tool', lanes: ['team', 'code-lab'], bundles: ['@deepseek-ai/dsh-experimental-auto-review'], description: 'A review gate between work and delivery.' },
  { id: 'plugin-market', title: 'Plugin market', kind: 'market', lanes: ['team'], bundles: ['@deepseek-ai/dsh-experimental-plugin-market-bundle'], description: 'Browse configured plugin indexes.' },
  { id: 'graphlint', title: 'Graphlint', kind: 'tool', lanes: ['team', 'code-lab'], bundles: ['dsh-graphlint'], description: 'Code and dependency graph checks.' },
  { id: 'hooks', title: 'Hooks', kind: 'tool', lanes: ['team', 'code-lab'], bundles: ['dsh-hooks'], description: 'Project and agent lifecycle hooks.' },
  { id: 'net-health', title: 'Network health', kind: 'host', lanes: ['team', 'code-lab'], bundles: ['dsh-net-health'], description: 'Network path diagnostics.' },
  { id: 'ssh', title: 'SSH', kind: 'connector', lanes: ['code-lab'], bundles: ['dsh-ssh'], description: 'Remote development over SSH.' },
  { id: 'sync', title: 'Profile sync', kind: 'host', lanes: ['team'], bundles: ['dsh-sync'], description: 'Explicit profile and device synchronization.' },
  { id: 'skill-explorer', title: 'Skill explorer', kind: 'ui', lanes: ['team', 'ui'], bundles: ['@linxin666/dsh-client-ui-skill-explorer'], description: 'Browse the installed skill catalog.' },
  { id: 'session-insights', title: 'Session insights', kind: 'ui', lanes: ['team', 'ui'], bundles: ['dsh-session-insights'], description: 'Inspect Session usage and activity.' },
  { id: 'superpowers', title: 'Superpowers', kind: 'tool', lanes: ['team', 'code-lab'], bundles: ['superpowers-dsh'], description: 'Reusable planning and engineering workflows.' },
  { id: 'super-code', title: 'Super code', kind: 'engine', scope: 'bot', lanes: ['agent-lab'], bundles: ['dsh-super-code'], exclusive: 'agent-engine', description: 'Alternative coding-agent engine.' },
  { id: 'ralph', title: 'Ralph', kind: 'engine', scope: 'bot', lanes: ['agent-lab'], bundles: ['@deepseek-ai/dsh-experimental-ralph-bundle'], exclusive: 'agent-engine', description: 'Autonomous iterative work loop.' },
  { id: 'agent-team', title: 'Agent teams', kind: 'engine', scope: 'bot', lanes: ['agent-lab'], bundles: ['@deepseek-ai/dsh-experimental-agent-team-profile'], exclusive: 'agent-engine', description: 'Lead and teammate orchestration.' },
  { id: 'inspector', title: 'Inspector', kind: 'engine', scope: 'bot', lanes: ['agent-lab'], bundles: ['@deepseek-ai/dsh-experimental-inspector-profile'], description: 'Development inspection profile.' },
  { id: 'cua', title: 'DSH Computer Use', kind: 'engine', scope: 'bot', lanes: ['agent-lab'], bundles: ['@deepseek-ai/dsh-cua-bundle'], authority: 'computer', description: 'Alternative desktop-control stack.' },
  { id: 'subagent-codex', title: 'Codex subagent', kind: 'engine', scope: 'bot', lanes: ['agent-lab'], bundles: ['@deepseek-ai/dsh-subagent-codex'], description: 'Invoke Codex as a subagent provider.' },
  { id: 'subagent-claude-code', title: 'Claude Code subagent', kind: 'engine', scope: 'bot', lanes: ['agent-lab'], bundles: ['@deepseek-ai/dsh-subagent-claude-code'], description: 'Invoke Claude Code as a subagent provider.' },
  { id: 'subagent-opencode', title: 'OpenCode subagent', kind: 'engine', scope: 'bot', lanes: ['agent-lab'], bundles: ['@local/dsh-subagent-opencode'], installable: false, description: 'Invoke OpenCode as a subagent provider from a local package.' },
  { id: 'billion-context', title: 'Billion Context', kind: 'compression', scope: 'bot', lanes: ['long-context'], bundles: ['billion-context'], authority: 'compression', description: 'Alternative long-context compression engine.' },
  { id: 'mnemon', title: 'Mnemon', kind: 'memory', scope: 'bot', lanes: ['long-context'], bundles: ['dsh-mnemon'], authority: 'memory', description: 'Alternative long-term memory provider.' },
  { id: 'openviking', title: 'OpenViking memory', kind: 'memory', scope: 'bot', lanes: ['long-context'], bundles: ['@openviking/dsh-memory-plugin'], authority: 'memory', description: 'Alternative memory provider.' },
  { id: 'project-memory', title: 'Project memory', kind: 'memory', scope: 'bot', lanes: ['long-context', 'code-lab'], bundles: ['@yolk_vat-y/dsh-project-memory'], authority: 'memory', description: 'Repository-aware long-term memory.' },
  { id: 'genui', title: 'GenUI', kind: 'ui', lanes: ['ui'], bundles: ['@changfenhuang/dsh-genui'], description: 'Generated interface cards and views.' },
  { id: 'better-sidebar', title: 'Better sidebar', kind: 'ui', lanes: ['ui'], bundles: ['dsh-better-sidebar'], description: 'Alternative navigation and sidebar behavior.' },
  { id: 'ambience', title: 'Ambience', kind: 'ui', lanes: ['ui'], bundles: ['dsh-ambience'], description: 'Ambient visual effects.' },
  { id: 'todo-plus', title: 'Todo Plus', kind: 'ui', lanes: ['ui'], bundles: ['dsh-tool-todo-plus'], description: 'Extended todo views and controls.' },
  { id: 'opendesign', title: 'Open Design', kind: 'ui', lanes: ['media'], bundles: ['dsh-opendesign'], description: 'Design canvases and visual editing.' },
  { id: 'ppt-studio', title: 'PPT Studio', kind: 'media', lanes: ['media'], bundles: ['dsh-ppt-studio'], description: 'Presentation generation and editing.' },
  { id: 'media', title: 'Media', kind: 'media', lanes: ['media'], bundles: ['dsh-media'], description: 'Image and video generation, budgets and galleries.' },
  { id: 'qq-onebot', title: 'QQ OneBot', kind: 'connector', lanes: ['team'], bundles: ['dsh-qq-onebot'], description: 'QQ connector through OneBot.' },
  { id: 'super-dafeiyu', title: 'Super Dafeiyu', kind: 'connector', lanes: ['team'], bundles: ['dsh-super-dafeiyu'], description: 'Dafeiyu connector.' },
  { id: 'openmaic', title: 'OpenMAIC', kind: 'connector', lanes: ['team'], bundles: ['@openmaic/dsh-openmaic'], description: 'OpenMAIC agent connector.' },
  { id: 'auto-update', title: 'Auto update', kind: 'host', lanes: ['team'], bundles: ['@sueleven/dsh-auto-update'], description: 'Profile update checks and delivery.' },
  { id: 'unlag', title: 'Unlag', kind: 'host', lanes: ['team'], bundles: ['dsh-unlag'], description: 'Runtime latency diagnostics.' },
  { id: 'auto-continue', title: 'Auto continue', kind: 'tool', lanes: ['agent-lab'], bundles: ['dsh-client-auto-continue'], description: 'Continue long agent work after an interruption.' },
]

export const LANES = [
  { id: 'team', title: 'Team', description: 'The stable default profile.' },
  { id: 'code-lab', title: 'Code Lab', description: 'Repository, review and remote-development tools.' },
  { id: 'long-context', title: 'Long Context', description: 'Long-session search, compression and memory.' },
  { id: 'agent-lab', title: 'Agent Lab', description: 'Alternative engines and subagent providers.' },
  { id: 'media', title: 'Media', description: 'Design, presentations and generated media.' },
  { id: 'ui', title: 'UI', description: 'Optional navigation and visual modes.' },
]

// These are profile-wide authorities. A pack may be installed beside the others,
// but only one implementation in each domain may be selected and enabled.
export const AUTHORITY_DEFS = {
  compression: {
    title: 'Context compression',
    default: 'steward',
    options: [
      { id: 'steward', title: 'DS Bot steward', owner: 'DS Bot' },
      { id: 'bili', title: 'Billion Context', owner: 'Billion Context', pack: 'billion-context' },
      { id: 'off', title: 'Off', owner: 'Disabled' },
    ],
  },
  memory: {
    title: 'Memory',
    default: 'dsbot',
    options: [
      { id: 'dsbot', title: 'DS Bot memory', owner: 'DS Bot' },
      { id: 'mnemon', title: 'Mnemon', owner: 'Mnemon', pack: 'mnemon' },
      { id: 'openviking', title: 'OpenViking memory', owner: 'OpenViking', pack: 'openviking' },
      { id: 'project-memory', title: 'Project memory', owner: 'Project memory', pack: 'project-memory' },
      { id: 'off', title: 'Off', owner: 'Disabled' },
    ],
  },
  computer: {
    title: 'Computer use',
    default: 'dsbot',
    options: [
      { id: 'dsbot', title: 'DS Bot Computer Use', owner: 'DS Bot' },
      { id: 'dsh-cua', title: 'DSH Computer Use', owner: 'DSH', pack: 'cua' },
      { id: 'off', title: 'Off', owner: 'Disabled' },
    ],
  },
}

export const AUTHORITIES = Object.fromEntries(Object.entries(AUTHORITY_DEFS).map(([domain, definition]) => [domain, definition.options.find(option => option.id === definition.default)?.owner ?? 'DS Bot']))

const packOf = id => PACKS.find(pack => pack.id === id)
const optionsOf = domain => AUTHORITY_DEFS[domain]?.options ?? []
const optionOf = (domain, id) => optionsOf(domain).find(option => option.id === id)

export function install(rt) {
  let snapshot = emptySnapshot()
  let loadError
  let lastChange = null

  const invalid = message => Object.assign(new Error(message), { code: 'INVALID' })
  const refuse = message => Object.assign(new Error(message), { code: 'REFUSED' })
  const manager = () => rt.ctx?.get?.('pluginManager')

  function selectedAuthorities() {
    const saved = rt.state?.prefs?.pluginPackAuthorities ?? {}
    return Object.fromEntries(Object.entries(AUTHORITY_DEFS).map(([domain, definition]) => {
      const value = typeof saved[domain] === 'string' ? saved[domain] : definition.default
      return [domain, optionOf(domain, value) === undefined ? definition.default : value]
    }))
  }

  function authorityOf(domain) {
    return selectedAuthorities()[domain] ?? AUTHORITY_DEFS[domain]?.default
  }

  function statusOf(pack, byName) {
    const rows = pack.bundles.map(name => byName.get(name))
    if (rows.some(row => row === undefined || row.installed !== true)) return 'missing'
    const failed = rows.find(row => row.error !== undefined)
    if (failed !== undefined) return 'error'
    if (rows.every(row => row.enabled === true)) return 'enabled'
    if (rows.some(row => row.enabled === true)) return 'partial'
    return 'disabled'
  }

  function conflictOf(pack, byName) {
    if (pack.exclusive === undefined) return undefined
    return PACKS.find(other => other.id !== pack.id && other.exclusive === pack.exclusive && statusOf(other, byName) === 'enabled')
  }

  function authorityView(byName) {
    const selected = selectedAuthorities()
    return Object.fromEntries(Object.entries(AUTHORITY_DEFS).map(([domain, definition]) => [domain, {
      id: domain,
      title: definition.title,
      selected: selected[domain],
      options: definition.options.map((option) => {
        const pack = option.pack === undefined ? undefined : packOf(option.pack)
        return {
          id: option.id,
          title: option.title,
          owner: option.owner,
          ...(option.pack === undefined ? {} : { pack: option.pack }),
          status: pack === undefined ? 'internal' : byName === undefined ? 'unavailable' : statusOf(pack, byName),
        }
      }),
    }]))
  }

  function rowsFor(pack, byName) {
    return pack.bundles.map(name => byName.get(name)).filter(Boolean)
  }

  function packView(pack, byName, native) {
    const status = statusOf(pack, byName)
    const rows = rowsFor(pack, byName)
    const conflict = conflictOf(pack, byName)
    const error = rows.find(row => row.error !== undefined)?.error
    return {
      id: pack.id,
      title: pack.title,
      description: pack.description,
      kind: pack.kind,
      scope: pack.scope ?? 'profile',
      lanes: pack.lanes,
      bundles: pack.bundles,
      installed: status !== 'missing',
      enabled: status === 'enabled',
      status,
      version: rows.find(row => row.version !== undefined)?.version,
      ...(error === undefined ? {} : { error: error.message ?? error.code }),
      installable: pack.installable !== false,
      canInstall: status === 'missing' && pack.installable !== false && typeof native.installBundle === 'function' && pack.authority === undefined,
      canToggle: status !== 'missing' && status !== 'error' && typeof native.setBundleEnabled === 'function' && pack.authority === undefined,
      ...(pack.exclusive === undefined ? {} : { exclusive: pack.exclusive }),
      ...(pack.authority === undefined ? {} : { authority: pack.authority, authorityOwner: AUTHORITIES[pack.authority] }),
      conflicts: conflict === undefined ? [] : [conflict.id],
    }
  }

  async function refresh() {
    const native = manager()
    if (native === undefined || typeof native.listBundles !== 'function') {
      loadError = 'This DSH does not expose the native plugin manager.'
      snapshot = emptySnapshot(loadError)
      return snapshot
    }
    try {
      const bundles = await native.listBundles()
      const byName = new Map(bundles.map(row => [row.name, row]))
      snapshot = {
        available: true,
        packs: PACKS.map(pack => packView(pack, byName, native)),
        lanes: LANES.map(lane => ({ ...lane, packs: PACKS.filter(pack => pack.lanes.includes(lane.id)).map(pack => pack.id) })),
        authorities: authorityView(byName),
        lastChange,
      }
      loadError = undefined
      return snapshot
    } catch (error) {
      loadError = error?.message ?? String(error)
      snapshot = emptySnapshot(loadError)
      return snapshot
    }
  }

  function view() {
    return snapshot ?? emptySnapshot(loadError)
  }

  function requireManager(needInstall = false) {
    const native = manager()
    if (native === undefined || typeof native.listBundles !== 'function'
      || typeof native.setBundleEnabled !== 'function' || (needInstall && typeof native.installBundle !== 'function')) {
      throw refuse('This DSH does not expose the native plugin manager.')
    }
    return native
  }

  function resultFailed(result) {
    return result?.application === 'failed' || result?.application === 'cancelled'
  }

  async function setBundles(native, pack, enabled) {
    let last
    for (const name of pack.bundles) {
      last = await native.setBundleEnabled(name, enabled)
      if (resultFailed(last)) throw refuse(last.error?.message ?? `${pack.title} could not be ${enabled ? 'enabled' : 'disabled'}.`)
    }
    return last
  }

  async function installBundles(native, pack) {
    if (pack.installable === false) throw refuse(`${pack.title} is supplied by a local package and cannot be installed from the registry here.`)
    let last
    for (const name of pack.bundles) {
      last = await native.installBundle(pack.installSpec ?? name, { enabled: true })
      if (resultFailed(last)) throw refuse(last.error?.message ?? `${pack.title} could not be installed.`)
    }
    return last
  }

  async function enableAuthorityPack(native, pack) {
    let bundles = await native.listBundles()
    let byName = new Map(bundles.map(row => [row.name, row]))
    const status = statusOf(pack, byName)
    if (status === 'enabled') return null
    if (status === 'error') throw refuse(`${pack.title} is installed but cannot load. Repair it in DSH Plugins first.`)
    if (status === 'missing') {
      const result = await installBundles(native, pack)
      bundles = await native.listBundles()
      byName = new Map(bundles.map(row => [row.name, row]))
      if (statusOf(pack, byName) === 'error') throw refuse(`${pack.title} installed but cannot load. Repair it in DSH Plugins first.`)
      return result
    }
    return setBundles(native, pack, true)
  }

  async function setPack(id, enabled) {
    const pack = packOf(id)
    if (pack === undefined) throw invalid(`Unknown plugin pack: ${id}`)
    if (typeof enabled !== 'boolean') throw invalid('enabled must be true or false')
    if (rt.readOnly() !== undefined) throw refuse(rt.readOnly())
    const native = requireManager(true)
    if (enabled && pack.authority !== undefined) {
      throw refuse(`${pack.title} is an ${pack.authority} authority. Change it under DS Bot authorities instead of toggling the pack.`)
    }
    const bundles = await native.listBundles()
    const byName = new Map(bundles.map(row => [row.name, row]))
    if (pack.bundles.some(name => byName.get(name)?.installed !== true)) throw refuse(`${pack.title} is not installed yet. Install it first.`)
    if (enabled) {
      const conflict = conflictOf(pack, byName)
      if (conflict !== undefined) throw refuse(`${pack.title} (${pack.id}) conflicts with ${conflict.title} (${conflict.id}) in the ${pack.exclusive} slot. Disable ${conflict.title} first.`)
    }
    lastChange = await setBundles(native, pack, enabled)
    return refresh()
  }

  async function installPack(id) {
    const pack = packOf(id)
    if (pack === undefined) throw invalid(`Unknown plugin pack: ${id}`)
    if (pack.authority !== undefined) throw refuse(`${pack.title} is an ${pack.authority} authority. Change it under DS Bot authorities instead of installing it as an ordinary pack.`)
    if (rt.readOnly() !== undefined) throw refuse(rt.readOnly())
    const native = requireManager(true)
    const before = await native.listBundles()
    const byName = new Map(before.map(row => [row.name, row]))
    const missing = pack.bundles.filter(name => byName.get(name)?.installed !== true)
    if (missing.length === 0) return setPack(id, true)
    if (missing.length !== pack.bundles.length) throw refuse(`${pack.title} has a partial native bundle installation. Repair it in DSH Plugins first.`)
    lastChange = await installBundles(native, pack)
    return refresh()
  }

  async function setAuthority(domain, id) {
    const definition = AUTHORITY_DEFS[domain]
    if (definition === undefined) throw invalid(`Unknown plugin authority: ${domain}`)
    const option = optionOf(domain, id)
    if (option === undefined) throw invalid(`Unknown ${domain} authority: ${id}`)
    if (rt.readOnly() !== undefined) throw refuse(rt.readOnly())
    const native = requireManager(true)
    const before = await native.listBundles()
    const beforeByName = new Map(before.map(row => [row.name, row]))
    const changed = []
    const prefs = rt.state?.prefs
    const hadSaved = prefs?.pluginPackAuthorities !== undefined && Object.hasOwn(prefs.pluginPackAuthorities, domain)
    const previousSaved = prefs?.pluginPackAuthorities?.[domain]
    let result = null
    try {
      // Disable every competing pack first. A pack that cannot stop must not leave
      // two memory/compression providers selected at once.
      for (const competing of optionsOf(domain)) {
        if (competing.pack === undefined || competing.pack === option.pack) continue
        const pack = packOf(competing.pack)
        if (pack === undefined) continue
        const status = statusOf(pack, beforeByName)
        if (status !== 'enabled' && status !== 'partial') continue
        result = await setBundles(native, pack, false)
        changed.push({ pack, enabled: true })
      }
      if (option.pack !== undefined) {
        const pack = packOf(option.pack)
        if (pack === undefined) throw invalid(`The ${domain} authority names an unknown pack: ${option.pack}`)
        const wasEnabled = ['enabled', 'partial'].includes(statusOf(pack, beforeByName))
        result = await enableAuthorityPack(native, pack)
        changed.push({ pack, enabled: wasEnabled })
        const after = await native.listBundles()
        if (statusOf(pack, new Map(after.map(row => [row.name, row]))) !== 'enabled') {
          throw refuse(`${pack.title} did not become the active ${domain} authority.`)
        }
      }
      if (prefs === undefined) throw refuse('DS Bot preferences are not available.')
      prefs.pluginPackAuthorities ??= {}
      if (option.id === definition.default) delete prefs.pluginPackAuthorities[domain]
      else prefs.pluginPackAuthorities[domain] = option.id
      await rt.save?.({ required: true })
      if (domain === 'memory') rt.resyncTeamTools?.()
      lastChange = result
      return refresh()
    } catch (error) {
      // Put the bundle selections back. Installation may remain on disk, but it is
      // left disabled; selection and the authority preference stay unchanged.
      for (const entry of changed.reverse()) {
        try { await setBundles(native, entry.pack, entry.enabled) } catch { /* preserve the original failure */ }
      }
      if (prefs?.pluginPackAuthorities !== undefined) {
        if (hadSaved) prefs.pluginPackAuthorities[domain] = previousSaved
        else delete prefs.pluginPackAuthorities[domain]
      }
      throw error
    }
  }

  async function pluginPackEndpoint(endpoint, body = {}) {
    if (endpoint === 'plugin-packs') return refresh()
    if (endpoint === 'plugin-pack-set') return setPack(String(body.id ?? ''), body.enabled)
    if (endpoint === 'plugin-pack-install') return installPack(String(body.id ?? ''))
    if (endpoint === 'plugin-pack-authority') return setAuthority(String(body.authority ?? ''), String(body.id ?? ''))
    throw invalid(`Unknown plugin pack endpoint: ${endpoint}`)
  }

  Object.assign(rt, {
    pluginPacksView: view,
    refreshPluginPacks: refresh,
    pluginPackEndpoint,
    compressionAuthority: () => authorityOf('compression'),
    memoryAuthority: () => authorityOf('memory'),
    computerAuthority: () => authorityOf('computer'),
    pluginPackAuthorities: selectedAuthorities,
  })
}

function emptySnapshot(error) {
  const selected = Object.fromEntries(Object.entries(AUTHORITY_DEFS).map(([domain, definition]) => [domain, definition.default]))
  return {
    available: false,
    packs: PACKS.map(pack => ({
      id: pack.id,
      title: pack.title,
      description: pack.description,
      kind: pack.kind,
      scope: pack.scope ?? 'profile',
      lanes: pack.lanes,
      bundles: pack.bundles,
      installed: false,
      enabled: false,
      status: 'unavailable',
      installable: pack.installable !== false,
      canInstall: false,
      canToggle: false,
      ...(pack.exclusive === undefined ? {} : { exclusive: pack.exclusive }),
      ...(pack.authority === undefined ? {} : { authority: pack.authority, authorityOwner: AUTHORITIES[pack.authority] }),
      conflicts: [],
    })),
    lanes: LANES.map(lane => ({ ...lane, packs: PACKS.filter(pack => pack.lanes.includes(lane.id)).map(pack => pack.id) })),
    authorities: Object.fromEntries(Object.entries(AUTHORITY_DEFS).map(([domain, definition]) => [domain, {
      id: domain,
      title: definition.title,
      selected: selected[domain],
      options: definition.options.map(option => ({ id: option.id, title: option.title, owner: option.owner, ...(option.pack === undefined ? {} : { pack: option.pack }), status: 'unavailable' })),
    }])),
    ...(error === undefined ? {} : { error }),
    lastChange: null,
  }
}
