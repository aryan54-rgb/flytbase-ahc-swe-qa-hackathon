import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { EvidenceRecorder } from '../runner/evidence.js';
import { EL } from '../utils/selectors.js';
import { median } from './metrics.js';
import { guarded } from './probe.js';
import type { BottleneckSignal, MetricKey, PerformanceBaselineProfile, PerformanceResult, PerformanceRun, WindowMetrics, WorkloadStep } from './types.js';

// ==================================================================================== correlation

const med = (ws: WindowMetrics[], k: MetricKey) => median(ws.map((w) => w.values[k]));
const base = (p: PerformanceBaselineProfile | null, k: MetricKey) => p?.metrics[k]?.median ?? null;
const ratio = (a: number | null, b: number | null) => (a === null || b === null || b <= 0 ? null : Math.round((a / b) * 100) / 100);
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

/**
 * Correlate signals at the degradation point against the baseline. Correlation is not causation:
 * every statement is "signals consistent with ...", and the evidence behind it is attached.
 *
 *   high API RTT + normal main thread            -> backend
 *   normal API + high long tasks / TBT / busy    -> frontend main thread
 *   high telemetry lag + socket instability      -> transport / realtime
 *   low FPS + normal API + high render load      -> map rendering
 *   falling simulator tick rate                  -> simulator
 */
export function correlateBottlenecks(profile: PerformanceBaselineProfile | null, at: WindowMetrics[]): BottleneckSignal[] {
  if (!at.length) return [];
  const out: BottleneckSignal[] = [];
  const api = Math.max(med(at, 'api_health_rtt_ms') ?? 0, med(at, 'api_state_rtt_ms') ?? 0);
  const apiBase = Math.max(base(profile, 'api_health_rtt_ms') ?? 0, base(profile, 'api_state_rtt_ms') ?? 0) || null;
  const apiFailures = at.reduce((a, w) => a + w.api.filter((x) => !x.ok).length, 0);
  const apiHigh = (ratio(api, apiBase) ?? 0) >= 2 && api - (apiBase ?? 0) >= 50;

  const tbt = med(at, 'tbt_per_s');
  const lt = med(at, 'long_task_max_ms');
  const busy = med(at, 'main_thread_busy_ratio');
  const tbtBase = base(profile, 'tbt_per_s');
  const ltBase = base(profile, 'long_task_max_ms');
  const busyBase = base(profile, 'main_thread_busy_ratio');
  const mainHighReasons = [
    tbt !== null && tbt > Math.max(40, 2 * (tbtBase ?? 0)) && `blocking time ${r1(tbt)} ms/s vs baseline ${r1(tbtBase)} ms/s`,
    lt !== null && lt > Math.max(150, 2 * (ltBase ?? 0)) && `longest task ${r1(lt)} ms vs baseline ${r1(ltBase)} ms`,
    busy !== null && busy >= 0.5 && busy > 1.5 * (busyBase ?? 0) && `main thread busy ${Math.round(busy * 100)}% vs baseline ${busyBase === null ? '?' : Math.round(busyBase * 100)}%`,
  ].filter((x): x is string => !!x);

  const age = med(at, 'telemetry_age_ms');
  const ageBase = base(profile, 'telemetry_age_ms');
  const lagHigh = age !== null && age > Math.max(1000, 2 * (ageBase ?? 0));
  const closes = at.reduce((a, w) => a + (w.browser?.ws_closes ?? 0), 0);
  const badges = [...new Set(at.map((w) => w.browser?.socket_badge ?? ''))];
  const socketUnstable = closes > 0 || badges.some((b) => b !== '' && b !== 'socket connected');

  const fps = med(at, 'fps_mean');
  const fpsBase = base(profile, 'fps_mean');
  const fpsLow = fps !== null && (fps < 20 || (fpsBase !== null && fps < 0.7 * fpsBase));
  const render = med(at, 'map_render_ms');
  const renderBase = base(profile, 'map_render_ms');
  const renderHigh = render !== null && renderBase !== null && render > 1.5 * renderBase && render - renderBase > 5;

  const tickRate = med(at, 'sim_tick_rate');
  const tickBase = base(profile, 'sim_tick_rate');
  const loaf = at.flatMap((w) => w.browser?.loaf?.top_scripts ?? []);
  const topScripts = Object.values(
    loaf.reduce<Record<string, { source: string; invoker: string; duration_ms: number }>>((m, s) => {
      const k = `${s.source}|${s.invoker}`;
      m[k] = { source: s.source, invoker: s.invoker, duration_ms: (m[k]?.duration_ms ?? 0) + s.duration_ms };
      return m;
    }, {}),
  )
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, 3);

  if (apiHigh || apiFailures > 0) {
    out.push({
      id: 'backend',
      statement: `Signals consistent with a backend bottleneck: API round trip ${r1(api)} ms vs baseline ${r1(apiBase)} ms${apiFailures ? `, ${apiFailures} failed probes` : ''}${mainHighReasons.length ? ' (the browser main thread is ALSO loaded, so this is not isolated)' : ' while browser long tasks stay near baseline'}.`,
      strength: mainHighReasons.length ? 'weak' : apiHigh && apiFailures ? 'strong' : 'moderate',
      evidence: { api_rtt_ms: r1(api), api_rtt_baseline_ms: r1(apiBase), api_failures: apiFailures },
    });
  }
  if (mainHighReasons.length && !apiHigh) {
    out.push({
      id: 'frontend_main_thread',
      statement: `Signals consistent with a frontend main-thread bottleneck: ${mainHighReasons.join('; ')}, while API round trips stay near baseline (${r1(api)} ms vs ${r1(apiBase)} ms).${topScripts.length ? ` Long-animation-frame attribution points at ${topScripts.map((s) => `${s.source || '(inline)'} ${s.invoker}`.trim()).join(', ')}.` : ''}`,
      strength: mainHighReasons.length >= 2 ? 'strong' : 'moderate',
      evidence: { tbt_ms_per_s: r1(tbt), tbt_baseline_ms_per_s: r1(tbtBase), long_task_max_ms: r1(lt), long_task_baseline_ms: r1(ltBase), main_thread_busy_ratio: busy, busy_baseline: busyBase, fps_mean: r1(fps), fps_baseline: r1(fpsBase), map_render_ms: r1(render), ws_msgs_per_s: r1(med(at, 'ws_msgs_per_s')), rendered_track_points: median(at.map((w) => w.browser?.map.track_points ?? null)), loaf_top_scripts: topScripts },
    });
  }
  if (lagHigh && socketUnstable) {
    out.push({
      id: 'transport_realtime',
      statement: `Signals consistent with a transport/realtime bottleneck: displayed telemetry ${r1(age)} ms old (baseline ${r1(ageBase)} ms) with socket instability (${closes} WebSocket closes, badge ${badges.join('/')}).`,
      strength: 'moderate',
      evidence: { telemetry_age_ms: r1(age), baseline_ms: r1(ageBase), ws_closes: closes, socket_badge: badges },
    });
  } else if (lagHigh) {
    out.push({
      id: 'transport_realtime',
      statement: `Displayed telemetry is ${r1(age)} ms old (baseline ${r1(ageBase)} ms) with a stable socket: signals consistent with the UI falling behind the stream${mainHighReasons.length ? ' (main thread loaded)' : ''} rather than with a transport fault.`,
      strength: 'weak',
      evidence: { telemetry_age_ms: r1(age), baseline_ms: r1(ageBase), ws_closes: closes },
    });
  }
  if (fpsLow && !apiHigh && renderHigh) {
    out.push({
      id: 'map_rendering',
      statement: `Signals consistent with a map/rendering bottleneck: ${r1(fps)} fps (baseline ${r1(fpsBase)}) with Cesium render time ${r1(render)} ms per frame (baseline ${r1(renderBase)} ms) and normal API latency.`,
      strength: mainHighReasons.length ? 'weak' : 'moderate',
      evidence: { fps_mean: r1(fps), fps_baseline: r1(fpsBase), map_render_ms: r1(render), map_render_baseline_ms: r1(renderBase), map_renders_per_s: med(at, 'map_renders_per_s') },
    });
  }
  if (tickRate !== null && tickBase !== null && tickRate < 0.8 * tickBase) {
    out.push({ id: 'simulator', statement: `Signals consistent with the simulator falling behind: ${tickRate} ticks/s vs baseline ${tickBase}.`, strength: 'moderate', evidence: { tick_rate: tickRate, baseline: tickBase } });
  }
  return out;
}

// ==================================================================================== screenshot

/**
 * Raw screenshot of the cockpit. Playwright's screenshot needs the page's main thread (it waits for
 * fonts); when the page is frozen, fall back to CDP Page.captureScreenshot (compositor side).
 */
export async function rawScreenshot(page: Page, evidence: EvidenceRecorder): Promise<Buffer | null> {
  try {
    return await page.screenshot({ timeout: 8_000 });
  } catch (e) {
    evidence.log({ kind: 'console', level: 'harness', text: `page.screenshot failed (${(e as Error).message.split('\n')[0]}); trying CDP capture` });
  }
  try {
    const cdp = await page.context().newCDPSession(page);
    const shot = await guarded(cdp.send('Page.captureScreenshot', { format: 'png' }) as Promise<{ data: string }>, 10_000, 'cdp screenshot');
    await cdp.detach().catch(() => undefined);
    return Buffer.from(shot.data, 'base64');
  } catch (e) {
    evidence.log({ kind: 'console', level: 'harness', text: `CDP screenshot failed: ${(e as Error).message.split('\n')[0]}` });
    return null;
  }
}

/**
 * Annotated evidence: a raw screenshot of the cockpit, with a banner (workload, verdict, key metrics)
 * and the device list / map outlined, composed in a SEPARATE page so it works even while the cockpit
 * page is frozen (then the outlines are omitted). Also writes `alsoAs` (e.g. failure.png) when given.
 * Taken outside measurement windows. Failure to capture is logged, never fatal.
 */
export async function annotatedCapture(page: Page, evidence: EvidenceRecorder, lines: string[], name = 'degradation-annotated.png', alsoAs?: string): Promise<boolean> {
  const raw = await rawScreenshot(page, evidence);
  if (!raw) return false;
  if (alsoAs) {
    writeFileSync(evidence.path(alsoAs), raw);
    evidence.files[alsoAs.replace(/\.png$/, '')] = alsoAs;
  }
  const regions = await guarded(
    page.evaluate((list) => list.map((r) => ({ label: r.label, rect: document.querySelector(r.css)?.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number } | undefined })), [
      { css: EL.sidePanel.css, label: 'device list + telemetry' },
      { css: EL.mapRegion.css, label: 'map (Cesium) + video' },
    ]),
    2_000,
    'regions',
  ).catch(() => [] as Array<{ label: string; rect?: { x: number; y: number; width: number; height: number } }>);
  const vp = page.viewportSize() ?? { width: 1440, height: 900 };
  const browser = page.context().browser();
  if (!browser) return false;
  const ctx = await browser.newContext({ viewport: vp });
  try {
    const p = await ctx.newPage();
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const boxes = regions
      .filter((r) => r.rect)
      .map((r, i) => {
        const c = ['#ff2d55', '#0a84ff'][i % 2];
        const b = r.rect!;
        return `<div style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;outline:3px solid ${c}"><span style="position:absolute;left:0;bottom:0;font:600 11px/15px monospace;color:#fff;background:${c};padding:0 4px">${esc(r.label)}</span></div>`;
      })
      .join('');
    const note = regions.some((r) => r.rect) ? '' : '\n(cockpit page unresponsive: regions not outlined)';
    await p.setContent(
      `<html><body style="margin:0;position:relative;width:${vp.width}px;height:${vp.height}px;overflow:hidden"><img src="data:image/png;base64,${raw.toString('base64')}" style="position:absolute;left:0;top:0;width:${vp.width}px;height:${vp.height}px">${boxes}<pre style="position:absolute;left:50%;top:8px;transform:translateX(-50%);margin:0;padding:8px 12px;font:600 12px/16px monospace;color:#000;background:#ffcc00ee;border:2px solid #000;white-space:pre;max-width:90vw;overflow:hidden">${esc(lines.join('\n') + note)}</pre></body></html>`,
    );
    await p.screenshot({ path: evidence.path(name), timeout: 10_000 });
    evidence.files[name.replace(/\.png$/, '').replace(/-/g, '_')] = name;
    return true;
  } catch (e) {
    evidence.log({ kind: 'console', level: 'harness', text: `annotated capture failed: ${(e as Error).message}` });
    return false;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/** Banner lines for a judged step. */
export function stepBanner(scenarioId: string, axisLabel: string, s: WorkloadStep): string[] {
  const w = s.windows[s.windows.length - 1];
  const v = (k: MetricKey, unit = '') => (w?.values[k] === null || w?.values[k] === undefined ? 'n/a' : `${Math.round(w.values[k]! * 10) / 10}${unit}`);
  return [
    `${scenarioId} · ${axisLabel}=${s.level} · ${s.verdict}${s.phase === 'refine' ? ' (refinement)' : ''}`,
    `interaction p50 ${v('interaction_latency_ms', ' ms')} · longest task ${v('long_task_max_ms', ' ms')} · TBT ${v('tbt_per_s', ' ms/s')} · FPS ${v('fps_mean')} · max frame gap ${v('max_frame_gap_ms', ' ms')}`,
    `API ${v('api_state_rtt_ms', ' ms')} · telemetry age ${v('telemetry_age_ms', ' ms')} · fleet convergence ${v('fleet_convergence_ms', ' ms')}`,
    ...s.reasons.slice(0, 3).map((r) => `- ${r}`),
  ];
}

// ==================================================================================== evidence files

const fmt = (x: number | null | undefined, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : (Math.round(x * 10 ** d) / 10 ** d).toString());

export function stepRow(s: WorkloadStep): string {
  const ws = s.windows;
  const m = (k: MetricKey, d = 0) => fmt(median(ws.map((w) => w.values[k])), d);
  const heap = median(ws.map((w) => w.values.heap_used_bytes));
  const track = median(ws.map((w) => w.browser?.map.track_points ?? null));
  return `| ${s.level} | ${s.phase} | ${ws.length} | **${s.verdict}** | ${m('interaction_latency_ms')} | ${m('long_task_max_ms')} | ${m('tbt_per_s')} | ${m('fps_mean', 1)} | ${m('max_frame_gap_ms')} | ${heap === null ? 'n/a' : (heap / 1048576).toFixed(1)} | ${m('main_thread_busy_ratio', 2)} | ${m('ws_msgs_per_s')} | ${fmt(track)} | ${m('api_state_rtt_ms', 1)} | ${m('telemetry_age_ms')} | ${m('fleet_convergence_ms')} |`;
}

export function renderSummary(r: PerformanceResult, evidenceDir: string): string {
  const k = r.knee;
  const b = r.baseline;
  const bm = (key: MetricKey, d = 0) => {
    const m = b?.metrics[key];
    return m ? `${fmt(m.median, d)} (P95 ${fmt(m.p95, d)}, IQR ${fmt(m.iqr, d)}, n=${m.n})` : 'n/a';
  };
  const lines = [
    `# ${r.scenario_id} — ${r.title}`,
    '',
    `> ${r.user_goal}`,
    '',
    '| | |',
    '|---|---|',
    `| Scenario | ${r.scenario_id} |`,
    `| Workload axis | ${r.workload_axis} |`,
    `| Baseline | ${b ? `N=${b.workload.drones} drones, ${b.workload.sim_speed}x, ${b.workload.faults} faults, ${b.windows} windows × ${b.window_ms} ms` : 'not established'} |`,
    `| Safe capacity | ${k ? (k.safe_capacity === null ? 'none found at or above the lowest tested level' : `${k.safe_capacity}${k.established ? '' : ' (lower bound; boundary not established)'}`) : 'n/a (not a capacity scenario)'} |`,
    `| Degradation onset | ${k ? (k.degradation_onset === null ? 'not observed in the tested range' : String(k.degradation_onset)) : 'n/a'} |`,
    `| Primary signals | ${r.bottleneck_signals.length ? r.bottleneck_signals.map((s) => `${s.id} (${s.strength})`).join(', ') : 'none'} |`,
    `| Verdict | **${r.verdict}** — ${r.verdict_reason} |`,
    `| Evidence path | ${evidenceDir} |`,
    '',
    '## Baseline',
    '',
    `- interaction latency: ${bm('interaction_latency_ms')} ms`,
    `- longest task: ${bm('long_task_max_ms')} ms · total blocking time: ${bm('tbt_per_s')} ms per second`,
    `- FPS: ${bm('fps_mean', 1)} · max frame gap: ${bm('max_frame_gap_ms')} ms`,
    `- API /state RTT: ${bm('api_state_rtt_ms', 1)} ms · /health RTT: ${bm('api_health_rtt_ms', 1)} ms`,
    `- telemetry age: ${bm('telemetry_age_ms')} ms (clock offset ${b?.clock_offset_ms ?? 'n/a'} ms)`,
    `- heap: ${b?.metrics.heap_used_bytes ? `${(b.metrics.heap_used_bytes.median / 1048576).toFixed(1)} MB` : 'n/a'} · main-thread busy: ${bm('main_thread_busy_ratio', 2)}`,
    '',
    '## Measurements',
    '',
    '| level | phase | windows | verdict | interaction p50 ms | longest task ms | TBT ms/s | FPS | max gap ms | heap MB | main-thread busy | ws msg/s | track pts | API ms | telemetry age ms | convergence ms |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...r.steps.map(stepRow),
    '',
  ];
  if (k) {
    lines.push('## Boundary', '', `- ${k.reason}`, `- tested: ${k.tested.map((t) => `${t.level}:${t.verdict}`).join(' → ')}`);
    if (k.non_monotonic.length) lines.push(`- non-monotonic results (passed above a failing level): ${k.non_monotonic.map((x) => x.level).join(', ')}`);
    const failing = r.steps.find((s) => s.level === k.degradation_onset && !s.pass);
    if (failing) lines.push('- evidence at the onset:', ...failing.reasons.map((x) => `  - ${x}`));
    lines.push('');
  }
  const outliers = r.steps.flatMap((s) => s.isolated_outliers.map((o) => `${s.level}: ${o}`));
  if (outliers.length) lines.push('## Isolated outliers (not counted)', '', ...outliers.map((o) => `- ${o}`), '');
  const pre = r.steps.find((s) => s.phase === 'baseline')?.preexisting ?? [];
  if (pre.length) lines.push('## Contracts already violated at the baseline workload', '', ...pre.map((p) => `- ${p}`), '');
  if (r.bottleneck_signals.length) lines.push('## Signals', '', ...r.bottleneck_signals.map((s) => `- ${s.statement}`), '');
  if (Object.keys(r.extra).length) lines.push('## Scenario details', '', '```json', JSON.stringify(r.extra, null, 2).slice(0, 4000), '```', '');
  const un = Object.entries(r.unavailable_metrics);
  if (un.length) lines.push('## Unavailable metrics', '', ...un.map(([m, why]) => `- ${m}: ${why}`), '');
  lines.push('## Safety & cleanup', '', `- aborted: ${r.safety.aborted ?? 'no'} · truncated: ${r.safety.truncated ?? 'no'}`);
  if (r.cleanup) lines.push(`- cleanup ${r.cleanup.ok ? 'OK' : 'INCOMPLETE'}; back at baseline: ${r.cleanup.verified_baseline}; leftovers: ${r.cleanup.leftovers.join(', ') || 'none'}`);
  for (const n of r.environment.notes) lines.push(`- note: ${n}`);
  return `${lines.join('\n')}\n`;
}

export function writePerformanceEvidence(evidence: EvidenceRecorder, r: PerformanceResult): void {
  evidence.writeJson('performance.json', r);
  evidence.files.performance = 'performance.json';
  writeFileSync(evidence.path('summary.md'), renderSummary(r, evidence.dir));
  evidence.files.summary = 'summary.md';
}

/** Run-level summary across perf scenarios: evidence/performance-summary.{json,md}. */
export function writeRunSummary(evidenceRoot: string, run: PerformanceRun, results: PerformanceResult[]): string {
  writeFileSync(join(evidenceRoot, 'performance-summary.json'), JSON.stringify(run, null, 2));
  const md = [
    `# Level-2 performance run ${run.run_id}`,
    '',
    '| scenario | executor status | performance verdict | safe capacity | degradation onset | evidence |',
    '|---|---|---|---|---|---|',
    ...run.scenarios.map((s) => `| ${s.id} | ${s.status} | ${s.verdict} | ${s.safe_capacity ?? 'n/a'} | ${s.degradation_onset ?? 'n/a'} | ${s.evidence_dir} |`),
    '',
    ...results.map((r) => `- **${r.scenario_id}**: ${r.verdict} — ${r.verdict_reason}`),
    '',
  ].join('\n');
  const f = join(evidenceRoot, 'performance-summary.md');
  writeFileSync(f, md);
  return f;
}
