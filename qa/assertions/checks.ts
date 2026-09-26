/**
 * Structured soft-assertion recorder.
 *
 * Every check declares WHAT invariant it tests (`id`), WHICH user-visible thing it is about (`target`)
 * and HOW it can fail (`type`). Those three fields — never the human-readable message or raw numbers —
 * are what finding fingerprints are built from (runner/findings.ts), so the same symptom is recognised
 * across runs even when measured values jitter.
 *
 * A step produces a product defect only through a failed `error`-severity check. `warn` checks are
 * reported but never change the verdict. `precondition` failures mean the scenario could not establish
 * a valid starting point (BLOCKED), which is not a product defect.
 */

export type Severity = 'error' | 'warn';
export type Phase = 'action' | 'verify';

/** Closed vocabulary so fingerprints stay comparable. */
export type FailureType =
  | 'mismatch' // UI value != ground truth / expected value
  | 'missing' // expected element/row not present
  | 'unexpected' // element/row present that should not be
  | 'duplicate'
  | 'hidden' // present but not visible
  | 'out_of_viewport'
  | 'clipped' // cut off by an ancestor's overflow
  | 'covered' // another element receives the pointer
  | 'overlap' // two widgets intersect
  | 'overflow' // document scrolls horizontally
  | 'not_actionable' // a real user interaction could not be performed
  | 'ambiguous_target' // known selector gone; several elements equally match the intent -> healer refused
  | 'unresolved_target' // known selector gone; no confident semantic match -> healer refused
  | 'not_distinct' // state change not visually perceivable
  | 'timeout' // state never converged within the bound
  | 'lag' // converged, but slower than the allowed latency
  | 'order_violation' // UI ahead of / inconsistent with state machine order
  | 'non_monotonic'
  | 'invalid_state'
  | 'http_error'
  | 'wrong_route'
  | 'blank'
  | 'script_executed'
  | 'reflected'
  | 'leak'
  | 'uncaught_error'
  | 'unexpected_dialog';

export interface CheckSpec {
  /** Stable invariant/check id, e.g. "layout.pointer_reachable". Never contains run-specific data. */
  id: string;
  /** Semantic target, e.g. "testid:map-view-2d", "device:drone-4", "pair:map-view-toggle|video-tile". */
  target?: string;
  type: FailureType;
  /** Optional human label; defaults to `id [target]`. */
  name?: string;
}

export interface CheckDetails {
  expected?: unknown;
  actual?: unknown;
  message?: string;
  severity?: Severity;
  /**
   * Discrete, run-stable description of the failing state that belongs in the fingerprint
   * (e.g. the covering element's test id, or "standby->in_flight"). If omitted it is derived from
   * expected/actual only when both are short non-numeric primitives.
   */
  state?: string;
  /** Structured observations attached to the finding as evidence (geometry, traces...). Not fingerprinted. */
  observed?: Record<string, unknown>;
  /** Boxes to outline on the annotated failure screenshot. */
  boxes?: Array<{ label: string; rect: { x: number; y: number; width: number; height: number } }>;
}

export interface CheckResult {
  id: string;
  target: string | null;
  type: FailureType;
  name: string;
  phase: Phase;
  passed: boolean;
  severity: Severity;
  expected?: unknown;
  actual?: unknown;
  message?: string;
  state: string;
  observed?: Record<string, unknown>;
  boxes?: CheckDetails['boxes'];
}

/** A failed `require`: stop the step, the check is already recorded as a defect. */
export class HardStop extends Error {
  constructor(readonly check: CheckResult) {
    super(`${check.name}: ${check.message ?? 'required check failed'}`);
  }
}

/** The scenario cannot establish a valid result (missing service, unmet precondition). Not a defect. */
export class Blocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Blocked';
  }
}

function deriveState(expected: unknown, actual: unknown): string {
  const disc = (v: unknown): string | null => {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'string') return v.length <= 60 ? v : null;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length <= 8) return `[${[...v].sort().join(',')}]`;
    return null; // numbers and objects are observations, not identity
  };
  const e = disc(expected);
  const a = disc(actual);
  return e !== null && a !== null ? `${e}->${a}` : '';
}

export class Checks {
  readonly results: CheckResult[] = [];
  phase: Phase = 'action';

  private push(spec: CheckSpec, passed: boolean, d: CheckDetails): CheckResult {
    const r: CheckResult = {
      id: spec.id,
      target: spec.target ?? null,
      type: spec.type,
      name: spec.name ?? (spec.target ? `${spec.id} [${spec.target}]` : spec.id),
      phase: this.phase,
      passed,
      severity: d.severity ?? 'error',
      expected: d.expected,
      actual: d.actual,
      message: d.message,
      state: passed ? '' : d.state ?? deriveState(d.expected, d.actual),
      observed: passed ? undefined : d.observed,
      boxes: passed ? undefined : d.boxes,
    };
    this.results.push(r);
    return r;
  }

  that(spec: CheckSpec, passed: boolean, details: CheckDetails = {}): boolean {
    this.push(spec, passed, details);
    return passed;
  }

  equal<T>(spec: CheckSpec, actual: T, expected: T, details: Omit<CheckDetails, 'expected' | 'actual'> = {}): boolean {
    return this.that(spec, JSON.stringify(actual) === JSON.stringify(expected), { ...details, expected, actual });
  }

  near(spec: CheckSpec, actual: number | null, expected: number, tolerance: number, details: Omit<CheckDetails, 'expected' | 'actual'> = {}): boolean {
    const passed = actual !== null && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
    return this.that(spec, passed, { ...details, expected: `${expected} ± ${tolerance}`, actual, state: details.state ?? (actual === null ? 'no-reading' : '') });
  }

  warn(spec: CheckSpec, passed: boolean, details: CheckDetails = {}): boolean {
    return this.that(spec, passed, { ...details, severity: 'warn' });
  }

  /** Like `that`, but aborts the step when it fails (later checks would be meaningless). */
  require(spec: CheckSpec, passed: boolean, details: CheckDetails = {}): void {
    const r = this.push(spec, passed, details);
    if (!passed) throw new HardStop(r);
  }

  /** Environment/precondition gate: failing means BLOCKED, not a defect. Not recorded as a check. */
  precondition(description: string, passed: boolean, detail?: unknown): void {
    if (!passed) throw new Blocked(`precondition not met: ${description}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`);
  }

  get failed(): CheckResult[] {
    return this.results.filter((r) => !r.passed && r.severity === 'error');
  }

  get warnings(): CheckResult[] {
    return this.results.filter((r) => !r.passed && r.severity === 'warn');
  }
}

export function describeCheck(c: CheckResult): string {
  if (c.message) return `${c.name}: ${c.message}`;
  return `${c.name}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`;
}
