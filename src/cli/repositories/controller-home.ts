import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, relative, resolve } from 'path';

export function resolveControllerHome(explicit?: string): string {
  const configured = explicit?.trim()
    || process.env.FORGE_CONTROLLER_HOME?.trim()
    || (process.env.XDG_STATE_HOME?.trim()
      ? join(process.env.XDG_STATE_HOME.trim(), 'forge', 'controller')
      : join(homedir(), '.forge', 'controller'));
  return resolve(configured);
}

/**
 * Resolve the one installed Controller Home. A repository containing a retired
 * `_ops/controller-home` is evidence for an explicit migration only; its mere
 * presence must never redirect a package Runtime, CLI, or MCP caller away from
 * the user-level authority.
 *
 * Repo-local storage remains available only through an explicit
 * `--controller-home` argument or `FORGE_CONTROLLER_HOME` configuration.
 */
export function resolveRepoPreferredControllerHome(repoRoot?: string, explicit?: string): string {
  const trimmedExplicit = explicit?.trim();
  if (trimmedExplicit) return resolveControllerHome(trimmedExplicit);
  const configured = process.env.FORGE_CONTROLLER_HOME?.trim();
  if (configured) return resolveControllerHome(configured);
  return resolveControllerHome();
}

export function repoLocalNoIndexControllerHome(
  controllerHome: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const home = resolve(controllerHome);
  if (platform !== 'darwin' || basename(home) !== 'controller-home' || basename(dirname(home)) !== '_ops') return undefined;
  return `${home}.noindex`;
}

export function ensureControllerHomeStorage(
  controllerHome: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = resolve(controllerHome);
  const physical = repoLocalNoIndexControllerHome(home, platform);
  if (!physical || existsSync(home)) return home;

  let logicalEntryExists = false;
  try { logicalEntryExists = lstatSync(home).isSymbolicLink(); } catch { /* absent */ }
  mkdirSync(physical, { recursive: true });
  if (!logicalEntryExists) {
    const target = relative(dirname(home), physical) || basename(physical);
    try {
      symlinkSync(target, home, 'dir');
    } catch (error) {
      if (!existsSync(home)) throw error;
    }
  }
  return home;
}

export interface ControllerHomeStorageMigration {
  migrated: boolean;
  logicalHome: string;
  physicalHome?: string;
}

function symlinkTargetPath(path: string): string {
  return resolve(dirname(path), readlinkSync(path));
}

export function repoLocalControllerHomeStorageNeedsMigration(
  controllerHome: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const logicalHome = resolve(controllerHome);
  const physicalHome = repoLocalNoIndexControllerHome(logicalHome, platform);
  if (!physicalHome) return false;
  let stat;
  try {
    stat = lstatSync(logicalHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    if (symlinkTargetPath(logicalHome) !== physicalHome) {
      throw new Error(`CONTROLLER_HOME_NOINDEX_SYMLINK_CONFLICT: ${logicalHome}`);
    }
    if (!existsSync(physicalHome)) {
      throw new Error(`CONTROLLER_HOME_NOINDEX_TARGET_MISSING: ${physicalHome}`);
    }
    return false;
  }
  if (!stat.isDirectory()) throw new Error(`CONTROLLER_HOME_STORAGE_UNSUPPORTED: ${logicalHome}`);
  if (existsSync(physicalHome)) throw new Error(`CONTROLLER_HOME_NOINDEX_TARGET_EXISTS: ${physicalHome}`);
  return true;
}

/** Caller must prove the Canonical Runtime is fully stopped before invoking. */
export function migrateStoppedRepoLocalControllerHomeStorage(
  controllerHome: string,
  platform: NodeJS.Platform = process.platform,
): ControllerHomeStorageMigration {
  const logicalHome = resolve(controllerHome);
  const physicalHome = repoLocalNoIndexControllerHome(logicalHome, platform);
  if (!physicalHome || !repoLocalControllerHomeStorageNeedsMigration(logicalHome, platform)) {
    return { migrated: false, logicalHome, physicalHome };
  }
  renameSync(logicalHome, physicalHome);
  try {
    const target = relative(dirname(logicalHome), physicalHome) || basename(physicalHome);
    symlinkSync(target, logicalHome, 'dir');
    if (!lstatSync(logicalHome).isSymbolicLink() || symlinkTargetPath(logicalHome) !== physicalHome || !existsSync(physicalHome)) {
      throw new Error(`CONTROLLER_HOME_NOINDEX_POSTCHECK_FAILED: ${logicalHome}`);
    }
    return { migrated: true, logicalHome, physicalHome };
  } catch (error) {
    try { rmSync(logicalHome, { force: true }); } catch { /* best effort */ }
    if (!existsSync(logicalHome) && existsSync(physicalHome)) renameSync(physicalHome, logicalHome);
    throw error;
  }
}

/** Caller must prove the Canonical Runtime is fully stopped before invoking. */
export function rollbackStoppedRepoLocalControllerHomeStorage(migration: ControllerHomeStorageMigration): void {
  if (!migration.migrated || !migration.physicalHome) return;
  const { logicalHome, physicalHome } = migration;
  const stat = lstatSync(logicalHome);
  if (!stat.isSymbolicLink() || symlinkTargetPath(logicalHome) !== physicalHome) {
    throw new Error(`CONTROLLER_HOME_NOINDEX_ROLLBACK_CONFLICT: ${logicalHome}`);
  }
  if (!existsSync(physicalHome)) throw new Error(`CONTROLLER_HOME_NOINDEX_ROLLBACK_TARGET_MISSING: ${physicalHome}`);
  rmSync(logicalHome, { force: true });
  renameSync(physicalHome, logicalHome);
}


export interface StoppedControllerHomeAuthorityRelocation {
  migrated: boolean;
  sourceHome: string;
  destinationHome: string;
  archivedDestinationHome?: string;
}

function directoryEntryExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Atomically relocate one fully stopped Controller Home to a new durable path.
 * The caller owns liveness fencing and must prove Runtime, Connector, Recovery
 * Gateway, Recovery Watchdog, and any other writers are stopped before calling.
 *
 * Existing destination contents are never merged. A caller that has already
 * proven the destination is an authority-free shell may request archival; the
 * entire shell is renamed aside so rollback can restore it byte-for-byte.
 */
export function relocateStoppedControllerHomeAuthority(input: {
  sourceHome: string;
  destinationHome: string;
  archiveExistingDestination?: boolean;
  archiveSuffix?: string;
}): StoppedControllerHomeAuthorityRelocation {
  const sourceHome = resolve(input.sourceHome);
  const destinationHome = resolve(input.destinationHome);
  if (sourceHome === destinationHome) throw new Error('CONTROLLER_HOME_RELOCATION_SAME_HOME');
  if (!directoryEntryExists(sourceHome)) throw new Error(`CONTROLLER_HOME_RELOCATION_SOURCE_MISSING: ${sourceHome}`);
  const sourceStat = lstatSync(sourceHome);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`CONTROLLER_HOME_RELOCATION_SOURCE_UNSUPPORTED: ${sourceHome}`);
  }
  mkdirSync(dirname(destinationHome), { recursive: true });

  let archivedDestinationHome: string | undefined;
  if (directoryEntryExists(destinationHome)) {
    const destinationStat = lstatSync(destinationHome);
    if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
      throw new Error(`CONTROLLER_HOME_RELOCATION_DESTINATION_UNSUPPORTED: ${destinationHome}`);
    }
    if (!input.archiveExistingDestination) {
      throw new Error(`CONTROLLER_HOME_RELOCATION_DESTINATION_EXISTS: ${destinationHome}`);
    }
    const suffix = input.archiveSuffix?.trim() || `${Date.now()}-${process.pid}`;
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(suffix)) throw new Error('CONTROLLER_HOME_RELOCATION_ARCHIVE_SUFFIX_INVALID');
    archivedDestinationHome = `${destinationHome}.pre-migration-${suffix}`;
    if (directoryEntryExists(archivedDestinationHome)) {
      throw new Error(`CONTROLLER_HOME_RELOCATION_ARCHIVE_EXISTS: ${archivedDestinationHome}`);
    }
    renameSync(destinationHome, archivedDestinationHome);
  }

  try {
    renameSync(sourceHome, destinationHome);
    if (directoryEntryExists(sourceHome) || !lstatSync(destinationHome).isDirectory()) {
      throw new Error('CONTROLLER_HOME_RELOCATION_POSTCHECK_FAILED');
    }
    return {
      migrated: true,
      sourceHome,
      destinationHome,
      ...(archivedDestinationHome ? { archivedDestinationHome } : {}),
    };
  } catch (error) {
    try {
      if (!directoryEntryExists(sourceHome) && directoryEntryExists(destinationHome)) renameSync(destinationHome, sourceHome);
      if (archivedDestinationHome && !directoryEntryExists(destinationHome) && directoryEntryExists(archivedDestinationHome)) {
        renameSync(archivedDestinationHome, destinationHome);
      }
    } catch {
      throw new Error(`CONTROLLER_HOME_RELOCATION_ROLLBACK_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  }
}

/** Caller must keep all Controller Home writers stopped until rollback completes. */
export function rollbackStoppedControllerHomeAuthorityRelocation(
  relocation: StoppedControllerHomeAuthorityRelocation,
): void {
  if (!relocation.migrated) return;
  const sourceHome = resolve(relocation.sourceHome);
  const destinationHome = resolve(relocation.destinationHome);
  const archivedDestinationHome = relocation.archivedDestinationHome ? resolve(relocation.archivedDestinationHome) : undefined;
  if (directoryEntryExists(sourceHome)) throw new Error(`CONTROLLER_HOME_RELOCATION_ROLLBACK_SOURCE_EXISTS: ${sourceHome}`);
  if (!directoryEntryExists(destinationHome) || !lstatSync(destinationHome).isDirectory()) {
    throw new Error(`CONTROLLER_HOME_RELOCATION_ROLLBACK_DESTINATION_MISSING: ${destinationHome}`);
  }
  if (archivedDestinationHome && !directoryEntryExists(archivedDestinationHome)) {
    throw new Error(`CONTROLLER_HOME_RELOCATION_ROLLBACK_ARCHIVE_MISSING: ${archivedDestinationHome}`);
  }
  renameSync(destinationHome, sourceHome);
  try {
    if (archivedDestinationHome) renameSync(archivedDestinationHome, destinationHome);
  } catch (error) {
    try { if (!directoryEntryExists(destinationHome) && directoryEntryExists(sourceHome)) renameSync(sourceHome, destinationHome); } catch { /* best effort */ }
    throw new Error(`CONTROLLER_HOME_RELOCATION_ROLLBACK_RESTORE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function ensureControllerHome(explicit?: string): string {
  const home = ensureControllerHomeStorage(resolveControllerHome(explicit));
  for (const child of ['', 'repositories', 'system', 'locks', 'indexes', 'audit', 'mcp', 'sessions', 'work-handles']) {
    mkdirSync(join(home, child), { recursive: true });
  }
  return home;
}

export function ensureRepoPreferredControllerHome(repoRoot?: string, explicit?: string): string {
  return ensureControllerHome(resolveRepoPreferredControllerHome(repoRoot, explicit));
}

export const CONTROLLER_SCOPE_REPO_ID = '__controller__';

export function controllerSystemRoot(controllerHome: string): string {
  return join(resolveControllerHome(controllerHome), 'system');
}

/** Resolve the one durable Controller Home. Runtime slot paths are not valid homes. */
export function durableControllerHome(controllerHome?: string): string {
  return resolveControllerHome(controllerHome);
}

export function repositoryControllerRoot(controllerHome: string, repoId: string): string {
  // Durable repository state lives below the one Controller Home.
  const durableHome = durableControllerHome(controllerHome);
  return repoId === CONTROLLER_SCOPE_REPO_ID
    ? controllerSystemRoot(durableHome)
    : join(resolveControllerHome(durableHome), 'repositories', repoId);
}

export function ensureRepositoryControllerLayout(controllerHome: string, repoId: string): string {
  const root = repositoryControllerRoot(controllerHome, repoId);
  for (const child of [
    '',
    'runs',
    'jobs',
    'worktrees',
    'artifacts',
    'locks',
    'indexes',
    'edit-sessions',
    'controller',
    'hook-state',
    'local-bridge',
    'ephemeral-issues',
    'work-handles',
    'results',
    'audit',
    'processes',
    'leases',
    'workflows',
    'projections',
  ]) {
    mkdirSync(join(root, child), { recursive: true });
  }
  return root;
}
