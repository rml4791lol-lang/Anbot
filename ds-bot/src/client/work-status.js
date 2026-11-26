import { createElement as h, useEffect, useState } from 'react'
import { AgentOrb } from '@firexcore/agent-orbs'
import { Elapsed, Shimmer } from './cells.js'
import { t } from './i18n.js'

// The status ornament comes from @firexcore/agent-orbs (MIT; see NOTICE): its
// Canvas 2D scenes name the work instead of replaying a generic spinner. The
// names below map DSH's states to the library's ten scenes.
export const ORB_STATE = {
  thinking: 'shaping',
  searching: 'searching',
  working: 'working',
  sending: 'connecting',
  alert: 'waiting',
  done: 'composing',
  orbit: 'weaving',
  idle: 'breathing',
}
export const SUBAGENT_STATE = { weave: 'weaving', connect: 'connecting', solve: 'solving' }

export const workStatusOf = prefs => (prefs?.workStatus === 'compact' ? 'compact' : 'full')
export const workOrbOf = prefs => prefs?.workOrb !== false
export const workMetricsOf = prefs => prefs?.workMetrics !== false
export const workSpeedOf = prefs => ([0.5, 0.75, 1, 1.5, 2].includes(prefs?.orbSpeed) ? prefs.orbSpeed : 1)
export const loadingStateOf = prefs => (['shaping', 'breathing', 'waiting'].includes(prefs?.loadingStyle) ? prefs.loadingStyle : 'shaping')
export const subagentStateOf = prefs => (['weaving', 'connecting', 'solving'].includes(prefs?.subagentStyle) ? prefs.subagentStyle : 'weaving')

export function stateFor(tool, state, prefs) {
  const subagent = typeof tool === 'string' && (tool === 'subagent' || tool.startsWith('subagent_') || tool === 'delegate_work')
  if (subagent) return subagentStateOf(prefs)
  if (!tool && (state === 'thinking' || state === 'idle' || !state)) return loadingStateOf(prefs)
  return ORB_STATE[state] ?? 'working'
}

export function OrbMark({ tool, state, prefs }) {
  return h(AgentOrb, {
    state: stateFor(tool, state, prefs),
    size: 32,
    speed: workSpeedOf(prefs),
    paused: prefs?.effects === 'off',
    theme: globalThis.document?.body?.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light',
    ...(typeof prefs?.accent === 'string' ? { accent: prefs.accent } : {}),
    'aria-hidden': true,
    focusable: 'false',
    style: { flex: 'none', display: 'block' },
  })
}

function secondsOf(start, end) {
  if (!Number.isFinite(start) || start <= 0) return 0
  const until = Number.isFinite(end) && end > 0 ? end : Date.now()
  return Math.max(0, Math.round((until - start) / 1000))
}

// Counts from the turn's start until its first tool. Once a tool arrives the
// figure is frozen, so it reads as the time spent thinking rather than a second
// clock that keeps running through the work.
function ThinkClock({ start, frozenAt }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!Number.isFinite(start) || start <= 0 || (Number.isFinite(frozenAt) && frozenAt > 0)) return undefined
    const timer = setInterval(() => setTick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [start, frozenAt])
  return h('span', { className: 'bt-work-think' }, t('Thinking {seconds}s', { seconds: secondsOf(start, frozenAt) }))
}

export function countText(count) {
  return t(count === 1 ? '1 action' : '{count} actions', { count })
}

const compactCount = count => (count >= 1e6
  ? `${(count / 1e6).toFixed(1)}M`
  : count >= 1e3 ? `${(count / 1e3).toFixed(1)}K` : String(count))
const speedText = speed => (speed >= 10 ? String(Math.round(speed)) : String(Math.round(speed * 10) / 10))

export function statsOf(values) {
  const stats = values?.sessionStats
  const usage = values?.tokenUsage
  const speed = stats?.decodeMs > 0 && stats?.decodeTokens > 0
    ? stats.decodeTokens / (stats.decodeMs / 1000)
    : null
  const tokens = (usage?.uncachedInputTokens ?? 0) + (usage?.cacheReadTokens ?? 0)
    + (usage?.cacheWriteTokens ?? 0) + (usage?.outputTokens ?? 0)
  return { speed, tokens: tokens > 0 ? tokens : null }
}

// The three-line status the user asked for: what the turn is doing, the phrase
// it changes with, and the figures DSH already keeps. Compact keeps the old row.
export function WorkStatus({ phrase, startAt, toolCount, firstToolAt, stats, metrics }) {
  return h('span', { className: 'bt-work' },
    h('span', { className: 'bt-work-top' },
      toolCount > 0 ? h('span', { className: 'bt-work-count' }, countText(toolCount)) : null,
      toolCount > 0 ? h('span', { className: 'bt-work-dot', 'aria-hidden': true }, '·') : null,
      h(ThinkClock, { start: startAt, frozenAt: firstToolAt })),
    h('span', { className: 'bt-work-phrase' }, h(Shimmer, { key: phrase.key }, `${phrase.text}…`)),
    h('span', { className: 'bt-work-meta' },
      h(Elapsed, { at: startAt, bare: true, className: 'bt-work-elapsed' }),
      metrics && stats?.speed ? h('span', { className: 'bt-work-sep', 'aria-hidden': true }, '·') : null,
      metrics && stats?.speed ? h('span', { title: t('{speed} tokens per second', { speed: speedText(stats.speed) }) }, `${speedText(stats.speed)} tok/s`) : null,
      metrics && stats?.tokens ? h('span', { className: 'bt-work-sep', 'aria-hidden': true }, '·') : null,
      metrics && stats?.tokens ? h('span', { title: t('{count} tokens in this Session', { count: stats.tokens }) }, `${compactCount(stats.tokens)} tokens`) : null))
}
