import { createElement as h, useEffect, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'

const EMPTY = { revision: null, objective: '', checklist: '' }

export function BotSpecEditor({ botId, sessionId, readOnly }) {
  const [saved, setSaved] = useState(null)
  const [draft, setDraft] = useState(EMPTY)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadVersion, reload] = useState(0)
  const changed = saved !== null && (saved.objective !== draft.objective || saved.checklist !== draft.checklist)

  useEffect(() => {
    const request = new AbortController()
    call('bot-spec', { botId, sessionId }, request.signal).then(value => {
      if (request.signal.aborted) return
      setSaved(value ?? EMPTY)
      setDraft(value ?? EMPTY)
      setError('')
    }, failure => {
      if (!request.signal.aborted) setError(failure.message)
    })
    return () => request.abort()
  }, [botId, sessionId, loadVersion])

  const submit = async (event) => {
    event.preventDefault()
    if (readOnly || busy || !changed) return
    setBusy(true)
    try {
      const next = await call('bot-spec-save', { ...draft, revision: saved.revision, botId, sessionId })
      setSaved(next)
      setDraft(next)
      setError('')
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy(false)
    }
  }

  const field = (name, label, maxLength) => h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
    h('span', { className: 'bt-bs-label' }, t(label)),
    h('textarea', { className: 'bt-input bt-input-area', value: draft[name], maxLength, disabled: busy || readOnly || saved === null,
      onChange: event => setDraft({ ...draft, [name]: event.target.value }) }))

  return h('section', { 'aria-label': t('Task spec') },
    h('div', { className: 'bt-section-title' }, t('Task spec')),
    h('form', { onSubmit: submit },
      field('objective', 'Objective and constraints', 4000),
      field('checklist', 'Task checklist', 2000),
      error ? h('p', { role: 'alert', className: 'bt-error' }, error) : null,
      h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: readOnly || busy || !changed }, t('Save')),
      error ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => reload(value => value + 1) }, t('Reload task spec')) : null))
}
