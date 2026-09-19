import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanupControllerReleaseHistory } from '../../src/runtime/control-plane/release-retention';
import { cleanupControllerRuntimeState } from '../../src/runtime/control-plane/runtime-cleanup';
import { backupControlPlaneDatabase, inspectControlPlaneDatabase } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { forgeRuntimeServicePaths, writeForgeRuntimeServiceConfig } from '../../src/runtime/root/service';

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

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeRecoverableKnownGood(home: string, releaseId: string): string {
  inspectControlPlaneDatabase(home);
  const releaseRoot = join(home, 'runtime', 'releases', releaseId);
  mkdirSync(releaseRoot, { recursive: true });
  const manifestPath = join(releaseRoot, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    releaseId,
    artifactIdentity: `artifact-${releaseId}`,
    entrypoint: 'forge-runtime',
    arguments: [],
    configurationSchemaVersion: 1,
    controllerHome: home,
    databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
    workerProtocolVersion: 1,
    createdAt: new Date(NOW).toISOString(),
  }, null, 2)}\n`);
  const repositoryRoot = join(home, 'source');
  const authTokenFile = join(home, 'mcp', 'runtime-token');
  mkdirSync(repositoryRoot, { recursive: true });
  mkdirSync(join(home, 'mcp'), { recursive: true });
  writeFileSync(authTokenFile, 'test-token\n');
  const service = writeForgeRuntimeServiceConfig({
    schemaVersion: 1,
    controllerHome: home,
    repositoryRoot,
    host: '127.0.0.1',
    port: 8765,
    authTokenFile,
  });
  const bundleRoot = join(home, 'recovery', 'bundles', 'known-good', 'attestation-retention-test');
  const databasePath = join(bundleRoot, 'controller.sqlite');
  const database = backupControlPlaneDatabase(home, databasePath);
  const serviceContractPath = join(bundleRoot, 'service-contract.json');
  writeFileSync(serviceContractPath, `${JSON.stringify({
    schemaVersion: 1,
    configPath: forgeRuntimeServicePaths(home).configPath,
    serviceConfig: service.config,
  }, null, 2)}\n`);
  mkdirSync(join(home, 'recovery', 'state'), { recursive: true });
  writeFileSync(join(home, 'recovery', 'state', 'known-good.json'), `${JSON.stringify({
    schemaVersion: 2,
    releases: [{
      path: manifestPath,
      revision: releaseId,
      artifactIdentity: `artifact-${releaseId}`,
      manifestSha256: sha256(manifestPath),
      workerProtocolVersion: 1,
      controllerHome: home,
      recoveryBundle: {
        schemaVersion: 1,
        attestationId: 'attestation-retention-test',
        root: bundleRoot,
        database: {
          path: databasePath,
          sha256: sha256(databasePath),
          schemaVersion: database.schemaVersion,
          recordCount: database.recordCount,
          auditEventCount: database.auditEventCount,
        },
        serviceContract: { path: serviceContractPath, sha256: sha256(serviceContractPath) },
        createdAt: new Date(NOW).toISOString(),
      },
    }],
    updatedAt: new Date(NOW).toISOString(),
  }, null, 2)}\n`);
  return releaseRoot;
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

  test('keeps recovery known-good as historical evidence without pinning old runtime release artifacts', () => {
    const home = controllerHome();
    const active = runtimeRelease(home, 'active-release');
    const previous = runtimeRelease(home, 'previous-release');
    const knownGood = runtimeRelease(home, 'known-good-release');
    const stale = runtimeRelease(home, 'stale-release');
    const backups = join(home, 'runtime', 'releases', 'backups');
    mkdirSync(backups, { recursive: true });
    const referencedBackup = join(backups, 'referenced.sqlite');
    writeFileSync(referencedBackup, 'referenced', 'utf8');
    writeRuntimeAuthority(home, 'active-release', 'previous-release', referencedBackup);
    mkdirSync(join(home, 'recovery', 'state'), { recursive: true });
    writeFileSync(join(home, 'recovery', 'state', 'known-good.json'), `${JSON.stringify({
      schemaVersion: 1,
      releases: [
        { revision: 'known-good-release', path: join(knownGood, 'manifest.json') },
        { revision: 'already-pruned-release', path: join(home, 'runtime', 'releases', 'already-pruned-release', 'manifest.json') },
      ],
    }, null, 2)}\n`, 'utf8');
    age(knownGood);
    age(stale);

    const report = cleanupControllerReleaseHistory(home, {
      nowMs: NOW,
      graceMs: 0,
      maxRemovals: 20,
    });

    expect(existsSync(active)).toBe(true);
    expect(existsSync(previous)).toBe(true);
    expect(existsSync(knownGood)).toBe(false);
    expect(existsSync(stale)).toBe(false);
    expect(report.errors).toEqual([]);
    expect(report.removedPaths).toContain('runtime/releases/known-good-release');
    expect(report.removedPaths).toContain('runtime/releases/stale-release');
    expect(report.skippedByReason.release_authority).toBe(2);
  });

  test('preserves only a bounded Recovery bundle that is independently restorable', () => {
    const home = controllerHome();
    const active = runtimeRelease(home, 'active-release');
    const previous = runtimeRelease(home, 'previous-release');
    const knownGood = writeRecoverableKnownGood(home, 'known-good-release');
    const stale = runtimeRelease(home, 'stale-release');
    writeRuntimeAuthority(home, 'active-release', 'previous-release');
    age(knownGood);
    age(stale);

    const report = cleanupControllerReleaseHistory(home, { nowMs: NOW, graceMs: 0, maxRemovals: 20 });

    expect(existsSync(active)).toBe(true);
    expect(existsSync(previous)).toBe(true);
    expect(existsSync(knownGood)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(report.skippedByReason.release_authority).toBe(3);
  });

  test('preserves an explicitly pinned Runtime release while known-good history remains non-owning', () => {
    const home = controllerHome();
    const active = runtimeRelease(home, 'active-release');
    const previous = runtimeRelease(home, 'previous-release');
    const pinned = runtimeRelease(home, 'pinned-release');
    const stale = runtimeRelease(home, 'stale-release');
    writeRuntimeAuthority(home, 'active-release', 'previous-release');
    mkdirSync(join(home, 'recovery', 'state'), { recursive: true });
    writeFileSync(join(home, 'recovery', 'state', 'runtime-pin.json'), `${JSON.stringify({
      schemaVersion: 1,
      release: {
        revision: 'pinned-release',
        path: join(pinned, 'manifest.json'),
        artifactIdentity: `sha256:${'a'.repeat(64)}`,
        manifestSha256: 'b'.repeat(64),
        workerProtocolVersion: 1,
      },
      updatedAt: new Date(NOW).toISOString(),
    }, null, 2)}\n`, 'utf8');
    age(pinned);
    age(stale);

    const report = cleanupControllerReleaseHistory(home, { nowMs: NOW, graceMs: 0, maxRemovals: 20 });

    expect(existsSync(active)).toBe(true);
    expect(existsSync(previous)).toBe(true);
    expect(existsSync(pinned)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(report.errors).toEqual([]);
    expect(report.removedPaths).toContain('runtime/releases/stale-release');
    expect(report.removedPaths).not.toContain('runtime/releases/pinned-release');
    expect(report.skippedByReason.release_authority).toBeGreaterThanOrEqual(3);
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
      periodicSequence: 7,
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

  test('periodic phase rotation prevents release retention starvation under a saturated one-item budget', () => {
    const home = controllerHome();
    runtimeRelease(home, 'active-release');
    runtimeRelease(home, 'previous-release');
    const staleA = runtimeRelease(home, 'stale-release-a');
    const staleB = runtimeRelease(home, 'stale-release-b');
    const backups = join(home, 'runtime', 'releases', 'backups');
    mkdirSync(backups, { recursive: true });
    const referencedBackup = join(backups, 'referenced.sqlite');
    writeFileSync(referencedBackup, 'referenced', 'utf8');
    writeRuntimeAuthority(home, 'active-release', 'previous-release', referencedBackup);
    age(staleA);
    age(staleB);
    const daemon = join(home, 'daemon');
    mkdirSync(daemon, { recursive: true });
    const staleTemp = join(daemon, 'always-stale.tmp');
    writeFileSync(staleTemp, 'temporary\n', 'utf8');
    age(staleTemp);

    const report = cleanupControllerRuntimeState(home, {
      reason: 'periodic',
      periodicSequence: 7,
      nowMs: NOW,
      maxEntries: 100,
      maxRemovals: 1,
      releaseRetentionGraceMs: 0,
      inspectProcess: () => ({ alive: false }),
    });

    expect([staleA, staleB].filter((path) => existsSync(path))).toHaveLength(1);
    expect(existsSync(staleTemp)).toBe(true);
    expect(report.removedReleasePaths).toHaveLength(1);
    expect(report.cycle.removed).toBe(1);
    expect(report.cycle.budgetExhausted).toBe(true);
  });

});
