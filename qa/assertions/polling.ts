/**
 * Bounded polling. Telemetry is eventually consistent (sim tick -> socket.io -> React render), so
 * cross-tier checks sample until a predicate holds or a hard deadline passes. Every sample is kept,
 * so a timeout produces a full trace instead of a single "last value".
 *
 * Robustness:
 *  - `confirm` (default 1): the predicate must hold on N consecutive samples before success, so one
 *    lucky frame cannot end a convergence wait early.
 *  - a sample that throws (transient network error) is recorded and retried, never fatal by itself.
 *  - `maxGapMs` reports the largest gap between samples, so a harness stall (GC, scheduling) is
 *    visible in evidence instead of being mistaken for product latency.
 */

export interface PollOptions {
  timeoutMs: number;
  intervalMs: number;
  confirm?: number;
}

export interface PollResult<T> {
  ok: boolean;
  elapsedMs: number;
  last: T | undefined;
  samples: Array<{ t: number; value: T }>;
  /** Consecutive failed sample attempts at the end (e.g. network errors). */
  errors: number;
  maxGapMs: number;
  error?: string;
}

export async function pollUntil<T>(sample: () => Promise<T>, done: (v: T) => boolean, opts: PollOptions): Promise<PollResult<T>> {
  const start = Date.now();
  const need = Math.max(1, opts.confirm ?? 1);
  const samples: Array<{ t: number; value: T }> = [];
  let last: T | undefined;
  let error: string | undefined;
  let errors = 0;
  let streak = 0;
  let maxGap = 0;
  let prevT: number | null = null;
  while (Date.now() - start <= opts.timeoutMs) {
    try {
      last = await sample();
      const t = Date.now() - start;
      if (prevT !== null) maxGap = Math.max(maxGap, t - prevT);
      prevT = t;
      samples.push({ t, value: last });
      error = undefined;
      errors = 0;
      streak = done(last) ? streak + 1 : 0;
      if (streak >= need) return { ok: true, elapsedMs: Date.now() - start, last, samples, errors, maxGapMs: maxGap };
    } catch (e) {
      error = (e as Error).message;
      errors++;
      // Ground-truth outages are not transient noise: let Blocked propagate to the executor.
      if ((e as Error).name === 'Blocked') throw e;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  return { ok: false, elapsedMs: Date.now() - start, last, samples, errors, maxGapMs: maxGap, error };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
