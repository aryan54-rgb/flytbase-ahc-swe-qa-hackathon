import { s001 } from './s001-device-list-integrity.js';
import { s002 } from './s002-device-selection-sync.js';
import { s003 } from './s003-responsive-375.js';
import { s004 } from './s004-cross-tier-flight-state.js';
import { s005 } from './s005-route-robustness.js';
import { s006 } from './s006-map-view-toggle.js';
import { p001 } from './p001-drone-workload.js';
import { p002 } from './p002-telemetry-stress.js';
import { p003 } from './p003-stability-soak.js';
import type { Scenario } from './types.js';

/** Level-1 functional suite (what `npm run qa` runs). */
export const scenarios: Scenario[] = [s001, s002, s003, s004, s005, s006];

/** Level-2 performance scenarios, run only with `--perf`, in this order (P001 -> P002 -> P003). */
export const perfScenarios: Scenario[] = [p001, p002, p003];
