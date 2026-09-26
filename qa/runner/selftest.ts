import type { Browser } from 'playwright';
import { ALL_EVIDENCE, type Scenario, type Step } from '../scenarios/types.js';
import type { QaConfig } from './config.js';
import { join } from 'node:path';
import { analyseConvergence } from '../assertions/convergence.js';
import { healingCases } from '../healing/selftest-cases.js';
import { baselineStateOf } from './baseline.js';
import { runScenario, type ScenarioStatus } from './executor.js';
import { diffAgainstBaseline } from './findings.js';

/**
 * Self-test of the verdict model: synthetic scenarios against the live cockpit, each constructed to
 * produce exactly one verdict. Proves a product defect, a missing precondition and a harness bug are
 * never confused with each other.
 */

const synthetic = (id: string, title: string, step: Step): Scenario => ({
  id,
  title,
  user_goal: 'self-test of the QA verdict model',
  starting_state: { description: 'cockpit at /, simulator as-is', path: '/', simulator: 'as-is', waitForDevices: true },
  steps: [step],
  expected_behavior: [],
  invariant: 'synthetic',
  evidence_requirements: ALL_EVIDENCE,
  tags: ['self-test'],
});

const CASES: Array<{ expect: ScenarioStatus; scenario: Scenario }> = [
  {
    expect: 'PASS',
    scenario: synthetic('selftest-pass', 'invariant holds', {
      name: 'device rows exist',
      verify: async ({ ui, check }) => void check.that({ id: 'selftest.rows', target: 'region:device-list', type: 'missing' }, (await ui.deviceRows().count()) > 0),
    }),
  },
  {
    expect: 'DEFECT_FOUND',
    scenario: synthetic('selftest-defect', 'invariant violated', {
      name: 'impossible UI expectation',
      verify: async ({ ui, check }) => void check.equal({ id: 'selftest.row_count', target: 'region:device-list', type: 'mismatch' }, await ui.deviceRows().count(), 999),
    }),
  },
  {
    expect: 'BLOCKED',
    scenario: synthetic('selftest-blocked', 'precondition unavailable', {
      name: 'needs a fleet of 999 drones',
      action: async ({ api, check }) => check.precondition('at least 999 drones', (await api.drones()).length >= 999),
    }),
  },
  {
    expect: 'HARNESS_ERROR',
    scenario: synthetic('selftest-harness', 'harness bug', {
      name: 'harness code throws',
      action: async () => {
        const broken = undefined as unknown as { call: () => void };
        broken.call(); // TypeError inside QA code, not the product
      },
    }),
  },
];

/**
 * Pure-logic cases for the noise-robust convergence analysis and baseline state model.
 * Traces are synthetic: t in ms, api/ui are statuses. Bound = 2500 ms (as in scenario-004).
 */
function logicCases(): Array<{ name: string; ok: boolean; detail: string }> {
  const BOUND = 2_500;
  const tr = (rows: Array<[number, string, string]>) => rows.map(([t, api, ui]) => ({ t, api, ui }));
  const verdict = (trace: ReturnType<typeof tr>) => {
    const r = analyseConvergence(trace, (s) => s.api, (s) => s.ui);
    const lower = Math.max(0, ...r.transitions.map((x) => x.lower_ms), ...r.regressions.map((x) => x.observed_ms));
    return { defect: lower > BOUND, lower, flickers: r.regressions.filter((x) => x.observed_ms <= BOUND).length };
  };
  const cases: Array<{ name: string; expectDefect: boolean; expectFlicker?: boolean; trace: ReturnType<typeof tr> }> = [
    { name: 'healthy: UI 600 ms behind each transition', expectDefect: false, trace: tr([[0, 'a', 'a'], [100, 'b', 'a'], [700, 'b', 'b'], [5000, 'c', 'b'], [5600, 'c', 'c']]) },
    { name: 'one late telemetry sample (single stale frame at 900 ms)', expectDefect: false, trace: tr([[0, 'a', 'a'], [100, 'b', 'a'], [900, 'b', 'a'], [1000, 'b', 'b'], [2000, 'b', 'b']]) },
    { name: 'harness stall: 4 s gap between samples (GC/scheduling), UI current after', expectDefect: false, trace: tr([[0, 'a', 'a'], [100, 'b', 'a'], [4100, 'b', 'b'], [4200, 'b', 'b']]) },
    { name: 'single reverted sample after convergence (flicker)', expectDefect: false, expectFlicker: true, trace: tr([[0, 'b', 'b'], [500, 'b', 'a'], [600, 'b', 'b'], [3000, 'b', 'b']]) },
    { name: 'genuinely stale: UI observed stale 4 s after the change', expectDefect: true, trace: tr([[0, 'a', 'a'], [100, 'b', 'a'], [2000, 'b', 'a'], [4100, 'b', 'a'], [4300, 'b', 'b']]) },
    { name: 'never converges (frozen UI)', expectDefect: true, trace: tr([[0, 'b', 'a'], [1000, 'b', 'a'], [3000, 'b', 'a'], [6000, 'b', 'a']]) },
    { name: 'sustained regression 3 s after convergence', expectDefect: true, trace: tr([[0, 'b', 'b'], [500, 'b', 'a'], [2000, 'b', 'a'], [3600, 'b', 'a'], [3700, 'b', 'b']]) },
  ];
  const out = cases.map((c) => {
    const v = verdict(c.trace);
    const ok = v.defect === c.expectDefect && (c.expectFlicker === undefined || (v.flickers > 0) === c.expectFlicker);
    return { name: `convergence: ${c.name}`, ok, detail: `defect=${v.defect} observed_stale=${v.lower}ms flickers=${v.flickers}` };
  });
  const states: Array<[number, number, string]> = [[3, 3, 'STABLE_BASELINE'], [2, 3, 'INTERMITTENT'], [1, 3, 'TRANSIENT'], [1, 1, 'UNCONFIRMED'], [4, 5, 'INTERMITTENT']];
  for (const [seen, runs, want] of states) {
    const got = baselineStateOf(seen, runs);
    out.push({ name: `baseline state: seen ${seen}/${runs} -> ${want}`, ok: got === want, detail: `got ${got}` });
  }
  const d = diffAgainstBaseline(['s1', 'n1'], new Map([['s1', 'STABLE_BASELINE'], ['s2', 'STABLE_BASELINE'], ['i1', 'INTERMITTENT']] as const));
  out.push({ name: 'baseline diff: new / known / masked / intermittent-absent', ok: JSON.stringify([d.new, d.known_stable, d.masked, d.absent_intermittent]) === JSON.stringify([['n1'], ['s1'], ['s2'], ['i1']]), detail: JSON.stringify(d) });
  return out;
}

export async function selfTest(browser: Browser, base: QaConfig): Promise<number> {
  let ok = true;
  console.log('-- logic');
  for (const c of logicCases()) {
    ok &&= c.ok;
    console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}  (${c.detail})`);
  }
  console.log('\n-- self-healing (synthetic page, scripted resolver test double; no network)');
  for (const c of await healingCases(browser, join(base.paths.evidence, 'healing-memory.json'))) {
    ok &&= c.ok;
    console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}  (${c.detail})`);
  }
  console.log('\n-- verdict model (live cockpit)');
  for (const c of CASES) {
    const r = await runScenario(browser, c.scenario, base);
    const pass = r.status === c.expect;
    ok &&= pass;
    console.log(`${pass ? 'OK  ' : 'FAIL'} expected ${c.expect.padEnd(13)} got ${r.status.padEnd(13)} ${c.scenario.id}  (${r.status_reason.slice(0, 110)})`);
  }
  console.log(ok ? '\nverdict model self-test passed' : '\nverdict model self-test FAILED');
  return ok ? 0 : 3;
}
