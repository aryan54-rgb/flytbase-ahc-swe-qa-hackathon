import { Blocked, HardStop } from '../assertions/checks.js';
import { waitForDeviceRows } from '../assertions/cockpit.js';
import { sleep } from '../assertions/polling.js';
import { ALL_EVIDENCE, type Scenario, type StepContext } from '../scenarios/types.js';
import { correlateBottlenecks, annotatedCapture, stepBanner, writePerformanceEvidence } from './reporting.js';
import { perfConfig, type PerfConfig } from './config.js';
import { invariantsFromEnv } from './invariants.js';
import { guarded } from './probe.js';
import { Deadline, isInfrastructureAbort, SafetyLimitError, SevereAbort, WorkloadLedger } from './safety.js';
import { describeAbort, PerfSession } from './stepper.js';
import type { CleanupReport, KneeResult, PerformanceBaselineProfile, PerformanceResult, PerformanceVerdict, StepVerdict, WorkloadAxis, WorkloadStep } from './types.js';

/**
 * A performance scenario is an ordinary Level-1 `Scenario` (same executor, verdict model, evidence,
 * findings) with a fixed step skeleton:
 *
 *   1. open        install the probe BEFORE the cockpit loads, navigate, verify the baseline stack
 *   2. workload    the scenario's controller, under a hard timeout and safety monitor
 *   3. capture     (always) annotated screenshot + dom.html of the state under load
 *   4. cleanup     (always) undo every change on the shared stack, verify return to baseline
 *   5. report      (always) verdict, bottleneck correlation, performance.json + summary.md
 *
 * Executor status vs performance verdict:
 *   - Functional failures under load (wrong rows, wrong-device telemetry, uncaught exceptions, WebGL
 *     context loss, renderer crash, an interaction that never takes effect) are error checks ->
 *     DEFECT_FOUND, exactly like Level-1.
 *   - Capacity results (DEGRADED / HARD_INVARIANT_BREACH at some workload) are the performance
 *     verdict in performance.json plus verdict-neutral warnings; pushing a system until it degrades
 *     is the purpose of the ramp, not a defect by itself.
 *   - Outages -> BLOCKED; harness failures (incl. cleanup failures, budget overrun) -> HARNESS_ERROR.
 */

export interface PerfScenarioDef {
  id: string;
  title: string;
  user_goal: string;
  axis: WorkloadAxis;
  axisLabel: string;
  starting: string;
  expected_behavior: string[];
  invariant: string;
  /** The controller. Runs under the deadline; must check `s.cancelled` between long operations. */
  workload: (s: PerfRun) => Promise<void>;
}

export class PerfRun extends PerfSession {
  knee: KneeResult | null = null;
  extra: Record<string, unknown> = {};
  cleanup: CleanupReport | null = null;
  recordedDrift: PerformanceResult['recorded_baseline_drift'] = null;
  freezeBreach: string | null = null;
  /** Error-severity checks failed during the workload (functional defects under load). */
  defects = false;
  renderer: string | null = null;
  unavailableProbe: Record<string, string> = {};
  workloadDone: Promise<unknown> = Promise.resolve();
  startedAt = new Date().toISOString();
}

/** Results of the perf scenarios run in this process, for the CLI summary. */
export const perfResults = new Map<string, PerformanceResult>();

const VERDICT_RANK: Record<StepVerdict, number> = { HEALTHY: 0, INCONCLUSIVE: 1, DEGRADED: 2, HARD_INVARIANT_BREACH: 3 };

/**
 * Scenario-level performance verdict. A harness failure or an outage is never turned into a
 * performance result: HARNESS_ERROR / BLOCKED win over anything measured.
 */
export function overallVerdict(s: Pick<PerfRun, 'steps' | 'axis' | 'freezeBreach' | 'truncated'>, status: { blocked: string | null; harness: string | null }): { verdict: PerformanceVerdict; reason: string } {
  if (status.harness) return { verdict: 'HARNESS_ERROR', reason: status.harness };
  if (status.blocked) return { verdict: 'BLOCKED', reason: status.blocked };
  if (s.freezeBreach) return { verdict: 'HARD_INVARIANT_BREACH', reason: s.freezeBreach };
  const judged = s.steps.filter((x) => x.verdict !== 'INCONCLUSIVE');
  if (!judged.length) return { verdict: 'INCONCLUSIVE', reason: 'no workload level could be judged' };
  // Ties go to the later (higher-workload) step: it is the more informative one to report.
  const worst = judged.reduce((w, x) => (VERDICT_RANK[x.verdict] >= VERDICT_RANK[w.verdict] ? x : w));
  if (worst.verdict === 'HEALTHY') {
    const tested = [...new Set(s.steps.map((x) => x.level))];
    // Contracts that could not be measured anywhere are named: HEALTHY never implies they held.
    const all = s.steps.flatMap((x) => x.invariants);
    const never = [...new Set(all.map((i) => i.id))].filter((id) => all.filter((i) => i.id === id).every((i) => i.category === 'UNAVAILABLE'));
    const unmeasured = never.map((id) => `${id} (${all.find((i) => i.id === id)?.reason ?? 'not measured'})`);
    return { verdict: 'HEALTHY', reason: `every judged level healthy (${s.axis} ${Math.min(...tested)}–${Math.max(...tested)})${s.truncated ? `; ${s.truncated}` : ''}${unmeasured.length ? `; NOT measurable: ${unmeasured.join('; ')}` : ''}` };
  }
  return { verdict: worst.verdict as PerformanceVerdict, reason: `worst at ${s.axis}=${worst.level} (${worst.phase}): ${worst.reasons.slice(0, 2).join('; ')}` };
}

/** A cleanup that did not complete: BLOCKED when the stack was unreachable, else the harness's failure. Never a perf defect. */
export function classifyCleanupFailure(report: CleanupReport): { status: 'BLOCKED' | 'HARNESS_ERROR'; message: string } | null {
  if (report.ok) return null;
  const message = `cleanup incomplete: ${report.actions.filter((a) => !a.ok).map((a) => `${a.action} (${a.error})`).join('; ')}; leftovers: ${report.leftovers.join(', ') || 'none'}`;
  const outage = report.actions.some((a) => !a.ok && /unreachable|upstream unavailable/.test(a.error ?? ''));
  return { status: outage ? 'BLOCKED' : 'HARNESS_ERROR', message };
}

function onsetStep(s: PerfRun): WorkloadStep | undefined {
  // Only steps with measured windows can be correlated (an aborted level has none).
  const failing = s.steps.filter((x) => x.phase !== 'baseline' && !x.pass && x.verdict !== 'INCONCLUSIVE' && x.windows.length > 0);
  const onset = s.knee?.degradation_onset;
  if (onset !== null && onset !== undefined) return failing.find((x) => x.level === onset) ?? [...failing].sort((a, b) => Math.abs(a.level - onset) - Math.abs(b.level - onset))[0];
  return failing.sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict])[0];
}

async function openCockpit(def: PerfScenarioDef, cfg: PerfConfig, ctx: StepContext): Promise<void> {
  const { api, page, check, memo, evidence, config } = ctx;
  const s = new PerfRun(def.id, def.axis, cfg, invariantsFromEnv(), page, evidence).bind(ctx);
  memo.perf = s;
  const drones = await api.drones();
  const faults = (await api.faults()).faults;
  check.precondition(`stack at the baseline fleet (${cfg.baseline.drones} drones; found ${drones.map((d) => d.id).join(',')})`, drones.length === cfg.baseline.drones);
  check.precondition('no active faults', faults.length === 0, faults);
  s.ledger = new WorkloadLedger(api, cfg.safety, drones.map((d) => d.id));
  const state = await api.state();
  if (state.speed !== cfg.baseline.speed) await s.ledger.setSpeed(cfg.baseline.speed);
  await s.probe.install();
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    throw new Blocked(`cockpit unreachable at ${config.cockpitUrl}: ${(e as Error).message.split('\n')[0]}`);
  }
  const rendered = await waitForDeviceRows(page, config.appReadyTimeoutMs);
  check.require({ id: 'app.device_list_rendered', target: 'region:device-list', type: 'blank' }, rendered, { expected: 'device rows', actual: 'none', state: 'no-rows' });
  const started = await s.probe.start();
  check.require({ id: 'perf.probe_installed', target: 'page', type: 'missing' }, started.probe, { expected: 'window.__qaPerf', actual: 'absent', state: 'no-probe' });
  if (!started.cdp) s.unavailableProbe.cdp = started.cdp_reason;
  await s.refreshFleet();
  s.renderer = await page
    .evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl ? String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null;
    })
    .catch(() => null);
  // Map runtime (for render timing / track size); unobservable is recorded, not fatal.
  for (let i = 0; i < 30; i++) {
    const m = await s.probe.mapInfo();
    if (m.observable) break;
    if (i === 29) s.unavailableProbe.map = m.reason ?? 'map not observable';
    await sleep(500);
  }
  await sleep(3_000); // initial camera flight + first telemetry
  evidence.note('perf_open', { drones: s.drones.map((d) => d.id), renderer: s.renderer, cdp: started });
}

export function perfScenario(def: PerfScenarioDef, cfg: PerfConfig = perfConfig): Scenario {
  const session = (ctx: StepContext) => (ctx.memo.perf as PerfRun).bind(ctx);
  const flags = { blocked: null as string | null, harness: null as string | null };

  return {
    id: def.id,
    title: def.title,
    user_goal: def.user_goal,
    starting_state: { description: def.starting, path: null, simulator: 'reset', waitForDevices: false },
    expected_behavior: def.expected_behavior,
    invariant: def.invariant,
    evidence_requirements: ALL_EVIDENCE,
    tags: ['level-2', 'performance'],
    steps: [
      {
        name: 'Open the cockpit with the performance probe (baseline stack)',
        action: async (ctx) => {
          flags.blocked = null;
          flags.harness = null;
          try {
            await openCockpit(def, cfg, ctx);
          } catch (e) {
            if (e instanceof Blocked) flags.blocked = e.message;
            else if (!(e instanceof HardStop)) flags.harness = (e as Error).message;
            throw e;
          }
        },
      },
      {
        name: `Workload: ${def.title}`,
        action: async (ctx) => {
          const s = session(ctx);
          s.deadline = new Deadline(cfg.safety.scenarioTimeoutMs);
          let timer: NodeJS.Timeout | undefined;
          const work = def.workload(s);
          s.workloadDone = work.catch(() => undefined);
          try {
            await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new SevereAbort('timeout', `workload exceeded the ${cfg.safety.scenarioTimeoutMs} ms hard timeout`)), cfg.safety.scenarioTimeoutMs + 5_000)))]);
          } catch (e) {
            s.cancelled = true;
            const a = describeAbort(e);
            s.aborted = `${a.kind}: ${a.message}`;
            ctx.evidence.note('perf_abort', s.aborted);
            if (isInfrastructureAbort(e)) {
              flags.blocked = a.message;
              throw new Blocked(a.message);
            }
            if (a.kind === 'page_freeze') {
              // Severe responsiveness failure: stop now; reported as a hard breach in the perf verdict.
              const at = s.currentLevel ?? s.steps[s.steps.length - 1]?.level ?? null;
              s.freezeBreach = `page unresponsive > ${cfg.safety.freezeAbortMs} ms at ${at === null ? 'start' : `${def.axis}=${at}`} (${a.message})`;
              // The aborted level is a measured result too: record it as a (window-less) step.
              if (at !== null && !s.steps.some((x) => x.level === at && x.phase !== 'baseline'))
                s.steps.push({ index: s.steps.length + 1, level: at, phase: 'ramp', started_at: new Date().toISOString(), windows: [], invariants: [], baseline: [], verdict: 'HARD_INVARIANT_BREACH', isolated_outliers: [], preexisting: [], reasons: [`severe: ${a.message} (> ${cfg.safety.freezeAbortMs} ms); workload aborted`], pass: false });
              ctx.check.warn({ id: 'perf.page_freeze', target: `workload:${def.axis}`, type: 'timeout' }, false, { expected: `no freeze > ${cfg.safety.freezeAbortMs} ms`, actual: a.message, state: 'freeze' });
              return;
            }
            if (a.kind === 'browser_crash') {
              ctx.check.that({ id: 'perf.browser_crash', target: 'page', type: 'invalid_state' }, false, { expected: 'renderer alive', actual: 'crashed', state: 'crashed', message: 'the renderer crashed under load' });
              return;
            }
            flags.harness = a.message;
            if (e instanceof SafetyLimitError) throw e;
            throw e instanceof Error ? e : new Error(String(e));
          } finally {
            clearTimeout(timer);
            s.defects = ctx.check.failed.length > 0;
          }
        },
      },
      {
        name: 'Capture the state under load (screenshot + DOM)',
        always: true,
        action: async (ctx) => {
          const s = ctx.memo.perf as PerfRun | undefined;
          if (!s) return;
          session(ctx);
          // failure.png is Level-1's required evidence for a defect; the executor re-takes it at the
          // end, but a frozen page may refuse, so the state under load is kept here as well.
          const alsoAs = s.defects ? 'failure.png' : undefined;
          if (!s.degradationShot || alsoAs) {
            const last = s.steps[s.steps.length - 1];
            const lines = s.freezeBreach
              ? [`${def.id}: ${s.freezeBreach}`]
              : last
                ? [...stepBanner(def.id, def.axisLabel, last), s.knee && s.knee.degradation_onset === null ? `no degradation observed up to ${def.axisLabel}=${s.knee.safe_capacity}` : '']
                : [`${def.id}: no workload step completed`];
            await guarded(annotatedCapture(ctx.page, ctx.evidence, lines.filter(Boolean), s.degradationShot ? 'load-state-annotated.png' : 'degradation-annotated.png', alsoAs), 45_000, 'capture').catch(() => undefined);
          }
          await guarded(ctx.evidence.dom(ctx.page), 10_000, 'dom').catch(() => undefined);
        },
      },
      {
        name: 'Cleanup: restore the shared stack to its baseline',
        always: true,
        action: async (ctx) => {
          const s = ctx.memo.perf as PerfRun | undefined;
          if (!s?.ledger) return;
          session(ctx);
          s.cancelled = true;
          await Promise.race([s.workloadDone, sleep(15_000)]);
          await s.probe.stop();
          s.cleanup = await s.ledger.cleanup();
          ctx.evidence.note('perf_cleanup', s.cleanup);
          // Recovery: once the workload is gone, how long until the page answers again?
          const t0 = Date.now();
          let recovered = false;
          while (!recovered && Date.now() - t0 < 30_000) recovered = await guarded(ctx.page.evaluate(() => true), 2_000, 'recovery').catch(() => false);
          s.extra.recovery_after_cleanup = { responsive: recovered, waited_ms: Date.now() - t0 };
          const failure = classifyCleanupFailure(s.cleanup);
          if (failure?.status === 'BLOCKED') {
            flags.blocked ??= failure.message;
            throw new Blocked(failure.message);
          }
          if (failure) {
            flags.harness ??= failure.message;
            throw new Error(failure.message);
          }
        },
      },
      {
        name: 'Performance verdict and report',
        always: true,
        action: async (ctx) => {
          const s = ctx.memo.perf as PerfRun | undefined;
          if (!s) return;
          session(ctx);
          const { verdict, reason } = overallVerdict(s, flags);
          const onset = onsetStep(s);
          const top = [...s.steps].reverse().find((x) => x.phase !== 'baseline');
          const signals = correlateBottlenecks(s.baseline, onset?.windows ?? top?.windows ?? []);
          const unavailable: PerformanceResult['unavailable_metrics'] = {};
          for (const w of s.windows) for (const [k, why] of Object.entries(w.unavailable)) if (w.values[k as keyof typeof w.values] === null) unavailable[k as keyof typeof unavailable] ??= why;
          for (const [k, why] of Object.entries(s.unavailableProbe)) s.notes.push(`${k} unavailable: ${why}`);
          const result: PerformanceResult = {
            schema: 'cockpit-qa/performance@1',
            scenario_id: def.id,
            title: def.title,
            user_goal: def.user_goal,
            workload_axis: def.axis,
            started_at: s.startedAt,
            finished_at: new Date().toISOString(),
            environment: { cockpitUrl: ctx.config.cockpitUrl, apiUrl: ctx.config.apiUrl, browser: ctx.page.context().browser()?.version() ?? 'unknown', headless: ctx.config.headless, renderer: s.renderer, notes: s.notes },
            config: { timing: cfg.timing, ramp: cfg.ramp, tukey: cfg.tukey, baseline: cfg.baseline, soak: cfg.soak, stress: cfg.stress, invariants: s.invariants },
            baseline: s.baseline as PerformanceBaselineProfile | null,
            recorded_baseline_drift: s.recordedDrift,
            steps: s.steps,
            samples: s.samples,
            knee: s.knee,
            verdict,
            verdict_reason: reason,
            bottleneck_signals: onset || verdict !== 'HEALTHY' ? signals : [],
            unavailable_metrics: unavailable,
            safety: { limits: { ...cfg.safety }, aborted: s.aborted, truncated: s.truncated, events: [...s.monitor.events, ...s.ledger.events] },
            cleanup: s.cleanup,
            extra: { ...s.extra, signals_from_level: (onset ?? top)?.level ?? null, informational_signals_at_max_load: onset || verdict !== 'HEALTHY' ? undefined : signals },
          };
          writePerformanceEvidence(ctx.evidence, result);
          perfResults.set(def.id, result);

          // Verdict-neutral visibility of capacity results in result.json.
          for (const st of s.steps.filter((x) => x.phase !== 'baseline' && (x.verdict === 'DEGRADED' || x.verdict === 'HARD_INVARIANT_BREACH'))) {
            ctx.check.warn({ id: 'perf.contract', target: `workload:${def.axis}=${st.level}`, type: 'lag' }, false, { expected: 'HEALTHY', actual: st.verdict, state: st.verdict, message: st.reasons.join('; ') });
          }
          // Functional stability under load (defects, as in Level-1).
          const lost = s.windows.reduce((a, w) => a + (w.browser?.webgl_context_lost ?? 0), 0);
          ctx.check.that({ id: 'perf.webgl_context_lost', target: 'testid:map-canvas', type: 'invalid_state' }, lost === 0, { expected: 0, actual: lost, state: 'context-lost', message: `${lost} WebGL context loss event(s) under load` });
        },
      },
    ],
  };
}
