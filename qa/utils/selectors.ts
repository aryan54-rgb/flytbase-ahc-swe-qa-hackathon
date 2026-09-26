import type { Locator, Page } from 'playwright';

/**
 * Semantic element registry — the single place that knows how to find cockpit UI parts.
 * Scenarios, layout probes and in-page evaluators all resolve elements through here, so selector
 * healing (later) is a change to one table, and `--selector-audit` can report on every entry.
 *
 * Strategy, most to least robust:
 *   testid       data-testid from frontend/src/testids.ts (a published test contract)
 *   role         ARIA role / accessible name, or the semantic HTML tag that carries that implicit role
 *   relational   defined by its relation to a testid'd element (CSS :has, no XPath)
 *   structural   position in the DOM tree only (breaks if markup is reordered)
 *   class-state  CSS class used as *state* because the app exposes no semantic equivalent
 *
 * No product testids were added: elements without one are reached relationally.
 */

export type Strategy = 'testid' | 'role' | 'relational' | 'structural' | 'class-state';

export interface SemanticElement {
  strategy: Strategy;
  /** CSS usable both by Playwright and by document.querySelector inside page.evaluate. */
  css: string;
  /** Preferred Playwright locator when it differs from `css` (role/name locators). */
  locate?: (page: Page) => Locator;
  note?: string;
}

const tid = (id: string, note?: string): SemanticElement => ({ strategy: 'testid', css: `[data-testid="${id}"]`, note });

export const TID = {
  socketStatus: 'socket-status',
  mapCanvas: 'map-canvas',
  mapViewToggle: 'map-view-toggle',
  mapView2d: 'map-view-2d',
  mapView3d: 'map-view-3d',
  telemetryBattery: 'telemetry-battery',
  telemetryAltRlt: 'telemetry-alt-rlt',
  telemetryAltAgl: 'telemetry-alt-agl',
  telemetryAltAsl: 'telemetry-alt-asl',
  telemetryHSpeed: 'telemetry-hspeed',
  telemetryVSpeed: 'telemetry-vspeed',
  telemetryWind: 'telemetry-wind',
  telemetryHomeDistance: 'telemetry-home-distance',
  telemetryHeading: 'telemetry-heading',
  statusFlight: 'status-flight',
  videoPlayer: 'video-player',
  videoState: 'video-state',
  alertToast: 'alert-toast',
} as const;

export const DEVICE_ROW_PREFIX = 'device-row-';

export const EL = {
  socketBadge: tid(TID.socketStatus),
  deviceRows: { strategy: 'testid', css: `[data-testid^="${DEVICE_ROW_PREFIX}"]`, note: 'prefix match; id suffix is the device id' } as SemanticElement,
  flightStatus: tid(TID.statusFlight),
  telemetryValues: { strategy: 'testid', css: '[data-testid^="telemetry-"]' } as SemanticElement,
  videoState: tid(TID.videoState),
  videoPlayer: tid(TID.videoPlayer, 'present both as <video> and as the "Video off" placeholder'),
  mapCanvas: tid(TID.mapCanvas),
  mapViewToggle: tid(TID.mapViewToggle),
  mapView2d: tid(TID.mapView2d),
  mapView3d: tid(TID.mapView3d),
  alertToast: tid(TID.alertToast),

  header: { strategy: 'role', css: 'header', locate: (p) => p.getByRole('banner'), note: '<header> = implicit banner role' } as SemanticElement,
  sidePanel: { strategy: 'role', css: 'aside', locate: (p) => p.getByRole('complementary'), note: '<aside> = implicit complementary role (device list + telemetry)' } as SemanticElement,
  mapRegion: { strategy: 'role', css: 'main', locate: (p) => p.getByRole('main') } as SemanticElement,
  controlPanelLink: { strategy: 'role', css: 'header a[href$="/dashboard"]', locate: (p) => p.getByRole('link', { name: /control panel/i }) } as SemanticElement,

  telemetryHeader: {
    strategy: 'relational',
    css: `h2:has([data-testid="${TID.statusFlight}"])`,
    locate: (p) => p.getByRole('heading').filter({ has: p.getByTestId(TID.statusFlight) }),
    note: 'the heading that contains the flight-status pill',
  } as SemanticElement,
  videoHeader: { strategy: 'relational', css: `:has(> [data-testid="${TID.videoState}"])`, note: 'parent of the video-state label' } as SemanticElement,
  videoTile: { strategy: 'relational', css: `:has(> [data-testid="${TID.videoPlayer}"])`, note: 'parent of the video player/placeholder' } as SemanticElement,

  brand: { strategy: 'structural', css: 'header > :first-child', note: 'first child of the banner; no testid/role exists' } as SemanticElement,

  selectedRow: { strategy: 'class-state', css: `[data-testid^="${DEVICE_ROW_PREFIX}"].selected`, note: 'selection is exposed only as a class (no aria-selected); backed by the selection.visually_distinct check' } as SemanticElement,
} satisfies Record<string, SemanticElement>;

export type ElementName = keyof typeof EL;

export const locateEl = (page: Page, name: ElementName): Locator => {
  const e: SemanticElement = EL[name];
  return e.locate ? e.locate(page) : page.locator(e.css);
};

export const ui = (page: Page) => ({
  appRoot: () => page.locator('#root'),
  header: () => locateEl(page, 'header'),
  brand: () => locateEl(page, 'brand'),
  sidePanel: () => locateEl(page, 'sidePanel'),
  controlPanelLink: () => locateEl(page, 'controlPanelLink'),
  socketBadge: () => locateEl(page, 'socketBadge'),

  deviceRows: () => locateEl(page, 'deviceRows'),
  deviceRow: (id: string) => page.getByTestId(`${DEVICE_ROW_PREFIX}${id}`),

  flightStatus: () => locateEl(page, 'flightStatus'),
  telemetryHeader: () => locateEl(page, 'telemetryHeader'),
  telemetryValue: (testid: string) => page.getByTestId(testid),
  telemetryValues: () => locateEl(page, 'telemetryValues'),

  videoState: () => locateEl(page, 'videoState'),
  videoHeader: () => locateEl(page, 'videoHeader'),
  videoTile: () => locateEl(page, 'videoTile'),

  mapViewToggle: () => locateEl(page, 'mapViewToggle'),
  mapView2d: () => locateEl(page, 'mapView2d'),
  mapView3d: () => locateEl(page, 'mapView3d'),
});

export type Ui = ReturnType<typeof ui>;

/** Live health of every registry entry: how many elements each resolves to right now. */
export async function selectorAudit(page: Page): Promise<Array<{ name: string; strategy: Strategy; css: string; playwright: string; matches: number; note?: string }>> {
  const out = [];
  for (const [name, e] of Object.entries(EL) as Array<[string, SemanticElement]>) {
    out.push({ name, strategy: e.strategy, css: e.css, playwright: e.locate ? 'role/filter locator' : 'css', matches: await (e.locate ? e.locate(page) : page.locator(e.css)).count(), note: e.note });
  }
  return out;
}

/** "12.3 m" -> 12.3, "—" -> null. */
export function parseNumber(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(text);
  return m ? Number(m[0]) : null;
}
