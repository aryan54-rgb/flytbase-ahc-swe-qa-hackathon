// Builds submission/results/manifest.json and submission/voiceover/all-scripts.md from the captured
// result.json files, the real WebM headers (via Playwright's bundled ffmpeg) and the voiceover scripts.
//   node submission/build-manifest.cjs
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const SUB = __dirname;
const FF = path.join(os.homedir(), 'AppData/Local/ms-playwright/ffmpeg-1011/ffmpeg-win64.exe');
const S = [
  ['001', 'device-integrity'],
  ['002', 'selection-sync'],
  ['003', 'responsive-375'],
  ['004', 'flight-consistency'],
  ['005', 'route-robustness'],
  ['006', 'map-toggle'],
];

function probe(file) {
  let out = '';
  try { execFileSync(FF, ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { out = String(e.stderr); }
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(out);
  const v = /Video: (\w+).*?\b(\d{2,5})x(\d{2,5})\b.*?(\d+(?:\.\d+)?) fps/.exec(out);
  return {
    container: /Input #0, ([^,]+,[^,]+),/.exec(out)?.[1] ?? null,
    duration_s: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    codec: v?.[1] ?? null,
    resolution: v ? `${v[2]}x${v[3]}` : null,
    fps: v ? Number(v[4]) : null,
  };
}

const quote = (md) => md.split('\n').filter((l) => l.startsWith('> ')).map((l) => l.slice(2)).join(' ');
const words = (t) => t.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

const manifest = { generated_at: new Date().toISOString(), capture: 'bash submission/capture.sh (each scenario run individually, clean app, no mutation, no LLM provider)', scenarios: [] };
let all = '# Voiceover scripts — all six scenarios\n\nEach script follows the exact order of actions in its recording. Spoken at ~150 words/min.\n';

for (const [id, name] of S) {
  const r = JSON.parse(fs.readFileSync(path.join(SUB, 'results', `scenario-${id}-result.json`), 'utf8'));
  const video = `videos/scenario-${id}-${name}.webm`;
  const vo = `voiceover/scenario-${id}.md`;
  const voPath = path.join(SUB, vo);
  let md = fs.readFileSync(voPath, 'utf8');
  const text = quote(md);
  const n = words(text);
  const secs = Math.round((n / 150) * 60);
  md = md.replace(/\*~?\d+ words · ~\d+ s\*/, `*${n} words · ~${secs} s spoken*`);
  fs.writeFileSync(voPath, md);
  const p = probe(path.join(SUB, video));
  const stable = r.findings.filter((f) => f.baseline_state === 'STABLE_BASELINE').length;
  const fresh = r.findings.filter((f) => f.baseline_state === 'NEW_DEFECT' || !f.baseline_state).length;
  manifest.scenarios.push({
    scenario_id: r.scenario.id,
    title: r.scenario.title,
    user_goal: r.scenario.user_goal,
    verdict: r.status,
    status_reason: r.status_reason,
    video_filename: video,
    video: { bytes: fs.statSync(path.join(SUB, video)).size, ...p },
    voiceover_filename: vo,
    voiceover_words: n,
    voiceover_est_seconds: secs,
    evidence_directory: `evidence/scenario-${id}`,
    result_file: `results/scenario-${id}-result.json`,
    duration_ms: r.duration_ms,
    viewport: r.viewport,
    finding_count: r.findings.length,
    findings: r.findings.map((f) => ({ fingerprint: f.fingerprint, check_id: f.check_id, target: f.target, failure_type: f.failure_type, baseline_state: f.baseline_state ?? null })),
    baseline_status: r.findings.length === 0 ? 'no findings' : `${stable} STABLE_BASELINE, ${fresh} NEW`,
    baseline_id: r.baseline_comparison?.baseline_id ?? null,
    mutation: r.environment.mutation,
    healing: r.healing?.summary.status ?? null,
    llm_provider: r.healing?.provider ?? null,
    warnings: r.warnings,
    started_at: r.started_at,
  });
  all += `\n---\n\n## ${r.scenario.id} — ${r.scenario.title} — ${r.status === 'DEFECT_FOUND' ? 'DEFECT FOUND' : r.status}\n\nVideo: \`${video}\` (${p.duration_s} s) · ${n} words · ~${secs} s spoken\n\n> ${text}\n`;
}
fs.writeFileSync(path.join(SUB, 'results', 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(SUB, 'voiceover', 'all-scripts.md'), all);
for (const s of manifest.scenarios) console.log(`${s.scenario_id}  ${s.verdict.padEnd(13)} video ${String(s.video.duration_s).padEnd(6)}s ${s.video.resolution} ${s.video.codec} ${s.video.fps}fps  vo ${s.voiceover_words}w ~${s.voiceover_est_seconds}s  findings ${s.finding_count} (${s.baseline_status})  mutation=${s.mutation}`);
