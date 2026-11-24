import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Observation } from './harness-contracts.js'

type TokenMeasurement = ReturnType<TokenMeter['measure']>

export interface ContextProjection {
  sessionId: string
  throughSequence: number
  retainedMessageIds: readonly string[]
  sourceRanges: readonly { from: number; through: number }[]
  replacements: readonly { sequence: number; start: number; end: number; sourceSequences: readonly number[] }[]
  usedTokens: Observation<number>
  limitTokens: Observation<number>
}

export type ContextBudget = ({
  status: 'observed'
  throughSequence: number
  usedTokens: number
  measuredFrom: TokenMeasurement['baseline']['kind']
  window: number
  usable: number
  check: number
  hard: number
  surfaceNodes: number
} | {
  status: 'unavailable'
  reason: 'no-request' | 'meter-unavailable' | 'capacity-unavailable'
}) & { projection?: ContextProjection }

export function observeContextBudget(session: Session, reader: {
  measure: (session: Session) => TokenMeasurement | undefined
  limits: (route: { provider: string; model: string; maxTokens?: number }) => Promise<Pick<Extract<ContextBudget, { status: 'observed' }>, 'window' | 'usable' | 'check' | 'hard'> | undefined>
}): Promise<ContextBudget>
