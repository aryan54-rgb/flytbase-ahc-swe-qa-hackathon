import { s001 } from './s001-device-list-integrity.js';
import { s002 } from './s002-device-selection-sync.js';
import { s003 } from './s003-responsive-375.js';
import { s004 } from './s004-cross-tier-flight-state.js';
import { s005 } from './s005-route-robustness.js';
import { s006 } from './s006-map-view-toggle.js';
import type { Scenario } from './types.js';

export const scenarios: Scenario[] = [s001, s002, s003, s004, s005, s006];
