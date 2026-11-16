import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acquireRuntimeOwnership,
  inspectRuntimeOwnership,
  migrateRuntimeIncarnationProcessIdentity,
  reconcileStoppedRuntimeOwnership,
  runtimeIncarnationPath,
  runtimeOwnerPath,
} from '../../src/runtime/root/ownership';

const controllerHomes: string[] = [];

afterEach(() => {
  for (const home of controllerHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function createControllerHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  controllerHomes.push(home);
  mkdirSync(join(home, 'runtime'), { recursive: true });
  return home;
}

test('stopped Runtime incarnation does not stay live when its PID has been reused', () => {
  const home = createControllerHome('forge-runtime-incarnation-pid-reuse-');
  writeFileSync(runtimeIncarnationPath(home), JSON.stringify({
    schemaVersion: 1,
    controllerHome: home,
    runtimeInstanceId: 'runtime-stopped-before-pid-reuse',
    pid: process.pid,
    fencingGeneration: 11,
    activatedAt: '2026-09-20T00:00:00.000Z',
    processStartTime: 'stale-runtime-start-time',
    executableFingerprint: 'stale-runtime-executable',
  }, null, 2));

  expect(inspectRuntimeOwnership(home)).toMatchObject({
    coherent: false,
    ownerAlive: false,
    incarnationAlive: false,
  });
  expect(reconcileStoppedRuntimeOwnership(home)).toMatchObject({
    ok: true,
    changed: false,
    detail: 'Runtime ownership is already quiescent',
  });
  expect(existsSync(runtimeIncarnationPath(home))).toBe(true);
});

test('legacy incarnation without process identity remains conservative for a live PID', () => {
  const home = createControllerHome('forge-runtime-incarnation-legacy-');
  writeFileSync(runtimeIncarnationPath(home), JSON.stringify({
    schemaVersion: 1,
    controllerHome: home,
    runtimeInstanceId: 'runtime-legacy-incarnation',
    pid: process.pid,
    fencingGeneration: 12,
    activatedAt: '2026-09-20T00:00:00.000Z',
  }, null, 2));

  expect(inspectRuntimeOwnership(home)).toMatchObject({
    coherent: false,
    ownerAlive: false,
    incarnationAlive: true,
  });
  expect(reconcileStoppedRuntimeOwnership(home)).toMatchObject({
    ok: false,
    changed: false,
    detail: 'RUNTIME_OWNERSHIP_STILL_LIVE',
  });
});

test('legacy Stable A incarnation is migrated from its exact live owner before ReleaseSession preparation', () => {
  const home = createControllerHome('forge-runtime-incarnation-migration-');
  const ownership = acquireRuntimeOwnership(home, 'runtime-legacy-stable-owner');
  try {
    const incarnation = JSON.parse(readFileSync(runtimeIncarnationPath(home), 'utf8')) as Record<string, unknown>;
    delete incarnation.processStartTime;
    delete incarnation.executableFingerprint;
    writeFileSync(runtimeIncarnationPath(home), JSON.stringify(incarnation, null, 2));

    expect(migrateRuntimeIncarnationProcessIdentity(home)).toMatchObject({ ok: true, changed: true });
    const migrated = JSON.parse(readFileSync(runtimeIncarnationPath(home), 'utf8')) as Record<string, unknown>;
    expect(migrated.processStartTime).toBe(ownership.record.processStartTime);
    expect(migrated.executableFingerprint).toBe(ownership.record.executableFingerprint);
    expect(inspectRuntimeOwnership(home)).toMatchObject({ coherent: true, ownerAlive: true, incarnationAlive: true });
  } finally {
    ownership.release();
  }
});

test('legacy incarnation cannot be migrated after its owner lease disappears', () => {
  const home = createControllerHome('forge-runtime-incarnation-migration-owner-missing-');
  writeFileSync(runtimeIncarnationPath(home), JSON.stringify({
    schemaVersion: 1,
    controllerHome: home,
    runtimeInstanceId: 'runtime-legacy-owner-missing',
    pid: process.pid,
    fencingGeneration: 13,
    activatedAt: '2026-09-20T00:00:00.000Z',
  }, null, 2));

  expect(migrateRuntimeIncarnationProcessIdentity(home)).toMatchObject({
    ok: false,
    changed: false,
    detail: 'RUNTIME_INCARNATION_IDENTITY_MIGRATION_OWNER_REQUIRED',
  });
  const unchanged = JSON.parse(readFileSync(runtimeIncarnationPath(home), 'utf8')) as Record<string, unknown>;
  expect(unchanged.processStartTime).toBeUndefined();
  expect(unchanged.executableFingerprint).toBeUndefined();
});

test('new incarnation preserves exact live process identity after the owner lease disappears', () => {
  const home = createControllerHome('forge-runtime-incarnation-live-');
  const ownership = acquireRuntimeOwnership(home, 'runtime-exact-live-owner');
  try {
    const incarnation = JSON.parse(readFileSync(runtimeIncarnationPath(home), 'utf8')) as Record<string, unknown>;
    expect(incarnation).toMatchObject({
      runtimeInstanceId: 'runtime-exact-live-owner',
      pid: process.pid,
    });
    expect(incarnation.processStartTime).toBe(ownership.record.processStartTime);
    expect(incarnation.executableFingerprint).toBe(ownership.record.executableFingerprint);

    rmSync(runtimeOwnerPath(home), { force: true });
    expect(inspectRuntimeOwnership(home)).toMatchObject({
      ownerAlive: false,
      incarnationAlive: true,
    });
    expect(reconcileStoppedRuntimeOwnership(home)).toMatchObject({
      ok: false,
      changed: false,
      detail: 'RUNTIME_OWNERSHIP_STILL_LIVE',
    });
  } finally {
    ownership.release();
  }
});
