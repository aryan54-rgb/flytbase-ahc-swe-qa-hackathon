import type { Locator } from 'playwright';
import type { CheckSpec, Checks } from '../assertions/checks.js';
import { pollUntil } from '../assertions/polling.js';

/**
 * A user interaction has three distinct stages, and each is reported separately:
 *
 *   ACTIONABLE              the element *could* receive the interaction (Playwright actionability:
 *                           attached, visible, stable, enabled, receives pointer events). Nothing happened.
 *   ACTION_EXECUTED         the interaction was actually dispatched to the element.
 *   POSTCONDITION_SATISFIED the application reached the state the interaction is supposed to produce.
 *
 * Only POSTCONDITION_SATISFIED means "the user action succeeded". A dead click handler reaches
 * ACTION_EXECUTED and then fails the postcondition. The result types are distinct so a caller cannot
 * use an actionability probe where an action outcome is expected, or an execution where a postcondition is.
 *
 * Actionability failures are *product observations* (the user could not act), recorded as checks
 * and never thrown; anything that still throws out of a step is therefore a harness error.
 */

export type ActionStage = 'NOT_FOUND' | 'NOT_ACTIONABLE' | 'ACTIONABLE' | 'ACTION_EXECUTED' | 'POSTCONDITION_SATISFIED' | 'POSTCONDITION_FAILED';

/** Result of an actionability probe. Deliberately has no `ok`/`executed` field. */
export interface Actionability {
  readonly kind: 'actionability';
  readonly stage: 'ACTIONABLE' | 'NOT_ACTIONABLE' | 'NOT_FOUND';
  readonly reason: string;
  readonly detail: string;
}

/** Result of performing an interaction (no claim about its effect). */
export interface ActionOutcome {
  readonly kind: 'action';
  readonly stage: 'ACTION_EXECUTED' | 'NOT_ACTIONABLE' | 'NOT_FOUND';
  readonly reason: string;
}

/** Result of performing an interaction AND verifying its effect. */
export interface InteractionResult<T> {
  readonly kind: 'interaction';
  readonly stage: 'POSTCONDITION_SATISFIED' | 'POSTCONDITION_FAILED' | 'NOT_ACTIONABLE' | 'NOT_FOUND';
  readonly action: ActionOutcome;
  readonly observed: T | undefined;
  readonly elapsedMs: number;
}

/**
 * Probe only: runs a real click's actionability checks without clicking (Playwright `trial`).
 * Answers "could a user click this right now?" — never "did the click work?".
 */
export async function probeActionable(locator: Locator, timeoutMs = 1_500): Promise<Actionability> {
  if ((await locator.count()) === 0) return { kind: 'actionability', stage: 'NOT_FOUND', reason: 'absent', detail: '' };
  try {
    await locator.first().click({ trial: true, timeout: timeoutMs });
    return { kind: 'actionability', stage: 'ACTIONABLE', reason: 'ok', detail: '' };
  } catch (e) {
    const msg = (e as Error).message;
    // eslint-disable-next-line no-control-regex
    const lines = msg.replace(/\u001b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter((l) => /intercepts|not visible|not stable|disabled|detached|outside/.test(l));
    return { kind: 'actionability', stage: 'NOT_ACTIONABLE', reason: actionabilityReason(msg), detail: [...new Set(lines)].slice(0, 2).join(' | ') };
  }
}

/**
 * Perform a click and record whether it was EXECUTED (check `interaction.action_executed`).
 * Says nothing about the effect: verify the postcondition separately, or use `interact()`.
 */
export async function click(check: Checks, target: string, locator: Locator, opts: { timeoutMs?: number } = {}): Promise<ActionOutcome> {
  const spec = { id: 'interaction.action_executed', target };
  if ((await locator.count()) === 0) {
    check.that({ ...spec, type: 'missing' }, false, { expected: 'element present', actual: 'not in DOM', state: 'absent' });
    return { kind: 'action', stage: 'NOT_FOUND', reason: 'absent' };
  }
  try {
    await locator.first().click({ timeout: opts.timeoutMs ?? 5_000 });
    check.that({ ...spec, type: 'not_actionable' }, true);
    return { kind: 'action', stage: 'ACTION_EXECUTED', reason: 'ok' };
  } catch (e) {
    const reason = actionabilityReason((e as Error).message);
    check.that({ ...spec, type: 'not_actionable' }, false, {
      expected: 'click performed',
      actual: reason,
      state: reason,
      message: `user could not click ${target}: ${reason}`,
      observed: { playwright: (e as Error).message.split('\n').slice(0, 6).join(' | ') },
    });
    return { kind: 'action', stage: 'NOT_ACTIONABLE', reason };
  }
}

/**
 * Full interaction: click, then poll `observe` until `satisfied` holds (bounded). Records the
 * postcondition as its own check, so result.json distinguishes ACTION_EXECUTED from POSTCONDITION_SATISFIED.
 */
export async function interact<T>(
  check: Checks,
  target: string,
  locator: Locator,
  post: { spec: CheckSpec; observe: () => Promise<T>; satisfied: (v: T) => boolean; describe?: (v: T | undefined) => { expected?: unknown; actual?: unknown; state?: string }; timeoutMs?: number },
): Promise<InteractionResult<T>> {
  const action = await click(check, target, locator);
  if (action.stage !== 'ACTION_EXECUTED') return { kind: 'interaction', stage: action.stage, action, observed: undefined, elapsedMs: 0 };
  const poll = await pollUntil(post.observe, post.satisfied, { timeoutMs: post.timeoutMs ?? 5_000, intervalMs: 150 });
  const d = post.describe?.(poll.last) ?? {};
  check.that(post.spec, poll.ok, { expected: d.expected, actual: d.actual ?? poll.last, state: d.state, observed: { stage: poll.ok ? 'POSTCONDITION_SATISFIED' : 'POSTCONDITION_FAILED', waited_ms: poll.elapsedMs, samples: poll.samples.length } });
  return { kind: 'interaction', stage: poll.ok ? 'POSTCONDITION_SATISFIED' : 'POSTCONDITION_FAILED', action, observed: poll.last, elapsedMs: poll.elapsedMs };
}

/** Reduce a Playwright error to a stable category (no selectors, timings or retry counts). */
function actionabilityReason(msg: string): string {
  if (/intercepts pointer events/.test(msg)) return 'intercepted';
  if (/not visible/.test(msg)) return 'not-visible';
  if (/not enabled|disabled/.test(msg)) return 'disabled';
  if (/not stable/.test(msg)) return 'not-stable';
  if (/detached/.test(msg)) return 'detached';
  if (/outside of the viewport/.test(msg)) return 'outside-viewport';
  if (/Timeout/.test(msg)) return 'timeout';
  return 'failed';
}
