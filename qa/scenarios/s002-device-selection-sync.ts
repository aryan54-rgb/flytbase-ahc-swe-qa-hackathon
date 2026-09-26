import { namedDevice, readDeviceRows, readSelection, type UiSelection } from '../assertions/cockpit.js';
import type { Checks } from '../assertions/checks.js';
import { pollUntil } from '../assertions/polling.js';
import { selectDevice } from './actions.js';
import type { DeviceInfo, SimSnapshot } from '../utils/api.js';
import { ALL_EVIDENCE, type Scenario, type StepContext } from './types.js';

/**
 * The heading readout is a per-device fingerprint: in standby each drone's yaw equals its configured
 * heading, and the stock fleet uses a different heading per drone. So "telemetry shows the selected
 * device" is checked on data, not only on the header label.
 */

function coherentFor(sel: UiSelection, drone: DeviceInfo, names: string[], state: SimSnapshot): boolean {
  const gt = state.drones[drone.id];
  return (
    sel.selectedRowIds.length === 1 &&
    sel.selectedRowIds[0] === drone.id &&
    namedDevice(sel.telemetryHeader, names) === drone.name &&
    namedDevice(sel.videoHeader, names) === drone.name &&
    sel.flightStatus === gt?.status &&
    sel.headingDeg !== null &&
    Math.abs(sel.headingDeg - Math.round(gt.heading)) <= 1
  );
}

async function verifyFocus(ctx: StepContext, drone: DeviceInfo, previous: string | null, label: string) {
  const { page, api, check, evidence, memo } = ctx;
  const names = (memo.drones as DeviceInfo[]).map((d) => d.name);
  let state = await api.state();
  // Selection is local React state: it should settle within a couple of frames; 5 s is a generous bound.
  const poll = await pollUntil(
    async () => {
      state = await api.state();
      return readSelection(page);
    },
    (sel) => coherentFor(sel, drone, names, state),
    { timeoutMs: 5_000, intervalMs: 200 },
  );
  const sel = poll.last!;
  evidence.note(`${label}_selection`, { target: drone.id, previous, converged: poll.ok, elapsedMs: poll.elapsedMs, ui: sel, ground_truth: state.drones[drone.id] });
  assertFocus(check, sel, drone, previous, names, state);
  await assertSelectionPerceivable(ctx, drone);
}

function assertFocus(check: Checks, sel: UiSelection, drone: DeviceInfo, previous: string | null, names: string[], state: SimSnapshot) {
  const gt = state.drones[drone.id];
  const t = `device:${drone.id}`;
  check.equal({ id: 'selection.single_selected_row', target: 'region:device-list', type: 'mismatch' }, sel.selectedRowIds.length, 1, { state: sel.selectedRowIds.length === 0 ? 'none-selected' : sel.selectedRowIds.length > 1 ? 'many-selected' : '' });
  check.that({ id: 'selection.clicked_row_selected', target: t, type: 'mismatch' }, sel.selectedRowIds.includes(drone.id), { expected: drone.id, actual: sel.selectedRowIds, state: 'not-selected' });
  if (previous && previous !== drone.id) {
    check.that({ id: 'selection.previous_row_deselected', target: `device:${previous}`, type: 'mismatch' }, !sel.selectedRowIds.includes(previous), { expected: `not ${previous}`, actual: sel.selectedRowIds, state: 'still-selected' });
  }
  check.equal({ id: 'selection.telemetry_header_follows', target: t, type: 'mismatch' }, namedDevice(sel.telemetryHeader, names), drone.name);
  check.equal({ id: 'selection.video_header_follows', target: t, type: 'mismatch' }, namedDevice(sel.videoHeader, names), drone.name);
  check.equal({ id: 'selection.telemetry_status_is_selected_drone', target: t, type: 'mismatch' }, sel.flightStatus, gt?.status);
  check.near({ id: 'selection.telemetry_data_is_selected_drone', target: t, type: 'mismatch' }, sel.headingDeg, Math.round(gt?.heading ?? NaN), 1, {
    message: sel.headingDeg === null ? 'no heading shown' : `heading ${sel.headingDeg}° shown, ${drone.id} heading is ${Math.round(gt?.heading ?? NaN)}°`,
  });
}

/** The selection must be visible to the user, not just a class: selected row style differs from every other row. */
async function assertSelectionPerceivable(ctx: StepContext, drone: DeviceInfo) {
  const rows = await readDeviceRows(ctx.page);
  const sel = rows.find((r) => r.id === drone.id && r.selected);
  if (!sel) return; // already reported by selection.clicked_row_selected
  const lookalikes = rows.filter((r) => r !== sel && r.style === sel.style).map((r) => r.id);
  ctx.check.that({ id: 'selection.visually_distinct', target: `device:${drone.id}`, type: 'not_distinct' }, lookalikes.length === 0, {
    expected: 'selected row styled differently from unselected rows',
    actual: `same computed style as ${lookalikes.join(', ')}`,
    state: 'same-style',
  });
}

export const s002: Scenario = {
  id: 'scenario-002',
  title: 'Device Selection Synchronization',
  user_goal: 'When I click another drone, the whole cockpit (list, telemetry, video) switches focus to it.',
  starting_state: {
    description: 'Simulator reset (all drones standby at their docks); cockpit loaded at / with the default first drone selected.',
    path: '/',
    simulator: 'reset',
    waitForDevices: true,
  },
  expected_behavior: [
    'The clicked row becomes the only selected row, visibly distinct; the previously selected row is deselected.',
    'The telemetry header and the video header both name the clicked drone.',
    "Telemetry values are the clicked drone's (heading matches its ground-truth heading).",
    'Selection works repeatedly (switching back restores the original focus).',
  ],
  invariant: 'selectedRow.id == telemetryHeader.device == videoHeader.device == device whose ground-truth heading/status the telemetry shows.',
  evidence_requirements: ALL_EVIDENCE,
  tags: ['level-1', 'interaction', 'ground-truth'],
  steps: [
    {
      name: 'Initial focus is coherent',
      action: async ({ api, memo, check }) => {
        const drones = await api.drones();
        memo.drones = drones;
        check.precondition('at least two drones to switch between', drones.length >= 2, drones.length);
      },
      verify: async (ctx) => {
        const drones = ctx.memo.drones as DeviceInfo[];
        const sel = await readSelection(ctx.page);
        const initial = drones.find((d) => d.id === sel.selectedRowIds[0]) ?? drones[0];
        ctx.memo.initial = initial;
        await verifyFocus(ctx, initial, null, 'initial');
      },
    },
    {
      name: 'Click a different drone row',
      action: async ({ memo, check, healing }) => {
        const drones = memo.drones as DeviceInfo[];
        const initial = memo.initial as DeviceInfo;
        const target = [...drones].reverse().find((d) => d.id !== initial.id)!;
        memo.target = target;
        await healing.perform(check, selectDevice(target));
      },
      verify: async (ctx) => verifyFocus(ctx, ctx.memo.target as DeviceInfo, (ctx.memo.initial as DeviceInfo).id, 'after_click'),
    },
    {
      name: 'Click the original drone again (selection is repeatable)',
      action: async ({ memo, check, healing }) => {
        const initial = memo.initial as DeviceInfo;
        await healing.perform(check, selectDevice(initial));
      },
      verify: async (ctx) => verifyFocus(ctx, ctx.memo.initial as DeviceInfo, (ctx.memo.target as DeviceInfo).id, 'after_switch_back'),
    },
  ],
};
