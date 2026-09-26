import type { SemanticAction } from '../healing/types.js';
import type { DeviceInfo } from '../utils/api.js';
import { DEVICE_ROW_PREFIX, TID } from '../utils/selectors.js';

/**
 * Semantic action catalog: user intents the scenarios perform, with the known selector plus the
 * semantics the healer may use when that selector stops resolving. Targets are the same semantic
 * target ids the checks already used, so finding fingerprints do not change.
 *
 * Constraint design:
 *  - device rows: identity is the device name (required_text, HARD) — another drone is never "the same row".
 *  - map buttons: the opposite mode is forbidden (HARD); the old label "2D"/"3D" is only SOFT evidence,
 *    so a relabelled button can still be recovered (by context, memory, or the LLM tier).
 */

export function selectDevice(d: DeviceInfo): SemanticAction {
  return {
    step_id: `select-${d.id}`,
    intent: `Select ${d.name} in the device list`,
    target: `device:${d.id}`,
    selector: `[data-testid="${DEVICE_ROW_PREFIX}${d.id}"]`,
    roles: ['listitem', 'button', 'option', 'row'],
    required_text: [d.name],
    semantic_hints: [d.name],
    context: 'Devices',
    expected_postcondition: `${d.name} becomes the only selected device and telemetry/video follow it`,
  };
}

export function mapView(mode: '2d' | '3d'): SemanticAction {
  const label = mode.toUpperCase();
  return {
    step_id: `map-view-${mode}`,
    intent: `Switch the map to the ${label} view`,
    target: `testid:${mode === '2d' ? TID.mapView2d : TID.mapView3d}`,
    roles: ['button'],
    accessible_name: label,
    semantic_hints: [label],
    context: 'Map view',
    forbidden_text: [mode === '2d' ? '3D' : '2D'],
    expected_postcondition: mode === '2d' ? 'map is top-down (pitch -90°) with tilt disabled' : 'map is oblique (pitch -45°) with tilt enabled',
  };
}
