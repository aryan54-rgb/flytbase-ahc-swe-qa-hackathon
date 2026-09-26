import { rmSync } from 'node:fs';
import type { Browser, Page } from 'playwright';
import { Checks } from '../assertions/checks.js';
import { HealingMemory } from './memory.js';
import { DEFAULT_THRESHOLDS, hasPhrase } from './rank.js';
import { ScriptedResolver, type ResolverRequest, type SemanticResolver } from './resolver.js';
import { HealingSession } from './session.js';
import type { SemanticAction } from './types.js';

/**
 * Offline self-test of self-healing on a synthetic page (page.setContent — not the cockpit) with a
 * scripted resolver test double standing in for the LLM. Exercises every tier and every refusal path
 * deterministically, without network or API cost.
 */

const PAGE = `<main>
  <section><h2>Devices</h2><ul>
    <li style="cursor:pointer" onclick="window.sel='d1'">Drone 1 <span>standby</span></li>
    <li style="cursor:pointer" onclick="window.sel='d2'">Drone 2 <span>standby</span></li>
    <li style="cursor:pointer" onclick="window.sel='d10'">Drone 10 <span>standby</span></li>
  </ul></section>
  <div role="group" aria-label="Map view"><button id="a" onclick="window.mode='2d'">Top-down</button><button id="b" onclick="window.mode='3d'">Tilted</button></div>
  <button data-testid="known-ok" onclick="window.known=1">Known</button>
</main>`;

const map2d: SemanticAction = { step_id: 'map-2d', intent: 'Switch the map to the 2D view', target: 'testid:map-view-2d', roles: ['button'], accessible_name: '2D', semantic_hints: ['2D'], context: 'Map view', forbidden_text: ['3D'] };
const drone = (n: string): SemanticAction => ({ step_id: `select-${n}`, intent: `Select ${n}`, target: `device:${n}`, selector: '[data-testid="device-row-gone"]', roles: ['listitem'], required_text: [n], semantic_hints: [n], context: 'Devices' });
const pickByName = (name: string, confidence = 0.95) => (req: ResolverRequest) => JSON.stringify({ candidate_id: req.candidates.find((c) => c.name === name)?.id ?? 'none', confidence, reason: `"${name}" is the requested view` });
const postWindow = (key: string, want: string) => ({ spec: { id: 'selftest.post', target: key, type: 'mismatch' as const }, observe: (page: Page) => page.evaluate((k) => (window as unknown as Record<string, unknown>)[k] ?? null, key), want });

export async function healingCases(browser: Browser, memoryFile: string): Promise<Array<{ name: string; ok: boolean; detail: string }>> {
  rmSync(memoryFile, { force: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const out: Array<{ name: string; ok: boolean; detail: string }> = [];
  // Same tsx/esbuild __name shim the scenario fixture installs (string form: not transformed by esbuild).
  const fresh = async (html = PAGE) => {
    await page.setContent(html);
    await page.evaluate('globalThis.__name = globalThis.__name || ((f) => f); delete window.mode; delete window.sel; delete window.known;');
  };
  const session = (resolver: SemanticResolver) =>
    new HealingSession(page, 'selftest', new HealingMemory(memoryFile), resolver, { memoryFile, thresholds: DEFAULT_THRESHOLDS, llmMinConfidence: 0.8, applicationIdentity: 'selftest@local', commit: null });
  const run = async (resolver: SemanticResolver, action: SemanticAction, post?: ReturnType<typeof postWindow>) => {
    const s = session(resolver);
    const check = new Checks();
    const r = await s.perform(check, action, post && { spec: post.spec, observe: () => post.observe(page), satisfied: (v) => v === post.want, timeoutMs: 1_000 });
    return { r, s, check };
  };
  const add = (name: string, ok: boolean, detail: string) => out.push({ name: `healing: ${name}`, ok, detail });

  try {
    out.push({ name: 'healing: whole-phrase matching ("Drone 1" not inside "Drone 10")', ok: hasPhrase('Drone 10 standby', 'Drone 10') && !hasPhrase('Drone 10 standby', 'Drone 1'), detail: '' });

    await fresh();
    let x = await run(new ScriptedResolver('{}'), { ...map2d, step_id: 'known', target: 'testid:known-ok', forbidden_text: [] }, postWindow('known', 1 as unknown as string));
    add('tier 1 — known selector used as-is', x.r.record.outcome === 'DETERMINISTIC' && x.r.stage === 'POSTCONDITION_SATISFIED', x.r.record.outcome);

    await fresh();
    x = await run(new ScriptedResolver('{}'), drone('Drone 2'), postWindow('sel', 'd2'));
    add('tier 2 — local HIGH by identity (Drone 2, not Drone 1/10), postcondition verified', x.r.record.outcome === 'HEALED_LOCAL' && x.r.stage === 'POSTCONDITION_SATISFIED', `${x.r.record.outcome} conf=${x.r.record.recovery_confidence}`);

    await fresh();
    x = await run(new ScriptedResolver('{}'), drone('Drone 9'));
    add('tier 2 — no eligible element -> TARGET_ABSENT, no click', x.r.record.outcome === 'TARGET_ABSENT' && x.r.record.clicks_dispatched === 0, x.r.record.outcome);

    await fresh();
    let llm = new ScriptedResolver(pickByName('Top-down'));
    x = await run(llm, map2d, postWindow('mode', '2d'));
    add('tier 3 — local LOW -> LLM picks "Top-down" -> validated -> postcondition verified -> memory written', x.r.record.outcome === 'HEALED_LLM' && x.r.stage === 'POSTCONDITION_SATISFIED' && llm.calls === 1 && new HealingMemory(memoryFile).entries().length >= 1, `${x.r.record.outcome}, llm calls ${llm.calls}`);

    await fresh();
    llm = new ScriptedResolver(pickByName('Top-down'));
    x = await run(llm, map2d, postWindow('mode', '2d'));
    add('memory — second run heals from memory with 0 LLM calls', x.r.record.outcome === 'HEALED_MEMORY' && llm.calls === 0 && x.r.stage === 'POSTCONDITION_SATISFIED', `${x.r.record.outcome}, llm calls ${llm.calls}`);

    rmSync(memoryFile, { force: true });
    for (const [label, raw] of [['malformed JSON', 'not json'], ['unknown candidate id', '{"candidate_id":"candidate-999","confidence":0.99,"reason":"x"}'], ['confidence below threshold', (r: ResolverRequest) => pickByName('Top-down', 0.5)(r)], ['LLM declines (null)', '{"candidate_id":null,"confidence":0.9,"reason":"unclear"}']] as const) {
      await fresh();
      x = await run(new ScriptedResolver(raw as string | ((r: ResolverRequest) => string)), map2d, postWindow('mode', '2d'));
      add(`tier 3 — ${label} -> HEALING_UNRESOLVED, no click`, x.r.record.outcome === 'HEALING_UNRESOLVED' && x.r.record.clicks_dispatched === 0, `${x.r.record.outcome}: ${x.r.record.reason.slice(0, 70)}`);
    }

    await fresh();
    x = await run(new ScriptedResolver(pickByName('Tilted')), map2d, postWindow('mode', '2d'));
    const memAfter = new HealingMemory(memoryFile).entries().length;
    add('tier 3 — wrong LLM choice fails the postcondition -> HEALING_FAILED, real check failure, memory NOT written', x.r.record.outcome === 'HEALING_FAILED' && x.check.failed.some((c) => c.id === 'selftest.post') && memAfter === 0, `${x.r.record.outcome}, memory entries ${memAfter}`);

    const twins = PAGE.replace('>Top-down<', '>View<').replace('>Tilted<', '>View<');
    await fresh(twins);
    llm = new ScriptedResolver(pickByName('View'));
    x = await run(llm, map2d, postWindow('mode', '2d'));
    add('ambiguity — identical candidates -> HEALING_REJECTED before any LLM call, no click', x.r.record.outcome === 'HEALING_REJECTED' && llm.calls === 0 && x.r.record.clicks_dispatched === 0 && (await page.evaluate(() => (window as unknown as { mode?: string }).mode)) === undefined, `${x.r.record.outcome}, llm calls ${llm.calls}`);

    await fresh();
    await run(new ScriptedResolver(pickByName('Top-down')), map2d, postWindow('mode', '2d')); // learn Top-down
    await fresh(twins);
    llm = new ScriptedResolver(pickByName('View'));
    x = await run(llm, map2d, postWindow('mode', '2d'));
    add('stale memory — remembered "Top-down" gone -> marked stale, not redirected, rejected, no click', x.r.record.memory_stale && x.r.record.outcome === 'HEALING_REJECTED' && x.r.record.clicks_dispatched === 0, `stale=${x.r.record.memory_stale} ${x.r.record.outcome}`);
  } finally {
    await ctx.close();
  }
  return out;
}
