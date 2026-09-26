import { Blocked } from '../assertions/checks.js';
import type { ApiClient } from '../utils/api.js';
import type { CleanupReport } from './types.js';

/**
 * Safety for a shared stack:
 *  - hard limits (drones, sim speed, scenario-started video streams, interaction spacing, time)
 *  - a ledger of every change a scenario makes, undone by `cleanup()` in a finally/always step
 *  - abort conditions: page freeze > 5 s, repeated backend outages, simulator disconnect, browser crash
 *
 * Aborts on infrastructure (outage, simulator disconnect) are BLOCKED, never a performance verdict.
 */

export interface SafetyLimits {
  maxDrones: number;
  maxSimSpeed: number;
  maxScenarioVideoStreams: number;
  minInteractionIntervalMs: number;
  scenarioTimeoutMs: number;
  freezeAbortMs: number;
  maxConsecutiveOutages: number;
}

/** A limit would be exceeded: the harness refuses (a harness decision, never a product result). */
export class SafetyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafetyLimitError';
  }
}

/** A severe condition that ends the scenario's workload phase immediately. */
export class SevereAbort extends Error {
  constructor(readonly kind: 'page_freeze' | 'backend_outage' | 'simulator_disconnect' | 'browser_crash' | 'timeout', message: string) {
    super(message);
    this.name = 'SevereAbort';
  }
}

export class Deadline {
  readonly startedAt = Date.now();
  constructor(readonly budgetMs: number) {}
  elapsed(): number {
    return Date.now() - this.startedAt;
  }
  remaining(): number {
    return this.budgetMs - this.elapsed();
  }
  /** Whether `ms` more work still fits (used to stop gracefully before the hard timeout). */
  fits(ms: number): boolean {
    return this.remaining() > ms;
  }
}

/**
 * Everything the scenario changed on the shared stack. Undo is idempotent; each action's outcome
 * is reported. A cleanup that cannot complete is a harness/environment problem (never a perf defect).
 */
/** Ledgers with changes not yet undone; the CLI cleans these up on Ctrl-C. */
export const activeLedgers = new Set<WorkloadLedger>();

export class WorkloadLedger {
  readonly addedDrones: string[] = [];
  readonly startedVideo = new Set<string>();
  readonly stoppedVideo = new Set<string>();
  speedChanged = false;
  flying = new Set<string>();
  readonly events: string[] = [];
  private lastInteraction = 0;

  constructor(readonly api: ApiClient, readonly limits: SafetyLimits, readonly initialDrones: string[]) {
    activeLedgers.add(this);
  }

  get droneCount(): number {
    return this.initialDrones.length + this.addedDrones.length;
  }

  async addDrones(count: number): Promise<string[]> {
    if (this.droneCount + count > this.limits.maxDrones) throw new SafetyLimitError(`refusing to exceed ${this.limits.maxDrones} drones (have ${this.droneCount}, asked +${count})`);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const r = await this.api.addDrone({});
      this.addedDrones.push(r.drone.id);
      ids.push(r.drone.id);
    }
    return ids;
  }

  async removeDrones(count: number): Promise<string[]> {
    const ids = this.addedDrones.splice(Math.max(0, this.addedDrones.length - count));
    for (const id of ids) {
      try {
        await this.api.removeDrone(id);
      } catch (e) {
        this.addedDrones.push(id); // still ours to clean up
        throw e;
      }
    }
    return ids;
  }

  /** Grow or shrink the fleet this scenario owns to `total` drones. */
  async setFleet(total: number): Promise<{ added: string[]; removed: string[] }> {
    if (total > this.limits.maxDrones) throw new SafetyLimitError(`requested fleet ${total} > limit ${this.limits.maxDrones}`);
    if (total < this.initialDrones.length) throw new SafetyLimitError(`cannot go below the pre-existing fleet (${this.initialDrones.length})`);
    const delta = total - this.droneCount;
    if (delta > 0) return { added: await this.addDrones(delta), removed: [] };
    if (delta < 0) return { added: [], removed: await this.removeDrones(-delta) };
    return { added: [], removed: [] };
  }

  async setSpeed(speed: number): Promise<void> {
    if (!(speed > 0) || speed > this.limits.maxSimSpeed) throw new SafetyLimitError(`simulation speed ${speed} outside (0, ${this.limits.maxSimSpeed}]`);
    this.speedChanged = true;
    await this.api.setSimulationSpeed(speed, 'start');
  }

  async startVideo(deviceId: string): Promise<void> {
    if (!this.startedVideo.has(deviceId) && !this.stoppedVideo.has(deviceId) && this.startedVideo.size >= this.limits.maxScenarioVideoStreams) throw new SafetyLimitError(`refusing to start more than ${this.limits.maxScenarioVideoStreams} video streams`);
    await this.api.videoControl('start', deviceId);
    if (this.stoppedVideo.has(deviceId)) this.stoppedVideo.delete(deviceId);
    else this.startedVideo.add(deviceId);
  }

  async stopVideo(deviceId: string): Promise<void> {
    await this.api.videoControl('stop', deviceId);
    if (this.startedVideo.has(deviceId)) this.startedVideo.delete(deviceId);
    else this.stoppedVideo.add(deviceId);
  }

  async takeoff(deviceId: string): Promise<void> {
    const r = await this.api.command(deviceId, 'takeoff');
    if (!r.ok || !r.body?.ok) throw new Error(`takeoff ${deviceId} rejected: ${r.body?.error ?? r.status}`);
    this.flying.add(deviceId);
  }

  /** Enforce the minimum spacing between operator interactions. */
  async pace(intervalMs: number): Promise<number> {
    const spacing = Math.max(intervalMs, this.limits.minInteractionIntervalMs);
    const wait = this.lastInteraction + spacing - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastInteraction = Date.now();
    return Math.max(0, wait);
  }

  /**
   * Undo everything, in order: stop started video / restore stopped video, remove added drones,
   * speed 1x, reset + start the simulator, then verify the stack is back at its starting fleet.
   */
  async cleanup(): Promise<CleanupReport> {
    const actions: CleanupReport['actions'] = [];
    const run = async (action: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        actions.push({ action, ok: true });
        return true;
      } catch (e) {
        actions.push({ action, ok: false, error: (e as Error).message });
        return false;
      }
    };
    for (const id of [...this.startedVideo]) if (await run(`video stop ${id}`, () => this.api.videoControl('stop', id))) this.startedVideo.delete(id);
    for (const id of [...this.stoppedVideo]) if (await run(`video restore ${id}`, () => this.api.videoControl('start', id))) this.stoppedVideo.delete(id);
    for (const id of [...this.addedDrones].reverse()) if (await run(`remove ${id}`, () => this.api.removeDrone(id))) this.addedDrones.splice(this.addedDrones.indexOf(id), 1);
    await run('speed 1x', () => this.api.setSimulationSpeed(1, 'start'));
    await run('sim reset', () => this.api.sim('reset'));
    await run('sim start (speed 1x)', () => this.api.setSimulationSpeed(1, 'start'));
    this.flying.clear();

    let verified: boolean | null = null;
    let final: CleanupReport['final_state'];
    try {
      const [drones, state] = await Promise.all([this.api.drones(), this.api.state()]);
      final = { drones: drones.map((d) => d.id), speed: state.speed, running: state.running };
      const same = drones.length === this.initialDrones.length && drones.every((d) => this.initialDrones.includes(d.id));
      verified = same && state.speed === 1 && state.running && Object.values(state.drones).every((d) => d.status === 'standby');
      if (!verified) actions.push({ action: 'verify baseline', ok: false, error: `fleet ${final.drones.join(',')} speed ${state.speed} running ${state.running}` });
      else actions.push({ action: 'verify baseline', ok: true });
    } catch (e) {
      actions.push({ action: 'verify baseline', ok: false, error: (e as Error).message });
    }
    const leftovers = [...this.addedDrones.map((d) => `drone ${d}`), ...[...this.startedVideo].map((d) => `video ${d} started`), ...[...this.stoppedVideo].map((d) => `video ${d} stopped`)];
    if (!leftovers.length) activeLedgers.delete(this);
    return { ok: actions.every((a) => a.ok), actions, leftovers, verified_baseline: verified, final_state: final };
  }
}

/** Tracks infrastructure health during a run and decides when to abort. */
export class SafetyMonitor {
  private consecutiveOutages = 0;
  readonly events: string[] = [];
  crashed = false;

  constructor(readonly limits: SafetyLimits) {}

  /** Feed each API probe result; repeated outages abort as BLOCKED (not a product result). */
  noteApi(failure: 'none' | 'outage' | 'http', detail: string): void {
    if (failure === 'outage') {
      this.consecutiveOutages++;
      this.events.push(`outage: ${detail}`);
      if (this.consecutiveOutages >= this.limits.maxConsecutiveOutages) throw new SevereAbort('backend_outage', `backend unavailable ${this.consecutiveOutages}x in a row (last: ${detail})`);
    } else this.consecutiveOutages = 0;
  }

  noteSimulator(health: { simulator?: string } | undefined): void {
    if (health && health.simulator !== 'connected') throw new SevereAbort('simulator_disconnect', `simulator ${health.simulator ?? 'unknown'} (GET /api/health)`);
  }

  noteFrameGap(ms: number | null): void {
    if (ms !== null && ms > this.limits.freezeAbortMs) throw new SevereAbort('page_freeze', `page froze for ${Math.round(ms)} ms (> ${this.limits.freezeAbortMs} ms)`);
  }

  checkCrash(): void {
    if (this.crashed) throw new SevereAbort('browser_crash', 'renderer crashed');
  }
}

/** Infrastructure aborts become BLOCKED; product-side severe failures stay product observations. */
export function isInfrastructureAbort(e: unknown): boolean {
  return e instanceof Blocked || (e instanceof SevereAbort && (e.kind === 'backend_outage' || e.kind === 'simulator_disconnect'));
}
