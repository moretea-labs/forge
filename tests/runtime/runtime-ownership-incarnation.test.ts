import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executableFingerprint } from '../../src/runtime/shared/process-identity';
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

test('legacy WSL process identity is refreshed only after exact systemd ownership proof', () => {
  const home = createControllerHome('forge-runtime-incarnation-wsl-clock-correction-');
  const acquiredAt = '2026-11-18T07:00:47.407Z';
  const legacyStartTime = 'Wed Nov 18 07:00:46 2026';
  const command = `/opt/forge/runtime/forge-runtime-bun /opt/forge/runtime/forge-runtime-bundle.js --controller-home ${home}`;
  const fingerprint = executableFingerprint(command);
  const stableStartTime = 'linux-proc-start:42e26eaa-30b9-4c32-9bcc-d2548ce76774:4877989';
  const owner = {
    schemaVersion: 2,
    runtimeInstanceId: 'runtime-wsl-clock-correction',
    pid: 4242,
    acquiredAt,
    fencingGeneration: 14,
    processStartTime: legacyStartTime,
    executableFingerprint: fingerprint,
  } as const;
  const incarnation = {
    schemaVersion: 1,
    controllerHome: home,
    runtimeInstanceId: owner.runtimeInstanceId,
    pid: owner.pid,
    fencingGeneration: owner.fencingGeneration,
    activatedAt: acquiredAt,
    processStartTime: legacyStartTime,
    executableFingerprint: fingerprint,
  } as const;
  writeFileSync(runtimeOwnerPath(home), JSON.stringify(owner));
  writeFileSync(runtimeIncarnationPath(home), JSON.stringify(incarnation));

  const probe = {
    isAlive: (pid: number) => pid === owner.pid,
    command: () => command,
    startTime: () => stableStartTime,
    inspect: () => ({ command, startTime: stableStartTime }),
    legacyInspect: () => ({ command, startTime: 'Wed Nov 18 06:56:37 2026' }),
  };
  expect(migrateRuntimeIncarnationProcessIdentity(home, { platform: 'linux', probe })).toMatchObject({
    ok: false,
    changed: false,
    detail: 'RUNTIME_INCARNATION_PROCESS_IDENTITY_NOT_LIVE',
  });
  expect(JSON.parse(readFileSync(runtimeOwnerPath(home), 'utf8'))).toMatchObject({
    processStartTime: legacyStartTime,
  });

  const migrated = migrateRuntimeIncarnationProcessIdentity(home, {
    platform: 'linux',
    probe,
    verifyLegacyProcessOwnership: ({ owner: observedOwner, incarnation: observedIncarnation, observedCommand, observedProcessStartTime }) => (
      observedOwner.pid === owner.pid
      && observedIncarnation.runtimeInstanceId === owner.runtimeInstanceId
      && observedCommand === command
      && observedProcessStartTime === stableStartTime
    ),
  });
  expect(migrated).toMatchObject({ ok: true, changed: true });
  expect(JSON.parse(readFileSync(runtimeOwnerPath(home), 'utf8'))).toMatchObject({
    pid: owner.pid,
    runtimeInstanceId: owner.runtimeInstanceId,
    processStartTime: stableStartTime,
    executableFingerprint: fingerprint,
  });
  expect(JSON.parse(readFileSync(runtimeIncarnationPath(home), 'utf8'))).toMatchObject({
    pid: owner.pid,
    runtimeInstanceId: owner.runtimeInstanceId,
    processStartTime: stableStartTime,
    executableFingerprint: fingerprint,
  });
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
