import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { METRICS, stats, tukeyLimits } from './metrics.js';
import type { BaselineComparison, MetricBaseline, MetricKey, PerformanceBaselineProfile, WindowMetrics } from './types.js';

/**
 * Performance baseline: the distribution of every metric over K windows at the baseline workload
 * (default N=4 drones, 1.0x, no faults). It extends the Level-1 baseline system without touching
 * its schema: the profile lives in its own file, qa/baseline/performance-baseline.json.
 *
 * Every perf scenario also measures an in-run baseline (same browser, same stack, minutes apart),
 * which is what regression detection uses; the recorded file is compared as cross-run drift.
 *
 * Per metric (worse = higher; mirrored at P5 when lower is worse):
 *   NORMAL_VARIANCE          value <= P95 + 1.5 * IQR
 *   OUTLIER                  beyond that, or beyond the regression limit in fewer than 2 consecutive windows
 *   PERFORMANCE_REGRESSION   > P95 + 3.0 * IQR in 2 consecutive observation windows
 *   INSUFFICIENT_BASELINE    fewer than `minSamples` baseline values: not judged
 * Constants live in perfConfig.tukey; each metric has an absolute floor (metrics.ts) so a zero-IQR
 * baseline cannot turn one sample of noise into a regression.
 */

export const perfBaselineFile = (qaRoot: string) => join(qaRoot, 'baseline', 'performance-baseline.json');

export interface ProfileOptions {
  normalK: number;
  regressionK: number;
  consecutiveWindows: number;
  minSamples: number;
  workload: PerformanceBaselineProfile['workload'];
  windowMs: number;
  clockOffsetMs: number | null;
}

export function buildProfile(windows: Array<Pick<WindowMetrics, 'values'>>, o: ProfileOptions): PerformanceBaselineProfile {
  const metrics: PerformanceBaselineProfile['metrics'] = {};
  const unavailable: MetricKey[] = [];
  for (const key of Object.keys(METRICS) as MetricKey[]) {
    const spec = METRICS[key];
    const s = stats(windows.map((w) => w.values[key]));
    if (!s) {
      if (windows.some((w) => key in w.values)) unavailable.push(key);
      continue;
    }
    const worse = spec.worse;
    const lim = worse === 'none' ? { normal: NaN, regression: NaN } : tukeyLimits(s, worse, o.normalK, o.regressionK, spec.floor);
    const m: MetricBaseline = { ...s, worse, normal_limit: lim.normal, regression_limit: lim.regression, sufficient: s.n >= o.minSamples };
    metrics[key] = m;
  }
  return {
    schema: 'cockpit-qa/perf-baseline@1',
    recorded_at: new Date().toISOString(),
    workload: o.workload,
    windows: windows.length,
    window_ms: o.windowMs,
    constants: { normal_iqr_k: o.normalK, regression_iqr_k: o.regressionK, consecutive_windows: o.consecutiveWindows, min_samples: o.minSamples },
    metrics,
    unavailable,
    clock_offset_ms: o.clockOffsetMs,
  };
}

const beyond = (v: number, limit: number, worse: 'higher' | 'lower') => (worse === 'higher' ? v > limit : v < limit);

/**
 * Classify consecutive windows of one workload level against the profile. Only metrics flagged
 * `regression: true` (user-facing) are judged; diagnostic metrics that scale with load are not.
 */
export function compareToBaseline(profile: PerformanceBaselineProfile | null, windows: Array<Pick<WindowMetrics, 'values'>>): BaselineComparison[] {
  if (!profile) return [];
  const need = profile.constants.consecutive_windows;
  const out: BaselineComparison[] = [];
  for (const key of Object.keys(METRICS) as MetricKey[]) {
    const spec = METRICS[key];
    if (!spec.regression || spec.worse === 'none') continue;
    const observed = windows.map((w) => w.values[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (!windows.some((w) => key in w.values)) continue;
    const b = profile.metrics[key];
    if (!observed.length) {
      out.push({ metric: key, classification: 'UNAVAILABLE', observed, normal_limit: b?.normal_limit ?? null, regression_limit: b?.regression_limit ?? null });
      continue;
    }
    if (!b || !b.sufficient) {
      out.push({ metric: key, classification: 'INSUFFICIENT_BASELINE', observed, normal_limit: b?.normal_limit ?? null, regression_limit: b?.regression_limit ?? null });
      continue;
    }
    const worse = spec.worse;
    const overRegression = observed.map((v) => beyond(v, b.regression_limit, worse));
    // Regression: the LAST `need` consecutive windows are all beyond the regression limit.
    const tail = overRegression.slice(-need);
    const classification = tail.length >= need && tail.every(Boolean) ? 'PERFORMANCE_REGRESSION' : observed.some((v) => beyond(v, b.normal_limit, worse)) ? 'OUTLIER' : 'NORMAL_VARIANCE';
    out.push({ metric: key, classification, observed, normal_limit: b.normal_limit, regression_limit: b.regression_limit });
  }
  return out;
}

export function loadPerfBaseline(qaRoot: string): PerformanceBaselineProfile | null {
  const f = perfBaselineFile(qaRoot);
  if (!existsSync(f)) return null;
  try {
    const p = JSON.parse(readFileSync(f, 'utf8')) as PerformanceBaselineProfile;
    return p.schema === 'cockpit-qa/perf-baseline@1' ? p : null;
  } catch {
    return null;
  }
}

export function writePerfBaseline(qaRoot: string, profile: PerformanceBaselineProfile): string {
  const f = perfBaselineFile(qaRoot);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(profile, null, 2));
  return f;
}

/** In-run baseline medians vs the recorded profile: environment drift between runs (informational). */
export function profileDrift(recorded: PerformanceBaselineProfile | null, current: PerformanceBaselineProfile): BaselineComparison[] | null {
  if (!recorded) return null;
  const pseudo = Object.fromEntries(Object.entries(current.metrics).map(([k, m]) => [k, m!.median])) as WindowMetrics['values'];
  // The in-run median is one value, so judge it against the normal limit only (never a "regression").
  return compareToBaseline({ ...recorded, constants: { ...recorded.constants, consecutive_windows: Number.POSITIVE_INFINITY } }, [{ values: pseudo }]);
}
