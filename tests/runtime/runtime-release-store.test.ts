import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import {
  ensureActiveRuntimeRelease,
  publishRuntimeRelease,
  readRuntimeReleaseAuthority,
  rollbackRuntimeRelease,
} from '../../src/runtime/root/release-store';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const controllerHome = mkdtempSync(join(tmpdir(), 'runtime-release-store-'));
  roots.push(controllerHome);
  const manifests = join(controllerHome, 'manifests');
  mkdirSync(manifests, { recursive: true });
  const manifest = (releaseId: string, artifactIdentity: string, protocol = 1) => {
    const path = join(manifests, `${releaseId}.json`);
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      releaseId,
      artifactIdentity,
      entrypoint: 'repo-harness-runtime',
      arguments: [],
      configurationSchemaVersion: 1,
      controllerHome: resolve(controllerHome),
      databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
      workerProtocolVersion: protocol,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    return path;
  };
  return { controllerHome, manifest };
}

describe('whole Runtime release store', () => {
  test('initializes one active authority and rejects a mismatched startup manifest', () => {
    const fx = fixture();
    const first = fx.manifest('release-a', 'artifact-a');
    const second = fx.manifest('release-b', 'artifact-b');
    expect(ensureActiveRuntimeRelease(fx.controllerHome, first)).toMatchObject({ revision: 1, active: { releaseId: 'release-a' } });
    expect(() => ensureActiveRuntimeRelease(fx.controllerHome, second)).toThrow(/RUNTIME_RELEASE_AUTHORITY_MISMATCH/);
  });

  test('publishes and rolls back the whole Runtime with database backups', () => {
    const fx = fixture();
    const first = fx.manifest('release-a', 'artifact-a');
    const second = fx.manifest('release-b', 'artifact-b', 2);
    ensureActiveRuntimeRelease(fx.controllerHome, first);
    const backups: string[] = [];
    const restores: string[] = [];
    const dependencies = {
      backupDatabase: (_home: string, path: string) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'sqlite-backup');
        backups.push(path);
        return { path, integrity: 'ok' as const, schemaVersion: 1, recordCount: 0, auditEventCount: 0, orphanRecordCount: 0 };
      },
      restoreDatabase: (_home: string, path: string) => {
        restores.push(path);
        expect(readFileSync(path, 'utf8')).toBe('sqlite-backup');
        return { path, integrity: 'ok' as const, schemaVersion: 1, recordCount: 0, auditEventCount: 0, orphanRecordCount: 0 };
      },
    };
    const published = publishRuntimeRelease(fx.controllerHome, second, 'publish-b', dependencies);
    expect(published).toMatchObject({ revision: 2, active: { releaseId: 'release-b', workerProtocolVersion: 2 }, previous: { releaseId: 'release-a' } });
    expect(published.previous?.databaseBackup?.path).toBe(backups[0]);
    const rolled = rollbackRuntimeRelease(fx.controllerHome, 'rollback-a', dependencies);
    expect(rolled).toMatchObject({ revision: 3, active: { releaseId: 'release-a' }, previous: { releaseId: 'release-b' } });
    expect(restores).toEqual([published.previous!.databaseBackup!.path]);
    expect(readRuntimeReleaseAuthority(fx.controllerHome)?.active.releaseId).toBe('release-a');
  });
});
