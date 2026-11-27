import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { readRuntimeOwner, runtimeOwnerPath } from '../../src/runtime/root/ownership';
import {
  observeRuntimeStatus,
  observeRuntimeStatusAsync,
  writeRuntimeStatusSnapshot,
} from '../../src/runtime/root/status';
import {
  defaultProcessIdentityProbe,
  executableFingerprint,
  processIdentityMatchesAsync,
} from '../../src/runtime/shared/process-identity';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('non-blocking read-only Runtime owner verification', () => {
  test('matches the exact live PID, start time and executable and rejects substitutions', async () => {
    const identity = defaultProcessIdentityProbe.inspect?.(process.pid);
    expect(identity?.command).toBeTruthy();
    expect(identity?.startTime).toBeTruthy();
    const expected = {
      pid: process.pid,
      processStartTime: identity!.startTime!,
      executableFingerprint: executableFingerprint(identity!.command!),
    };
    expect((await processIdentityMatchesAsync(expected, process.pid)).matches).toBe(true);
    expect((await processIdentityMatchesAsync(expected, process.pid + 1)).reason).toBe('pid_changed');
    expect((await processIdentityMatchesAsync({ ...expected, executableFingerprint: 'wrong' }, process.pid)).reason)
      .toBe('executable_fingerprint_changed');
    expect((await processIdentityMatchesAsync({ ...expected, processStartTime: 'wrong' }, process.pid)).reason)
      .toBe('process_start_time_changed');
  });

  test('async status matches synchronous status without loosening stale-owner fencing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-mcp-status-async-'));
    homes.push(home);
    const inspected = defaultProcessIdentityProbe.inspect?.(process.pid);
    expect(inspected?.command).toBeTruthy();
    expect(inspected?.startTime).toBeTruthy();
    const now = new Date().toISOString();
    const owner = {
      schemaVersion: 2 as const,
      runtimeInstanceId: 'runtime-async-probe',
      pid: process.pid,
      acquiredAt: now,
      fencingGeneration: 1,
      processStartTime: inspected!.startTime!,
      executableFingerprint: executableFingerprint(inspected!.command!),
    };
    mkdirSync(dirname(runtimeOwnerPath(home)), { recursive: true });
    writeFileSync(runtimeOwnerPath(home), JSON.stringify(owner));
    writeRuntimeStatusSnapshot(home, {
      schemaVersion: 1,
      runtimeInstanceId: owner.runtimeInstanceId,
      pid: process.pid,
      releaseId: 'test-release',
      artifactIdentity: 'sha256:status-test',
      startedAt: now,
      updatedAt: now,
      readiness: {
        ready: true,
        reasonCodes: [],
        observedAt: now,
        diagnostics: {
          database: { outcome: 'pass' },
          scheduler: { outcome: 'pass' },
          releaseCoherence: { outcome: 'pass' },
          mcpEndToEnd: { outcome: 'pass' },
        },
      },
    });
    expect(readRuntimeOwner(home)?.pid).toBe(process.pid);
    const expected = observeRuntimeStatus(home, () => now);
    const actual = await observeRuntimeStatusAsync(home, () => now);
    expect(actual).toEqual(expected);
    expect(actual.ready).toBe(true);

    writeFileSync(runtimeOwnerPath(home), JSON.stringify({ ...owner, executableFingerprint: 'invalid' }));
    const stale = await observeRuntimeStatusAsync(home, () => now);
    expect(stale.ready).toBe(false);
    expect(stale.stale).toBe(true);
    expect(stale).toEqual(observeRuntimeStatus(home, () => now));
  });
});
