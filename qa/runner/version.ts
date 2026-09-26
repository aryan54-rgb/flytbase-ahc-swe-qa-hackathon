import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Identifies exactly what was tested and with what, so a baseline can be matched to a later run:
 *  - harness: qa package version + content hash of the harness sources (scenarios/assertions/runner/utils)
 *  - app:     git commit of the product repo + whether product files (anything outside qa/) are modified
 */

export interface VersionInfo {
  harness: { version: string; source_hash: string };
  app: { git_commit: string | null; git_branch: string | null; product_dirty: boolean | null; dirty_files: string[] };
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function hashSources(qaRoot: string): string {
  const h = createHash('sha1');
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) h.update(relative(qaRoot, p).replace(/\\/g, '/')).update(readFileSync(p));
    }
  };
  for (const d of ['scenarios', 'assertions', 'runner', 'utils', 'healing', 'performance']) walk(join(qaRoot, d));
  return h.digest('hex').slice(0, 12);
}

let cached: VersionInfo | undefined;

export function versionInfo(qaRoot: string): VersionInfo {
  if (cached) return cached;
  const repo = resolve(qaRoot, '..');
  const pkg = JSON.parse(readFileSync(join(qaRoot, 'package.json'), 'utf8')) as { version: string };
  const porcelain = git(repo, ['status', '--porcelain', '--', '.', ':(exclude)qa']);
  const dirtyFiles = porcelain === null ? [] : porcelain.split('\n').filter(Boolean).map((l) => l.slice(3));
  cached = {
    harness: { version: pkg.version, source_hash: hashSources(qaRoot) },
    app: {
      git_commit: git(repo, ['rev-parse', 'HEAD']),
      git_branch: git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
      product_dirty: porcelain === null ? null : dirtyFiles.length > 0,
      dirty_files: dirtyFiles,
    },
  };
  return cached;
}
