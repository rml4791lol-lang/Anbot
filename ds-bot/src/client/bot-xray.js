import { createElement as h, useEffect, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'

const IN_PROGRESS = new Set(['preparing', 'running', 'cancelling'])
const LABELS = { preparing: 'Preparing', running: 'Running', cancelling: 'Cancelling', interrupted: 'Interrupted', completed: 'Completed', cancelled: 'Cancelled', error: 'Failed' }

export function BotXRay({ botId, sessionId, readOnly }) {
  const [view, setView] = useState(undefined)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const active = IN_PROGRESS.has(view?.status)
  useEffect(() => {
    if (pending || (view !== undefined && !active)) return undefined
    const request = new AbortController()
    let timer
    const refresh = async () => {
      try {
        const next = await call('bot-workflow', { botId }, request.signal)
        if (request.signal.aborted) return
        setView(next)
        setError('')
        if (IN_PROGRESS.has(next?.status)) timer = setTimeout(refresh, 300)
      } catch (failure) {
        if (request.signal.aborted) return
        setError(failure.message)
        if (active) timer = setTimeout(refresh, 1200)
        else setView(null)
      }
    }
    void refresh()
    return () => { clearTimeout(timer); request.abort() }
  }, [botId, pending, active])

  const run = async (endpoint, args) => {
    setPending(true)
    try {
      setView(await call(endpoint, { botId, ...args }))
      setError('')
    } catch (failure) {
      setError(failure.message)
    } finally {
      setPending(false)
    }
  }
  const sameSession = view?.sessionId === sessionId
  const report = sameSession ? view.result : undefined
  return h('section', { 'aria-label': t('Session evidence') },
    h('div', { className: 'bt-section-title' }, t('Session evidence')),
    h('p', { className: 'bt-note' }, t('Use DSH Workflow to inspect recent recorded tool results.')),
    h('div', { role: 'status', className: 'bt-kv' }, sameSession || active ? t(LABELS[view.status]) : null),
    error || (sameSession && view.reason) ? h('p', { className: 'bt-error', role: 'alert' }, error || view.reason) : null,
    report ? h('dl', null, [['Commands', report.commands], ['Failed commands', report.failures], ['Diffs', report.diffs], ['Deliverables', report.deliverables]].map(([label, count]) =>
      h('div', { key: label, className: 'bt-kv' }, h('dt', null, t(label)), h('dd', null, count)))) : null,
    active ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly || pending || !view.runId || view.status === 'cancelling',
      onClick: () => void run('bot-workflow-cancel', { runId: view.runId }) }, t('Cancel workflow'))
      : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly || pending || view === undefined,
        onClick: () => void run('bot-workflow-start') }, t('Check evidence')))
}
