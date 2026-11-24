export type Observation<T> = {
  status: 'observed'
  value: T
  at: number
  source: string
  reason?: string
} | {
  status: 'unavailable'
  reason: string
  source?: string
  repair?: string
}

export interface TaskRef {
  taskId: string
  attemptId: string
}

export interface PairedCheckpoint {
  task?: TaskRef
  sessionId: string
  throughSequence: number | null
  worktree: string
  checkpointRef: string
  commit: string
  head: string
  memoryJournalThrough: string | null
  at: number
}

export type WorktreeObservation = Observation<{
  sessionId: string
  root: string
  revision: string
} & ({ state: 'created' | 'session-ready' } | { state: 'turn-started'; turnSequence: number })>

export type CliObservation = {
  name: string
} & ({ installed: false; signedIn: null } | { installed: true; signedIn: boolean | null })

export interface ExtensionObservations {
  cataloged: Observation<boolean>
  loaderAdmitted: Observation<boolean>
  bodyLoadable: Observation<boolean>
  initialConnected: Observation<boolean>
  liveness: Observation<'connected' | 'reconnecting' | 'failed'>
  authorization: Observation<'not-required' | 'allowed' | 'approval-required'>
}

export interface EffectiveExtension {
  id: string
  kind: 'skill' | 'mcp'
  availability: Observation<'loaded' | 'not-loaded' | 'approval-required'>
  observations: ExtensionObservations
}
