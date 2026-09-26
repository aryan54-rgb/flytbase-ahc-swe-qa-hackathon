import type { Locator, Page } from 'playwright';
import { EL } from '../utils/selectors.js';

/** Widgets a covering hit is attributed to (resolved from the semantic registry, not hard-coded classes). */
const WIDGETS: Array<[string, string]> = [
  [EL.videoTile.css, 'region:video-tile'],
  [EL.alertToast.css, 'region:toast'],
  [EL.header.css, 'role:banner'],
  [EL.sidePanel.css, 'region:device-telemetry-panel'],
  [EL.mapViewToggle.css, 'testid:map-view-toggle'],
];

/**
 * Geometry checks from live DOM rectangles (never screenshot pixels).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export interface ElementGeometry {
  label: string;
  selector: string;
  found: boolean;
  visible: boolean;
  rect: Rect | null;
  /** Visible part of the element after clipping by every overflow-hidden/auto/scroll ancestor and the viewport. */
  visibleRect: Rect | null;
  /** Horizontal px cut off by ancestors (scrolling can't fix this for non-horizontally-scrollable ancestors). */
  clippedX: number;
  /** Semantic identity of what is at the centre of the visible rect (foreign widget, else nearest data-testid). */
  hitTarget: string | null;
  /** Box of the covering widget when the element does not receive the pointer. */
  hitRect: Rect | null;
  /** True when the centre hit-test lands on the element or a descendant — where a real click lands. */
  receivesPointer: boolean;
  /** 3x3 grid hit-test over the visible rect: share of points that reach the element, and who covers the rest. */
  coverage: { points: number; reachable: number; fraction: number; coveredBy: string[] } | null;
}

export interface DocumentOverflow {
  viewportWidth: number;
  viewportHeight: number;
  scrollWidth: number;
  clientWidth: number;
  bodyScrollWidth: number;
  overflowX: number;
  /** Elements whose right edge exceeds the viewport, excluding ones inside a clipping ancestor. */
  offenders: Array<{ element: string; right: number; width: number }>;
}

export async function documentOverflow(page: Page): Promise<DocumentOverflow> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const vw = window.innerWidth;
    const describe = (el: Element) => {
      const tid = el.getAttribute('data-testid');
      const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
      return `${el.tagName.toLowerCase()}${tid ? `[data-testid=${tid}]` : ''}${cls ? `.${cls}` : ''}`;
    };
    const clippedByAncestor = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') return true;
      }
      return false;
    };
    const offenders: Array<{ element: string; right: number; width: number }> = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1 && !clippedByAncestor(el)) offenders.push({ element: describe(el), right: Math.round(r.right), width: Math.round(r.width) });
      if (offenders.length >= 15) break;
    }
    return {
      viewportWidth: vw,
      viewportHeight: window.innerHeight,
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      overflowX: Math.max(0, de.scrollWidth - de.clientWidth),
      offenders,
    };
  });
}

export async function geometry(label: string, locator: Locator, selector: string): Promise<ElementGeometry> {
  const empty: ElementGeometry = { label, selector, found: false, visible: false, rect: null, visibleRect: null, clippedX: 0, hitTarget: null, hitRect: null, receivesPointer: false, coverage: null };
  if ((await locator.count()) === 0) return empty;
  const el = locator.first();
  const visible = await el.isVisible();
  const g = await el.evaluate((node, WIDGETS) => {
    const toRect = (r: { x: number; y: number; width: number; height: number }) => ({
      x: r.x, y: r.y, width: r.width, height: r.height, right: r.x + r.width, bottom: r.y + r.height,
    });
    // Resolve a hit to the *widget* the user perceives (video tile, toast, header, side panel) when that
    // widget is foreign to the target; otherwise to the nearest test id. Leaf-level identities (video vs
    // its container's border) would flip on sub-pixel differences and are not what a user sees.
    const identityOf = (hit: Element): { id: string; el: Element } => {
      for (const [sel, name] of WIDGETS) {
        const w = hit.closest(sel);
        if (w && !w.contains(node)) return { id: name, el: w };
      }
      const withId = hit.closest('[data-testid]');
      if (withId) return { id: `testid:${withId.getAttribute('data-testid')}`, el: withId };
      const cls = typeof (hit as HTMLElement).className === 'string' ? (hit as HTMLElement).className.split(/\s+/).filter(Boolean)[0] : '';
      return { id: `${hit.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`, el: hit };
    };
    const identity = (hit: Element) => identityOf(hit).id;
    const r = node.getBoundingClientRect();
    let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
    let clippedX = 0;
    for (let p = node.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible') {
        const pr = p.getBoundingClientRect();
        const horizontallyScrollable = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth;
        if (!horizontallyScrollable) clippedX += Math.max(0, pr.left - left) + Math.max(0, right - pr.right);
        left = Math.max(left, pr.left);
        right = Math.min(right, pr.right);
      }
      if (cs.overflowY !== 'visible') {
        const pr = p.getBoundingClientRect();
        top = Math.max(top, pr.top);
        bottom = Math.min(bottom, pr.bottom);
      }
    }
    left = Math.max(left, 0);
    top = Math.max(top, 0);
    right = Math.min(right, window.innerWidth);
    bottom = Math.min(bottom, window.innerHeight);
    const hasVisible = right - left > 0.5 && bottom - top > 0.5;
    const visibleRect = hasVisible ? toRect({ x: left, y: top, width: right - left, height: bottom - top }) : null;

    let hitTarget: string | null = null;
    let hitRect: ReturnType<typeof toRect> | null = null;
    let receivesPointer = false;
    let coverage: { points: number; reachable: number; fraction: number; coveredBy: string[] } | null = null;
    if (visibleRect) {
      const at = (fx: number, fy: number) => document.elementFromPoint(left + (right - left) * fx, top + (bottom - top) * fy);
      const centre = at(0.5, 0.5);
      if (centre) {
        receivesPointer = node === centre || node.contains(centre);
        const who = identityOf(centre);
        hitTarget = who.id;
        if (!receivesPointer) hitRect = toRect(who.el.getBoundingClientRect());
      }
      const fr = [0.2, 0.5, 0.8];
      let reachable = 0;
      const coveredBy = new Set<string>();
      for (const fx of fr) for (const fy of fr) {
        const h = at(fx, fy);
        if (h && (h === node || node.contains(h))) reachable++;
        else if (h) coveredBy.add(identity(h));
      }
      coverage = { points: 9, reachable, fraction: Math.round((reachable / 9) * 100) / 100, coveredBy: [...coveredBy].sort() };
    }
    return { rect: toRect(r), visibleRect, clippedX: Math.round(clippedX), hitTarget, hitRect, receivesPointer, coverage };
  }, WIDGETS);
  return { ...empty, found: true, visible, ...g };
}

export function intersection(a: Rect, b: Rect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.x, b.x);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function intersectionRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y, right, bottom } : null;
}

export function insideViewportX(r: Rect, vw: number, tolerance = 1): boolean {
  return r.x >= -tolerance && r.right <= vw + tolerance;
}

export const roundRect = (r: Rect | null) =>
  r && { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };

/**
 * Deterministic replacement for "sleep and hope": resolves once the bounding boxes of the given
 * selectors are identical for `stableSamples` consecutive samples (fonts, lazy map, video tile settled).
 */
export async function waitForLayoutStable(page: Page, selectors: string[], opts: { timeoutMs?: number; intervalMs?: number; stableSamples?: number } = {}): Promise<{ stable: boolean; elapsedMs: number }> {
  const { timeoutMs = 8_000, intervalMs = 150, stableSamples = 3 } = opts;
  const t0 = Date.now();
  let last = '';
  let same = 0;
  while (Date.now() - t0 < timeoutMs) {
    const sig = await page.evaluate((sels) => sels.map((s) => {
      const el = document.querySelector(s);
      if (!el) return `${s}:none`;
      const r = el.getBoundingClientRect();
      return `${s}:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
    }).join('|'), selectors);
    same = sig === last ? same + 1 : 1;
    last = sig;
    if (same >= stableSamples) return { stable: true, elapsedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { stable: false, elapsedMs: Date.now() - t0 };
}
