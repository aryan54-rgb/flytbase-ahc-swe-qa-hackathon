import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { remember } from '../memory/history.js';
import { perfScenarios, scenarios } from '../scenarios/index.js';
import { perfConfig } from '../performance/config.js';
import { perfResults } from '../performance/scenario.js';
import { writeRunSummary } from '../performance/reporting.js';
import { perfSelfTest } from '../performance/selftest.js';
import { activeLedgers } from '../performance/safety.js';
import type { PerformanceRun } from '../performance/types.js';
import type { Scenario } from '../scenarios/types.js';
import { baselineDrift, baselineFile, baselineIndex, loadBaseline, writeBaseline, type Baseline } from './baseline.js';
import { qaConfig, type QaConfig } from './config.js';
import { runScenario, STATUS_RANK, type RunOptions, type ScenarioResult, type ScenarioStatus } from './executor.js';
import { mutationDecouplingViolations } from './decoupling.js';
import { diffAgainstBaseline } from './findings.js';
import { launchBrowser } from './fixture.js';
import { findMutation, MUTATIONS } from './mutations.js';
import { selfTest } from './selftest.js';
import { versionInfo } from './version.js';
import { rmSync } from 'node:fs';
import { resolverFromEnv } from '../healing/resolver.js';
import type { HealingSummary } from '../healing/session.js';
import { EL, selectorAudit, type Strategy } from '../utils/selectors.js';

/**
 * Usage (from qa/):
 *   npm run qa                                    all scenarios; findings tagged KNOWN/NEW vs baseline if one exists
 *   npm run qa -- --scenario 004                  one scenario ("4", "004", "scenario-004", "1,3")
 *   npm run qa -- --tag responsive
 *   npm run qa -- --fail-on new                   exit 1 only for findings not in the baseline
 *   npm run qa -- --record-baseline [--runs 3]    record the clean-app baseline from N real runs
 *   npm run qa -- --repeat 10                     reliability: run the suite N times, report determinism
 *   npm run qa -- --mutation-check                baseline-aware mutation validation (all scenarios x all mutations)
 *   npm run qa -- --mutate row-click-dead         run against one runtime mutation
 *   npm run qa -- --self-test                     verify the verdict model (PASS/DEFECT/BLOCKED/HARNESS) on synthetic cases
 *   npm run qa -- --healing-demo                  cost proof: run 1 (LLM) vs run 2 (memory) vs stale memory (refusal)
 *   npm run qa -- --reset-healing-memory          delete learned selector repairs before running
 *   npm run qa -- --selector-audit                every registry selector: strategy + live match count
 *   npm run qa -- --list | --list-mutations | --headed | --no-baseline
 *
 * Level-2 performance (separate scenario set, never part of the runs above):
 *   npm run qa -- --perf                          P001 -> P002 -> P003
 *   npm run qa -- --perf --scenario P001          one ("P1", "p001", "P001,P003")
 *   npm run qa -- --perf --record-baseline        record the N=4 performance baseline profile only
 *   npm run qa -- --perf --self-test              offline self-test of the performance logic (no browser)
 *
 * Exit codes (worst verdict wins): 0 PASS · 1 DEFECT_FOUND · 2 BLOCKED · 3 HARNESS_ERROR
 */

interface Args {
  scenario?: string;
  tag?: string;
  mutate?: string;
  failOn: 'any' | 'new';
  runs: number;
  repeat: number;
  list: boolean;
  listMutations: boolean;
  mutationCheck: boolean;
  recordBaseline: boolean;
  noBaseline: boolean;
  headed: boolean;
  selfTest: boolean;
  selectorAudit: boolean;
  healingDemo: boolean;
  resetHealingMemory: boolean;
  perf: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { failOn: 'any', runs: 3, repeat: 0, list: false, listMutations: false, mutationCheck: false, recordBaseline: false, noBaseline: false, headed: false, selfTest: false, selectorAudit: false, healingDemo: false, resetHealingMemory: false, perf: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => inline ?? argv[++i];
    if (flag === '--scenario' || flag === '-s') out.scenario = value();
    else if (flag === '--tag') out.tag = value();
    else if (flag === '--mutate') out.mutate = value();
    else if (flag === '--fail-on') out.failOn = value() === 'new' ? 'new' : 'any';
    else if (flag === '--runs') out.runs = Math.max(1, Number(value()) || 3);
    else if (flag === '--repeat') out.repeat = Math.max(1, Number(value()) || 10);
    else if (flag === '--list') out.list = true;
    else if (flag === '--list-mutations') out.listMutations = true;
    else if (flag === '--mutation-check') out.mutationCheck = true;
    else if (flag === '--record-baseline') out.recordBaseline = true;
    else if (flag === '--no-baseline') out.noBaseline = true;
    else if (flag === '--headed') out.headed = true;
    else if (flag === '--self-test') out.selfTest = true;
    else if (flag === '--selector-audit') out.selectorAudit = true;
    else if (flag === '--healing-demo') out.healingDemo = true;
    else if (flag === '--reset-healing-memory') out.resetHealingMemory = true;
    else if (flag === '--perf') out.perf = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function normalizeId(raw: string): string {
  const n = raw.trim().replace(/^scenario-/, '');
  const perf = /^p(\d+)$/i.exec(n);
  if (perf) return `P${perf[1].padStart(3, '0')}`;
  return /^\d+$/.test(n) ? `scenario-${n.padStart(3, '0')}` : raw.trim();
}

function select(all: Scenario[], args: Args): Scenario[] {
  let list = all;
  if (args.scenario) {
    const ids = new Set(args.scenario.split(',').map(normalizeId));
    const unknown = [...ids].filter((id) => !all.some((s) => s.id === id));
    if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(', ')}. Try --list.`);
    list = list.filter((s) => ids.has(s.id));
  }
  if (args.tag) list = list.filter((s) => s.tags?.includes(args.tag!));
  return list;
}

const EXIT: Record<ScenarioStatus, number> = { PASS: 0, DEFECT_FOUND: 1, BLOCKED: 2, HARNESS_ERROR: 3 };
const worst = (rs: ScenarioResult[]): ScenarioStatus => rs.reduce<ScenarioStatus>((w, r) => (STATUS_RANK[r.status] > STATUS_RANK[w] ? r.status : w), 'PASS');
const pad = (s: string, n: number) => s.padEnd(n);

function printResult(r: ScenarioResult, verbose = true) {
  console.log(`${pad(r.status, 13)} ${r.scenario.id} ${r.scenario.title} (${(r.duration_ms / 1000).toFixed(1)}s)`);
  if (!verbose) return;
  for (const st of r.steps) {
    const mark = { passed: '✓', defect: '✗', blocked: '⊘', harness_error: '!', skipped: '-' }[st.status];
    console.log(`    ${mark} ${st.index}. ${st.name}${st.error ? `  — ${st.error}` : ''}`);
  }
  if (r.status !== 'PASS' && r.status !== 'DEFECT_FOUND') console.log(`      ↳ ${r.status}: ${r.status_reason}`);
  const byIncident = new Map<string, typeof r.findings>();
  for (const f of r.findings) byIncident.set(f.incident, [...(byIncident.get(f.incident) ?? []), f]);
  for (const [incident, fs] of byIncident) {
    if (fs.length > 1) console.log(`      ◆ incident ${incident} (${fs.length} related findings)`);
    for (const f of fs) {
      const tag = f.baseline_state ? `[${f.baseline_state}]` : '';
      console.log(`      ↳ ${tag} ${f.fingerprint} ${f.check_id} ${f.target ?? ''} (${f.failure_type})${f.occurrences > 1 ? ` x${f.occurrences}` : ''}`);
      console.log(`          ${f.summary.slice(0, 220)}`);
    }
  }
  printHealing(r);
  for (const w of r.warnings) if (!w.includes('healing.selector_drifted')) console.log(`      ⚠ ${w}`);
  console.log(`      evidence: ${r.evidence_dir}`);
}

function healingLine(h: HealingSummary): string {
  return `${h.status} · actions ${h.total_actions} · deterministic ${h.deterministic} · healed ${h.healed_actions} (memory ${h.memory_hits}, local ${h.local_recoveries}, llm ${h.llm_successes}) · llm calls ${h.llm_calls}${h.llm_calls ? ` (${h.llm_latency_ms_total} ms, ${h.llm_tokens_total} tokens)` : ''} · unresolved ${h.unresolved} · rejected ${h.rejected} · absent ${h.target_absent} · healing failures ${h.healing_failures}`;
}

function printHealing(r: ScenarioResult) {
  if (!r.healing || r.healing.summary.status === 'NOT_NEEDED') return;
  console.log(`      ⟳ healing ${healingLine(r.healing.summary)}`);
  for (const a of r.healing.actions.filter((x) => x.outcome !== 'DETERMINISTIC')) {
    const tail = a.healed_description ? ` → ${a.healed_description}` : '';
    console.log(`          ${pad(a.outcome, 18)} ${pad(a.mode, 7)} ${a.step_id} conf=${a.recovery_confidence ?? '-'} (${a.confidence_level ?? '-'}) ${a.recovery_latency_ms}ms clicks=${a.clicks_dispatched} post=${a.postcondition}${tail}`);
    if (a.outcome !== 'HEALED_MEMORY' && a.outcome !== 'HEALED_LOCAL') console.log(`            reason: ${a.reason.slice(0, 160)}`);
  }
}

function totalHealing(results: ScenarioResult[]) {
  const keys = ['total_actions', 'deterministic', 'healed_actions', 'memory_hits', 'memory_stale', 'local_recoveries', 'llm_calls', 'llm_successes', 'llm_latency_ms_total', 'llm_tokens_total', 'unresolved', 'rejected', 'target_absent', 'healing_failures'] as const;
  const t = Object.fromEntries(keys.map((k) => [k, 0])) as Record<(typeof keys)[number], number>;
  for (const r of results) if (r.healing) for (const k of keys) t[k] += r.healing.summary[k] as number;
  return t;
}

async function runSet(browser: Browser, chosen: Scenario[], config: QaConfig, runId: string, mode: string, opts: RunOptions, verbose = true): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const s of chosen) {
    const r = await runScenario(browser, s, config, opts);
    results.push(r);
    remember(config.paths.memory, runId, mode, r);
    printResult(r, verbose);
  }
  return results;
}

function withEvidenceDir(base: QaConfig, ...sub: string[]): QaConfig {
  const evidence = join(base.paths.evidence, ...sub);
  mkdirSync(evidence, { recursive: true });
  return { ...base, paths: { ...base.paths, evidence } };
}

const fps = (r: ScenarioResult) => r.findings.map((f) => f.fingerprint).sort();

// ---------------------------------------------------------------------------------------------- modes

async function recordBaseline(browser: Browser, base: QaConfig, runs: number, runId: string): Promise<{ baseline: Baseline | null; code: number }> {
  console.log(`Recording baseline from ${runs} clean run(s) of all ${scenarios.length} scenarios\n`);
  const all: ScenarioResult[][] = [];
  for (let i = 1; i <= runs; i++) {
    console.log(`--- baseline run ${i}/${runs}`);
    all.push(await runSet(browser, scenarios, withEvidenceDir(base, '_baseline', `run-${i}`), `${runId}-baseline-${i}`, 'baseline', {}, false));
  }
  const invalid = all.flat().filter((r) => r.status === 'BLOCKED' || r.status === 'HARNESS_ERROR');
  if (invalid.length) {
    console.error(`\nBaseline NOT written: ${invalid.length} run(s) did not produce a valid verdict:`);
    for (const r of invalid) console.error(`  ${r.status} ${r.scenario.id}: ${r.status_reason}`);
    return { baseline: null, code: EXIT[worst(invalid)] };
  }
  const b = writeBaseline(base.paths.root, runId, all);
  console.log(`\nBaseline ${b.baseline_id} written -> ${baselineFile(base.paths.root)}  (stable: ${b.stable})`);
  for (const [id, s] of Object.entries(b.scenarios)) console.log(`  ${pad(s.stable_status ?? 'UNSTABLE', 13)} ${id}  ${s.fingerprints.length} finding(s)`);
  for (const f of b.findings) console.log(`    ${pad(f.baseline_state, 16)} ${f.fingerprint} ${f.scenario_id} ${f.check_id} ${f.target ?? ''} (${f.failure_type}) seen ${f.seen_in_runs}/${f.runs_total}`);
  if (!b.stable) console.log('\n⚠ baseline is not stable across runs; see qa/baseline/baseline.json');
  return { baseline: b, code: b.stable ? 0 : 1 };
}

async function reliability(browser: Browser, base: QaConfig, chosen: Scenario[], n: number, runId: string, opts: RunOptions): Promise<number> {
  const runs: ScenarioResult[][] = [];
  for (let i = 1; i <= n; i++) {
    console.log(`\n=== reliability run ${i}/${n}`);
    runs.push(await runSet(browser, chosen, withEvidenceDir(base, '_reliability', `run-${String(i).padStart(2, '0')}`), `${runId}-rep-${i}`, 'reliability', opts, false));
  }
  const report = {
    run_id: runId,
    runs: n,
    baseline_id: opts.baseline?.id ?? null,
    scenarios: chosen.map((s) => {
      const rs = runs.map((run) => run.find((r) => r.scenario.id === s.id)!);
      const d = rs.map((r) => r.duration_ms);
      const sets = [...new Set(rs.map((r) => fps(r).join(',')))];
      const statuses = rs.map((r) => r.status);
      const base = opts.baseline?.byScenario.get(s.id);
      return {
        id: s.id,
        statuses,
        status_counts: statuses.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {}),
        deterministic_status: new Set(statuses).size === 1,
        distinct_finding_sets: sets.length,
        finding_sets: sets.map((set) => ({ fingerprints: set ? set.split(',') : [], runs: rs.filter((r) => fps(r).join(',') === set).length })),
        // Matches = every stable baseline finding reproduced, nothing new (intermittent ones may come and go).
        matches_baseline_every_run: base ? rs.every((r) => { const d = diffAgainstBaseline(fps(r), base); return d.new.length === 0 && d.masked.length === 0; }) : null,
        harness_errors: statuses.filter((x) => x === 'HARNESS_ERROR').length,
        blocked: statuses.filter((x) => x === 'BLOCKED').length,
        duplicate_findings: rs.reduce((acc, r) => acc + r.findings.filter((f) => f.occurrences > 1).length, 0),
        duration_ms: { min: Math.min(...d), max: Math.max(...d), mean: Math.round(d.reduce((a, b) => a + b, 0) / d.length), all: d },
      };
    }),
    per_run: runs.map((run, i) => ({ run: i + 1, results: run.map((r) => ({ id: r.scenario.id, status: r.status, duration_ms: r.duration_ms, fingerprints: fps(r) })) })),
  };
  const deterministic = report.scenarios.every((s) => s.deterministic_status && s.distinct_finding_sets === 1 && s.harness_errors === 0 && s.blocked === 0);
  writeFileSync(join(base.paths.evidence, 'reliability.json'), JSON.stringify({ ...report, deterministic }, null, 2));

  console.log(`\nReliability over ${n} runs  (same app state -> same verdict + same fingerprints?)`);
  console.log(`  ${pad('scenario', 14)}${pad('verdicts', 26)}${pad('finding-sets', 14)}${pad('baseline', 10)}${pad('dup', 5)}duration ms (min/mean/max)`);
  for (const s of report.scenarios) {
    const v = Object.entries(s.status_counts).map(([k, c]) => `${k}x${c}`).join(' ');
    console.log(`  ${pad(s.id, 14)}${pad(v, 26)}${pad(String(s.distinct_finding_sets), 14)}${pad(s.matches_baseline_every_run === null ? 'n/a' : s.matches_baseline_every_run ? 'match' : 'DIFF', 10)}${pad(String(s.duplicate_findings), 5)}${s.duration_ms.min}/${s.duration_ms.mean}/${s.duration_ms.max}`);
  }
  console.log(`\n${deterministic ? 'DETERMINISTIC' : 'NON-DETERMINISTIC'}  ->  ${join(base.paths.evidence, 'reliability.json')}`);
  return deterministic ? 0 : 1;
}

/**
 * Per-scenario categories (a scenario can carry several):
 *   NEW_DEFECT              findings absent from the baseline               -> counts as detection
 *   STABLE_BASELINE         stable baseline findings still present           -> never counted as detection
 *   INTERMITTENT            intermittent/transient baseline findings present -> never counted, flagged
 *   BASELINE_DEFECT_MASKED  stable baseline findings that disappeared        -> SUSPICIOUS, never a "fix"
 *   UNCHANGED_PASS          nothing at all, as in the baseline
 * Mutation outcomes:
 *   DETECTED                           new defects, no masking
 *   DETECTED_WITH_MASKING (suspicious) new defects AND a stable baseline defect vanished
 *   MASKED_ONLY (suspicious, missed)   the only observable change is a baseline defect vanishing
 *   MISSED                             no new defect anywhere
 */
type MutationOutcome = 'DETECTED' | 'DETECTED_WITH_MASKING' | 'MASKED_ONLY' | 'MISSED' | 'INVALID';

async function mutationCheck(browser: Browser, base: QaConfig, runId: string, runsForBaseline: number): Promise<number> {
  let baseline = loadBaseline(base.paths.root);
  if (!baseline) {
    console.log('No baseline found: recording one first.\n');
    const rec = await recordBaseline(browser, base, runsForBaseline, `${runId}-auto`);
    if (!rec.baseline) return rec.code;
    baseline = rec.baseline;
  }
  const drift = baselineDrift(baseline, versionInfo(base.paths.root));
  for (const d of drift) console.log(`⚠ ${d}`);
  const index = baselineIndex(baseline);
  const nonStable = baseline.findings.filter((f) => f.baseline_state !== 'STABLE_BASELINE');
  for (const f of nonStable) console.log(`⚠ baseline finding ${f.fingerprint} is ${f.baseline_state} (seen ${f.seen_in_runs}/${f.runs_total}) — kept visible, never used as detection`);

  // 0. Mutations must not share locators with detectors.
  const decoupling = mutationDecouplingViolations(base.paths.root);
  console.log(`mutation/detector decoupling: ${decoupling.length ? `VIOLATIONS: ${decoupling.join('; ')}` : 'clean (no shared test ids, registry selectors or state classes)'}`);

  // 1. The clean app must reproduce the baseline, or attribution is meaningless.
  console.log(`\n=== clean verification against baseline ${baseline.baseline_id}`);
  const cleanCfg = isolatedMemory(withEvidenceDir(base, '_mutations', '_clean'));
  const clean = await runSet(browser, scenarios, cleanCfg, `${runId}-clean`, 'mutation-clean', { baseline: index }, false);
  const cleanDiffs = clean.map((r) => ({ id: r.scenario.id, status: r.status, expected_status: baseline!.scenarios[r.scenario.id]?.stable_status ?? null, ...diffAgainstBaseline(fps(r), index.byScenario.get(r.scenario.id)) }));
  const reproduced = cleanDiffs.every((d) => d.new.length === 0 && d.masked.length === 0 && (d.expected_status === null || d.status === d.expected_status));
  console.log(`clean app ${reproduced ? 'REPRODUCES' : 'DOES NOT REPRODUCE'} the baseline`);

  // 2. Every mutation x EVERY scenario. `expectedToFail` is a report annotation only.
  const report = [];
  for (const m of MUTATIONS) {
    console.log(`\n=== mutation ${m.name}: ${m.description}`);
    // Fresh healing memory per mutation: each is judged on its own, independent of run order.
    const cfg: QaConfig = { ...isolatedMemory(withEvidenceDir(base, '_mutations', m.name)), mutation: m };
    const results = await runSet(browser, scenarios, cfg, `${runId}-${m.name}`, 'mutation', { baseline: index }, false);
    const rows = results.map((r) => {
      const d = diffAgainstBaseline(fps(r), index.byScenario.get(r.scenario.id));
      const invalid = r.status === 'HARNESS_ERROR' || r.status === 'BLOCKED';
      const categories = invalid
        ? [r.status as string]
        : [d.new.length && 'NEW_DEFECT', d.known_stable.length && 'STABLE_BASELINE', d.known_intermittent.length && 'INTERMITTENT', d.masked.length && 'BASELINE_DEFECT_MASKED'].filter((x): x is string => !!x);
      if (!categories.length) categories.push('UNCHANGED_PASS');
      return {
        id: r.scenario.id,
        status: r.status,
        categories,
        ...d,
        new_findings: r.findings.filter((f) => d.new.includes(f.fingerprint)).map((f) => ({ fingerprint: f.fingerprint, check_id: f.check_id, target: f.target, failure_type: f.failure_type, state: f.state })),
        masked_findings: baseline!.findings.filter((f) => d.masked.includes(f.fingerprint)).map((f) => ({ fingerprint: f.fingerprint, check_id: f.check_id, target: f.target })),
      };
    });
    const detectedBy = rows.filter((x) => x.new.length > 0).map((x) => x.id);
    const masking = rows.filter((x) => x.masked.length > 0).map((x) => x.id);
    const invalid = rows.filter((x) => x.status === 'HARNESS_ERROR' || x.status === 'BLOCKED').map((x) => x.id);
    const outcome: MutationOutcome = invalid.length ? 'INVALID' : detectedBy.length ? (masking.length ? 'DETECTED_WITH_MASKING' : 'DETECTED') : masking.length ? 'MASKED_ONLY' : 'MISSED';
    const expectation = evaluateExpectation(m, results, rows, !!base.resolver?.configured);
    report.push({
      mutation: m.name,
      description: m.description,
      expectation: m.expect?.kind ?? 'detected',
      expectation_met: expectation.met,
      expectation_detail: expectation.detail,
      healing: totalHealing(results),
      outcome: m.expect && m.expect.kind !== 'detected' ? expectation.outcome : outcome,
      suspicious: masking.length > 0,
      expected_detectors: m.expectedToFail,
      detected_by: detectedBy,
      masking_in: masking,
      unexpected_detectors: detectedBy.filter((id) => !m.expectedToFail.includes(id)),
      missed_expected: m.expectedToFail.filter((id) => !detectedBy.includes(id)),
      harness_or_blocked: invalid,
      scenarios: rows,
    });
    for (const x of rows) console.log(`    ${pad(x.id, 14)} ${pad(x.categories.join(' + '), 52)} stable=${x.known_stable.length} intermittent=${x.known_intermittent.length} new=${x.new.length} masked=${x.masked.length}`);
  }

  const detected = (o: string) => o === 'DETECTED' || o === 'DETECTED_WITH_MASKING';
  const allDetected = report.every((r) => r.expectation_met);
  const noHarness = report.every((r) => r.harness_or_blocked.length === 0) && clean.every((r) => r.status !== 'HARNESS_ERROR' && r.status !== 'BLOCKED');
  // A baseline finding (any state) must never be counted as a mutation's detection:
  const misattributed = report.flatMap((r) => r.scenarios.flatMap((s) => s.new.filter((fp) => [...index.byScenario.values()].some((m) => m.has(fp))).map((fp) => `${r.mutation}/${s.id}/${fp}`)));
  const product = versionInfo(base.paths.root).app;
  const out = {
    run_id: runId,
    baseline_id: baseline.baseline_id,
    baseline_drift: drift,
    non_stable_baseline_findings: nonStable.map((f) => ({ fingerprint: f.fingerprint, state: f.baseline_state, seen: `${f.seen_in_runs}/${f.runs_total}` })),
    decoupling_violations: decoupling,
    clean_reproduces_baseline: reproduced,
    clean: cleanDiffs,
    mutations: report,
    all_detected: allDetected,
    suspicious_mutations: report.filter((r) => r.suspicious).map((r) => r.mutation),
    misattributed_baseline_findings: misattributed,
    product_dirty: product.product_dirty,
    product_dirty_files: product.dirty_files,
  };
  writeFileSync(join(base.paths.evidence, 'mutation-report.json'), JSON.stringify(out, null, 2));

  console.log('\nMutation validation');
  console.log(`  clean app reproduces baseline: ${reproduced ? 'yes' : 'NO'}`);
  for (const r of report) {
    const note = [
      r.suspicious && `SUSPICIOUS: stable baseline defect masked in ${r.masking_in.join(', ')}`,
      r.missed_expected.length && `expected but silent: ${r.missed_expected.join(', ')}`,
      r.unexpected_detectors.length && `also: ${r.unexpected_detectors.join(', ')}`,
    ].filter(Boolean).join('; ');
    const how = r.expectation === 'detected' ? `by ${r.detected_by.join(', ') || '-'}` : `${r.expectation_detail}`;
    console.log(`  ${r.expectation_met ? '✓' : '✗'} ${pad(r.outcome, 24)} ${pad(r.mutation, 24)} ${how}${note ? `   (${note})` : ''}`);
    if (r.expectation !== 'detected') console.log(`      healing: actions ${r.healing.total_actions}, healed ${r.healing.healed_actions} (memory ${r.healing.memory_hits}, local ${r.healing.local_recoveries}, llm ${r.healing.llm_successes}), LLM calls ${r.healing.llm_calls}, unresolved ${r.healing.unresolved}, rejected ${r.healing.rejected}`);
  }
  console.log(`  baseline findings misattributed to a mutation: ${misattributed.length}`);
  console.log(`  mutation/detector decoupling violations: ${decoupling.length}`);
  console.log(`  product source modified: ${product.product_dirty ? `YES (${product.dirty_files.join(', ')})` : 'no'}`);
  console.log(`\n${report.filter((r) => r.expectation_met).length}/${report.length} mutations met their expectation (${report.filter((r) => detected(r.outcome)).length} detected, ${report.filter((r) => r.expectation !== 'detected' && r.expectation_met).length} healing), ${out.suspicious_mutations.length} suspicious  ->  ${join(base.paths.evidence, 'mutation-report.json')}`);
  if (!noHarness) return 3;
  return reproduced && allDetected && misattributed.length === 0 && decoupling.length === 0 && !product.product_dirty ? 0 : 1;
}

async function runSelectorAudit(browser: Browser, base: QaConfig): Promise<number> {
  const ctx = await browser.newContext({ viewport: base.defaultViewport });
  const page = await ctx.newPage();
  await page.goto(base.cockpitUrl);
  await page.locator(EL.deviceRows.css).first().waitFor({ timeout: base.appReadyTimeoutMs });
  const rows = await selectorAudit(page);
  await ctx.close();
  const order: Strategy[] = ['testid', 'role', 'relational', 'structural', 'class-state'];
  rows.sort((a, b) => order.indexOf(a.strategy) - order.indexOf(b.strategy));
  console.log(`${pad('element', 18)}${pad('strategy', 13)}${pad('matches', 9)}selector`);
  for (const r of rows) console.log(`${pad(r.name, 18)}${pad(r.strategy, 13)}${pad(String(r.matches), 9)}${r.css}${r.note ? `   — ${r.note}` : ''}`);
  const counts = order.map((s) => `${s} ${rows.filter((r) => r.strategy === s).length}`).join(' · ');
  const xpath = rows.filter((r) => r.css.includes('xpath')).length;
  const broken = rows.filter((r) => r.matches === 0 && r.name !== 'alertToast');
  writeFileSync(join(base.paths.evidence, 'selector-audit.json'), JSON.stringify({ counts: Object.fromEntries(order.map((s) => [s, rows.filter((r) => r.strategy === s).length])), xpath, rows }, null, 2));
  console.log(`
${counts} · xpath ${xpath}${broken.length ? `
UNRESOLVED: ${broken.map((b) => b.name).join(', ')}` : ''}`);
  return broken.length ? 1 : 0;
}

function isolatedMemory(cfg: QaConfig): QaConfig {
  const file = join(cfg.paths.evidence, 'healing-memory.json');
  rmSync(file, { force: true });
  return { ...cfg, paths: { ...cfg.paths, healingMemory: file } };
}

/**
 * Healing mutations are judged on what they are meant to prove (see MutationExpectation), in the
 * scenarios they name. Other scenarios are still reported (categories above) but do not decide this.
 */
function evaluateExpectation(m: (typeof MUTATIONS)[number], results: ScenarioResult[], rows: Array<{ id: string; new: string[] }>, llmConfigured: boolean): { met: boolean; outcome: string; detail: string } {
  const e = m.expect;
  if (!e || e.kind === 'detected') {
    const by = rows.filter((x) => x.new.length > 0).map((x) => x.id);
    return { met: by.length > 0, outcome: by.length ? 'DETECTED' : 'MISSED', detail: by.join(', ') };
  }
  const per = e.scenarios.map((id) => {
    const r = results.find((x) => x.scenario.id === id);
    const h = r?.healing?.summary;
    const row = rows.find((x) => x.id === id);
    if (!r || !h || !row) return { id, ok: false, why: 'scenario not run' };
    const acts = r.healing!.actions;
    const healedOk = r.status === 'PASS' && h.healed_actions > 0 && h.healing_failures === 0 && h.unresolved === 0 && h.rejected === 0 && row.new.length === 0 && acts.filter((a) => a.mode === 'action' && a.outcome.startsWith('HEALED')).every((a) => a.postcondition === 'satisfied');
    if (e.kind === 'healed' || (e.kind === 'healed-if-llm' && llmConfigured)) return { id, ok: healedOk, why: healedOk ? `PASS via healing (${h.healed_actions} healed, ${h.llm_calls} LLM calls)` : `status ${r.status}, healed ${h.healed_actions}, unresolved ${h.unresolved}, failures ${h.healing_failures}, new findings ${row.new.length}` };
    if (e.kind === 'healed-if-llm') {
      const ok = h.unresolved > 0 && h.llm_calls === 0 && acts.filter((a) => a.outcome === 'HEALING_UNRESOLVED').every((a) => a.clicks_dispatched === 0) && r.findings.some((f) => f.failure_type === 'unresolved_target');
      return { id, ok, why: ok ? 'no LLM provider configured: refused cleanly (unresolved, 0 LLM calls, 0 clicks)' : 'expected a clean unresolved refusal' };
    }
    const ok = h.rejected > 0 && acts.filter((a) => a.outcome === 'HEALING_REJECTED').every((a) => a.clicks_dispatched === 0) && r.findings.some((f) => f.failure_type === 'ambiguous_target') && !r.findings.some((f) => f.check_id === 'healing.no_unintended_action');
    return { id, ok, why: ok ? 'refused to guess (HEALING_REJECTED, 0 clicks, map unchanged)' : 'expected a rejection with no action' };
  });
  const met = per.every((x) => x.ok);
  const outcome = !met ? 'EXPECTATION_NOT_MET' : e.kind === 'rejected' ? 'REJECTED_AS_EXPECTED' : e.kind === 'healed-if-llm' && !llmConfigured ? 'UNRESOLVED_AS_EXPECTED' : 'HEALED';
  return { met, outcome, detail: per.map((x) => `${x.id}: ${x.why}`).join('; ') };
}

/**
 * Cost proof on one selector mutation (heal-label-changed, scenario-006), fresh memory:
 *   phase 1  known selector fails -> local LOW -> LLM (if configured) -> verified -> memory written
 *   phase 2  same mutation, same memory -> memory hits, LLM calls must be 0
 *   phase 3  heal-ambiguous with the phase-2 memory -> remembered target no longer unique -> stale,
 *            refusal, nothing clicked (stale memory never redirects an action)
 */
async function healingDemo(browser: Browser, base: QaConfig, runId: string): Promise<number> {
  const s6 = scenarios.find((s) => s.id === 'scenario-006')!;
  const dir = withEvidenceDir(base, '_healing-demo');
  const memoryFile = join(dir.paths.evidence, 'healing-memory.json');
  rmSync(memoryFile, { force: true });
  const phases = [
    { name: 'run 1: heal-label-changed, empty memory', mutation: findMutation('heal-label-changed') },
    { name: 'run 2: heal-label-changed, learned memory', mutation: findMutation('heal-label-changed') },
    { name: 'run 3: heal-ambiguous, same memory (now stale)', mutation: findMutation('heal-ambiguous') },
  ];
  const out = [];
  for (const [i, ph] of phases.entries()) {
    console.log(`\n=== ${ph.name}`);
    const cfg: QaConfig = { ...withEvidenceDir(base, '_healing-demo', `phase-${i + 1}`), mutation: ph.mutation, paths: { ...base.paths, evidence: join(dir.paths.evidence, `phase-${i + 1}`), healingMemory: memoryFile } };
    const [r] = await runSet(browser, [s6], cfg, `${runId}-demo-${i + 1}`, 'healing-demo', {}, true);
    out.push({ phase: ph.name, status: r.status, healing: r.healing?.summary, actions: r.healing?.actions.map((a) => ({ step_id: a.step_id, mode: a.mode, outcome: a.outcome, tier: a.recovery_tier, confidence: a.recovery_confidence, llm_attempt: a.llm_attempt, llm_latency_ms: a.llm_latency_ms, llm_tokens: a.llm_tokens, memory_hit: a.memory_hit, memory_stale: a.memory_stale, recovery_latency_ms: a.recovery_latency_ms, clicks: a.clicks_dispatched, postcondition: a.postcondition, target: a.healed_description, reason: a.reason })) });
  }
  const provider = base.resolver?.provider ?? 'none';
  writeFileSync(join(dir.paths.evidence, 'healing-demo.json'), JSON.stringify({ run_id: runId, provider, model: base.resolver?.model ?? null, llm_configured: !!base.resolver?.configured, phases: out }, null, 2));
  console.log(`\nCost proof  (tier-3 provider: ${provider}${base.resolver?.model ? ` ${base.resolver.model}` : ''}${base.resolver?.configured ? '' : ' — NOT configured'})`);
  console.log(`  ${pad('phase', 48)}${pad('verdict', 14)}${pad('actions', 9)}${pad('memory', 8)}${pad('local', 7)}${pad('LLM calls', 11)}${pad('LLM ms', 8)}${pad('stale', 7)}${pad('unres.', 8)}rejected`);
  for (const o of out) {
    const h = o.healing!;
    console.log(`  ${pad(o.phase, 48)}${pad(o.status, 14)}${pad(String(h.total_actions), 9)}${pad(String(h.memory_hits), 8)}${pad(String(h.local_recoveries), 7)}${pad(String(h.llm_calls), 11)}${pad(String(h.llm_latency_ms_total), 8)}${pad(String(h.memory_stale), 7)}${pad(String(h.unresolved), 8)}${h.rejected}`);
  }
  console.log(`\n-> ${join(dir.paths.evidence, 'healing-demo.json')}  (memory: ${memoryFile})`);
  return 0;
}

/**
 * Level-2: performance scenarios through the same executor (verdicts, evidence, history), then the
 * performance verdict/boundary per scenario and evidence/performance-summary.{json,md}.
 */
async function perfRun(browser: Browser, base: QaConfig, args: Args, runId: string): Promise<number> {
  const chosen = select(perfScenarios, args);
  if (chosen.length === 0) throw new Error('no performance scenarios selected (P001, P002, P003)');
  if (args.recordBaseline) {
    perfConfig.mode.recordBaselineOnly = true;
    if (!chosen.some((s) => s.id === 'P001')) throw new Error('--record-baseline with --perf records the P001 (N=4) profile');
  }
  const run = args.recordBaseline ? chosen.filter((s) => s.id === 'P001') : chosen;
  console.log(`Level-2 performance: ${run.map((s) => s.id).join(' -> ')}${args.recordBaseline ? '  (baseline profile only)' : ''}`);
  console.log(`  limits: <=${perfConfig.safety.maxDrones} drones, <=${perfConfig.safety.maxSimSpeed}x, <=${perfConfig.safety.maxScenarioVideoStreams} scenario video streams, >=${perfConfig.safety.minInteractionIntervalMs} ms between interactions, ${perfConfig.safety.scenarioTimeoutMs / 1000}s workload timeout\n`);
  const startedAt = new Date().toISOString();
  const results = await runSet(browser, run, base, runId, 'performance', {});
  const perf: PerformanceRun = {
    schema: 'cockpit-qa/performance-run@1',
    run_id: runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    scenarios: results.map((r) => {
      const p = perfResults.get(r.scenario.id);
      return { id: r.scenario.id, status: r.status, verdict: p?.verdict ?? (r.status === 'BLOCKED' ? 'BLOCKED' : 'HARNESS_ERROR'), safe_capacity: p?.knee?.safe_capacity ?? null, degradation_onset: p?.knee?.degradation_onset ?? null, evidence_dir: r.evidence_dir };
    }),
  };
  console.log('\nPerformance');
  for (const r of results) {
    const p = perfResults.get(r.scenario.id);
    if (!p) {
      console.log(`  ${pad(r.scenario.id, 6)} no performance result (${r.status}: ${r.status_reason})`);
      continue;
    }
    console.log(`  ${pad(r.scenario.id, 6)} ${pad(p.verdict, 22)} ${p.verdict_reason.slice(0, 160)}`);
    if (p.knee) console.log(`         safe capacity ${p.knee.safe_capacity ?? 'none'} · degradation onset ${p.knee.degradation_onset ?? 'not observed'} · ${p.knee.reason}`);
    for (const sig of p.bottleneck_signals) console.log(`         signal (${sig.strength}): ${sig.statement.slice(0, 220)}`);
    if (p.cleanup) console.log(`         cleanup ${p.cleanup.ok ? 'ok' : 'INCOMPLETE'} · back at baseline: ${p.cleanup.verified_baseline}`);
    console.log(`         ${join(r.evidence_dir, 'summary.md')}`);
  }
  console.log(`\n-> ${writeRunSummary(base.paths.evidence, perf, [...perfResults.values()])}`);
  return EXIT[worst(results)];
}

// ---------------------------------------------------------------------------------------------- main

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const s of scenarios) console.log(`${s.id}  ${s.title}  [${(s.tags ?? []).join(', ')}]`);
    return 0;
  }
  if (args.listMutations) {
    for (const m of MUTATIONS) console.log(`${pad(m.name, 24)} expected detectors: ${pad(m.expectedToFail.join(', '), 28)} ${m.description}`);
    return 0;
  }

  if (args.perf && args.selfTest) return perfSelfTest();

  const resolver = resolverFromEnv();
  const base: QaConfig = { ...qaConfig, headless: args.headed ? false : qaConfig.headless, resolver };
  if (args.resetHealingMemory) rmSync(base.paths.healingMemory, { force: true });
  mkdirSync(base.paths.evidence, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const v = versionInfo(base.paths.root);
  console.log(`cockpit-qa ${runId}  harness ${v.harness.version}+${v.harness.source_hash}  app ${v.app.git_commit?.slice(0, 8) ?? '?'}${v.app.product_dirty ? ' (product modified!)' : ''}`);
  console.log(`  cockpit ${base.cockpitUrl}   api ${base.apiUrl}`);
  // Provider and model only — never the key.
  console.log(`  healing: tier-3 resolver ${resolver.provider}${resolver.model ? ` (${resolver.model})` : ''}${resolver.provider !== 'none' ? (resolver.configured ? ' — key present' : ' — NO KEY, tier 3 disabled') : ' — deterministic tiers only'} · memory ${base.paths.healingMemory}\n`);

  // Perf runs: precise performance.memory (otherwise Chromium quantizes/caches it).
  const browser = await launchBrowser(base, args.perf ? ['--enable-precise-memory-info'] : []);
  const onSigint = async () => {
    console.error('\ninterrupted: restoring the shared stack');
    for (const l of activeLedgers) await l.cleanup().catch(() => undefined);
    process.exit(130);
  };
  process.once('SIGINT', onSigint);
  try {
    if (args.perf) return await perfRun(browser, base, args, runId);
    if (args.selfTest) return await selfTest(browser, withEvidenceDir(base, '_selftest'));
    if (args.selectorAudit) return await runSelectorAudit(browser, base);
    if (args.recordBaseline) return (await recordBaseline(browser, base, args.runs, runId)).code;
    if (args.mutationCheck) return await mutationCheck(browser, base, runId, args.runs);
    if (args.healingDemo) return await healingDemo(browser, base, runId);

    const baseline = args.noBaseline ? null : loadBaseline(base.paths.root);
    if (baseline) {
      console.log(`baseline ${baseline.baseline_id} (${baseline.findings.length} known finding(s))`);
      for (const d of baselineDrift(baseline, v)) console.log(`⚠ ${d}`);
      console.log('');
    }
    const opts: RunOptions = baseline ? { baseline: baselineIndex(baseline) } : {};
    const chosen = select(scenarios, args);
    if (chosen.length === 0) throw new Error('no scenarios selected');

    if (args.repeat) return await reliability(browser, base, chosen, args.repeat, runId, opts);

    const mutation = args.mutate ? findMutation(args.mutate) : undefined;
    const config: QaConfig = mutation ? { ...withEvidenceDir(base, '_mutations', mutation.name), mutation } : base;
    if (mutation) console.log(`MUTATION ${mutation.name}: ${mutation.description}\n`);
    const results = await runSet(browser, chosen, config, runId, mutation ? 'mutation' : 'run', opts);

    const count = (s: ScenarioStatus) => results.filter((r) => r.status === s).length;
    // Without a baseline every finding is new; with one, only NEW_DEFECT is.
    const newFindings = results.flatMap((r) => r.findings.filter((f) => !f.baseline_state || f.baseline_state === 'NEW_DEFECT'));
    const byState = (st: string) => results.reduce((a, r) => a + r.findings.filter((f) => f.baseline_state === st).length, 0);
    const masked = results.flatMap((r) => (r.baseline_comparison?.masked ?? []).map((fp) => `${r.scenario.id}/${fp}`));
    const summary = {
      run_id: runId,
      mutation: mutation?.name ?? null,
      baseline_id: baseline?.baseline_id ?? null,
      versions: v,
      totals: { total: results.length, PASS: count('PASS'), DEFECT_FOUND: count('DEFECT_FOUND'), BLOCKED: count('BLOCKED'), HARNESS_ERROR: count('HARNESS_ERROR') },
      healing: { provider: config.resolver?.provider ?? 'none', model: config.resolver?.model ?? null, ...totalHealing(results) },
      findings: { total: results.reduce((a, r) => a + r.findings.length, 0), STABLE_BASELINE: byState('STABLE_BASELINE'), INTERMITTENT: byState('INTERMITTENT'), TRANSIENT: byState('TRANSIENT'), UNCONFIRMED: byState('UNCONFIRMED'), NEW_DEFECT: newFindings.length, BASELINE_DEFECT_MASKED: masked },
      scenarios: results.map((r) => ({
        id: r.scenario.id, title: r.scenario.title, status: r.status, status_reason: r.status_reason, duration_ms: r.duration_ms,
        findings: r.findings.map((f) => ({ fingerprint: f.fingerprint, check_id: f.check_id, target: f.target, failure_type: f.failure_type, baseline_state: f.baseline_state ?? null, incident: f.incident })),
        evidence_dir: r.evidence_dir,
      })),
    };
    writeFileSync(join(config.paths.evidence, 'summary.json'), JSON.stringify(summary, null, 2));
    const t = summary.totals;
    const ht = summary.healing;
    console.log(`\nhealing: actions ${ht.total_actions} · healed ${ht.healed_actions} (memory ${ht.memory_hits}, local ${ht.local_recoveries}, llm ${ht.llm_successes}) · LLM calls ${ht.llm_calls} [${ht.provider}] · unresolved ${ht.unresolved} · rejected ${ht.rejected} · healing failures ${ht.healing_failures}`);
    console.log(`\nPASS ${t.PASS} · DEFECT_FOUND ${t.DEFECT_FOUND} · BLOCKED ${t.BLOCKED} · HARNESS_ERROR ${t.HARNESS_ERROR}` + (baseline ? `   findings: ${summary.findings.STABLE_BASELINE} stable-baseline, ${summary.findings.INTERMITTENT + summary.findings.TRANSIENT} intermittent/transient, ${summary.findings.NEW_DEFECT} new${masked.length ? `, ${masked.length} BASELINE_DEFECT_MASKED` : ''}` : '') + `  ->  ${join(config.paths.evidence, 'summary.json')}`);

    let w = worst(results);
    if (w === 'DEFECT_FOUND' && args.failOn === 'new' && baseline && newFindings.length === 0) w = 'PASS';
    return EXIT[w];
  } finally {
    await browser.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(3);
  },
);
