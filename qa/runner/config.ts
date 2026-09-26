import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mutation } from './mutations.js';
import type { SemanticResolver } from '../healing/resolver.js';

const qaRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Every knob the harness reads. Override with env vars; defaults target the local docker stack. */
export const qaConfig: {
  cockpitUrl: string;
  apiUrl: string;
  expectedDrones: number;
  defaultViewport: { width: number; height: number };
  appReadyTimeoutMs: number;
  headless: boolean;
  slowMo: number;
  paths: { root: string; evidence: string; memory: string; healingMemory: string };
  healing: { high: number; margin: number; medium: number; llmMinConfidence: number };
  /** Tier-3 resolver; created from env in run.ts (QA_LLM_PROVIDER), 'none' when unset. */
  resolver?: SemanticResolver;
  /** Runtime mutation applied to every browser context (mutation testing). Undefined = real app. */
  mutation?: Mutation;
} = {
  cockpitUrl: process.env.QA_COCKPIT_URL ?? 'http://localhost:4010',
  apiUrl: process.env.QA_API_URL ?? 'http://localhost:4000',
  /** Drones the stock simulator boots with. Used as a baseline check, not as the source of truth. */
  expectedDrones: num('QA_EXPECTED_DRONES', 4),
  defaultViewport: { width: num('QA_VIEWPORT_W', 1440), height: num('QA_VIEWPORT_H', 900) },
  /** How long the cockpit gets to show the device list after navigation. */
  appReadyTimeoutMs: num('QA_APP_READY_MS', 30_000),
  headless: process.env.QA_HEADED !== '1',
  slowMo: num('QA_SLOWMO_MS', 0),
  healing: {
    high: Number(process.env.QA_HEAL_HIGH) || 0.45,
    margin: Number(process.env.QA_HEAL_MARGIN) || 0.2,
    medium: Number(process.env.QA_HEAL_MEDIUM) || 0.3,
    llmMinConfidence: Number(process.env.QA_LLM_MIN_CONFIDENCE) || 0.8,
  },
  paths: {
    root: qaRoot,
    evidence: resolve(qaRoot, 'evidence'),
    memory: resolve(qaRoot, 'memory'),
    healingMemory: process.env.QA_HEALING_MEMORY ?? resolve(qaRoot, 'memory', 'healing-memory.json'),
  },
};

export type QaConfig = typeof qaConfig;
