import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ApiClient } from '../utils/api.js';

/**
 * Per-scenario evidence directory: evidence/<scenario-id>/
 *   recording.webm  failure.png  final.png  dom.html  console.json  ground_truth.json  result.json
 * The directory is wiped at the start of each run of that scenario so it always reflects the latest run.
 */

export interface ConsoleEntry {
  t: number;
  kind: 'console' | 'pageerror' | 'requestfailed' | 'http-error' | 'dialog';
  level?: string;
  text: string;
  location?: string;
}

export interface GroundTruthSample {
  label: string;
  t: number;
  health?: unknown;
  devices?: unknown;
  state?: unknown;
  error?: string;
  extra?: unknown;
}

export class EvidenceRecorder {
  readonly dir: string;
  readonly console: ConsoleEntry[] = [];
  readonly groundTruth: GroundTruthSample[] = [];
  readonly files: Record<string, string> = {};
  private readonly t0 = Date.now();

  constructor(root: string, readonly scenarioId: string) {
    this.dir = join(root, scenarioId);
    if (existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }

  now(): number {
    return Date.now() - this.t0;
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  log(entry: Omit<ConsoleEntry, 't'>): void {
    this.console.push({ t: this.now(), ...entry });
  }

  /** Snapshot backend ground truth (health, devices, sim state) under a label. Never throws. */
  async snapshotBackend(api: ApiClient, label: string, extra?: unknown): Promise<GroundTruthSample> {
    const s: GroundTruthSample = { label, t: this.now(), extra };
    try {
      const [health, devices, state] = await Promise.all([api.health(), api.devices(), api.state()]);
      Object.assign(s, { health, devices, state });
    } catch (e) {
      s.error = (e as Error).message;
    }
    this.groundTruth.push(s);
    return s;
  }

  /** Attach arbitrary ground-truth data (e.g. a polling trace). */
  note(label: string, extra: unknown): void {
    this.groundTruth.push({ label, t: this.now(), extra });
  }

  async screenshot(page: Page, name: string): Promise<void> {
    try {
      await page.screenshot({ path: this.path(name), fullPage: false, timeout: 10_000 });
      this.files[name.replace(/\.png$/, '')] = name;
    } catch (e) {
      this.log({ kind: 'console', level: 'harness', text: `screenshot ${name} failed: ${(e as Error).message}` });
    }
  }

  /**
   * Screenshot with the affected regions outlined and labelled (overlay injected, captured, removed).
   * Boxes are viewport coordinates recorded by the failing checks.
   */
  async annotatedScreenshot(page: Page, boxes: Array<{ label: string; rect: { x: number; y: number; width: number; height: number } }>, name = 'failure-annotated.png'): Promise<void> {
    if (boxes.length === 0) return;
    try {
      await page.evaluate((list) => {
        const layer = document.createElement('div');
        layer.id = '__qa_annotations';
        layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
        const colors = ['#ff2d55', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2'];
        list.forEach((b, i) => {
          const c = colors[i % colors.length];
          const d = document.createElement('div');
          d.style.cssText = `position:absolute;left:${b.rect.x}px;top:${b.rect.y}px;width:${b.rect.width}px;height:${b.rect.height}px;outline:2px solid ${c};background:${c}22`;
          const t = document.createElement('span');
          t.textContent = b.label;
          t.style.cssText = `position:absolute;left:0;top:-15px;font:600 10px/14px monospace;color:#000;background:${c};padding:0 3px;white-space:nowrap`;
          d.appendChild(t);
          layer.appendChild(d);
        });
        document.body.appendChild(layer);
      }, boxes);
      await page.screenshot({ path: this.path(name), timeout: 10_000 });
      this.files.failure_annotated = name;
    } catch (e) {
      this.log({ kind: 'console', level: 'harness', text: `annotated screenshot failed: ${(e as Error).message}` });
    } finally {
      await page.evaluate(() => document.getElementById('__qa_annotations')?.remove()).catch(() => undefined);
    }
  }

  /** Which required evidence files are missing or empty on disk. */
  missing(required: string[]): string[] {
    return required.filter((f) => {
      try {
        return statSync(this.path(f)).size === 0;
      } catch {
        return true;
      }
    });
  }

  async dom(page: Page, name = 'dom.html'): Promise<void> {
    try {
      writeFileSync(this.path(name), await page.content());
      this.files.dom = name;
    } catch (e) {
      this.log({ kind: 'console', level: 'harness', text: `dom snapshot failed: ${(e as Error).message}` });
    }
  }

  writeJson(name: string, data: unknown): void {
    writeFileSync(this.path(name), JSON.stringify(data, null, 2));
  }

  flushLogs(): void {
    this.writeJson('console.json', this.console);
    this.files.console = 'console.json';
    this.writeJson('ground_truth.json', this.groundTruth);
    this.files.ground_truth = 'ground_truth.json';
  }
}
