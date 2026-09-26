import type { CDPSession, Page } from 'playwright';
import { namedDevice } from '../assertions/cockpit.js';
import { DEVICE_ROW_PREFIX, EL, TID } from '../utils/selectors.js';
import type { BrowserWindowMetrics, CdpWindowMetrics, TelemetryProbe } from './types.js';

/**
 * In-browser performance probe. Observation only: nothing in the product is changed or called.
 *
 * Installed with page.addInitScript BEFORE the cockpit loads, so observers see the whole session:
 *   - PerformanceObserver 'longtask'            -> count, max, total blocking time
 *   - PerformanceObserver 'long-animation-frame' -> blocking time + script attribution (if supported)
 *   - PerformanceObserver 'event'               -> Event Timing of clicks (if supported)
 *   - requestAnimationFrame loop                -> frame cadence (FPS, >33.3 ms frames, longest gap)
 *   - performance.memory                        -> JS heap (only if the browser exposes it; else null)
 *   - window error / unhandledrejection / webglcontextlost (capture phase)
 *   - WebSocket subclass: counts frames/opens/closes and keeps a small ring buffer of each device's
 *     global_position payloads (arrival time + payload timestamp). socket.io still gets the native
 *     socket behaviour; only an extra 'message' listener is attached.
 *   - Cesium scene preRender/postRender listeners (found read-only through the React fiber, as in
 *     assertions/cesium.ts) -> render count and render time. Unobservable => reported as such.
 *
 * Interaction latency is measured in the page: from the click event's timestamp to the first
 * animation frame in which the intended POSTCONDITION holds (row selected AND telemetry header names
 * the drone; or the map button pressed AND the camera at the target pitch). A dispatched click
 * without the postcondition is never counted as a successful interaction.
 */

declare global {
  interface Window {
    __qaPerf?: QaPerfApi;
  }
}

interface InteractionSpec {
  kind: 'select' | 'map';
  /** CSS of the element whose click starts the clock. */
  clickCss: string;
  /** select: the row that must carry the selected class; name that must appear in the telemetry header. */
  rowCss?: string;
  name?: string;
  headerCss?: string;
  /** Child of the header to ignore (the status pill: its text is glued to the name in textContent). */
  headerExcludeCss?: string;
  /** map: button whose aria-pressed must become true; target pitch/tilt. */
  pressedCss?: string;
  pitchDeg?: number;
  tilt?: boolean;
  timeoutMs: number;
}

export interface InteractionOutcome {
  done: boolean;
  clicked: boolean;
  satisfied: boolean;
  latency_ms: number | null;
  settle_ms: number | null;
  event_timing_ms: number | null;
  timed_out: boolean;
}

interface QaPerfApi {
  version: number;
  beginWindow: () => void;
  endWindow: () => BrowserWindowMetrics;
  arm: (spec: InteractionSpec) => void;
  interaction: () => InteractionOutcome;
  telemetry: (spec: { rowPrefix: string; headerCss: string; headerExcludeCss: string; altCss: string; hspeedCss: string; distCss: string }) => Omit<TelemetryProbe, 't_rel_ms' | 'header_matches_selected'> & { header: string; transit_raw_ms: { min: number; max: number } | null };
  video: (deviceId: string) => { enabled: boolean | null; url: string | null };
  /** `tracks`: rendered track polyline length per device (the store caps each at MAX_TRACK). */
  mapInfo: () => { observable: boolean; reason?: string; track_points: number | null; entities: number | null; tracks: Record<string, number> };
  rowIds: (prefix: string) => string[];
  waitRows: (prefix: string, ids: string[], timeoutMs: number) => Promise<{ ok: boolean; at_epoch: number; missing: string[]; extra: string[] }>;
  stop: () => void;
}

/** The init script. Self-contained: it is serialised into the page. */
function installQaPerf(): void {
  const w = window as Window & typeof globalThis;
  if (w.__qaPerf) return;
  type Frame = { arrival: number; ts: number; h: number; hs: number; dist: number };
  const MAX_FRAMES = 40;
  const st = {
    running: true,
    winStart: performance.now(),
    frames: [] as number[],
    longtasks: [] as Array<{ start: number; dur: number }>,
    loaf: [] as Array<{ start: number; dur: number; blocking: number; scripts: Array<{ src: string; inv: string; dur: number }> }>,
    events: [] as Array<{ name: string; start: number; dur: number }>,
    ws: { messages: 0, opens: 0, closes: 0 },
    buffers: new Map<string, Frame[]>(),
    video: new Map<string, { enabled: boolean; url: string | null }>(),
    pageErrors: 0,
    rejections: 0,
    webglLost: 0,
    support: { longtask: false, loaf: false, event: false },
    map: { hooked: false, reason: 'not attached', renders: 0, renderMs: [] as number[], pre: 0, viewer: null as null | Record<string, any> },
    ia: null as null | { spec: InteractionSpec; armedAt: number; t0: number | null; ack: number | null; settle: number | null; done: boolean; timedOut: boolean; lastPos: { x: number; y: number; z: number } | null },
  };

  const observe = (type: string, cb: (list: PerformanceObserverEntryList) => void, extra: Record<string, unknown> = {}) => {
    try {
      const o = new PerformanceObserver(cb);
      o.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      return true;
    } catch {
      return false;
    }
  };
  st.support.longtask = observe('longtask', (l) => {
    for (const e of l.getEntries()) st.longtasks.push({ start: e.startTime, dur: e.duration });
    if (st.longtasks.length > 5000) st.longtasks.splice(0, st.longtasks.length - 5000);
  });
  st.support.loaf = observe('long-animation-frame', (l) => {
    for (const e of l.getEntries() as unknown as Array<{ startTime: number; duration: number; blockingDuration?: number; scripts?: Array<{ sourceURL?: string; invoker?: string; duration: number }> }>) {
      st.loaf.push({ start: e.startTime, dur: e.duration, blocking: e.blockingDuration ?? 0, scripts: (e.scripts ?? []).map((s) => ({ src: (s.sourceURL ?? '').split('?')[0].split('/').pop() ?? '', inv: (s.invoker ?? '').slice(0, 60), dur: s.duration })) });
    }
    if (st.loaf.length > 2000) st.loaf.splice(0, st.loaf.length - 2000);
  });
  st.support.event = observe(
    'event',
    (l) => {
      for (const e of l.getEntries()) st.events.push({ name: e.name, start: e.startTime, dur: e.duration });
      if (st.events.length > 500) st.events.splice(0, st.events.length - 500);
    },
    { durationThreshold: 16 },
  );

  w.addEventListener('error', () => st.pageErrors++, true);
  w.addEventListener('unhandledrejection', () => st.rejections++);
  w.addEventListener('webglcontextlost', () => st.webglLost++, true);

  // ---- WebSocket tap (extra listener only)
  const Native = w.WebSocket;
  class QaWebSocket extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('open', () => st.ws.opens++);
      this.addEventListener('close', () => st.ws.closes++);
      this.addEventListener('message', (e: MessageEvent) => {
        st.ws.messages++;
        const d = e.data;
        if (typeof d !== 'string' || d.charCodeAt(0) !== 52) return; // socket.io "4x" packets only
        const isPos = d.includes('/telemetry/global_position');
        if (!isPos && !d.includes('/telemetry/video')) return;
        try {
          const [topicName, payload] = JSON.parse(d.slice(d.indexOf('['))) as [string, Record<string, any>];
          const id = topicName.split('/')[1];
          if (isPos) {
            const buf = st.buffers.get(id) ?? [];
            buf.push({ arrival: Date.now(), ts: payload.timestamp, h: payload.position?.height, hs: payload.speed?.horizontal, dist: payload.home_position?.distance });
            if (buf.length > MAX_FRAMES) buf.shift();
            st.buffers.set(id, buf);
          } else st.video.set(id, { enabled: !!payload.enabled, url: payload.url ?? null });
        } catch {
          /* not a JSON event packet */
        }
      });
    }
  }
  w.WebSocket = QaWebSocket as unknown as typeof WebSocket;

  // ---- Cesium viewer (read-only lookup by shape through React's fiber; listeners only)
  const findViewer = (): Record<string, any> | null => {
    const host = document.querySelector('[data-testid="map-canvas"]') as (Element & Record<string, unknown>) | null;
    if (!host) return (st.map.reason = 'map container not in DOM'), null;
    const key = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return (st.map.reason = 'no React fiber on map container'), null;
    let fiber = host[key] as { memoizedState?: any; return?: any } | undefined;
    for (let depth = 0; fiber && depth < 25; depth++) {
      for (let h = fiber.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) {
        const v = h.memoizedState?.current;
        if (v && typeof v === 'object' && v.camera && v.scene && typeof v.isDestroyed === 'function' && !v.isDestroyed()) return v;
      }
      fiber = fiber.return;
    }
    st.map.reason = 'no Cesium viewer reachable from the map component';
    return null;
  };
  const hookMap = () => {
    if (st.map.hooked && st.map.viewer && !st.map.viewer.isDestroyed()) return;
    const v = findViewer();
    if (!v) return;
    try {
      v.scene.preRender.addEventListener(() => (st.map.pre = performance.now()));
      v.scene.postRender.addEventListener(() => {
        st.map.renders++;
        if (st.map.pre) st.map.renderMs.push(performance.now() - st.map.pre);
        if (st.map.renderMs.length > 5000) st.map.renderMs.splice(0, 2500);
      });
      st.map.viewer = v;
      st.map.hooked = true;
      st.map.reason = '';
    } catch (e) {
      st.map.reason = `could not attach render listeners: ${(e as Error).message}`;
    }
  };

  /** Text of `css` without the `exclude` children (e.g. "Drone 4" not "Drone 4standby"). */
  const textWithout = (css: string, exclude?: string) => {
    const el = document.querySelector(css);
    if (!el) return '';
    if (!exclude) return el.textContent ?? '';
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll(exclude).forEach((n) => n.remove());
    return clone.textContent ?? '';
  };
  const nameIn = (text: string, name: string) => new RegExp(`(^|[^\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w])`).test(text);

  // ---- Interaction clock: capture-phase click listener starts it; the frame loop stops it.
  w.addEventListener(
    'click',
    (e) => {
      const ia = st.ia;
      if (ia && ia.t0 === null && e.target instanceof Element && e.target.closest(ia.spec.clickCss)) ia.t0 = e.timeStamp;
    },
    true,
  );

  const checkInteraction = () => {
    const ia = st.ia;
    if (!ia || ia.done) return;
    const now = performance.now();
    if (ia.t0 !== null) {
      const s = ia.spec;
      if (s.kind === 'select') {
        const row = document.querySelector(s.rowCss!);
        const header = textWithout(s.headerCss!, s.headerExcludeCss);
        if (row?.classList.contains('selected') && nameIn(header, s.name!)) {
          ia.ack = now - ia.t0;
          ia.done = true;
        }
      } else {
        if (ia.ack === null && document.querySelector(s.pressedCss!)?.getAttribute('aria-pressed') === 'true') ia.ack = now - ia.t0;
        const v = st.map.viewer;
        if (ia.ack !== null && v && !v.isDestroyed()) {
          const p = v.camera.positionWC;
          const pos = { x: p.x, y: p.y, z: p.z };
          const moved = ia.lastPos ? Math.hypot(pos.x - ia.lastPos.x, pos.y - ia.lastPos.y, pos.z - ia.lastPos.z) : Infinity;
          ia.lastPos = pos;
          const pitch = (v.camera.pitch * 180) / Math.PI;
          if (v.scene.screenSpaceCameraController.enableTilt === s.tilt && Math.abs(pitch - s.pitchDeg!) <= 1 && moved < 0.5) {
            ia.settle = now - ia.t0;
            ia.done = true;
          }
        } else if (ia.ack !== null && !v) ia.done = true; // map unobservable: ack only
      }
    }
    if (!ia.done && now - (ia.t0 ?? ia.armedAt) > ia.spec.timeoutMs) {
      ia.done = true;
      ia.timedOut = true;
    }
  };

  const loop = (t: number) => {
    if (!st.running) return;
    st.frames.push(t);
    if (st.frames.length > 20000) st.frames.splice(0, 10000);
    checkInteraction();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const api: QaPerfApi = {
    version: 1,
    beginWindow() {
      hookMap();
      st.winStart = performance.now();
      st.frames = [];
      st.longtasks = st.longtasks.filter((x) => x.start + x.dur >= st.winStart);
      st.loaf = [];
      st.ws = { messages: 0, opens: 0, closes: 0 };
      st.pageErrors = 0;
      st.rejections = 0;
      st.webglLost = 0;
      st.map.renders = 0;
      st.map.renderMs = [];
    },
    endWindow() {
      const end = performance.now();
      const dur = end - st.winStart;
      const f = st.frames.filter((t) => t >= st.winStart);
      let maxGap = f.length ? f[0] - st.winStart : dur;
      let over33 = 0;
      for (let i = 1; i < f.length; i++) {
        const g = f[i] - f[i - 1];
        if (g > maxGap) maxGap = g;
        if (g > 33.4) over33++;
      }
      if (f.length) maxGap = Math.max(maxGap, end - f[f.length - 1]);
      const seconds = Math.floor(dur / 1000);
      const buckets: number[] = [];
      for (let s = 0; s < seconds; s++) buckets.push(f.filter((t) => t >= st.winStart + s * 1000 && t < st.winStart + (s + 1) * 1000).length);
      const sorted = [...buckets].sort((a, b) => a - b);
      const p10 = sorted.length >= 2 ? sorted[Math.floor(0.1 * (sorted.length - 1))] : null;
      const lts = st.longtasks.filter((x) => x.start >= st.winStart && x.start < end);
      const loafs = st.loaf.filter((x) => x.start >= st.winStart);
      const scripts = new Map<string, { source: string; invoker: string; duration_ms: number; count: number }>();
      for (const lf of loafs)
        for (const s of lf.scripts) {
          const k = `${s.src}|${s.inv}`;
          const e = scripts.get(k) ?? { source: s.src || '(inline)', invoker: s.inv, duration_ms: 0, count: 0 };
          e.duration_ms += s.dur;
          e.count++;
          scripts.set(k, e);
        }
      const evs = st.events.filter((e) => e.start >= st.winStart && (e.name === 'click' || e.name === 'pointerdown' || e.name === 'pointerup'));
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      const rms = st.map.renderMs;
      let trackPoints: number | null = null;
      let entities: number | null = null;
      const v = st.map.viewer;
      if (v && !v.isDestroyed()) {
        try {
          const all = v.entities.values as Array<{ id: string; polyline?: { positions?: { getValue: (t: unknown) => unknown[] } } }>;
          entities = all.length;
          trackPoints = all.filter((e) => String(e.id).startsWith('track:')).reduce((a, e) => a + (e.polyline?.positions?.getValue(v.clock.currentTime)?.length ?? 0), 0);
        } catch {
          trackPoints = null;
        }
      }
      return {
        duration_ms: Math.round(dur),
        frames: f.length,
        fps_mean: f.length ? (f.length / dur) * 1000 : null,
        fps_p10: p10,
        fps_min_second: sorted.length ? sorted[0] : null,
        frames_over_33ms: over33,
        max_frame_gap_ms: Math.round(maxGap * 10) / 10,
        long_task_supported: st.support.longtask,
        long_tasks: lts.length,
        long_task_max_ms: lts.reduce((m, x) => Math.max(m, x.dur), 0),
        tbt_ms: lts.reduce((a, x) => a + Math.max(0, x.dur - 50), 0),
        loaf_supported: st.support.loaf,
        loaf: st.support.loaf
          ? {
              count: loafs.length,
              blocking_ms: loafs.reduce((a, x) => a + x.blocking, 0),
              top_scripts: [...scripts.values()].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 5).map((s) => ({ ...s, duration_ms: Math.round(s.duration_ms) })),
            }
          : null,
        event_timing_supported: st.support.event,
        event_timing_max_ms: st.support.event ? evs.reduce((m, e) => Math.max(m, e.dur), 0) : null,
        memory_supported: !!mem,
        heap_used_bytes: mem ? mem.usedJSHeapSize : null,
        dom_nodes: document.getElementsByTagName('*').length,
        ws_messages: st.ws.messages,
        ws_msgs_per_s: dur > 0 ? (st.ws.messages / dur) * 1000 : 0,
        ws_opens: st.ws.opens,
        ws_closes: st.ws.closes,
        page_errors: st.pageErrors,
        unhandled_rejections: st.rejections,
        webgl_context_lost: st.webglLost,
        socket_badge: document.querySelector('[data-testid="socket-status"]')?.textContent?.trim() ?? '',
        map: {
          observable: st.map.hooked,
          renders: st.map.renders,
          render_ms_mean: rms.length ? rms.reduce((a, b) => a + b, 0) / rms.length : null,
          render_ms_max: rms.length ? Math.max(...rms) : null,
          track_points: trackPoints,
          entities,
          reason: st.map.hooked ? undefined : st.map.reason,
        },
      };
    },
    arm(spec) {
      hookMap();
      st.ia = { spec, armedAt: performance.now(), t0: null, ack: null, settle: null, done: false, timedOut: false, lastPos: null };
    },
    interaction() {
      const ia = st.ia;
      if (!ia) return { done: false, clicked: false, satisfied: false, latency_ms: null, settle_ms: null, event_timing_ms: null, timed_out: false };
      checkInteraction(); // also progresses when rAF is starved
      const ev = ia.t0 === null ? undefined : st.events.find((e) => e.name === 'click' && Math.abs(e.start - ia.t0!) < 2);
      const satisfied = ia.spec.kind === 'select' ? ia.ack !== null : ia.ack !== null && (ia.settle !== null || !st.map.viewer);
      return { done: ia.done, clicked: ia.t0 !== null, satisfied: ia.done && satisfied, latency_ms: ia.ack, settle_ms: ia.settle, event_timing_ms: ev ? ev.dur : null, timed_out: ia.timedOut };
    },
    telemetry(spec) {
      const selected = document.querySelector(`[data-testid^="${spec.rowPrefix}"].selected`)?.getAttribute('data-testid')?.slice(spec.rowPrefix.length) ?? '';
      const header = textWithout(spec.headerCss, spec.headerExcludeCss);
      const num = (css: string) => {
        const m = /-?\d+(?:\.\d+)?/.exec(document.querySelector(css)?.textContent ?? '');
        return m ? m[0] : null;
      };
      const alt = num(spec.altCss);
      const hs = num(spec.hspeedCss);
      const dist = num(spec.distCss);
      const matches = (fr: Frame) => alt !== null && hs !== null && dist !== null && fr.h?.toFixed(1) === alt && fr.hs?.toFixed(1) === hs && fr.dist?.toFixed(0) === dist;
      const now = Date.now();
      const own = st.buffers.get(selected) ?? [];
      const hit = [...own].reverse().find(matches);
      let other: string | null = null;
      if (!hit) for (const [id, buf] of st.buffers) if (id !== selected && buf.some(matches)) other = id;
      // Cross-clock (simulator payload timestamp vs browser clock): diagnostic only.
      let transit: { min: number; max: number } | null = null;
      for (const buf of st.buffers.values())
        for (const fr of buf)
          if (Number.isFinite(fr.ts)) {
            const d = fr.arrival - fr.ts;
            transit = transit ? { min: Math.min(transit.min, d), max: Math.max(transit.max, d) } : { min: d, max: d };
          }
      const ageRaw = hit ? now - hit.ts : null;
      return {
        device_id: selected,
        header,
        matched_selected_device: !!hit,
        matched_other_device: other,
        age_raw_ms: ageRaw,
        // Same clock (browser): how long ago the frame now on screen was received.
        age_ms: hit ? now - hit.arrival : null,
        arrival_age_ms: own.length ? now - own[own.length - 1].arrival : null,
        frames_buffered: own.length,
        transit_raw_ms: transit,
      };
    },
    video(id) {
      const v = st.video.get(id);
      return { enabled: v ? v.enabled : null, url: v ? v.url : null };
    },
    mapInfo() {
      hookMap();
      const v = st.map.viewer;
      if (!v) return { observable: false, reason: st.map.reason, track_points: null, entities: null, tracks: {} };
      const all = v.entities.values as Array<{ id: string; polyline?: { positions?: { getValue: (t: unknown) => unknown[] } } }>;
      const tracks: Record<string, number> = {};
      for (const e of all) if (String(e.id).startsWith('track:')) tracks[String(e.id).slice(6)] = e.polyline?.positions?.getValue(v.clock.currentTime)?.length ?? 0;
      return { observable: true, track_points: Object.values(tracks).reduce((a, b) => a + b, 0), entities: all.length, tracks };
    },
    rowIds(prefix) {
      return Array.from(document.querySelectorAll(`[data-testid^="${prefix}"]`)).map((r) => r.getAttribute('data-testid')!.slice(prefix.length));
    },
    waitRows(prefix, ids, timeoutMs) {
      const want = new Set(ids);
      const t0 = performance.now();
      return new Promise((resolve) => {
        const tick = () => {
          const have = new Set(api.rowIds(prefix));
          const missing = [...want].filter((x) => !have.has(x));
          const extra = [...have].filter((x) => !want.has(x));
          if ((missing.length === 0 && extra.length === 0) || performance.now() - t0 > timeoutMs) return resolve({ ok: missing.length === 0 && extra.length === 0, at_epoch: Date.now(), missing, extra });
          requestAnimationFrame(tick);
        };
        tick();
      });
    },
    stop() {
      st.running = false;
    },
  };
  w.__qaPerf = api;
}


// ------------------------------------------------------------------------------------ Node side

/** The page did not answer within the freeze budget: treated as a severe failure, not a harness bug. */
export class PageUnresponsive extends Error {
  constructor(readonly waitedMs: number, what: string) {
    super(`page unresponsive for ${waitedMs} ms (${what})`);
    this.name = 'PageUnresponsive';
  }
}

export async function guarded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new PageUnresponsive(ms, what)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

const TELEMETRY_SPEC = {
  rowPrefix: DEVICE_ROW_PREFIX,
  headerCss: EL.telemetryHeader.css,
  headerExcludeCss: EL.flightStatus.css,
  altCss: `[data-testid="${TID.telemetryAltRlt}"]`,
  hspeedCss: `[data-testid="${TID.telemetryHSpeed}"]`,
  distCss: `[data-testid="${TID.telemetryHomeDistance}"]`,
};

export interface HeapReading {
  performance_memory_bytes: number | null;
  post_gc_bytes: number | null;
  source: 'performance.memory' | 'cdp' | 'unavailable';
}

export class BrowserProbe {
  private cdp: CDPSession | null = null;
  private cdpReason = 'not started';
  private cdpStart: Map<string, number> | null = null;
  private windowStartedAt = 0;

  constructor(readonly page: Page, readonly freezeMs: number) {}

  /** Must run before the cockpit is loaded. */
  async install(): Promise<void> {
    // As a string with the __name shim first: tsx (esbuild keepNames) wraps named functions in
    // __name(...), and the order of context vs page init scripts is not guaranteed.
    await this.page.addInitScript({ content: `globalThis.__name = globalThis.__name || ((f) => f);
(${installQaPerf.toString()})();` });
  }

  /** After navigation: verify the probe is live and open the (optional) CDP session. */
  async start(): Promise<{ probe: boolean; cdp: boolean; cdp_reason: string }> {
    const probe = await guarded(this.page.evaluate(() => !!window.__qaPerf), this.freezeMs, 'probe start');
    try {
      this.cdp = await this.page.context().newCDPSession(this.page);
      await this.cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
      this.cdpReason = '';
    } catch (e) {
      this.cdp = null;
      this.cdpReason = `CDP unavailable: ${(e as Error).message.split('\n')[0]}`;
    }
    return { probe, cdp: !!this.cdp, cdp_reason: this.cdpReason };
  }

  private async cdpMetrics(): Promise<Map<string, number> | null> {
    if (!this.cdp) return null;
    try {
      const r = (await this.cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> };
      return new Map(r.metrics.map((m) => [m.name, m.value]));
    } catch {
      return null;
    }
  }

  async beginWindow(): Promise<void> {
    await guarded(this.page.evaluate(() => window.__qaPerf!.beginWindow()), this.freezeMs, 'begin window');
    this.cdpStart = await this.cdpMetrics();
    this.windowStartedAt = Date.now();
  }

  async endWindow(): Promise<{ browser: BrowserWindowMetrics; cdp: CdpWindowMetrics | null }> {
    const browser = await guarded(this.page.evaluate(() => window.__qaPerf!.endWindow()), this.freezeMs, 'end window');
    const end = await this.cdpMetrics();
    let cdp: CdpWindowMetrics | null = null;
    if (end && this.cdpStart) {
      const secs = Math.max(0.001, (Date.now() - this.windowStartedAt) / 1000);
      const d = (k: string) => (end.has(k) && this.cdpStart!.has(k) ? end.get(k)! - this.cdpStart!.get(k)! : null);
      const ratio = (k: string) => {
        const x = d(k);
        return x === null ? null : Math.round((x / secs) * 1000) / 1000;
      };
      const ms = (k: string) => {
        const x = d(k);
        return x === null ? null : Math.round(x * 1000);
      };
      cdp = { task_busy_ratio: ratio('TaskDuration'), script_busy_ratio: ratio('ScriptDuration'), layout_ms: ms('LayoutDuration'), recalc_style_ms: ms('RecalcStyleDuration'), heap_used_bytes: end.get('JSHeapUsedSize') ?? null, nodes: end.get('Nodes') ?? null };
    }
    return { browser, cdp };
  }

  /** `names`: device id -> display name, to check the telemetry header names the selected drone. */
  async telemetry(tRel: number, names: Record<string, string>): Promise<TelemetryProbe & { header: string; transit_raw_ms: { min: number; max: number } | null }> {
    const r = await guarded(this.page.evaluate((spec) => window.__qaPerf!.telemetry(spec), TELEMETRY_SPEC), this.freezeMs, 'telemetry sample');
    const expected = names[r.device_id];
    return { t_rel_ms: tRel, ...r, header_matches_selected: !!expected && namedDevice(r.header, Object.values(names)) === expected };
  }

  async arm(spec: InteractionSpec): Promise<void> {
    await guarded(this.page.evaluate((s) => window.__qaPerf!.arm(s), spec), this.freezeMs, 'arm interaction');
  }

  async interaction(): Promise<InteractionOutcome> {
    return guarded(this.page.evaluate(() => window.__qaPerf!.interaction()), this.freezeMs, 'interaction result');
  }

  async video(deviceId: string) {
    return guarded(this.page.evaluate((id) => window.__qaPerf!.video(id), deviceId), this.freezeMs, 'video state');
  }

  async mapInfo() {
    return guarded(this.page.evaluate(() => window.__qaPerf!.mapInfo()), this.freezeMs, 'map info');
  }

  async rowIds(): Promise<string[]> {
    return guarded(this.page.evaluate((p) => window.__qaPerf!.rowIds(p), DEVICE_ROW_PREFIX), this.freezeMs, 'row ids');
  }

  /** In-page rAF wait until the rendered row set equals `ids`; returns the page's Date.now() at that frame. */
  async waitRows(ids: string[], timeoutMs: number) {
    return guarded(this.page.evaluate(({ p, ids, t }) => window.__qaPerf!.waitRows(p, ids, t), { p: DEVICE_ROW_PREFIX, ids, t: timeoutMs }), timeoutMs + this.freezeMs, 'wait rows');
  }

  /**
   * Heap: performance.memory if the browser exposes it (precise mode is enabled at launch for perf
   * runs); optionally a post-GC reading through CDP so a trend is not dominated by GC timing.
   * Missing support is reported as unavailable, never as a number.
   */
  async heap(forceGc: boolean): Promise<HeapReading> {
    const pm = await guarded(this.page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null), this.freezeMs, 'heap');
    let post: number | null = null;
    if (forceGc && this.cdp) {
      try {
        await this.cdp.send('HeapProfiler.collectGarbage');
        const u = (await this.cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
        post = u.usedSize;
      } catch {
        post = null;
      }
    }
    return { performance_memory_bytes: pm, post_gc_bytes: post, source: pm !== null ? 'performance.memory' : post !== null ? 'cdp' : 'unavailable' };
  }

  async domNodes(): Promise<number> {
    return guarded(this.page.evaluate(() => document.getElementsByTagName('*').length), this.freezeMs, 'dom nodes');
  }

  get cdpAvailable(): { ok: boolean; reason: string } {
    return { ok: !!this.cdp, reason: this.cdpReason };
  }

  async stop(): Promise<void> {
    await this.page.evaluate(() => window.__qaPerf?.stop()).catch(() => undefined);
    await this.cdp?.detach().catch(() => undefined);
    this.cdp = null;
  }

  /** Reset = start a fresh window (drops accumulated frames/tasks/counters). */
  async reset(): Promise<void> {
    await this.beginWindow();
  }
}

export type { InteractionSpec };
