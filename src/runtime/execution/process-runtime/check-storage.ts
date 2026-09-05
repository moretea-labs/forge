import { lstatSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
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
 * repository-local `.ai/harness/checks` path or compatibility link. Existing
 * repository-local state is rejected rather than adopted, merged, or deleted.
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
  const repositoryPath = join(storage.repoRoot, '.ai', 'harness', 'checks');
  if (pathEntryExists(repositoryPath)) {
    throw new Error(`CHECK_STORAGE_REPOSITORY_PATH_FORBIDDEN: ${repositoryPath}`);
  }
  mkdirSync(storage.physicalRoot, { recursive: true });
  mkdirSync(storage.lockRoot, { recursive: true });
  return storage;
}
