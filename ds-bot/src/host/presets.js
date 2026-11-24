// Each Bot owns a complete DSH Agent preset. The registry exposes a preset only as
// YAML, so a Bot's copy is kept as its own file and registered again on every start.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { dump, load } from 'js-yaml'
import { replaceFile } from './files.js'

const BOT_PREFIX = 'dsbot-bot-'
const GROUP_RELAY_ID = 'dsbot-group-relay'
const BASE_PRIORITY = ['standard', 'ptc']
const PRESET_ORDER = 10_000

const errorText = error => error?.message ?? String(error)

const isBotPreset = id => id.startsWith(BOT_PREFIX) || id === GROUP_RELAY_ID

function readEntryList(content, label) {
  let rows
  try {
    rows = load(content, { schema: entryListSchema })
  } catch (error) {
    throw new Error(`${label} is not valid preset YAML: ${errorText(error)}`)
  }
  if (!Array.isArray(rows)) throw new Error(`${label} must be a list of plugin rows`)
  return rows
}

function readDefinition(text, expectedId) {
  let value
  try {
    value = load(text, { schema: entryListSchema })
  } catch (error) {
    throw new Error(`The preset file is not valid YAML: ${errorText(error)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('The preset file must hold a preset object')
  if (value.id !== expectedId) throw new Error(`The preset id must stay ${expectedId}`)
  if (!Array.isArray(value.plugins)) throw new Error('The preset must have a plugins list')
  return {
    id: expectedId,
    ...(typeof value.name === 'string' && value.name.trim() !== '' ? { name: value.name.trim() } : {}),
    ...(typeof value.description === 'string' && value.description.trim() !== '' ? { description: value.description.trim() } : {}),
    order: Number.isFinite(value.order) ? value.order : PRESET_ORDER,
    plugins: value.plugins,
    ...(typeof value.base === 'string' && value.base.trim() !== '' ? { base: value.base.trim() } : {}),
    ...(typeof value.copiedFrom === 'string' && value.copiedFrom !== '' ? { copiedFrom: value.copiedFrom } : {}),
  }
}

function presetText(definition) {
  return dump({
    version: 1,
    id: definition.id,
    name: definition.name ?? `${definition.id} preset`,
    description: definition.description ?? 'An Agent preset owned by one DS Bot.',
    order: definition.order ?? PRESET_ORDER,
    ...(definition.base === undefined ? {} : { base: definition.base }),
    ...(definition.copiedFrom === undefined ? {} : { copiedFrom: definition.copiedFrom }),
    plugins: definition.plugins,
  }, { schema: entryListSchema, noRefs: true, lineWidth: -1 })
}

function presetDefinition(definition) {
  return {
    id: definition.id,
    ...(definition.name === undefined ? {} : { name: definition.name }),
    ...(definition.description === undefined ? {} : { description: definition.description }),
    order: definition.order ?? PRESET_ORDER,
    plugins: definition.plugins,
  }
}

export function install(rt) {
  const { ctx } = rt
  const dir = join(rt.home, 'presets')
  // Registered presets and the parsed definitions behind them. A registry revision
  // stays alive for Sessions that already use it; replacing one only changes future
  // Sessions, which is exactly the product rule for a Bot's preset.
  const registered = new Map()
  const definitions = new Map()
  const broken = new Map()
  const botWork = new Map()
  let relayWork

  const service = () => ctx.get?.('agentPresets')
  const available = () => typeof service()?.register === 'function' && typeof service()?.list === 'function'
  const fileFor = id => join(dir, `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.yaml`)
  const baseLabel = definition => definition.base ?? definition.copiedFrom ?? 'DSH standard'

  async function writePreset(id, text) {
    await mkdir(dir, { recursive: true })
    const target = fileFor(id)
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, text, 'utf8')
    try {
      await replaceFile(temp, target)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
    return target
  }

  async function readPresetFile(id) {
    return readFile(fileFor(id), 'utf8')
  }

  async function rowOf(id) {
    if (!available()) return undefined
    try {
      return (await service().list()).find(row => row.id === id)
    } catch {
      return undefined
    }
  }

  async function activate(definition) {
    if (!available()) return { available: false, id: definition.id }
    const existing = registered.get(definition.id)
    if (existing !== undefined) {
      definitions.set(definition.id, definition)
      return { available: true, id: definition.id, ...(broken.has(definition.id) ? { broken: broken.get(definition.id) } : {}) }
    }
    // Another package may already own this id (notably the group relay preset in a
    // bundle patch). Use it rather than failing to start DS Bot.
    const row = await rowOf(definition.id)
    if (row !== undefined) {
      definitions.set(definition.id, definition)
      if (row.broken) broken.set(definition.id, row.broken)
      else broken.delete(definition.id)
      return { available: true, id: definition.id, external: true, ...(row.broken ? { broken: row.broken } : {}) }
    }
    let dispose
    try {
      dispose = await service().register(presetDefinition(definition))
    } catch (error) {
      broken.set(definition.id, errorText(error))
      return { available: true, id: definition.id, broken: errorText(error) }
    }
    registered.set(definition.id, dispose)
    definitions.set(definition.id, definition)
    const current = await rowOf(definition.id)
    if (current?.broken) {
      broken.set(definition.id, current.broken)
      return { available: true, id: definition.id, broken: current.broken }
    }
    broken.delete(definition.id)
    return { available: true, id: definition.id }
  }

  async function deactivate(id) {
    const dispose = registered.get(id)
    registered.delete(id)
    definitions.delete(id)
    broken.delete(id)
    if (dispose !== undefined) await dispose()
  }

  async function readPresetSource(row) {
    try {
      const document = await service().readDocument(row.id)
      return {
        id: row.id,
        name: document.name,
        description: document.description,
        plugins: readEntryList(document.content, `${row.id} preset`),
      }
    } catch (error) {
      rt.warn?.('ds-bot: could not copy preset %s: %s', row.id, errorText(error))
      return undefined
    }
  }

  async function readBase(preferred) {
    if (!available()) return undefined
    const rows = await service().list()
    // Bot-owned presets are copies, never templates for another Bot. The relay preset is
    // internal too; accepting either here would make a chain of copies instead of using
    // the native preset the user chose.
    const usable = rows.filter(row => row.broken === undefined && !isBotPreset(row.id))
    if (preferred !== undefined) {
      const wanted = usable.find(row => row.id === preferred)
      if (wanted === undefined) throw new Error(`The DSH Agent preset ${preferred} is unavailable`)
      const source = await readPresetSource(wanted)
      if (source === undefined) throw new Error(`The DSH Agent preset ${preferred} could not be read`)
      return source
    }
    const ordered = [
      ...BASE_PRIORITY.map(id => usable.find(row => row.id === id)).filter(Boolean),
      ...usable.filter(row => !BASE_PRIORITY.includes(row.id)),
    ]
    for (const row of ordered) {
      const source = await readPresetSource(row)
      if (source !== undefined) return source
    }
    return undefined
  }

  async function sourceDefinition(copyOf, basePreset) {
    if (copyOf !== undefined) {
      const source = rt.botOf?.(copyOf)
      if (source === undefined) throw new Error('The Bot whose preset is being copied no longer exists')
      const result = await ensureBotPreset(source)
      if (result.broken !== undefined) throw new Error(`The preset of ${source.name} cannot be copied: ${result.broken}`)
      const definition = readDefinition(await readPresetFile(result.id), result.id)
      return { ...definition, copiedFrom: copyOf }
    }
    const base = await readBase(basePreset)
    if (base === undefined) throw new Error('DSH has no usable native Agent preset to copy from')
    return { base: base.id, plugins: base.plugins }
  }

  async function createOwnedPreset({ name, copyOf, basePreset }) {
    if (!available()) return undefined
    const readOnly = rt.readOnly?.()
    if (readOnly !== undefined) throw new Error(readOnly)
    const source = await sourceDefinition(copyOf, typeof basePreset === 'string' && basePreset.trim() !== '' ? basePreset.trim() : undefined)
    const definition = {
      id: `${BOT_PREFIX}${randomUUID()}`,
      name: `${name} preset`,
      description: `Native DSH Agent preset owned by ${name}. Future Sessions of this Bot use it.`,
      order: PRESET_ORDER,
      base: source.base ?? source.copiedFrom ?? source.id,
      ...(copyOf === undefined ? {} : { copiedFrom: copyOf }),
      plugins: source.plugins,
    }
    await writePreset(definition.id, presetText(definition))
    const result = await activate(definition)
    if (result.broken !== undefined) {
      await deactivate(definition.id)
      await unlink(fileFor(definition.id)).catch(() => {})
      throw new Error(`The Agent preset for ${name} did not load: ${result.broken}`)
    }
    return definition.id
  }

  async function createMigratedPreset(bot, id) {
    const source = await sourceDefinition()
    const definition = {
      id,
      name: `${bot.name} preset`,
      description: `Native DSH Agent preset owned by ${bot.name}. Future Sessions of this Bot use it.`,
      order: PRESET_ORDER,
      base: source.base ?? source.id,
      plugins: source.plugins,
    }
    await writePreset(id, presetText(definition))
    return definition
  }

  async function ensureBotPreset(bot, { persist = true } = {}) {
    if (bot === undefined || typeof bot.id !== 'string') throw new Error('Unknown Bot')
    if (!available()) return { available: false, id: bot.agentPreset }
    const knownId = typeof bot.agentPreset === 'string' && bot.agentPreset !== '' ? bot.agentPreset : undefined
    if (knownId !== undefined && (registered.has(knownId) || definitions.has(knownId))) {
      return { available: true, id: knownId, ...(broken.has(knownId) ? { broken: broken.get(knownId) } : {}) }
    }
    const pending = botWork.get(bot.id)
    if (pending !== undefined) return pending
    const work = (async () => {
      let changed = false
      try {
        let id = typeof bot.agentPreset === 'string' && bot.agentPreset !== '' ? bot.agentPreset : undefined
        let definition
        const readOnly = rt.readOnly?.()
        if (id === undefined) {
          if (readOnly !== undefined) return { available: true, broken: readOnly }
          id = `${BOT_PREFIX}${randomUUID()}`
          definition = await createMigratedPreset(bot, id)
          bot.agentPreset = id
          changed = true
        } else {
          try {
            definition = readDefinition(await readPresetFile(id), id)
          } catch (error) {
            if (error?.code !== 'ENOENT') {
              broken.set(id, errorText(error))
              return { available: true, id, broken: errorText(error) }
            }
            if (readOnly !== undefined) return { available: true, id, broken: readOnly }
            definition = await createMigratedPreset(bot, id)
          }
        }
        const result = await activate(definition)
        if (result.broken !== undefined) broken.set(id, result.broken)
        return result
      } catch (error) {
        const id = typeof bot.agentPreset === 'string' ? bot.agentPreset : undefined
        if (id !== undefined) broken.set(id, errorText(error))
        rt.warn?.('ds-bot: the Agent preset for %s is unavailable: %s', bot.name ?? bot.id, errorText(error))
        return { available: true, ...(id === undefined ? {} : { id }), broken: errorText(error) }
      } finally {
        botWork.delete(bot.id)
        if (changed && persist) await rt.save().catch(error => rt.warn?.('ds-bot: saving %s agent preset id failed: %s', bot.name ?? bot.id, errorText(error)))
      }
    })()
    botWork.set(bot.id, work)
    return work
  }

  async function ensureBotPresets() {
    if (!available()) return
    let changed = false
    for (const bot of Object.values(rt.state?.bots ?? {})) {
      const before = bot.agentPreset
      await ensureBotPreset(bot, { persist: false })
      if (bot.agentPreset !== before) changed = true
    }
    if (changed) await rt.save()
  }

  async function botAgentPreset(bot) {
    const result = await ensureBotPreset(bot)
    if (result.available === false) return undefined
    if (result.broken !== undefined) throw new Error(`The Agent preset for ${bot.name} is unavailable: ${result.broken}`)
    return result.id
  }

  async function groupAgentPreset() {
    if (!available()) return undefined
    if (relayWork !== undefined) return relayWork
    relayWork = (async () => {
      const existing = await rowOf(GROUP_RELAY_ID)
      if (existing?.broken === undefined && existing !== undefined) return GROUP_RELAY_ID
      const base = await readBase()
      if (base === undefined) return undefined
      const result = await activate({
        id: GROUP_RELAY_ID,
        name: 'DS Bot group relay',
        description: 'The system preset used by a group chat to relay its turn to member Bots.',
        order: PRESET_ORDER,
        base: base.id,
        plugins: base.plugins,
      })
      if (result.broken !== undefined) {
        rt.warn?.('ds-bot: group relay preset is unavailable, using %s: %s', base.id, result.broken)
        await deactivate(GROUP_RELAY_ID)
        return base.id
      }
      return GROUP_RELAY_ID
    })().finally(() => { relayWork = undefined })
    return relayWork
  }

  async function presetView(bot) {
    if (!available()) return { available: false, id: bot?.agentPreset ?? null, editable: false }
    await ensureBotPreset(bot)
    const id = bot.agentPreset
    try {
      const definition = readDefinition(await readPresetFile(id), id)
      const row = await rowOf(id)
      return {
        available: true,
        id,
        name: definition.name ?? bot.name,
        description: definition.description,
        base: baseLabel(definition),
        editable: false,
        ...(broken.get(id) ?? row?.broken ? { broken: broken.get(id) ?? row?.broken } : {}),
      }
    } catch (error) {
      return { available: true, id, editable: false, broken: broken.get(id) ?? errorText(error) }
    }
  }

  async function deleteBotPreset(bot) {
    const id = bot?.agentPreset
    if (typeof id !== 'string' || id === '') return
    await deactivate(id).catch(error => rt.warn?.('ds-bot: %s preset not unregistered: %s', bot.name, errorText(error)))
    await unlink(fileFor(id)).catch(error => {
      if (error?.code !== 'ENOENT') rt.warn?.('ds-bot: %s preset file not removed: %s', bot.name, errorText(error))
    })
  }

  Object.assign(rt, {
    ensureBotPreset,
    ensureBotPresets,
    botAgentPreset,
    groupAgentPreset,
    createOwnedPreset,
    deleteBotPreset,
    presetView,
  })

  ctx.effect(() => () => Promise.allSettled([...registered.entries()].map(async ([id, dispose]) => {
    registered.delete(id)
    definitions.delete(id)
    broken.delete(id)
    await dispose()
  })), 'ds-bot: Bot agent presets')
}
