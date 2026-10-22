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
  /** Sums of `usage` events; null = unknown (never reported), never 0. `cached` (cache reads) is
   * absent on a run folded by an older version. */
  tokens: { input: number | null; output: number | null; cached?: number | null }
  /** run.start.prefixSha: sha256 of the dispatch's --prompt (the cache prefix), 12 lowercase hex.
   * Absent when the dispatcher did not send one or it was malformed, and on older folds. */
  prefixSha?: string
  exitCode: number | null
  score: number | null
  ms: number | null
  /** Total of `run.end.dropped`; its keys are CLI-controlled and never kept. */
  dropped: number
  /** run.end's witness finding codes: claims the run's own trace does not back. Absent on a run
   * folded by an older version ($.state outlives a reload) and on a run.end without a witness. */
  witness?: string[]
  /** Event times (ms), newest last, at most 200: the live row's sparkline. Dropped at run.end (an
   * ended run draws none); absent on a run folded by an older version. */
  beats?: number[]
  /** The current run of identical tool calls (`<tool>: <detail>`), `n` long: a call is a tool.start,
   * or a tool.end no start opened (opencode and muse emit no tool.start). `okSince` once a matching
   * tool.end reported ok; `open` while a start awaits its end. Dropped at run.end; absent on older folds. */
  streak?: { sig: string; n: number; okSince: boolean; open?: boolean }
  /** run.start.brief: what the run was asked to do (--brief, else derived from --suffix and the
   * prompt), at most 600 code points. Absent from an older dispatcher (the pane shows the title) and on
   * runs folded by 0.3.x; the same holds for every field below. */
  brief?: string
  /** run.start.root, the whole workspace path (`where` is its last segment). */
  root?: string
  /** run.start.parentId: the node this run continues. */
  parentId?: string
  /** The last 5 tool.end calls (`<tool>: <detail>`), newest last, with their verdict. */
  recent?: { text: string; ok: boolean | null }[]
  /** The latest assistant message, cut at 300 code points. */
  lastMessage?: string
  /** The last 3 warn texts, newest last (warnCount counts them all). */
  warnings?: string[]
  /** The --verify exit code from the dispatcher's `verify.end code=<n>` step; null when it had none. */
  verifyCode?: number | null
  /** Highest `seq` folded in: the dedupe key with `runId`. */
  lastSeq: number
}

/** A task card the person moved to History: a snapshot, so it still draws after its runs age out.
 * The card stays hidden, in its scope, while no event of its runs is newer than `lastAt`. */
export type OcliHistory = {
  /** The dirs the pane watched when the card was moved (the project): History is per scope. */
  scope: string
  task: string
  status: 'Completed' | 'Failed' | 'Blocked'
  runs: number
  tokens: number | null
  span: number | null
  lastAt: number
  dismissedAt: number
}

/** A task's declared phases (its plan.json), cleaned, and the plan file's mtime: the card's order
 * while the task has no run. */
export type OcliPlan = { task: string; phases: string[]; at: number }

/** The newest project checkpoint (`<root>/checkpoints/*.md`) as the pane draws it; every string cleaned. */
export type Checkpoint = { name: string; rows: { n: string; phase: string; status: string }[]; next: string; resume: string }

/** A provider's quota state: a gate or route verdict as the dispatcher's snapshot names it. */
export type QuotaState = 'ok' | 'stop' | 'unknown'

/** One provider of `<live dir>/usage/latest.json` (schema v1), checked and cleaned; times in ms. */
export type QuotaProvider = {
  /** One of codex, claude, glm, gemini, muse, cline. */
  name: string
  readAt: number | null
  status: 'ok' | 'unknown' | 'unavailable'
  reason: string
  windows: { limitId: string; usedPercent: number | null; mins: number | null; resetsAt: number | null }[]
  gate: QuotaState
  /** Scoped buckets (gemini's argon/flash): each route's own gate. */
  routes: { role: string; model: string; gate: QuotaState }[]
  stop: { until: number | null; reason: string } | null
  /** Which setting is missing ('' when none). */
  setup: string
}

/** The dispatcher's usage snapshot as the pane draws it: providers in the fixed order, a list (a
 * provider key named `__proto__` must not reach a prototype). */
export type OcliQuota = { writtenAt: number | null; providers: QuotaProvider[] }

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
      /** `<task>/<runId>` keys whose end was already announced (or was already ended at the first tick),
       * and `loop/<task>/<runId>` keys whose "may be looping" toast was shown (two `/`: never an end key). */
      notified: string[]
      /** True once the first tick ran: ends seen before it are not announced. */
      primed: boolean
      /** Tasks whose card the person expanded (0.3.x stored `<task>/<phase>` keys: they match no card). */
      expanded: string[]
      /** Cards moved to History by the person, oldest first; mirrored to $.store under `history`. */
      history: OcliHistory[]
      /** Whether the History card is open. */
      historyOpen: boolean
      /** Declared phases, one entry per task, from `<live dir>/<task>/plan.json`. */
      plans: OcliPlan[]
      /** The newest checkpoint, its file's mtime and the project root it was read under; null when none. */
      checkpoint: (Checkpoint & { mtimeMs: number; root: string }) | null
      /** The last /ocli-digest output (dispatcher/digest.mjs markdown, each line cleaned); '' before the first. */
      digest: string
      /** The last usage snapshot read from `<live dir>/usage/latest.json`; null when none or malformed. */
      quota: OcliQuota | null
      /** Whether the Quota card is open (it starts open). */
      quotaOpen: boolean
    }
  }
}
