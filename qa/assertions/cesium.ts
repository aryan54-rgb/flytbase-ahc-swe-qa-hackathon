import type { Page } from 'playwright';
import { EL } from '../utils/selectors.js';

/**
 * Read-only observation of the live Cesium map, without product changes.
 *
 * Findings from inspecting frontend/src/components/CesiumMap.tsx:
 *  - the Viewer lives in a React `useRef`; the 2D/3D mode lives in component `useState`;
 *  - nothing is exposed on window (no window.Cesium, no window.viewer), the Zustand store has no map mode,
 *    and there is no backend interface for map state;
 *  - the toggle's real effect is: camera flies to pitch -90° (2D) / -45° (3D), and
 *    scene.screenSpaceCameraController.enableTilt is set false (2D) / true (3D).
 *
 * Method: from the map container element (data-testid=map-canvas), follow React's own fiber pointer
 * (`__reactFiber$*`, present in dev and prod React 18) up to the owning component and find the hook
 * whose ref holds an object shaped like a Cesium Viewer (camera + scene + isDestroyed()). Found by
 * shape, not by hook index. After that, ONLY public Cesium API is read: camera.pitch/heading/
 * positionCartographic, scene.mode, screenSpaceCameraController.enableTilt. Nothing is written.
 * If the handle cannot be found, callers must treat map behaviour as unobservable (BLOCKED), never guess.
 */

export interface MapRuntime {
  observable: boolean;
  reason?: string;
  pitchDeg?: number;
  headingDeg?: number;
  heightM?: number;
  tiltEnabled?: boolean;
  sceneMode?: number;
  /** Camera flight in progress (position changing between two reads 60 ms apart). */
  moving?: boolean;
}

export async function readMapRuntime(page: Page): Promise<MapRuntime> {
  return page.evaluate(async (canvasCss) => {
    const host = document.querySelector(canvasCss) as (Element & Record<string, unknown>) | null;
    if (!host) return { observable: false, reason: 'map container not in DOM' };
    const key = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return { observable: false, reason: 'no React fiber on map container' };
    type Viewer = { camera: { pitch: number; heading: number; positionCartographic: { height: number }; positionWC: { x: number; y: number; z: number } }; scene: { mode: number; screenSpaceCameraController: { enableTilt: boolean } }; isDestroyed: () => boolean };
    type Hook = { memoizedState?: { current?: unknown }; next?: Hook | null };
    let viewer: Viewer | null = null;
    let fiber = host[key] as { memoizedState?: Hook; return?: unknown } | undefined;
    for (let depth = 0; fiber && !viewer && depth < 25; depth++) {
      for (let h = fiber.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next ?? undefined) {
        const v = h.memoizedState?.current as Partial<Viewer> | undefined;
        if (v && typeof v === 'object' && v.camera && v.scene && typeof v.isDestroyed === 'function') {
          viewer = v as Viewer;
          break;
        }
      }
      fiber = fiber.return as typeof fiber;
    }
    if (!viewer) return { observable: false, reason: 'no Cesium viewer reachable from the map component' };
    if (viewer.isDestroyed()) return { observable: false, reason: 'viewer destroyed' };
    const p0 = { ...viewer.camera.positionWC };
    await new Promise((r) => setTimeout(r, 60));
    const p1 = viewer.camera.positionWC;
    const moved = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    const deg = (r: number) => Math.round(((r * 180) / Math.PI) * 100) / 100;
    return {
      observable: true,
      pitchDeg: deg(viewer.camera.pitch),
      headingDeg: deg(viewer.camera.heading),
      heightM: Math.round(viewer.camera.positionCartographic.height),
      tiltEnabled: viewer.scene.screenSpaceCameraController.enableTilt,
      sceneMode: viewer.scene.mode,
      moving: moved > 0.5,
    };
  }, EL.mapCanvas.css);
}

/** ARIA state of the two view buttons (what assistive tech and the pressed styling expose). */
export async function readToggleAria(page: Page): Promise<{ '2d': string | null; '3d': string | null }> {
  return page.evaluate(({ a, b }) => ({ '2d': document.querySelector(a)?.getAttribute('aria-pressed') ?? null, '3d': document.querySelector(b)?.getAttribute('aria-pressed') ?? null }), { a: EL.mapView2d.css, b: EL.mapView3d.css });
}
