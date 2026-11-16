import { createElement as h, useId, useMemo, useRef, useState } from 'react'
import { editLines, lineDiff } from './learning-card-model.js'
import { t } from './i18n.js'
import { CheckIcon, MemoryIcon, PencilIcon } from './icons.js'

// `proposal.outcome` set: an answered card, read-only and folded to one row (what
// it was, how it ended, its name); the row opens the change.
export function ProposalCard({ proposal, initialError = '', onFailure = () => {}, onResolved = () => {}, actions, disabledReason = '' }) {
  const outcome = proposal.outcome
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError)
  const [open, setOpen] = useState(false)
  const busyRef = useRef(false)
  const titleId = useId()
  const answer = approve => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    void Promise.resolve().then(() => actions.learningAnswer(proposal.id, approve))
      .then(() => onResolved(proposal.id, approve), failure => {
        setError(failure?.message ?? String(failure))
        onFailure(proposal, failure)
      })
      .finally(() => {
        busyRef.current = false
        setBusy(false)
      })
  }
  const update = proposal.action === 'update'
  const agents = proposal.kind === 'agents'
  const rows = useMemo(() => lineDiff(update ? proposal.previous?.content : '', proposal.content), [update, proposal.previous?.content, proposal.content])
  const change = agents
    ? [
      h(FileBox, { key: 'file', name: 'AGENTS.md', path: proposal.folder, state: proposal.exists === false ? 'Added' : 'Modified', blocks: proposal.edits.map(edit => [
        ...(edit.op === 'add' ? [] : editLines(edit.old)).map(line => ({ kind: 'removed', line })),
        ...(edit.op === 'remove' ? [] : editLines(edit.text)).map(line => ({ kind: 'added', line })),
      ]) }),
      ...proposal.edits.map((edit, index) => edit.why ? h('p', { className: 'bt-learning-why', key: `why-${index}` }, edit.why) : null),
    ]
    : [
      h(FileBox, { key: 'file', name: 'SKILL.md', path: `skills/${proposal.name}`, state: update ? 'Updated' : 'Added', blocks: [rows] }),
      proposal.why ? h('p', { className: 'bt-learning-why', key: 'why' }, proposal.why) : null,
    ]
  const kind = t(agents ? 'AGENTS.md update' : update ? 'Skill update' : 'New skill')
  const reviewReason = proposal.requiresReview ? `${t('Review required')}: ${proposal.reviewReason}` : ''
  if (outcome) {
    const what = agents ? proposal.folder : proposal.name
    return h('section', { className: 'bt-q bt-q-settled bt-learning-card bt-learning-settled', role: 'group', 'aria-label': `${kind} · ${what}`, 'data-outcome': outcome },
      h('button', { type: 'button', className: 'bt-learning-fold', 'aria-expanded': open, onClick: () => setOpen(!open) },
        h('span', { className: 'bt-learning-icon', 'aria-hidden': true }, h(agents ? PencilIcon : MemoryIcon)),
        h('span', { className: 'bt-learning-kind' }, kind),
        h('span', { className: 'bt-learning-sum' }, `${t(outcome === 'approved' ? 'Approved' : 'Declined')} · ${what}`)),
      open ? [change, proposal.improvement ? h(ImprovementDetails, { key: 'improvement', improvement: proposal.improvement, proposal }) : null] : null)
  }
  const oldDetail = update && typeof proposal.previous?.description === 'string' && proposal.previous.description !== proposal.description ? proposal.previous.description : undefined
  return h('section', { className: 'bt-q bt-learning-card', role: 'group', 'aria-labelledby': titleId, 'aria-busy': busy },
    agents
      ? h(ProposalHead, { titleId, icon: PencilIcon, title: kind })
      : h(ProposalHead, { titleId, title: proposal.name, kind, detail: proposal.description, oldDetail }),
    change,
    proposal.improvement ? h(ImprovementDetails, { improvement: proposal.improvement, proposal }) : null,
    error ? h('div', { className: 'bt-learning-error', role: 'alert' }, error) : null,
    h(ProposalFoot, { busy, answer, disabledReason, approveDisabledReason: reviewReason }))
}

function ImprovementDetails({ improvement, proposal }) {
  const evidence = [...(improvement.evidenceIds ?? []), ...(improvement.sourceIds ?? [])].join(', ')
  const audit = proposal.audit
  return h('section', { className: 'bt-learning-improvement', 'aria-label': t('Verified improvement') },
    h('p', { className: 'bt-learning-improvement-title' }, t('Verified improvement')),
    h('dl', null,
      h('div', null, h('dt', null, t('Affects')), h('dd', null, `${improvement.affectedBot.name} · ${improvement.scope.label}`)),
      h('div', null, h('dt', null, t('Observed problem')), h('dd', null, improvement.observedProblem)),
      h('div', null, h('dt', null, t('Proposed change')), h('dd', null, improvement.proposedChange)),
      h('div', null, h('dt', null, t('Expected benefit')), h('dd', null, improvement.expectedBenefit)),
      h('div', null, h('dt', null, t('Rollback path')), h('dd', null, improvement.rollbackPath)),
      h('div', null, h('dt', null, t('Source')), h('dd', null, h('span', { className: 'bt-activity-id' }, `${improvement.taskId} · ${evidence}`))),
      audit ? h('div', null, h('dt', null, t('Audit')), h('dd', null, `${t('Version {version}', { version: audit.version })} · ${audit.beforeHash} → ${audit.afterHash}`)) : null),
    proposal.requiresReview ? h('p', { className: 'bt-learning-review', role: 'alert' }, `${t('Review required')}: ${proposal.reviewReason}`) : null)
}

function ProposalHead({ titleId, icon = MemoryIcon, title, kind, detail, oldDetail }) {
  return h('div', { className: 'bt-q-head' },
    h('span', { className: 'bt-learning-icon', 'aria-hidden': true }, h(icon)),
    h('div', { className: 'bt-q-text' },
      h('p', { className: 'bt-q-title', id: titleId }, title),
      kind ? h('div', { className: 'bt-q-detail' }, kind) : null,
      oldDetail ? h('p', { className: 'bt-learning-description bt-learning-old' }, h('del', null, oldDetail)) : null,
      detail ? h('p', { className: 'bt-learning-description' }, detail) : null),
    h('span', { className: 'bt-q-badge bt-learning-status' }, h('span', { className: 'bt-learning-dot', 'aria-hidden': true }), t('Awaiting approval')))
}

function ProposalFoot({ busy, answer, disabledReason, approveDisabledReason = '' }) {
  const declineDisabled = busy || Boolean(disabledReason)
  const approveDisabled = declineDisabled || Boolean(approveDisabledReason)
  return h('div', { className: 'bt-q-foot bt-learning-foot' },
    h('button', { type: 'button', className: 'bt-learning-btn bt-learning-decline', disabled: declineDisabled, title: disabledReason || undefined, onClick: () => answer(false) }, t('Decline')),
    h('button', { type: 'button', className: 'bt-learning-btn bt-learning-approve', disabled: approveDisabled, title: approveDisabledReason || disabledReason || undefined, onClick: () => answer(true) },
      h(CheckIcon), t('Approve')))
}

const COLLAPSE_ROWS = 8
const SIGNS = { added: '+', removed: '\u2212', same: '' }

function FileBox({ name, path, state, blocks }) {
  const [open, setOpen] = useState(false)
  const all = blocks.flat()
  const added = all.filter(row => row.kind === 'added').length
  const removed = all.filter(row => row.kind === 'removed').length
  const folds = all.length > COLLAPSE_ROWS
  const shut = folds && !open
  return h('div', { className: 'bt-learning-file' },
    h('div', { className: 'bt-learning-filehead' },
      h('span', { className: 'bt-learning-name' }, name),
      path ? h('span', { className: 'bt-learning-path' }, path) : null,
      h('span', { className: 'bt-learning-spacer' }),
      added > 0 ? h('span', { className: 'bt-learning-plus' }, `+${added}`) : null,
      removed > 0 ? h('span', { className: 'bt-learning-minus' }, `\u2212${removed}`) : null,
      h('span', { className: `bt-learning-state bt-learning-state-${state.toLowerCase()}` }, t(state))),
    h('div', { className: shut ? 'bt-learning-code bt-learning-shut' : 'bt-learning-code' },
      blocks.map((rows, blockIndex) => [
        blockIndex > 0 ? h('div', { className: 'bt-learning-gap', key: `gap-${blockIndex}` }) : null,
        ...rows.map((row, rowIndex) => h('div', { className: `bt-learning-row bt-learning-${row.kind}`, key: `${blockIndex}-${rowIndex}` },
          h('span', { className: 'bt-learning-num', 'aria-hidden': true }, row.number ?? ''),
          h('span', { className: 'bt-learning-sign', 'aria-hidden': true }, SIGNS[row.kind]),
          h('span', { className: 'bt-learning-text' }, row.line || '\u00a0'))),
      ])),
    folds ? h('div', { className: shut ? 'bt-learning-morebar bt-learning-morebar-shut' : 'bt-learning-morebar' },
      h('button', { type: 'button', className: 'bt-learning-more', 'aria-expanded': open, onClick: () => setOpen(!open) },
        t(open ? 'Show less' : 'Show all {count} lines', { count: all.length }))) : null)
}
