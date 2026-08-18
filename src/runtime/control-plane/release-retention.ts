import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';

const DEFAULT_RELEASE_RETENTION_GRACE_MS = 30 * 60_000;
const DEFAULT_STAGING_RETENTION_GRACE_MS = 6 * 60 * 60_000;

export interface ReleaseRetentionOptions {
  nowMs?: number;
  graceMs?: number;
  stagingGraceMs?: number;
  maxRemovals?: number;
}

export interface ReleaseRetentionReport {
  inspected: number;
  eligible: number;
  attempted: number;
  removedPaths: string[];
  retained: number;
  skipped: number;
  skippedByReason: Record<string, number>;
  errors: string[];
  budgetExhausted: boolean;
}

interface MutableRetentionState extends ReleaseRetentionReport {
  remainingRemovals: number;
}

interface RuntimeProtection {
  releasesRoot: string;
  backupsRoot: string;
  releasePaths: Set<string>;
  backupPaths: Set<string>;
  backupAuthoritySafe: boolean;
}

interface LinkedReleaseProtection {
  releasesRoot: string;
  releasePaths: Set<string>;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function directChild(root: string, path: string): boolean {
  return dirname(canonical(path)) === canonical(root);
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function errorText(scope: string, error: unknown): string {
  return `${scope}: ${error instanceof Error ? error.message : String(error)}`;
}

function increment(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function relativeHomePath(controllerHome: string, path: string): string {
  return relative(controllerHome, path).replace(/\\/g, '/');
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function releasePathFromAuthorityRecord(
  releasesRoot: string,
  record: unknown,
  label: string,
): string {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`${label} release record is missing`);
  }
  const value = record as Record<string, unknown>;
  const releaseId = typeof value.releaseId === 'string' ? value.releaseId.trim() : '';
  const manifestPath = typeof value.manifestPath === 'string' ? value.manifestPath.trim() : '';
  if (!releaseId || !manifestPath) throw new Error(`${label} release identity is incomplete`);
  const releasePath = dirname(resolve(manifestPath));
  if (basename(releasePath) !== releaseId || !directChild(releasesRoot, releasePath)) {
    throw new Error(`${label} release is outside runtime release authority`);
  }
  if (!existsSync(releasePath)) throw new Error(`${label} release directory is missing`);
  return canonical(releasePath);
}

function loadPackageConnectorReleaseProtection(controllerHome: string, releasesRoot: string): string | undefined {
  const connectorRoot = join(controllerHome, 'runtime', 'connector-service');
  if (!existsSync(connectorRoot)) return undefined;
  const authorityPath = join(connectorRoot, 'authority.json');
  if (!existsSync(authorityPath)) throw new Error('package connector release authority is missing');

  const parsed = JSON.parse(readFileSync(authorityPath, 'utf8')) as Record<string, unknown>;
  const releaseId = typeof parsed.releaseId === 'string' ? parsed.releaseId.trim() : '';
  const releaseRootValue = typeof parsed.releaseRoot === 'string' ? parsed.releaseRoot.trim() : '';
  const packageRoot = typeof parsed.packageRoot === 'string' ? parsed.packageRoot.trim() : '';
  const endpoint = typeof parsed.endpoint === 'string' ? parsed.endpoint.trim() : '';
  if (parsed.schemaVersion !== 1 || !releaseId || !releaseRootValue || !packageRoot || !endpoint) {
    throw new Error('package connector release authority is invalid');
  }
  const releaseRoot = resolve(releaseRootValue);
  if (basename(releaseRoot) !== releaseId || !directChild(releasesRoot, releaseRoot) || !existsSync(releaseRoot)) {
    throw new Error('package connector release is outside runtime release authority or missing');
  }
  return canonical(releaseRoot);
}

function loadRuntimeProtection(controllerHome: string): RuntimeProtection | undefined {
  const releasesRoot = join(controllerHome, 'runtime', 'releases');
  if (!existsSync(releasesRoot)) return undefined;
  const backupsRoot = join(releasesRoot, 'backups');
  const authorityPath = join(releasesRoot, 'authority.json');
  if (!existsSync(authorityPath)) throw new Error('runtime release authority is missing');

  const parsed = JSON.parse(readFileSync(authorityPath, 'utf8')) as Record<string, unknown>;
  if (parsed.schemaVersion !== 1 || parsed.status !== 'committed') {
    throw new Error('runtime release authority is not committed schemaVersion=1');
  }

  const releasePaths = new Set<string>();
  releasePaths.add(releasePathFromAuthorityRecord(releasesRoot, parsed.active, 'active'));
  const previous = parsed.previous;
  if (previous !== undefined) {
    releasePaths.add(releasePathFromAuthorityRecord(releasesRoot, previous, 'previous'));
  }
  const connectorRelease = loadPackageConnectorReleaseProtection(controllerHome, releasesRoot);
  if (connectorRelease) releasePaths.add(connectorRelease);

  const backupPaths = new Set<string>();
  let backupAuthoritySafe = true;
  if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
    const databaseBackup = (previous as Record<string, unknown>).databaseBackup;
    if (!databaseBackup || typeof databaseBackup !== 'object' || Array.isArray(databaseBackup)) {
      backupAuthoritySafe = false;
    } else {
      const rawPath = (databaseBackup as Record<string, unknown>).path;
      const backupPath = typeof rawPath === 'string' ? rawPath.trim() : '';
      if (!backupPath || !directChild(backupsRoot, backupPath) || !existsSync(backupPath)) {
        backupAuthoritySafe = false;
      } else {
        backupPaths.add(canonical(backupPath));
      }
    }
  }

  return {
    releasesRoot: canonical(releasesRoot),
    backupsRoot: canonical(backupsRoot),
    releasePaths,
    backupPaths,
    backupAuthoritySafe,
  };
}

function loadLinkedReleaseProtection(
  controllerHome: string,
  family: 'supervisor' | 'recovery',
): LinkedReleaseProtection | undefined {
  const familyRoot = join(controllerHome, family);
  const releasesRoot = join(familyRoot, 'releases');
  if (!existsSync(releasesRoot)) return undefined;

  const currentPath = join(familyRoot, 'current');
  if (!entryExists(currentPath)) throw new Error(`${family} current release authority is missing`);

  const releasePaths = new Set<string>();
  const current = realpathSync(currentPath);
  if (!directChild(releasesRoot, current)) {
    throw new Error(`${family} current release is outside release authority`);
  }
  releasePaths.add(canonical(current));

  const previousPath = join(familyRoot, 'previous');
  if (entryExists(previousPath)) {
    const previous = realpathSync(previousPath);
    if (!directChild(releasesRoot, previous)) {
      throw new Error(`${family} previous release is outside release authority`);
    }
    releasePaths.add(canonical(previous));
  }

  return { releasesRoot: canonical(releasesRoot), releasePaths };
}

function candidateOldEnough(path: string, nowMs: number, graceMs: number): boolean {
  return nowMs - lstatSync(path).mtimeMs >= graceMs;
}

function removeCandidate(
  controllerHome: string,
  path: string,
  recursive: boolean,
  state: MutableRetentionState,
): void {
  state.eligible += 1;
  if (state.remainingRemovals <= 0) {
    state.budgetExhausted = true;
    state.skipped += 1;
    increment(state.skippedByReason, 'cleanup_budget_exhausted');
    return;
  }

  state.remainingRemovals -= 1;
  state.attempted += 1;
  try {
    rmSync(path, { recursive, force: true });
    state.removedPaths.push(relativeHomePath(controllerHome, path));
  } catch (error) {
    state.errors.push(errorText(`release retention ${relativeHomePath(controllerHome, path)}`, error));
  }
}

function scanRuntimeReleases(
  controllerHome: string,
  state: MutableRetentionState,
  nowMs: number,
  graceMs: number,
  stagingGraceMs: number,
): void {
  let protection: RuntimeProtection | undefined;
  try {
    protection = loadRuntimeProtection(controllerHome);
  } catch (error) {
    state.errors.push(errorText('runtime release retention authority', error));
    increment(state.skippedByReason, 'authority_unavailable');
    return;
  }
  if (!protection) return;

  for (const entry of readdirSync(protection.releasesRoot, { withFileTypes: true })) {
    if (entry.name === 'backups' || entry.name === 'authority.json') continue;
    const path = join(protection.releasesRoot, entry.name);
    state.inspected += 1;

    if (!entry.isDirectory()) {
      state.skipped += 1;
      increment(state.skippedByReason, 'unknown_release_entry');
      continue;
    }

    const canonicalPath = canonical(path);
    if (protection.releasePaths.has(canonicalPath)) {
      state.retained += 1;
      increment(state.skippedByReason, 'release_authority');
      continue;
    }

    const candidateGraceMs = entry.name.startsWith('.staging-')
      ? Math.max(graceMs, stagingGraceMs)
      : graceMs;
    try {
      if (!candidateOldEnough(path, nowMs, candidateGraceMs)) {
        state.skipped += 1;
        increment(state.skippedByReason, 'retention_grace');
        continue;
      }
    } catch (error) {
      state.errors.push(errorText(`runtime release retention stat ${entry.name}`, error));
      continue;
    }

    try {
      const fresh = loadRuntimeProtection(controllerHome);
      if (!fresh) {
        state.skipped += 1;
        increment(state.skippedByReason, 'authority_unavailable');
        continue;
      }
      if (fresh.releasePaths.has(canonicalPath)) {
        state.retained += 1;
        increment(state.skippedByReason, 'release_authority_changed');
        continue;
      }
    } catch (error) {
      state.skipped += 1;
      state.errors.push(errorText('runtime release retention authority refresh', error));
      increment(state.skippedByReason, 'authority_unavailable');
      continue;
    }

    removeCandidate(controllerHome, path, true, state);
  }

  if (!existsSync(protection.backupsRoot)) return;
  if (!protection.backupAuthoritySafe) {
    state.errors.push('runtime backup retention authority: previous release backup is unavailable or invalid');
    increment(state.skippedByReason, 'backup_authority_unavailable');
    return;
  }

  for (const entry of readdirSync(protection.backupsRoot, { withFileTypes: true })) {
    const path = join(protection.backupsRoot, entry.name);
    state.inspected += 1;

    if (!entry.isFile() || !entry.name.endsWith('.sqlite')) {
      state.skipped += 1;
      increment(state.skippedByReason, 'unknown_backup_entry');
      continue;
    }

    const canonicalPath = canonical(path);
    if (protection.backupPaths.has(canonicalPath)) {
      state.retained += 1;
      increment(state.skippedByReason, 'backup_authority');
      continue;
    }

    try {
      if (!candidateOldEnough(path, nowMs, graceMs)) {
        state.skipped += 1;
        increment(state.skippedByReason, 'retention_grace');
        continue;
      }
    } catch (error) {
      state.errors.push(errorText(`runtime backup retention stat ${entry.name}`, error));
      continue;
    }

    try {
      const fresh = loadRuntimeProtection(controllerHome);
      if (!fresh || !fresh.backupAuthoritySafe) {
        state.skipped += 1;
        increment(state.skippedByReason, 'backup_authority_unavailable');
        continue;
      }
      if (fresh.backupPaths.has(canonicalPath)) {
        state.retained += 1;
        increment(state.skippedByReason, 'backup_authority_changed');
        continue;
      }
    } catch (error) {
      state.skipped += 1;
      state.errors.push(errorText('runtime backup retention authority refresh', error));
      increment(state.skippedByReason, 'authority_unavailable');
      continue;
    }

    removeCandidate(controllerHome, path, false, state);
  }
}

function scanLinkedReleaseFamily(
  controllerHome: string,
  family: 'supervisor' | 'recovery',
  state: MutableRetentionState,
  nowMs: number,
  graceMs: number
): void {
  let protection: LinkedReleaseProtection | undefined;
  try {
    protection = loadLinkedReleaseProtection(controllerHome, family);
  } catch (error) {
    state.errors.push(errorText(`${family} release retention authority`, error));
    increment(state.skippedByReason, 'authority_unavailable');
    return;
  }
  if (!protection) return;

  for (const entry of readdirSync(protection.releasesRoot, { withFileTypes: true })) {
    const path = join(protection.releasesRoot, entry.name);
    state.inspected += 1;

    if (!entry.isDirectory()) {
      state.skipped += 1;
      increment(state.skippedByReason, 'unknown_release_entry');
      continue;
    }

    const canonicalPath = canonical(path);
    if (protection.releasePaths.has(canonicalPath)) {
      state.retained += 1;
      increment(state.skippedByReason, 'release_authority');
      continue;
    }

    try {
      if (!candidateOldEnough(path, nowMs, graceMs)) {
        state.skipped += 1;
        increment(state.skippedByReason, 'retention_grace');
        continue;
      }
    } catch (error) {
      state.errors.push(errorText(`${family} release retention stat ${entry.name}`, error));
      continue;
    }

    try {
      const fresh = loadLinkedReleaseProtection(controllerHome, family);
      if (!fresh) {
        state.skipped += 1;
        increment(state.skippedByReason, 'authority_unavailable');
        continue;
      }
      if (fresh.releasePaths.has(canonicalPath)) {
        state.retained += 1;
        increment(state.skippedByReason, 'release_authority_changed');
        continue;
      }
    } catch (error) {
      state.skipped += 1;
      state.errors.push(errorText(`${family} release retention authority refresh`, error));
      increment(state.skippedByReason, 'authority_unavailable');
      continue;
    }

    removeCandidate(controllerHome, path, true, state);
  }
}

/**
 * Reclaim immutable Controller release history while preserving the exact
 * rollback authorities. Runtime keeps active + previous + the previous DB
 * backup plus the immutable release backing the persistent public MCP Gateway;
 * Recovery/Supervisor keep current + previous. Missing or malformed authority
 * always fails closed.
 */
export function cleanupControllerReleaseHistory(
  controllerHome: string,
  options: ReleaseRetentionOptions = {},
): ReleaseRetentionReport {
  const home = canonical(controllerHome);
  const nowMs = options.nowMs ?? Date.now();
  const graceMs = nonNegativeInteger(options.graceMs, DEFAULT_RELEASE_RETENTION_GRACE_MS);
  const stagingGraceMs = nonNegativeInteger(options.stagingGraceMs, DEFAULT_STAGING_RETENTION_GRACE_MS);

  const state: MutableRetentionState = {
    inspected: 0,
    eligible: 0,
    attempted: 0,
    removedPaths: [],
    retained: 0,
    skipped: 0,
    skippedByReason: {},
    errors: [],
    budgetExhausted: false,
    remainingRemovals: nonNegativeInteger(options.maxRemovals, 50),
  };

  scanRuntimeReleases(home, state, nowMs, graceMs, stagingGraceMs);
  scanLinkedReleaseFamily(home, 'supervisor', state, nowMs, graceMs);
  scanLinkedReleaseFamily(home, 'recovery', state, nowMs, graceMs);

  const { remainingRemovals: _remainingRemovals, ...report } = state;
  return {
    ...report,
    removedPaths: report.removedPaths.sort(),
    errors: report.errors.sort(),
  };
}
