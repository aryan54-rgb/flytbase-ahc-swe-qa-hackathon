import type { MetricKey, MetricSpec, MetricStats, WindowMetrics } from './types.js';

/**
 * Metric catalog and pure statistics. No I/O here: everything is unit-testable (performance/selftest.ts).
 */

export const METRICS: Record<MetricKey, MetricSpec> = {
  interaction_latency_ms: { source: 'browser', unit: 'ms', worse: 'higher', regression: true, floor: 50, description: 'operator click -> first frame showing the intended postcondition (median of the window)' },
  event_timing_ms: { source: 'browser', unit: 'ms', worse: 'higher', regression: false, floor: 50, description: 'browser Event Timing duration of the click (processing + next paint)' },
  long_task_count: { source: 'browser', unit: 'count', worse: 'higher', regression: false, floor: 2, description: 'main-thread tasks > 50 ms in the window' },
  long_task_max_ms: { source: 'browser', unit: 'ms', worse: 'higher', regression: true, floor: 50, description: 'longest main-thread task in the window' },
  tbt_ms: { source: 'browser', unit: 'ms', worse: 'higher', regression: false, floor: 100, description: 'total blocking time of the window: sum of (long task - 50 ms); depends on window length' },
  tbt_per_s: { source: 'browser', unit: 'ms', worse: 'higher', regression: true, floor: 20, description: 'total blocking time per second of window (comparable across window lengths)' },
  fps_mean: { source: 'browser', unit: 'fps', worse: 'lower', regression: true, floor: 3, description: 'requestAnimationFrame callbacks per second over the window' },
  fps_p10: { source: 'browser', unit: 'fps', worse: 'lower', regression: false, floor: 3, description: '10th percentile of per-second frame counts' },
  frames_over_33ms: { source: 'browser', unit: 'count', worse: 'higher', regression: false, floor: 3, description: 'frame intervals > 33.3 ms (dropped frames at 30 fps)' },
  max_frame_gap_ms: { source: 'browser', unit: 'ms', worse: 'higher', regression: true, floor: 50, description: 'longest interval between two frames (freeze)' },
  heap_used_bytes: { source: 'browser', unit: 'bytes', worse: 'none', regression: false, floor: 0, description: 'JS heap in use (performance.memory, precise mode)' },
  dom_nodes: { source: 'browser', unit: 'count', worse: 'none', regression: false, floor: 0, description: 'elements in the document' },
  main_thread_busy_ratio: { source: 'browser', unit: 'ratio', worse: 'none', regression: false, floor: 0, description: 'CDP TaskDuration delta / window' },
  script_busy_ratio: { source: 'browser', unit: 'ratio', worse: 'none', regression: false, floor: 0, description: 'CDP ScriptDuration delta / window' },
  page_errors: { source: 'browser', unit: 'count', worse: 'higher', regression: false, floor: 0, description: 'uncaught exceptions in the window' },
  console_errors: { source: 'browser', unit: 'count', worse: 'higher', regression: false, floor: 0, description: 'console.error messages in the window' },
  failed_requests: { source: 'browser', unit: 'count', worse: 'higher', regression: false, floor: 0, description: 'failed network requests in the window' },
  webgl_context_lost: { source: 'browser', unit: 'count', worse: 'higher', regression: false, floor: 0, description: 'webglcontextlost events in the window' },
  map_render_ms: { source: 'browser', unit: 'ms', worse: 'none', regression: false, floor: 0, description: 'mean Cesium scene render time (preRender -> postRender)' },
  map_renders_per_s: { source: 'browser', unit: 'per_s', worse: 'none', regression: false, floor: 0, description: 'Cesium scene renders per second (requestRenderMode)' },
  api_health_rtt_ms: { source: 'backend', unit: 'ms', worse: 'higher', regression: true, floor: 25, description: 'GET /api/health round trip (median of the window)' },
  api_state_rtt_ms: { source: 'backend', unit: 'ms', worse: 'higher', regression: true, floor: 25, description: 'GET /api/control/state round trip (median of the window)' },
  api_failures: { source: 'backend', unit: 'count', worse: 'higher', regression: false, floor: 0, description: 'non-outage API failures in the window' },
  socket_disconnects: { source: 'backend', unit: 'count', worse: 'higher', regression: false, floor: 0, description: 'browser WebSocket closes in the window' },
  ws_msgs_per_s: { source: 'backend', unit: 'per_s', worse: 'none', regression: false, floor: 0, description: 'WebSocket messages received by the browser per second' },
  sim_tick_rate: { source: 'simulator', unit: 'per_s', worse: 'lower', regression: false, floor: 0.2, description: 'simulator ticks per second (ground truth)' },
  telemetry_age_ms: { source: 'product', unit: 'ms', worse: 'higher', regression: true, floor: 250, description: 'age of the telemetry the operator sees (clock-offset corrected, max of window)' },
  fleet_convergence_ms: { source: 'product', unit: 'ms', worse: 'higher', regression: false, floor: 250, description: 'fleet change acknowledged by the API -> every device row rendered' },
  video_live_ms: { source: 'product', unit: 'ms', worse: 'higher', regression: false, floor: 500, description: 'video start request -> tile shows live with decoded frames' },
  map_ack_ms: { source: 'product', unit: 'ms', worse: 'higher', regression: false, floor: 50, description: '2D/3D click -> pressed state rendered' },
  map_settle_ms: { source: 'product', unit: 'ms', worse: 'higher', regression: false, floor: 200, description: '2D/3D click -> camera at the target pitch and at rest (includes the 0.8 s flight)' },
};

// ------------------------------------------------------------------------------------ statistics

const finite = (xs: Array<number | null | undefined>): number[] => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));

/** Linear-interpolation percentile (type 7, same as numpy default). p in [0, 100]. */
export function percentile(values: Array<number | null | undefined>, p: number): number | null {
  const xs = finite(values).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0];
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return xs[lo] + (xs[hi] - xs[lo]) * (rank - lo);
}

export const median = (values: Array<number | null | undefined>) => percentile(values, 50);

export function mean(values: Array<number | null | undefined>): number | null {
  const xs = finite(values);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function stats(values: Array<number | null | undefined>): MetricStats | null {
  const xs = finite(values);
  if (xs.length === 0) return null;
  const q1 = percentile(xs, 25)!;
  const q3 = percentile(xs, 75)!;
  return {
    n: xs.length,
    median: percentile(xs, 50)!,
    mean: mean(xs)!,
    min: Math.min(...xs),
    max: Math.max(...xs),
    p5: percentile(xs, 5)!,
    p95: percentile(xs, 95)!,
    q1,
    q3,
    iqr: q3 - q1,
  };
}

/**
 * Tukey-style limits from a baseline distribution, anchored at P95 (P5 when lower is worse):
 *   normal     = P95 + max(normalK * IQR, floor)
 *   regression = P95 + max(regressionK * IQR, floor * regressionK / normalK)
 * The floor keeps a zero-IQR baseline (e.g. 0 long tasks in every window) from flagging one sample of noise.
 */
export function tukeyLimits(s: MetricStats, worse: 'higher' | 'lower', normalK: number, regressionK: number, floor: number): { normal: number; regression: number } {
  const nMargin = Math.max(normalK * s.iqr, floor);
  const rMargin = Math.max(regressionK * s.iqr, (floor * regressionK) / normalK);
  // Lower-is-worse metrics (FPS, rates) cannot go below 0.
  return worse === 'higher' ? { normal: s.p95 + nMargin, regression: s.p95 + rMargin } : { normal: Math.max(0, s.p5 - nMargin), regression: Math.max(0, s.p5 - rMargin) };
}

/** Theil-Sen slope (median of pairwise slopes): robust to a single GC dip/spike. Units: y per x. */
export function theilSen(points: Array<{ x: number; y: number }>): number | null {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 3) return null;
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (pts[j].x !== pts[i].x) slopes.push((pts[j].y - pts[i].y) / (pts[j].x - pts[i].x));
  return median(slopes);
}

/** Share of consecutive deltas that are positive (1 = monotonically growing). */
export function risingShare(ys: number[]): number | null {
  if (ys.length < 2) return null;
  let up = 0;
  for (let i = 1; i < ys.length; i++) if (ys[i] > ys[i - 1]) up++;
  return up / (ys.length - 1);
}

/**
 * Sustained growth vs noise: growth requires BOTH a robust slope above the limit AND most steps
 * going up. One GC drop or one spike changes neither much, so it is never called a leak.
 */
export function sustainedGrowth(points: Array<{ x: number; y: number }>, slopeLimit: number, minRising = 0.6, unit = 'per x'): { sustained: boolean; slope: number | null; rising: number | null; reason: string } {
  const slope = theilSen(points);
  const rising = risingShare(points.map((p) => p.y));
  if (slope === null || rising === null) return { sustained: false, slope, rising, reason: `insufficient samples (${points.length})` };
  const sustained = slope > slopeLimit && rising >= minRising;
  const s = `slope ${Math.round(slope * 10) / 10} ${unit}`;
  return { sustained, slope, rising, reason: sustained ? `${s} > limit ${slopeLimit} with ${(rising * 100).toFixed(0)}% rising steps` : `${s} (limit ${slopeLimit}), ${(rising * 100).toFixed(0)}% rising steps: no sustained growth` };
}

// ------------------------------------------------------------------------------------ window summary

const round = (x: number | null, d = 1) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

/**
 * Flat, metric-keyed summary of one window. A metric the browser/runtime cannot provide is `null`
 * with a reason in `unavailable` — it is never reported as 0.
 */
export function summarizeWindow(w: Omit<WindowMetrics, 'values' | 'unavailable'>): Pick<WindowMetrics, 'values' | 'unavailable'> {
  const v: WindowMetrics['values'] = {};
  const u: WindowMetrics['unavailable'] = {};
  const b = w.browser;
  const set = (k: keyof typeof v, x: number | null | undefined, why?: string) => {
    v[k] = x === undefined ? null : round(x, 3);
    if (x === null || x === undefined) u[k] = why ?? 'not measured in this window';
  };
  if (b) {
    set('long_task_count', b.long_task_supported ? b.long_tasks : null, 'PerformanceObserver longtask unsupported');
    set('long_task_max_ms', b.long_task_supported ? b.long_task_max_ms : null, 'PerformanceObserver longtask unsupported');
    set('tbt_ms', b.long_task_supported ? b.tbt_ms : null, 'PerformanceObserver longtask unsupported');
    set('tbt_per_s', b.long_task_supported ? b.tbt_ms / Math.max(0.001, b.duration_ms / 1000) : null, 'PerformanceObserver longtask unsupported');
    set('fps_mean', b.fps_mean, 'no animation frames observed');
    set('fps_p10', b.fps_p10, 'window shorter than 2 s');
    set('frames_over_33ms', b.frames_over_33ms);
    set('max_frame_gap_ms', b.max_frame_gap_ms, 'no animation frames observed');
    set('heap_used_bytes', b.heap_used_bytes, 'performance.memory unavailable in this browser');
    set('dom_nodes', b.dom_nodes);
    set('page_errors', b.page_errors);
    set('webgl_context_lost', b.webgl_context_lost);
    set('socket_disconnects', b.ws_closes);
    set('ws_msgs_per_s', b.ws_msgs_per_s);
    set('map_render_ms', b.map.observable ? b.map.render_ms_mean : null, b.map.reason ?? 'no map renders in window');
    set('map_renders_per_s', b.map.observable ? b.map.renders / Math.max(0.001, b.duration_ms / 1000) : null, b.map.reason ?? 'map runtime not observable');
  } else {
    for (const k of ['long_task_count', 'long_task_max_ms', 'tbt_ms', 'fps_mean', 'max_frame_gap_ms', 'dom_nodes'] as const) set(k, null, 'browser window not collected');
  }
  set('main_thread_busy_ratio', w.cdp?.task_busy_ratio ?? null, 'CDP Performance domain unavailable');
  set('script_busy_ratio', w.cdp?.script_busy_ratio ?? null, 'CDP Performance domain unavailable');
  if (v.heap_used_bytes === null && w.cdp?.heap_used_bytes) {
    // Fallback source, labelled: CDP JSHeapUsedSize is the same V8 counter.
    v.heap_used_bytes = w.cdp.heap_used_bytes;
    u.heap_used_bytes = 'performance.memory unavailable; value from CDP JSHeapUsedSize';
  }
  const ok = (e: 'health' | 'state') => w.api.filter((a) => a.endpoint === e && a.ok).map((a) => a.rtt_ms);
  set('api_health_rtt_ms', median(ok('health')), 'no successful /api/health probe in window');
  set('api_state_rtt_ms', median(ok('state')), 'no successful /api/control/state probe in window');
  set('api_failures', w.api.filter((a) => a.failure === 'http').length);
  set('sim_tick_rate', w.simulator.tick_rate_per_s, 'simulator state not sampled');
  const ages = w.telemetry.map((t) => t.age_ms);
  set('telemetry_age_ms', ages.some((a) => a !== null) ? Math.max(...finite(ages)) : null, 'no displayed telemetry frame could be matched');
  const sel = w.interactions.filter((i) => i.kind === 'select-device');
  if (sel.length) {
    set('interaction_latency_ms', median(sel.map((i) => i.latency_ms)), 'no interaction reached its postcondition');
    set('event_timing_ms', median(sel.map((i) => i.event_timing_ms)), 'Event Timing unsupported or no entry');
  }
  const maps = w.interactions.filter((i) => i.kind === 'map-view');
  if (maps.length) {
    set('map_ack_ms', median(maps.map((i) => i.latency_ms)), 'no map interaction reached its postcondition');
    set('map_settle_ms', median(maps.map((i) => i.settle_ms)), 'camera never settled / map not observable');
    if (!sel.length) set('interaction_latency_ms', median(maps.map((i) => i.latency_ms)), 'no map interaction reached its postcondition');
  }
  set('console_errors', w.console_errors);
  set('failed_requests', w.failed_requests);
  return { values: v, unavailable: u };
}
