// Test-only: usage snapshots in the dispatcher's schema v1 (<live dir>/usage/latest.json), dated
// against the harness clock. Hand-written: Part A's writer lands separately; this follows its spec.
import { NOW } from './harness'

const M = 60_000
// Half a minute past each mark: the pane draws a few ticks after NOW and its times floor to the minute.
const S = 30_000
const iso = (ms: number) => new Date(ms).toISOString()

/** codex fresh and binding on 5h; claude read 2 h ago (stale); glm stopped for 40 more minutes;
 * gemini binding on the week with scoped routes (argon stopped, flash open); muse unavailable with a
 * setup line; cline absent. */
export const SNAPSHOT = {
  v: 1,
  writtenAt: iso(NOW - M),
  providers: {
    codex: {
      readAt: iso(NOW - M), status: 'ok', source: 'native:codex', reason: null,
      windows: [
        { limitId: 'primary', usedPercent: 42, windowDurationMins: 300, resetsAt: iso(NOW + 130 * M + S) },
        { limitId: 'secondary', usedPercent: 18, windowDurationMins: 10080, resetsAt: iso(NOW + 3 * 1440 * M) },
      ],
      gate: { state: 'ok', reason: 'headroom', headroomPercent: 58 }, stop: null, setup: null,
    },
    claude: {
      readAt: iso(NOW - 120 * M), status: 'ok', source: 'lead', reason: null,
      windows: [
        { limitId: 'five_hour', usedPercent: 30, windowDurationMins: 300, resetsAt: iso(NOW + 60 * M + S) },
        { limitId: 'seven_day', usedPercent: 20, windowDurationMins: 10080, resetsAt: null },
      ],
      gate: { state: 'ok', reason: 'headroom', headroomPercent: 70 }, stop: null, setup: null,
    },
    glm: {
      readAt: iso(NOW - 2 * M), status: 'ok', source: 'plugin:zai', reason: null,
      windows: [{ limitId: 'tokens', usedPercent: 96, windowDurationMins: 300, resetsAt: iso(NOW + 40 * M + S) }],
      gate: { state: 'stop', reason: '5h at 96%', headroomPercent: 4 },
      stop: { until: iso(NOW + 40 * M + S), reason: 'quota exhausted' }, setup: null,
    },
    gemini: {
      readAt: iso(NOW - 5 * M), status: 'ok', source: 'native:gemini', reason: null,
      windows: [
        { limitId: 'daily', usedPercent: 10, windowDurationMins: 300, resetsAt: iso(NOW + 200 * M + S) },
        { limitId: 'weekly', usedPercent: 39, windowDurationMins: 10080, resetsAt: iso(NOW + 2 * 1440 * M + 3 * 60 * M + S) },
      ],
      gate: { state: 'ok', reason: 'headroom', headroomPercent: 61 },
      routes: [
        { role: 'breadth', model: 'gemini-4-argon-high', gate: { state: 'stop', reason: 'argon bucket empty' } },
        { role: 'breadth-medium', model: 'gemini-4-argon-medium', gate: { state: 'stop', reason: 'argon bucket empty' } },
        { role: 'breadth-flash', model: 'gemini-3.8-flash-high', gate: { state: 'ok', reason: 'headroom' } },
      ],
      stop: null, setup: null,
    },
    muse: {
      readAt: iso(NOW - M), status: 'unavailable', source: 'plugin:muse', reason: 'no reader',
      windows: [], gate: { state: 'unknown', reason: 'no reading', headroomPercent: null }, stop: null,
      setup: 'usage.muse is not set in the ocli config',
    },
  },
}

export const snapshotText = (snapshot: unknown = SNAPSHOT): string[] => [JSON.stringify(snapshot)]

export const GLM_UNTIL = NOW + 40 * M + S
