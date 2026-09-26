import { Blocked } from '../assertions/checks.js';

/**
 * Thin client for the backend control API (ground truth). Mirrors the shapes in protocol/src/index.ts
 * without importing it, so the QA module stays independent of product code.
 */

export type FlightStatus = 'standby' | 'taking_off' | 'in_flight' | 'landing';

export interface DeviceInfo {
  id: string;
  type: 'drone' | 'dock';
  name: string;
  dockId?: string;
  droneId?: string;
}

export interface DroneSnapshot {
  id: string;
  status: FlightStatus;
  latitude: number;
  longitude: number;
  height: number;
  heading: number;
  battery: number;
}

export interface SimSnapshot {
  running: boolean;
  speed: number;
  tick: number;
  drones: Record<string, DroneSnapshot>;
}

export interface Health {
  status: string;
  simulator: 'connected' | 'disconnected';
  video: 'up' | 'down';
  uptime: number;
}

export interface ApiResponse<T> {
  status: number;
  ok: boolean;
  body: T;
}

export class ApiClient {
  constructor(readonly baseUrl: string) {}

  /**
   * Network failures and 502/503/504 (backend up but simulator/video unreachable) throw `Blocked`:
   * the ground truth is unavailable, so no verdict about the product can be made.
   */
  async request<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<ApiResponse<T>> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new Blocked(`backend unreachable: ${method} ${path} (${(e as Error).message})`);
    }
    if (res.status >= 502 && res.status <= 504) {
      const text = await res.text().catch(() => '');
      throw new Blocked(`upstream unavailable: ${method} ${path} -> ${res.status} ${text.slice(0, 120)}`);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    return { status: res.status, ok: res.ok, body: parsed as T };
  }

  private async json<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const r = await this.request<T & { error?: string }>(method, path, body);
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${r.body?.error ?? ''}`.trim());
    return r.body;
  }

  health(): Promise<Health> {
    return this.json('GET', '/api/health');
  }

  async devices(): Promise<DeviceInfo[]> {
    return (await this.json<{ devices: DeviceInfo[] }>('GET', '/api/devices')).devices;
  }

  async drones(): Promise<DeviceInfo[]> {
    return (await this.devices()).filter((d) => d.type === 'drone');
  }

  state(): Promise<SimSnapshot> {
    return this.json('GET', '/api/control/state');
  }

  sim(action: 'start' | 'stop' | 'reset'): Promise<SimSnapshot> {
    return this.json('POST', '/api/control/sim', { action });
  }

  /** `reset` also stops the world (simulator/src/world.ts), so a usable baseline is reset + start. */
  async resetAndStart(): Promise<SimSnapshot> {
    await this.sim('reset');
    return this.sim('start');
  }

  /** Raw so scenarios can assert on the ack separately from the resulting state. */
  command(deviceId: string, type: 'takeoff' | 'land') {
    return this.request<{ ok: boolean; error?: string }>('POST', '/api/control/command', { deviceId, type });
  }

  faults() {
    return this.json<{ faults: unknown[] }>('GET', '/api/control/fault');
  }

  clearFaults() {
    return this.json<{ faults: unknown[] }>('DELETE', '/api/control/fault');
  }

  // ---- Level-2 workload control (same error model: outages throw Blocked, other failures throw Error)

  addDrone(req: { name?: string; latitude?: number; longitude?: number } = {}): Promise<{ drone: DeviceInfo; dock: DeviceInfo }> {
    return this.json('POST', '/api/control/drones', req);
  }

  removeDrone(id: string): Promise<{ ok: boolean }> {
    return this.json('DELETE', `/api/control/drones/${encodeURIComponent(id)}`);
  }

  /** The simulator applies `speed` with any sim action; `start` keeps the world running. */
  setSimulationSpeed(speed: number, action: 'start' | 'stop' | 'reset' = 'start'): Promise<SimSnapshot> {
    return this.json('POST', '/api/control/sim', { action, speed });
  }

  videoControl(action: 'start' | 'stop', deviceId?: string): Promise<{ ok: boolean; devices: Array<{ id: string; enabled: boolean }> }> {
    return this.json('POST', '/api/control/video', deviceId ? { action, deviceId } : { action });
  }

  /**
   * Round-trip probe that never throws: outages (network, 502-504) are labelled `outage` so a
   * performance run can tell an unavailable service apart from a slow or failing product.
   */
  async timed(path: string): Promise<{ ok: boolean; status: number | null; rtt_ms: number; failure: 'none' | 'outage' | 'http'; error?: string }> {
    const t0 = performance.now();
    try {
      const r = await this.request('GET', path);
      const rtt = Math.round((performance.now() - t0) * 10) / 10;
      return r.ok ? { ok: true, status: r.status, rtt_ms: rtt, failure: 'none' } : { ok: false, status: r.status, rtt_ms: rtt, failure: 'http', error: `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, status: null, rtt_ms: Math.round(performance.now() - t0), failure: e instanceof Blocked ? 'outage' : 'http', error: (e as Error).message };
    }
  }
}
