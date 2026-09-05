import { randomBytes, createHash } from 'crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from 'fs';
import { dirname, join, resolve } from 'path';

export const CODEGRAPH_LEGACY_CACHE_DIR = '.codegraph';
export const CODEGRAPH_LOCATOR_PREFIX = '.codegraph-forge-';
const CODEGRAPH_LOCATOR_SCAN_BUDGET = 128;

/** Stable identity for Forge-owned CodeGraph cache placement. */
export function codegraphCacheIdentity(repoRoot: string): string {
  return createHash('sha256').update(resolve(repoRoot)).digest('hex').slice(0, 24);
}

export function codegraphCacheRoot(controllerHome: string): string {
  return join(resolve(controllerHome), 'tool-cache', 'codegraph');
}

export function codegraphRepositoryCacheRoot(controllerHome: string, repoRoot: string): string {
  return join(codegraphCacheRoot(controllerHome), codegraphCacheIdentity(repoRoot));
}

function absoluteLinkTarget(linkPath: string): string {
  const target = readlinkSync(linkPath);
  return resolve(dirname(linkPath), target);
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function touchCacheRoot(path: string): void {
  try {
    const at = new Date();
    utimesSync(path, at, at);
  } catch {
    // Cache recency is advisory. A failed touch must never make the index an authority.
  }
}

/**
 * Explicit migration boundary for the retired repo-local `.codegraph` cache.
 * A legacy Forge compatibility symlink is simply retired. A real directory is
 * copied only when the Controller Home target is empty; conflicting dual cache
 * state fails closed instead of guessing which index is newer.
 */
export function migrateLegacyCodegraphCache(repoRoot: string, controllerHome: string): string {
  const canonicalRepo = resolve(repoRoot);
  const targetRoot = codegraphRepositoryCacheRoot(controllerHome, canonicalRepo);
  const legacyRoot = join(canonicalRepo, CODEGRAPH_LEGACY_CACHE_DIR);
  mkdirSync(targetRoot, { recursive: true });
  if (!existsSync(legacyRoot)) return targetRoot;

  const stat = lstatSync(legacyRoot);
  if (stat.isSymbolicLink()) {
    if (!samePath(absoluteLinkTarget(legacyRoot), targetRoot)) {
      throw new Error(`CODEGRAPH_CACHE_LINK_MISMATCH: ${legacyRoot} -> ${readlinkSync(legacyRoot)}`);
    }
    rmSync(legacyRoot, { force: true });
    touchCacheRoot(targetRoot);
    return targetRoot;
  }
  if (!stat.isDirectory()) throw new Error(`CODEGRAPH_CACHE_PATH_INVALID: ${legacyRoot}`);
  if (readdirSync(targetRoot).length > 0) {
    throw new Error(`CODEGRAPH_CACHE_MIGRATION_CONFLICT: both ${legacyRoot} and ${targetRoot} contain cache state`);
  }
  cpSync(legacyRoot, targetRoot, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    force: false,
    errorOnExist: true,
  });
  rmSync(legacyRoot, { recursive: true, force: true });
  touchCacheRoot(targetRoot);
  return targetRoot;
}

export interface CodegraphLocatorCleanupReport {
  inspected: number;
  eligible: number;
  attempted: number;
  removed: string[];
  active: string[];
  skippedByReason: Record<string, number>;
  errors: string[];
  budgetExhausted: boolean;
}

function increment(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

/**
 * Remove only dead-process locator symlinks that still point at this repo's
 * exact Forge cache. Live PIDs and unproven paths are preserved fail-closed.
 */
export function cleanupStaleCodegraphLocators(
  repoRoot: string,
  controllerHome: string,
  maxEntries = CODEGRAPH_LOCATOR_SCAN_BUDGET,
  maxRemovals = 16,
): CodegraphLocatorCleanupReport {
  const canonicalRepo = resolve(repoRoot);
  const targetRoot = codegraphRepositoryCacheRoot(controllerHome, canonicalRepo);
  const removalLimit = Math.max(0, Math.floor(maxRemovals));
  const report: CodegraphLocatorCleanupReport = {
    inspected: 0,
    eligible: 0,
    attempted: 0,
    removed: [],
    active: [],
    skippedByReason: {},
    errors: [],
    budgetExhausted: false,
  };
  let entries;
  try {
    entries = readdirSync(canonicalRepo, { withFileTypes: true })
      .filter((entry) => String(entry.name).startsWith(CODEGRAPH_LOCATOR_PREFIX));
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    return report;
  }
  if (entries.length > maxEntries) report.budgetExhausted = true;
  for (const entry of entries.slice(0, Math.max(1, maxEntries))) {
    report.inspected += 1;
    const name = String(entry.name);
    const path = join(canonicalRepo, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isSymbolicLink()) {
        increment(report.skippedByReason, 'locator_not_symlink');
        continue;
      }
      if (!samePath(absoluteLinkTarget(path), targetRoot)) {
        increment(report.skippedByReason, 'locator_target_unproven');
        continue;
      }
      const match = /^\.codegraph-forge-(\d+)-[a-f0-9]+$/.exec(name);
      if (!match) {
        increment(report.skippedByReason, 'locator_identity_unproven');
        continue;
      }
      const pid = Number(match[1]);
      if (processAlive(pid)) {
        report.active.push(name);
        increment(report.skippedByReason, 'active_locator');
        continue;
      }
      report.eligible += 1;
      if (report.attempted >= removalLimit) {
        report.budgetExhausted = true;
        increment(report.skippedByReason, 'cleanup_budget_exhausted');
        continue;
      }
      report.attempted += 1;
      rmSync(path, { force: true });
      report.removed.push(name);
    } catch (error) {
      report.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  report.active.sort();
  report.removed.sort();
  report.errors.sort();
  return report;
}

export interface CodegraphCacheLocator {
  name: string;
  path: string;
  targetRoot: string;
  release(): void;
}

export interface CodegraphCacheLocatorOptions {
  migrateLegacy?: boolean;
  createTarget?: boolean;
}

/**
 * Create a process-scoped CODEGRAPH_DIR locator. The source tree contains only
 * a short-lived symlink; durable cache bytes remain in Controller Home.
 */
export function createCodegraphCacheLocator(
  repoRoot: string,
  controllerHome: string,
  options: CodegraphCacheLocatorOptions = {},
): CodegraphCacheLocator | null {
  const canonicalRepo = resolve(repoRoot);
  const targetRoot = codegraphRepositoryCacheRoot(controllerHome, canonicalRepo);
  if (options.migrateLegacy === true) migrateLegacyCodegraphCache(canonicalRepo, controllerHome);
  if (!existsSync(targetRoot)) {
    if (options.createTarget === false) return null;
    mkdirSync(targetRoot, { recursive: true });
  }
  cleanupStaleCodegraphLocators(canonicalRepo, controllerHome);

  let name = '';
  let path = '';
  for (let attempt = 0; attempt < 16; attempt += 1) {
    name = `${CODEGRAPH_LOCATOR_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`;
    path = join(canonicalRepo, name);
    if (!existsSync(path)) break;
    name = '';
  }
  if (!name || !path) throw new Error('CODEGRAPH_LOCATOR_ID_EXHAUSTED');
  symlinkSync(targetRoot, path, process.platform === 'win32' ? 'junction' : 'dir');
  touchCacheRoot(targetRoot);
  let released = false;
  return {
    name,
    path,
    targetRoot,
    release(): void {
      if (released) return;
      released = true;
      try {
        if (existsSync(path) && lstatSync(path).isSymbolicLink() && samePath(absoluteLinkTarget(path), targetRoot)) {
          rmSync(path, { force: true });
        }
      } finally {
        touchCacheRoot(targetRoot);
      }
    },
  };
}
