import { Blocked } from '../assertions/checks.js';
import type { ApiClient } from '../utils/api.js';
import { buildProfile, compareToBaseline } from './baseline.js';
import { SAFETY } from './config.js';
import { categorize, DEFAULT_INVARIANTS, evaluateHeapTrend, evaluateInvariants, judgeStep, preexistingViolations } from './invariants.js';
import { percentile, stats, summarizeWindow, sustainedGrowth, theilSen, tukeyLimits } from './metrics.js';
import { correlateBottlenecks } from './reporting.js';
import { isInfrastructureAbort, SafetyLimitError, SafetyMonitor, SevereAbort, WorkloadLedger } from './safety.js';
import { classifyCleanupFailure, overallVerdict } from './scenario.js';
import { bracketKnee } from './stepper.js';
import type { BrowserWindowMetrics, StepVerdict, WindowMetrics, WorkloadStep } from './types.js';

/**
 * Offline self-tests of the Level-2 logic: no browser, no stack. Synthetic inputs only.
 * Run with `npm run qa -- --perf --self-test` (also included in `npm run qa -- --self-test`).
 */

interface Case {
  name: string;
  ok: boolean;
  detail: string;
}

const approx = (a: number | null, b: number, eps = 1e-6) => a !== null && Math.abs(a - b) <= eps;

const browser = (over: Partial<BrowserWindowMetrics> = {}): BrowserWindowMetrics => ({
  duration_ms: 5000, frames: 300, fps_mean: 60, fps_p10: 58, fps_min_second: 57, frames_over_33ms: 0, max_frame_gap_ms: 20,
  long_task_supported: true, long_tasks: 0, long_task_max_ms: 0, tbt_ms: 0, loaf_supported: false, loaf: null,
  event_timing_supported: true, event_timing_max_ms: 24, memory_supported: true, heap_used_bytes: 50_000_000, dom_nodes: 400,
  ws_messages: 180, ws_msgs_per_s: 36, ws_opens: 0, ws_closes: 0, page_errors: 0, unhandled_rejections: 0, webgl_context_lost: 0,
  socket_badge: 'socket connected', map: { observable: true, renders: 50, render_ms_mean: 8, render_ms_max: 15, track_points: 100, entities: 20 },
  ...over,
});

const wl = { scenario_id: 'selftest', axis: 'drones' as const, level: 4, drones: 4, sim_speed: 1, scenario_video_streams: 0, phase: 'ramp' as const };

function window(values: WindowMetrics['values'], over: Partial<WindowMetrics> = {}): WindowMetrics {
  return { id: 'w', workload: wl, started_at: '', t_start_ms: 0, t_end_ms: 5000, browser: null, cdp: null, api: [], telemetry: [], simulator: { tick_start: 0, tick_end: 10, tick_rate_per_s: 2, speed: 1, running: true, drones: 4 }, interactions: [], console_errors: 0, failed_requests: 0, values, unavailable: {}, ...over };
}

/** A fake control API recording calls; `fail` makes chosen methods throw. */
function fakeApi(fail: Partial<Record<'removeDrone' | 'videoControl' | 'sim', Error>> = {}) {
  let n = 4;
  const drones = new Set(['drone-1', 'drone-2', 'drone-3', 'drone-4']);
  const calls: string[] = [];
  const api = {
    addDrone: async () => {
      const id = `drone-${++n}`;
      drones.add(id);
      calls.push(`add ${id}`);
      return { drone: { id, type: 'drone', name: id }, dock: { id: `dock-${n}`, type: 'dock', name: '' } };
    },
    removeDrone: async (id: string) => {
      calls.push(`remove ${id}`);
      if (fail.removeDrone) throw fail.removeDrone;
      drones.delete(id);
      return { ok: true };
    },
    setSimulationSpeed: async (speed: number) => (calls.push(`speed ${speed}`), { running: true, speed, tick: 0, drones: {} }),
    videoControl: async (action: string, id: string) => {
      calls.push(`video ${action} ${id}`);
      if (fail.videoControl) throw fail.videoControl;
      return { ok: true, devices: [] };
    },
    sim: async (a: string) => {
      calls.push(`sim ${a}`);
      if (fail.sim) throw fail.sim;
      return { running: a !== 'reset', speed: 1, tick: 0, drones: {} };
    },
    drones: async () => [...drones].map((id) => ({ id, type: 'drone', name: id })),
    state: async () => ({ running: true, speed: 1, tick: 5, drones: Object.fromEntries([...drones].map((id) => [id, { id, status: 'standby' }])) }),
    command: async () => ({ status: 200, ok: true, body: { ok: true } }),
  };
  return { api: api as unknown as ApiClient, calls, drones };
}

const step = (level: number, verdict: StepVerdict, phase: WorkloadStep['phase'] = 'ramp'): WorkloadStep => ({ index: 0, level, phase, started_at: '', windows: [], invariants: [], baseline: [], verdict, isolated_outliers: [], preexisting: [], reasons: [`${verdict} at ${level}`], pass: verdict === 'HEALTHY' });

async function throwsKind(fn: () => unknown, check: (e: unknown) => boolean): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return check(e);
  }
}

export async function perfSelfTestCases(): Promise<Case[]> {
  const out: Case[] = [];
  const add = (name: string, ok: boolean, detail: unknown) => out.push({ name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });

  // ---- percentiles / IQR
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const st = stats(xs)!;
  add('stats: median/P95/IQR (type-7 percentiles)', approx(st.median, 4.5) && approx(st.q1, 2.75) && approx(st.q3, 6.25) && approx(st.iqr, 3.5) && approx(st.p95, 7.65), st);
  add('stats: nulls ignored, empty -> null', stats([null, undefined])! === null && approx(percentile([null, 10, 20], 50), 15), 'ok');

  // ---- Tukey limits
  const lim = tukeyLimits(st, 'higher', 1.5, 3, 0);
  add('tukey: normal = P95 + 1.5*IQR, regression = P95 + 3*IQR', approx(lim.normal, 7.65 + 5.25) && approx(lim.regression, 7.65 + 10.5), lim);
  const zero = tukeyLimits(stats([0, 0, 0, 0, 0])!, 'higher', 1.5, 3, 50);
  add('tukey: zero-IQR baseline uses the absolute floor', approx(zero.normal, 50) && approx(zero.regression, 100), zero);
  const low = tukeyLimits(stats([58, 59, 60, 60, 61])!, 'lower', 1.5, 3, 3);
  add('tukey: lower-is-worse metrics are mirrored at P5', low.normal < 58 && low.regression < low.normal, low);

  // ---- metric aggregation + missing performance.memory
  const agg = summarizeWindow({
    ...window({}),
    browser: browser({ memory_supported: false, heap_used_bytes: null }),
    api: [
      { t_rel_ms: 0, endpoint: 'state', ok: true, status: 200, rtt_ms: 10, failure: 'none' },
      { t_rel_ms: 1, endpoint: 'state', ok: true, status: 200, rtt_ms: 30, failure: 'none' },
      { t_rel_ms: 2, endpoint: 'state', ok: false, status: null, rtt_ms: 5, failure: 'outage' },
    ],
    telemetry: [
      { t_rel_ms: 0, device_id: 'drone-1', header_matches_selected: true, matched_selected_device: true, matched_other_device: null, age_raw_ms: 400, age_ms: 350, arrival_age_ms: 100, frames_buffered: 5 },
      { t_rel_ms: 1, device_id: 'drone-1', header_matches_selected: true, matched_selected_device: true, matched_other_device: null, age_raw_ms: 900, age_ms: 850, arrival_age_ms: 100, frames_buffered: 5 },
    ],
    interactions: [80, 120, 400].map((l) => ({ kind: 'select-device' as const, target: 'drone-1', t_rel_ms: 0, workload: wl, stage: 'POSTCONDITION_SATISFIED' as const, latency_ms: l, event_timing_ms: null, settle_ms: null, harness_wall_ms: l + 50 })),
  });
  add('aggregation: API median of successful probes; outage excluded from RTT; not counted as http failure', agg.values.api_state_rtt_ms === 20 && agg.values.api_failures === 0, agg.values);
  add('aggregation: telemetry age = worst (max) sample of the window', agg.values.telemetry_age_ms === 850, agg.values.telemetry_age_ms);
  add('aggregation: interaction latency = median of the window', agg.values.interaction_latency_ms === 120, agg.values.interaction_latency_ms);
  add('missing performance.memory: heap is null (not 0) with a reason', agg.values.heap_used_bytes === null && /performance.memory/.test(agg.unavailable.heap_used_bytes ?? ''), agg.unavailable.heap_used_bytes);
  const noMemProfile = buildProfile([agg, agg, agg].map((v) => ({ values: v.values })), { normalK: 1.5, regressionK: 3, consecutiveWindows: 2, minSamples: 3, workload: { drones: 4, sim_speed: 1, faults: 0 }, windowMs: 5000, clockOffsetMs: 0 });
  add('missing performance.memory: profile lists heap as unavailable, scenario still judged', noMemProfile.unavailable.includes('heap_used_bytes') && judgeStep([evaluateInvariants(agg.values, agg.unavailable)], [], new Map()).verdict !== 'INCONCLUSIVE', noMemProfile.unavailable);

  // ---- invariant categories (the 150-300 ms gap is explicit)
  const inter = DEFAULT_INVARIANTS.find((i) => i.id === 'responsiveness.interaction')!;
  const cats = [100, 150, 200, 300, 301, 1000, 1001].map((v) => categorize(inter, v));
  add('invariant: latency bands NOMINAL <=150 < ELEVATED <=300 < DEGRADED <=1000 < BREACH', JSON.stringify(cats) === JSON.stringify(['NOMINAL', 'NOMINAL', 'ELEVATED', 'ELEVATED', 'DEGRADED', 'DEGRADED', 'BREACH']), cats);
  const fps = DEFAULT_INVARIANTS.find((i) => i.id === 'smoothness.fps')!;
  add('invariant: FPS (lower is worse) 19 -> BREACH, 22 -> DEGRADED, 60 -> NOMINAL', categorize(fps, 19) === 'BREACH' && categorize(fps, 22) === 'DEGRADED' && categorize(fps, 60) === 'NOMINAL', [categorize(fps, 19), categorize(fps, 22), categorize(fps, 60)]);
  const pe = DEFAULT_INVARIANTS.find((i) => i.id === 'stability.page_errors')!;
  add('invariant: zero-tolerance stability (0 -> NOMINAL, 1 -> BREACH)', categorize(pe, 0) === 'NOMINAL' && categorize(pe, 1) === 'BREACH', 'ok');
  add('invariant: unmeasured metric -> UNAVAILABLE (never a pass)', categorize(inter, null) === 'UNAVAILABLE', 'ok');

  // ---- isolated outlier vs sustained degradation
  const good = evaluateInvariants({ interaction_latency_ms: 90, fps_mean: 60, max_frame_gap_ms: 30, long_task_max_ms: 60 }, {});
  const bad = evaluateInvariants({ interaction_latency_ms: 600, fps_mean: 60, max_frame_gap_ms: 30, long_task_max_ms: 60 }, {});
  const iso = judgeStep([bad, good], [], new Map());
  const sus = judgeStep([bad, bad], [], new Map());
  add('judge: one degraded window + healthy confirmation = HEALTHY, isolated outlier recorded', iso.verdict === 'HEALTHY' && iso.isolated_outliers.length === 1, iso);
  add('judge: two consecutive degraded windows = DEGRADED', sus.verdict === 'DEGRADED', sus.reasons);
  const err = evaluateInvariants({ interaction_latency_ms: 90, page_errors: 1 }, {});
  add('judge: one uncaught exception in any window is a breach (not averaged away)', judgeStep([err, good.concat(evaluateInvariants({ page_errors: 0 }, {}))], [], new Map()).verdict === 'HARD_INVARIANT_BREACH', 'ok');
  const pre = preexistingViolations([0, 1, 2].map(() => evaluateInvariants({ fps_mean: 22 }, {})));
  const same = judgeStep([evaluateInvariants({ fps_mean: 22 }, {}), evaluateInvariants({ fps_mean: 23 }, {})], [], pre);
  const worse = judgeStep([evaluateInvariants({ fps_mean: 12 }, {}), evaluateInvariants({ fps_mean: 11 }, {})], [], pre);
  add('judge: contract already violated at baseline counts only when it gets worse', pre.get('smoothness.fps') === 'DEGRADED' && same.verdict === 'HEALTHY' && worse.verdict === 'HARD_INVARIANT_BREACH', { pre: [...pre], same: same.verdict, worse: worse.verdict });

  // ---- baseline outliers: insufficient windows / isolated / sustained regression
  const base5 = [100, 110, 105, 95, 102].map((v) => ({ values: { interaction_latency_ms: v } }));
  const prof = buildProfile(base5, { normalK: 1.5, regressionK: 3, consecutiveWindows: 2, minSamples: 3, workload: { drones: 4, sim_speed: 1, faults: 0 }, windowMs: 5000, clockOffsetMs: 0 });
  const one = compareToBaseline(prof, [{ values: { interaction_latency_ms: 400 } }, { values: { interaction_latency_ms: 104 } }]).find((c) => c.metric === 'interaction_latency_ms')!;
  const two = compareToBaseline(prof, [{ values: { interaction_latency_ms: 400 } }, { values: { interaction_latency_ms: 420 } }]).find((c) => c.metric === 'interaction_latency_ms')!;
  const normal = compareToBaseline(prof, [{ values: { interaction_latency_ms: 108 } }]).find((c) => c.metric === 'interaction_latency_ms')!;
  add('baseline: within P95 + 1.5*IQR (+floor) = NORMAL_VARIANCE', normal.classification === 'NORMAL_VARIANCE', normal);
  add('baseline: one window beyond the regression limit = OUTLIER, not a regression', one.classification === 'OUTLIER', one);
  add('baseline: two consecutive windows beyond the limit = PERFORMANCE_REGRESSION', two.classification === 'PERFORMANCE_REGRESSION', two);
  const thin = buildProfile(base5.slice(0, 2), { normalK: 1.5, regressionK: 3, consecutiveWindows: 2, minSamples: 3, workload: { drones: 4, sim_speed: 1, faults: 0 }, windowMs: 5000, clockOffsetMs: 0 });
  const thinCmp = compareToBaseline(thin, [{ values: { interaction_latency_ms: 900 } }, { values: { interaction_latency_ms: 900 } }]).find((c) => c.metric === 'interaction_latency_ms')!;
  add('baseline: fewer windows than min_samples = INSUFFICIENT_BASELINE, never a regression', thinCmp.classification === 'INSUFFICIENT_BASELINE', thinCmp);

  // ---- trends: GC fluctuation vs sustained growth
  const flatWithGc = [100, 101, 100, 70, 100, 101, 100, 100].map((y, i) => ({ x: i, y }));
  const growing = [100, 110, 118, 131, 140, 149, 161, 170].map((y, i) => ({ x: i, y }));
  const spike = [100, 100, 100, 180, 100, 100, 100, 100].map((y, i) => ({ x: i, y }));
  add('trend: a single GC drop in a flat series is not growth', !sustainedGrowth(flatWithGc, 1).sustained, sustainedGrowth(flatWithGc, 1));
  add('trend: a single spike is not growth', !sustainedGrowth(spike, 1).sustained, sustainedGrowth(spike, 1));
  add('trend: steady growth is sustained (Theil-Sen ~10/step)', sustainedGrowth(growing, 1).sustained && approx(theilSen(growing), 10, 0.6), sustainedGrowth(growing, 1));
  add('heap contract: saturation never reached -> UNAVAILABLE (not a pass)', evaluateHeapTrend(growing, null, 1).category === 'UNAVAILABLE', evaluateHeapTrend(growing, null, 1).reason);
  add('heap contract: flat after saturation -> NOMINAL; growing after saturation -> DEGRADED', evaluateHeapTrend(flatWithGc, 2, 1).category === 'NOMINAL' && evaluateHeapTrend(growing, 2, 1).category === 'DEGRADED', 'ok');

  // ---- step-and-bracket
  const oracle = (knee: number) => async (level: number) => ({ pass: level <= knee, verdict: (level <= knee ? 'HEALTHY' : 'DEGRADED') as StepVerdict });
  const L = [4, 8, 12, 16, 20, 24, 28, 32];
  const k13 = await bracketKnee(L, 1, oracle(13));
  add('bracket: knee 13 -> ramp 4..16, refine 14, 13 -> [13, 14]', k13.established && k13.safe_capacity === 13 && k13.degradation_onset === 14 && JSON.stringify(k13.tested.map((t) => t.level)) === '[4,8,12,16,14,13]', k13.tested.map((t) => t.level));
  const k15 = await bracketKnee(L, 1, oracle(15));
  add('bracket: 12 PASS / 16 FAIL -> test 14 then 15 -> [15, 16]', k15.safe_capacity === 15 && k15.degradation_onset === 16 && JSON.stringify(k15.tested.map((t) => t.level)) === '[4,8,12,16,14,15]', k15.tested.map((t) => t.level));
  const kAll = await bracketKnee(L, 1, oracle(99));
  add('bracket: no degradation up to 32 -> no onset claimed', kAll.degradation_onset === null && kAll.safe_capacity === 32 && !kAll.established, kAll.reason);
  const kBase = await bracketKnee(L, 1, oracle(0));
  add('bracket: first level fails -> no safe capacity claimed', kBase.safe_capacity === null && kBase.degradation_onset === 4 && !kBase.established, kBase.reason);
  let budget = 3;
  const kCut = await bracketKnee(L, 1, oracle(99), () => budget-- > 0);
  add('bracket: time budget -> truncated, boundary not established', !kCut.established && /truncated/.test(kCut.reason) && kCut.tested.length === 3, kCut.reason);
  const kInc = await bracketKnee(L, 1, async (l) => ({ pass: l < 12, verdict: (l < 12 ? 'HEALTHY' : 'INCONCLUSIVE') as StepVerdict }));
  add('bracket: inconclusive level stops the search without a claim', !kInc.established && kInc.degradation_onset === null, kInc.reason);

  // ---- safety halting
  const { api } = fakeApi();
  const lim2 = { ...SAFETY };
  const ledger = new WorkloadLedger(api, lim2, ['drone-1', 'drone-2', 'drone-3', 'drone-4']);
  add('safety: fleet above 32 drones is refused', await throwsKind(() => ledger.setFleet(33), (e) => e instanceof SafetyLimitError), 'ok');
  add('safety: simulation speed above 5x is refused', await throwsKind(() => ledger.setSpeed(6), (e) => e instanceof SafetyLimitError), 'ok');
  for (const id of ['drone-5', 'drone-6', 'drone-7']) await ledger.startVideo(id);
  add('safety: a 4th scenario-started video stream is refused', await throwsKind(() => ledger.startVideo('drone-8'), (e) => e instanceof SafetyLimitError), [...ledger.startedVideo]);
  const t0 = Date.now();
  await ledger.pace(0);
  await ledger.pace(0);
  add('safety: interactions are spaced >= 500 ms even when asked for 0', Date.now() - t0 >= 490, `${Date.now() - t0} ms`);
  const mon = new SafetyMonitor(SAFETY);
  let outageAbort: unknown = null;
  try {
    for (let i = 0; i < 3; i++) mon.noteApi('outage', '502');
  } catch (e) {
    outageAbort = e;
  }
  add('safety: 3 consecutive outages abort as infrastructure (BLOCKED), not a perf result', outageAbort instanceof SevereAbort && isInfrastructureAbort(outageAbort), String(outageAbort));
  const mon2 = new SafetyMonitor(SAFETY);
  const interleaved = await throwsKind(() => ['outage', 'none', 'outage', 'none', 'outage'].forEach((f) => mon2.noteApi(f as 'outage' | 'none', 'probe')), () => true);
  add('safety: non-consecutive outages do not abort', !interleaved, 'ok');
  add('safety: freeze > 5 s aborts as a product-side severe failure', await throwsKind(() => mon2.noteFrameGap(6_000), (e) => e instanceof SevereAbort && e.kind === 'page_freeze' && !isInfrastructureAbort(e)), 'ok');
  add('safety: simulator disconnect aborts as infrastructure', await throwsKind(() => mon2.noteSimulator({ simulator: 'disconnected' }), (e) => isInfrastructureAbort(e)), 'ok');

  // ---- cleanup (and cleanup failure) handling
  const okCase = fakeApi();
  const l1 = new WorkloadLedger(okCase.api, SAFETY, ['drone-1', 'drone-2', 'drone-3', 'drone-4']);
  await l1.setFleet(8);
  await l1.stopVideo('drone-1');
  const rep = await l1.cleanup();
  add('cleanup: removes added drones, restores stopped video, 1x, reset+start, verifies baseline', rep.ok && rep.verified_baseline === true && rep.leftovers.length === 0 && okCase.calls.includes('video start drone-1') && okCase.calls.includes('sim reset'), okCase.calls.slice(-9));
  const harnessCase = fakeApi({ removeDrone: new Error('DELETE /api/control/drones/drone-5 -> 500') });
  const l2 = new WorkloadLedger(harnessCase.api, SAFETY, ['drone-1', 'drone-2', 'drone-3', 'drone-4']);
  await l2.setFleet(5).catch(() => undefined);
  const rep2 = await l2.cleanup();
  const cls2 = classifyCleanupFailure(rep2);
  add('cleanup failure (API error) -> HARNESS_ERROR with leftovers listed, never a perf defect', !rep2.ok && rep2.leftovers.includes('drone drone-5') && cls2?.status === 'HARNESS_ERROR', cls2);
  const outCase = fakeApi({ removeDrone: new Blocked('backend unreachable: DELETE /api/control/drones/drone-5 (fetch failed)') });
  const l3 = new WorkloadLedger(outCase.api, SAFETY, ['drone-1', 'drone-2', 'drone-3', 'drone-4']);
  await l3.setFleet(5).catch(() => undefined);
  const cls3 = classifyCleanupFailure(await l3.cleanup());
  add('cleanup failure (backend unreachable) -> BLOCKED', cls3?.status === 'BLOCKED', cls3);

  // ---- harness errors never become performance defects
  const degradedRun = { steps: [step(4, 'HEALTHY', 'baseline'), step(8, 'DEGRADED')], axis: 'drones' as const, freezeBreach: null, truncated: null };
  add('verdict: harness failure -> HARNESS_ERROR even with degraded measurements', overallVerdict(degradedRun, { blocked: null, harness: 'TypeError in harness' }).verdict === 'HARNESS_ERROR', 'ok');
  add('verdict: outage -> BLOCKED even with degraded measurements', overallVerdict(degradedRun, { blocked: 'backend unreachable', harness: null }).verdict === 'BLOCKED', 'ok');
  add('verdict: worst sustained level wins otherwise', overallVerdict(degradedRun, { blocked: null, harness: null }).verdict === 'DEGRADED', overallVerdict(degradedRun, { blocked: null, harness: null }).reason);
  add('verdict: nothing judged -> INCONCLUSIVE (never HEALTHY)', overallVerdict({ steps: [step(4, 'INCONCLUSIVE')], axis: 'drones', freezeBreach: null, truncated: null }, { blocked: null, harness: null }).verdict === 'INCONCLUSIVE', 'ok');

  // ---- bottleneck correlation wording
  const profile = buildProfile([1, 2, 3, 4, 5].map(() => ({ values: { api_state_rtt_ms: 10, api_health_rtt_ms: 12, tbt_per_s: 0, long_task_max_ms: 60, main_thread_busy_ratio: 0.2, fps_mean: 60, telemetry_age_ms: 300, map_render_ms: 8 } })), { normalK: 1.5, regressionK: 3, consecutiveWindows: 2, minSamples: 3, workload: { drones: 4, sim_speed: 1, faults: 0 }, windowMs: 5000, clockOffsetMs: 0 });
  const backendHot = correlateBottlenecks(profile, [window({ api_state_rtt_ms: 400, api_health_rtt_ms: 380, tbt_per_s: 0, long_task_max_ms: 60, fps_mean: 60 })]);
  const frontHot = correlateBottlenecks(profile, [window({ api_state_rtt_ms: 11, api_health_rtt_ms: 12, tbt_per_s: 360, long_task_max_ms: 420, main_thread_busy_ratio: 0.9, fps_mean: 30 })]);
  add('correlation: high API + normal long tasks -> backend signal', backendHot.some((s) => s.id === 'backend') && !backendHot.some((s) => s.id === 'frontend_main_thread'), backendHot.map((s) => s.id));
  add('correlation: normal API + high long tasks -> frontend main-thread signal', frontHot.some((s) => s.id === 'frontend_main_thread') && !frontHot.some((s) => s.id === 'backend'), frontHot.map((s) => s.id));
  add('correlation: statements say "consistent with", never a root cause', [...backendHot, ...frontHot].every((s) => /consistent with/i.test(s.statement)), 'ok');
  return out;
}

export async function perfSelfTest(): Promise<number> {
  const cases = await perfSelfTestCases();
  for (const c of cases) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}${c.ok ? '' : `  (${c.detail.slice(0, 300)})`}`);
  const failed = cases.filter((c) => !c.ok).length;
  console.log(failed ? `\nperformance self-test FAILED (${failed}/${cases.length})` : `\nperformance self-test passed (${cases.length} cases)`);
  return failed ? 3 : 0;
}
