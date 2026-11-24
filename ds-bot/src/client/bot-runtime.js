import { createElement as h, useEffect, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'
import { presetName } from './permission-picker.js'

const STATUS = { ready: 'Available', unavailable: 'Unavailable', unobserved: 'Unverified',
  error: 'Failed', connecting: 'Connecting', 'needs-approval': 'Needs approval' }
const BUDGET_UNAVAILABLE = {
  'no-request': 'Send a message to measure context.',
  'meter-unavailable': 'The DSH token meter is unavailable.',
  'capacity-unavailable': 'The model did not report its context window.',
}

function ContextBudget({ budget }) {
  if (budget.status === 'unavailable') return h('p', { className: 'bt-note' }, t(BUDGET_UNAVAILABLE[budget.reason]))
  const number = value => new Intl.NumberFormat().format(value)
  const usage = t('{used} of {total} tokens of context in use', { used: number(budget.usedTokens), total: number(budget.usable) })
  return h('details', null,
    h('summary', { className: 'bt-note' }, usage),
    h('p', { className: 'bt-note' }, t('Context check at {check} tokens. Hard threshold at {hard}.', { check: number(budget.check), hard: number(budget.hard) })),
    budget.measuredFrom !== 'usage' ? h('p', { className: 'bt-note' }, t('Token usage is estimated.')) : null)
}

export function BotRuntime({ botId, sessionId, running, readOnly }) {
  const [view, setView] = useState(null)
  const [error, setError] = useState(null)
  const [refresh, setRefresh] = useState(0)
  const [resuming, setResuming] = useState(false)
  useEffect(() => {
    const request = new AbortController()
    call('bot-runtime', { botId, sessionId }, request.signal).then(value => {
      if (request.signal.aborted) return
      setView(value)
      setError(null)
    }).catch(failure => {
      if (request.signal.aborted) return
      setView(null)
      setError(failure.message)
    })
    return () => request.abort()
  }, [botId, sessionId, running, refresh])

  const row = (label, value) => value ? h('div', { key: label, className: 'bt-kv' }, h('dt', null, t(label)), h('dd', { style: { overflowWrap: 'anywhere' } }, value)) : null
  const cli = view?.cli
  const capabilities = view?.capabilities
  const items = [...(capabilities?.skills ?? []), ...(capabilities?.mcp ?? [])]
  const resume = async () => {
    setResuming(true)
    setError(null)
    try {
      await call('resume', { botId })
      setRefresh(value => value + 1)
    } catch (failure) { setError(failure.message) }
    finally { setResuming(false) }
  }
  return h('section', { 'aria-label': t('Session capabilities') },
    h('div', { className: 'bt-section-title' }, t('Session capabilities')),
    error ? h('p', { className: 'bt-error', role: 'alert' }, error) : null,
    view?.recovery ? h('div', null,
      h('p', { className: 'bt-note', role: 'status' }, view.recovery === 'worktree-held'
        ? t('Recovery paused while the worktree was held.') : t('Automatic recovery reached its limit.')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly || resuming || running,
        onClick: () => void resume() }, t('Resume interrupted work'))) : null,
    view?.status === 'unavailable' ? h('p', { className: 'bt-note' }, t('Open the current Session to inspect its capabilities.')) : null,
    view?.status === 'observed' ? h('dl', null,
      row('Selected route', view.route === view.lastRoute ? null : view.route), row('Last request route', view.lastRoute),
      row('Agent preset', view.preset?.id), row('Permissions', view.sandbox ? presetName(view.sandbox) : null),
      cli ? row(cli.name, t(!cli.installed ? 'Command not found' : cli.signedIn === true ? 'Signed in' : cli.signedIn === false ? 'Not signed in' : 'Sign-in unknown')) : null) : null,
    view?.context ? h(ContextBudget, { budget: view.context }) : null,
    capabilities?.reason ? h('p', { className: 'bt-note' }, capabilities.reason) : null,
    items.length > 0 ? h('details', null,
      h('summary', { className: 'bt-note' }, t('Skills and MCP')),
      h('ul', null, items.map(item => h('li', { key: item.name, className: 'bt-note' }, item.name, ' · ', t(STATUS[item.status]), item.reason ? ` · ${item.reason}` : null)))) : null,
    view?.preset?.modules.length > 0 ? h('details', null,
      h('summary', { className: 'bt-note' }, t('Loaded preset plugins')),
      h('ul', null, view.preset.modules.map(name => h('li', { key: name, className: 'bt-note', style: { overflowWrap: 'anywhere' } }, name)))) : null,
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setRefresh(value => value + 1) }, t('Refresh')))
}
