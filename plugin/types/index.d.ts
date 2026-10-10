/** A run's status as the dispatcher's `run.end` names it; any other string is read as `failed`. */
export type OcliStatus = 'running' | 'completed' | 'failed' | 'blocked' | 'spawn-error' | 'dispatch-error'

/** One developer-CLI run, folded from its live file. Every string is sanitized at ingest. */
export type OcliRun = {
  runId: string
  task: string
  role: string
  cli: string
  model: string | null
  /** What the run is for (run.start.title: --title or the spec's first line); '' when unknown. */
  title: string
  /** Where it works: the last path segment of run.start.root (the worktree); '' when unknown. */
  where: string
  /** Its card phase (run.start.phase: --phase, else the role); absent on runs folded by 0.1.x. */
  phase?: string
  status: OcliStatus
  startedAt: number | null
  endedAt: number | null
  lastAt: number | null
  lastSummary: string
  toolCount: number
  warnCount: number
  /** Sums of `usage` events; null = unknown (never reported), never 0. */
  tokens: { input: number | null; output: number | null }
  exitCode: number | null
  score: number | null
  ms: number | null
  /** Total of `run.end.dropped`; its keys are CLI-controlled and never kept. */
  dropped: number
  /** Highest `seq` folded in: the dedupe key with `runId`. */
  lastSeq: number
}

export type OcliDir = { path: string; isMissing: boolean }

export type OcliMeta = {
  dirs: OcliDir[]
  lastTickAt: number | null
  errors: number
  tooLarge: string[]
  /** Live files past the per-tick cap, not read this tick. */
  skipped: number
}

declare module 'claude-code' {
  interface PluginState {
    'ocli-monitor': {
      runs: OcliRun[]
      meta: OcliMeta
      /** `<task>/<runId>` keys whose end was already announced (or was already ended at the first tick). */
      notified: string[]
      /** True once the first tick ran: ends seen before it are not announced. */
      primed: boolean
      /** `<task>/<phase>` keys of the phase rows the person expanded. */
      expanded: string[]
    }
  }
}
