import { loadPerfBaseline, profileDrift, writePerfBaseline } from '../performance/baseline.js';
import { readDeviceRows } from '../assertions/cockpit.js';
import { annotatedCapture, stepBanner } from '../performance/reporting.js';
import { perfScenario, type PerfRun } from '../performance/scenario.js';
import { bracketKnee } from '../performance/stepper.js';
import type { KneeResult, WindowMetrics, WorkloadContext } from '../performance/types.js';
import type { DeviceInfo } from '../utils/api.js';

/**
 * P001: fleet size N is the workload axis (≈ 9N telemetry messages/s).
 *
 * Baseline: K windows at N=4, 1.0x, no faults (one selection per window).
 * Ramp: N = 4, 8, 12 … 32 (limit). Each level: add/remove drones -> fleet convergence (API ack ->
 * every row rendered) -> stabilize 4 s -> observe 5 s -> 3 selections alternating between the
 * NEWEST drone and the first one -> judge (a non-healthy first window is re-observed before judging).
 * On the first failing level the bracket [last pass, fail] is binary-refined to ±1 drone.
 * Raw FPS alone never decides anything: every level is judged on the full contract set + baseline.
 */

/** Selection targets that always change the selection (re-clicking the selected row proves nothing). */
function targets(s: PerfRun, count: number, memo: { selected: string | null }): DeviceInfo[] {
  const newest = s.drones[s.drones.length - 1];
  const first = s.drones[0];
  const out: DeviceInfo[] = [];
  let current = memo.selected;
  for (let i = 0; i < count; i++) {
    const next = current === newest.id ? first : newest;
    out.push(next);
    current = next.id;
  }
  return out;
}

export const p001 = perfScenario({
  id: 'P001',
  title: 'Adaptive drone workload',
  user_goal: 'An operator should be able to manage an expanding fleet without the cockpit becoming unusable.',
  axis: 'drones',
  axisLabel: 'N',
  starting: 'Simulator reset + started at 1.0x with the stock fleet of 4 drones and no faults; cockpit at / with the performance probe installed before load.',
  expected_behavior: [
    'Every fleet change is reflected in the device list (row set == API drones) within 1500 ms.',
    'Selecting the newest drone takes effect (row selected, telemetry header names it) within the interaction contract.',
    'Longest task, frame rate, freezes and telemetry age stay within their contracts, or the level is reported as degraded/breached.',
    'The report gives the largest healthy fleet size and the degradation onset, refined to ±1 drone, with the evidence behind it.',
  ],
  invariant: 'For each fleet size N: rows == API drones; interaction ≤ 150 ms nominal (> 300 degraded, > 1000 breach); no task > 500 ms; FPS ≥ 20; no freeze > 500 ms; telemetry age ≤ 3000 ms; fleet convergence ≤ 1500 ms; no regression beyond P95 + 3·IQR of the N=4 baseline in 2 consecutive windows.',
  workload: async (s) => {
    const cfg = s.cfg;
    const memo = { selected: (await readDeviceRows(s.page)).find((r) => r.selected)?.id ?? null };
    const observation = (interactions: number) => async (wl: WorkloadContext): Promise<WindowMetrics> => {
      const w = await s.observe(wl);
      for (const d of targets(s, interactions, memo)) {
        const m = await s.selectDevice(d, wl);
        w.interactions.push(m);
        if (m.stage === 'POSTCONDITION_SATISFIED') memo.selected = d.id;
      }
      return w;
    };

    const base = await s.collectBaseline(cfg.baseline.drones, cfg.baseline.windows, observation(1));
    s.recordedDrift = profileDrift(loadPerfBaseline(s.ctx.config.paths.root), s.baseline!);
    if (cfg.mode.recordBaselineOnly) {
      s.extra.recorded_baseline_file = writePerfBaseline(s.ctx.config.paths.root, s.baseline!);
      return;
    }

    const levels = cfg.ramp.levels.filter((n) => n <= cfg.safety.maxDrones);
    // Budget for one more level: fleet change + stabilize + observe + interactions (+ a confirmation window).
    const levelBudget = 2_000 + cfg.timing.stabilizeMs + 2 * (cfg.timing.observeMs + cfg.timing.interactionsPerStep * 800);
    try {
      s.knee = await bracketKnee(
        levels,
        cfg.ramp.resolution,
        async (level, phase) => {
          if (level === cfg.baseline.drones) return { pass: base.verdict !== 'INCONCLUSIVE', verdict: base.verdict };
          const fleet = await s.applyFleet(level);
          await s.stabilize();
          const step = await s.evaluateLevel(level, phase, observation(cfg.timing.interactionsPerStep), { fleet_convergence_ms: fleet.convergence_ms });
          s.evidence.note(`level_${level}`, { phase, verdict: step.verdict, reasons: step.reasons, isolated: step.isolated_outliers, convergence_ms: fleet.convergence_ms });
          if (!step.pass && !s.degradationShot) {
            s.degradationShot = { level, reason: step.reasons.join('; ') };
            await annotatedCapture(s.page, s.evidence, stepBanner('P001', 'N', step));
          }
          return { pass: step.pass, verdict: step.verdict };
        },
        () => s.fits(levelBudget),
      );
    } catch (e) {
      // A severe abort (page freeze) still yields the bracket observed so far.
      s.knee = (e as { knee?: KneeResult }).knee ?? null;
      throw e;
    }
    if (s.knee && !s.knee.established && /truncated|time budget/.test(s.knee.reason)) s.truncated = s.knee.reason;
  },
});
