import type { BrowserContext } from 'playwright';

/**
 * Runtime mutations: deliberately break the cockpit *inside the test browser* (init scripts, injected
 * CSS, network interception) to prove the scenarios detect the resulting user-visible failure.
 * Product source is never touched. Select with `--mutate <name>`.
 *
 * DECOUPLING RULE (enforced by `mutationDecouplingViolations()` in --mutation-check):
 * a mutation must not locate its target the way a detector does. No data-testid values, no
 * registry selectors, no class names the assertions use, no imports from utils/selectors or
 * assertions. Mutations work from document structure, element semantics and visible text; detectors
 * catch the *behavioural* consequence through their own locators and ground truth. Otherwise a
 * mutation and a detector could agree on a selector and "detect" each other trivially.
 *
 * `expectedToFail` is a report annotation only — mutation-check runs every mutation against every
 * scenario and never uses it to choose what runs or what counts as detected.
 */

/**
 * What a mutation is supposed to demonstrate:
 *   detected        a behavioural breakage: some scenario must report a NEW defect
 *   healed          a selector-only change: the listed scenarios must still PASS via verified healing
 *   healed-if-llm   needs semantic reasoning: healed when a Tier-3 provider is configured, otherwise the
 *                   correct result is a clean refusal (HEALING_UNRESOLVED, 0 LLM calls, no click)
 *   rejected        ambiguous target: the healer must refuse (HEALING_REJECTED) and click nothing
 */
export type MutationExpectation = { kind: 'detected' } | { kind: 'healed' | 'healed-if-llm' | 'rejected'; scenarios: string[] };

export interface Mutation {
  name: string;
  description: string;
  expectedToFail: string[];
  expect?: MutationExpectation;
  apply: (context: BrowserContext, cockpitUrl: string) => Promise<unknown>;
}

/** Runs `body` once the DOM exists and re-runs it on every DOM change (React re-renders). */
const onEveryRender = (body: string) => `
  (() => {
    const run = () => { try { ${body} } catch (e) {} };
    const start = () => { run(); new MutationObserver(run).observe(document.documentElement, { subtree: true, childList: true, characterData: true }); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  })();`;

const injectCss = (css: string) => `
  (() => {
    const add = () => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
  })();`;

/** Swallow clicks (capture phase, before React's root listener) on elements matching a structural test. */
const swallowClicks = (matchExpr: string, extra = '') => `
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const hit = t && (${matchExpr});
    if (hit) { e.stopPropagation(); ${extra} }
  }, true);`;

export const MUTATIONS: Mutation[] = [
  {
    name: 'row-click-dead',
    description: 'Break the device-list click handler: clicks on list items never reach the app.',
    expectedToFail: ['scenario-002', 'scenario-003'],
    // Structure: any <li> (the device list is the page's only list). Detectors use device-row test ids.
    apply: (ctx) => ctx.addInitScript({ content: swallowClicks(`t.closest('li')`) }),
  },
  {
    name: 'row-missing',
    description: 'Remove one interactive control: the last entry of the device list is not displayed.',
    expectedToFail: ['scenario-001', 'scenario-003'],
    // Structure: last list item. Detectors compare rendered rows with GET /api/devices.
    apply: (ctx) => ctx.addInitScript({ content: injectCss('section ul > li:last-child { display: none !important; }') }),
  },
  {
    name: 'status-corrupt',
    description: 'Corrupt UI status: whatever flight status the telemetry heading shows is rewritten to "standby".',
    expectedToFail: ['scenario-004'],
    // Semantics + text: a span inside a heading whose text is a flight-status word. Detector reads the status test id.
    apply: (ctx) =>
      ctx.addInitScript({
        content: onEveryRender(`for (const el of document.querySelectorAll('h2 span')) { const t = (el.textContent || '').trim(); if ((t === 'taking_off' || t === 'in_flight' || t === 'landing')) el.textContent = 'standby'; }`),
      }),
  },
  {
    name: 'selection-stale-header',
    description: 'The telemetry heading label stops following the selection (always names the first drone).',
    expectedToFail: ['scenario-002', 'scenario-003'],
    // Text: the heading span whose text starts with "Drone Telemetry". Detector locates the heading relationally.
    apply: (ctx) =>
      ctx.addInitScript({
        content: onEveryRender(`for (const el of document.querySelectorAll('h2 > span')) { const t = el.textContent || ''; if (t.startsWith('Drone Telemetry') && t !== 'Drone Telemetry · Drone 1') el.textContent = 'Drone Telemetry · Drone 1'; }`),
      }),
  },
  {
    name: 'responsive-overflow',
    description: 'Create responsive overflow: the page banner gets a fixed 520px minimum width.',
    expectedToFail: ['scenario-003'],
    apply: (ctx) => ctx.addInitScript({ content: injectCss('body > div > div > header { min-width: 520px; }') }),
  },
  {
    name: 'route-404',
    description: 'Alter route behaviour: the server answers unmapped paths with a blank 404 instead of the SPA.',
    expectedToFail: ['scenario-005'],
    apply: (ctx, cockpitUrl) =>
      ctx.route(
        (url) => url.origin === new URL(cockpitUrl).origin && url.pathname !== '/' && !/\.[a-z0-9]+$/i.test(url.pathname) && !url.pathname.startsWith('/@') && !url.pathname.startsWith('/node_modules') && !url.pathname.startsWith('/src'),
        (route) => (route.request().resourceType() === 'document' ? route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }) : route.continue()),
      ),
  },
  {
    name: 'map-toggle-dead',
    description: 'Break the map view buttons: clicks are dispatched but never reach the handler.',
    expectedToFail: ['scenario-006'],
    // Structure: buttons inside <main> (the map area). Detector checks the Cesium runtime + ARIA.
    apply: (ctx) => ctx.addInitScript({ content: swallowClicks(`t.closest('main button')`) }),
  },
  {
    name: 'map-toggle-fake-state',
    description: 'Map view buttons LOOK like they work (pressed state flips) but the map never changes.',
    expectedToFail: ['scenario-006'],
    // Proves ARIA alone is not trusted: the handler is dead, only the pressed styling/attribute is faked.
    apply: (ctx) =>
      ctx.addInitScript({
        content: swallowClicks(
          `t.closest('main button')`,
          `const b = t.closest('main button'); for (const s of b.parentElement.children) { s.setAttribute('aria-pressed', String(s === b)); s.classList.toggle('active', s === b); }`,
        ),
      }),
  },
];

// ---- selector-change mutations (self-healing validation). Targets are found structurally: the buttons of
// the ARIA group inside <main>/<header>, by their visible text — never by a test id or registry selector.
const MAP_BUTTONS = `document.querySelectorAll('main [role="group"] > button, header [role="group"] > button')`;
const stripHooks = `for (const a of [...b.getAttributeNames()]) if (a.startsWith('data-')) b.removeAttribute(a);`;
const relabel = (from: string, to: string) => `if ((b.textContent || '').trim() === '${from}') b.textContent = '${to}';`;

MUTATIONS.push(
  {
    name: 'heal-testid-changed',
    description: 'TESTID_CHANGED: every data-* hook on the map view buttons gets a new value; UI and behaviour unchanged.',
    expectedToFail: [],
    expect: { kind: 'healed', scenarios: ['scenario-006'] },
    apply: (ctx) => ctx.addInitScript({ content: onEveryRender(`for (const b of ${MAP_BUTTONS}) for (const a of b.getAttributeNames()) if (a.startsWith('data-') && !b.getAttribute(a).endsWith('-v2')) b.setAttribute(a, b.getAttribute(a) + '-v2');`) }),
  },
  {
    name: 'heal-dom-moved',
    description: 'DOM_MOVED: the map view button group is re-parented into the page banner and its buttons lose their test hooks.',
    expectedToFail: [],
    expect: { kind: 'healed', scenarios: ['scenario-006'] },
    apply: (ctx) =>
      ctx.addInitScript({
        content: onEveryRender(`const g = document.querySelector('main [role="group"]'); const h = document.querySelector('header'); if (g && h) h.appendChild(g); for (const b of ${MAP_BUTTONS}) { ${stripHooks} }`),
      }),
  },
  {
    name: 'heal-label-changed',
    description: 'ACCESSIBLE_LABEL_CHANGED: map buttons lose test hooks and are relabelled "Top-down" / "Tilted" (same meaning, new words).',
    expectedToFail: [],
    expect: { kind: 'healed-if-llm', scenarios: ['scenario-006'] },
    apply: (ctx) => ctx.addInitScript({ content: onEveryRender(`for (const b of ${MAP_BUTTONS}) { ${stripHooks} ${relabel('2D', 'Top-down')} ${relabel('3D', 'Tilted')} }`) }),
  },
  {
    name: 'heal-ambiguous',
    description: 'AMBIGUOUS_TARGET: map buttons lose test hooks and BOTH are labelled "View" — two equally plausible targets.',
    expectedToFail: [],
    expect: { kind: 'rejected', scenarios: ['scenario-006'] },
    apply: (ctx) => ctx.addInitScript({ content: onEveryRender(`for (const b of ${MAP_BUTTONS}) { ${stripHooks} ${relabel('2D', 'View')} ${relabel('3D', 'View')} }`) }),
  },
);

export function findMutation(name: string): Mutation {
  const m = MUTATIONS.find((x) => x.name === name);
  if (!m) throw new Error(`unknown mutation "${name}". Known: ${MUTATIONS.map((x) => x.name).join(', ')}`);
  return m;
}
