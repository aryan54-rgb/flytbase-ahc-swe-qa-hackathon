import type { Candidate, SemanticAction } from './types.js';
import { describe } from './rank.js';

/**
 * Tier-3 semantic resolver: provider-neutral interface + adapters.
 *
 *   SemanticResolver.resolve(request) -> ResolverDecision
 *
 * Configuration (environment only; nothing is ever written to disk or logs):
 *   QA_LLM_PROVIDER   none (default) | gemini | openrouter | openai
 *   QA_LLM_MODEL      model id (defaults per provider below)
 *   QA_LLM_API_KEY    generic key; else GEMINI_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY
 *   QA_LLM_BASE_URL   override for OpenAI-compatible endpoints
 *   QA_LLM_TIMEOUT_MS default 20000
 *
 * With QA_LLM_PROVIDER unset the engine is fully deterministic: tier 3 reports "unavailable" and the
 * action stays unresolved. Keys are read at call time, sent only in the Authorization/x-goog-api-key
 * header (never in URLs), and scrubbed from any error text before it can reach result.json.
 */

export interface ResolverRequest {
  action: SemanticAction;
  failed_selector: string;
  candidates: Candidate[];
  page: { title: string; path: string; landmarks: string[] };
}

export interface ResolverDecision {
  ok: boolean;
  candidate_id: string | null;
  confidence: number;
  reason: string;
  latency_ms: number;
  tokens: number | null;
  /** Why a response was not usable (malformed, unknown id, declined, transport error...). */
  error?: string;
}

export interface SemanticResolver {
  readonly provider: string;
  readonly model: string | null;
  readonly configured: boolean;
  resolve(req: ResolverRequest): Promise<ResolverDecision>;
}

const SYSTEM = [
  'You resolve UI elements for an automated QA engine.',
  'Given a user intent and a list of candidate elements observed on the current page, choose the ONE candidate a user would operate to perform exactly that intent.',
  'Rules: never choose an element with the opposite meaning; if no candidate clearly satisfies the intent, or two or more are equally plausible, return candidate_id null.',
  'Respond with ONLY a JSON object: {"candidate_id": string|null, "confidence": number between 0 and 1, "reason": string}.',
].join(' ');

export function buildPrompt(req: ResolverRequest): string {
  const a = req.action;
  return JSON.stringify(
    {
      intent: a.intent,
      expected_effect: a.expected_postcondition ?? null,
      failed_selector: req.failed_selector,
      expected_role: a.roles,
      previous_accessible_name: a.accessible_name ?? null,
      hints: a.semantic_hints ?? [],
      context: a.context ?? null,
      must_not_mean: a.forbidden_text ?? [],
      page: req.page,
      candidates: req.candidates.map((c) => ({ id: c.id, role: c.role, name: c.name, text: c.text !== c.name ? c.text : undefined, context: c.context, section: c.heading, pressed: c.aria_pressed, summary: describe(c) })),
    },
    null,
    1,
  );
}

/** Strict parsing: exact shape, id must be one we offered, confidence a finite number in [0, 1]. */
export function parseDecision(raw: string, offered: Candidate[]): { candidate_id: string | null; confidence: number; reason: string } | { error: string } {
  let obj: unknown;
  try {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    obj = JSON.parse(trimmed);
  } catch {
    return { error: 'malformed: response is not JSON' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'malformed: not a JSON object' };
  const o = obj as Record<string, unknown>;
  const id = o.candidate_id;
  const conf = o.confidence;
  const reason = typeof o.reason === 'string' ? o.reason.slice(0, 300) : '';
  if (id !== null && typeof id !== 'string') return { error: 'malformed: candidate_id must be string or null' };
  if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) return { error: 'malformed: confidence must be a number in [0,1]' };
  if (id !== null && !offered.some((c) => c.id === id)) return { error: `invalid: candidate_id "${id}" was not offered` };
  return { candidate_id: id as string | null, confidence: conf, reason };
}

const env = (k: string) => process.env[k];

function scrub(text: string, secret: string | undefined): string {
  let t = text;
  if (secret) t = t.split(secret).join('***');
  // Keys, bearer tokens and account/project identifiers never reach result.json or logs.
  return t
    .replace(/(key|token|authorization)["'=:\s]+[A-Za-z0-9_\-.]{12,}/gi, '$1=***')
    .replace(/\b(sk|proj|org)[-_][A-Za-z0-9_-]{6,}/g, '$1_***')
    .slice(0, 300);
}

abstract class HttpResolver implements SemanticResolver {
  abstract readonly provider: string;
  constructor(readonly model: string, protected readonly keyEnv: string[], protected readonly timeoutMs: number) {}
  protected key(): string | undefined {
    for (const k of ['QA_LLM_API_KEY', ...this.keyEnv]) if (env(k)) return env(k);
    return undefined;
  }
  get configured(): boolean {
    return !!this.key();
  }
  protected abstract call(prompt: string, key: string): Promise<{ text: string; tokens: number | null }>;

  async resolve(req: ResolverRequest): Promise<ResolverDecision> {
    const t0 = Date.now();
    const key = this.key();
    if (!key) return { ok: false, candidate_id: null, confidence: 0, reason: '', latency_ms: 0, tokens: null, error: `no API key in ${['QA_LLM_API_KEY', ...this.keyEnv].join('/')}` };
    try {
      const { text, tokens } = await this.call(buildPrompt(req), key);
      const parsed = parseDecision(text, req.candidates);
      const latency_ms = Date.now() - t0;
      if ('error' in parsed) return { ok: false, candidate_id: null, confidence: 0, reason: '', latency_ms, tokens, error: parsed.error };
      return { ok: true, ...parsed, latency_ms, tokens };
    } catch (e) {
      return { ok: false, candidate_id: null, confidence: 0, reason: '', latency_ms: Date.now() - t0, tokens: null, error: `transport: ${scrub((e as Error).message, key)}` };
    }
  }
}

class GeminiResolver extends HttpResolver {
  readonly provider = 'gemini';
  protected async call(prompt: string, key: string) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { totalTokenCount?: number }; error?: { message?: string } };
    if (!res.ok) throw new Error(`HTTP ${res.status} ${body.error?.message ?? ''}`);
    return { text: body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '', tokens: body.usageMetadata?.totalTokenCount ?? null };
  }
}

class OpenAICompatibleResolver extends HttpResolver {
  constructor(readonly provider: string, model: string, keyEnv: string[], timeoutMs: number, private readonly baseUrl: string) {
    super(model, keyEnv, timeoutMs);
  }
  protected async call(prompt: string, key: string) {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: this.model,
        // Reasoning models (gpt-5*, o*) reject a non-default temperature; they take reasoning_effort instead.
        ...(/^(gpt-5|o\d)/.test(this.model) ? { reasoning_effort: env('QA_LLM_REASONING_EFFORT') ?? 'low' } : { temperature: 0 }),
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number }; error?: { message?: string } };
    if (!res.ok) throw new Error(`HTTP ${res.status} ${body.error?.message ?? ''}`);
    return { text: body.choices?.[0]?.message?.content ?? '', tokens: body.usage?.total_tokens ?? null };
  }
}

class NoResolver implements SemanticResolver {
  readonly provider = 'none';
  readonly model = null;
  readonly configured = false;
  async resolve(): Promise<ResolverDecision> {
    return { ok: false, candidate_id: null, confidence: 0, reason: '', latency_ms: 0, tokens: null, error: 'LLM tier not configured (QA_LLM_PROVIDER unset)' };
  }
}

/** Test double for the self-test ONLY (never selected by configuration): returns a fixed raw response. */
export class ScriptedResolver implements SemanticResolver {
  readonly provider = 'scripted-test-double';
  readonly model = null;
  readonly configured = true;
  calls = 0;
  constructor(private readonly raw: string | ((req: ResolverRequest) => string)) {}
  async resolve(req: ResolverRequest): Promise<ResolverDecision> {
    this.calls++;
    const parsed = parseDecision(typeof this.raw === 'function' ? this.raw(req) : this.raw, req.candidates);
    if ('error' in parsed) return { ok: false, candidate_id: null, confidence: 0, reason: '', latency_ms: 0, tokens: null, error: parsed.error };
    return { ok: true, ...parsed, latency_ms: 0, tokens: null };
  }
}

export function resolverFromEnv(): SemanticResolver {
  const provider = (env('QA_LLM_PROVIDER') ?? 'none').toLowerCase();
  const timeout = Number(env('QA_LLM_TIMEOUT_MS')) || 20_000;
  const model = env('QA_LLM_MODEL');
  switch (provider) {
    case 'gemini':
      return new GeminiResolver(model ?? 'gemini-2.5-flash', ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], timeout);
    case 'openrouter':
      return new OpenAICompatibleResolver('openrouter', model ?? 'google/gemini-2.5-flash', ['OPENROUTER_API_KEY'], timeout, env('QA_LLM_BASE_URL') ?? 'https://openrouter.ai/api/v1');
    case 'openai':
      return new OpenAICompatibleResolver('openai', model ?? 'gpt-4o-mini', ['OPENAI_API_KEY'], timeout, env('QA_LLM_BASE_URL') ?? 'https://api.openai.com/v1');
    default:
      return new NoResolver();
  }
}
