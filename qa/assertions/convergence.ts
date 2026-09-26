/**
 * Bounded-convergence analysis for cross-tier traces (UI vs ground truth), robust to sampling noise.
 *
 * For every ground-truth transition (API state changes to X, first seen at t_api):
 *   upper_ms = t(first UI sample showing X) - t_api     — includes any sampler stall; NOT used for verdicts
 *   lower_ms = t(last UI sample still NOT showing X) - t_api — staleness we actually OBSERVED
 * A defect requires lower_ms > bound: the UI was *seen* stale beyond the bound. A GC pause / scheduling
 * delay / network jitter in the harness only widens the gap between samples (inflating upper_ms), and
 * a single late telemetry sample produces one stale observation close to t_api — neither can cross the
 * bound unless the UI genuinely stays stale.
 *
 * After convergence, the UI reverting to a stale value ("regression") is measured the same way:
 * an isolated regressed sample is reported as a flicker (warning); an observed regression window
 * longer than the bound is a defect.
 */

export interface TransitionLatency {
  to: string;
  api_first_t: number;
  ui_first_t: number | null;
  last_stale_t: number | null;
  /** Observed staleness (ms). The verdict quantity. */
  lower_ms: number;
  /** Staleness upper bound (ms), includes sampling gaps. Null if the UI never showed the state. */
  upper_ms: number | null;
  /** The ground truth moved on before the UI ever showed this state. */
  skipped_by_ui: boolean;
  /** Largest gap between consecutive samples while this transition was open (sampler health). */
  max_gap_ms: number;
}

export interface Regression {
  state: string;
  from_t: number;
  to_t: number;
  samples: number;
  /** Observed duration (ms) of the regression window (0 for one isolated sample). */
  observed_ms: number;
}

export interface ConvergenceReport {
  transitions: TransitionLatency[];
  regressions: Regression[];
  max_sample_gap_ms: number;
}

export function analyseConvergence<S extends { t: number }>(trace: S[], api: (s: S) => string | undefined, ui: (s: S) => string): ConvergenceReport {
  const transitions: TransitionLatency[] = [];
  const regressions: Regression[] = [];
  let maxGap = 0;
  for (let i = 1; i < trace.length; i++) maxGap = Math.max(maxGap, trace[i].t - trace[i - 1].t);

  // i = 0 opens a transition too: the ground truth usually changed just before sampling began, so
  // measuring from t=0 under-estimates staleness (conservative: can only reduce findings).
  for (let i = 0; i < trace.length; i++) {
    const to = api(trace[i]);
    if (to === undefined || (i > 0 && to === api(trace[i - 1]))) continue;
    // Window during which the ground truth stays at `to`.
    let end = i;
    while (end + 1 < trace.length && api(trace[end + 1]) === to) end++;
    let firstUi: number | null = null;
    let lastStale: number | null = null;
    let gap = 0;
    for (let j = i; j <= end; j++) {
      if (j > i) gap = Math.max(gap, trace[j].t - trace[j - 1].t);
      if (ui(trace[j]) === to) {
        if (firstUi === null) firstUi = j;
      } else if (firstUi === null) {
        lastStale = j;
      }
    }
    transitions.push({
      to,
      api_first_t: trace[i].t,
      ui_first_t: firstUi === null ? null : trace[firstUi].t,
      last_stale_t: lastStale === null ? null : trace[lastStale].t,
      lower_ms: lastStale === null ? 0 : trace[lastStale].t - trace[i].t,
      upper_ms: firstUi === null ? null : trace[firstUi].t - trace[i].t,
      skipped_by_ui: firstUi === null && end + 1 < trace.length,
      max_gap_ms: gap,
    });
    // Regressions: after the UI converged on `to`, while the ground truth is still `to`.
    if (firstUi !== null) {
      let run: number[] = [];
      const flush = () => {
        if (run.length) regressions.push({ state: to, from_t: trace[run[0]].t, to_t: trace[run[run.length - 1]].t, samples: run.length, observed_ms: trace[run[run.length - 1]].t - trace[run[0]].t });
        run = [];
      };
      for (let j = firstUi + 1; j <= end; j++) {
        if (ui(trace[j]) !== to) run.push(j);
        else flush();
      }
      flush();
    }
    i = end;
  }
  return { transitions, regressions, max_sample_gap_ms: maxGap };
}

/**
 * Longest run of consecutive samples for which `bad` holds, in samples and observed ms.
 * Used for "UI ahead of ground truth": one sample is noise-level evidence, >=2 consecutive is confirmed.
 */
export function longestRun<S extends { t: number }>(trace: S[], bad: (s: S) => boolean): { samples: number; observed_ms: number; from_t: number | null } {
  let best = { samples: 0, observed_ms: 0, from_t: null as number | null };
  let start = -1;
  for (let i = 0; i <= trace.length; i++) {
    if (i < trace.length && bad(trace[i])) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const len = i - start;
      if (len > best.samples) best = { samples: len, observed_ms: trace[i - 1].t - trace[start].t, from_t: trace[start].t };
      start = -1;
    }
  }
  return best;
}
