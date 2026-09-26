import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEVICE_ROW_PREFIX, EL, TID } from '../utils/selectors.js';

/**
 * Static guard for mutation/detector independence. A mutation that finds its target with the same
 * selector a detector uses proves nothing (they agree by construction). Scans runner/mutations.ts
 * (comments stripped) for:
 *   - imports of detector modules (utils/selectors, assertions/*)
 *   - data-testid usage or any test id value / prefix from the registry
 *   - any registry CSS selector
 *   - any CSS class the registry relies on (e.g. the `selected` state class)
 */
export function mutationDecouplingViolations(qaRoot: string): string[] {
  const src = readFileSync(join(qaRoot, 'runner', 'mutations.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const v: string[] = [];
  if (/from\s+['"]\.\.\/(utils\/selectors|assertions\/|scenarios\/|healing\/)/.test(code)) v.push('imports a detector/scenario/healing module');
  if (/data-testid/.test(code)) v.push('uses data-testid');
  for (const id of [...Object.values(TID), DEVICE_ROW_PREFIX]) if (code.includes(id)) v.push(`uses test id "${id}"`);
  for (const [name, el] of Object.entries(EL)) if (!/^[a-z]+$/.test(el.css) && code.includes(el.css)) v.push(`uses registry selector ${name} (${el.css})`);
  const detectorClasses = new Set(Object.values(EL).flatMap((e) => [...e.css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1])));
  for (const cls of detectorClasses) if (new RegExp(`['".\\s]${cls}['"\\s)]`).test(code)) v.push(`uses detector state class "${cls}"`);
  return v;
}
