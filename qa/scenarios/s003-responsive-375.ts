import { namedDevice, readSelection } from '../assertions/cockpit.js';
import { documentOverflow, geometry, insideViewportX, intersection, intersectionRect, roundRect, waitForLayoutStable, type ElementGeometry } from '../assertions/layout.js';
import { pollUntil } from '../assertions/polling.js';
import { probeActionable } from '../utils/actions.js';
import { mapView, selectDevice } from './actions.js';
import type { SemanticAction } from '../healing/types.js';
import type { DeviceInfo } from '../utils/api.js';
import { EL, TID, type Ui } from '../utils/selectors.js';
import { ALL_EVIDENCE, type Scenario, type StepContext } from './types.js';

const VIEWPORT = { width: 375, height: 667 };

interface Target {
  /** Semantic target id used in findings (stable across runs). */
  target: string;
  label: string;
  selector: string;
  locate: (ui: Ui) => ReturnType<Ui['socketBadge']>;
  interactive: boolean;
  /** Interactive targets carry their semantic action so the lookup can heal (tiers 1/memory/local only). */
  action?: SemanticAction;
}

/**
 * Resolve the element to MEASURE. Uses self-healing only for interactive targets that have a semantic
 * action, and only the verifiable tiers (known selector, validated memory, HIGH-confidence local): an
 * unverified LLM guess must never decide which element a layout invariant is measured on.
 */
async function measureTarget(t: Target, ctx: StepContext): Promise<ReturnType<Ui['socketBadge']>> {
  if (!t.action) return t.locate(ctx.ui);
  return (await ctx.healing.locate(ctx.check, t.action)) ?? t.locate(ctx.ui);
}

function criticalTargets(drones: DeviceInfo[]): Target[] {
  const tid = (id: string, label: string, locate: Target['locate'], interactive = false): Target => ({ target: `testid:${id}`, label, selector: `[data-testid=${id}]`, locate, interactive });
  return [
    tid(TID.socketStatus, 'socket badge', (u) => u.socketBadge()),
    { target: 'link:control-panel', label: 'control panel link', selector: 'role=link[name=/control panel/i]', locate: (u) => u.controlPanelLink(), interactive: true },
    ...drones.map<Target>((d) => ({ target: `device:${d.id}`, label: `device row ${d.id}`, selector: `[data-testid=device-row-${d.id}]`, locate: (u) => u.deviceRow(d.id), interactive: true, action: selectDevice(d) })),
    tid(TID.statusFlight, 'flight status pill', (u) => u.flightStatus()),
    tid(TID.telemetryBattery, 'telemetry battery', (u) => u.telemetryValue(TID.telemetryBattery)),
    tid(TID.telemetryAltRlt, 'telemetry altitude', (u) => u.telemetryValue(TID.telemetryAltRlt)),
    tid(TID.telemetryHSpeed, 'telemetry h-speed', (u) => u.telemetryValue(TID.telemetryHSpeed)),
    tid(TID.telemetryHeading, 'telemetry heading', (u) => u.telemetryValue(TID.telemetryHeading)),
    tid(TID.videoState, 'video state', (u) => u.videoState()),
    { ...tid(TID.mapView2d, 'map 2D button', (u) => u.mapView2d(), true), action: mapView('2d') },
    { ...tid(TID.mapView3d, 'map 3D button', (u) => u.mapView3d(), true), action: mapView('3d') },
  ];
}

const fmtRect = (g: ElementGeometry) => (g.rect ? `x=${Math.round(g.rect.x)} right=${Math.round(g.rect.right)} y=${Math.round(g.rect.y)} bottom=${Math.round(g.rect.bottom)}` : 'no rect');
const box = (label: string, r: { x: number; y: number; width: number; height: number } | null | undefined) => (r ? [{ label, rect: { x: r.x, y: r.y, width: r.width, height: r.height } }] : []);
const geoEvidence = (g: ElementGeometry) => ({ label: g.label, selector: g.selector, rect: roundRect(g.rect), visible_rect: roundRect(g.visibleRect), clipped_x: g.clippedX });

/** Elements whose position the checks depend on; the layout must stop moving before we measure. */
const SETTLE_SELECTORS = [EL.header.css, EL.sidePanel.css, EL.videoTile.css, EL.mapViewToggle.css, EL.flightStatus.css];

export const s003: Scenario = {
  id: 'scenario-003',
  title: '375px Responsive Integrity',
  user_goal: 'On a 375×667 phone viewport I can still read telemetry, pick a drone and use the map controls.',
  starting_state: {
    description: 'Simulator reset; cockpit loaded at / in a 375×667 viewport.',
    path: '/',
    viewport: VIEWPORT,
    simulator: 'reset',
    waitForDevices: true,
  },
  expected_behavior: [
    'The document does not scroll horizontally.',
    'Critical elements (device rows, telemetry, status, video state, map toggle, header controls) lie within the viewport horizontally and are not clipped by ancestors.',
    'Interactive controls can be scrolled into view and a click at their centre reaches them (not covered by another element).',
    'Top-level widgets (header, device/telemetry panel, video tile, map view toggle) do not overlap each other.',
    'Selecting a drone still updates telemetry at this width.',
  ],
  invariant: 'For every critical element e: 0 <= e.left && e.right <= 375 && clippedX(e) == 0; for interactive e: hitTest(center(e)) ∈ e; pairwise overlap of top-level widgets == 0.',
  evidence_requirements: ALL_EVIDENCE,
  tags: ['level-1', 'responsive', 'layout'],
  independent_steps: true,
  steps: [
    {
      name: 'No horizontal document overflow',
      action: async ({ api, memo, page, check, evidence }) => {
        memo.drones = await api.drones();
        const vw = await page.evaluate(() => window.innerWidth);
        check.precondition('browser viewport is 375px wide', vw === VIEWPORT.width, vw);
        const settle = await waitForLayoutStable(page, SETTLE_SELECTORS);
        evidence.note('layout_settle', settle);
        check.warn({ id: 'layout.settled', target: 'page', type: 'timeout' }, settle.stable, { expected: 'layout stops moving', actual: `still moving after ${settle.elapsedMs} ms` });
      },
      verify: async ({ page, check, evidence }) => {
        const o = await documentOverflow(page);
        evidence.note('document_overflow', o);
        check.that({ id: 'layout.no_horizontal_overflow', target: 'document', type: 'overflow' }, o.overflowX <= 1, {
          expected: `scrollWidth <= ${o.clientWidth}`,
          actual: o.scrollWidth,
          message: `document overflows by ${o.overflowX}px; offenders: ${o.offenders.map((x) => `${x.element}(right=${x.right})`).join(', ')}`,
          // The outermost offender identifies the symptom; the pixel amount is an observation.
          state: o.offenders[0]?.element ?? 'unknown',
          observed: { viewport: VIEWPORT, overflow_px: o.overflowX, scroll_width: o.scrollWidth, client_width: o.clientWidth, offenders: o.offenders },
        });
      },
    },
    {
      name: 'Critical elements are inside the viewport and not clipped horizontally',
      verify: async (ctx) => {
        const { memo, check, evidence } = ctx;
        const geos: ElementGeometry[] = [];
        for (const t of criticalTargets(memo.drones as DeviceInfo[])) {
          const g = await geometry(t.label, await measureTarget(t, ctx), t.selector);
          geos.push(g);
          const observed = { viewport: VIEWPORT, element: geoEvidence(g) };
          if (!check.that({ id: 'layout.critical_visible', target: t.target, type: g.found ? 'hidden' : 'missing' }, g.found && g.visible, { expected: 'visible', actual: g.found ? 'hidden' : 'missing', observed })) continue;
          check.that({ id: 'layout.in_viewport_x', target: t.target, type: 'out_of_viewport' }, insideViewportX(g.rect!, VIEWPORT.width), {
            expected: `0..${VIEWPORT.width}`, actual: fmtRect(g), state: g.rect!.x < 0 ? 'left' : 'right', observed, boxes: box(t.label, g.rect),
          });
          check.that({ id: 'layout.not_clipped_x', target: t.target, type: 'clipped' }, g.clippedX <= 1, { expected: '0px clipped', actual: `${g.clippedX}px clipped`, state: 'clipped', observed, boxes: box(t.label, g.rect) });
        }
        evidence.note('critical_geometry', geos);
      },
    },
    {
      name: 'Interactive controls are reachable and receive the pointer',
      verify: async (ctx) => {
        const { memo, check, evidence } = ctx;
        const geos: ElementGeometry[] = [];
        for (const t of criticalTargets(memo.drones as DeviceInfo[]).filter((x) => x.interactive)) {
          const loc = await measureTarget(t, ctx);
          if ((await loc.count()) === 0) {
            check.that({ id: 'layout.interactive_present', target: t.target, type: 'missing' }, false, { expected: 'present', actual: 'missing', observed: { viewport: VIEWPORT, selector: t.selector } });
            continue;
          }
          await loc.first().scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
          const g = await geometry(t.label, loc, t.selector);
          geos.push(g);
          if (!check.that({ id: 'layout.reachable', target: t.target, type: 'out_of_viewport' }, g.visibleRect !== null, { expected: 'on screen after scrolling', actual: fmtRect(g), state: g.visible ? 'offscreen' : 'hidden', observed: { viewport: VIEWPORT, element: geoEvidence(g) } })) continue;
          if (g.receivesPointer) {
            check.that({ id: 'layout.pointer_reaches', target: t.target, type: 'covered' }, true);
            continue;
          }
          // Covered: record who covers it, how much, and what an actual click attempt does.
          const probe = await probeActionable(loc); // actionability only: says whether a click COULD land, not that one worked
          const coverRect = g.hitRect;
          check.that({ id: 'layout.pointer_reaches', target: t.target, type: 'covered' }, false, {
            expected: `click at centre lands on ${t.selector}`,
            actual: `lands on ${g.hitTarget}`,
            message: `centre of ${t.label} is covered by ${g.hitTarget}; ${Math.round((1 - (g.coverage?.fraction ?? 0)) * 100)}% of sampled points covered; actionability probe: ${probe.stage} (${probe.reason})`,
            state: g.hitTarget ?? 'unknown', // WHO covers it is the identity; how much is an observation
            observed: {
              viewport: VIEWPORT,
              element: geoEvidence(g),
              covered_by: g.hitTarget,
              covered_by_rect: roundRect(coverRect),
              coverage: g.coverage,
              actionability: { method: 'playwright trial click (actionability checks only; nothing is clicked)', stage: probe.stage, reason: probe.reason, detail: probe.detail },
            },
            boxes: [...box(t.label, g.visibleRect), ...box(`covered by ${g.hitTarget}`, coverRect)],
          });
        }
        evidence.note('interactive_geometry', geos);
      },
    },
    {
      name: 'Top-level widgets do not overlap',
      verify: async ({ page, ui, check, evidence }) => {
        await page.evaluate((css) => document.querySelector(css)?.scrollTo(0, 0), EL.sidePanel.css);
        const g = async (target: string, label: string, loc: ReturnType<Ui['socketBadge']>, selector: string) => ({ target, geo: await geometry(label, loc, selector) });
        const widgets = [
          await g('role:banner', 'header', ui.header(), 'role=banner'),
          await g('region:device-telemetry-panel', 'device/telemetry panel', ui.sidePanel(), EL.sidePanel.css),
          await g('region:video-tile', 'video tile', ui.videoTile(), EL.videoTile.css),
          await g(`testid:${TID.mapViewToggle}`, 'map view toggle', ui.mapViewToggle(), `[data-testid=${TID.mapViewToggle}]`),
        ];
        const headerParts = [
          await g('region:brand', 'brand', ui.brand(), EL.brand.css),
          await g(`testid:${TID.socketStatus}`, 'socket badge', ui.socketBadge(), `[data-testid=${TID.socketStatus}]`),
          await g('link:control-panel', 'control panel link', ui.controlPanelLink(), 'role=link[name=/control panel/i]'),
        ];
        evidence.note('widget_geometry', [...widgets, ...headerParts].map((w) => ({ target: w.target, ...geoEvidence(w.geo) })));
        const pairs = <T,>(list: T[]) => list.flatMap((a, i) => list.slice(i + 1).map((b) => [a, b] as const));
        for (const [a, b] of [...pairs(widgets), ...pairs(headerParts)]) {
          if (!a.geo.visibleRect || !b.geo.visibleRect) continue;
          const [x, y] = [a, b].sort((p, q) => p.target.localeCompare(q.target)); // order-independent identity
          const area = Math.round(intersection(a.geo.visibleRect, b.geo.visibleRect));
          const inter = intersectionRect(a.geo.visibleRect, b.geo.visibleRect);
          check.that({ id: 'layout.no_overlap', target: `pair:${x.target}|${y.target}`, type: 'overlap' }, area <= 1, {
            expected: '0 px² overlap',
            actual: `${area} px² overlap`,
            message: `${a.geo.label} overlaps ${b.geo.label} by ${area} px² (${a.geo.label}: ${fmtRect(a.geo)} | ${b.geo.label}: ${fmtRect(b.geo)})`,
            state: 'overlap',
            observed: { viewport: VIEWPORT, overlap_px2: area, overlap_rect: roundRect(inter), a: { target: a.target, ...geoEvidence(a.geo) }, b: { target: b.target, ...geoEvidence(b.geo) } },
            boxes: [...box(a.geo.label, a.geo.visibleRect), ...box(b.geo.label, b.geo.visibleRect)],
          });
        }
      },
    },
    {
      name: 'Selecting a drone still updates telemetry at 375px',
      action: async ({ page, memo, check, healing }) => {
        const drones = memo.drones as DeviceInfo[];
        const sel = await readSelection(page);
        const target = drones.find((d) => !sel.selectedRowIds.includes(d.id)) ?? drones[0];
        memo.target = target;
        await healing.perform(check, selectDevice(target));
      },
      verify: async ({ page, memo, check }) => {
        const target = memo.target as DeviceInfo;
        const names = (memo.drones as DeviceInfo[]).map((d) => d.name);
        const poll = await pollUntil(() => readSelection(page), (s) => namedDevice(s.telemetryHeader, names) === target.name && s.selectedRowIds.join() === target.id, { timeoutMs: 5_000, intervalMs: 200 });
        check.equal({ id: 'selection.clicked_row_selected', target: `device:${target.id}`, type: 'mismatch' }, poll.last?.selectedRowIds, [target.id]);
        check.equal({ id: 'selection.telemetry_header_follows', target: `device:${target.id}`, type: 'mismatch' }, namedDevice(poll.last?.telemetryHeader ?? '', names), target.name);
      },
    },
  ],
};
