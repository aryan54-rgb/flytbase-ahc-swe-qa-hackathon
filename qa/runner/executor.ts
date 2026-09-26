import type { Browser } from 'playwright';
import { Blocked, Checks, describeCheck, HardStop, type CheckResult } from '../assertions/checks.js';
import { waitForDeviceRows } from '../assertions/cockpit.js';
import type { Scenario, ScenarioContext, StepContext } from '../scenarios/types.js';
import { ApiClient } from '../utils/api.js';
import { ui } from '../utils/selectors.js';
import type { QaConfig } from './config.js';
import { EvidenceRecorder } from './evidence.js';
import type { BaselineIndex } from './baseline.js';
import { buildFindings, diffAgainstBaseline, type BaselineDiff, type Finding } from './findings.js';
import { openScenarioFixture, type ScenarioFixture } from './fixture.js';
import { versionInfo, type VersionInfo } from './version.js';
import { HealingMemory } from '../healing/memory.js';
import { resolverFromEnv } from '../healing/resolver.js';
import { HealingSession, type HealingSummary } from '../healing/session.js';
import type { ActionRecord } from '../healing/types.js';

/**
 * Verdicts:
 *   PASS           scenario executed, every invariant held
 *   DEFECT_FOUND   scenario executed correctly and a product invariant was violated (>= 1 finding),
 *                  with complete evidence
 *   BLOCKED        a required service/state was unavailable; no valid verdict about the product
 *   HARNESS_ERROR  the QA system itself failed (unexpected exception, evidence not collected)
 *
 * When several apply, the least trustworthy wins: HARNESS_ERROR > BLOCKED > DEFECT_FOUND > PASS.
 * Findings observed before a BLOCKED/HARNESS_ERROR are still listed in the result.
 */
export type ScenarioStatus = 'PASS' | 'DEFECT_FOUND' | 'BLOCKED' | 'HARNESS_ERROR';
export const STATUS_RANK: Record<ScenarioStatus, number> = { PASS: 0, DEFECT_FOUND: 1, BLOCKED: 2, HARNESS_ERROR: 3 };
export type StepStatus = 'passed' | 'defect' | 'blocked' | 'harness_error' | 'skipped';

export interface StepResult {
  index: number;
  name: string;
  status: StepStatus;
  action: { ran: boolean; ok: boolean | null };
  verify: { ran: boolean; ok: boolean | null };
  checks: CheckResult[];
  /**
   * For steps that perform a user interaction: how far it got. ACTION_EXECUTED alone is NOT success;
   * success is POSTCONDITION_SATISFIED (the step's verify held).
   */
  interaction_stage?: 'NOT_FOUND' | 'NOT_ACTIONABLE' | 'ACTION_EXECUTED' | 'POSTCONDITION_SATISFIED' | 'POSTCONDITION_FAILED';
  error?: string;
  duration_ms: number;
}

export interface ScenarioResult {
  schema: 'cockpit-qa/result@2';
  scenario: Omit<Scenario, 'steps' | 'allowed_page_errors'> & { steps: string[] };
  status: ScenarioStatus;
  status_reason: string;
  findings: Finding[];
  /** Distinct root symptoms (findings clustered by intersecting affected regions). */
  incident_count: number;
  baseline_comparison: (BaselineDiff & { baseline_id: string }) | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  viewport: { width: number; height: number };
  versions: VersionInfo;
  environment: { cockpitUrl: string; apiUrl: string; browser: string; mutation: string | null };
  warnings: string[];
  steps: StepResult[];
  runtime: { page_errors: number; console_errors: number; dialogs: number; failed_requests: number };
  evidence_dir: string;
  evidence: Record<string, string>;
  evidence_integrity: { required: string[]; missing: string[] };
  /** Self-healing: per-action metrics and scenario totals. Keys and prompts are never recorded. */
  healing: { summary: HealingSummary; provider: string; model: string | null; actions: ActionRecord[] } | null;
}

export interface RunOptions {
  /** Fingerprints per scenario from a recorded baseline; annotates findings as known/new. */
  baseline?: BaselineIndex;
}

const worse = (a: ScenarioStatus, b: ScenarioStatus): ScenarioStatus => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a);

/** Collapse volatile parts of an error message so identical runtime errors fingerprint identically. */
const normalizeError = (s: string) => s.replace(/https?:\/\/\S+/g, '<url>').replace(/\d+/g, '#').slice(0, 120);

export async function runScenario(browser: Browser, scenario: Scenario, config: QaConfig, opts: RunOptions = {}): Promise<ScenarioResult> {
  const startedAt = new Date();
  const evidence = new EvidenceRecorder(config.paths.evidence, scenario.id);
  const viewport = scenario.starting_state.viewport ?? config.defaultViewport;
  const api = new ApiClient(config.apiUrl);
  const steps: StepResult[] = [];
  const warnings: string[] = [];
  let status = 'PASS' as ScenarioStatus; // widened: escalate() mutates it from a closure
  let reason = 'all invariants held';
  const escalate = (s: ScenarioStatus, why: string) => {
    if (STATUS_RANK[s] > STATUS_RANK[status]) {
      status = s;
      reason = why;
    }
  };
  let fx: ScenarioFixture | undefined;
  let healing: HealingSession | undefined;

  /** Pseudo-step for checks made outside the scenario's own steps (starting state, runtime health). */
  const syntheticStep = (name: string, fill: (c: Checks) => void): void => {
    const c = new Checks();
    c.phase = 'verify';
    fill(c);
    if (c.results.length === 0) return;
    const failed = c.failed.length > 0;
    steps.push({ index: steps.length + 1, name, status: failed ? 'defect' : 'passed', action: { ran: false, ok: null }, verify: { ran: true, ok: !failed }, checks: c.results, duration_ms: 0 });
    if (failed) escalate('DEFECT_FOUND', `${name}: ${describeCheck(c.failed[0])}`);
  };

  const finish = async (): Promise<ScenarioResult> => {
    await evidence.snapshotBackend(api, 'end');
    if (fx) await fx.dispose();
    evidence.flushLogs();

    const failures = steps.flatMap((s) => s.checks.filter((c) => !c.passed && c.severity === 'error').map((check) => ({ step: s.name, check })));
    const findings = buildFindings(scenario.id, failures, { dir: evidence.dir, files: { ...evidence.files, result: 'result.json' } });

    // Evidence integrity: a defect is only reported as DEFECT_FOUND when its evidence is complete.
    const required = status === 'DEFECT_FOUND' ? ['recording.webm', 'failure.png', 'dom.html', 'console.json', 'ground_truth.json'] : ['console.json', 'ground_truth.json'];
    const missing = evidence.missing(required);
    if (missing.length) escalate('HARNESS_ERROR', `evidence incomplete: missing ${missing.join(', ')}`);

    let comparison: ScenarioResult['baseline_comparison'] = null;
    if (opts.baseline) {
      const base = opts.baseline.byScenario.get(scenario.id);
      comparison = { baseline_id: opts.baseline.id, ...diffAgainstBaseline(findings.map((f) => f.fingerprint), base) };
      for (const f of findings) f.baseline_state = base?.get(f.fingerprint) ?? 'NEW_DEFECT';
      // A stable baseline defect that did not reproduce is never silently treated as fixed.
      if (comparison.masked.length) warnings.push(`BASELINE_DEFECT_MASKED: ${comparison.masked.length} stable baseline finding(s) not reproduced (${comparison.masked.join(', ')}) — fixed, masked, or environment changed`);
      if (comparison.known_intermittent.length) warnings.push(`INTERMITTENT baseline finding(s) reproduced: ${comparison.known_intermittent.join(', ')}`);
    }

    const finishedAt = new Date();
    const result: ScenarioResult = {
      schema: 'cockpit-qa/result@2',
      scenario: {
        id: scenario.id,
        title: scenario.title,
        user_goal: scenario.user_goal,
        starting_state: scenario.starting_state,
        steps: scenario.steps.map((s) => s.name),
        expected_behavior: scenario.expected_behavior,
        invariant: scenario.invariant,
        evidence_requirements: scenario.evidence_requirements,
        tags: scenario.tags,
        independent_steps: scenario.independent_steps,
      },
      status,
      status_reason: reason,
      findings,
      incident_count: new Set(findings.map((f) => f.incident)).size,
      baseline_comparison: comparison,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      viewport,
      versions: versionInfo(config.paths.root),
      environment: { cockpitUrl: config.cockpitUrl, apiUrl: config.apiUrl, browser: `chromium ${browser.version()}`, mutation: config.mutation?.name ?? null },
      warnings,
      steps,
      runtime: {
        page_errors: evidence.console.filter((e) => e.kind === 'pageerror').length,
        console_errors: evidence.console.filter((e) => e.kind === 'console' && e.level === 'error').length,
        dialogs: evidence.console.filter((e) => e.kind === 'dialog').length,
        failed_requests: evidence.console.filter((e) => e.kind === 'requestfailed').length,
      },
      evidence_dir: evidence.dir,
      evidence: { ...evidence.files, result: 'result.json' },
      evidence_integrity: { required: [...required, 'result.json'], missing },
      healing: healing ? { summary: healing.summary(), provider: (config.resolver ?? resolverFromEnv()).provider, model: (config.resolver ?? resolverFromEnv()).model, actions: healing.records } : null,
    };
    try {
      evidence.writeJson('result.json', result);
    } catch (e) {
      result.status = 'HARNESS_ERROR';
      result.status_reason = `could not write result.json: ${(e as Error).message}`;
    }
    return result;
  };

  try {
    // ---- Preflight: can a valid verdict be reached at all?
    const pre = await evidence.snapshotBackend(api, 'preflight');
    const health = pre.health as { simulator?: string } | undefined;
    if (pre.error) throw new Blocked(pre.error);
    if (health?.simulator !== 'connected') throw new Blocked(`simulator ${health?.simulator ?? 'unknown'} (GET /api/health)`);
    const drones = ((pre.devices as Array<{ type: string }> | undefined) ?? []).filter((d) => d.type === 'drone');
    if (scenario.starting_state.waitForDevices && drones.length === 0) throw new Blocked('simulator reports no drones; scenario needs at least one');

    if (scenario.starting_state.simulator === 'reset') {
      await api.clearFaults();
      await api.resetAndStart();
    }
    await evidence.snapshotBackend(api, 'start');

    fx = await openScenarioFixture(browser, config, evidence, viewport);
    const v = versionInfo(config.paths.root);
    healing = new HealingSession(fx.page, scenario.id, new HealingMemory(config.paths.healingMemory), config.resolver ?? resolverFromEnv(), {
      memoryFile: config.paths.healingMemory,
      thresholds: { high: config.healing.high, margin: config.healing.margin, medium: config.healing.medium },
      llmMinConfidence: config.healing.llmMinConfidence,
      applicationIdentity: `flytbase-cockpit@${new URL(config.cockpitUrl).origin}`,
      commit: v.app.git_commit,
    });
    const ctx: ScenarioContext = { page: fx.page, context: fx.context, api: fx.api, ui: ui(fx.page), config, evidence, memo: {}, healing };

    if (scenario.starting_state.path !== null) {
      let res;
      try {
        res = await fx.page.goto(scenario.starting_state.path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (e) {
        throw new Blocked(`cockpit unreachable at ${config.cockpitUrl}: ${(e as Error).message.split('\n')[0]}`);
      }
      if (res && res.status() >= 500) throw new Blocked(`cockpit server error ${res.status()}`);
      if (scenario.starting_state.waitForDevices) {
        const rendered = await waitForDeviceRows(fx.page, config.appReadyTimeoutMs);
        // Backend healthy and has drones (preflight), yet the UI shows none: a product defect.
        syntheticStep('Starting state: cockpit renders the device list', (c) =>
          c.that({ id: 'app.device_list_rendered', target: 'region:device-list', type: 'blank' }, rendered, { expected: 'device rows', actual: 'none', state: 'no-rows', message: `no device rows within ${config.appReadyTimeoutMs} ms while API reports ${drones.length} drones` }),
        );
      }
    }

    // ---- Steps
    for (const step of scenario.steps) {
      const t0 = Date.now();
      const check = new Checks();
      const sr: StepResult = { index: steps.length + 1, name: step.name, status: 'passed', action: { ran: false, ok: null }, verify: { ran: false, ok: null }, checks: check.results, duration_ms: 0 };
      steps.push(sr);
      const halted = status === 'BLOCKED' || status === 'HARNESS_ERROR' || (status === 'DEFECT_FOUND' && !scenario.independent_steps);
      if (halted && !step.always) {
        sr.status = 'skipped';
        continue;
      }
      const sctx: StepContext = { ...ctx, check };
      healing.currentStep = step.name;
      let phase: 'action' | 'verify' = 'action';
      try {
        if (step.action) {
          sr.action.ran = true;
          check.phase = 'action';
          await step.action(sctx);
          sr.action.ok = !check.results.some((c) => c.phase === 'action' && !c.passed && c.severity === 'error');
        }
        if (step.verify && sr.action.ok !== false) {
          phase = 'verify';
          sr.verify.ran = true;
          check.phase = 'verify';
          await step.verify(sctx);
          sr.verify.ok = !check.results.some((c) => c.phase === 'verify' && !c.passed && c.severity === 'error');
        }
      } catch (e) {
        if (phase === 'action') sr.action.ok = false;
        else sr.verify.ok = false;
        if (e instanceof Blocked) {
          sr.status = 'blocked';
          sr.error = e.message;
          escalate('BLOCKED', `${step.name}: ${e.message}`);
        } else if (!(e instanceof HardStop)) {
          // Product interactions and assertions never throw (see utils/actions.ts, Checks): this is ours.
          sr.status = 'harness_error';
          sr.error = `${(e as Error).name}: ${(e as Error).message.split('\n')[0]}`;
          evidence.log({ kind: 'console', level: 'harness', text: `step "${step.name}" threw: ${(e as Error).stack ?? e}` });
          escalate('HARNESS_ERROR', `${step.name}: ${sr.error}`);
        }
      }
      sr.duration_ms = Date.now() - t0;
      sr.interaction_stage = interactionStage(sr);
      // Healings whose postcondition is the step's own verify are committed (or rejected) here.
      healing.endStep(sr.status === 'passed' && check.failed.length === 0);
      warnings.push(...check.warnings.map((c) => `[${step.name}] ${describeCheck(c)}`));
      if (check.failed.length > 0) {
        if (sr.status === 'passed') sr.status = 'defect';
        escalate('DEFECT_FOUND', `${step.name}: ${describeCheck(check.failed[0])}`);
      }
    }

    // ---- Runtime health: uncaught exceptions and unexpected dialogs are defects in any scenario.
    const allowed = scenario.allowed_page_errors ?? [];
    syntheticStep('Runtime health', (c) => {
      const pageErrors = evidence.console.filter((e) => e.kind === 'pageerror' && !allowed.some((re) => re.test(e.text)));
      const dialogs = evidence.console.filter((e) => e.kind === 'dialog');
      c.that({ id: 'runtime.no_uncaught_errors', target: 'page', type: 'uncaught_error' }, pageErrors.length === 0, {
        expected: 'no uncaught exceptions',
        actual: pageErrors.map((e) => e.text),
        state: [...new Set(pageErrors.map((e) => normalizeError(e.text)))].sort().join(' ; '),
      });
      c.that({ id: 'runtime.no_unexpected_dialogs', target: 'page', type: 'unexpected_dialog' }, dialogs.length === 0, {
        expected: 'no dialogs',
        actual: dialogs.map((d) => d.text),
        state: [...new Set(dialogs.map((d) => normalizeError(d.text)))].sort().join(' ; '),
      });
    });
  } catch (e) {
    if (e instanceof Blocked) escalate('BLOCKED', e.message);
    else {
      evidence.log({ kind: 'console', level: 'harness', text: `harness failure: ${(e as Error).stack ?? e}` });
      escalate('HARNESS_ERROR', `${(e as Error).name}: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  // ---- Evidence capture
  if (fx) {
    if (status === 'PASS') {
      await evidence.screenshot(fx.page, 'final.png');
    } else {
      await evidence.screenshot(fx.page, 'failure.png');
      await evidence.dom(fx.page);
      const boxes = steps.flatMap((s) => s.checks.filter((c) => !c.passed && c.severity === 'error').flatMap((c) => c.boxes ?? []));
      await evidence.annotatedScreenshot(fx.page, dedupeBoxes(boxes));
    }
  }
  return finish();
}

function interactionStage(sr: StepResult): StepResult['interaction_stage'] {
  const acts = sr.checks.filter((c) => c.id === 'interaction.action_executed');
  if (acts.length === 0) return undefined;
  const failed = acts.find((c) => !c.passed);
  if (failed) return failed.type === 'missing' ? 'NOT_FOUND' : 'NOT_ACTIONABLE';
  if (!sr.verify.ran) return sr.checks.some((c) => c.phase === 'action' && !c.passed && c.severity === 'error') ? 'POSTCONDITION_FAILED' : 'ACTION_EXECUTED';
  return sr.verify.ok ? 'POSTCONDITION_SATISFIED' : 'POSTCONDITION_FAILED';
}

function dedupeBoxes(boxes: NonNullable<CheckResult['boxes']>): NonNullable<CheckResult['boxes']> {
  const seen = new Set<string>();
  return boxes.filter((b) => {
    const k = `${b.label}|${Math.round(b.rect.x)}|${Math.round(b.rect.y)}|${Math.round(b.rect.width)}|${Math.round(b.rect.height)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
