import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FailureType } from '../assertions/checks.js';
import type { ScenarioResult, ScenarioStatus } from './executor.js';
import type { VersionInfo } from './version.js';

/**
 * A baseline is the recorded behaviour of the *unmutated* application, established by actually
 * running the suite N times (default 3). It is what later runs and mutation validation diff against.
 *
 *   qa/baseline/baseline.json          identity, versions, per-scenario verdicts, every finding
 *   qa/baseline/evidence/<scenario>/   evidence copied from the last recording run (gitignored)
 *
 * Nothing about which scenario "should" fail is hardcoded: findings come only from execution.
 *
 * Each finding gets an explicit baseline state from how often it reproduced across the N runs.
 * Nothing is promoted: 2/3 stays INTERMITTENT, it never becomes STABLE_BASELINE.
 *   STABLE_BASELINE  seen in every run (N >= 2)
 *   INTERMITTENT     seen in more than one run but not all
 *   TRANSIENT        seen in exactly one of N >= 2 runs
 *   UNCONFIRMED      baseline recorded from a single run: reproducibility unknown
 */

export type BaselineState = 'STABLE_BASELINE' | 'INTERMITTENT' | 'TRANSIENT' | 'UNCONFIRMED';

export function baselineStateOf(seen: number, runs: number): BaselineState {
  if (runs < 2) return 'UNCONFIRMED';
  if (seen >= runs) return 'STABLE_BASELINE';
  return seen > 1 ? 'INTERMITTENT' : 'TRANSIENT';
}

export interface BaselineFinding {
  fingerprint: string;
  signature: string;
  scenario_id: string;
  check_id: string;
  target: string | null;
  failure_type: FailureType;
  state: string;
  summary: string;
  observed_values: { expected?: unknown; actual?: unknown; observed?: Record<string, unknown> };
  seen_in_runs: number;
  runs_total: number;
  baseline_state: BaselineState;
  /** true only for STABLE_BASELINE. */
  stable: boolean;
  first_seen: string;
  evidence_dir: string;
  evidence_files: Record<string, string>;
}

export interface BaselineScenario {
  title: string;
  invariant: string;
  statuses: ScenarioStatus[];
  /** Verdict if identical in every run, else null (unstable). */
  stable_status: ScenarioStatus | null;
  fingerprints: string[];
  evidence_dir: string;
}

export interface Baseline {
  schema: 'cockpit-qa/baseline@1';
  baseline_id: string;
  recorded_at: string;
  runs: number;
  stable: boolean;
  versions: VersionInfo;
  environment: { cockpitUrl: string; apiUrl: string; browser: string };
  scenarios: Record<string, BaselineScenario>;
  findings: BaselineFinding[];
}

export const baselineDir = (qaRoot: string) => join(qaRoot, 'baseline');
export const baselineFile = (qaRoot: string) => join(baselineDir(qaRoot), 'baseline.json');

/** Build and persist a baseline from N complete clean runs (each run = results for every scenario). */
export function writeBaseline(qaRoot: string, baselineId: string, runs: ScenarioResult[][]): Baseline {
  const last = runs[runs.length - 1];
  const dir = baselineDir(qaRoot);
  const evidenceRoot = join(dir, 'evidence');
  rmSync(evidenceRoot, { recursive: true, force: true });
  mkdirSync(evidenceRoot, { recursive: true });

  const scenarios: Record<string, BaselineScenario> = {};
  const findings = new Map<string, BaselineFinding>();
  for (const r of last) {
    const all = runs.map((run) => run.find((x) => x.scenario.id === r.scenario.id)!);
    const statuses = all.map((x) => x.status);
    const archived = join(evidenceRoot, r.scenario.id);
    if (existsSync(r.evidence_dir)) cpSync(r.evidence_dir, archived, { recursive: true });
    scenarios[r.scenario.id] = {
      title: r.scenario.title,
      invariant: r.scenario.invariant,
      statuses,
      stable_status: statuses.every((s) => s === statuses[0]) ? statuses[0] : null,
      fingerprints: [],
      evidence_dir: archived,
    };
    for (const run of all) {
      for (const f of run.findings) {
        const e = findings.get(f.fingerprint);
        if (e) {
          e.seen_in_runs += 1;
          continue;
        }
        findings.set(f.fingerprint, {
          fingerprint: f.fingerprint,
          signature: f.signature,
          scenario_id: f.scenario_id,
          check_id: f.check_id,
          target: f.target,
          failure_type: f.failure_type,
          state: f.state,
          summary: f.summary,
          observed_values: { expected: f.expected, actual: f.actual, observed: f.observed },
          seen_in_runs: 1,
          runs_total: runs.length,
          baseline_state: 'TRANSIENT',
          stable: false,
          first_seen: run.finished_at,
          evidence_dir: archived,
          evidence_files: f.evidence.files,
        });
      }
    }
  }
  for (const f of findings.values()) {
    f.baseline_state = baselineStateOf(f.seen_in_runs, runs.length);
    f.stable = f.baseline_state === 'STABLE_BASELINE';
    scenarios[f.scenario_id].fingerprints.push(f.fingerprint);
  }
  for (const s of Object.values(scenarios)) s.fingerprints.sort();

  const baseline: Baseline = {
    schema: 'cockpit-qa/baseline@1',
    baseline_id: baselineId,
    recorded_at: new Date().toISOString(),
    runs: runs.length,
    stable: Object.values(scenarios).every((s) => s.stable_status !== null) && [...findings.values()].every((f) => f.stable),
    versions: last[0].versions,
    environment: { cockpitUrl: last[0].environment.cockpitUrl, apiUrl: last[0].environment.apiUrl, browser: last[0].environment.browser },
    scenarios,
    findings: [...findings.values()].sort((a, b) => a.signature.localeCompare(b.signature)),
  };
  writeFileSync(baselineFile(qaRoot), JSON.stringify(baseline, null, 2));
  return baseline;
}

export function loadBaseline(qaRoot: string): Baseline | null {
  const f = baselineFile(qaRoot);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, 'utf8')) as Baseline;
}

export interface BaselineIndex {
  id: string;
  /** scenario id -> (fingerprint -> baseline state) */
  byScenario: Map<string, Map<string, BaselineState>>;
}

/** Fingerprints per scenario with their baseline state, the shape the executor uses to tag findings. */
export function baselineIndex(b: Baseline): BaselineIndex {
  const byScenario = new Map<string, Map<string, BaselineState>>(Object.keys(b.scenarios).map((id) => [id, new Map()]));
  for (const f of b.findings) {
    // Baselines written before states existed: derive from seen/runs.
    const state = f.baseline_state ?? baselineStateOf(f.seen_in_runs, f.runs_total);
    (byScenario.get(f.scenario_id) ?? byScenario.set(f.scenario_id, new Map()).get(f.scenario_id)!).set(f.fingerprint, state);
  }
  return { id: b.baseline_id, byScenario };
}

export const stableSet = (m: Map<string, BaselineState> | undefined) => new Set([...(m ?? new Map()).entries()].filter(([, s]) => s === 'STABLE_BASELINE' || s === 'UNCONFIRMED').map(([fp]) => fp));

/** Human-readable reasons the baseline may not be comparable with the current harness/app. */
export function baselineDrift(b: Baseline, now: VersionInfo): string[] {
  const out: string[] = [];
  if (b.versions.harness.source_hash !== now.harness.source_hash) out.push(`harness sources changed since baseline (${b.versions.harness.source_hash} -> ${now.harness.source_hash}); re-record with --record-baseline`);
  if (b.versions.app.git_commit !== now.app.git_commit) out.push(`product commit changed since baseline (${b.versions.app.git_commit?.slice(0, 8)} -> ${now.app.git_commit?.slice(0, 8)})`);
  if (now.app.product_dirty) out.push(`product working tree has local modifications: ${now.app.dirty_files.join(', ')}`);
  return out;
}
