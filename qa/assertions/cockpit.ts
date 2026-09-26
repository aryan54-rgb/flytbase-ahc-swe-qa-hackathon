import type { Page } from 'playwright';
import { DEVICE_ROW_PREFIX, EL, parseNumber, TID, ui } from '../utils/selectors.js';

/**
 * Structured read of what the cockpit is *showing*. Compare this against ApiClient ground truth.
 *
 * Rows are read by their visible text (leaf text nodes), not by CSS class names, so renaming
 * `.device-name`/`.pill` does not break the suite while changing what the user sees does.
 * Selection is the one exception: the app exposes it only as the `selected` class, so we also
 * check that the selected row is *visually* distinct (computed style) — see UiDeviceRow.style.
 */

export const FLIGHT_STATUSES = ['standby', 'taking_off', 'in_flight', 'landing'] as const;

export interface UiDeviceRow {
  id: string | null;
  /** Visible leaf texts in DOM order, e.g. ["Drone 1", "Dock 1", "dock closed", "standby"]. */
  texts: string[];
  /** The flight-status word shown in the row (last exact match of a known status), or '' if none. */
  flightStatus: string;
  selected: boolean;
  visible: boolean;
  /** Computed look, used to verify the selection is perceivable, not just a class. */
  style: string;
}

export interface UiSelection {
  telemetryHeader: string;
  videoHeader: string;
  flightStatus: string;
  headingDeg: number | null;
  altitudeM: number | null;
  selectedRowIds: string[];
}

export async function readDeviceRows(page: Page): Promise<UiDeviceRow[]> {
  return page.evaluate(
    ({ prefix, statuses }) =>
      Array.from(document.querySelectorAll(`[data-testid^="${prefix}"]`)).map((row) => {
        const texts = Array.from(row.querySelectorAll('*'))
          .filter((el) => el.children.length === 0)
          .map((el) => (el.textContent ?? '').trim())
          .filter(Boolean);
        const status = [...texts].reverse().find((t) => statuses.includes(t)) ?? '';
        const cs = getComputedStyle(row);
        const r = row.getBoundingClientRect();
        return {
          id: row.getAttribute('data-testid')?.slice(prefix.length) ?? null,
          texts,
          flightStatus: status,
          selected: row.classList.contains('selected'), // class-state: see EL.selectedRow
          visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
          style: `${cs.backgroundColor}|${cs.borderColor}|${cs.outlineStyle}:${cs.outlineColor}|${cs.boxShadow}`,
        };
      }),
    { prefix: DEVICE_ROW_PREFIX, statuses: [...FLIGHT_STATUSES] as string[] },
  );
}

export async function readSelection(page: Page): Promise<UiSelection> {
  // One atomic read. Header texts exclude the status/state child they contain, so "Drone 2" is not
  // glued to "standby" ("Drone 2standby") by textContent concatenation.
  const raw = await page.evaluate(
    ({ telemetryHeader, videoHeader, statusCss, stateCss, headingCss, altCss }) => {
      const textWithout = (css: string, exclude: string) => {
        const el = document.querySelector(css);
        if (!el) return '';
        const clone = el.cloneNode(true) as Element;
        clone.querySelectorAll(exclude).forEach((n) => n.remove());
        return (clone.textContent ?? '').trim();
      };
      const text = (css: string) => document.querySelector(css)?.textContent?.trim() ?? '';
      return {
        telemetryHeader: textWithout(telemetryHeader, statusCss),
        videoHeader: textWithout(videoHeader, stateCss),
        flightStatus: text(statusCss),
        heading: text(headingCss),
        altitude: text(altCss),
      };
    },
    {
      telemetryHeader: EL.telemetryHeader.css,
      videoHeader: EL.videoHeader.css,
      statusCss: EL.flightStatus.css,
      stateCss: EL.videoState.css,
      headingCss: `[data-testid="${TID.telemetryHeading}"]`,
      altCss: `[data-testid="${TID.telemetryAltRlt}"]`,
    },
  );
  const rows = await readDeviceRows(page);
  return {
    telemetryHeader: raw.telemetryHeader,
    videoHeader: raw.videoHeader,
    flightStatus: raw.flightStatus,
    headingDeg: parseNumber(raw.heading),
    altitudeM: parseNumber(raw.altitude),
    selectedRowIds: rows.filter((r) => r.selected).map((r) => r.id ?? '?'),
  };
}

/**
 * Which known device a piece of UI text names. Longest whole-name match wins, so "Drone 1" never
 * matches inside "Drone 10", and the header's formatting ("X · name", "name - X"...) is irrelevant.
 */
export function namedDevice(text: string, names: string[]): string | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits = names.filter((n) => new RegExp(`(^|[^\\w])${esc(n)}($|[^\\w])`).test(text));
  return hits.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** Resolves once at least one device row is rendered; returns false on timeout instead of throwing. */
export async function waitForDeviceRows(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await ui(page).deviceRows().first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export interface FlightSnapshot {
  headerStatus: string;
  rowStatus: string;
  altitudeM: number | null;
}

/**
 * Atomic, cheap read (one evaluate = one frame) of the status/altitude a user sees for a drone.
 * Used for high-frequency cross-tier sampling where per-locator reads would be slow and skewed.
 */
export async function readFlightSnapshot(page: Page, droneId: string): Promise<FlightSnapshot> {
  const raw = await page.evaluate(
    ({ rowTid, statusTid, altTid, statuses }) => {
      const text = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? '';
      const row = document.querySelector(`[data-testid="${rowTid}"]`);
      const leafs = row ? Array.from(row.querySelectorAll('*')).filter((el) => el.children.length === 0).map((el) => (el.textContent ?? '').trim()) : [];
      return {
        headerStatus: text(`[data-testid="${statusTid}"]`),
        rowStatus: [...leafs].reverse().find((t) => statuses.includes(t)) ?? '',
        altitudeText: text(`[data-testid="${altTid}"]`),
      };
    },
    { rowTid: `${DEVICE_ROW_PREFIX}${droneId}`, statusTid: TID.statusFlight, altTid: TID.telemetryAltRlt, statuses: [...FLIGHT_STATUSES] as string[] },
  );
  return { headerStatus: raw.headerStatus, rowStatus: raw.rowStatus, altitudeM: parseNumber(raw.altitudeText) };
}
