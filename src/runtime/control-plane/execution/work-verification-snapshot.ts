import { createHash } from 'crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { spawnSync } from 'child_process';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { globMatches, normalizeMcpRelativePath } from '../../../cli/mcp/paths';
import { sanitizeFileComponent } from '../../shared/json-files';

const STALE_SNAPSHOT_MS = 6 * 60 * 60_000;
const SNAPSHOT_MARKER = '.ai/harness/controller/work-verification-snapshot.json';

export interface WorkVerificationSnapshotScope {
  workId: string;
  allowedPaths: readonly string[];
  forbiddenPaths: readonly string[];
}

export interface WorkVerificationSnapshot {
  root: string;
  /** Ephemeral Controller Home visible only to Candidate verification children. */
  isolatedControllerHome: string;
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

function normalizeTrackedSnapshotModes(sourceRoot: string, targetRoot: string): void {
  for (const relativePath of nulPaths(git(sourceRoot, ['ls-files', '-z']))) {
    const source = resolve(sourceRoot, relativePath);
    const target = resolve(targetRoot, relativePath);
    try {
      const sourceStat = lstatSync(source);
      const targetStat = lstatSync(target);
      if (!sourceStat.isFile() || !targetStat.isFile()) continue;
      // Git tracks only the executable bit for regular files. A checkout
      // created under umask=0002 otherwise materializes 0664/0775 and makes
      // exact-mode gates depend on the Runtime process umask. Canonicalize the
      // untracked permission bits while preserving the Work's current
      // executable semantics (including an uncommitted chmod +/-x).
      chmodSync(target, (sourceStat.mode & 0o111) !== 0 ? 0o755 : 0o644);
    } catch {
      // Deleted paths, symlinks, and concurrently disappearing files are
      // handled by the normal overlay/deletion path and are not regular files.
    }
  }
}

function pruneEmptySnapshotParents(targetRoot: string, targetPath: string): void {
  const boundary = resolve(targetRoot);
  let current = dirname(resolve(targetPath));
  while (current !== boundary) {
    try {
      if (readdirSync(current).length > 0) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function overlayPath(sourceRoot: string, targetRoot: string, relativePath: string): void {
  const source = resolve(sourceRoot, relativePath);
  const target = resolve(targetRoot, relativePath);
  rmSync(target, { recursive: true, force: true });
  if (!existsSync(source)) {
    pruneEmptySnapshotParents(targetRoot, target);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    cpSync(source, target, { recursive: false, dereference: false, force: true });
    return;
  }
  cpSync(source, target, { recursive: stat.isDirectory(), dereference: false, force: true, preserveTimestamps: true });
}

const DEPENDENCY_LOCK_FILES = ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'] as const;
const DEPENDENCY_CONFIG_FILES = ['pnpm-workspace.yaml', 'bunfig.toml', '.npmrc', '.yarnrc.yml'] as const;
const DEPENDENCY_METADATA_NAMES = ['package.json', ...DEPENDENCY_LOCK_FILES, ...DEPENDENCY_CONFIG_FILES] as const;

function isDependencyMetadataPath(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return DEPENDENCY_METADATA_NAMES.some((candidate) => candidate === name);
}

function hasUntrackedDependencyMetadata(root: string): boolean {
  return nulPaths(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).some(isDependencyMetadataPath);
}

function dependencyMetadataDigest(root: string): string | undefined {
  if (!existsSync(join(root, 'package.json'))) return undefined;
  const rootLock = DEPENDENCY_LOCK_FILES.find((name) => existsSync(join(root, name)));
  if (!rootLock) return undefined;
  const pathspecs = DEPENDENCY_METADATA_NAMES.flatMap((name) => [name, `:(glob)**/${name}`]);
  const tracked = nulPaths(git(root, ['ls-files', '-z', '--', ...pathspecs]));
  const files = [...new Set(tracked)].sort();
  if (!files.includes('package.json') || !files.includes(rootLock)) return undefined;
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(join(root, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function primaryWorktreeRoot(sourceRoot: string): string | undefined {
  const commonDirValue = git(sourceRoot, ['rev-parse', '--git-common-dir']).toString('utf8').trim();
  if (!commonDirValue) return undefined;
  const commonDir = resolve(sourceRoot, commonDirValue);
  const candidate = dirname(commonDir);
  if (resolve(candidate) === resolve(sourceRoot)) return undefined;
  if (!existsSync(join(candidate, '.git'))) return undefined;
  return candidate;
}

function isManagedWorktreeDependencyLink(sourceRoot: string, path: string): boolean {
  if (path !== 'node_modules') return false;
  const candidate = join(sourceRoot, path);
  try {
    if (!lstatSync(candidate).isSymbolicLink()) return false;
    const primaryRoot = primaryWorktreeRoot(sourceRoot);
    if (!primaryRoot) return false;
    const primaryNodeModules = join(primaryRoot, 'node_modules');
    if (!existsSync(primaryNodeModules)) return false;
    return realpathSync(candidate) === realpathSync(primaryNodeModules);
  } catch {
    return false;
  }
}

function isControllerHomeRuntimeBindingLink(
  sourceRoot: string,
  controllerHome: string,
  repoId: string,
  path: string,
): boolean {
  if (!path.startsWith('.ai/harness/') && !path.startsWith('.forge/')) return false;
  const candidate = join(sourceRoot, path);
  try {
    if (!lstatSync(candidate).isSymbolicLink()) return false;
    const controllerRoot = realpathSync(repositoryControllerRoot(controllerHome, repoId));
    const target = realpathSync(candidate);
    return target === controllerRoot || target.startsWith(`${controllerRoot}${sep}`);
  } catch {
    return false;
  }
}

function linkIgnoredNodeModules(sourceRoot: string, targetRoot: string, dirtyPaths: readonly string[]): void {
  let source = join(sourceRoot, 'node_modules');
  const target = join(targetRoot, 'node_modules');
  if (existsSync(target)) return;
  if (!existsSync(source)) {
    if (dirtyPaths.some(isDependencyMetadataPath)) return;
    const primaryRoot = primaryWorktreeRoot(sourceRoot);
    if (!primaryRoot) return;
    const primaryNodeModules = join(primaryRoot, 'node_modules');
    if (!existsSync(primaryNodeModules) || hasUntrackedDependencyMetadata(primaryRoot)) return;
    const sourceDigest = dependencyMetadataDigest(sourceRoot);
    const primaryDigest = dependencyMetadataDigest(primaryRoot);
    if (!sourceDigest || sourceDigest !== primaryDigest) return;
    source = primaryNodeModules;
  }
  // An existing managed-worktree node_modules may itself be a symlink. Git
  // rejects child pathspecs through symlinks, while an absent node_modules
  // needs a virtual child path so directory-only ignore rules still match.
  const managedDependencyLink = isManagedWorktreeDependencyLink(sourceRoot, 'node_modules');
  const ignoreProbe = existsSync(join(sourceRoot, 'node_modules'))
    ? 'node_modules'
    : 'node_modules/.forge-verification-probe';
  const ignored = managedDependencyLink
    ? true
    : spawnSync('git', ['-C', sourceRoot, 'check-ignore', '--quiet', '--', ignoreProbe], { stdio: 'ignore', timeout: 10_000 }).status === 0;
  if (!ignored) return;
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
  const untracked = nulPaths(git(input.sourceRoot, ['ls-files', '--others', '--exclude-standard', '-z']))
    .filter((path) => !isManagedWorktreeDependencyLink(input.sourceRoot, path))
    .filter((path) => !isControllerHomeRuntimeBindingLink(input.sourceRoot, input.controllerHome, input.repoId, path));
  const dirtyPaths = [...new Set([...tracked, ...untracked])].sort();
  const includedPaths: string[] = [];
  const excludedPaths: string[] = [];
  for (const path of dirtyPaths) {
    if (matchesAny(input.scope.forbiddenPaths, path)) {
      excludedPaths.push(path);
      continue;
    }
    if (input.scope.allowedPaths.length === 0 || matchesAny(input.scope.allowedPaths, path)) {
      includedPaths.push(path);
      continue;
    }
    throw new Error(`WORK_VERIFICATION_PATH_OWNERSHIP_AMBIGUOUS: ${path} is dirty but is outside the allowed path fence for ${input.scope.workId}`);
  }

  const root = snapshotRoot(input.controllerHome, input.repoId, input.scope.workId);
  try {
    cloneHead(input.sourceRoot, root, sourceHead);
    normalizeTrackedSnapshotModes(input.sourceRoot, root);
    for (const path of includedPaths) overlayPath(input.sourceRoot, root, path);
    // Overlay copies may reintroduce umask-derived group-write bits from the
    // source Worktree, so normalize tracked regular files again afterwards.
    normalizeTrackedSnapshotModes(input.sourceRoot, root);
    linkIgnoredNodeModules(input.sourceRoot, root, dirtyPaths);
    const ownershipDigest = createHash('sha256').update(JSON.stringify({
      sourceHead,
      workId: input.scope.workId,
      includedPaths,
      excludedPaths,
      allowedPaths: [...input.scope.allowedPaths].sort(),
      forbiddenPaths: [...input.scope.forbiddenPaths].sort(),
    })).digest('hex');
    const isolatedControllerHome = join(root, '.git', 'forge-candidate-controller');
    mkdirSync(isolatedControllerHome, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(join(root, SNAPSHOT_MARKER)), { recursive: true });
    writeFileSync(join(root, SNAPSHOT_MARKER), `${JSON.stringify({ schemaVersion: 1, ...input.scope, sourceHead, includedPaths, excludedPaths, ownershipDigest }, null, 2)}\n`);
    return { root, isolatedControllerHome, sourceHead, includedPaths, excludedPaths, ownershipDigest };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupWorkVerificationSnapshot(snapshotRoot: string): void {
  rmSync(snapshotRoot, { recursive: true, force: true });
}
