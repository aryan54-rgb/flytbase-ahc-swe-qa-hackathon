import { createHash } from 'node:crypto';
import { describeCheck, type CheckResult, type FailureType } from '../assertions/checks.js';
import type { BaselineState } from './baseline.js';

/**
 * A finding is one violated product invariant. Its identity (fingerprint) is:
 *
 *   scenario_id | check_id | target | failure_type | state
 *
 * - check_id / target / failure_type come from the check's declared spec, never from message text.
 * - state is a discrete, run-stable descriptor (e.g. the covering element, "standby->in_flight").
 *   Numbers (areas, latencies, coordinates), timestamps and run ids are deliberately excluded; they
 *   are kept as `observed` evidence instead.
 * So the same underlying symptom gets the same fingerprint on every run, and a changed symptom
 * (different target, different covering element, different wrong value) gets a new one.
 */

export interface Finding {
  fingerprint: string;
  signature: string;
  scenario_id: string;
  check_id: string;
  target: string | null;
  failure_type: FailureType;
  state: string;
  step: string;
  phase: string;
  summary: string;
  expected?: unknown;
  actual?: unknown;
  observed?: Record<string, unknown>;
  /** How many times this exact fingerprint was raised in the scenario run (>1 = duplicate reports). */
  occurrences: number;
  /** Findings whose affected screen regions intersect share an incident (one root symptom, several views). */
  incident: string;
  /** Set when compared with a baseline: the finding's baseline state, or NEW_DEFECT if absent from it. */
  baseline_state?: BaselineState | 'NEW_DEFECT';
  evidence: { dir: string; files: Record<string, string> };
  boxes?: CheckResult['boxes'];
}

export function signatureOf(scenarioId: string, c: { id: string; target: string | null; type: FailureType; state: string }): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return [scenarioId, c.id, c.target ?? '-', c.type, norm(c.state || '-')].join(' | ');
}

export function fingerprintOf(signature: string): string {
  return createHash('sha1').update(signature).digest('hex').slice(0, 12);
}

interface RawFailure {
  step: string;
  check: CheckResult;
}

/** Build de-duplicated findings (one per fingerprint) from failed error-severity checks. */
export function buildFindings(scenarioId: string, failures: RawFailure[], evidence: { dir: string; files: Record<string, string> }): Finding[] {
  const byFp = new Map<string, Finding>();
  for (const { step, check } of failures) {
    const signature = signatureOf(scenarioId, check);
    const fingerprint = fingerprintOf(signature);
    const existing = byFp.get(fingerprint);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    byFp.set(fingerprint, {
      fingerprint,
      signature,
      scenario_id: scenarioId,
      check_id: check.id,
      target: check.target,
      failure_type: check.type,
      state: check.state,
      step,
      phase: check.phase,
      summary: describeCheck(check),
      expected: check.expected,
      actual: check.actual,
      observed: check.observed,
      occurrences: 1,
      incident: fingerprint,
      evidence,
      boxes: check.boxes,
    });
  }
  const findings = [...byFp.values()];
  clusterIncidents(findings);
  return findings;
}

/** Union findings whose outlined boxes intersect; incident id = smallest fingerprint in the cluster. */
function clusterIncidents(findings: Finding[]): void {
  const parent = findings.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const hit = (a: NonNullable<Finding['boxes']>[number]['rect'], b: typeof a) =>
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5;
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      const A = findings[i].boxes ?? [];
      const B = findings[j].boxes ?? [];
      if (A.some((a) => B.some((b) => hit(a.rect, b.rect)))) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Finding[]>();
  findings.forEach((f, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), f]));
  for (const g of groups.values()) {
    const id = g.map((f) => f.fingerprint).sort()[0];
    for (const f of g) f.incident = id;
  }
}

/**
 * Current findings vs a baseline, per scenario.
 *   known_stable        STABLE_BASELINE (or UNCONFIRMED) findings reproduced now
 *   known_intermittent  INTERMITTENT / TRANSIENT baseline findings seen now (still flagged, never hidden)
 *   new                 not in the baseline at all -> NEW_DEFECT
 *   masked              STABLE_BASELINE findings NOT reproduced now -> BASELINE_DEFECT_MASKED. Under a
 *                       mutation this is suspicious (the change hid a known defect); on the clean app
 *                       it means the defect was fixed or the environment changed. Never a silent "fix".
 *   absent_intermittent INTERMITTENT/TRANSIENT findings not seen now (expected to come and go)
 */
export interface BaselineDiff {
  known_stable: string[];
  known_intermittent: string[];
  new: string[];
  masked: string[];
  absent_intermittent: string[];
}

export function diffAgainstBaseline(current: Iterable<string>, baseline: Map<string, BaselineState> | undefined): BaselineDiff {
  const cur = new Set(current);
  const base = baseline ?? new Map<string, BaselineState>();
  const isStable = (s: BaselineState) => s === 'STABLE_BASELINE' || s === 'UNCONFIRMED';
  const sorted = (xs: string[]) => xs.sort();
  return {
    known_stable: sorted([...cur].filter((f) => base.has(f) && isStable(base.get(f)!))),
    known_intermittent: sorted([...cur].filter((f) => base.has(f) && !isStable(base.get(f)!))),
    new: sorted([...cur].filter((f) => !base.has(f))),
    masked: sorted([...base.entries()].filter(([f, st]) => isStable(st) && !cur.has(f)).map(([f]) => f)),
    absent_intermittent: sorted([...base.entries()].filter(([f, st]) => !isStable(st) && !cur.has(f)).map(([f]) => f)),
  };
}
