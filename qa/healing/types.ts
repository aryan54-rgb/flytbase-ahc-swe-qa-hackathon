/**
 * Semantic action model for self-healing selector execution.
 *
 * A SemanticAction says WHAT the user is doing (intent + semantic constraints) and HOW we last knew
 * to find it (`selector`). The selector is tried first, exactly as before; the semantics are only
 * used when that selector no longer resolves to any element.
 */

export interface SemanticAction {
  /** Stable id of the action within the scenario (not an index). */
  step_id: string;
  /** Human intent, e.g. "Activate the 2D map view". Sent to the LLM tier verbatim. */
  intent: string;
  /** Semantic target id used in findings, e.g. "testid:map-view-2d" (fingerprints never change with healing). */
  target: string;
  /** The known deterministic selector (CSS). Defaults from `target` when it is "testid:<id>". */
  selector?: string;
  /** HARD: acceptable ARIA roles (as computed by Playwright), e.g. ["button"] or ["listitem", "button"]. */
  roles: string[];
  /** SOFT (strong): the accessible name the element had when the test was written. */
  accessible_name?: string;
  /** SOFT: extra words/phrases that describe the target. */
  semantic_hints?: string[];
  /** SOFT: label of an enclosing landmark/group/section, e.g. "Map view" or "Devices". */
  context?: string;
  /** HARD: phrases that must appear (whole-word) in the element's name/text — identity, e.g. ["Drone 2"]. */
  required_text?: string[];
  /** HARD: phrases that must NOT appear — the semantic opposite, e.g. ["3D"] when looking for 2D. */
  forbidden_text?: string[];
  /** Human description of the postcondition (the check itself is supplied by the scenario). */
  expected_postcondition?: string;
}

/** Everything a candidate element exposes that the browser can observe. No DOM dumps. */
export interface Candidate {
  id: string;
  index: number;
  tag: string;
  role: string;
  /** Approximate accessible name (aria-label > labelledby > text > title/alt). */
  name: string;
  text: string;
  testid: string | null;
  aria_label: string | null;
  aria_pressed: string | null;
  title: string | null;
  disabled: boolean;
  visible: boolean;
  /** Landmark/group/section chain, e.g. "main > group:map view". */
  context: string;
  /** Nearest section heading, e.g. "devices". */
  heading: string | null;
  /** Other stable attributes worth showing (type, href path, name, id). */
  attrs: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'AMBIGUOUS' | 'NONE';

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
  features: Record<string, number>;
  /** Reasons the candidate was excluded by hard constraints (empty = eligible). */
  rejected: string[];
  signature: string;
}

export interface Ranking {
  eligible: ScoredCandidate[];
  rejected: ScoredCandidate[];
  level: ConfidenceLevel;
  best: ScoredCandidate | null;
  margin: number;
  reason: string;
}

export type HealingOutcome =
  | 'DETERMINISTIC' // known selector worked, no healing
  | 'HEALED_MEMORY'
  | 'HEALED_LOCAL'
  | 'HEALED_LLM'
  | 'HEALING_REJECTED' // candidates exist but are ambiguous: refused to guess
  | 'HEALING_UNRESOLVED' // no confident candidate (and LLM unavailable/declined/invalid)
  | 'HEALING_FAILED' // a healed target was used but the postcondition failed
  | 'TARGET_ABSENT'; // nothing eligible exists at all

export interface ActionRecord {
  scenario_id: string;
  step: string;
  step_id: string;
  intent: string;
  original_target: string;
  original_selector: string;
  mode: 'action' | 'resolve';
  deterministic_attempt: boolean;
  deterministic_success: boolean;
  memory_lookup: boolean;
  memory_hit: boolean;
  memory_stale: boolean;
  local_recovery_attempt: boolean;
  local_recovery_success: boolean;
  llm_attempt: boolean;
  llm_success: boolean;
  llm_provider: string | null;
  llm_model: string | null;
  llm_latency_ms: number | null;
  llm_tokens: number | null;
  llm_reason: string | null;
  recovery_tier: 'deterministic' | 'memory' | 'local' | 'llm' | null;
  recovery_confidence: number | null;
  confidence_level: ConfidenceLevel | null;
  recovery_latency_ms: number;
  candidates_considered: number;
  healed_signature: string | null;
  healed_description: string | null;
  outcome: HealingOutcome;
  postcondition: 'satisfied' | 'failed' | 'pending' | 'not-applicable';
  clicks_dispatched: number;
  reason: string;
}
