import { createElement as h, useEffect, useState } from 'react'
import { useTurnFacts } from './btw.js'
import { answerFailure, answerKeepsCard, proposalCards, proposalPlacement, withoutEntry } from './learning-card-model.js'
import { currentPart } from './text.js'
import { spring, SPRING_TAP } from './motion.js'
import { ProposalCard } from './learning-card-view.js'

// One entry per proposal still waiting for another try, kept across remounts.
const failedAnswers = new Map()

function LearningProposals({ turn, dock, sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const facts = useTurnFacts(sessionId, actions)
  const [failed, setFailed] = useState({})
  const bot = roster.byId?.[sessionId] ?? roster.bots?.find(entry => currentPart(entry) === sessionId)
  // A proposal answered in another window or turn takes its failure with it, so this map
  // holds only the answers still waiting for another try (#1339).
  const settledIds = (bot === undefined ? [] : roster.learningSettled?.[bot.id] ?? []).map(entry => entry.id)
  useEffect(() => {
    const gone = Object.keys(failed).filter(id => settledIds.includes(id))
    if (gone.length === 0) return
    for (const id of gone) failedAnswers.delete(id)
    setFailed(current => gone.reduce((next, id) => withoutEntry(next, id), current))
  }, [settledIds.join('|')])
  if (!bot || currentPart(bot) !== sessionId) return null
  const proposals = roster.learning?.[bot.id] ?? []
  // Answered cards stay in place, read-only; a waiting copy of the same card wins.
  const settled = roster.learningSettled?.[bot.id] ?? []
  const remembered = Object.fromEntries([...failedAnswers.values(), ...Object.values(failed)]
    .filter(entry => entry.proposal.botId === bot.id)
    .map(entry => [entry.proposal.id, entry]))
  const visible = proposalCards({ proposals, settled, failures: remembered })
  const cards = visible.filter(proposal => {
    const placement = proposalPlacement(proposal, facts?.turns)
    return dock ? placement.kind === 'dock' : placement.kind === 'turn' && placement.turn === turn?.turn
  })
  if (cards.length === 0) return null
  // An answer the host no longer knows (`bot/stale`) drops the card: the proposal is gone,
  // so a retry cannot work and leaving it up only pins a dead card. Every other failure —
  // network, a host error, a skill of that name already existing — keeps it for another go.
  const onFailure = (proposal, failure) => {
    if (answerKeepsCard(failure)) failedAnswers.set(proposal.id, { proposal, error: failure?.message ?? String(failure) })
    else failedAnswers.delete(proposal.id)
    setFailed(current => answerFailure(current, proposal, failure))
  }
  const onResolved = id => setFailed(current => {
    failedAnswers.delete(id)
    return withoutEntry(current, id)
  })
  return h('div', { className: dock ? 'bt-learning-stack bt-learning-dock' : 'bt-learning-stack' }, cards.map(proposal => h('div', { className: 'bt-q-inline', key: proposal.id },
    h(ProposalCard, {
      proposal,
      initialError: failed[proposal.id]?.error ?? failedAnswers.get(proposal.id)?.error,
      onFailure,
      onResolved,
      actions,
    }))))
}

export function LearningTurnTail(props) {
  return h(LearningProposals, { ...props, dock: false })
}

export function LearningDock(props) {
  return h(LearningProposals, { ...props, dock: true })
}

export const LEARNING_CSS = `
.bt-learning-stack{display:flex;flex-direction:column;gap:4px}
.bt-learning-dock{width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto;box-sizing:border-box}
.bt-learning-card .bt-q-head{gap:12px}
.bt-learning-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-learning-icon svg{width:18px;height:18px}
.bt-learning-description{margin:6px 0 0;font-size:13px;line-height:19px;color:var(--bt-ink)}
.bt-learning-old{color:var(--bt-ink-3)}
.bt-learning-status{display:inline-flex;align-items:center;gap:6px;border-style:solid;border-color:color-mix(in srgb,var(--bt-star) 35%,transparent);color:color-mix(in srgb,var(--bt-star) 80%,var(--bt-ink))}
.bt-learning-dot{width:6px;height:6px;border-radius:50%;background:var(--bt-star)}
.bt-learning-file{border-radius:12px;overflow:hidden;background:color-mix(in srgb,var(--bt-ink) 2.5%,var(--bt-card));box-shadow:inset 0 0 0 1px var(--bt-q-rule)}
.bt-learning-filehead{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 12px;box-shadow:inset 0 -1px 0 var(--bt-q-rule-2);font-size:12px;line-height:18px}
.bt-learning-name{flex:none;font-weight:600;color:var(--bt-ink)}
.bt-learning-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-3)}
.bt-learning-spacer{flex:1}
.bt-learning-plus,.bt-learning-minus{flex:none;font-weight:600;font-variant-numeric:tabular-nums}
.bt-learning-plus{color:var(--bt-green)}
.bt-learning-minus{color:var(--bt-danger)}
.bt-learning-state{flex:none;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:20px;font-weight:500;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-learning-state-added{background:color-mix(in srgb,var(--bt-green) 13%,transparent);color:color-mix(in srgb,var(--bt-green) 70%,var(--bt-ink))}
.bt-learning-code{padding:6px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:20px;color:var(--bt-ink)}
.bt-learning-shut{max-height:172px;overflow:hidden}
.bt-learning-row{display:grid;grid-template-columns:36px 16px 1fr}
.bt-learning-num{padding-right:6px;text-align:right;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;user-select:none}
.bt-learning-sign{text-align:center;user-select:none}
.bt-learning-text{min-width:0;padding-right:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-learning-added{background:color-mix(in srgb,var(--bt-green) 9%,transparent)}
.bt-learning-added .bt-learning-sign{color:var(--bt-green)}
.bt-learning-removed{background:color-mix(in srgb,var(--bt-danger) 7%,transparent)}
.bt-learning-removed .bt-learning-sign{color:var(--bt-danger)}
.bt-learning-removed .bt-learning-text{color:var(--bt-ink-2)}
.bt-learning-gap{height:1px;margin:6px 12px;background:var(--bt-q-rule)}
.bt-learning-morebar{display:flex;justify-content:center;padding:4px 0 8px}
.bt-learning-morebar-shut{position:relative;margin-top:-36px;padding-top:28px;background:linear-gradient(transparent,color-mix(in srgb,var(--bt-ink) 2.5%,var(--bt-card)) 60%)}
.bt-learning-more{height:24px;padding:0 10px;border:0;border-radius:999px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-q-edge);font:inherit;font-size:12px;color:var(--bt-ink-2);cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-learning-more:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-learning-more:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-learning-why{margin:0;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-learning-btn{flex:none;display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 16px;border:0;border-radius:999px;font:inherit;font-size:14px;font-weight:500;cursor:pointer;transition:background-color .12s ease,opacity .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-learning-btn svg{width:15px;height:15px}
.bt-learning-decline{background:transparent;box-shadow:inset 0 0 0 1px var(--bt-line-2);color:var(--bt-ink)}
.bt-learning-decline:hover:not(:disabled){background:var(--bt-hover)}
.bt-learning-approve{padding-left:13px;background:var(--bt-accent);color:var(--bt-accent-ink)}
.bt-learning-approve:hover:not(:disabled){opacity:.86}
.bt-learning-btn:disabled{opacity:.45;cursor:default}
.bt-learning-btn:active:not(:disabled){scale:.96}
.bt-learning-btn:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.bt-learning-btn{transition:background-color .12s ease,opacity .12s ease}.bt-learning-btn:active:not(:disabled){scale:none}}
.bt-learning-settled{gap:10px}
.bt-learning-fold{display:flex;align-items:center;gap:10px;min-width:0;width:100%;margin:-4px 0;padding:4px 0;border:0;background:none;font:inherit;text-align:start;color:var(--bt-ink);cursor:pointer}
.bt-learning-fold .bt-learning-icon{width:28px;height:28px;border-radius:8px}
.bt-learning-fold .bt-learning-icon svg{width:16px;height:16px}
.bt-learning-kind{flex:none;font-size:14px;line-height:20px;font-weight:600}
.bt-learning-sum{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;color:var(--bt-ink-2)}
.bt-learning-fold:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px;border-radius:8px}
.bt-learning-error{font-size:12px;line-height:16px;color:var(--bt-danger)}
.bt-learning-improvement{margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-q-rule)}
.bt-learning-improvement-title{margin:0 0 6px;font-size:12px;line-height:16px;font-weight:600;color:var(--bt-ink)}
.bt-learning-improvement dl{display:grid;gap:6px;margin:0}.bt-learning-improvement dl div{display:grid;grid-template-columns:minmax(84px,.35fr) minmax(0,1fr);gap:8px}.bt-learning-improvement dt{font-size:11px;line-height:16px;color:var(--bt-ink-3)}.bt-learning-improvement dd{margin:0;font-size:12px;line-height:17px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-learning-review{margin:8px 0 0;font-size:12px;line-height:17px;color:var(--bt-danger)}
`
