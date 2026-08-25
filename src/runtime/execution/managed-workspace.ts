import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import type { RepositoryRecord } from '../../cli/repositories/types';
import {
  addRepositoryCheckout,
  listRepositories,
  repositoryCheckoutRootMatches,
  selectRepositoryCheckout,
} from '../../cli/repositories/registry';
import { managedWorktreePath } from '../../cli/repositories/worktree-storage';
import { branchSlugSegment, validateBranchName } from '../../cli/repositories/branch-name-policy';
import { withControllerLock } from '../../cli/repositories/locks';
import { resolveGitExecutable } from '../../effects/git-executable';
import { runProcess } from '../../effects/process-runner';
import { repositoryChildProcessEnvironment, resolveBunExecutable } from '../shared/process-environment';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';

export interface EnsureManagedWorkspaceInput {
  requestId: string;
  title: string;
  baseRef?: string;
  branchName?: string;
  /** Explicitly materialize lockfile-backed Node dependencies in this isolated worktree. */
  prepareDependencies?: boolean;
}

export interface ManagedWorkspaceDependencyBootstrap {
  packageManager: 'bun' | 'pnpm' | 'npm' | 'yarn';
  lockfile: string;
  command: string[];
}

export interface ManagedWorkspaceDependencyPreparation {
  mode: 'already_ready' | 'canonical_reuse' | 'installed';
  nodeModulesRoot: string;
  canonicalRoot?: string;
}

export interface ManagedWorkspaceDependencies {
  materializeDependencies?: (workspaceRoot: string) => void;
}

export interface ManagedWorkspace {
  mode: 'current' | 'isolated';
  checkoutId?: string;
  root?: string;
  branch?: string | null;
  baseRevision?: string | null;
  managed: boolean;
}

interface ManagedWorkspaceManifest {
  schemaVersion: 1;
  repoId: string;
  requestId: string;
  branch: string;
  path: string;
  baseRevision: string;
  createdAt: string;
}

function suffix(repoId: string, requestId: string): string {
  return createHash('sha256').update(`${repoId}:${requestId}`).digest('hex').slice(0, 12);
}

function git(root: string, args: string[], timeoutMs = 30_000): string {
  const result = runProcess(resolveGitExecutable(), ['-C', root, ...args], {
    timeoutMs,
    maxOutputBytes: 64 * 1024,
  });
  if (!result.ok) {
    const detail = result.stderr || result.error || `exit ${result.status}`;
    throw new Error(`MANAGED_WORKSPACE_GIT_FAILED: git ${args.join(' ')}: ${detail}`);
  }
  return result.stdout.trim();
}

function gitSucceeds(root: string, args: string[]): boolean {
  return runProcess(resolveGitExecutable(), ['-C', root, ...args], {
    timeoutMs: 15_000,
    maxOutputBytes: 8 * 1024,
  }).ok;
}

function assertBranch(root: string, branch: string): string {
  const normalized = validateBranchName(branch, { purpose: 'MANAGED_WORKSPACE_BRANCH' });
  if (!gitSucceeds(root, ['check-ref-format', '--branch', normalized])) {
    throw new Error(`MANAGED_WORKSPACE_BRANCH_INVALID: ${normalized}`);
  }
  return normalized;
}

export function managedWorkspaceDependencyBootstrap(repoRoot: string): ManagedWorkspaceDependencyBootstrap | undefined {
  if (!existsSync(join(repoRoot, 'package.json')) || existsSync(join(repoRoot, 'node_modules'))) return undefined;
  const lockCandidates = [
    ['bun', 'bun.lock', ['bun', 'install', '--frozen-lockfile']],
    ['bun', 'bun.lockb', ['bun', 'install', '--frozen-lockfile']],
    ['pnpm', 'pnpm-lock.yaml', ['pnpm', 'install', '--frozen-lockfile']],
    ['npm', 'package-lock.json', ['npm', 'ci']],
    ['yarn', 'yarn.lock', ['yarn', 'install', '--frozen-lockfile']],
  ] as const;
  const detected = lockCandidates.find(([, lockfile]) => existsSync(join(repoRoot, lockfile)));
  if (!detected) return undefined;
  return { packageManager: detected[0], lockfile: detected[1], command: [...detected[2]] };
}

const DEPENDENCY_REUSE_CONFIG_PATHS = [
  '.npmrc',
  'bunfig.toml',
  'pnpm-workspace.yaml',
  '.yarnrc.yml',
] as const;

function dependencyInputMatches(leftRoot: string, rightRoot: string, path: string): boolean {
  const left = join(leftRoot, path);
  const right = join(rightRoot, path);
  const leftExists = existsSync(left);
  const rightExists = existsSync(right);
  if (leftExists !== rightExists) return false;
  return !leftExists || readFileSync(left).equals(readFileSync(right));
}

function linkedWorkspaceCanonicalRoot(repoRoot: string): string | undefined {
  const common = runProcess(resolveGitExecutable(), ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    timeoutMs: 15_000,
    maxOutputBytes: 8 * 1024,
  });
  if (!common.ok || !common.stdout.trim()) return undefined;
  const canonicalRoot = dirname(resolve(common.stdout.trim()));
  if (!existsSync(canonicalRoot)) return undefined;
  try {
    if (realpathSync(canonicalRoot) === realpathSync(repoRoot)) return undefined;
  } catch {
    return undefined;
  }
  const topLevel = runProcess(resolveGitExecutable(), ['-C', canonicalRoot, 'rev-parse', '--show-toplevel'], {
    timeoutMs: 15_000,
    maxOutputBytes: 8 * 1024,
  });
  if (!topLevel.ok || !topLevel.stdout.trim()) return undefined;
  try {
    return realpathSync(topLevel.stdout.trim()) === realpathSync(canonicalRoot) ? canonicalRoot : undefined;
  } catch {
    return undefined;
  }
}

export function resolveManagedWorkspaceCanonicalDependencies(repoRoot: string): {
  canonicalRoot: string;
  nodeModulesRoot: string;
} | undefined {
  const bootstrap = managedWorkspaceDependencyBootstrap(repoRoot);
  if (!bootstrap) return undefined;
  const canonicalRoot = linkedWorkspaceCanonicalRoot(repoRoot);
  if (!canonicalRoot) return undefined;
  const nodeModulesRoot = join(canonicalRoot, 'node_modules');
  if (!existsSync(nodeModulesRoot)) return undefined;
  const dependencyInputs = ['package.json', bootstrap.lockfile, ...DEPENDENCY_REUSE_CONFIG_PATHS];
  if (!dependencyInputs.every((path) => dependencyInputMatches(repoRoot, canonicalRoot, path))) return undefined;
  return { canonicalRoot, nodeModulesRoot: realpathSync(nodeModulesRoot) };
}

function packageManifestRequiresDependencyMaterialization(repoRoot: string): boolean {
  const packagePath = join(repoRoot, 'package.json');
  if (!existsSync(packagePath)) return false;
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
    manifest = parsed as Record<string, unknown>;
  } catch {
    // Preserve fail-closed dependency preparation for malformed manifests. The
    // package manager remains the authority for the concrete parse error once a
    // supported frozen lockfile is present.
    return true;
  }

  const dependencyFields = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundleDependencies',
    'bundledDependencies',
  ] as const;
  if (dependencyFields.some((field) => {
    const value = manifest[field];
    return Array.isArray(value)
      ? value.length > 0
      : Boolean(value && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length > 0);
  })) return true;

  const workspaces = manifest.workspaces;
  if (Array.isArray(workspaces)) return workspaces.length > 0;
  if (workspaces && typeof workspaces === 'object') {
    const packages = (workspaces as Record<string, unknown>).packages;
    if (Array.isArray(packages)) return packages.length > 0;
    return Object.keys(workspaces as Record<string, unknown>).length > 0;
  }
  return false;
}

function reuseManagedWorkspaceCanonicalDependencies(repoRoot: string): ManagedWorkspaceDependencyPreparation | undefined {
  const nodeModulesRoot = join(repoRoot, 'node_modules');
  const reusable = resolveManagedWorkspaceCanonicalDependencies(repoRoot);
  if (!reusable) return undefined;
  try {
    symlinkSync(reusable.nodeModulesRoot, nodeModulesRoot, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!existsSync(nodeModulesRoot)) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`MANAGED_WORKSPACE_DEPENDENCY_REUSE_FAILED: ${detail}`);
    }
  }
  return {
    mode: 'canonical_reuse',
    nodeModulesRoot: realpathSync(nodeModulesRoot),
    canonicalRoot: reusable.canonicalRoot,
  };
}

export function materializeManagedWorkspaceDependencies(repoRoot: string): ManagedWorkspaceDependencyPreparation | undefined {
  if (!existsSync(join(repoRoot, 'package.json'))) return undefined;
  const nodeModulesRoot = join(repoRoot, 'node_modules');
  if (existsSync(nodeModulesRoot)) {
    return { mode: 'already_ready', nodeModulesRoot: realpathSync(nodeModulesRoot) };
  }
  // A linked worktree may safely reuse canonical dependencies even when the
  // package manifest itself declares no dependencies. The supported lockfile
  // and dependency-reuse inputs remain the authority for proving equivalence.
  const reused = reuseManagedWorkspaceCanonicalDependencies(repoRoot);
  if (reused) return reused;
  // A package manifest can define dependency-free scripts (for example a
  // built-in `node -e` check). Such checks do not need node_modules and must not
  // be rejected merely because the repository intentionally has no lockfile.
  if (!packageManifestRequiresDependencyMaterialization(repoRoot)) return undefined;
  const bootstrap = managedWorkspaceDependencyBootstrap(repoRoot);
  if (!bootstrap) {
    throw new Error('MANAGED_WORKSPACE_DEPENDENCY_LOCK_REQUIRED: package.json declares dependencies but no supported lockfile was found');
  }
  const childEnv = repositoryChildProcessEnvironment();
  const executable = bootstrap.packageManager === 'bun'
    ? resolveBunExecutable(process.execPath, childEnv)
    : bootstrap.command[0]!;
  const result = runProcess(executable, bootstrap.command.slice(1), {
    cwd: repoRoot,
    env: childEnv,
    timeoutMs: 10 * 60_000,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (!result.ok) {
    const detail = result.stderr || result.error || `exit ${result.status}`;
    throw new Error(`MANAGED_WORKSPACE_DEPENDENCY_INSTALL_FAILED: ${bootstrap.command.join(' ')}: ${detail}`);
  }
  if (!existsSync(nodeModulesRoot)) {
    throw new Error(`MANAGED_WORKSPACE_DEPENDENCY_INSTALL_INCOMPLETE: ${bootstrap.command.join(' ')} completed without node_modules`);
  }
  return { mode: 'installed', nodeModulesRoot: realpathSync(nodeModulesRoot) };
}

export function materializeManagedWorkspaceCheckDependencies(repoRoot: string): ManagedWorkspaceDependencyPreparation | undefined {
  if (!existsSync(join(repoRoot, 'package.json')) || existsSync(join(repoRoot, 'node_modules'))) return undefined;
  if (!linkedWorkspaceCanonicalRoot(repoRoot)) return undefined;
  return materializeManagedWorkspaceDependencies(repoRoot);
}

function existingWorkspace(path: string, branch: string): boolean {
  if (!existsSync(path)) return false;
  const root = runProcess(resolveGitExecutable(), ['-C', path, 'rev-parse', '--show-toplevel'], {
    timeoutMs: 15_000,
    maxOutputBytes: 8 * 1024,
  });
  if (!root.ok) throw new Error(`MANAGED_WORKSPACE_PATH_OCCUPIED: ${path}`);
  if (realpathSync(root.stdout.trim()) !== realpathSync(path)) {
    throw new Error(`MANAGED_WORKSPACE_PATH_MISMATCH: ${path}`);
  }
  const currentBranch = git(path, ['branch', '--show-current']);
  if (currentBranch !== branch) {
    throw new Error(`MANAGED_WORKSPACE_BRANCH_MISMATCH: expected ${branch}, found ${currentBranch || 'detached'}`);
  }
  return true;
}

function manifestPath(controllerHome: string, repoId: string, identity: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'managed-workspaces', `${identity}.json`);
}

export function currentManagedWorkspace(repository: RepositoryRecord): ManagedWorkspace {
  return {
    mode: 'current',
    checkoutId: repository.activeCheckoutId,
    root: repository.canonicalRoot,
    branch: git(repository.canonicalRoot, ['branch', '--show-current']) || null,
    baseRevision: git(repository.canonicalRoot, ['rev-parse', 'HEAD']),
    managed: false,
  };
}

export function ensureManagedWorkspace(
  controllerHome: string,
  repository: RepositoryRecord,
  input: EnsureManagedWorkspaceInput,
  dependencies: ManagedWorkspaceDependencies = {},
): ManagedWorkspace {
  const requestId = input.requestId.trim();
  if (!requestId) throw new Error('MANAGED_WORKSPACE_REQUEST_ID_REQUIRED');
  const identity = suffix(repository.repoId, requestId);
  const sourceRoot = repository.canonicalRoot;
  const requestedBranch = assertBranch(
    sourceRoot,
    input.branchName?.trim() || `work/${branchSlugSegment(input.title)}-${identity}`,
  );
  const requestedBaseRef = input.baseRef?.trim() || 'HEAD';
  const requestedPath = managedWorktreePath(
    controllerHome,
    repository.repoId,
    `work-${identity}`,
    listRepositories(controllerHome, { includeRemoved: true }),
  );
  const statePath = manifestPath(controllerHome, repository.repoId, identity);

  return withControllerLock(
    controllerHome,
    { scope: 'worktree', repoId: repository.repoId, worktreeId: `work-${identity}` },
    `ensure-managed-workspace:${requestId}`,
    () => {
      const manifest = existsSync(statePath) ? readJsonFile<ManagedWorkspaceManifest>(statePath) : undefined;
      if (manifest && (
        manifest.repoId !== repository.repoId
        || manifest.requestId !== requestId
        || manifest.branch !== requestedBranch
      )) {
        throw new Error(`MANAGED_WORKSPACE_REQUEST_CONFLICT: ${requestId}`);
      }
      const branch = manifest?.branch ?? requestedBranch;
      // Persisted manifests are authoritative evidence; never move an active worktree in place.
      const path = manifest?.path ? resolve(manifest.path) : requestedPath;
      const baseRevision = manifest?.baseRevision ?? git(sourceRoot, ['rev-parse', '--verify', `${requestedBaseRef}^{commit}`]);

      if (!existingWorkspace(path, branch)) {
        mkdirSync(dirname(path), { recursive: true });
        const branchExists = gitSucceeds(sourceRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
        if (branchExists) {
          // A daemon crash may leave stale worktree administration behind even after the directory is gone.
          git(sourceRoot, ['worktree', 'prune', '--expire', 'now'], 120_000);
          git(sourceRoot, ['worktree', 'add', path, branch], 120_000);
        } else {
          git(sourceRoot, ['worktree', 'add', '-b', branch, path, baseRevision], 120_000);
        }
      }
      if (!repositoryCheckoutRootMatches(repository, path)) {
        throw new Error(`MANAGED_WORKSPACE_REPOSITORY_MISMATCH: ${path}`);
      }
      if (input.prepareDependencies === true) {
        (dependencies.materializeDependencies ?? materializeManagedWorkspaceDependencies)(path);
      } else {
        // Reusing a byte-equivalent canonical dependency tree is cheap and
        // deterministic, so isolated Work checkouts should get it even when a
        // full package-manager install was not explicitly requested.
        reuseManagedWorkspaceCanonicalDependencies(path);
      }

      const record = addRepositoryCheckout({
        repoId: repository.repoId,
        path,
        controllerHome,
        activate: false,
      });
      const canonicalWorkspacePath = realpathSync(path);
      const checkout = record.checkouts.find((candidate) =>
        existsSync(candidate.canonicalRoot)
        && realpathSync(candidate.canonicalRoot) === canonicalWorkspacePath,
      );
      if (!checkout) throw new Error(`MANAGED_WORKSPACE_CHECKOUT_NOT_REGISTERED: ${path}`);
      const selected = selectRepositoryCheckout(record, checkout.checkoutId);
      if (!manifest) {
        writeJsonAtomic(statePath, {
          schemaVersion: 1,
          repoId: repository.repoId,
          requestId,
          branch,
          path: selected.canonicalRoot,
          baseRevision,
          createdAt: new Date().toISOString(),
        } satisfies ManagedWorkspaceManifest);
      }
      return {
        mode: 'isolated',
        checkoutId: checkout.checkoutId,
        root: selected.canonicalRoot,
        branch,
        baseRevision,
        managed: true,
      } satisfies ManagedWorkspace;
    },
    120_000,
  );
}
