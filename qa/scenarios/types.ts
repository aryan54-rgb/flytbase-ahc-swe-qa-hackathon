import type { BrowserContext, Page } from 'playwright';
import type { Checks } from '../assertions/checks.js';
import type { ApiClient } from '../utils/api.js';
import type { Ui } from '../utils/selectors.js';
import type { EvidenceRecorder } from '../runner/evidence.js';
import type { QaConfig } from '../runner/config.js';
import type { HealingSession } from '../healing/session.js';

export type EvidenceKind = 'recording' | 'screenshot_on_failure' | 'dom_on_failure' | 'console' | 'ground_truth' | 'result';

export const ALL_EVIDENCE: EvidenceKind[] = ['recording', 'screenshot_on_failure', 'dom_on_failure', 'console', 'ground_truth', 'result'];

export interface StartingState {
  description: string;
  /** Path opened before the first step. `null` means the scenario navigates itself. */
  path: string | null;
  viewport?: { width: number; height: number };
  /** `reset` = POST /api/control/sim reset + start (reset alone stops the world). */
  simulator: 'reset' | 'as-is';
  /** Wait until the device list has rendered at least one row before step 1. */
  waitForDevices: boolean;
}

export interface ScenarioContext {
  page: Page;
  context: BrowserContext;
  api: ApiClient;
  ui: Ui;
  config: QaConfig;
  evidence: EvidenceRecorder;
  /** Values steps hand to later steps (e.g. the id of the row that was selected before a click). */
  memo: Record<string, unknown>;
  /** Self-healing selector execution (semantic actions). Optional to use; scenarios may keep raw locators. */
  healing: HealingSession;
}

export interface StepContext extends ScenarioContext {
  check: Checks;
}

/**
 * A step is split in two on purpose:
 *   action — do the thing, and report whether *the action itself* went through (click landed, API acked)
 *   verify — check that the *resulting state* is correct, against ground truth
 * A click that "succeeds" but leaves the app in the wrong state fails in verify, not action.
 */
export interface Step {
  name: string;
  action?: (ctx: StepContext) => Promise<void>;
  verify?: (ctx: StepContext) => Promise<void>;
  /** Runs even if an earlier step failed (cleanup / restoring simulator state). */
  always?: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  user_goal: string;
  starting_state: StartingState;
  steps: Step[];
  expected_behavior: string[];
  invariant: string;
  evidence_requirements: EvidenceKind[];
  tags?: string[];
  /** Steps do not depend on each other: keep running after a failure so every finding is reported. */
  independent_steps?: boolean;
  /** Per-scenario tolerated page errors (regex on message). Keep empty unless justified. */
  allowed_page_errors?: RegExp[];
}
