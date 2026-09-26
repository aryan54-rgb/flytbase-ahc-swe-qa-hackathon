import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { ApiClient } from '../utils/api.js';
import type { QaConfig } from './config.js';
import type { EvidenceRecorder } from './evidence.js';

/**
 * Browser fixture: one browser per run, one fresh context (clean storage, own video) per scenario.
 */

export async function launchBrowser(config: QaConfig, extraArgs: string[] = []): Promise<Browser> {
  return chromium.launch({
    headless: config.headless,
    slowMo: config.slowMo || undefined,
    // Cesium needs WebGL; headless Chromium provides it through SwiftShader.
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...extraArgs],
  });
}

export interface ScenarioFixture {
  context: BrowserContext;
  page: Page;
  api: ApiClient;
  /** Close the context, then move the recorded video to recording.webm. */
  dispose: () => Promise<string | null>;
}

export async function openScenarioFixture(
  browser: Browser,
  config: QaConfig,
  evidence: EvidenceRecorder,
  viewport: { width: number; height: number },
): Promise<ScenarioFixture> {
  const videoTmp = evidence.path('.video-tmp');
  mkdirSync(videoTmp, { recursive: true });

  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: videoTmp, size: viewport },
    baseURL: config.cockpitUrl,
    ignoreHTTPSErrors: true,
  });
  // tsx/esbuild (keepNames) wraps named functions in __name(...); functions shipped to page.evaluate
  // carry that call into the browser, where it does not exist. Harness-only shim, no product effect.
  await context.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f);' });
  if (config.mutation) {
    await config.mutation.apply(context, config.cockpitUrl);
    evidence.log({ kind: 'console', level: 'harness', text: `mutation applied: ${config.mutation.name} — ${config.mutation.description}` });
  }
  const page = await context.newPage();

  page.on('console', (msg) => {
    const loc = msg.location();
    evidence.log({ kind: 'console', level: msg.type(), text: msg.text(), location: loc.url ? `${loc.url}:${loc.lineNumber}` : undefined });
  });
  page.on('pageerror', (err) => evidence.log({ kind: 'pageerror', level: 'error', text: `${err.name}: ${err.message}`, location: err.stack?.split('\n')[1]?.trim() }));
  page.on('requestfailed', (req) => evidence.log({ kind: 'requestfailed', level: 'warning', text: `${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'failed'}` }));
  page.on('response', (res) => {
    if (res.status() >= 400) evidence.log({ kind: 'http-error', level: 'warning', text: `${res.status()} ${res.request().method()} ${res.url()}` });
  });
  // An unexpected dialog (e.g. reflected XSS -> alert()) is itself evidence; dismiss so the run continues.
  page.on('dialog', async (d) => {
    evidence.log({ kind: 'dialog', level: 'error', text: `${d.type()}: ${d.message()}` });
    await d.dismiss().catch(() => undefined);
  });

  const api = new ApiClient(config.apiUrl);

  const dispose = async (): Promise<string | null> => {
    const video = page.video();
    await context.close().catch(() => undefined);
    let out: string | null = null;
    try {
      const src = video ? await video.path() : readdirSync(videoTmp).map((f) => join(videoTmp, f))[0];
      if (src) {
        out = evidence.path('recording.webm');
        renameSync(src, out);
        evidence.files.recording = 'recording.webm';
      }
    } catch (e) {
      evidence.log({ kind: 'console', level: 'harness', text: `video save failed: ${(e as Error).message}` });
    }
    rmSync(videoTmp, { recursive: true, force: true });
    return out;
  };

  return { context, page, api, dispose };
}
