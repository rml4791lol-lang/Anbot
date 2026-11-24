import { createElement as h, useEffect, useRef, useState } from 'react'
import { BotMark } from './mark.js'
import { CharacterGrid } from './bot-settings.js'
import { AvatarLibraryPanel, avatarImage } from './avatar-library.js'
import { DEFAULT_SHAPES, DEFAULT_COLORS } from './characters.js'
import { ChevronLeftIcon, CloseIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { createPayload, freshBotName, SKILL_SHORTLIST_MAX, skillPurpose, startModel } from './bot-draft.js'
import { ModelMenu, useAgentModels } from './model-menu.js'
import { CliList, ReadingModels, RunModeSwitch, useLocalAgents } from './agent-cards.js'
import { agentAvatar, modelsFor, routeOf } from './agent-routes.js'
import { hostText, t } from './i18n.js'
import { call } from './api.js'
import { nameProblem } from '../shared/mentions.js'
import { engineeringPresets } from '../shared/engineering-presets.js'

const pick = list => list[Math.floor(Math.random() * list.length)]
const randomLook = (avoid = {}) => {
  const shapes = DEFAULT_SHAPES.filter(shape => shape !== avoid.shape)
  const colors = DEFAULT_COLORS.filter(color => color !== avoid.color)
  return { shape: pick(shapes), color: pick(colors) }
}

// The new-Bot form: what it runs on, then look, name and model. Nothing exists until Create.
// `inline` drops the pane's header for a form shown inside Settings.
export function CreateBot({ roster, actions, start, brief = '', onBack, canGoBack, onCreated, inline = false }) {
  const [look, setLook] = useState(() => randomLook())
  const [image, setImage] = useState(null)
  const [library, setLibrary] = useState(false)
  const [name, setName] = useState(start?.name ?? '')
  const [instructions, setInstructions] = useState('')
  const [preset, setPreset] = useState('')
  const [presets, setPresets] = useState([])
  const [presetError, setPresetError] = useState('')
  const [skills, setSkills] = useState([])
  const [skillQuery, setSkillQuery] = useState('')
  const [mode, setMode] = useState('model')
  const [model, setModel] = useState(() => startModel(roster))
  const [agentModel, setAgentModel] = useState('')
  const [ownLook, setOwnLook] = useState(false)
  const [effort, setEffort] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef(null)
  const frame = useRef(null)
  const localAgents = useLocalAgents(mode === 'local')
  const [reading, readModels] = useAgentModels(actions)
  const local = mode === 'local'
  const chosen = local ? agentModel : model
  useEscape(onBack)
  useEffect(() => {
    const controller = new AbortController()
    call('agent-presets', {}, controller.signal)
      .then(value => { if (!controller.signal.aborted) setPresets(value) })
      .catch(error => { if (!controller.signal.aborted) setPresetError(error.message) })
    return () => controller.abort()
  }, [])
  // Inside Settings the form opens below other sections, so it scrolls itself into view.
  useEffect(() => { if (inline) frame.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, [])
  const fallbackName = freshBotName(roster, t('New Bot'))
  const finalName = name.trim() || fallbackName
  const clash = roster.bots.some(bot => bot.name.toLowerCase() === finalName.toLowerCase())
  const problem = nameProblem(finalName)
  const missingAgent = local && chosen !== '' && localAgents.known
    && !localAgents.agents.some(agent => agent.route === routeOf(chosen) && agent.installed !== false)
  const blocked = busy || clash || Boolean(problem) || missingAgent || (local && chosen === '')
  const create = async () => {
    if (blocked) return
    setError('')
    setBusy(true)
    try {
      const bot = await actions.createBot(createPayload({
        name: finalName, look, image, model: chosen, effort: local ? undefined : effort, brief,
        instructions, skills: local ? undefined : skills, agentPreset: preset, ownLook, sectionId: start?.sectionId,
      }))
      onCreated(bot)
    } catch (failure) {
      setError(failure?.message ?? String(failure))
      setBusy(false)
    }
  }
  const upload = (file) => {
    if (!file) return
    setError('')
    avatarImage(file).then(setImage, failure => setError(failure?.message ?? String(failure)))
  }
  const pickAgent = (agent) => {
    setAgentModel(`${agent.route}/default`)
    readModels(agent.route)
  }
  const worn = local && chosen !== '' && !ownLook ? agentAvatar(routeOf(chosen))?.image : undefined
  const previewLook = image ? { ...look, image } : worn ? { ...look, image: worn } : look
  const catalog = (roster.newBotSkillCatalog ?? roster.skillCatalog ?? []).filter(skill => !Array.isArray(skill.bots))
  const visibleSkills = catalog.filter(skill => skill.name.toLowerCase().includes(skillQuery.trim().toLowerCase())
    || skills.some(item => item.name === skill.name))
  const recommendations = engineeringPresets.filter(item => item.skills.every(skill => catalog.some(candidate => candidate.name === skill.name)))
  const applyRecommendation = (item) => {
    setInstructions(current => current === '' ? item.instructions
      : current.includes(item.instructions) ? current : `${current.trimEnd()}\n\n${item.instructions}`)
    setSkills(current => [...current, ...item.skills.filter(skill => !current.some(entry => entry.name === skill.name))].slice(0, SKILL_SHORTLIST_MAX))
  }
  const card = h('div', { className: 'bt-create-card' },
    h(RunModeSwitch, { mode, setMode }),
    h('div', { className: 'bt-create-preview' },
      // The key remounts the mark, so every new pick plays the pop.
      h('span', { key: `${look.shape}:${look.color}:${previewLook.image ? 'photo' : ''}`, className: 'bt-create-pop' },
        h(BotMark, { look: previewLook, bot: { id: 'new-bot' }, size: 88, live: true, gaze: true, pokeable: true })),
      h('span', { className: 'bt-create-name' }, finalName)),
    h('div', { className: 'bt-create-step' }, t('Look')),
    h('div', { className: 'bt-create-looks' },
      h(CharacterGrid, {
        look, hasPhoto: Boolean(image),
        onShape: (shape) => { setImage(null); setOwnLook(true); setLook(current => ({ ...current, shape })) },
        onColor: (color) => { setImage(null); setOwnLook(true); setLook(current => ({ ...current, color })) },
      }),
      h('div', { className: 'bt-actions bt-create-lookbar' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { setImage(null); setOwnLook(true); setLook(current => randomLook(current)) } }, t('Shuffle')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => fileRef.current?.click() }, image ? t('Replace photo') : t('Upload photo')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-expanded': library, onClick: () => setLibrary(value => !value) }, t('Library')),
        image ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setImage(null) }, t('Remove photo')) : null,
        h('input', { ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, onChange: (event) => { const file = event.target.files?.[0]; event.target.value = ''; upload(file) } }))),
    // The library is a block of its own under the look, not a part of the button row.
    library ? h(AvatarLibraryPanel, { actions, onPick: entry => { setImage(entry.image); setLibrary(false) } }) : null,
    h('label', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Name')),
      h('input', {
        className: 'bt-input', autoFocus: !inline, value: name, placeholder: fallbackName, maxLength: 40, 'aria-label': t('Name'),
        onChange: event => setName(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void create() } },
      }),
      problem ? h('span', { className: 'bt-note bt-danger' }, hostText(problem))
        : clash ? h('span', { className: 'bt-note bt-danger' }, t('A Bot named {name} already exists', { name: finalName })) : null),
    local ? h('div', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Local agent')),
      h(CliList, { ...localAgents, selected: routeOf(chosen), onPick: pickAgent, actions })) : null,
    !local || chosen !== '' ? h('div', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Model'), local && reading ? h(ReadingModels) : null),
      h(ModelMenu, { bot: { id: 'new-bot', name: finalName, model: chosen || undefined, effort: local ? undefined : effort }, roster, actions, wide: true, onPick: (ref) => { if (local) { setAgentModel(ref); return } setModel(ref); setEffort(undefined) }, onPickEffort: picked => setEffort(picked ?? null) }),
      h('span', { className: 'bt-note' }, chosen
        ? t('The Bot runs on this model. You can change it later in its details.')
        : modelsFor(roster.models).length > 0
          ? t('Pick a model here, or the Bot asks for one in its chat.')
          : t('Add a provider and a model in DeepSeek Harness first, or pick one in the Bot\'s chat later.'))) : null,
    h('details', { className: 'bt-field' },
      h('summary', null, t('What this Bot does')),
      !local && recommendations.length > 0 ? h('div', { className: 'bt-field' },
        h('span', { className: 'bt-field-label' }, t('Start with a preset')),
        h('div', null, recommendations.map(item => h('button', {
          key: item.id, type: 'button', className: 'bt-soft bt-soft-sm',
          disabled: skills.length + item.skills.filter(skill => !skills.some(entry => entry.name === skill.name)).length > SKILL_SHORTLIST_MAX,
          onClick: () => applyRecommendation(item),
        }, t(item.label))))) : null,
      presets.length > 0 ? h('label', { className: 'bt-field' },
        h('span', { className: 'bt-field-label' }, t('Agent preset')),
        h('select', {
          className: 'bt-input', value: preset, onChange: event => setPreset(event.target.value),
        }, h('option', { value: '' }, t('Default')), presets.map(choice => h('option', { key: choice.id, value: choice.id }, choice.name)))) : null,
      presetError ? h('p', { className: 'bt-note bt-danger', role: 'status' }, presetError) : null,
      h('label', { className: 'bt-field' },
        h('span', { className: 'bt-field-label' }, t('Instructions')),
        h('textarea', {
          className: 'bt-input bt-input-area',
          'aria-label': t('Instructions'),
          placeholder: t('What this Bot is responsible for…'),
          value: instructions,
          onChange: event => setInstructions(event.target.value),
        })),
      local || catalog.length === 0 ? null : h('details', { className: 'bt-field' },
        h('summary', null, t('Skills')),
        h('p', { className: 'bt-note' }, t('Up to 5 skills. The prompt lists each name with one line saying when to use it.')),
        catalog.length > 8 ? h('input', {
          type: 'search', className: 'bt-input', placeholder: t('Search skills'), 'aria-label': t('Search skills'),
          value: skillQuery, onChange: event => setSkillQuery(event.target.value),
        }) : null,
        h('div', { className: 'bt-create-skill-list' }, visibleSkills.map(skill => {
          const checked = skills.some(item => item.name === skill.name)
          return h('label', { key: skill.name, className: 'bt-create-skill' },
            h('input', {
              type: 'checkbox', value: skill.name, checked, disabled: !checked && skills.length >= SKILL_SHORTLIST_MAX,
              onChange: event => {
                const enabled = event.target.checked
                setSkills(current => enabled
                  ? current.length >= SKILL_SHORTLIST_MAX || current.some(item => item.name === skill.name)
                    ? current
                    : [...current, { name: skill.name, purpose: skillPurpose(skill) }]
                  : current.filter(item => item.name !== skill.name))
              },
            }),
            skill.name)
        })))),
    error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null,
    h('div', { className: 'bt-create-foot' },
      h('button', { type: 'button', className: 'bt-soft', onClick: onBack }, canGoBack ? t('Back') : t('Cancel')),
      h('button', { type: 'button', className: 'bt-send bt-create-go', disabled: blocked, onClick: () => void create() }, busy ? t('Creating…') : t('Create'))))
  if (inline) return h('div', { ref: frame, className: 'bt-create-inline', role: 'group', 'aria-label': t('Create Bot') }, card)
  return h('div', { className: 'bt-create', role: 'dialog', 'aria-label': t('Create Bot') },
    h('div', { className: 'bt-create-head' },
      canGoBack ? h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to new chat'), onClick: onBack }, h(ChevronLeftIcon)) : h('span', { className: 'bt-create-gap' }),
      h('span', { className: 'bt-create-title' }, t('Create Bot')),
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: () => actions.closeOverlay() }, h(CloseIcon))),
    h('div', { className: 'bt-create-body' }, card))
}
