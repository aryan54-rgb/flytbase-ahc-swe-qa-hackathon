import { buildProfile } from '../performance/baseline.js';
import { evaluateHeapTrend } from '../performance/invariants.js';
import { sustainedGrowth, theilSen, risingShare } from '../performance/metrics.js';
import { perfScenario } from '../performance/scenario.js';
import type { InvariantResult, WindowMetrics, WorkloadStep } from '../performance/types.js';

/**
 * P003: a continuous incident-response session. Two drones fly (their track polylines grow every
 * tick), the rest stay docked. After a warm-up, every 15 s: a 3 s observation window, one map
 * interaction (2D/3D toggle, to its postcondition), a heap reading (performance.memory, plus a
 * post-GC reading through CDP when available), DOM element count, rendered track size, errors.
 *
 * Trends, not points: heap / DOM / latency are judged by Theil-Sen slope AND a majority of rising
 * steps, so a single GC fluctuation is never a leak. The heap contract ("stabilizes after the track
 * history reaches its cap") is judged only on samples after saturation; the track cap is 2000 points
 * per drone at 2 points/s (≈ 1000 s), so a 180 s session cannot reach it and the contract is
 * reported UNAVAILABLE with the projected saturation time — never as passed.
 */

export const p003 = perfScenario({
  id: 'P003',
  title: 'Long-running stability soak',
  user_goal: 'The cockpit remains usable during a continuous incident-response session.',
  axis: 'elapsed_s',
  axisLabel: 't (s)',
  starting: 'Simulator reset + started at 1.0x with the stock 4 drones; 2 of them take off and keep flying; cockpit at / with the performance probe.',
  expected_behavior: [
    'Map interactions stay within the responsiveness contract for the whole session (no upward latency drift).',
    'DOM size stays flat (map growth lives in the canvas, not in the DOM).',
    'Heap growth stops once track history reaches its cap (judged after saturation only).',
    'No unhandled exceptions and no WebGL context loss.',
  ],
  invariant: 'Across the session: interaction ≤ 150 ms nominal (> 300 degraded, > 1000 breach) without sustained drift; DOM slope ≈ 0; post-saturation heap slope ≤ limit; 0 page errors; 0 WebGL context losses.',
  workload: async (s) => {
    const sc = s.cfg.soak;
    const flyers = s.drones.slice(0, sc.flyingDrones);
    for (const d of flyers) await s.ledger.takeoff(d.id);
    await s.stabilize(sc.warmupMs);

    const t0 = Date.now();
    const rows: Array<Record<string, unknown> & { t_s: number; x: number; heap: number | null; dom: number; min_track: number | null; ack: number | null }> = [];
    const early: WindowMetrics[] = [];
    let prev: WindowMetrics | null = null;
    for (let i = 0; i * sc.sampleEveryMs <= sc.durationMs; i++) {
      const wait = t0 + i * sc.sampleEveryMs - Date.now();
      if (!s.fits(Math.max(0, wait) + sc.windowMs + 8_000)) {
        s.truncated = `soak stopped after ${rows.length} samples: time budget`;
        break;
      }
      if (wait > 0) await s.stabilize(wait);
      const t_s = Math.round((Date.now() - t0) / 1000);
      const wl = s.workload(t_s, i < 3 ? 'warmup' : 'soak');
      const w = await s.observe(wl, sc.windowMs);
      w.interactions.push(await s.toggleMap(wl));
      const heap = await s.probe.heap(true);
      const dom = await s.probe.domNodes();
      const map = await s.probe.mapInfo();
      s.finalize(w);
      const tracks = Object.entries(map.tracks).filter(([id]) => s.drones.some((d) => d.id === id));
      const heapValue = heap.post_gc_bytes ?? heap.performance_memory_bytes;
      rows.push({
        t_s,
        x: t_s / 60,
        heap: heapValue,
        heap_source: heap.post_gc_bytes !== null ? 'cdp-post-gc' : heap.source,
        heap_performance_memory: heap.performance_memory_bytes,
        dom,
        track_points: map.track_points,
        min_track: tracks.length ? Math.min(...tracks.map(([, n]) => n)) : null,
        max_track: tracks.length ? Math.max(...tracks.map(([, n]) => n)) : null,
        entities: map.entities,
        ack: w.interactions[0]?.latency_ms ?? null,
        settle: w.interactions[0]?.settle_ms ?? null,
        page_errors: w.browser?.page_errors ?? null,
        webgl_context_lost: w.browser?.webgl_context_lost ?? null,
        long_task_max_ms: w.values.long_task_max_ms ?? null,
        fps_mean: w.values.fps_mean ?? null,
      });
      s.samples.push({ metric: 'heap_used_bytes', source: 'browser', value: heapValue, unit: 'bytes', t_wall: new Date().toISOString(), t_rel_ms: s.evidence.now(), workload: wl, window_id: w.id, detail: { ...heap, dom_nodes: dom, track_points: map.track_points }, ...(heapValue === null ? { unavailable_reason: 'neither performance.memory nor CDP heap usage available' } : {}) });
      // Early-session profile (first 3 samples) = in-run baseline for later drift.
      if (i < 3) early.push(w);
      if (i === 2) {
        s.baseline = buildProfile(early, {
          normalK: s.cfg.tukey.normalK,
          regressionK: s.cfg.tukey.regressionK,
          consecutiveWindows: s.cfg.tukey.consecutiveWindows,
          minSamples: s.cfg.baseline.minSamples,
          workload: { drones: s.drones.length, sim_speed: s.speed, faults: 0 },
          windowMs: sc.windowMs,
          clockOffsetMs: null,
        });
        s.fixClockOffset();
      }
      s.recordStep(t_s, wl.phase, w, prev);
      prev = w;
    }

    // ---- trends
    const cap = sc.trackCapPerDevice;
    const saturated = rows.find((r) => r.min_track !== null && r.min_track >= cap);
    const trackRate = theilSen(rows.filter((r) => r.min_track !== null).map((r) => ({ x: r.t_s, y: r.min_track! })));
    const last = rows[rows.length - 1];
    const projected = !saturated && trackRate && trackRate > 0 && last?.min_track !== null && last ? Math.round(last.t_s + (cap - (last.min_track as number)) / trackRate) : null;
    const heapPts = rows.filter((r) => r.heap !== null).map((r) => ({ x: r.x, y: r.heap! }));
    const heapInv = evaluateHeapTrend(heapPts, saturated ? saturated.x : null, sc.heapSlopeLimitBytesPerMin);
    if (!heapPts.length) heapInv.reason = 'heap unavailable in this browser/runtime (no performance.memory, no CDP)';
    const domTrend = sustainedGrowth(rows.map((r) => ({ x: r.x, y: r.dom })), sc.domSlopeLimitPerMin, 0.6, 'elements/min');
    const ackPts = rows.filter((r) => r.ack !== null).map((r) => ({ x: r.x, y: r.ack! }));
    const ackSlope = theilSen(ackPts);
    const ackRising = risingShare(ackPts.map((p) => p.y));
    const latencyDrift = ackSlope !== null && ackSlope > sc.latencyDriftLimitMsPerMin && (ackRising ?? 0) >= 0.6;
    const errors = rows.reduce((a, r) => a + ((r.page_errors as number | null) ?? 0), 0);

    const reasons: string[] = [];
    if (heapInv.category === 'DEGRADED') reasons.push(`memory.heap_stabilizes DEGRADED: ${heapInv.reason}`);
    if (domTrend.sustained) reasons.push(`DOM grows: ${domTrend.reason}`);
    if (latencyDrift) reasons.push(`interaction latency drifts up ${ackSlope?.toFixed(0)} ms/min (limit ${sc.latencyDriftLimitMsPerMin})`);
    const trendInvariants: InvariantResult[] = [
      heapInv,
      { id: 'stability.dom_flat', group: 'stability', metric: 'dom_nodes', category: domTrend.slope === null ? 'UNAVAILABLE' : domTrend.sustained ? 'DEGRADED' : 'NOMINAL', observed: domTrend.slope, thresholds: { nominal: sc.domSlopeLimitPerMin, degraded: sc.domSlopeLimitPerMin, breach: Number.POSITIVE_INFINITY, worse: 'higher' }, reason: domTrend.reason },
      { id: 'responsiveness.no_drift', group: 'responsiveness', metric: 'map_ack_ms', category: ackSlope === null ? 'UNAVAILABLE' : latencyDrift ? 'DEGRADED' : 'NOMINAL', observed: ackSlope, thresholds: { nominal: sc.latencyDriftLimitMsPerMin, degraded: sc.latencyDriftLimitMsPerMin, breach: Number.POSITIVE_INFINITY, worse: 'higher' }, reason: `Theil-Sen ${ackSlope?.toFixed(1) ?? 'n/a'} ms/min, ${ackRising === null ? 'n/a' : Math.round(ackRising * 100)}% rising steps` },
    ];
    const trendStep: WorkloadStep = {
      index: s.steps.length + 1,
      level: last?.t_s ?? 0,
      phase: 'trend',
      started_at: new Date().toISOString(),
      windows: [],
      invariants: trendInvariants,
      baseline: [],
      verdict: reasons.length ? 'DEGRADED' : rows.length >= 3 ? 'HEALTHY' : 'INCONCLUSIVE',
      isolated_outliers: [],
      preexisting: [],
      reasons: reasons.length ? reasons : [`session trends: ${heapInv.category === 'UNAVAILABLE' ? `heap contract not measurable (${heapInv.reason}${projected ? `; projected track saturation at ~${projected} s` : ''})` : `heap ${heapInv.category}`}, DOM ${trendInvariants[1].category}, latency drift ${trendInvariants[2].category}`],
      pass: reasons.length === 0,
    };
    s.steps.push(trendStep);
    if (domTrend.sustained) s.ctx.check.warn({ id: 'perf.dom_growth', target: 'page', type: 'leak' }, false, { expected: 'flat DOM size', actual: domTrend, state: 'growing' });
    if (heapInv.category === 'DEGRADED') s.ctx.check.warn({ id: 'perf.heap_growth_after_saturation', target: 'page', type: 'leak' }, false, { expected: 'heap stabilizes after track cap', actual: heapInv.detail, state: 'growing' });

    s.extra = {
      flying: flyers.map((d) => d.id),
      samples: rows.map(({ x: _x, ...r }) => r),
      track_saturation: { cap_per_drone: cap, reached: !!saturated, at_s: saturated?.t_s ?? null, min_track_rate_per_s: trackRate === null ? null : Math.round(trackRate * 100) / 100, projected_saturation_s: projected },
      heap_trend: { contract: heapInv.category, reason: heapInv.reason, ...heapInv.detail },
      dom_trend: domTrend,
      latency_trend: { slope_ms_per_min: ackSlope, rising_share: ackRising, drift: latencyDrift },
      page_errors: errors,
    };
  },
});
