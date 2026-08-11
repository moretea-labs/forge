import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanupControllerReleaseHistory } from '../../src/runtime/control-plane/release-retention';
import { cleanupControllerRuntimeState } from '../../src/runtime/control-plane/runtime-cleanup';

const homes: string[] = [];
const NOW = Date.parse('2026-08-11T10:00:00.000Z');

function controllerHome(): string {
  const value = mkdtempSync(join(tmpdir(), 'forge-release-retention-'));
  homes.push(value);
  return value;
}

function age(path: string, ageMs = 2 * 60 * 60_000): void {
  const old = new Date(NOW - ageMs);
  utimesSync(path, old, old);
}

function runtimeRelease(home: string, releaseId: string): string {
  const path = join(home, 'runtime', 'releases', releaseId);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'manifest.json'), '{}\n', 'utf8');
  return path;
}

function writeRuntimeAuthority(
  home: string,
  activeId: string,
  previousId: string | undefined,
  backupPath?: string,
): void {
  const releasesRoot = join(home, 'runtime', 'releases');
  const authority = {
    schemaVersion: 1,
    status: 'committed',
    revision: 2,
    fencingToken: 'test-token',
    active: {
      releaseId: activeId,
      manifestPath: join(releasesRoot, activeId, 'manifest.json'),
    },
    ...(previousId ? {
      previous: {
        releaseId: previousId,
        manifestPath: join(releasesRoot, previousId, 'manifest.json'),
        ...(backupPath ? { databaseBackup: { path: backupPath } } : {}),
      },
    } : {}),
    operationId: 'test',
    committedAt: new Date(NOW).toISOString(),
  };
  writeFileSync(join(releasesRoot, 'authority.json'), `${JSON.stringify(authority, null, 2)}\n`, 'utf8');
}

function linkedFamily(home: string, family: 'supervisor' | 'recovery'): {
  current: string;
  previous: string;
  stale: string;
} {
  const root = join(home, family);
  const releases = join(root, 'releases');
  const current = join(releases, 'current-release');
  const previous = join(releases, 'previous-release');
  const stale = join(releases, 'stale-release');
  mkdirSync(current, { recursive: true });
  mkdirSync(previous, { recursive: true });
  mkdirSync(stale, { recursive: true });
  symlinkSync(join('releases', 'current-release'), join(root, 'current'), 'dir');
  symlinkSync(join('releases', 'previous-release'), join(root, 'previous'), 'dir');
  age(stale);
  return { current, previous, stale };
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe('controller release retention', () => {
  test('removes stale unreferenced runtime releases and backups while preserving rollback authority', () => {
    const home = controllerHome();
    const active = runtimeRelease(home, 'active-release');
    const previous = runtimeRelease(home, 'previous-release');
    const stale = runtimeRelease(home, 'stale-release');
    const recent = runtimeRelease(home, 'recent-release');
    const staging = runtimeRelease(home, '.staging-candidate');

    const backups = join(home, 'runtime', 'releases', 'backups');
    mkdirSync(backups, { recursive: true });
    const referencedBackup = join(backups, 'referenced.sqlite');
    const staleBackup = join(backups, 'stale.sqlite');
    writeFileSync(referencedBackup, 'referenced', 'utf8');
    writeFileSync(staleBackup, 'stale', 'utf8');

    writeRuntimeAuthority(home, 'active-release', 'previous-release', referencedBackup);
    age(stale);
    age(staleBackup);
    age(staging, 2 * 60 * 60_000);

    const report = cleanupControllerReleaseHistory(home, {
      nowMs: NOW,
      graceMs: 60 * 60_000,
      stagingGraceMs: 6 * 60 * 60_000,
      maxRemovals: 20,
    });

    expect(existsSync(active)).toBe(true);
    expect(existsSync(previous)).toBe(true);
    expect(existsSync(referencedBackup)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(staleBackup)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(staging)).toBe(true);
    expect(report.removedPaths).toContain('runtime/releases/stale-release');
    expect(report.removedPaths).toContain('runtime/releases/backups/stale.sqlite');
    expect(report.skippedByReason.release_authority).toBe(2);
    expect(report.skippedByReason.backup_authority).toBe(1);
    expect(report.skippedByReason.retention_grace).toBeGreaterThanOrEqual(2);
  });

  test('preserves current and previous supervisor/recovery releases and prunes stale history', () => {
    const home = controllerHome();
    const supervisor = linkedFamily(home, 'supervisor');
    const recovery = linkedFamily(home, 'recovery');

    const report = cleanupControllerReleaseHistory(home, {
      nowMs: NOW,
      graceMs: 60 * 60_000,
      maxRemovals: 20,
    });

    expect(existsSync(supervisor.current)).toBe(true);
    expect(existsSync(supervisor.previous)).toBe(true);
    expect(existsSync(supervisor.stale)).toBe(false);
    expect(existsSync(recovery.current)).toBe(true);
    expect(existsSync(recovery.previous)).toBe(true);
    expect(existsSync(recovery.stale)).toBe(false);
    expect(report.removedPaths).toContain('supervisor/releases/stale-release');
    expect(report.removedPaths).toContain('recovery/releases/stale-release');
  });

  test('fails closed when runtime release authority is malformed', () => {
    const home = controllerHome();
    const stale = runtimeRelease(home, 'stale-release');
    age(stale);
    writeFileSync(
      join(home, 'runtime', 'releases', 'authority.json'),
      JSON.stringify({ schemaVersion: 1, status: 'draft' }),
      'utf8',
    );

    const report = cleanupControllerReleaseHistory(home, {
      nowMs: NOW,
      graceMs: 0,
      maxRemovals: 20,
    });

    expect(existsSync(stale)).toBe(true);
    expect(report.removedPaths).toEqual([]);
    expect(report.errors.some((entry) => entry.includes('runtime release retention authority'))).toBe(true);
    expect(report.skippedByReason.authority_unavailable).toBe(1);
  });

  test('shares a bounded removal budget across release families', () => {
    const home = controllerHome();
    runtimeRelease(home, 'active-release');
    runtimeRelease(home, 'previous-release');
    const staleA = runtimeRelease(home, 'stale-a');
    const staleB = runtimeRelease(home, 'stale-b');
    const backups = join(home, 'runtime', 'releases', 'backups');
    mkdirSync(backups, { recursive: true });
    const referencedBackup = join(backups, 'referenced.sqlite');
    writeFileSync(referencedBackup, 'referenced', 'utf8');
    writeRuntimeAuthority(home, 'active-release', 'previous-release', referencedBackup);
    age(staleA);
    age(staleB);

    const report = cleanupControllerReleaseHistory(home, {
      nowMs: NOW,
      graceMs: 0,
      maxRemovals: 1,
    });

    expect([staleA, staleB].filter((path) => existsSync(path))).toHaveLength(1);
    expect(report.removedPaths).toHaveLength(1);
    expect(report.budgetExhausted).toBe(true);
    expect(report.skippedByReason.cleanup_budget_exhausted).toBeGreaterThanOrEqual(1);
  });
});


describe('runtime cleanup release integration', () => {
  test('periodic cleanup consumes remaining cycle budget to prune release history', () => {
    const home = controllerHome();
    runtimeRelease(home, 'active-release');
    runtimeRelease(home, 'previous-release');
    const stale = runtimeRelease(home, 'stale-release');
    const backups = join(home, 'runtime', 'releases', 'backups');
    mkdirSync(backups, { recursive: true });
    const referencedBackup = join(backups, 'referenced.sqlite');
    writeFileSync(referencedBackup, 'referenced', 'utf8');
    writeRuntimeAuthority(home, 'active-release', 'previous-release', referencedBackup);
    age(stale);

    const report = cleanupControllerRuntimeState(home, {
      reason: 'periodic',
      nowMs: NOW,
      maxEntries: 100,
      maxRemovals: 10,
      releaseRetentionGraceMs: 0,
      stagingReleaseRetentionGraceMs: 0,
      inspectProcess: () => ({ alive: false }),
    });

    expect(existsSync(stale)).toBe(false);
    expect(report.removedReleasePaths).toContain('runtime/releases/stale-release');
    expect(report.cycle.removed).toBeGreaterThanOrEqual(1);
  });
});


