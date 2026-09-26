import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Healing memory: verified selector repairs, human-readable JSON (qa/memory/healing-memory.json).
 *
 * Lookup key = sha1(application | page | intent | original target) — no timestamps, no run ids.
 * An entry is written ONLY after the healed target passed the action's postcondition.
 * On reuse the remembered target is re-found by its semantic signature (role | identity | context)
 * and must match exactly one live candidate that also passes the action's hard constraints;
 * otherwise the entry is marked stale and never used to redirect the action.
 * No secrets, page dumps or DOM snapshots are stored — only the descriptors below.
 */

export interface HealedTarget {
  role: string;
  name: string;
  context: string;
  heading: string | null;
  testid: string | null;
  /** Playwright locator idea for humans updating the test, e.g. getByRole('button', { name: 'Top-down' }). */
  suggested_locator: string;
}

export interface MemoryEntry {
  key: string;
  application_identity: string;
  page_identity: string;
  scenario_id: string;
  step_ids: string[];
  intent: string;
  original_target: string;
  original_selector: string;
  healed_target: HealedTarget;
  semantic_signature: string;
  learned_via: 'local' | 'llm';
  confidence: number;
  status: 'active' | 'stale';
  first_success: string;
  last_success: string;
  success_count: number;
  stale_count: number;
  last_stale_reason?: string;
  learned_on_commit: string | null;
}

interface MemoryFile {
  schema: 'cockpit-qa/healing-memory@1';
  note: string;
  entries: Record<string, MemoryEntry>;
}

export function memoryKey(app: string, page: string, intent: string, originalTarget: string): string {
  return createHash('sha1').update([app, page, intent, originalTarget].join(' | ')).digest('hex').slice(0, 16);
}

export class HealingMemory {
  private data: MemoryFile;
  constructor(readonly file: string) {
    this.data = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as MemoryFile)
      : { schema: 'cockpit-qa/healing-memory@1', note: 'Verified selector repairs learned by cockpit-qa. Safe to delete; entries are re-learned.', entries: {} };
  }

  get(key: string): MemoryEntry | undefined {
    return this.data.entries[key];
  }

  entries(): MemoryEntry[] {
    return Object.values(this.data.entries);
  }

  recordSuccess(e: Omit<MemoryEntry, 'first_success' | 'last_success' | 'success_count' | 'stale_count' | 'status'>, now = new Date().toISOString()): MemoryEntry {
    const prev = this.data.entries[e.key];
    const sameTarget = prev && prev.semantic_signature === e.semantic_signature;
    const entry: MemoryEntry = {
      ...e,
      step_ids: [...new Set([...(sameTarget ? prev.step_ids : []), ...e.step_ids])].sort(),
      status: 'active',
      first_success: sameTarget ? prev.first_success : now,
      last_success: now,
      success_count: (sameTarget ? prev.success_count : 0) + 1,
      stale_count: prev?.stale_count ?? 0,
    };
    this.data.entries[e.key] = entry;
    this.save();
    return entry;
  }

  markStale(key: string, reason: string): void {
    const e = this.data.entries[key];
    if (!e) return;
    e.status = 'stale';
    e.stale_count += 1;
    e.last_stale_reason = reason;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
