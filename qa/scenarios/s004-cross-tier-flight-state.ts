import { readFlightSnapshot, readSelection } from '../assertions/cockpit.js';
import { analyseConvergence, longestRun, type ConvergenceReport } from '../assertions/convergence.js';
import { pollUntil } from '../assertions/polling.js';
import { selectDevice } from './actions.js';
import type { FlightStatus } from '../utils/api.js';
import { parseNumber, TID } from '../utils/selectors.js';
import { ALL_EVIDENCE, type Scenario } from './types.js';

const DRONE = 'drone-1';
const CRUISE_HEIGHT = 30; // simulator/src/drone.ts CRUISE_HEIGHT
const CRUISE_SPEED = 10; // simulator/src/drone.ts CRUISE_SPEED
/**
 * Sim tick is 500 ms; measured UI lag on a healthy stack is ~0.5-0.7 s. 2.5 s (5 ticks) of OBSERVED staleness is the bound
 * beyond which a mismatch is a defect rather than normal telemetry latency.
 */
const MAX_LAG_MS = 2_500;
const ORDER: Record<string, number> = { standby: 0, taking_off: 1, in_flight: 2 };
const T_HEADER = `testid:${TID.statusFlight}`;
const T_ROW = `device:${DRONE}`;
const T_ALT = `testid:${TID.telemetryAltRlt}`;

interface Sample {
  t: number;
  ui_status: string;
  ui_row_status: string;
  ui_alt: number | null;
  api_status: FlightStatus | undefined;
  api_height: number | undefined;
}

export const s004: Scenario = {
  id: 'scenario-004',
  title: 'Cross-Tier Flight State Consistency',
  user_goal: 'When a drone takes off, the cockpit shows the same flight status and altitude the simulator reports.',
  starting_state: {
    description: 'Simulator reset (drone-1 standby on its dock, height 0); cockpit at / with drone-1 selected.',
    path: '/',
    simulator: 'reset',
    waitForDevices: true,
  },
  expected_behavior: [
    `${DRONE} begins in standby in both simulator and UI.`,
    'POST /api/control/command {type: takeoff} is acknowledged (ok: true).',
    'The simulator moves taking_off -> in_flight and climbs to 30 m.',
    `The UI status pill and device-row status follow the simulator within ${MAX_LAG_MS} ms and are never ahead of it.`,
    'The UI altitude never decreases during the climb and settles at the simulator height.',
    'Once in flight the UI horizontal speed matches cruise speed.',
  ],
  invariant: `For all t: order(ui_status(t)) <= order(api_status(t)), and any ui/api mismatch lasts <= ${MAX_LAG_MS} ms; at steady state ui_alt ≈ api_height.`,
  evidence_requirements: ALL_EVIDENCE,
  tags: ['level-1', 'ground-truth', 'cross-tier', 'telemetry'],
  steps: [
    {
      name: `${DRONE} starts in standby (simulator and UI)`,
      action: async ({ api, check, healing }) => {
        const gt = (await api.state()).drones[DRONE];
        // Ground-truth side of the starting state: if the simulator is not at baseline, no verdict is possible.
        check.precondition(`${DRONE} exists in simulator`, !!gt);
        check.precondition(`${DRONE} is standby at height 0 after reset`, gt.status === 'standby' && Math.abs(gt.height) < 0.01, { status: gt.status, height: gt.height });
        const device = (await api.drones()).find((d) => d.id === DRONE)!;
        await healing.perform(check, selectDevice(device));
      },
      verify: async ({ page, check, evidence, memo }) => {
        const poll = await pollUntil(() => readSelection(page), (s) => s.flightStatus === 'standby' && s.altitudeM !== null && Math.abs(s.altitudeM) < 0.5, { timeoutMs: 8_000, intervalMs: 250 });
        evidence.note('baseline', { ui: poll.last, converged: poll.ok, elapsedMs: poll.elapsedMs });
        memo.baselineAlt = poll.last?.altitudeM ?? null;
        check.equal({ id: 'flight.ui_status_matches_sim', target: T_HEADER, type: 'mismatch', name: 'UI status pill shows standby' }, poll.last?.flightStatus, 'standby');
        check.near({ id: 'flight.ui_altitude_matches_sim', target: T_ALT, type: 'mismatch', name: 'UI altitude is ~0 m at standby' }, poll.last?.altitudeM ?? null, 0, 0.5);
      },
    },
    {
      name: 'Send takeoff via POST /api/control/command',
      action: async ({ api, check, evidence }) => {
        const res = await api.command(DRONE, 'takeoff');
        evidence.note('takeoff_ack', res);
        check.equal({ id: 'control.command_http_ok', target: 'api:/api/control/command', type: 'http_error' }, res.status, 200, { state: `status-${res.status}` });
        check.equal({ id: 'control.command_acked', target: 'api:/api/control/command', type: 'mismatch' }, res.body?.ok, true, { state: res.body?.error ?? 'not-ok' });
      },
      verify: async ({ api, check }) => {
        const poll = await pollUntil(() => api.state(), (s) => s.drones[DRONE]?.status !== 'standby', { timeoutMs: 3_000, intervalMs: 200 });
        check.that({ id: 'control.sim_left_standby', target: `sim:${DRONE}`, type: 'timeout' }, poll.ok, { expected: 'taking_off|in_flight', actual: poll.last?.drones[DRONE]?.status, state: 'still-standby' });
      },
    },
    {
      name: 'UI tracks simulator through the climb',
      verify: async ({ page, api, check, evidence, memo }) => {
        const t0 = Date.now();
        const trace: Sample[] = [];
        const poll = await pollUntil(
          async () => {
            // UI first (one atomic DOM read), then API: a UI "ahead" of a later API read is a real inversion.
            const snap = await readFlightSnapshot(page, DRONE);
            const gt = (await api.state()).drones[DRONE];
            const s: Sample = { t: Date.now() - t0, ui_status: snap.headerStatus, ui_row_status: snap.rowStatus, ui_alt: snap.altitudeM, api_status: gt?.status, api_height: gt?.height };
            trace.push(s);
            return s;
          },
          (s) => s.api_status === 'in_flight' && s.ui_status === 'in_flight' && s.ui_row_status === 'in_flight' && s.ui_alt !== null && Math.abs(s.ui_alt - CRUISE_HEIGHT) <= 0.5,
          // confirm: 2 — steady state must be seen on two consecutive samples, not one lucky frame.
          { timeoutMs: 30_000, intervalMs: 100, confirm: 2 },
        );

        // Bounded convergence per ground-truth transition (see assertions/convergence.ts): verdicts use
        // OBSERVED staleness only, so sampler stalls and one late telemetry frame cannot create findings.
        const header = analyseConvergence(trace, (s) => s.api_status, (s) => s.ui_status);
        const row = analyseConvergence(trace, (s) => s.api_status, (s) => s.ui_row_status);
        const rank = (st: string | undefined) => ORDER[st ?? ''] ?? -1;
        const headerAhead = longestRun(trace, (s) => rank(s.ui_status) > rank(s.api_status));
        const rowAhead = longestRun(trace, (s) => rank(s.ui_row_status) > rank(s.api_status));
        const invalid = [...new Set(trace.map((s) => s.ui_status).filter((st) => !(st in ORDER)))].sort();
        // Altitude regression: samples below the running maximum. One isolated dip = a late frame (warn);
        // two or more consecutive = the UI is genuinely showing older data (defect).
        let runMax = -Infinity;
        const altTrace = trace.filter((s) => s.ui_alt !== null).map((s) => {
          const below = (s.ui_alt as number) < runMax - 0.05;
          runMax = Math.max(runMax, s.ui_alt as number);
          return { t: s.t, below, alt: s.ui_alt };
        });
        const dip = longestRun(altTrace, (s) => s.below);
        const alts = trace.map((s) => s.ui_alt).filter((a): a is number => a !== null);
        const last = trace[trace.length - 1];
        const baseAlt = (memo.baselineAlt as number | null) ?? 0;
        const peak = alts.length ? Math.max(...alts) : null;
        const seen = [...new Set(trace.map((s) => s.ui_status))];

        const worstLower = (r: ConvergenceReport) => Math.max(0, ...r.transitions.map((x) => x.lower_ms), ...r.regressions.map((x) => x.observed_ms));
        evidence.note('climb_trace', { converged: poll.ok, elapsedMs: poll.elapsedMs, max_sample_gap_ms: poll.maxGapMs, header_convergence: header, row_convergence: row, samples: trace });
        const obs = (r: ConvergenceReport) => ({ samples: trace.length, elapsed_ms: poll.elapsedMs, max_sample_gap_ms: poll.maxGapMs, bound_ms: MAX_LAG_MS, transitions: r.transitions, regressions: r.regressions, last_sample: last });

        check.that({ id: 'flight.ui_converges_to_in_flight', target: T_HEADER, type: 'timeout' }, poll.ok, {
          expected: `UI in_flight @ ${CRUISE_HEIGHT} m (2 consecutive samples)`, actual: last,
          // Which UI parts failed to converge is the identity; the numbers are observations.
          state: [last?.ui_status !== 'in_flight' && 'header', last?.ui_row_status !== 'in_flight' && 'row', (last?.ui_alt === null || Math.abs((last?.ui_alt ?? 0) - CRUISE_HEIGHT) > 0.5) && 'altitude'].filter(Boolean).join('+') || 'none',
          observed: obs(header),
        });
        for (const [target, a, r] of [[T_HEADER, headerAhead, header], [T_ROW, rowAhead, row]] as const) {
          check.that({ id: 'flight.ui_never_ahead_of_sim', target, type: 'order_violation' }, a.samples < 2, { expected: 'never ahead on 2+ consecutive samples', actual: `${a.samples} consecutive samples ahead from t=${a.from_t}ms`, state: 'ahead', observed: obs(r) });
          check.warn({ id: 'flight.ui_ahead_single_sample', target, type: 'order_violation' }, a.samples === 0, { expected: 'never ahead', actual: `${a.samples} isolated sample(s)` });
          // The staleness bound, evaluated on observed staleness per transition and per regression window.
          const lower = worstLower(r);
          check.that({ id: 'flight.ui_lag_bounded', target, type: 'lag' }, lower <= MAX_LAG_MS, {
            expected: `observed staleness <= ${MAX_LAG_MS} ms`, actual: `${lower} ms observed stale`, state: 'exceeded', observed: obs(r),
          });
          const flickers = r.regressions.filter((x) => x.observed_ms <= MAX_LAG_MS);
          check.warn({ id: 'flight.ui_status_flicker', target, type: 'lag' }, flickers.length === 0, { expected: 'no reversion after convergence', actual: flickers });
        }
        check.that({ id: 'flight.ui_valid_states_only', target: T_HEADER, type: 'invalid_state' }, invalid.length === 0, { expected: Object.keys(ORDER), actual: invalid, state: invalid.join(',') });
        check.that({ id: 'flight.ui_altitude_monotonic_climb', target: T_ALT, type: 'non_monotonic' }, dip.samples < 2, { expected: 'no sustained altitude regression', actual: `${dip.samples} consecutive samples below the running max`, state: 'drop' });
        check.warn({ id: 'flight.ui_altitude_single_dip', target: T_ALT, type: 'non_monotonic' }, dip.samples === 0, { expected: 'non-decreasing', actual: `${dip.samples} isolated dip sample(s)` });
        check.that({ id: 'flight.ui_altitude_rises_to_cruise', target: T_ALT, type: 'mismatch' }, peak !== null && peak - baseAlt >= CRUISE_HEIGHT - 1, {
          expected: `${baseAlt} -> ~${CRUISE_HEIGHT} m`, actual: peak === null ? 'no readings' : `${baseAlt} -> ${peak}`, state: peak === null ? 'no-reading' : 'too-low',
        });
        check.near({ id: 'flight.ui_altitude_matches_sim', target: T_ALT, type: 'mismatch' }, last?.ui_alt ?? null, last?.api_height ?? NaN, 0.5);
        check.equal({ id: 'flight.row_and_header_agree', target: T_ROW, type: 'mismatch' }, last?.ui_row_status, last?.ui_status);
        check.warn({ id: 'flight.ui_shows_taking_off', target: T_HEADER, type: 'missing' }, seen.includes('taking_off'), { expected: 'taking_off seen', actual: seen });
      },
    },
    {
      name: 'In flight: UI altitude holds and horizontal speed matches cruise',
      verify: async ({ page, api, check, evidence }) => {
        const hs = await pollUntil(async () => parseNumber(await page.getByTestId(TID.telemetryHSpeed).textContent()), (v) => v !== null && Math.abs(v - CRUISE_SPEED) <= 0.5, { timeoutMs: 5_000, intervalMs: 250 });
        const gt = (await api.state()).drones[DRONE];
        check.precondition(`${DRONE} still in_flight in simulator`, gt?.status === 'in_flight', gt?.status);
        const sel = await readSelection(page);
        evidence.note('cruise', { ui_hspeed: hs.last, ui: sel, ground_truth: gt });
        check.equal({ id: 'flight.ui_status_matches_sim', target: T_HEADER, type: 'mismatch', name: 'UI still in_flight at cruise' }, sel.flightStatus, 'in_flight');
        check.near({ id: 'flight.ui_hspeed_matches_cruise', target: `testid:${TID.telemetryHSpeed}`, type: 'mismatch' }, hs.last ?? null, CRUISE_SPEED, 0.5);
        check.near({ id: 'flight.ui_altitude_holds_cruise', target: T_ALT, type: 'mismatch' }, sel.altitudeM, gt?.height ?? CRUISE_HEIGHT, 0.5);
      },
    },
    {
      name: 'Cleanup: reset simulator to baseline',
      always: true,
      action: async ({ api, check }) => {
        const s = await api.resetAndStart();
        // Cleanup never changes the verdict; a failed restore is surfaced as a warning for the next scenario.
        check.warn({ id: 'cleanup.sim_restored', target: `sim:${DRONE}`, type: 'mismatch' }, s.drones[DRONE]?.status === 'standby', { expected: 'standby', actual: s.drones[DRONE]?.status });
      },
    },
  ],
};
