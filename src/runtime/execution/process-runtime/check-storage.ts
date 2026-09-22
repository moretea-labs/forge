import { cpSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { durableControllerHome, repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { findRegisteredRepositoryByCheckoutRoot } from '../../../cli/repositories/registry';

export interface RepositoryCheckStorageAuthority {
  controllerHome: string;
  repoId: string;
}

export interface ResolvedRepositoryCheckStorage extends RepositoryCheckStorageAuthority {
  repoRoot: string;
  physicalRoot: string;
  lockRoot: string;
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && String((error as { code?: unknown }).code ?? '') === 'ENOENT');
}

function nextLegacyCheckQuarantinePath(storage: ResolvedRepositoryCheckStorage): string {
  const root = join(dirname(storage.physicalRoot), 'quarantine', 'legacy-checks');
  const stem = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  let index = 0;
  while (true) {
    const suffix = index === 0 ? stem : `${stem}-${index}`;
    const candidate = join(root, suffix);
    if (!pathEntryExists(candidate)) return candidate;
    index += 1;
  }
}

function moveLegacyCheckDirectory(source: string, target: string): void {
  try {
    renameSync(source, target);
    return;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
    if (code !== 'EXDEV') throw error;
  }
  mkdirSync(target, { recursive: true });
  try {
    cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
    rmSync(source, { recursive: true, force: true });
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Retire the pre-Controller-Home check directory only when the repository has
 * an explicit registry authority. The old bytes are moved into a bounded
 * Controller-Home quarantine so a stale project-local directory cannot block
 * the current runner and no legacy evidence is silently discarded. Unknown or
 * unregistered paths remain fail-closed because their ownership is unproven.
 */
function retireRegisteredLegacyCheckStorage(storage: ResolvedRepositoryCheckStorage): void {
  const repositoryPath = join(storage.repoRoot, '.ai', 'harness', 'checks');
  if (!pathEntryExists(repositoryPath)) return;

  const registered = findRegisteredRepositoryByCheckoutRoot(storage.repoRoot, storage.controllerHome);
  if (!registered || registered.repoId !== storage.repoId) {
    throw new Error(`CHECK_STORAGE_REPOSITORY_PATH_FORBIDDEN: ${repositoryPath}`);
  }

  let stat;
  try {
    stat = lstatSync(repositoryPath);
  } catch (error) {
    // Another Runner may have retired the directory after the existence
    // probe. Treat that interleaving as successful convergence.
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = realpathSync(repositoryPath);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw new Error(`CHECK_STORAGE_REPOSITORY_PATH_FORBIDDEN: ${repositoryPath}`);
    }
    if (target !== realpathSync(storage.physicalRoot)) {
      throw new Error(`CHECK_STORAGE_REPOSITORY_PATH_FORBIDDEN: ${repositoryPath}`);
    }
    // A retired compatibility link has no independent authority. Remove only
    // the link; the Controller-Home target remains untouched.
    try {
      unlinkSync(repositoryPath);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`CHECK_STORAGE_REPOSITORY_PATH_FORBIDDEN: ${repositoryPath}`);
  }

  let entries: string[];
  try {
    entries = readdirSync(repositoryPath);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (entries.length === 0) {
    try {
      rmSync(repositoryPath, { recursive: true, force: true });
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    return;
  }

  const quarantine = nextLegacyCheckQuarantinePath(storage);
  mkdirSync(dirname(quarantine), { recursive: true });
  try {
    moveLegacyCheckDirectory(repositoryPath, quarantine);
  } catch (error) {
    // A concurrent retire may have won the rename race. Do not turn a
    // converged Controller-Home state into a spurious check failure.
    if (isMissingPathError(error)) return;
    throw error;
  }
}

function resolveAuthority(repoRoot: string, explicit?: RepositoryCheckStorageAuthority): RepositoryCheckStorageAuthority {
  const root = resolve(repoRoot);
  if (explicit) {
    const controllerHome = durableControllerHome(explicit.controllerHome);
    const repoId = explicit.repoId.trim();
    if (!repoId) throw new Error('CHECK_STORAGE_REPOSITORY_ID_REQUIRED');
    const registered = findRegisteredRepositoryByCheckoutRoot(root, controllerHome);
    if (registered && registered.repoId !== repoId) {
      throw new Error(`CHECK_STORAGE_REPOSITORY_ID_MISMATCH: expected ${registered.repoId}, received ${repoId}`);
    }
    return { controllerHome, repoId };
  }

  const controllerHome = durableControllerHome();
  const registered = findRegisteredRepositoryByCheckoutRoot(root, controllerHome);
  if (!registered) throw new Error(`CHECK_STORAGE_REPOSITORY_AUTHORITY_REQUIRED: ${root}`);
  return { controllerHome, repoId: registered.repoId };
}

/**
 * Check/cache state is Controller-Home-owned. New execution never creates a
 * repository-local `.ai/harness/checks` path or compatibility link. Registered
 * repositories may retire old machine state into Controller-Home quarantine;
 * unknown paths remain rejected rather than adopted as a second authority.
 */
export function resolveRepositoryCheckStorage(
  repoRoot: string,
  explicit?: RepositoryCheckStorageAuthority,
): ResolvedRepositoryCheckStorage {
  const root = resolve(repoRoot);
  const authority = resolveAuthority(root, explicit);
  const physicalRoot = join(repositoryControllerRoot(authority.controllerHome, authority.repoId), 'checks');
  return {
    ...authority,
    repoRoot: root,
    physicalRoot,
    lockRoot: join(physicalRoot, 'locks'),
  };
}

export function ensureRepositoryCheckStorage(
  repoRoot: string,
  explicit?: RepositoryCheckStorageAuthority,
): ResolvedRepositoryCheckStorage {
  const storage = resolveRepositoryCheckStorage(repoRoot, explicit);
  mkdirSync(storage.physicalRoot, { recursive: true });
  retireRegisteredLegacyCheckStorage(storage);
  mkdirSync(storage.lockRoot, { recursive: true });
  return storage;
}
