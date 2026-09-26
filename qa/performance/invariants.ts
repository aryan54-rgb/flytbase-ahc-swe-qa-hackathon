import { sustainedGrowth } from './metrics.js';
import type { BaselineComparison, InvariantCategory, InvariantResult, PerformanceInvariant, StepVerdict, WindowMetrics } from './types.js';

/**
 * User-facing performance contracts. Categories are explicit bands, so the gap between "nominal"
 * and "degraded" (e.g. 150–300 ms interaction latency) is reported as ELEVATED instead of hidden.
 *
 *   worse = higher:  v <= nominal NOMINAL · <= degraded ELEVATED · <= breach DEGRADED · > breach BREACH
 *   worse = lower:   v >= nominal NOMINAL · >= degraded ELEVATED · >= breach DEGRADED · < breach BREACH
 *
 * All thresholds are data: override with `withOverrides()` or QA_PERF_INVARIANTS='{"id":{"breach":800}}'.
 */
export const DEFAULT_INVARIANTS: PerformanceInvariant[] = [
  { id: 'responsiveness.interaction', title: 'Operator interaction latency', group: 'responsiveness', metric: 'interaction_latency_ms', worse: 'higher', nominal: 150, degraded: 300, breach: 1000, statistic: 'median', hard: true },
  { id: 'responsiveness.long_task', title: 'Longest main-thread task (> 500 ms is severe)', group: 'responsiveness', metric: 'long_task_max_ms', worse: 'higher', nominal: 150, degraded: 300, breach: 500, statistic: 'max', hard: true },
  { id: 'smoothness.fps', title: 'Average frame rate >= 20 fps', group: 'smoothness', metric: 'fps_mean', worse: 'lower', nominal: 30, degraded: 25, breach: 20, statistic: 'value', hard: true },
  { id: 'smoothness.freeze', title: 'No single freeze > 500 ms', group: 'smoothness', metric: 'max_frame_gap_ms', worse: 'higher', nominal: 100, degraded: 250, breach: 500, statistic: 'max', hard: true },
  { id: 'freshness.telemetry', title: 'Displayed telemetry <= 3000 ms old', group: 'freshness', metric: 'telemetry_age_ms', worse: 'higher', nominal: 1000, degraded: 2000, breach: 3000, statistic: 'max', hard: true },
  { id: 'convergence.fleet', title: 'Device list reflects a fleet change within 1500 ms', group: 'convergence', metric: 'fleet_convergence_ms', worse: 'higher', nominal: 1000, degraded: 1250, breach: 1500, statistic: 'value', hard: true },
  { id: 'stability.page_errors', title: 'Zero unhandled JS exceptions', group: 'stability', metric: 'page_errors', worse: 'higher', nominal: 0, degraded: 0, breach: 0, statistic: 'value', hard: true },
  { id: 'stability.webgl', title: 'Zero WebGL context losses', group: 'stability', metric: 'webgl_context_lost', worse: 'higher', nominal: 0, degraded: 0, breach: 0, statistic: 'value', hard: true },
];

/** Stability contracts: one occurrence in any window counts (never averaged away by a second window). */
const ANY_OCCURRENCE = new Set(['stability']);

export const CATEGORY_RANK: Record<InvariantCategory, number> = { UNAVAILABLE: -1, NOMINAL: 0, ELEVATED: 1, DEGRADED: 2, BREACH: 3 };

export function withOverrides(base: PerformanceInvariant[], overrides: Record<string, Partial<Pick<PerformanceInvariant, 'nominal' | 'degraded' | 'breach'>>>): PerformanceInvariant[] {
  return base.map((inv) => ({ ...inv, ...(overrides[inv.id] ?? {}) }));
}

export function invariantsFromEnv(): PerformanceInvariant[] {
  const raw = process.env.QA_PERF_INVARIANTS;
  if (!raw) return DEFAULT_INVARIANTS;
  return withOverrides(DEFAULT_INVARIANTS, JSON.parse(raw) as Record<string, Partial<PerformanceInvariant>>);
}

export function categorize(inv: Pick<PerformanceInvariant, 'worse' | 'nominal' | 'degraded' | 'breach'>, v: number | null | undefined): InvariantCategory {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'UNAVAILABLE';
  if (inv.worse === 'higher') return v <= inv.nominal ? 'NOMINAL' : v <= inv.degraded ? 'ELEVATED' : v <= inv.breach ? 'DEGRADED' : 'BREACH';
  return v >= inv.nominal ? 'NOMINAL' : v >= inv.degraded ? 'ELEVATED' : v >= inv.breach ? 'DEGRADED' : 'BREACH';
}

/** Evaluate every contract whose metric this window measured (absent metrics are simply not judged). */
export function evaluateInvariants(values: WindowMetrics['values'], unavailable: WindowMetrics['unavailable'], invariants: PerformanceInvariant[] = DEFAULT_INVARIANTS): InvariantResult[] {
  return invariants
    .filter((inv) => inv.metric in values)
    .map((inv) => {
      const observed = values[inv.metric] ?? null;
      const category = categorize(inv, observed);
      return {
        id: inv.id,
        group: inv.group,
        metric: inv.metric,
        category,
        observed,
        thresholds: { nominal: inv.nominal, degraded: inv.degraded, breach: inv.breach, worse: inv.worse },
        reason: category === 'UNAVAILABLE' ? unavailable[inv.metric] ?? 'not measured' : undefined,
      };
    });
}

/** A first window this bad is re-observed before the level is judged (isolated outlier vs sustained). */
export function needsConfirmation(results: InvariantResult[], comparisons: BaselineComparison[], preexisting: Map<string, InvariantCategory>): boolean {
  return (
    results.some((r) => CATEGORY_RANK[r.category] >= CATEGORY_RANK.DEGRADED && CATEGORY_RANK[r.category] > CATEGORY_RANK[preexisting.get(r.id) ?? 'NOMINAL']) ||
    comparisons.some((c) => c.classification === 'OUTLIER' || c.classification === 'PERFORMANCE_REGRESSION')
  );
}

export interface StepJudgement {
  verdict: StepVerdict;
  invariants: InvariantResult[];
  isolated_outliers: string[];
  reasons: string[];
  pass: boolean;
}

/**
 * Judge one workload level from its (1 or 2 consecutive) windows.
 *  - Sustained category per contract = the LESS severe of the windows (a single bad window is an
 *    isolated outlier, recorded but not a verdict). Stability contracts use the worst (any occurrence).
 *  - Contracts already violated at the baseline workload (`preexisting`) only count when they get worse.
 *  - Baseline-relative PERFORMANCE_REGRESSION (already requires consecutive windows) => DEGRADED.
 *  - If the core responsiveness/smoothness contracts are all UNAVAILABLE the level is INCONCLUSIVE.
 */
export function judgeStep(perWindow: InvariantResult[][], comparisons: BaselineComparison[], preexisting: Map<string, InvariantCategory>, invariants: PerformanceInvariant[] = DEFAULT_INVARIANTS): StepJudgement {
  const reasons: string[] = [];
  const isolated: string[] = [];
  const ids = [...new Set(perWindow.flat().map((r) => r.id))];
  const sustained: InvariantResult[] = ids.map((id) => {
    const rs = perWindow.map((w) => w.find((r) => r.id === id)).filter((r): r is InvariantResult => !!r);
    const measured = rs.filter((r) => r.category !== 'UNAVAILABLE');
    if (measured.length === 0) return rs[rs.length - 1];
    const byRank = [...measured].sort((a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]);
    const pick = ANY_OCCURRENCE.has(measured[0].group) || measured.length === 1 ? byRank[byRank.length - 1] : byRank[0];
    const worst = byRank[byRank.length - 1];
    if (pick !== worst && CATEGORY_RANK[worst.category] >= CATEGORY_RANK.DEGRADED) isolated.push(`${id}: ${worst.category} in one window (${worst.observed}), ${pick.category} in the confirmation window (${pick.observed})`);
    return pick;
  });

  const hard = new Set(invariants.filter((i) => i.hard).map((i) => i.id));
  const worsened = (r: InvariantResult) => CATEGORY_RANK[r.category] > CATEGORY_RANK[preexisting.get(r.id) ?? 'NOMINAL'];
  const breaches = sustained.filter((r) => r.category === 'BREACH' && hard.has(r.id) && worsened(r));
  const degraded = sustained.filter((r) => r.category === 'DEGRADED' && worsened(r));
  const regressions = comparisons.filter((c) => c.classification === 'PERFORMANCE_REGRESSION');
  for (const c of comparisons.filter((x) => x.classification === 'OUTLIER')) isolated.push(`${c.metric}: beyond the baseline limit in one window only (${c.observed.join(', ')})`);

  for (const r of breaches) reasons.push(`${r.id} BREACH: ${r.metric}=${r.observed} (breach ${r.thresholds.worse === 'higher' ? '>' : '<'} ${r.thresholds.breach})`);
  for (const r of degraded) reasons.push(`${r.id} DEGRADED: ${r.metric}=${r.observed} (degraded ${r.thresholds.worse === 'higher' ? '>' : '<'} ${r.thresholds.degraded})`);
  for (const c of regressions) reasons.push(`${c.metric} PERFORMANCE_REGRESSION vs baseline: ${c.observed.join(', ')} beyond ${c.regression_limit?.toFixed(1)} in ${c.observed.length} consecutive windows`);

  const core = sustained.filter((r) => r.group === 'responsiveness' || r.group === 'smoothness');
  let verdict: StepVerdict;
  if (breaches.length) verdict = 'HARD_INVARIANT_BREACH';
  else if (degraded.length || regressions.length) verdict = 'DEGRADED';
  else if (core.length > 0 && core.every((r) => r.category === 'UNAVAILABLE')) {
    verdict = 'INCONCLUSIVE';
    reasons.push('responsiveness and smoothness metrics unavailable in this window');
  } else verdict = 'HEALTHY';
  return { verdict, invariants: sustained, isolated_outliers: isolated, reasons, pass: verdict === 'HEALTHY' };
}

/** Contracts the baseline workload itself does not meet; later levels are judged relative to them. */
export function preexistingViolations(baselineResults: InvariantResult[][]): Map<string, InvariantCategory> {
  const out = new Map<string, InvariantCategory>();
  const ids = new Set(baselineResults.flat().map((r) => r.id));
  for (const id of ids) {
    // Median-ish: the category reached by at least half of the baseline windows.
    const cats = baselineResults.map((w) => w.find((r) => r.id === id)?.category).filter((c): c is InvariantCategory => !!c && c !== 'UNAVAILABLE');
    if (!cats.length) continue;
    const sorted = cats.sort((a, b) => CATEGORY_RANK[a] - CATEGORY_RANK[b]);
    const typical = sorted[Math.floor((sorted.length - 1) / 2)];
    if (CATEGORY_RANK[typical] >= CATEGORY_RANK.DEGRADED) out.set(id, typical);
  }
  return out;
}

/**
 * Memory contract: heap growth should stabilize once track history reaches its cap. Judged only on
 * samples AFTER saturation, with a robust slope (Theil-Sen) AND a majority of rising steps — one GC
 * drop or one spike is never called a leak. Before saturation, growth is expected (tracks grow) and
 * the contract is UNAVAILABLE rather than passed.
 * x = minutes, y = bytes; `slopeLimit` in bytes/minute.
 */
export function evaluateHeapTrend(points: Array<{ x: number; y: number }>, saturatedAtX: number | null, slopeLimit: number, minPost = 3): InvariantResult & { detail: Record<string, unknown> } {
  const base = { id: 'memory.heap_stabilizes', group: 'memory' as const, metric: 'heap_used_bytes' as const, thresholds: { nominal: slopeLimit, degraded: slopeLimit, breach: Number.POSITIVE_INFINITY, worse: 'higher' as const } };
  const pre = sustainedGrowth(points.filter((p) => saturatedAtX === null || p.x < saturatedAtX), slopeLimit, 0.6, 'bytes/min');
  if (saturatedAtX === null) return { ...base, category: 'UNAVAILABLE', observed: null, reason: 'track history did not reach its cap during the run: post-saturation heap trend not measurable', detail: { pre_saturation: pre } };
  const post = points.filter((p) => p.x >= saturatedAtX);
  if (post.length < minPost) return { ...base, category: 'UNAVAILABLE', observed: null, reason: `only ${post.length} sample(s) after saturation (need ${minPost})`, detail: { pre_saturation: pre } };
  const g = sustainedGrowth(post, slopeLimit, 0.6, 'bytes/min');
  return { ...base, category: g.sustained ? 'DEGRADED' : 'NOMINAL', observed: g.slope, reason: g.reason, detail: { pre_saturation: pre, post_saturation: g, samples_after_saturation: post.length } };
}
