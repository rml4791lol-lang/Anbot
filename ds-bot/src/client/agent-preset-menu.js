import { createElement as h, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon } from './icons.js'
import { Caret, useAnchoredMenu } from './model-menu.js'
import { IconAgentPresetOutlineMedium } from './dsh-primitives.js'
import { t } from './i18n.js'
import { presetBaseName, presetBases } from './agent-preset-bases.js'

export { defaultPresetBase, presetBaseName, presetBases } from './agent-preset-bases.js'

// Direct selection from the DSH preset roster. The menu shows only names and the
// description DSH publishes; YAML and ids belong to DSH, not to this form.
export function BotPresetMenu({ value, presets, loading = false, disabled = false, onPick }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu()
  const rows = presetBases(presets)
  const selected = rows.find(preset => preset.id === value)
  const label = selected === undefined ? loading ? t('Loading…') : t('None') : presetBaseName(selected)
  const toggle = () => {
    if (disabled || rows.length === 0) return
    if (isOpen) close()
    else open()
  }
  const pick = (id) => {
    close()
    if (id !== value) onPick(id)
  }
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-model-trigger bt-preset-trigger', 'data-wide': true,
      'aria-haspopup': 'menu', 'aria-expanded': isOpen, 'aria-label': t('Agent preset'),
      disabled: disabled || rows.length === 0, onClick: toggle,
    },
    h(IconAgentPresetOutlineMedium, { size: 15, className: 'bt-preset-icon' }),
    h('span', { className: 'bt-model-copy' },
      h('span', { className: 'bt-model-name' }, label),
      selected?.description ? h('span', { className: 'bt-model-provider' }, selected.description) : null),
    h(Caret)),
    shownPlace ? createPortal(h('div', {
      ref: menu, className: `bt-menu bt-model-menu bt-preset-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`,
      role: 'menu', 'aria-label': t('Agent preset'), style: shownPlace, 'data-leaving': leaving || undefined,
    }, rows.map(preset => h('button', {
      key: preset.id, type: 'button', role: 'menuitemradio', 'aria-checked': preset.id === value,
      title: preset.description ?? presetBaseName(preset), onClick: () => pick(preset.id),
    },
    h('span', { className: 'bt-preset-option' },
      h('span', { className: 'bt-menu-label' }, presetBaseName(preset)),
      preset.description ? h('span', { className: 'bt-preset-description' }, preset.description) : null),
    h('span', { className: 'bt-model-tick', 'aria-hidden': true }, preset.id === value ? h(CheckIcon) : null)))), document.body) : null)
}

export const AGENT_PRESET_MENU_CSS = `
.bt-preset-trigger .bt-preset-icon{flex:none;color:var(--bt-ink-2)}
.bt-preset-option{display:flex;flex-direction:column;min-width:0;gap:1px}
.bt-preset-description{max-width:420px;font-size:11px;line-height:15px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-preset-menu .bt-model-name,.bt-preset-menu .bt-model-provider{text-align:left}
`
