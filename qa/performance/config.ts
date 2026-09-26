/**
 * Level-2 knobs. Timing and statistics are overridable with env vars; the SAFETY limits are not
 * raised by env (only lowered), so a typo cannot push the shared stack beyond them.
 */

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
const atMost = (name: string, fallback: number, hard: number) => Math.min(num(name, fallback), hard);

export const SAFETY = {
  maxDrones: 32,
  maxSimSpeed: 5,
  maxScenarioVideoStreams: 3,
  minInteractionIntervalMs: 500,
  /** Workload phase of each scenario (page load before and cleanup after are not counted). */
  scenarioTimeoutMs: 180_000,
  /** A frame gap / unresponsive page longer than this aborts the scenario. */
  freezeAbortMs: 5_000,
  /** Consecutive backend outage responses (network / 502-504) that abort the scenario. */
  maxConsecutiveOutages: 3,
} as const;

export const perfConfig = {
  /** Set by the CLI: `--perf --record-baseline` collects the N=4 profile and stops. */
  mode: { recordBaselineOnly: false },
  safety: {
    maxDrones: atMost('QA_PERF_MAX_DRONES', SAFETY.maxDrones, SAFETY.maxDrones),
    maxSimSpeed: SAFETY.maxSimSpeed,
    maxScenarioVideoStreams: SAFETY.maxScenarioVideoStreams,
    minInteractionIntervalMs: SAFETY.minInteractionIntervalMs,
    scenarioTimeoutMs: atMost('QA_PERF_TIMEOUT_MS', SAFETY.scenarioTimeoutMs, SAFETY.scenarioTimeoutMs),
    freezeAbortMs: SAFETY.freezeAbortMs,
    maxConsecutiveOutages: SAFETY.maxConsecutiveOutages,
  },
  baseline: {
    drones: 4,
    speed: 1,
    windows: num('QA_PERF_BASELINE_WINDOWS', 5),
    /** Discarded warm-up before the first baseline window (map tiles / first subscriptions settle). */
    warmupMs: num('QA_PERF_BASELINE_WARMUP_MS', 5_000),
    minSamples: 3,
  },
  timing: {
    stabilizeMs: num('QA_PERF_STABILIZE_MS', 4_000),
    observeMs: num('QA_PERF_OBSERVE_MS', 5_000),
    /** Backend RTT / telemetry freshness sampling period inside a window. */
    sampleEveryMs: 1_000,
    interactionsPerStep: 3,
    interactionTimeoutMs: 5_000,
    /** Fleet change -> device rows; beyond this the rows are considered never converged (correctness). */
    convergenceGiveUpMs: 10_000,
  },
  ramp: {
    levels: [4, 8, 12, 16, 20, 24, 28, 32],
    resolution: 1,
  },
  /** Tukey-style baseline outlier constants (see baseline.ts). */
  tukey: { normalK: 1.5, regressionK: 3.0, consecutiveWindows: 2 },
  soak: {
    durationMs: atMost('QA_PERF_SOAK_MS', 150_000, SAFETY.scenarioTimeoutMs - 20_000),
    warmupMs: num('QA_PERF_WARMUP_MS', 10_000),
    sampleEveryMs: 15_000,
    windowMs: 3_000,
    flyingDrones: 2,
    /** Sustained growth = Theil-Sen slope above this AND most consecutive deltas positive. */
    heapSlopeLimitBytesPerMin: num('QA_PERF_HEAP_SLOPE_LIMIT', 2 * 1024 * 1024),
    domSlopeLimitPerMin: 50,
    latencyDriftLimitMsPerMin: 50,
    /** MAX_TRACK in frontend/src/store/telemetry.store.ts: points kept per device (2 per second per drone). */
    trackCapPerDevice: 2000,
  },
  stress: {
    drones: 6,
    flyingDrones: 3,
    intervalsMs: [2_000, 1_000, 500],
    phaseMs: num('QA_PERF_STRESS_PHASE_MS', 12_000),
  },
};

export type PerfConfig = typeof perfConfig;
