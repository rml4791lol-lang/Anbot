export interface SessionEvidenceSummary {
  commands: number
  failures: number
  diffs: number
  deliverables: number
}

export interface BotWorkflowView {
  botId: string
  sessionId: string
  runId: string | null
  throughSequence: number | null
  status: 'preparing' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'error'
  result?: SessionEvidenceSummary
  reason?: string
}
