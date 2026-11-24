// Settings → Plugin packs. The catalog is owned by DS Bot; installation and
// enablement stay in DSH's native plugin manager. A pack is a capability family,
// not a second profile: profile-wide packs are switched here, while authority
// packs are shown with their owner and a route to the owning DS Bot setting.
import { createElement as h, useEffect, useState } from 'react'
import { CheckIcon, PlugIcon } from './icons.js'
import { t } from './i18n.js'

const LANE_ORDER = ['team', 'code-lab', 'long-context', 'agent-lab', 'media', 'ui']
const STATUS_TEXT = {
  enabled: 'Enabled',
  disabled: 'Disabled',
  missing: 'Not installed',
  partial: 'Partly enabled',
  error: 'Needs attention',
  unavailable: 'Unavailable',
}
const SCOPE_TEXT = { profile: 'Profile-wide', bot: 'Per Bot', lane: 'Lane' }

function laneName(lane) {
  return lane?.title ?? lane?.id ?? 'Team'
}

function statusText(pack) {
  if (pack.status === 'missing' && pack.installable === false) return t('Local package is not installed')
  if (pack.status === 'error' && pack.error) return `${t(STATUS_TEXT.error)}: ${pack.error}`
  return t(STATUS_TEXT[pack.status] ?? 'Unavailable')
}

function packMeta(pack) {
  return [
    t(SCOPE_TEXT[pack.scope] ?? 'Profile-wide'),
    pack.kind === undefined ? null : t(pack.kind === 'ui' ? 'UI' : pack.kind.replace(/^./, letter => letter.toUpperCase())),
    ...(pack.version ? [`v${pack.version}`] : []),
  ].filter(Boolean).join(' · ')
}

function packReason(pack, view) {
  if (pack.authority !== undefined) return t('Managed by DS Bot: {owner}. Switch this authority in the owning DS Bot settings.', { owner: pack.authorityOwner ?? t('DS Bot') })
  if (pack.status === 'missing' && pack.installable === false) return t('This pack is supplied by a local package, so it cannot be installed from the registry here.')
  if (pack.status === 'missing') return t('Install it here, or open Plugins to manage the native DSH package.')
  if (pack.status === 'error') return t('Open Plugins to repair or disable this native DSH bundle.')
  if (pack.status === 'partial') return t('Some native rows are enabled. Enable the pack to align all of them.')
  if (pack.conflicts?.length > 0) {
    const other = (view.packs ?? []).find(row => row.id === pack.conflicts[0])
    return t('Disable {name} before enabling this pack.', { name: other?.title ?? pack.conflicts[0] })
  }
  if (pack.status === 'unavailable') return t('This DSH does not expose the native plugin manager.')
  return null
}


function AuthorityRow({ authority, busy, onChange, Row }) {
  const selected = authority.options.find(option => option.id === authority.selected)
  const status = option => option.status === 'missing' ? t('Not installed') : option.status === 'error' ? t('Needs attention') : option.status === 'disabled' ? t('Disabled') : option.status === 'partial' ? t('Partly enabled') : option.status === 'enabled' ? t('Enabled') : option.status === 'internal' ? t('Built in') : t('Unavailable')
  return h(Row, {
    label: authority.title,
    hint: selected ? t('{name} owns this authority.', { name: selected.owner }) : null,
  }, h('select', {
    className: 'bt-select bt-packs-authority',
    'aria-label': authority.title,
    value: authority.selected,
    disabled: busy === `authority:${authority.id}`,
    onChange: event => onChange(authority.id, event.target.value),
  }, authority.options.map(option => h('option', {
    key: option.id, value: option.id, disabled: option.status === 'error' || option.status === 'unavailable',
  }, `${option.title} · ${status(option)}`))))
}

function PackRow({ pack, view, busy, onChange, onInstall, onOpenPlugins, Row }) {
  const canChange = pack.canToggle === true && busy === ''
  const canInstall = pack.canInstall === true && busy === ''
  const control = pack.authority === undefined && canInstall
    ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: !canInstall, onClick: () => onInstall(pack.id) }, t('Install'))
    : pack.authority === undefined && pack.canToggle === true
      ? h('button', { type: 'button', className: pack.enabled ? 'bt-soft bt-soft-sm' : 'bt-send bt-soft-sm', disabled: !canChange || pack.conflicts?.length > 0, onClick: () => onChange(pack.id, !pack.enabled) }, busy === pack.id ? t('Working…') : pack.enabled ? t('Disable') : t('Enable'))
      : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onOpenPlugins }, t('Open Plugins'))
  const reason = packReason(pack, view)
  return h(Row, {
    key: pack.id,
    className: 'bt-packs-row',
    label: h('span', { className: 'bt-packs-title' }, pack.title, pack.enabled ? h(CheckIcon, { className: 'bt-packs-check' }) : null),
    hint: [pack.description, packMeta(pack), statusText(pack), reason].filter(Boolean).join(' · '),
  }, control)
}

export function PluginPacksPage({ roster, actions, run, Section, Row }) {
  const live = roster?.pluginPacks ?? null
  const [fetched, setFetched] = useState(null)
  const [lane, setLane] = useState('team')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const view = live ?? fetched ?? { available: false, packs: [], lanes: [], lastChange: null }
  const refresh = () => {
    if (typeof actions?.pluginPacks !== 'function') return Promise.resolve(null)
    return Promise.resolve(actions.pluginPacks()).then((next) => {
      if (next !== undefined) setFetched(next)
      return next
    })
  }
  useEffect(() => { void refresh().catch(failure => setError(failure?.message ?? String(failure))) }, [])
  const lanes = Array.isArray(view.lanes) && view.lanes.length > 0
    ? [...view.lanes].sort((a, b) => LANE_ORDER.indexOf(a.id) - LANE_ORDER.indexOf(b.id))
    : LANE_ORDER.map(id => ({ id, title: id, description: '', packs: [] }))
  const current = lanes.find(row => row.id === lane) ?? lanes[0]
  const packs = (current?.packs ?? []).map(id => (view.packs ?? []).find(pack => pack.id === id)).filter(Boolean)
  const openPlugins = () => actions?.openSettings?.('dsh', 'plugins')
  const changeAuthority = (authority, id) => {
    setBusy(`authority:${authority}`); setError('')
    return Promise.resolve(actions?.setPluginPackAuthority?.(authority, id)).then((next) => {
      if (next !== undefined) setFetched(next)
      return next
    }).catch(failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(''))
  }
  const change = (id, enabled) => {
    setBusy(id); setError('')
    return Promise.resolve(actions?.setPluginPack?.(id, enabled)).then((next) => {
      if (next !== undefined) setFetched(next)
      return next
    }).catch(failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(''))
  }
  const install = id => {
    setBusy(id); setError('')
    return Promise.resolve(actions?.installPluginPack?.(id)).then((next) => {
      if (next !== undefined) setFetched(next)
      return next
    }).catch(failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(''))
  }
  const last = view.lastChange
  return [
    h('section', { key: 'intro', className: 'bt-set-section bt-packs-intro' },
      h('div', { className: 'bt-packs-lead' },
        h('span', { className: 'bt-packs-mark', 'aria-hidden': true }, h(PlugIcon)),
        h('div', { className: 'bt-packs-copy' },
          h('h3', null, t('Plugin packs')),
          h('p', null, t('Capabilities are grouped by lane so alternative engines, memory and compression stay available without becoming one runtime. DSH installs and loads the native bundles.')))),
      error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
      last?.application === 'restart-required' ? h('div', { className: 'bt-packs-banner', role: 'status' }, t('Restart DSH to load the change in this profile.'), last.restartReason ? h('span', null, ` (${last.restartReason})`) : null) : null,
      last?.application === 'failed' ? h('div', { className: 'bt-error', role: 'alert' }, t('The last plugin change failed.')) : null),
    h(Section, { key: 'authorities', title: t('Authorities'), action: null },
      Object.values(view.authorities ?? {}).map(authority => h(AuthorityRow, { key: authority.id, authority, busy, onChange: changeAuthority, Row }))),
    h('section', { key: 'lanes', className: 'bt-set-section' },
      h('div', { className: 'bt-packs-lanes', role: 'tablist', 'aria-label': t('Plugin pack lanes') },
        lanes.map(row => h('button', {
          key: row.id, type: 'button', role: 'tab', className: 'bt-packs-lane', 'aria-selected': row.id === current?.id, onClick: () => setLane(row.id),
        }, laneName(row))))),
    h(Section, { key: 'packs', title: laneName(current), action: view.available === false ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: openPlugins }, t('Open Plugins')) },
      current?.description ? h('p', { className: 'bt-set-hint bt-packs-lane-hint' }, current.description) : null,
      packs.length === 0 ? h(Row, { label: t('No packs in this lane') }) : null,
      packs.map(pack => h(PackRow, { key: pack.id, pack, view, busy, onChange: change, onInstall: install, onOpenPlugins: openPlugins, Row })),
      view.available === false ? h(Row, { label: t('Native plugin manager unavailable'), hint: t('Install and enable bundles from DSH Plugins. DS Bot keeps this catalog read-only until that service is available.') }) : null),
  ]
}

export const PLUGIN_PACKS_CSS = `
.bt-packs-intro{gap:12px}
.bt-packs-lead{display:flex;align-items:flex-start;gap:12px;padding:4px 4px 0}
.bt-packs-mark{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex:none;border-radius:10px;background:var(--bt-accent-soft);color:var(--bt-accent)}
.bt-packs-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.bt-packs-copy h3{font-size:13px;line-height:18px;font-weight:600;margin:0}
.bt-packs-copy p{margin:0;color:var(--bt-ink-2);font-size:12px;line-height:18px}
.bt-packs-banner{padding:10px 12px;border:.5px solid color-mix(in srgb,var(--bt-star) 35%,var(--bt-line));border-radius:10px;background:color-mix(in srgb,var(--bt-star) 10%,var(--bt-card));color:var(--bt-ink);font-size:12px;line-height:17px}
.bt-packs-lanes{display:flex;align-items:center;gap:4px;overflow-x:auto;padding:1px 4px 2px;scrollbar-width:thin}
.bt-packs-lane{flex:none;border:0;border-radius:999px;background:transparent;color:var(--bt-ink-2);padding:6px 10px;font:inherit;font-size:12px;line-height:16px;cursor:pointer}
.bt-packs-lane:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-packs-lane[aria-selected=true]{background:var(--bt-active);color:var(--bt-ink);font-weight:550}
.bt-packs-lane:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-packs-lane-hint{padding:0 4px 8px;margin:0}
.bt-packs-row .bt-set-copy{gap:3px;min-width:0}
.bt-packs-authority{min-width:220px;max-width:100%}
.bt-packs-title{display:inline-flex;align-items:center;gap:6px;min-width:0}
.bt-packs-check{color:var(--bt-green);flex:none}
.bt-packs-row .bt-set-hint{overflow-wrap:anywhere}
@media (max-width:640px){
  .bt-packs-lead{padding:0}
  .bt-packs-lanes{margin:0 -4px}
  .bt-packs-row .bt-set-control{width:100%}
}
`
