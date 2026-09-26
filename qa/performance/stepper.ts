import type { Page } from 'playwright';
import { Blocked } from '../assertions/checks.js';
import { pollUntil, sleep } from '../assertions/polling.js';
import type { EvidenceRecorder } from '../runner/evidence.js';
import { mapView, selectDevice } from '../scenarios/actions.js';
import type { StepContext } from '../scenarios/types.js';
import type { DeviceInfo } from '../utils/api.js';
import { DEVICE_ROW_PREFIX, EL, TID } from '../utils/selectors.js';
import { buildProfile, compareToBaseline } from './baseline.js';
import type { PerfConfig } from './config.js';
import { evaluateInvariants as evaluateContracts, judgeStep, needsConfirmation, preexistingViolations } from './invariants.js';
import { METRICS, summarizeWindow } from './metrics.js';
import { BrowserProbe, PageUnresponsive, type InteractionOutcome } from './probe.js';
import { Deadline, SafetyMonitor, SevereAbort, WorkloadLedger } from './safety.js';
import type {
  ApiProbe,
  InteractionMeasurement,
  InvariantCategory,
  InvariantResult,
  KneeResult,
  MetricKey,
  PerformanceBaselineProfile,
  PerformanceInvariant,
  PerformanceSample,
  StepVerdict,
  TelemetryProbe,
  WindowMetrics,
  WorkloadAxis,
  WorkloadContext,
  WorkloadStep,
} from './types.js';

// ==================================================================================== adaptive ramp

export interface LevelOutcome {
  pass: boolean;
  verdict: StepVerdict;
}

/**
 * Step-and-bracket search for the degradation knee on a monotone workload axis.
 *
 *   ramp:    evaluate levels in order while they pass
 *   bracket: first failing level F after last passing level P  ->  [P, F]
 *   refine:  binary search inside [P, F] until F - P <= resolution (±1 drone)
 *
 * `canContinue(estimateMs)` lets the caller stop gracefully before a hard timeout; the result then
 * says the boundary is not established instead of guessing. INCONCLUSIVE levels stop the search.
 * Pure orchestration: `evaluate` is injected, so this is unit-tested with synthetic oracles.
 */
export async function bracketKnee(levels: number[], resolution: number, evaluate: (level: number, phase: 'ramp' | 'refine') => Promise<LevelOutcome>, canContinue: () => boolean = () => true): Promise<KneeResult> {
  const tested: KneeResult['tested'] = [];
  let lastPass: number | null = null;
  const run = async (level: number, phase: 'ramp' | 'refine') => {
    let r: LevelOutcome;
    try {
      r = await evaluate(level, phase);
    } catch (e) {
      // Severe abort while evaluating `level` (e.g. page freeze): the level failed; nothing is refined.
      tested.push({ level, verdict: 'HARD_INVARIANT_BREACH', pass: false });
      const lo = tested.filter((t) => t.pass && t.level < level).map((t) => t.level);
      const safe = lo.length ? Math.max(...lo) : null;
      (e as { knee?: KneeResult }).knee = finish({ safe_capacity: safe, degradation_onset: level, bracket: safe === null ? null : [safe, level], established: safe !== null && level - safe <= resolution, reason: `aborted during level ${level} (${(e as Error).message}); bracket not refined` });
      throw e;
    }
    tested.push({ level, verdict: r.verdict, pass: r.pass });
    return r;
  };
  const finish = (k: Omit<KneeResult, 'tested' | 'non_monotonic' | 'resolution'>): KneeResult => {
    // Non-monotonic evidence: a level that passed above a level that failed.
    const fails = tested.filter((t) => !t.pass).map((t) => t.level);
    const lowestFail = fails.length ? Math.min(...fails) : Infinity;
    const nonMono = tested.filter((t) => t.pass && t.level > lowestFail).map((t) => ({ level: t.level, verdict: t.verdict }));
    return { ...k, resolution, tested, non_monotonic: nonMono };
  };

  let firstFail: number | null = null;
  for (const level of levels) {
    if (!canContinue()) return finish({ safe_capacity: lastPass, degradation_onset: null, bracket: null, established: false, reason: `truncated by the time budget before level ${level}; no degradation up to ${lastPass ?? 'none'}` });
    const r = await run(level, 'ramp');
    if (r.verdict === 'INCONCLUSIVE') return finish({ safe_capacity: lastPass, degradation_onset: null, bracket: null, established: false, reason: `level ${level} inconclusive (metrics unavailable); search stopped` });
    if (r.pass) lastPass = level;
    else {
      firstFail = level;
      break;
    }
  }
  if (firstFail === null) return finish({ safe_capacity: lastPass, degradation_onset: null, bracket: null, established: false, reason: `no degradation up to the maximum tested level ${lastPass}` });
  if (lastPass === null) return finish({ safe_capacity: null, degradation_onset: firstFail, bracket: null, established: false, reason: `the first level (${firstFail}) already fails: boundary is at or below the lowest tested workload` });

  let lo = lastPass;
  let hi = firstFail;
  while (hi - lo > resolution) {
    if (!canContinue()) return finish({ safe_capacity: lo, degradation_onset: hi, bracket: [lo, hi], established: false, reason: `bracket [${lo}, ${hi}] not refined further: time budget` });
    const mid = Math.floor((lo + hi) / 2);
    const r = await run(mid, 'refine');
    if (r.verdict === 'INCONCLUSIVE') return finish({ safe_capacity: lo, degradation_onset: hi, bracket: [lo, hi], established: false, reason: `refinement level ${mid} inconclusive` });
    if (r.pass) lo = mid;
    else hi = mid;
  }
  return finish({ safe_capacity: lo, degradation_onset: hi, bracket: [lo, hi], established: true, reason: `boundary refined to [${lo}, ${hi}] (resolution ${resolution})` });
}

// ==================================================================================== session

type ApiReading = ApiProbe & { body?: unknown };

/**
 * Per-scenario performance session: owns the probe, the safety ledger/monitor, all windows, samples
 * and steps. Scenario steps call `bind(ctx)` first (the Checks object is per step).
 */
export class PerfSession {
  readonly samples: PerformanceSample[] = [];
  readonly steps: WorkloadStep[] = [];
  readonly windows: WindowMetrics[] = [];
  readonly interactions: InteractionMeasurement[] = [];
  readonly notes: string[] = [];
  readonly probe: BrowserProbe;
  readonly monitor: SafetyMonitor;
  ledger!: WorkloadLedger;
  deadline: Deadline | null = null;
  baseline: PerformanceBaselineProfile | null = null;
  baselineResults: InvariantResult[][] = [];
  preexisting = new Map<string, InvariantCategory>();
  names: Record<string, string> = {};
  drones: DeviceInfo[] = [];
  /** Observed spread of (browser arrival - simulator timestamp): a clock-sync diagnostic, not a latency. */
  clockOffsetMs: number | null = null;
  private transit: { min: number; max: number } | null = null;
  private winSeq = 0;
  ctx!: StepContext;
  aborted: string | null = null;
  truncated: string | null = null;
  degradationShot: { level: number; reason: string } | null = null;
  mapMode: '2d' | '3d' = '3d';
  /** Workload level currently applied / being evaluated (for abort reports). */
  currentLevel: number | null = null;
  speed = 1;
  /** Set by the hard timeout / cleanup: every long operation stops at its next check. */
  cancelled = false;

  constructor(
    readonly scenarioId: string,
    readonly axis: WorkloadAxis,
    readonly cfg: PerfConfig,
    readonly invariants: PerformanceInvariant[],
    page: Page,
    readonly evidence: EvidenceRecorder,
  ) {
    this.probe = new BrowserProbe(page, cfg.safety.freezeAbortMs);
    this.monitor = new SafetyMonitor(cfg.safety);
    page.on('crash', () => {
      this.monitor.crashed = true;
      evidence.log({ kind: 'console', level: 'harness', text: 'renderer crashed' });
    });
  }

  assertActive(): void {
    if (this.cancelled) throw new SevereAbort('timeout', 'workload cancelled (hard timeout / cleanup started)');
  }

  /** Budget check for the next unit of work. */
  fits(ms: number): boolean {
    return !this.cancelled && (this.deadline?.fits(ms) ?? true);
  }

  bind(ctx: StepContext): this {
    this.ctx = ctx;
    return this;
  }

  get page(): Page {
    return this.probe.page;
  }

  workload(level: number, phase: WorkloadContext['phase']): WorkloadContext {
    this.currentLevel = level;
    return { scenario_id: this.scenarioId, axis: this.axis, level, drones: this.drones.length, sim_speed: this.speed, scenario_video_streams: this.ledger?.startedVideo.size ?? 0, phase };
  }

  async refreshFleet(): Promise<DeviceInfo[]> {
    this.drones = await this.ctx.api.drones();
    this.names = Object.fromEntries(this.drones.map((d) => [d.id, d.name]));
    return this.drones;
  }

  // ---------------------------------------------------------------------------- API probes

  private async apiProbe(endpoint: 'health' | 'state'): Promise<ApiReading> {
    const path = endpoint === 'health' ? '/api/health' : '/api/control/state';
    const t0 = performance.now();
    const t_rel_ms = this.evidence.now();
    try {
      const r = await this.ctx.api.request('GET', path);
      const rtt_ms = Math.round((performance.now() - t0) * 10) / 10;
      const out: ApiReading = r.ok ? { t_rel_ms, endpoint, ok: true, status: r.status, rtt_ms, failure: 'none', body: r.body } : { t_rel_ms, endpoint, ok: false, status: r.status, rtt_ms, failure: 'http', error: `HTTP ${r.status}` };
      this.monitor.noteApi(out.failure, `${path} ${r.status}`);
      if (endpoint === 'health' && r.ok) this.monitor.noteSimulator(r.body as { simulator?: string });
      return out;
    } catch (e) {
      if (e instanceof SevereAbort) throw e;
      const outage = e instanceof Blocked;
      const out: ApiReading = { t_rel_ms, endpoint, ok: false, status: null, rtt_ms: Math.round(performance.now() - t0), failure: outage ? 'outage' : 'http', error: (e as Error).message };
      this.monitor.noteApi(out.failure, (e as Error).message);
      return out;
    }
  }

  // ---------------------------------------------------------------------------- stabilize / observe

  /** Let the workload settle. Safety is still watched (simulator connected, no crash). */
  async stabilize(ms = this.cfg.timing.stabilizeMs): Promise<void> {
    const end = Date.now() + ms;
    this.assertActive();
    await this.apiProbe('health');
    while (Date.now() < end) {
      this.assertActive();
      this.monitor.checkCrash();
      await sleep(Math.min(500, Math.max(0, end - Date.now())));
    }
  }

  /**
   * One observation window: browser probe window + backend RTT, simulator ticks and displayed-telemetry
   * freshness sampled every `sampleEveryMs`. `during` runs concurrently (operator stress phases).
   */
  async observe(workload: WorkloadContext, durationMs = this.cfg.timing.observeMs, during?: (w: WindowMetrics) => Promise<void>): Promise<WindowMetrics> {
    this.assertActive();
    this.monitor.checkCrash();
    const id = `${this.scenarioId}-w${String(++this.winSeq).padStart(3, '0')}`;
    const stateStart = await this.apiProbe('state');
    const started_at = new Date().toISOString();
    await this.probe.beginWindow();
    const t_start_ms = this.evidence.now();
    const w: WindowMetrics = {
      id, workload, started_at, t_start_ms, t_end_ms: t_start_ms, browser: null, cdp: null, api: [stateStart], telemetry: [],
      simulator: { tick_start: tick(stateStart), tick_end: null, tick_rate_per_s: null, speed: null, running: null, drones: null },
      interactions: [], console_errors: 0, failed_requests: 0, values: {}, unavailable: {},
    };
    const stopAt = Date.now() + durationMs;
    const sampler = (async () => {
      while (Date.now() < stopAt && !this.cancelled) {
        const t = Date.now();
        const [h, s, tel] = await Promise.all([this.apiProbe('health'), this.apiProbe('state'), this.telemetry()]);
        w.api.push(strip(h), strip(s));
        if (tel) w.telemetry.push(tel);
        await sleep(Math.max(0, Math.min(this.cfg.timing.sampleEveryMs - (Date.now() - t), stopAt - Date.now())));
      }
    })();
    const act = during ? during(w) : sleep(durationMs);
    await Promise.all([sampler, act]);
    const { browser, cdp } = await this.probe.endWindow();
    w.browser = browser;
    w.cdp = cdp;
    w.t_end_ms = this.evidence.now();
    const stateEnd = await this.apiProbe('state');
    w.api.push(strip(stateEnd));
    w.api[0] = strip(w.api[0] as ApiReading);
    const body = stateEnd.body as { tick?: number; speed?: number; running?: boolean; drones?: Record<string, unknown> } | undefined;
    w.simulator = {
      tick_start: w.simulator.tick_start,
      tick_end: body?.tick ?? null,
      tick_rate_per_s: w.simulator.tick_start !== null && body?.tick !== undefined ? Math.round(((body.tick - w.simulator.tick_start) / Math.max(0.001, (w.t_end_ms - w.t_start_ms) / 1000)) * 100) / 100 : null,
      speed: body?.speed ?? null,
      running: body?.running ?? null,
      drones: body?.drones ? Object.keys(body.drones).length : null,
    };
    const inWindow = this.evidence.console.filter((e) => e.t >= w.t_start_ms && e.t <= w.t_end_ms);
    w.console_errors = inWindow.filter((e) => e.kind === 'console' && e.level === 'error').length;
    w.failed_requests = inWindow.filter((e) => e.kind === 'requestfailed').length;
    this.monitor.noteFrameGap(browser.max_frame_gap_ms);
    this.monitor.checkCrash();
    this.windows.push(w);
    return w;
  }

  /** Displayed-telemetry sample; never throws for data reasons (a frozen page still aborts). */
  async telemetry(): Promise<TelemetryProbe | null> {
    if (!this.drones.length) return null;
    const r = await this.probe.telemetry(this.evidence.now(), this.names);
    if (r.transit_raw_ms) this.transit = this.transit ? { min: Math.min(this.transit.min, r.transit_raw_ms.min), max: Math.max(this.transit.max, r.transit_raw_ms.max) } : r.transit_raw_ms;
    const { transit_raw_ms: _t, header: _h, ...rest } = r;
    return rest;
  }

  /**
   * Recompute derived values (clock-corrected ages, summaries) and emit samples for a window.
   * Values a scenario already put in `w.values` (e.g. fleet convergence) are kept.
   */
  finalize(w: WindowMetrics, extra: Partial<Record<MetricKey, number | null>> = {}): WindowMetrics {
    const preset = w.values;
    const { values, unavailable } = summarizeWindow(w);
    w.values = { ...values, ...preset, ...extra };
    w.unavailable = unavailable;
    for (const [k, v] of Object.entries(extra)) if (v === null) w.unavailable[k as MetricKey] = 'not measured';
    const t_wall = new Date().toISOString();
    for (const [k, v] of Object.entries(w.values) as Array<[MetricKey, number | null]>) {
      const spec = METRICS[k];
      this.samples.push({ metric: k, source: spec.source, value: v, unit: spec.unit, t_wall, t_rel_ms: w.t_end_ms, workload: w.workload, window_id: w.id, ...(v === null ? { unavailable_reason: w.unavailable[k] } : {}) });
    }
    return w;
  }

  /**
   * Clock diagnostic from the baseline phase. Telemetry freshness is measured on the browser clock
   * only; payload timestamps come from the simulator container's clock, which may drift.
   */
  fixClockOffset(): void {
    if (!this.transit) return;
    this.clockOffsetMs = this.transit.min;
    const spread = this.transit.max - this.transit.min;
    if (spread > 250 || Math.abs(this.transit.min) > 250)
      this.notes.push(`simulator payload timestamps vs browser clock: arrival - timestamp ranged ${this.transit.min}..${this.transit.max} ms during the baseline (clock skew/drift between the simulator container and the host). Cross-clock ages are kept as age_raw_ms for diagnosis only; telemetry freshness uses the browser clock (time since the displayed frame arrived).`);
  }

  // ---------------------------------------------------------------------------- interactions

  /**
   * Operator selects a drone row (semantic action, healing-aware). Latency = click event -> first
   * frame where the row is selected AND the telemetry header names the drone. A click that lands
   * but never produces the postcondition fails `perf.interaction_postcondition`.
   */
  async selectDevice(d: DeviceInfo, workload: WorkloadContext, intervalMs: number = this.cfg.safety.minInteractionIntervalMs): Promise<InteractionMeasurement> {
    this.assertActive();
    await this.ledger.pace(intervalMs);
    const css = `[data-testid="${DEVICE_ROW_PREFIX}${d.id}"]`;
    await this.probe.arm({ kind: 'select', clickCss: css, rowCss: css, name: d.name, headerCss: EL.telemetryHeader.css, headerExcludeCss: EL.flightStatus.css, timeoutMs: this.cfg.timing.interactionTimeoutMs });
    return this.perform(selectDevice(d), 'select-device', d.id, workload, (v) => ({ expected: `${d.name} selected and named in the telemetry header`, actual: v, state: v?.clicked ? 'no-postcondition' : 'click-not-received' }));
  }

  /** Operator toggles the map to the other view; ack = pressed state rendered, settle = camera at rest at the target pitch. */
  async toggleMap(workload: WorkloadContext, intervalMs: number = this.cfg.safety.minInteractionIntervalMs): Promise<InteractionMeasurement> {
    this.assertActive();
    await this.ledger.pace(intervalMs);
    const mode = this.mapMode === '3d' ? '2d' : '3d';
    const css = `[data-testid="${mode === '2d' ? TID.mapView2d : TID.mapView3d}"]`;
    await this.probe.arm({ kind: 'map', clickCss: css, pressedCss: css, pitchDeg: mode === '2d' ? -90 : -45, tilt: mode === '3d', timeoutMs: this.cfg.timing.interactionTimeoutMs });
    const m = await this.perform(mapView(mode), 'map-view', mode, workload, (v) => ({ expected: `${mode.toUpperCase()} pressed and camera at rest at the target pitch`, actual: v, state: v?.clicked ? (v.latency_ms === null ? 'not-pressed' : 'camera-not-settled') : 'click-not-received' }));
    if (m.stage === 'POSTCONDITION_SATISFIED') this.mapMode = mode;
    return m;
  }

  private async perform(action: ReturnType<typeof selectDevice>, kind: InteractionMeasurement['kind'], target: string, workload: WorkloadContext, describe: (v: InteractionOutcome | undefined) => { expected?: unknown; actual?: unknown; state?: string }): Promise<InteractionMeasurement> {
    const t_rel_ms = this.evidence.now();
    const t0 = Date.now();
    let last: InteractionOutcome | undefined;
    const r = await this.ctx.healing.perform(this.ctx.check, action, {
      spec: { id: 'perf.interaction_postcondition', target: action.target, type: 'timeout' },
      observe: async () => (last = await this.probe.interaction()),
      satisfied: (v) => v.satisfied,
      describe,
      timeoutMs: this.cfg.timing.interactionTimeoutMs + 1_500,
    });
    const stage = r.stage === 'ACTION_EXECUTED' ? 'POSTCONDITION_FAILED' : r.stage;
    const m: InteractionMeasurement = {
      kind,
      target,
      t_rel_ms,
      workload,
      stage,
      latency_ms: stage === 'POSTCONDITION_SATISFIED' ? round1(last?.latency_ms ?? null) : null,
      event_timing_ms: last?.event_timing_ms ?? null,
      settle_ms: round1(last?.settle_ms ?? null),
      harness_wall_ms: Date.now() - t0,
      detail: { in_page: last, healing_outcome: r.record.outcome },
    };
    this.interactions.push(m);
    this.samples.push({ metric: kind === 'map-view' ? 'map_ack_ms' : 'interaction_latency_ms', source: 'browser', value: m.latency_ms, unit: 'ms', t_wall: new Date().toISOString(), t_rel_ms, workload, window_id: null, detail: { target, stage, event_timing_ms: m.event_timing_ms, settle_ms: m.settle_ms, harness_wall_ms: m.harness_wall_ms } });
    return m;
  }

  // ---------------------------------------------------------------------------- fleet

  /** Change the fleet to `total` drones and measure API ack -> all rows rendered (in-page frame time). */
  async applyFleet(total: number): Promise<{ added: string[]; removed: string[]; convergence_ms: number | null; converged: boolean; missing: string[]; extra: string[] }> {
    this.assertActive();
    if (this.axis === 'drones') this.currentLevel = total;
    const change = await this.ledger.setFleet(total);
    const acked = Date.now();
    const drones = await this.refreshFleet();
    const r = await this.probe.waitRows(drones.map((d) => d.id), this.cfg.timing.convergenceGiveUpMs);
    const convergence_ms = r.ok ? Math.max(0, r.at_epoch - acked) : null;
    this.evidence.note(`fleet_${total}`, { added: change.added, removed: change.removed, acked_at: acked, converged: r.ok, convergence_ms, missing: r.missing, extra: r.extra });
    this.ctx.check.that({ id: 'perf.fleet_rows_match', target: 'region:device-list', type: 'mismatch' }, r.ok, {
      expected: `rows for ${drones.length} drones within ${this.cfg.timing.convergenceGiveUpMs} ms`,
      actual: { missing: r.missing, extra: r.extra },
      state: r.missing.length ? 'rows-missing' : 'rows-extra',
      message: `device list did not converge on the fleet of ${total}: missing ${r.missing.join(',') || '-'}, extra ${r.extra.join(',') || '-'}`,
    });
    return { ...change, convergence_ms, converged: r.ok, missing: r.missing, extra: r.extra };
  }

  // ---------------------------------------------------------------------------- evaluation

  evaluateInvariants(w: WindowMetrics): InvariantResult[] {
    return evaluateContracts(w.values, w.unavailable, this.invariants);
  }

  /**
   * K baseline windows at the baseline workload -> profile (median / P95 / IQR per metric), the
   * contracts the baseline already violates, and the clock offset for telemetry ages.
   */
  async collectBaseline(level: number, windows: number, run: (w: WorkloadContext) => Promise<WindowMetrics>): Promise<WorkloadStep> {
    await this.stabilize(this.cfg.baseline.warmupMs);
    const started_at = new Date().toISOString();
    const ws: WindowMetrics[] = [];
    for (let i = 0; i < windows; i++) ws.push(await run(this.workload(level, 'baseline')));
    this.fixClockOffset();
    for (const w of ws) this.finalize(w);
    this.baseline = buildProfile(ws, {
      normalK: this.cfg.tukey.normalK,
      regressionK: this.cfg.tukey.regressionK,
      consecutiveWindows: this.cfg.tukey.consecutiveWindows,
      minSamples: this.cfg.baseline.minSamples,
      workload: { drones: this.drones.length, sim_speed: this.speed, faults: 0 },
      windowMs: this.cfg.timing.observeMs,
      clockOffsetMs: this.clockOffsetMs,
    });
    this.baselineResults = ws.map((w) => this.evaluateInvariants(w));
    this.preexisting = preexistingViolations(this.baselineResults);
    // Absolute judgement of the baseline itself (last two windows), reported, never used as onset.
    const j = judgeStep(this.baselineResults.slice(-2), [], new Map(), this.invariants);
    const step: WorkloadStep = {
      index: this.steps.length + 1, level, phase: 'baseline', started_at, windows: ws, invariants: j.invariants, baseline: [],
      verdict: j.verdict, isolated_outliers: j.isolated_outliers, preexisting: [...this.preexisting.entries()].map(([id, c]) => `${id}: ${c} at baseline`),
      reasons: j.reasons, pass: j.verdict !== 'INCONCLUSIVE',
    };
    if (this.baseline.windows < this.cfg.baseline.minSamples) this.notes.push(`only ${this.baseline.windows} baseline windows (< ${this.cfg.baseline.minSamples}): regression detection disabled`);
    this.steps.push(step);
    return step;
  }

  /**
   * Evaluate one workload level: observe; if the window is not clearly healthy, observe a second
   * consecutive window before judging (isolated outlier vs sustained degradation).
   */
  async evaluateLevel(level: number, phase: WorkloadContext['phase'], run: (w: WorkloadContext) => Promise<WindowMetrics>, extra: Partial<Record<MetricKey, number | null>> = {}): Promise<WorkloadStep> {
    const started_at = new Date().toISOString();
    const first = this.finalize(await run(this.workload(level, phase)), extra);
    const ws = [first];
    const r1 = this.evaluateInvariants(first);
    if (needsConfirmation(r1, compareToBaseline(this.baseline, [first]), this.preexisting) && this.deadline?.fits(this.cfg.timing.observeMs + 5_000) !== false) {
      ws.push(this.finalize(await run(this.workload(level, 'confirm'))));
    }
    const per = ws.map((w) => this.evaluateInvariants(w));
    const comparisons = compareToBaseline(this.baseline, ws);
    const j = judgeStep(per, comparisons, this.preexisting, this.invariants);
    const step: WorkloadStep = {
      index: this.steps.length + 1, level, phase, started_at, windows: ws, invariants: j.invariants, baseline: comparisons, verdict: j.verdict,
      isolated_outliers: j.isolated_outliers, preexisting: [...this.preexisting.keys()], reasons: j.reasons, pass: j.pass,
    };
    this.steps.push(step);
    return step;
  }

  /**
   * Judge already-finalized windows: `current` is the level's window, `previous` (if any) the
   * preceding consecutive window, so a verdict needs both to agree (sustained, not isolated).
   */
  recordStep(level: number, phase: WorkloadContext['phase'], current: WindowMetrics, previous: WindowMetrics | null, extraReasons: string[] = []): WorkloadStep {
    const ws = previous ? [previous, current] : [current];
    const per = ws.map((w) => this.evaluateInvariants(w));
    const comparisons = compareToBaseline(this.baseline, ws);
    const j = judgeStep(per, comparisons, this.preexisting, this.invariants);
    const step: WorkloadStep = {
      index: this.steps.length + 1, level, phase, started_at: current.started_at, windows: [current], invariants: j.invariants, baseline: comparisons, verdict: j.verdict,
      isolated_outliers: j.isolated_outliers, preexisting: [...this.preexisting.keys()], reasons: [...j.reasons, ...extraReasons], pass: j.pass,
    };
    this.steps.push(step);
    return step;
  }
}

const tick = (r: ApiReading) => ((r.body as { tick?: number } | undefined)?.tick ?? null);
const strip = (r: ApiReading): ApiProbe => {
  const { body: _b, ...rest } = r;
  return rest;
};
const round1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

/** Classify a thrown error from the workload phase. */
export function describeAbort(e: unknown): { kind: string; message: string } {
  if (e instanceof SevereAbort) return { kind: e.kind, message: e.message };
  if (e instanceof PageUnresponsive) return { kind: 'page_freeze', message: e.message };
  if (e instanceof Blocked) return { kind: 'blocked', message: e.message };
  return { kind: 'error', message: (e as Error).message };
}

/** Wait for the in-page probe + cockpit rows after navigation. */
export async function waitProbeReady(page: Page, timeoutMs: number): Promise<boolean> {
  const r = await pollUntil(() => page.evaluate(() => !!window.__qaPerf), (v) => v, { timeoutMs, intervalMs: 200 });
  return r.ok;
}
