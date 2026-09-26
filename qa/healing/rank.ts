import type { Candidate, Ranking, ScoredCandidate, SemanticAction } from './types.js';

/**
 * Tier-2 deterministic ranking. Not fuzzy text similarity: a candidate must first pass HARD
 * constraints, then is scored on independent structured signals.
 *
 * HARD (any failure = ineligible, never clicked, never offered to the LLM):
 *   visible · enabled · role ∈ action.roles · every required_text phrase present · no forbidden_text phrase
 * SOFT features (weights sum to 1.0):
 *   name_exact   0.45  normalised accessible name == action.accessible_name
 *   identity     0.30  all required_text phrases present (identity already proven by the hard filter)
 *   hints        0.10  share of semantic_hints present as whole phrases in name/text
 *   context      0.10  action.context phrase in the landmark/group/heading chain
 *   testid       0.05  token overlap between the old and the candidate's test id (weak: ids are what broke)
 *
 * Confidence (thresholds configurable, see config.ts):
 *   NONE       no eligible candidate
 *   AMBIGUOUS  the top candidates are semantically indistinguishable (same role + identity + context)
 *              -> refuse, and do NOT ask the LLM: there is no information that could separate them
 *   HIGH       best >= high AND (best - second) >= margin AND strong identity evidence
 *              (exact name, or required_text identity, or >= 0.5 test id overlap)
 *   MEDIUM     best >= medium ; LOW otherwise  -> LLM tier if configured, else unresolved
 */

export interface RankThresholds {
  high: number;
  margin: number;
  medium: number;
}

export const DEFAULT_THRESHOLDS: RankThresholds = { high: 0.45, margin: 0.2, medium: 0.3 };

export const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Whole-phrase match: "drone 1" does not match inside "drone 10"; "2d" does not match "32d". */
export function hasPhrase(haystack: string, phrase: string): boolean {
  const p = norm(phrase);
  if (!p) return false;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(norm(haystack));
}

const tokens = (s: string | null | undefined) => new Set(norm(s).split(/[^a-z0-9]+/).filter(Boolean));

export function testidOf(action: SemanticAction): string | null {
  const m = /^testid:(.+)$/.exec(action.target) ?? /data-testid="?([^"\]]+)"?/.exec(action.selector ?? '');
  return m ? m[1] : null;
}

/**
 * Semantic signature: what makes this element "the same element" to a user.
 * role | identity | context, where identity is the required_text phrases when the action has them
 * (a device row's live status text must not change its identity), else the accessible name.
 */
export function signatureOf(c: Candidate, action: SemanticAction): string {
  const identity = action.required_text?.length ? action.required_text.map(norm).sort().join('+') : norm(c.name);
  return `${c.role}|${identity}|${norm(c.context)}`;
}

export function scoreCandidate(c: Candidate, action: SemanticAction): ScoredCandidate {
  const surface = `${c.name} ${c.text} ${c.aria_label ?? ''} ${c.title ?? ''}`;
  const rejected: string[] = [];
  if (!c.visible) rejected.push('not visible');
  if (c.disabled) rejected.push('disabled');
  if (!action.roles.includes(c.role)) rejected.push(`role ${c.role} not in [${action.roles.join(', ')}]`);
  for (const t of action.required_text ?? []) if (!hasPhrase(surface, t)) rejected.push(`missing required "${t}"`);
  for (const t of action.forbidden_text ?? []) if (hasPhrase(surface, t)) rejected.push(`contains forbidden "${t}"`);

  const hints = action.semantic_hints ?? [];
  const ctx = `${c.context} ${c.heading ?? ''}`;
  const oldId = testidOf(action);
  const a = tokens(oldId);
  const b = tokens(c.testid);
  const jaccard = a.size && b.size ? [...a].filter((x) => b.has(x)).length / new Set([...a, ...b]).size : 0;
  const features = {
    name_exact: action.accessible_name && norm(c.name) === norm(action.accessible_name) ? 0.45 : 0,
    identity: action.required_text?.length && action.required_text.every((t) => hasPhrase(surface, t)) ? 0.3 : 0,
    hints: hints.length ? (0.1 * hints.filter((h) => hasPhrase(surface, h)).length) / hints.length : 0,
    context: action.context && hasPhrase(ctx, action.context) ? 0.1 : 0,
    testid: 0.05 * jaccard,
  };
  const score = Math.round(Object.values(features).reduce((x, y) => x + y, 0) * 1000) / 1000;
  return { candidate: c, score, features: { ...features, testid_overlap: Math.round(jaccard * 100) / 100 }, rejected, signature: signatureOf(c, action) };
}

export function rank(candidates: Candidate[], action: SemanticAction, t: RankThresholds = DEFAULT_THRESHOLDS): Ranking {
  const scored = candidates.map((c) => scoreCandidate(c, action));
  // Stable: score desc, then DOM order.
  const eligible = scored.filter((s) => s.rejected.length === 0).sort((x, y) => y.score - x.score || x.candidate.index - y.candidate.index);
  const rejected = scored.filter((s) => s.rejected.length > 0);
  if (eligible.length === 0) return { eligible, rejected, level: 'NONE', best: null, margin: 0, reason: 'no candidate satisfies the hard constraints' };

  const best = eligible[0];
  const second = eligible[1];
  const margin = second ? Math.round((best.score - second.score) * 1000) / 1000 : best.score;
  const twins = eligible.filter((s) => s !== best && s.signature === best.signature && Math.abs(s.score - best.score) < 1e-9);
  if (twins.length) {
    return { eligible, rejected, level: 'AMBIGUOUS', best: null, margin: 0, reason: `${twins.length + 1} candidates are semantically identical (${best.signature}); refusing to guess` };
  }
  const strong = best.features.name_exact > 0 || best.features.identity > 0 || best.features.testid_overlap >= 0.5;
  if (best.score >= t.high && margin >= t.margin && strong) {
    return { eligible, rejected, level: 'HIGH', best, margin, reason: `score ${best.score}, margin ${margin}, identity evidence present` };
  }
  const level = best.score >= t.medium ? 'MEDIUM' : 'LOW';
  const why = [best.score < t.high && `score ${best.score} < ${t.high}`, margin < t.margin && `margin ${margin} < ${t.margin}`, !strong && 'no strong identity evidence'].filter(Boolean).join(', ');
  return { eligible, rejected, level, best, margin, reason: why };
}

/** Compact, secret-free description of a candidate for logs, memory and the LLM prompt. */
export function describe(c: Candidate): string {
  return `${c.role} "${c.name}"${c.context ? ` in ${c.context}` : ''}${c.heading ? ` (section "${c.heading}")` : ''}`;
}
