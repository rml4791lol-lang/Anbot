import { createHash, randomUUID } from 'node:crypto'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'

export const ownedPresetId = value => typeof value === 'string' && value.startsWith('anbot-preset-')

export function install(rt) {
  const { ctx, state } = rt
  const mounts = new Map()
  const registry = () => ctx.get?.('agentPresets')

  async function loadBase(service, base) {
    const { content } = await service.readDocument(base)
    return { content, revision: createHash('sha256').update(content).digest('hex') }
  }

  async function mount(binding, source) {
    const service = registry()
    if (typeof service?.register !== 'function' || typeof service.readDocument !== 'function') {
      throw new Error('This DSH cannot register Bot presets')
    }
    const { content, revision } = source ?? await loadBase(service, binding.base)
    if (revision !== binding.revision) throw new Error(`The DSH Agent preset ${binding.base} changed. Restore its previous definition to reopen this Bot preset.`)
    let plugins
    try {
      plugins = load(content, { schema: entryListSchema })
    } catch {
      throw new Error('The DSH Agent preset definition could not be parsed')
    }
    if (!Array.isArray(plugins)) throw new Error('The DSH Agent preset must declare a plugin list')
    const dispose = await service.register({ id: binding.id, name: `Anbot · ${binding.base}`, plugins })
    try {
      const registered = (await service.list()).find(preset => preset.id === binding.id)
      if (!registered || registered.broken !== undefined) throw new Error('DSH could not load the Bot preset')
      return dispose
    } catch (error) {
      await dispose()
      throw error
    }
  }

  async function ensureBotPreset(binding, source) {
    if (binding === undefined) return undefined
    if (!ownedPresetId(binding.id)) throw new Error('Invalid Bot preset ID')
    let pending = mounts.get(binding.id)
    if (pending === undefined) {
      pending = mount(binding, source)
      mounts.set(binding.id, pending)
      pending.catch(() => {
        if (mounts.get(binding.id) === pending) mounts.delete(binding.id)
      })
    }
    await pending
    return binding.id
  }

  async function createBotPreset(base, previous) {
    const service = registry()
    if (typeof service?.register !== 'function' || typeof service.readDocument !== 'function') return undefined
    const source = await loadBase(service, base)
    const binding = { id: `anbot-preset-${randomUUID()}`, base, revision: previous?.revision ?? source.revision }
    await ensureBotPreset(binding, source)
    return binding
  }

  async function dropBotPreset(binding) {
    if (binding === undefined) return
    const pending = mounts.get(binding.id)
    if (pending === undefined) return
    mounts.delete(binding.id)
    const dispose = await pending.catch(() => undefined)
    await dispose?.()
  }

  async function restoreBotPresets() {
    for (const bot of Object.values(state.bots)) {
      if (bot.presetBinding === undefined) continue
      try {
        await ensureBotPreset(bot.presetBinding)
      } catch (error) {
        rt.warn('ds-bot: preset for %s is unavailable: %s', bot.name, error.message)
      }
    }
  }

  Object.assign(rt, { createBotPreset, dropBotPreset, ensureBotPreset, restoreBotPresets })
  ctx.effect(() => () => Promise.allSettled([...mounts.keys()].map(id => dropBotPreset({ id }))), 'ds-bot: owned Agent presets')
}
