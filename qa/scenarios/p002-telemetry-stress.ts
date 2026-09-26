import { readSelection } from '../assertions/cockpit.js';
import { pollUntil } from '../assertions/polling.js';
import { guarded } from '../performance/probe.js';
import { perfScenario, type PerfRun } from '../performance/scenario.js';
import type { TelemetryProbe, WindowMetrics, WorkloadContext } from '../performance/types.js';
import type { DeviceInfo } from '../utils/api.js';
import { EL } from '../utils/selectors.js';

/**
 * P002: operator triage under live telemetry + video. Workload axis = interaction interval
 * (2.0 s -> 1.0 s -> 0.5 s, never below the 500 ms safety floor) on a 6-drone fleet with 3 drones
 * flying (their telemetry changes every tick, so "telemetry belongs to the selected drone" is
 * checked on values, not only on the header).
 *
 * Each stress phase is one observation window during which the operator alternates "select a drone"
 * and "toggle 2D/3D", each measured to its postcondition. Before stress and after every phase, one
 * video transition of the selected drone is timed: stop -> tile shows "off", start -> tile shows
 * "live" -> frames actually decoded. A "live" label without decoded frames is reported, not trusted.
 */

interface VideoTransition {
  device: string;
  workload: WorkloadContext;
  skipped?: string;
  off_ms: number | null;
  live_label_ms: number | null;
  frames_ms: number | null;
  claim_without_frames: boolean;
  still_live_after_stop: boolean;
  labels_seen: string[];
}

async function videoTransition(s: PerfRun, deviceId: string, wl: WorkloadContext): Promise<VideoTransition> {
  const base: VideoTransition = { device: deviceId, workload: wl, off_ms: null, live_label_ms: null, frames_ms: null, claim_without_frames: false, still_live_after_stop: false, labels_seen: [] };
  const initial = await s.probe.video(deviceId);
  if (initial.enabled !== true) return { ...base, skipped: `video not enabled for ${deviceId} (retained payload: ${JSON.stringify(initial)})` };
  const read = () =>
    guarded(
      s.page.evaluate(({ stateCss, playerCss }) => {
        const v = document.querySelector(`video${playerCss}`) as HTMLVideoElement | null;
        return { label: document.querySelector(stateCss)?.textContent?.trim() ?? '', readyState: v?.readyState ?? null, width: v?.videoWidth ?? 0, time: v?.currentTime ?? null };
      }, { stateCss: EL.videoState.css, playerCss: EL.videoPlayer.css }),
      s.cfg.safety.freezeAbortMs,
      'video state',
    );
  const labels = new Set<string>();
  const t0 = Date.now();
  await s.ledger.stopVideo(deviceId);
  const stopAck = Date.now() - t0;
  const off = await pollUntil(read, (r) => (labels.add(r.label), r.label === 'off'), { timeoutMs: 8_000, intervalMs: 50 });
  const t1 = Date.now();
  await s.ledger.startVideo(deviceId);
  const startAck = Date.now() - t1;
  const live = await pollUntil(read, (r) => (labels.add(r.label), r.label === 'live'), { timeoutMs: 10_000, intervalMs: 50 });
  let frames_ms: number | null = null;
  if (live.ok) {
    const firstTime = live.last?.time ?? 0;
    const frames = await pollUntil(read, (r) => r.width > 0 && (r.readyState ?? 0) >= 2 && (r.time ?? 0) > firstTime + 0.2, { timeoutMs: 8_000, intervalMs: 100 });
    if (frames.ok) frames_ms = Date.now() - t1;
  }
  const out: VideoTransition = {
    ...base,
    // request sent -> tile label observed (harness wall clock, 50 ms polling)
    off_ms: off.ok ? stopAck + off.elapsedMs : null,
    live_label_ms: live.ok ? startAck + live.elapsedMs : null,
    frames_ms,
    claim_without_frames: live.ok && frames_ms === null,
    still_live_after_stop: !off.ok && off.last?.label === 'live',
    labels_seen: [...labels],
  };
  for (const [metric, v] of [['video_live_ms', out.frames_ms]] as const) s.samples.push({ metric, source: 'product', value: v, unit: 'ms', t_wall: new Date().toISOString(), t_rel_ms: s.evidence.now(), workload: wl, window_id: null, detail: { ...out, workload: undefined } });
  return out;
}

export const p002 = perfScenario({
  id: 'P002',
  title: 'Telemetry + interaction stress',
  user_goal: 'An operator rapidly triages multiple drones while real-time telemetry and video are active.',
  axis: 'interaction_interval_ms',
  axisLabel: 'interval ms',
  starting: 'Simulator reset + started at 1.0x; fleet grown to 6 drones, 3 of them flying; video of the selected drone active; cockpit at / with the performance probe.',
  expected_behavior: [
    'Every selection takes effect: the clicked drone is the selected row and the telemetry header names it.',
    'The telemetry shown belongs to the selected drone (values match its own stream) and stays fresh (≤ 3000 ms).',
    'Map 2D/3D toggles are acknowledged and the camera settles at the target pitch.',
    'Video transitions: stop shows "off"; start shows "live" only when frames are actually decoded.',
    'No unhandled browser errors, no socket drops, no WebGL context loss as the interaction rate increases.',
  ],
  invariant: 'For interval ∈ {2000, 1000, 500} ms: selection postcondition holds; telemetry ∈ selected drone stream; age ≤ 3000 ms; interaction ≤ 150 ms nominal (> 300 degraded, > 1000 breach); TBT/long tasks/FPS within contract; video "live" ⇒ decoded frames.',
  workload: async (s) => {
    const cfg = s.cfg;
    const st = cfg.stress;
    const fleet = await s.applyFleet(st.drones);
    const flyers = s.drones.slice(0, st.flyingDrones);
    for (const d of flyers) await s.ledger.takeoff(d.id);
    await s.stabilize();

    const order: DeviceInfo[] = [...flyers, ...s.drones.filter((d) => !flyers.includes(d))];
    const memo = { selected: (await readSelection(s.page)).selectedRowIds[0] ?? null, idx: 0 };
    const videos: VideoTransition[] = [];
    const nextTarget = () => {
      for (;;) {
        const d = order[memo.idx++ % order.length];
        if (d.id !== memo.selected) return d;
      }
    };
    const select = async (w: WindowMetrics, wl: WorkloadContext, interval?: number) => {
      const d = nextTarget();
      const m = await s.selectDevice(d, wl, interval);
      w.interactions.push(m);
      if (m.stage === 'POSTCONDITION_SATISFIED') memo.selected = d.id;
      const t = await s.telemetry();
      if (t) w.telemetry.push(t);
    };

    // Video is autostarted by the backend only for the boot-time fleet: use one of those drones,
    // selected first (the tile always shows the selected drone).
    let videoDrone: DeviceInfo | undefined;
    for (const d of s.drones) if ((await s.probe.video(d.id)).enabled === true) {
      videoDrone = d;
      break;
    }
    const videoStep = async (wl: WorkloadContext) => {
      if (!videoDrone) return;
      if (memo.selected !== videoDrone.id) {
        const m = await s.selectDevice(videoDrone, wl);
        if (m.stage === 'POSTCONDITION_SATISFIED') memo.selected = videoDrone.id;
      }
      videos.push(await videoTransition(s, videoDrone.id, wl));
    };

    await s.collectBaseline(0, cfg.baseline.windows, async (wl) => {
      const w = await s.observe(wl);
      await select(w, wl);
      return w;
    });
    await videoStep(s.workload(0, 'baseline'));

    const phases: Array<Record<string, unknown>> = [];
    for (const interval of st.intervalsMs) {
      if (!s.fits(2 * st.phaseMs + 15_000)) {
        s.truncated = `stress phase ${interval} ms not run: time budget`;
        break;
      }
      const step = await s.evaluateLevel(interval, 'stress', (wl) =>
        s.observe(wl, st.phaseMs, async (w) => {
          const end = Date.now() + st.phaseMs - 300;
          for (let k = 0; Date.now() < end && !s.cancelled; k++) {
            if (k % 2 === 0) await select(w, wl, interval);
            else w.interactions.push(await s.toggleMap(wl, interval));
          }
        }),
      );
      const ws = step.windows;
      const n = ws.reduce((a, w) => a + w.interactions.length, 0);
      const secs = ws.reduce((a, w) => a + (w.t_end_ms - w.t_start_ms) / 1000, 0);
      phases.push({ interval_ms: interval, verdict: step.verdict, interactions: n, achieved_per_s: Math.round((n / Math.max(1, secs)) * 100) / 100, target_per_s: Math.round((1000 / interval) * 100) / 100 });
      // The selection the operator made last is still the one shown.
      const sel = await readSelection(s.page);
      s.ctx.check.that({ id: 'perf.selection_retained', target: 'region:device-list', type: 'mismatch' }, sel.selectedRowIds.length === 1 && sel.selectedRowIds[0] === memo.selected, {
        expected: memo.selected,
        actual: sel.selectedRowIds,
        state: sel.selectedRowIds.length === 1 ? 'other-selected' : sel.selectedRowIds.length ? 'many-selected' : 'none-selected',
      });
      await videoStep(s.workload(interval, 'stress'));
    }

    // Telemetry correctness over every sample, in time order: a wrong-device reading must persist
    // for 2 consecutive samples to count (one sample straddling a React commit is not a verdict).
    const tel = s.windows.flatMap((w) => w.telemetry).sort((a, b) => a.t_rel_ms - b.t_rel_ms);
    const streak = (bad: (t: TelemetryProbe) => boolean) => {
      let best = 0;
      let cur = 0;
      const where: TelemetryProbe[] = [];
      for (const t of tel) {
        cur = bad(t) ? cur + 1 : 0;
        if (cur > best) best = cur;
        if (bad(t)) where.push(t);
      }
      return { best, where: where.slice(0, 5) };
    };
    const wrongDevice = streak((t) => t.matched_other_device !== null && !t.matched_selected_device && t.frames_buffered >= 3);
    const wrongHeader = streak((t) => !!t.device_id && !t.header_matches_selected);
    s.ctx.check.that({ id: 'perf.telemetry_belongs_to_selected', target: 'region:telemetry', type: 'mismatch' }, wrongDevice.best < 2, {
      expected: "displayed values match the selected drone's own stream",
      actual: wrongDevice.where,
      state: 'other-device-values',
      message: `telemetry panel showed another drone's values in ${wrongDevice.best} consecutive samples`,
    });
    s.ctx.check.that({ id: 'perf.telemetry_header_follows', target: 'region:telemetry', type: 'mismatch' }, wrongHeader.best < 2, { expected: 'header names the selected drone', actual: wrongHeader.where, state: 'header-mismatch' });
    for (const v of videos.filter((x) => !x.skipped)) {
      s.ctx.check.that({ id: 'perf.video_state_follows', target: `device:${v.device}`, type: 'mismatch' }, !v.still_live_after_stop, { expected: 'off after stop', actual: v.labels_seen, state: 'live-after-stop' });
      s.ctx.check.warn({ id: 'perf.video_live_has_frames', target: `device:${v.device}`, type: 'mismatch' }, !v.claim_without_frames, { expected: '"live" only with decoded frames', actual: v, state: 'live-without-frames' });
    }
    s.extra = {
      fleet_convergence_ms: fleet.convergence_ms,
      flying: flyers.map((d) => d.id),
      phases,
      video_transitions: videos.map(({ workload, ...v }) => ({ ...v, interval_ms: workload.level, phase: workload.phase })),
      video_drone: videoDrone?.id ?? 'none with an active stream',
      telemetry_correctness: { samples: tel.length, matched_selected: tel.filter((t) => t.matched_selected_device).length, wrong_device_max_streak: wrongDevice.best, header_mismatch_max_streak: wrongHeader.best },
    };
  },
});
