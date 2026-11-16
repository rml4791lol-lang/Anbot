import { createElement as h, useMemo, useState } from 'react'
import { CheckIcon, ChevronRightIcon, ClockIcon, CloseIcon, GlobeIcon, PencilIcon, PlusIcon, RefreshIcon, StarLineIcon } from './icons.js'
import { relativeShort } from './text.js'
import { t } from './i18n.js'
import { siteCatalogModel } from './site-directory-model.js'

const environmentWord = value => value === 'production' ? t('Production')
  : value === 'preview' ? t('Preview')
    : value === 'local' ? t('Local')
      : t('Docs')

const healthWord = status => status === 'online' ? t('Online')
  : status === 'auth' ? t('Sign-in required')
    : status === 'error' ? t('HTTP error')
      : status === 'offline' ? t('Offline')
        : t('Not checked')

const shortPath = value => {
  const parts = String(value ?? '').split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? ''
}

const hostOf = value => {
  try { return new URL(value).host } catch { return String(value ?? '') }
}

const tagsOf = value => String(value ?? '').split(/[,，]/).map(tag => tag.trim()).filter(Boolean)

export function SiteSummary({ counts = {} }) {
  const rows = [
    [counts.total ?? 0, t('Published'), 'projects', GlobeIcon],
    [counts.online ?? 0, t('Online'), 'working', CheckIcon],
    [counts.local ?? 0, t('Local'), 'memory', ClockIcon],
    [counts.attention ?? 0, t('Needs attention'), 'needs', RefreshIcon],
    [counts.groups ?? 0, t('Groups'), 'rules', StarLineIcon],
  ]
  return h('div', { className: 'bt-teamov-portfolio bt-sites-summary' },
    h('div', { className: 'bt-teamov-portfolio-mark' }, h(GlobeIcon)),
    h('div', { className: 'bt-teamov-portfolio-copy' },
      h('b', null, t('Published sites')),
      h('span', null, t('Production, previews and local entry points'))),
    h('div', { className: 'bt-teamov-portfolio-stats' }, rows.map(([value, label, kind, Icon]) =>
      h('span', { key: label, 'data-kind': kind }, h('b', null, value), h('small', null, h(Icon), label)))))
}

function SiteForm({ site, groups, paths, busy, onSubmit, onCancel }) {
  const [form, setForm] = useState(() => ({
    id: site?.id,
    name: site?.name ?? '',
    url: site?.url ?? '',
    environment: site?.environment ?? 'production',
    groupId: site?.groupId ?? '',
    projectPath: site?.projectPath ?? '',
    repoUrl: site?.repoUrl ?? '',
    tags: (site?.tags ?? []).join(', '),
    notes: site?.notes ?? '',
    favorite: site?.favorite === true,
    archived: site?.archived === true,
  }))
  const field = key => event => setForm(value => ({ ...value, [key]: event.target.value }))
  const submit = event => {
    event.preventDefault()
    onSubmit({ ...form, groupId: form.groupId || null, tags: tagsOf(form.tags) })
  }
  return h('form', { className: 'bt-site-form', onSubmit: submit },
    h('div', { className: 'bt-site-form-head' },
      h('div', null, h('span', { className: 'bt-teamov-kicker' }, site ? t('Edit site') : t('New site')), h('h4', null, form.name || t('Published site'))),
      h('button', { type: 'button', className: 'bt-round bt-round-sm', 'aria-label': t('Close'), title: t('Close'), onClick: onCancel }, h(CloseIcon))),
    h('div', { className: 'bt-site-form-grid' },
      h('label', null, h('span', null, t('Name')), h('input', { required: true, maxLength: 100, value: form.name, placeholder: t('Site name'), onChange: field('name') })),
      h('label', null, h('span', null, t('URL')), h('input', { required: true, type: 'url', value: form.url, placeholder: 'https://example.com', onChange: field('url') })),
      h('label', null, h('span', null, t('Site type')), h('select', { value: form.environment, onChange: field('environment') },
        ['production', 'preview', 'local', 'docs'].map(value => h('option', { key: value, value }, environmentWord(value))))),
      h('label', null, h('span', null, t('Site group')), h('select', { value: form.groupId, onChange: field('groupId') },
        h('option', { value: '' }, t('Ungrouped')),
        groups.map(group => h('option', { key: group.id, value: group.id }, group.name)))),
      h('label', { className: 'wide' }, h('span', null, t('Project folder')), h('input', { value: form.projectPath, list: 'bt-site-project-paths', placeholder: t('Optional project folder'), onChange: field('projectPath') }),
        h('datalist', { id: 'bt-site-project-paths' }, paths.map(path => h('option', { key: path, value: path })))),
      h('label', { className: 'wide' }, h('span', null, t('Repository')), h('input', { value: form.repoUrl, placeholder: t('Optional repository URL'), onChange: field('repoUrl') })),
      h('label', { className: 'wide' }, h('span', null, t('Tags')), h('input', { value: form.tags, placeholder: t('Comma-separated tags'), onChange: field('tags') })),
      h('label', { className: 'wide' }, h('span', null, t('Notes')), h('textarea', { rows: 3, maxLength: 2000, value: form.notes, placeholder: t('What this entry is for'), onChange: field('notes') }))),
    h('div', { className: 'bt-site-form-foot' },
      h('label', { className: 'bt-site-check' }, h('input', { type: 'checkbox', checked: form.favorite, onChange: event => setForm(value => ({ ...value, favorite: event.target.checked })) }), t('Pin to the top')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: onCancel }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-soft bt-soft-sm bt-with-icon', disabled: busy || form.name.trim() === '' || form.url.trim() === '' }, h(CheckIcon), busy ? t('Saving…') : t('Save site'))))
}

function GroupForm({ group, busy, onSubmit, onCancel, onDelete }) {
  const [name, setName] = useState(group?.name ?? '')
  const [color, setColor] = useState(group?.color ?? 'blue')
  return h('form', { className: 'bt-site-group-form', onSubmit: event => { event.preventDefault(); if (name.trim()) onSubmit({ id: group?.id, name: name.trim(), color }) } },
    h('input', { autoFocus: true, maxLength: 100, value: name, placeholder: t('Site group name'), 'aria-label': t('Site group name'), onChange: event => setName(event.target.value) }),
    h('select', { value: color, 'aria-label': t('Group color'), onChange: event => setColor(event.target.value) },
      ['blue', 'orange', 'green', 'violet', 'rose'].map(value => h('option', { key: value, value }, t(value[0].toUpperCase() + value.slice(1))))),
    h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: busy || name.trim() === '' }, t('Save')),
    group ? h('button', { type: 'button', className: 'bt-teamov-link danger', disabled: busy, onClick: onDelete }, t('Remove group')) : null,
    h('button', { type: 'button', className: 'bt-teamov-link', onClick: onCancel }, t('Cancel')))
}

function SiteRow({ site, checking, busy, onEdit, onCheck, onArchive }) {
  const health = site.health?.status ?? 'unknown'
  return h('article', { className: 'bt-site-row', 'data-health': health, 'data-archived': site.archived || undefined },
    h('span', { className: 'bt-site-mark', title: healthWord(health), 'aria-label': healthWord(health) }, h(GlobeIcon), h('i')),
    h('a', { className: 'bt-site-main', href: site.url, target: '_blank', rel: 'noopener noreferrer' },
      h('span', { className: 'bt-site-name' }, h('b', null, site.favorite ? h(StarLineIcon) : null, site.name), h('small', null, hostOf(site.url))),
      h('span', { className: 'bt-site-tags' },
        h('i', { 'data-env': site.environment }, environmentWord(site.environment)),
        site.projectPath ? h('em', null, shortPath(site.projectPath)) : null,
        (site.tags ?? []).slice(0, 3).map(tag => h('em', { key: tag }, tag)))),
    h('span', { className: 'bt-site-meta' },
      h('b', null, healthWord(health)),
      h('small', null, site.health?.checkedAt
        ? `${t('Checked {time}', { time: relativeShort(site.health.checkedAt) })}${site.health.latencyMs == null ? '' : ` · ${site.health.latencyMs} ms`}`
        : t('Never checked'))),
    h('span', { className: 'bt-site-actions' },
      h('button', { type: 'button', className: 'bt-round bt-round-sm', title: t('Check now'), 'aria-label': t('Check now'), disabled: checking || busy, onClick: onCheck }, h(RefreshIcon)),
      h('button', { type: 'button', className: 'bt-round bt-round-sm', title: t('Edit site'), 'aria-label': t('Edit site'), disabled: busy, onClick: onEdit }, h(PencilIcon)),
      site.archived
        ? h('button', { type: 'button', className: 'bt-teamov-link', disabled: busy, onClick: () => onArchive(false) }, t('Restore'))
        : h('button', { type: 'button', className: 'bt-teamov-link', disabled: busy, onClick: () => onArchive(true) }, t('Archive'))),
    h('a', { className: 'bt-site-open', href: site.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': t('Open {name}', { name: site.name }), title: t('Open') }, h(ChevronRightIcon)))
}

export function SitesView({ data, loading, failed, busy, actions, paths = [], onData }) {
  const [environment, setEnvironment] = useState('all')
  const [query, setQuery] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [editing, setEditing] = useState(undefined)
  const [editingGroup, setEditingGroup] = useState(undefined)
  const [checking, setChecking] = useState(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const model = useMemo(() => siteCatalogModel(data, { environment, query, includeArchived }), [data, environment, query, includeArchived])
  const filtered = query.trim() !== '' || environment !== 'all'
  const blocked = busy || working
  const run = async (work) => {
    setError('')
    setWorking(true)
    try { return await work() } catch (cause) { setError(cause?.message ?? String(cause)); return null } finally { setWorking(false) }
  }
  const saveSite = async payload => {
    const next = await run(() => actions.siteSave(payload))
    if (next === null) return
    onData(next)
    setEditing(undefined)
    if (!payload.id) {
      const checked = await run(() => actions.siteCheck(next.site.id))
      if (checked !== null) onData(checked)
    }
  }
  const checkSite = async id => {
    setChecking(id)
    const next = await run(() => actions.siteCheck(id))
    if (next !== null) onData(next)
    setChecking(null)
  }
  const archiveSite = async (id, archived) => {
    const next = await run(() => actions.siteArchive(id, archived))
    if (next !== null) onData(next)
  }
  const saveGroup = async payload => {
    const next = await run(() => actions.siteGroupSave(payload))
    if (next === null) return
    onData(next)
    setEditingGroup(undefined)
  }
  const deleteGroup = async id => {
    const next = await run(() => actions.siteGroupDelete(id))
    if (next !== null) onData(next)
    setEditingGroup(undefined)
  }
  return h('div', { className: 'bt-teamov-body bt-sites-body', id: 'bt-teamov-sites', role: 'tabpanel' },
    h('div', { className: 'bt-teamov-view-head bt-sites-head' },
      h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Published sites')), h('h3', null, t('One entry point for everything we ship'))),
      h('div', { className: 'bt-teamov-view-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: blocked, onClick: () => setEditingGroup(null) }, h(PlusIcon), t('New group')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', disabled: blocked, onClick: () => setEditing({}) }, h(PlusIcon), t('Add site')))),
    failed ? h('div', { className: 'bt-teamov-insight-state', role: 'alert' }, t('The site directory could not be read')) : null,
    error ? h('div', { className: 'bt-site-error', role: 'alert' }, error, h('button', { type: 'button', className: 'bt-round bt-round-sm', 'aria-label': t('Close'), onClick: () => setError('') }, h(CloseIcon))) : null,
    editing !== undefined ? h(SiteForm, {
      key: editing.id ?? 'new', site: editing.id ? editing : undefined, groups: data.groups, paths, busy: blocked,
      onSubmit: saveSite, onCancel: () => setEditing(undefined),
    }) : null,
    editingGroup !== undefined ? h(GroupForm, {
      key: editingGroup?.id ?? 'new-group', group: editingGroup?.id ? editingGroup : undefined, busy: blocked,
      onSubmit: saveGroup, onCancel: () => setEditingGroup(undefined), onDelete: () => { void deleteGroup(editingGroup.id) },
    }) : null,
    h('div', { className: 'bt-sites-toolbar' },
      h('div', { className: 'bt-sites-search' }, h(GlobeIcon), h('input', { value: query, placeholder: t('Search sites, tags or notes'), 'aria-label': t('Search sites'), onChange: event => setQuery(event.target.value) })),
      h('div', { className: 'bt-sites-filters' },
        [['all', t('All')], ['production', t('Production')], ['preview', t('Preview')], ['local', t('Local')], ['docs', t('Docs')]].map(([id, label]) =>
          h('button', { key: id, type: 'button', 'data-active': environment === id || undefined, onClick: () => setEnvironment(id) }, label))),
      h('button', { type: 'button', className: 'bt-sites-archive-toggle', 'data-active': includeArchived || undefined, onClick: () => setIncludeArchived(value => !value) }, t('Archived'), h('i', null, data.counts.archived ?? 0))),
    loading && data.sites.length === 0 ? h('div', { className: 'bt-teamov-insight-state', role: 'status' }, t('Reading published sites…')) : null,
    model.groups.length === 0 ? h('div', { className: 'bt-sites-empty' }, h(GlobeIcon),
      h('b', null, filtered ? t('No matching sites') : data.sites.length > 0 && !includeArchived ? t('No active sites') : t('No sites here yet')),
      h('span', null, filtered ? t('Try another search or filter.') : data.sites.length > 0 && !includeArchived ? t('Archived sites are hidden.') : t('Add a published URL, preview or local entry point.')),
      h('button', {
        type: 'button', className: 'bt-soft bt-soft-sm',
        onClick: () => filtered
          ? (setEnvironment('all'), setQuery(''))
          : data.sites.length > 0 && !includeArchived
            ? setIncludeArchived(true)
            : setEditing({}),
      }, filtered ? t('Clear filters') : data.sites.length > 0 && !includeArchived ? t('Show archived') : t('Add the first site'))) : null,
    h('div', { className: 'bt-sites-groups' }, model.groups.map(group => h('section', { key: group.id, className: 'bt-sites-group' },
      h('div', { className: 'bt-sites-group-head' },
        h('span', { className: 'bt-sites-group-name' }, h('i', { 'data-color': group.color ?? 'gray' }), h('b', null, group.id === '__ungrouped__' ? t('Ungrouped') : group.name), h('small', null, group.sites.length)),
        group.id === '__ungrouped__' ? null : h('button', { type: 'button', className: 'bt-teamov-link', onClick: () => setEditingGroup(group) }, t('Edit group'))),
      h('div', { className: 'bt-site-list' }, group.sites.map(site => h(SiteRow, {
        key: site.id, site, checking: checking === site.id, busy: blocked,
        onEdit: () => setEditing(site), onCheck: () => { void checkSite(site.id) }, onArchive: archived => { void archiveSite(site.id, archived) },
      })))))),
    h('div', { className: 'bt-teamov-refreshed' }, h(ClockIcon), data?.counts?.online ? t('{count} online', { count: data.counts.online }) : t('Checked only when you ask')))
}

export const SITES_CSS = `
.bt-sites-summary .bt-teamov-portfolio-stats small{display:flex;align-items:center;gap:4px}
.bt-sites-summary .bt-teamov-portfolio-stats small svg{width:9px;height:9px}
.bt-sites-body{position:relative}
.bt-sites-head{padding-top:4px}
.bt-sites-toolbar{display:flex;align-items:center;gap:8px;margin:8px 0 12px;flex-wrap:wrap}
.bt-sites-search{min-width:220px;flex:1;height:32px;padding:0 9px;display:flex;align-items:center;gap:6px;border-radius:10px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-sites-search svg{width:12px;height:12px;color:var(--bt-ink-3)}
.bt-sites-search input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:var(--bt-ink);font:inherit;font-size:10px}
.bt-sites-filters{display:flex;gap:2px;padding:2px;border-radius:10px;background:var(--bt-hover)}
.bt-sites-filters button,.bt-sites-archive-toggle{height:26px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-3);font:inherit;font-size:9px;cursor:pointer}
.bt-sites-filters button:hover{color:var(--bt-ink)}
.bt-sites-filters button[data-active]{background:var(--bt-card);color:var(--bt-ink);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-sites-archive-toggle{display:inline-flex;align-items:center;gap:4px}
.bt-sites-archive-toggle i{min-width:14px;height:14px;padding:0 4px;display:grid;place-items:center;border-radius:999px;background:var(--bt-hover);font-style:normal;font-size:8px}
.bt-sites-archive-toggle[data-active]{color:var(--bt-ink);background:var(--bt-hover)}
.bt-sites-groups{display:flex;flex-direction:column;gap:10px}
.bt-sites-group{min-width:0;padding:0 10px 4px;border-radius:12px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-sites-group-head{min-height:36px;display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid var(--bt-line)}
.bt-sites-group-name{display:flex;align-items:center;gap:6px;min-width:0}
.bt-sites-group-name>i{width:7px;height:7px;border-radius:50%;background:var(--bt-line-2)}
.bt-sites-group-name>i[data-color=blue]{background:var(--bt-accent)}
.bt-sites-group-name>i[data-color=green]{background:var(--bt-green)}
.bt-sites-group-name>i[data-color=orange]{background:var(--bt-star)}
.bt-sites-group-name>i[data-color=violet]{background:color-mix(in srgb,var(--bt-accent) 55%,var(--bt-star))}
.bt-sites-group-name>i[data-color=rose]{background:var(--bt-danger)}
.bt-sites-group-name>b{font-size:11px;line-height:15px;font-weight:600}
.bt-sites-group-name>small{font-size:8px;color:var(--bt-ink-3)}
.bt-site-list{display:flex;flex-direction:column}
.bt-site-row{min-height:58px;display:grid;grid-template-columns:30px minmax(0,1fr) 124px auto 14px;align-items:center;gap:10px;border-top:1px solid var(--bt-line)}
.bt-site-row:first-child{border-top:0}
.bt-site-row:hover{background:var(--bt-hover);border-radius:8px}
.bt-site-row[data-archived]{opacity:.58}
.bt-site-mark{position:relative;width:30px;height:30px;display:grid;place-items:center;border-radius:8px;background:var(--bt-hover);color:var(--bt-ink-3)}
.bt-site-mark svg{width:14px;height:14px}
.bt-site-mark i{position:absolute;right:4px;bottom:4px;width:6px;height:6px;border-radius:50%;background:var(--bt-line-2);box-shadow:0 0 0 2px var(--bt-card)}
.bt-site-row[data-health=online] .bt-site-mark{color:var(--bt-green);background:color-mix(in srgb,var(--bt-green) 9%,var(--bt-hover))}
.bt-site-row[data-health=online] .bt-site-mark i{background:var(--bt-green)}
.bt-site-row[data-health=auth] .bt-site-mark i{background:var(--bt-star)}
.bt-site-row[data-health=error] .bt-site-mark i,.bt-site-row[data-health=offline] .bt-site-mark i{background:var(--bt-danger)}
.bt-site-main{min-width:0;display:flex;flex-direction:column;gap:2px;color:var(--bt-ink);text-decoration:none}
.bt-site-name{min-width:0;display:flex;align-items:center;gap:5px}
.bt-site-name>b{min-width:0;display:flex;align-items:center;gap:5px;font-size:12px;line-height:16px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-site-name>b svg{width:11px;height:11px;flex:none;color:var(--bt-star)}
.bt-site-name>small{color:var(--bt-ink-3);font-size:9px;line-height:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-site-tags{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden}
.bt-site-tags i,.bt-site-tags em{padding:1px 5px;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-3);font-size:7px;line-height:11px;font-style:normal;white-space:nowrap}
.bt-site-tags i[data-env=production]{background:color-mix(in srgb,var(--bt-green) 11%,var(--bt-hover));color:color-mix(in srgb,var(--bt-green) 78%,var(--bt-ink))}
.bt-site-tags i[data-env=preview]{background:color-mix(in srgb,var(--bt-star) 11%,var(--bt-hover))}
.bt-site-tags i[data-env=local]{background:color-mix(in srgb,var(--bt-accent) 9%,var(--bt-hover))}
.bt-site-meta{min-width:0;display:flex;flex-direction:column;gap:1px;text-align:right}
.bt-site-meta b{color:var(--bt-ink-2);font-size:8px;line-height:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-site-meta small{color:var(--bt-ink-3);font-size:7px;line-height:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-site-actions{display:flex;align-items:center;gap:3px}
.bt-site-actions .bt-round{width:26px;height:26px}
.bt-site-actions .bt-round svg{width:12px;height:12px}
.bt-site-actions .bt-teamov-link{padding:3px 5px;font-size:8px}
.bt-site-open{display:grid;place-items:center;color:var(--bt-ink-3)}
.bt-site-open svg{width:12px;height:12px}
.bt-sites-empty{min-height:240px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;color:var(--bt-ink-3);text-align:center}
.bt-sites-empty>svg{width:28px;height:28px}
.bt-sites-empty>b{color:var(--bt-ink);font-size:13px}
.bt-sites-empty>span{font-size:10px;line-height:15px}
.bt-site-form,.bt-site-group-form{margin:0 0 12px;padding:11px;border-radius:12px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-site-form-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:9px}
.bt-site-form-head h4{margin:2px 0 0;font-size:13px;line-height:18px}
.bt-site-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.bt-site-form-grid label{min-width:0;display:flex;flex-direction:column;gap:4px}
.bt-site-form-grid label.wide{grid-column:1/-1}
.bt-site-form-grid label>span{color:var(--bt-ink-3);font-size:8px}
.bt-site-form-grid input,.bt-site-form-grid select,.bt-site-form-grid textarea,.bt-site-group-form input,.bt-site-group-form select{border:0;border-radius:8px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:10px;outline:none;box-shadow:inset 0 0 0 1px transparent}
.bt-site-form-grid input,.bt-site-form-grid select,.bt-site-group-form input,.bt-site-group-form select{height:30px;padding:0 8px}
.bt-site-form-grid textarea{min-height:62px;padding:7px 8px;resize:vertical}
.bt-site-form-grid input:focus,.bt-site-form-grid select:focus,.bt-site-form-grid textarea:focus,.bt-site-group-form input:focus,.bt-site-group-form select:focus{box-shadow:inset 0 0 0 1px var(--bt-accent)}
.bt-site-form-foot{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:7px;margin-top:9px}
.bt-site-check{display:inline-flex;align-items:center;gap:5px;color:var(--bt-ink-3);font-size:9px}
.bt-site-check input{accent-color:var(--bt-accent)}
.bt-site-group-form{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.bt-site-group-form input{flex:1;min-width:160px}
.bt-site-group-form select{width:90px}
.bt-site-error{position:sticky;top:0;z-index:2;margin:8px 0;padding:7px 8px;display:flex;align-items:center;gap:8px;border-radius:8px;background:color-mix(in srgb,var(--bt-danger) 10%,var(--bt-card));color:var(--bt-danger);font-size:9px}
.bt-site-error>button{margin-left:auto}
.bt-site-error .bt-round{width:24px;height:24px}
.bt-teamov-link.danger{color:var(--bt-danger)}
@media (max-width:760px){.bt-site-row{grid-template-columns:30px minmax(0,1fr) 14px;grid-template-rows:auto auto auto;min-height:0;padding:8px 0;gap:5px 9px}.bt-site-mark{grid-column:1;grid-row:1/3}.bt-site-main{grid-column:2;grid-row:1}.bt-site-meta{display:flex;grid-column:2;grid-row:2;flex-direction:row;align-items:center;justify-content:flex-start;gap:6px;text-align:left}.bt-site-meta b,.bt-site-meta small{font-size:8px;line-height:11px}.bt-site-actions{grid-column:2/4;grid-row:3;justify-content:flex-end}.bt-site-open{grid-column:3;grid-row:1}.bt-sites-head{flex-direction:column;align-items:stretch;gap:6px}.bt-sites-head .bt-teamov-view-actions{justify-content:flex-end}.bt-site-form-grid{grid-template-columns:1fr}.bt-site-form-grid label.wide{grid-column:auto}.bt-sites-toolbar{align-items:stretch}.bt-sites-search{flex-basis:100%}.bt-sites-filters{overflow:auto}.bt-sites-group{padding:0 8px 4px}}
`
