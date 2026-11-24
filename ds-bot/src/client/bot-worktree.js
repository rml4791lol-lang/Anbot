import { createElement as h, useEffect, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'

const STATES = { created: 'Worktree found', 'session-ready': 'Session ready', 'turn-started': 'Turn started' }

export function BotWorktree({ botId, sessionId, readOnly, openSession, followRestore }) {
  const [view, setView] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [keepMemory, setKeepMemory] = useState(false)
  const [review, setReview] = useState(null)
  useEffect(() => {
    const request = new AbortController()
    let next
    const refresh = async () => {
      try {
        const value = await call('bot-worktree', { botId }, request.signal)
        if (!request.signal.aborted) setView(value)
      } catch (failure) {
        if (!request.signal.aborted) setError(failure.message)
      } finally {
        if (!request.signal.aborted) next = setTimeout(refresh, 4000)
      }
    }
    if (!busy) void refresh()
    return () => { request.abort(); clearTimeout(next) }
  }, [botId, sessionId, busy])

  const change = async (endpoint, payload = {}) => {
    setBusy(true)
    setError('')
    try {
      const result = await call(endpoint, { botId, ...payload })
      if (endpoint.startsWith('bot-worktree-checkpoint-memory')) setReview({ ref: payload.checkpointRef, ...result })
      else setView(await call('bot-worktree', { botId }))
      if (endpoint === 'bot-worktree-checkpoint-activate') await followRestore()
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy(false)
    }
  }
  const observed = view?.value
  const hold = view?.hold
  const ready = observed?.sessionId === sessionId && ['session-ready', 'turn-started'].includes(observed?.state)
  const detail = hold ? t(hold.status === 'held' ? 'You control this worktree' : 'Waiting for the Bot to stop')
    : view?.canTakeOver === false ? t('Takeover is unavailable for this local Agent.')
      : observed ? t(STATES[observed.state]) : view?.reason
  const root = hold?.root ?? observed?.root
  const held = hold?.status === 'held' && hold.sessionId === sessionId
  const stopping = hold?.status === 'stopping' && hold.sessionId === sessionId
  const checkpoints = (view?.checkpoints ?? []).slice().reverse()
  const branches = (view?.previews ?? []).slice().reverse()
  return h('section', { 'aria-label': t('Worktree control') },
    h('div', { className: 'bt-section-title' }, t('Worktree control')),
    h('div', { className: 'bt-note', role: 'status' }, detail ?? ''),
    root ? h('p', { className: 'bt-note', style: { overflowWrap: 'anywhere' } }, root) : null,
    error ? h('p', { className: 'bt-error', role: 'alert' }, error) : null,
    hold ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly || busy || !held,
      onClick: () => void change('bot-worktree-return') }, t('Return worktree'))
      : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly || busy || !ready || view?.canTakeOver === false,
        onClick: () => void change('bot-worktree-takeover') }, t('Take over worktree')),
    stopping ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly || busy || !ready || view?.canTakeOver === false,
      onClick: () => void change('bot-worktree-takeover') }, t('Retry')) : null,
    held ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly || busy,
      onClick: () => void change('bot-worktree-checkpoint') }, t('Save checkpoint')) : null,
    checkpoints.length ? h('details', null, h('summary', { className: 'bt-note' }, t('Checkpoint history')),
      held ? h('label', { className: 'bt-note' }, h('input', { type: 'checkbox', checked: keepMemory,
        disabled: readOnly || busy, onChange: event => setKeepMemory(event.target.checked) }), ' ', t('Keep current memory when restoring')) : null,
      h('ol', null, checkpoints.map(record => {
        const preview = branches.find(branch => branch.checkpointRef === record.checkpointRef && !branch.writable)
        const restored = branches.find(branch => branch.checkpointRef === record.checkpointRef && branch.writable)
        const unavailable = readOnly || busy || !held || record.worktree !== root || !Number.isSafeInteger(record.throughSequence)
        return h('li', { key: record.checkpointRef },
          h('div', { className: 'bt-note' }, new Date(record.at).toLocaleString(), ' · ', record.commit.slice(0, 8)),
          (restored?.memoryChanged || preview?.memoryChanged) ? h('p', { className: 'bt-note' }, t('Memory has changed since this checkpoint.')) : null,
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
            onClick: () => void change('bot-worktree-checkpoint-memory', { checkpointRef: record.checkpointRef }) }, t('Review memory changes')),
          review?.ref === record.checkpointRef ? h('div', { role: 'status', className: 'bt-note' },
            review.status === 'unavailable' ? t('This checkpoint has no usable memory cursor.')
              : review.changes.length === 0 ? t('No undoable changes from this Session.')
                : h('ul', null, review.changes.map(row => h('li', { key: row.id },
                  h('p', null, row.text),
                  h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || readOnly,
                    onClick: () => void change('bot-worktree-checkpoint-memory-undo', { checkpointRef: record.checkpointRef, changeId: row.id }) }, t('Undo this change')))))) : null,
          preview ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => openSession(preview.sessionId) }, t('Open read-only preview'))
            : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: unavailable,
              onClick: () => void change('bot-worktree-checkpoint-preview', { checkpointRef: record.checkpointRef }) }, t('Create read-only preview')),
          restored ? (restored.sessionId === sessionId ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => openSession(restored.sessionId) }, t('Open restored Session')))
            : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: unavailable,
              onClick: () => void change('bot-worktree-checkpoint-restore', { checkpointRef: record.checkpointRef, keepCurrentMemory: keepMemory }) }, t('Restore to new worktree')),
          restored && restored.sessionId !== sessionId && held && root === record.worktree ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly || busy,
            onClick: () => void change('bot-worktree-checkpoint-activate', { sessionId: restored.sessionId, keepCurrentMemory: keepMemory }) }, t('Switch Bot to restored Session')) : null)
      }))) : null)
}
