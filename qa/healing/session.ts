import type { Locator, Page } from 'playwright';
import type { CheckSpec, Checks } from '../assertions/checks.js';
import { pollUntil } from '../assertions/polling.js';
import { click } from '../utils/actions.js';
import { collectCandidates, locatorFor, type CandidateSet } from './candidates.js';
import { HealingMemory, memoryKey, type MemoryEntry } from './memory.js';
import { DEFAULT_THRESHOLDS, describe, rank, scoreCandidate, type RankThresholds } from './rank.js';
import type { SemanticResolver } from './resolver.js';
import type { ActionRecord, Candidate, HealingOutcome, SemanticAction } from './types.js';

/**
 * Self-healing selector execution, one session per scenario run.
 *
 *   known selector ──resolves──► use it                                   (tier 1, deterministic)
 *        │ resolves to NOTHING (only then — hidden/covered/dead elements are product observations)
 *        ▼
 *   memory ──exactly one live element with the remembered semantic signature──► use it   (memory hit)
 *        │ none / several → mark entry stale (never redirect to a different element)
 *        ▼
 *   local ranking (rank.ts) ──HIGH──► use it                                (tier 2)
 *        │ NONE → TARGET_ABSENT · AMBIGUOUS → HEALING_REJECTED (no LLM: nothing could separate twins)
 *        ▼ MEDIUM/LOW
 *   LLM resolver (only for actions with a verifiable postcondition) → strict parse → hard re-validation
 *        ▼
 *   click → verify postcondition → ONLY THEN write memory (a failed postcondition stays a real failure)
 */

export interface HealingConfig {
  memoryFile: string;
  thresholds: RankThresholds;
  llmMinConfidence: number;
  applicationIdentity: string;
  commit: string | null;
}

export interface PostconditionSpec<T> {
  spec: CheckSpec;
  observe: () => Promise<T>;
  satisfied: (v: T) => boolean;
  describe?: (v: T | undefined) => { expected?: unknown; actual?: unknown; state?: string };
  timeoutMs?: number;
}

export interface Resolution {
  locator: Locator | null;
  record: ActionRecord;
  /** Present when a healed target must be committed to memory after verification. */
  pending?: Omit<MemoryEntry, 'first_success' | 'last_success' | 'success_count' | 'stale_count' | 'status'>;
}

export interface PerformResult<T> {
  stage: 'POSTCONDITION_SATISFIED' | 'POSTCONDITION_FAILED' | 'ACTION_EXECUTED' | 'NOT_ACTIONABLE' | 'NOT_FOUND';
  record: ActionRecord;
  observed?: T;
}

const selectorOf = (a: SemanticAction) => a.selector ?? (a.target.startsWith('testid:') ? `[data-testid="${a.target.slice('testid:'.length)}"]` : a.target);

export class HealingSession {
  readonly records: ActionRecord[] = [];
  currentStep = '';
  private pendingForStep: Array<{ record: ActionRecord; entry: Resolution['pending']; memKey: string | null }> = [];

  constructor(
    private readonly page: Page,
    private readonly scenarioId: string,
    private readonly memory: HealingMemory,
    private readonly resolver: SemanticResolver,
    private readonly cfg: HealingConfig,
  ) {}

  private baseRecord(action: SemanticAction, mode: 'action' | 'resolve'): ActionRecord {
    return {
      scenario_id: this.scenarioId, step: this.currentStep, step_id: action.step_id, intent: action.intent,
      original_target: action.target, original_selector: selectorOf(action), mode,
      deterministic_attempt: false, deterministic_success: false, memory_lookup: false, memory_hit: false, memory_stale: false,
      local_recovery_attempt: false, local_recovery_success: false, llm_attempt: false, llm_success: false,
      llm_provider: null, llm_model: null, llm_latency_ms: null, llm_tokens: null, llm_reason: null,
      recovery_tier: null, recovery_confidence: null, confidence_level: null, recovery_latency_ms: 0,
      candidates_considered: 0, healed_signature: null, healed_description: null,
      outcome: 'DETERMINISTIC', postcondition: 'not-applicable', clicks_dispatched: 0, reason: '',
    };
  }

  private entryFor(action: SemanticAction, c: Candidate, signature: string, via: 'local' | 'llm', confidence: number, path: string): Resolution['pending'] {
    const q = (s: string) => s.replace(/'/g, "\\'");
    return {
      key: memoryKey(this.cfg.applicationIdentity, path, action.intent, action.target),
      application_identity: this.cfg.applicationIdentity,
      page_identity: path,
      scenario_id: this.scenarioId,
      step_ids: [action.step_id],
      intent: action.intent,
      original_target: action.target,
      original_selector: selectorOf(action),
      healed_target: {
        role: c.role, name: c.name, context: c.context, heading: c.heading, testid: c.testid,
        suggested_locator: c.testid ? `getByTestId('${q(c.testid)}')` : c.name && c.role !== 'listitem' ? `getByRole('${c.role}', { name: '${q(c.name)}' })` : `getByRole('${c.role}').filter({ hasText: '${q((action.required_text ?? [c.name])[0])}' })`,
      },
      semantic_signature: signature,
      learned_via: via,
      confidence,
      learned_on_commit: this.cfg.commit,
    };
  }

  /**
   * Find the element for `action`. `allowLlm` must be false for lookups whose result cannot be
   * verified by a postcondition (e.g. measuring geometry): an unverified guess would corrupt the check.
   */
  async resolve(action: SemanticAction, mode: 'action' | 'resolve', allowLlm: boolean): Promise<Resolution> {
    const t0 = Date.now();
    const rec = this.baseRecord(action, mode);
    const done = (outcome: HealingOutcome, reason: string, locator: Locator | null = null, pending?: Resolution['pending']): Resolution => {
      rec.outcome = outcome;
      rec.reason = reason;
      rec.recovery_latency_ms = Date.now() - t0;
      this.records.push(rec);
      return { locator, record: rec, pending };
    };

    // Tier 1 — deterministic, exactly as before healing existed.
    rec.deterministic_attempt = true;
    const known = this.page.locator(selectorOf(action));
    if ((await known.count()) > 0) {
      rec.deterministic_success = true;
      rec.recovery_tier = 'deterministic';
      return done('DETERMINISTIC', 'known selector resolved', known.first());
    }

    let set: CandidateSet | undefined;
    try {
      set = await collectCandidates(this.page);
      const path = set.page.path;
      const hardOk = (c: Candidate) => scoreCandidate(c, action).rejected.length === 0;

      // Memory — remembered target must be re-found by exact semantic signature, uniquely.
      const key = memoryKey(this.cfg.applicationIdentity, path, action.intent, action.target);
      const entry = this.memory.get(key);
      if (entry && entry.status === 'active') {
        rec.memory_lookup = true;
        const matches = set.candidates.filter((c) => hardOk(c) && scoreCandidate(c, action).signature === entry.semantic_signature);
        if (matches.length === 1) {
          const loc = await locatorFor(this.page, set, matches[0]);
          if (loc.locator && loc.role_confirmed) {
            rec.memory_hit = true;
            rec.recovery_tier = 'memory';
            rec.recovery_confidence = entry.confidence;
            rec.confidence_level = 'HIGH';
            rec.healed_signature = entry.semantic_signature;
            rec.healed_description = describe(matches[0]);
            const pending = { ...this.entryFor(action, matches[0], entry.semantic_signature, entry.learned_via, entry.confidence, path)!, key };
            return done('HEALED_MEMORY', `remembered target re-validated (${entry.semantic_signature}), learned via ${entry.learned_via}`, loc.locator, pending);
          }
        }
        const why = matches.length === 0 ? 'remembered signature not present or no longer passes hard constraints' : `remembered signature now matches ${matches.length} elements`;
        this.memory.markStale(key, why);
        rec.memory_stale = true;
      }

      // Tier 2 — local deterministic ranking.
      rec.local_recovery_attempt = true;
      const r = rank(set.candidates, action, this.cfg.thresholds);
      rec.candidates_considered = r.eligible.length;
      rec.confidence_level = r.level;
      rec.recovery_confidence = r.best?.score ?? null;
      if (r.level === 'NONE') return done('TARGET_ABSENT', `${r.reason} (${set.candidates.length} interactive elements inspected)`);
      if (r.level === 'AMBIGUOUS') return done('HEALING_REJECTED', r.reason);
      if (r.level === 'HIGH' && r.best) {
        const loc = await locatorFor(this.page, set, r.best.candidate);
        if (!loc.locator || !loc.role_confirmed) return done('HEALING_UNRESOLVED', `local winner's role "${r.best.candidate.role}" not confirmed by Playwright's accessibility engine`);
        rec.recovery_tier = 'local';
        rec.healed_signature = r.best.signature;
        rec.healed_description = describe(r.best.candidate);
        if (mode === 'resolve') rec.local_recovery_success = true; // nothing to verify; never written to memory
        return done('HEALED_LOCAL', r.reason, loc.locator, mode === 'action' ? this.entryFor(action, r.best.candidate, r.best.signature, 'local', r.best.score, path) : undefined);
      }

      // Tier 3 — LLM, only for MEDIUM/LOW and only when the result can be verified.
      if (!allowLlm) return done('HEALING_UNRESOLVED', `local confidence ${r.level} (${r.reason}); LLM tier not used for unverifiable lookups`);
      if (!this.resolver.configured) return done('HEALING_UNRESOLVED', `local confidence ${r.level} (${r.reason}); LLM tier not configured`);
      const offered = r.eligible.slice(0, 12).map((s) => s.candidate);
      rec.llm_attempt = true;
      rec.llm_provider = this.resolver.provider;
      rec.llm_model = this.resolver.model;
      const d = await this.resolver.resolve({ action, failed_selector: selectorOf(action), candidates: offered, page: set.page });
      rec.llm_latency_ms = d.latency_ms;
      rec.llm_tokens = d.tokens;
      rec.llm_reason = d.reason || d.error || null;
      if (!d.ok) return done('HEALING_UNRESOLVED', `LLM response rejected: ${d.error}`);
      if (d.candidate_id === null) return done('HEALING_UNRESOLVED', `LLM declined: ${d.reason}`);
      if (d.confidence < this.cfg.llmMinConfidence) return done('HEALING_UNRESOLVED', `LLM confidence ${d.confidence} < ${this.cfg.llmMinConfidence}`);
      // Never trust the LLM directly: re-validate against the live DOM and hard constraints.
      const chosen = r.eligible.find((s) => s.candidate.id === d.candidate_id)!;
      if (!hardOk(chosen.candidate)) return done('HEALING_UNRESOLVED', 'LLM choice fails hard constraints');
      if (r.eligible.some((s) => s !== chosen && s.signature === chosen.signature)) return done('HEALING_REJECTED', 'LLM choice is indistinguishable from another candidate');
      const loc = await locatorFor(this.page, set, chosen.candidate);
      if (!loc.locator || !loc.role_confirmed) return done('HEALING_UNRESOLVED', "LLM choice's role not confirmed by Playwright's accessibility engine");
      rec.recovery_tier = 'llm';
      rec.recovery_confidence = d.confidence;
      rec.healed_signature = chosen.signature;
      rec.healed_description = describe(chosen.candidate);
      return done('HEALED_LLM', `LLM: ${d.reason}`, loc.locator, this.entryFor(action, chosen.candidate, chosen.signature, 'llm', d.confidence, path));
    } finally {
      await set?.dispose();
    }
  }

  /** Healing-aware locator for measurements (no click, no LLM, no memory writes). */
  async locate(check: Checks, action: SemanticAction): Promise<Locator | null> {
    const res = await this.resolve(action, 'resolve', false);
    this.noteDrift(check, res);
    return res.locator;
  }

  /**
   * Execute a semantic click. With `post`, the postcondition is verified here; without it, the
   * calling step's own verify is the postcondition and memory is committed by `endStep(passed)`.
   */
  async perform<T>(check: Checks, action: SemanticAction, post?: PostconditionSpec<T>): Promise<PerformResult<T>> {
    const res = await this.resolve(action, 'action', true);
    const rec = res.record;
    if (!res.locator) {
      const [type, state] = rec.outcome === 'HEALING_REJECTED' ? (['ambiguous_target', 'ambiguous'] as const) : rec.outcome === 'TARGET_ABSENT' ? (['missing', 'absent'] as const) : (['unresolved_target', 'unresolved'] as const);
      check.that({ id: 'interaction.action_executed', target: action.target, type }, false, {
        expected: `element for "${action.intent}"`,
        actual: rec.outcome,
        state,
        message: `${rec.outcome}: ${rec.reason} — no action was performed`,
        observed: { healing: rec },
      });
      return { stage: 'NOT_FOUND', record: rec };
    }
    this.noteDrift(check, res);
    const outcome = await click(check, action.target, res.locator);
    rec.clicks_dispatched = outcome.stage === 'ACTION_EXECUTED' ? 1 : 0;
    if (outcome.stage !== 'ACTION_EXECUTED') {
      if (rec.recovery_tier && rec.recovery_tier !== 'deterministic') rec.outcome = 'HEALING_FAILED';
      return { stage: outcome.stage, record: rec };
    }
    if (!post) {
      rec.postcondition = 'pending';
      this.pendingForStep.push({ record: rec, entry: res.pending, memKey: rec.recovery_tier === 'memory' ? res.pending?.key ?? null : null });
      return { stage: 'ACTION_EXECUTED', record: rec };
    }
    const poll = await pollUntil(post.observe, post.satisfied, { timeoutMs: post.timeoutMs ?? 5_000, intervalMs: 150 });
    const d = post.describe?.(poll.last) ?? {};
    check.that(post.spec, poll.ok, { expected: d.expected, actual: d.actual ?? poll.last, state: d.state, observed: { stage: poll.ok ? 'POSTCONDITION_SATISFIED' : 'POSTCONDITION_FAILED', waited_ms: poll.elapsedMs, healing_outcome: rec.outcome } });
    this.settle(rec, res.pending, poll.ok, rec.recovery_tier === 'memory' ? res.pending?.key ?? null : null);
    return { stage: poll.ok ? 'POSTCONDITION_SATISFIED' : 'POSTCONDITION_FAILED', record: rec, observed: poll.last };
  }

  /** Called by the executor after each step: commits or rejects healings verified by the step's own checks. */
  endStep(passed: boolean): void {
    for (const p of this.pendingForStep) this.settle(p.record, p.entry, passed, p.memKey);
    this.pendingForStep = [];
  }

  private settle(rec: ActionRecord, entry: Resolution['pending'], ok: boolean, memKey: string | null): void {
    rec.postcondition = ok ? 'satisfied' : 'failed';
    if (rec.recovery_tier === 'deterministic' || rec.recovery_tier === null) return;
    if (!ok) {
      rec.outcome = 'HEALING_FAILED';
      if (rec.recovery_tier === 'llm') rec.llm_success = false;
      if (memKey) this.memory.markStale(memKey, 'postcondition failed after memory-based healing');
      return;
    }
    if (rec.recovery_tier === 'local') rec.local_recovery_success = true;
    if (rec.recovery_tier === 'llm') rec.llm_success = true;
    if (entry) this.memory.recordSuccess(entry);
  }

  private noteDrift(check: Checks, res: Resolution): void {
    const r = res.record;
    if (!res.locator || r.recovery_tier === 'deterministic') return;
    // Visible but verdict-neutral: the test still works, the selector needs a human update.
    check.warn({ id: 'healing.selector_drifted', target: r.original_target, type: 'missing' }, false, {
      expected: `known selector ${r.original_selector} resolves`,
      actual: `healed via ${r.recovery_tier} → ${r.healed_description}`,
      message: `selector drift: ${r.original_selector} no longer resolves; ${r.outcome} to ${r.healed_description} (confidence ${r.recovery_confidence})`,
    });
  }

  summary() {
    const rs = this.records;
    const n = (f: (r: ActionRecord) => boolean) => rs.filter(f).length;
    return {
      total_actions: rs.length,
      deterministic: n((r) => r.outcome === 'DETERMINISTIC'),
      healed_actions: n((r) => ['HEALED_MEMORY', 'HEALED_LOCAL', 'HEALED_LLM'].includes(r.outcome)),
      memory_hits: n((r) => r.memory_hit),
      memory_stale: n((r) => r.memory_stale),
      local_recoveries: n((r) => r.outcome === 'HEALED_LOCAL'),
      llm_calls: n((r) => r.llm_attempt),
      llm_successes: n((r) => r.llm_success),
      llm_latency_ms_total: rs.reduce((a, r) => a + (r.llm_latency_ms ?? 0), 0),
      llm_tokens_total: rs.reduce((a, r) => a + (r.llm_tokens ?? 0), 0),
      unresolved: n((r) => r.outcome === 'HEALING_UNRESOLVED'),
      rejected: n((r) => r.outcome === 'HEALING_REJECTED'),
      target_absent: n((r) => r.outcome === 'TARGET_ABSENT'),
      healing_failures: n((r) => r.outcome === 'HEALING_FAILED'),
      status: ((): string => {
        if (n((r) => r.outcome === 'HEALING_FAILED')) return 'HEALING_FAILED';
        if (n((r) => r.outcome === 'HEALING_REJECTED')) return 'REJECTED';
        if (n((r) => r.outcome === 'HEALING_UNRESOLVED')) return 'UNRESOLVED';
        if (n((r) => ['HEALED_MEMORY', 'HEALED_LOCAL', 'HEALED_LLM'].includes(r.outcome))) return 'HEALED';
        return 'NOT_NEEDED';
      })(),
    };
  }
}

export type HealingSummary = ReturnType<HealingSession['summary']>;
