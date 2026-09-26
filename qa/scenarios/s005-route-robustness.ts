import { waitForDeviceRows } from '../assertions/cockpit.js';
import { pollUntil } from '../assertions/polling.js';
import { Blocked } from '../assertions/checks.js';
import { ALL_EVIDENCE, type Scenario, type Step } from './types.js';

/**
 * Router under test (frontend/src/App.tsx):
 *   <Route path="/" element={<CockpitPage/>}/>   <Route path="*" element={<Navigate to="/" replace/>}/>
 * There is no auth in this product. The contract is therefore: any unmapped path lands on the cockpit
 * at "/" (history replaced), renders normally, never throws, never shows a blank page, and never
 * reflects or executes path content.
 */

const PROBES: Array<{ path: string; why: string }> = [
  { path: '/', why: 'control: the mapped route' },
  { path: '/admin', why: 'common privileged path' },
  { path: '/settings', why: 'common app path' },
  { path: '/dashboard', why: 'exists on the backend (:4000), must not exist on the cockpit (:4010)' },
  { path: '/unauthorized', why: 'auth-sounding path (no auth exists)' },
  { path: '/admin/users/42?tab=roles#danger', why: 'nested path with query and hash' },
  { path: '/%2e%2e/%2e%2e/etc/passwd', why: 'encoded path traversal' },
  { path: '/<script>window.__qa_xss=1;alert(1)</script>', why: 'script in path' },
  { path: '/?q=<img src=x onerror="window.__qa_xss=1">', why: 'script in query string' },
];

/** Unique token planted in the payloads; appearing in the DOM or on window means reflection/execution. */
const MARKER = /__qa_xss/;

function probeStep({ path, why }: { path: string; why: string }): Step {
  const target = `route:${path}`;
  return {
    name: `GET ${path}  (${why})`,
    action: async ({ page, check, memo, evidence }) => {
      memo.consoleMark = evidence.console.length; // dialogs are attributed to the step that caused them
      let res;
      try {
        res = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      } catch (e) {
        throw new Blocked(`cockpit unreachable while probing ${path}: ${(e as Error).message.split('\n')[0]}`);
      }
      const status = res?.status() ?? null;
      check.that({ id: 'route.document_served', target, type: 'http_error' }, status !== null && status < 400, { expected: '< 400', actual: status ?? 'no response', state: `status-${status}` });
    },
    verify: async ({ page, check, config, evidence, memo }) => {
      const landed = await pollUntil(async () => new URL(page.url()).pathname, (p) => p === '/', { timeoutMs: 10_000, intervalMs: 100 });
      const rendered = await waitForDeviceRows(page, config.appReadyTimeoutMs);
      const probe = await page.evaluate(() => {
        const html = document.documentElement.outerHTML;
        return {
          rootChildren: document.getElementById('root')?.childElementCount ?? 0,
          bodyTextLength: document.body.innerText.trim().length,
          hasHeader: !!document.querySelector('header'),
          xssFlag: (window as unknown as { __qa_xss?: number }).__qa_xss ?? null,
          reflected: /__qa_xss/.test(html),
          leaked: /root:x:0:0/.test(html),
        };
      });
      const dialogs = evidence.console.slice(memo.consoleMark as number).filter((e) => e.kind === 'dialog');
      evidence.note(`route ${path}`, { url: page.url(), pathname: landed.last, rendered, ...probe });

      check.equal({ id: 'route.catch_all_redirects_home', target, type: 'wrong_route' }, landed.last, '/');
      check.that({ id: 'route.app_not_blank', target, type: 'blank' }, probe.rootChildren > 0 && probe.bodyTextLength > 0, { expected: 'non-empty #root', actual: { rootChildren: probe.rootChildren, bodyTextLength: probe.bodyTextLength }, state: 'blank' });
      check.that({ id: 'route.shell_rendered', target, type: 'missing' }, probe.hasHeader, { expected: 'header present', actual: 'no header', state: 'no-header' });
      check.that({ id: 'route.device_list_rendered', target, type: 'blank' }, rendered, { expected: 'device rows', actual: 'none', state: 'no-rows' });
      check.that({ id: 'route.no_script_execution', target, type: 'script_executed' }, probe.xssFlag === null && dialogs.length === 0, { expected: 'no __qa_xss flag, no dialog', actual: { xssFlag: probe.xssFlag, dialogs: dialogs.map((d) => d.text) }, state: probe.xssFlag !== null ? 'flag-set' : 'dialog' });
      check.that({ id: 'route.no_reflection', target, type: 'reflected' }, !probe.reflected, { expected: 'payload token absent from DOM', actual: 'token present in DOM', state: 'reflected' });
      check.that({ id: 'route.no_file_leak', target, type: 'leak' }, !probe.leaked, { expected: 'no /etc/passwd content', actual: 'passwd content in DOM', state: 'passwd' });
    },
  };
}

export const s005: Scenario = {
  id: 'scenario-005',
  title: 'Route Robustness',
  user_goal: 'Typing or following an unknown URL never leaves me on a broken or blank screen.',
  starting_state: {
    description: 'Simulator as-is (read-only scenario). Each step opens a fresh navigation to one probe path.',
    path: null,
    simulator: 'as-is',
    waitForDevices: false,
  },
  expected_behavior: [
    'Every probe path returns a document (no 4xx/5xx from the cockpit server).',
    'The router catch-all replaces any unmapped path with "/".',
    'The cockpit renders fully (header, device list) — never a blank #root.',
    'No uncaught exceptions; no script or markup from the URL executes or is reflected.',
  ],
  invariant: 'For every path p: status(p) < 400 && finalPath(p) == "/" && cockpitRendered && !scriptExecuted && !reflected.',
  evidence_requirements: ALL_EVIDENCE,
  tags: ['level-1', 'routing', 'security'],
  independent_steps: true,
  steps: PROBES.map(probeStep),
};
