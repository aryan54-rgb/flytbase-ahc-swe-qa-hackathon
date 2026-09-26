import { readDeviceRows } from '../assertions/cockpit.js';
import { pollUntil } from '../assertions/polling.js';
import type { DeviceInfo, SimSnapshot } from '../utils/api.js';
import { ALL_EVIDENCE, type Scenario } from './types.js';

export const s001: Scenario = {
  id: 'scenario-001',
  title: 'Device List Integrity',
  user_goal: 'As an operator I can see every simulated drone (with its dock) in the device list.',
  starting_state: {
    description: 'Simulator reset and running with its stock fleet; cockpit freshly loaded at /.',
    path: '/',
    simulator: 'reset',
    waitForDevices: true,
  },
  expected_behavior: [
    'One device row per drone returned by GET /api/devices (docks are folded into their drone row, not listed separately).',
    'Each row visibly shows its API drone name and its dock name.',
    'No missing, extra, duplicated or invisible rows.',
    "Each row's visible flight status matches the simulator state.",
  ],
  invariant: 'set(UI device-row ids) == set(API drone ids) and every row shows its API name, dock name and simulator flight status.',
  evidence_requirements: ALL_EVIDENCE,
  tags: ['level-1', 'ground-truth', 'device-list'],
  steps: [
    {
      name: 'Fetch ground-truth inventory from GET /api/devices',
      action: async ({ api, memo, check, evidence }) => {
        const devices = await api.devices();
        memo.devices = devices;
        memo.drones = devices.filter((d) => d.type === 'drone');
        evidence.note('api_devices', devices);
        check.precondition('API returns at least one drone', (memo.drones as DeviceInfo[]).length > 0, devices.length);
      },
      verify: async ({ memo, config, check }) => {
        const drones = memo.drones as DeviceInfo[];
        check.warn({ id: 'env.stock_fleet_size', target: 'api:/api/devices', type: 'mismatch' }, drones.length === config.expectedDrones, {
          expected: config.expectedDrones,
          actual: drones.length,
          message: `baseline expects ${config.expectedDrones} drones, API reports ${drones.length} (drones may have been added/removed)`,
        });
      },
    },
    {
      name: 'Rendered device rows correspond 1:1 to API drones',
      verify: async ({ page, memo, check, evidence }) => {
        const devices = memo.devices as DeviceInfo[];
        const drones = memo.drones as DeviceInfo[];
        // Devices arrive over REST and socket; give the list a bounded window to converge on the API ids.
        const apiIds = drones.map((d) => d.id).sort();
        const poll = await pollUntil(() => readDeviceRows(page), (rows) => JSON.stringify(rows.map((r) => r.id).sort()) === JSON.stringify(apiIds), { timeoutMs: 10_000, intervalMs: 250 });
        const rows = poll.last ?? [];
        evidence.note('ui_device_rows', { converged: poll.ok, elapsedMs: poll.elapsedMs, rows });

        const uiIds = rows.map((r) => r.id ?? '?');
        check.equal({ id: 'device_list.row_count', target: 'region:device-list', type: 'mismatch' }, rows.length, drones.length, { state: rows.length < drones.length ? 'fewer' : rows.length > drones.length ? 'more' : '' });
        for (const id of apiIds.filter((id) => !uiIds.includes(id))) {
          check.that({ id: 'device_list.row_present', target: `device:${id}`, type: 'missing' }, false, { expected: 'row rendered', actual: 'no row' });
        }
        for (const id of uiIds.filter((id) => !apiIds.includes(id))) {
          check.that({ id: 'device_list.row_backed_by_api', target: `device:${id}`, type: 'unexpected' }, false, { expected: 'no row', actual: 'row rendered' });
        }
        for (const id of [...new Set(uiIds.filter((id, i) => uiIds.indexOf(id) !== i))]) {
          check.that({ id: 'device_list.row_unique', target: `device:${id}`, type: 'duplicate' }, false, { expected: 1, actual: uiIds.filter((x) => x === id).length });
        }

        for (const d of drones) {
          const row = rows.find((r) => r.id === d.id);
          if (!row) continue;
          check.that({ id: 'device_list.row_visible', target: `device:${d.id}`, type: 'hidden' }, row.visible, { expected: 'visible', actual: 'hidden' });
          check.that({ id: 'device_list.row_shows_name', target: `device:${d.id}`, type: 'mismatch' }, row.texts.includes(d.name), { expected: d.name, actual: row.texts, state: `expected:${d.name}` });
          const dock = d.dockId ? devices.find((x) => x.id === d.dockId) : undefined;
          if (dock) check.that({ id: 'device_list.row_shows_dock', target: `device:${d.id}`, type: 'mismatch' }, row.texts.includes(dock.name), { expected: dock.name, actual: row.texts, state: `expected:${dock.name}` });
        }
      },
    },
    {
      name: "Each row's visible flight status matches simulator state",
      verify: async ({ page, api, memo, check, evidence }) => {
        const drones = memo.drones as DeviceInfo[];
        let state: SimSnapshot | undefined;
        const poll = await pollUntil(
          async () => {
            const rows = await readDeviceRows(page);
            state = await api.state();
            return { rows, state };
          },
          ({ rows, state: s }) => drones.every((d) => rows.find((r) => r.id === d.id)?.flightStatus === s.drones[d.id]?.status),
          { timeoutMs: 10_000, intervalMs: 500 },
        );
        evidence.note('status_poll', { ok: poll.ok, elapsedMs: poll.elapsedMs, last: poll.last });
        const rows = poll.last?.rows ?? [];
        for (const d of drones) {
          const row = rows.find((r) => r.id === d.id);
          if (!row) continue; // already reported as missing
          check.equal({ id: 'device_list.row_status_matches_sim', target: `device:${d.id}`, type: 'mismatch' }, row.flightStatus || null, state?.drones[d.id]?.status ?? null);
        }
      },
    },
  ],
};
