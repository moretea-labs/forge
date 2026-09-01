import { createHash } from 'crypto';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import { spawnSync } from 'child_process';

const MAX_REVIEW_PATHS = 256;

type ReviewContentEntry = { path: string; mode: string; blob: string } | { path: string; deleted: true };

function normalizeReviewPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function safePaths(root: string, paths: readonly string[]): string[] {
  const canonicalRoot = resolve(root);
  const normalized = normalizeReviewPaths(paths);
  if (normalized.length > MAX_REVIEW_PATHS) {
    throw new Error(`WORK_IMPLEMENTATION_REVIEW_TOO_MANY_PATHS: ${normalized.length} exceeds ${MAX_REVIEW_PATHS}`);
  }
  for (const path of normalized) {
    const absolute = resolve(canonicalRoot, path);
    const rel = relative(canonicalRoot, absolute);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`WORK_IMPLEMENTATION_REVIEW_PATH_OUTSIDE_CHECKOUT: ${path}`);
    // Lexical containment is insufficient when a parent directory is a symlink.
    // Review content must never hash a file reached by escaping the checkout.
    let probe = existsSync(absolute) ? absolute : resolve(absolute, '..');
    while (!existsSync(probe) && probe !== canonicalRoot) probe = resolve(probe, '..');
    const realProbe = realpathSync(probe);
    const realRoot = realpathSync(canonicalRoot);
    const realRel = relative(realRoot, realProbe);
    if (realRel.startsWith('..') || isAbsolute(realRel)) throw new Error(`WORK_IMPLEMENTATION_REVIEW_PATH_OUTSIDE_CHECKOUT: ${path}`);
  }
  return normalized;
}

function git(root: string, args: string[], input?: string): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', input, stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') {
    throw new Error(`WORK_IMPLEMENTATION_REVIEW_GIT_CONTENT_IDENTITY_UNAVAILABLE: ${args.join(' ')}: ${String(result.stderr ?? result.error ?? '').trim()}`);
  }
  return result.stdout.trim();
}

function fingerprint(entries: readonly ReviewContentEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/**
 * Stage-insensitive prospective Git content identity for the exact reviewed paths.
 * `git hash-object --path` applies the same clean-filter semantics Git uses when
 * staging, so review is bound to the commit-canonical blob rather than raw bytes.
 */
export function implementationReviewContentFingerprint(root: string, changedPaths: readonly string[]): string {
  const canonicalRoot = resolve(root);
  const entries: ReviewContentEntry[] = safePaths(canonicalRoot, changedPaths).map((path) => {
    const absolute = resolve(canonicalRoot, path);
    if (!existsSync(absolute)) return { path, deleted: true } as const;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      const blob = git(canonicalRoot, ['hash-object', '--stdin'], target);
      return { path, mode: '120000', blob };
    }
    if (!stat.isFile()) throw new Error(`WORK_IMPLEMENTATION_REVIEW_PATH_TYPE_UNSUPPORTED: ${path}`);
    const blob = git(canonicalRoot, ['hash-object', '--path', path, path]);
    const mode = (stat.mode & 0o111) !== 0 ? '100755' : '100644';
    return { path, mode, blob };
  });
  return fingerprint(entries);
}

/** Exact stage-0 index identity immediately before commit. Conflicts fail closed. */
export function implementationReviewIndexFingerprint(root: string, changedPaths: readonly string[]): string {
  const canonicalRoot = resolve(root);
  const paths = safePaths(canonicalRoot, changedPaths);
  const output = git(canonicalRoot, ['ls-files', '--stage', '-z', '--', ...paths]);
  const byPath = new Map<string, { mode: string; blob: string; stage: string }>();
  if (output) {
    for (const raw of output.split('\0').filter(Boolean)) {
      const match = /^(\d+)\s+([0-9a-f]+)\s+(\d+)\t([\s\S]+)$/.exec(raw);
      if (!match) throw new Error('WORK_IMPLEMENTATION_REVIEW_INDEX_IDENTITY_INVALID');
      const [, mode, blob, stage, path] = match;
      if (stage !== '0') throw new Error(`WORK_IMPLEMENTATION_REVIEW_INDEX_CONFLICT: ${path}`);
      byPath.set(path, { mode, blob, stage });
    }
  }
  const entries: ReviewContentEntry[] = paths.map((path) => {
    const entry = byPath.get(path);
    return entry ? { path, mode: entry.mode, blob: entry.blob } : { path, deleted: true };
  });
  return fingerprint(entries);
}
