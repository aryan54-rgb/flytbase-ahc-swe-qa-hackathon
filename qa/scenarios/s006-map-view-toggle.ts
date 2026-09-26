import { readMapRuntime, type MapRuntime } from '../assertions/cesium.js';
import { pollUntil } from '../assertions/polling.js';
import { mapView } from './actions.js';
import { TID } from '../utils/selectors.js';
import { ALL_EVIDENCE, type Scenario, type Step, type StepContext } from './types.js';

/**
 * What the toggle does (frontend/src/components/CesiumMap.tsx, setView()):
 *   2D -> camera flies to pitch -90° (top-down) and tilt gestures are disabled
 *   3D -> camera flies to pitch -45° (oblique)  and tilt gestures are enabled
 * Map mode is observed on the live Cesium runtime (assertions/cesium.ts), not on the button's own
 * aria-pressed, so a button that "looks pressed" but did nothing is still caught. ARIA is checked
 * separately as the user/assistive-tech-visible part of the contract.
 *
 * Note: at startup the camera is top-down (the home flyTo uses Cesium's default orientation) while
 * 3D is selected, so the first 2D activation does not change pitch. The sequence 2D -> 3D -> 2D makes
 * every pitch assertion discriminating; tilt discriminates on every step.
 */

const PITCH = { '2d': -90, '3d': -45 } as const;
const PITCH_TOL = 1;
const T_CANVAS = `testid:${TID.mapCanvas}`;

type Mode = '2d' | '3d';

function modeReached(r: MapRuntime | undefined, mode: Mode): boolean {
  return !!r?.observable && r.tiltEnabled === (mode === '3d') && Math.abs((r.pitchDeg ?? 0) - PITCH[mode]) <= PITCH_TOL && r.moving === false;
}

/** Which aspects of the mode are wrong — a discrete, fingerprint-stable description. */
function modeGap(r: MapRuntime | undefined, mode: Mode): string {
  if (!r?.observable) return 'unobservable';
  return [r.tiltEnabled !== (mode === '3d') && 'tilt', Math.abs((r.pitchDeg ?? 0) - PITCH[mode]) > PITCH_TOL && 'pitch', r.moving && 'still-moving'].filter(Boolean).join('+') || 'none';
}

/**
 * ARIA part of the contract, independent of test ids:
 *  - the active-mode button is found through the healer (known selector, validated memory or HIGH local
 *    match — never an LLM guess) and must be aria-pressed=true;
 *  - every OTHER button in the ARIA group "Map view" must be aria-pressed=false.
 * If the active button cannot be identified from verified information, only "exactly one button in
 * the group is pressed" is asserted and the gap is reported as a warning (not a product defect).
 */
async function verifyAria(ctx: StepContext, mode: Mode) {
  const group = ctx.page.getByRole('group', { name: 'Map view' }).getByRole('button');
  const active = await ctx.healing.locate(ctx.check, mapView(mode));
  const read = async () => {
    const all = await group.evaluateAll((els) => els.map((e) => e.getAttribute('aria-pressed')));
    const activeIdx = active ? await group.evaluateAll((els, target) => (els as Element[]).indexOf(target as Element), await active.elementHandle()) : -1;
    return { all, activeIdx };
  };
  // ARIA can lag a React commit by a frame; bounded wait, then assert.
  const poll = await pollUntil(read, (r) => (r.activeIdx < 0 ? r.all.filter((p) => p === 'true').length === 1 : r.all.every((p, i) => p === (i === r.activeIdx ? 'true' : 'false'))), { timeoutMs: 2_000, intervalMs: 100 });
  const { all, activeIdx } = poll.last!;
  const target = `testid:${mode === '2d' ? TID.mapView2d : TID.mapView3d}`;
  const other = `testid:${mode === '2d' ? TID.mapView3d : TID.mapView2d}`;
  if (activeIdx < 0) {
    ctx.check.warn({ id: 'map.aria_target_identified', target, type: 'unresolved_target' }, false, { expected: `${mode.toUpperCase()} button identifiable from verified information`, actual: 'not identifiable yet (no verified mapping)' });
    ctx.check.equal({ id: 'map.aria_single_pressed', target: `testid:${TID.mapViewToggle}`, type: 'mismatch' }, all.filter((p) => p === 'true').length, 1);
    return;
  }
  ctx.check.equal({ id: 'map.aria_pressed_reflects_mode', target, type: 'mismatch' }, all[activeIdx], 'true');
  ctx.check.equal({ id: 'map.aria_pressed_reflects_mode', target: other, type: 'mismatch' }, all.every((p, i) => i === activeIdx || p === 'false') ? 'false' : 'true', 'false');
}

function activate(mode: Mode, label: string): Step {
  const target = `testid:${mode === '2d' ? TID.mapView2d : TID.mapView3d}`;
  return {
    name: label,
    action: async (ctx) => {
      // Semantic action: known selector first; healing only if it stops resolving. The postcondition
      // is the live map state either way — a healed click that does not change the map still fails.
      const before = await readMapRuntime(ctx.page);
      const r = await ctx.healing.perform(ctx.check, mapView(mode), {
        spec: { id: 'map.view_mode_applied', target, type: 'mismatch' },
        observe: () => readMapRuntime(ctx.page),
        satisfied: (v) => modeReached(v, mode),
        // Camera flight is 0.8 s; 6 s bounds render-loop scheduling in headless WebGL.
        timeoutMs: 6_000,
        describe: (v) => ({
          expected: `${mode.toUpperCase()}: tilt ${mode === '3d' ? 'enabled' : 'disabled'}, pitch ${PITCH[mode]}±${PITCH_TOL}°, camera at rest`,
          actual: v && { tiltEnabled: v.tiltEnabled, pitchDeg: v.pitchDeg, moving: v.moving },
          state: modeGap(v, mode),
        }),
      });
      if (r.stage === 'POSTCONDITION_FAILED' && r.observed && !r.observed.observable) ctx.check.precondition('map runtime observable', false, r.observed.reason);
      if (r.stage === 'NOT_FOUND') {
        // The healer refused (or found nothing): prove no action happened — the map must be unchanged.
        const now = await readMapRuntime(ctx.page);
        const unchanged = now.tiltEnabled === before.tiltEnabled && Math.abs((now.pitchDeg ?? 0) - (before.pitchDeg ?? 0)) <= PITCH_TOL;
        ctx.check.that({ id: 'healing.no_unintended_action', target: T_CANVAS, type: 'mismatch' }, unchanged && r.record.clicks_dispatched === 0, {
          expected: `map unchanged (tilt ${before.tiltEnabled}, pitch ${before.pitchDeg}°), 0 clicks dispatched`,
          actual: { clicks_dispatched: r.record.clicks_dispatched, tiltEnabled: now.tiltEnabled, pitchDeg: now.pitchDeg },
          state: 'changed',
        });
      }
      ctx.evidence.note(`map_${label}`, { stage: r.stage, runtime: r.observed, healing: r.record.outcome });
    },
    verify: async (ctx) => verifyAria(ctx, mode),
  };
}

export const s006: Scenario = {
  id: 'scenario-006',
  title: 'Map View Toggle Behaviour',
  user_goal: 'I can switch the map between 2D (top-down) and 3D (oblique) and the map actually changes.',
  starting_state: {
    description: 'Simulator reset; cockpit at / (1440×900) with the map initialised and the home camera flight finished.',
    path: '/',
    simulator: 'reset',
    waitForDevices: true,
  },
  expected_behavior: [
    'Initially 3D is selected (aria-pressed) and the map allows tilt.',
    'Activating 2D makes the map top-down (pitch -90°) with tilt disabled, and 2D becomes the pressed button.',
    'Activating 3D restores an oblique camera (pitch -45°) with tilt enabled, and 3D becomes the pressed button.',
    'A click that is dispatched but does not change the map is a defect, whatever the button looks like.',
  ],
  invariant: 'After activating mode m: runtime(tiltEnabled) == (m == 3D) && |camera.pitch - pitch(m)| <= 1° && aria-pressed(m) == true && aria-pressed(other) == false.',
  evidence_requirements: ALL_EVIDENCE,
  tags: ['level-1', 'interaction', 'map'],
  steps: [
    {
      name: 'Initial map state is 3D',
      action: async ({ page, check, evidence, memo }) => {
        const found = await pollUntil(() => readMapRuntime(page), (r) => r.observable, { timeoutMs: 15_000, intervalMs: 250 });
        check.precondition('Cesium map runtime observable (read-only, via React fiber)', !!found.last?.observable, found.last?.reason);
        // Wait for the startup "fly home" to finish: camera at rest on 3 consecutive reads.
        const settled = await pollUntil(() => readMapRuntime(page), (r) => r.moving === false, { timeoutMs: 10_000, intervalMs: 150, confirm: 3 });
        evidence.note('map_initial', { runtime: settled.last, settle_ms: settled.elapsedMs });
        check.warn({ id: 'map.camera_settled', target: T_CANVAS, type: 'timeout' }, settled.ok, { expected: 'camera at rest', actual: settled.last });
        memo.initial = settled.last;
      },
      verify: async (ctx) => {
        const r = ctx.memo.initial as MapRuntime;
        ctx.check.equal({ id: 'map.initial_tilt_enabled', target: T_CANVAS, type: 'mismatch' }, r.tiltEnabled, true);
        await verifyAria(ctx, '3d');
        // Ambiguous contract, so a warning: 3D is selected but the startup camera is top-down.
        ctx.check.warn({ id: 'map.initial_camera_oblique', target: T_CANVAS, type: 'mismatch' }, Math.abs((r.pitchDeg ?? 0) - PITCH['3d']) <= PITCH_TOL, {
          expected: `pitch ${PITCH['3d']}° while 3D is selected`,
          actual: `pitch ${r.pitchDeg}° (top-down) at startup`,
        });
      },
    },
    activate('2d', 'Activate 2D'),
    activate('3d', 'Activate 3D (restores oblique camera)'),
    activate('2d', 'Activate 2D again (pitch must change from oblique)'),
  ],
};
