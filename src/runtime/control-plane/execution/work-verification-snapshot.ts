import { createHash } from 'crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { globMatches, normalizeMcpRelativePath } from '../../../cli/mcp/paths';
import { sanitizeFileComponent } from '../../shared/json-files';

const STALE_SNAPSHOT_MS = 6 * 60 * 60_000;
const SNAPSHOT_MARKER = '.forge-work-verification-snapshot.json';

export interface WorkVerificationSnapshotScope {
  workId: string;
  allowedPaths: readonly string[];
  forbiddenPaths: readonly string[];
}

export interface WorkVerificationSnapshot {
  root: string;
  sourceHead: string;
  includedPaths: string[];
  excludedPaths: string[];
  ownershipDigest: string;
}

function git(root: string, args: string[], maxBytes = 2 * 1024 * 1024): Buffer {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: maxBytes,
  });
  if (result.status !== 0 || result.error) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr ?? '');
    throw new Error(`WORK_VERIFICATION_SNAPSHOT_GIT_FAILED: git ${args.join(' ')}: ${stderr || result.error?.message || `exit ${result.status}`}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
}

function nulPaths(value: Buffer): string[] {
  return value.toString('utf8').split('\0').filter(Boolean).map((raw) => {
    const normalized = normalizeMcpRelativePath(raw);
    if (!normalized.ok || !normalized.relativePath) {
      throw new Error(`WORK_VERIFICATION_SNAPSHOT_PATH_INVALID: ${raw}`);
    }
    return normalized.relativePath;
  });
}

function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => globMatches(pattern, path));
}

function snapshotRoot(controllerHome: string, repoId: string, workId: string): string {
  const root = join(repositoryControllerRoot(controllerHome, repoId), 'verification-snapshots');
  mkdirSync(root, { recursive: true });
  const now = Date.now();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('snapshot-')) continue;
    const path = join(root, entry.name);
    try {
      if (now - statSync(path).mtimeMs > STALE_SNAPSHOT_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Best-effort stale cleanup; a fresh snapshot must not fail because an old
      // directory disappeared concurrently.
    }
  }
  return mkdtempSync(join(root, `snapshot-${sanitizeFileComponent(workId).slice(0, 48)}-`));
}

function cloneHead(sourceRoot: string, targetRoot: string, head: string): void {
  const clone = spawnSync('git', ['clone', '--shared', '--no-checkout', '--quiet', '--', sourceRoot, targetRoot], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  if (clone.status !== 0 || clone.error) {
    throw new Error(`WORK_VERIFICATION_SNAPSHOT_CLONE_FAILED: ${clone.stderr || clone.error?.message || `exit ${clone.status}`}`);
  }
  git(targetRoot, ['checkout', '--detach', '--quiet', head]);
}

function overlayPath(sourceRoot: string, targetRoot: string, relativePath: string): void {
  const source = resolve(sourceRoot, relativePath);
  const target = resolve(targetRoot, relativePath);
  rmSync(target, { recursive: true, force: true });
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    cpSync(source, target, { recursive: false, dereference: false, force: true });
    return;
  }
  cpSync(source, target, { recursive: stat.isDirectory(), dereference: false, force: true, preserveTimestamps: true });
}

function linkIgnoredNodeModules(sourceRoot: string, targetRoot: string): void {
  const source = join(sourceRoot, 'node_modules');
  const target = join(targetRoot, 'node_modules');
  if (!existsSync(source) || existsSync(target)) return;
  const ignored = spawnSync('git', ['-C', sourceRoot, 'check-ignore', '--quiet', '--', 'node_modules'], { stdio: 'ignore', timeout: 10_000 });
  if (ignored.status !== 0) return;
  try {
    symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    // Dependency linking is an optimization. If it is unavailable the check may
    // still succeed using its own toolchain resolution; never copy a huge cache.
  }
}

export function materializeWorkVerificationSnapshot(input: {
  controllerHome: string;
  repoId: string;
  sourceRoot: string;
  scope: WorkVerificationSnapshotScope;
}): WorkVerificationSnapshot {
  const sourceHead = git(input.sourceRoot, ['rev-parse', '--verify', 'HEAD']).toString('utf8').trim();
  const tracked = nulPaths(git(input.sourceRoot, ['diff', '--name-only', '-z', 'HEAD', '--']));
  const untracked = nulPaths(git(input.sourceRoot, ['ls-files', '--others', '--exclude-standard', '-z']));
  const dirtyPaths = [...new Set([...tracked, ...untracked])].sort();
  const includedPaths: string[] = [];
  const excludedPaths: string[] = [];
  for (const path of dirtyPaths) {
    if (matchesAny(input.scope.forbiddenPaths, path)) {
      excludedPaths.push(path);
      continue;
    }
    if (input.scope.allowedPaths.length > 0 && matchesAny(input.scope.allowedPaths, path)) {
      includedPaths.push(path);
      continue;
    }
    throw new Error(`WORK_VERIFICATION_PATH_OWNERSHIP_AMBIGUOUS: ${path} is dirty but is neither allowed nor forbidden for ${input.scope.workId}`);
  }

  const root = snapshotRoot(input.controllerHome, input.repoId, input.scope.workId);
  try {
    cloneHead(input.sourceRoot, root, sourceHead);
    for (const path of includedPaths) overlayPath(input.sourceRoot, root, path);
    linkIgnoredNodeModules(input.sourceRoot, root);
    const ownershipDigest = createHash('sha256').update(JSON.stringify({
      sourceHead,
      workId: input.scope.workId,
      includedPaths,
      excludedPaths,
      allowedPaths: [...input.scope.allowedPaths].sort(),
      forbiddenPaths: [...input.scope.forbiddenPaths].sort(),
    })).digest('hex');
    writeFileSync(join(root, SNAPSHOT_MARKER), `${JSON.stringify({ schemaVersion: 1, ...input.scope, sourceHead, includedPaths, excludedPaths, ownershipDigest }, null, 2)}\n`);
    return { root, sourceHead, includedPaths, excludedPaths, ownershipDigest };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupWorkVerificationSnapshot(snapshotRoot: string): void {
  rmSync(snapshotRoot, { recursive: true, force: true });
}
