import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ScenarioResult } from '../runner/executor.js';

/**
 * Append-only run history (memory/run-history.jsonl), one line per scenario execution.
 * Uses the same verdicts and fingerprints as result.json so runs can be diffed over time
 * (flakiness tracking; later, the healing layer's training data).
 */
export function remember(memoryDir: string, runId: string, mode: string, r: ScenarioResult): void {
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
  const line = {
    run_id: runId,
    mode,
    mutation: r.environment.mutation,
    scenario: r.scenario.id,
    status: r.status,
    status_reason: r.status_reason,
    duration_ms: r.duration_ms,
    fingerprints: r.findings.map((f) => f.fingerprint).sort(),
    new_fingerprints: r.findings.filter((f) => f.baseline_state === 'NEW_DEFECT').map((f) => f.fingerprint).sort(),
    masked_baseline: r.baseline_comparison?.masked ?? [],
    baseline_id: r.baseline_comparison?.baseline_id ?? null,
    harness_hash: r.versions.harness.source_hash,
    app_commit: r.versions.app.git_commit,
    finished_at: r.finished_at,
  };
  appendFileSync(join(memoryDir, 'run-history.jsonl'), `${JSON.stringify(line)}\n`);
}
