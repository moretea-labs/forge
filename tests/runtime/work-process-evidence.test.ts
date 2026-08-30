import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listWorkBoundRepositoryProcessEvidence, listWorkBoundRepositoryRemoteEffectProcessEvidence } from '../../src/runtime/control-plane/execution/work-process-evidence';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
import type { ManagedProcessRecord } from '../../src/runtime/execution/process-runtime/types';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function processRecord(controllerHome: string, overrides: Partial<ManagedProcessRecord> = {}): ManagedProcessRecord {
  const now = '2026-08-28T00:00:00.000Z';
  const workId = overrides.workId ?? 'work-process-evidence';
  return {
    schemaVersion: 1,
    processId: overrides.processId ?? 'proc-process-evidence',
    repoId: 'repo-process-evidence',
    checkoutId: 'checkout-process-evidence',
    workId,
    commandId: 'command-process-evidence',
    controllerHome,
    status: 'succeeded',
    route: 'managed',
    command: { kind: 'argv', executable: 'node', args: ['-e', 'process.exit(0)'], cwd: '/tmp' },
    origin: {
      surface: 'command',
      toolName: 'repository_command_execute',
      requestId: 'request-process-evidence',
      correlationId: workId,
    },
    resourceClaims: [],
    interactiveWaitMs: 0,
    timeoutMs: 30_000,
    maxOutputBytes: 1_024,
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    exitCode: 0,
    terminalFenceToken: 1,
    terminalWritten: true,
    leaseReleaseState: 'released',
    leasesReleased: true,
    ...overrides,
  };
}

function fixture() {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-process-evidence-'));
  roots.push(controllerHome);
  return { controllerHome, repoId: 'repo-process-evidence', checkoutId: 'checkout-process-evidence', workId: 'work-process-evidence' };
}

describe('Work-bound repository Process evidence', () => {
  test('re-derives an exact successful terminal repository command across store reads', () => {
    const fx = fixture();
    createProcessRecord(processRecord(fx.controllerHome));

    const first = listWorkBoundRepositoryProcessEvidence(fx);
    const afterControllerRotation = listWorkBoundRepositoryProcessEvidence(fx);

    expect(first).toEqual([{ processId: 'proc-process-evidence', commandId: 'command-process-evidence', finishedAt: '2026-08-28T00:00:00.000Z' }]);
    expect(afterControllerRotation).toEqual(first);
  });

  test('rejects unrelated, failed, timed-out, active, malformed-origin, and unfenced terminal records', () => {
    const fx = fixture();
    const variants: Array<Partial<ManagedProcessRecord>> = [
      { processId: 'proc-wrong-work', workId: 'work-other', origin: { surface: 'command', toolName: 'repository_command_execute', correlationId: 'work-other' } },
      { processId: 'proc-wrong-checkout', checkoutId: 'checkout-other' },
      { processId: 'proc-failed', status: 'failed', exitCode: 1 },
      { processId: 'proc-timed-out', status: 'timed_out', exitCode: undefined, timedOut: true },
      { processId: 'proc-active', status: 'running', exitCode: undefined, finishedAt: undefined, terminalWritten: false },
      { processId: 'proc-check', origin: { surface: 'check', toolName: 'repository_command_execute', correlationId: fx.workId } },
      { processId: 'proc-wrong-tool', origin: { surface: 'command', toolName: 'other_tool', correlationId: fx.workId } },
      { processId: 'proc-wrong-correlation', origin: { surface: 'command', toolName: 'repository_command_execute', correlationId: 'work-other' } },
      { processId: 'proc-unfenced-terminal', terminalWritten: false },
    ];
    for (const variant of variants) createProcessRecord(processRecord(fx.controllerHome, variant));

    expect(listWorkBoundRepositoryProcessEvidence(fx)).toEqual([]);
  });

  test('accepts only a trusted Work-bound argv git push holding the exact remote lease as remote-effect completion evidence', () => {
    const fx = fixture();
    createProcessRecord(processRecord(fx.controllerHome, {
      processId: 'proc-trusted-git-push',
      commandId: 'command-trusted-git-push',
      command: { kind: 'argv', executable: '/usr/bin/git', args: ['push', 'origin', 'HEAD:refs/heads/proof'], cwd: '/tmp' },
      identity: { pid: 4242, processStartTime: 'trusted-start', executableFingerprint: 'git-fingerprint', processGroupId: 4242 },
      resourceClaims: [{
        resourceKey: `remote:${fx.repoId}`,
        mode: 'exclusive',
        repoId: fx.repoId,
        checkoutId: fx.checkoutId,
        workId: fx.workId,
      }],
      origin: {
        surface: 'command',
        toolName: 'repository_command_execute',
        requestId: 'request-trusted-git-push',
        correlationId: fx.workId,
      },
    }));
    createProcessRecord(processRecord(fx.controllerHome, {
      processId: 'proc-shell-push',
      command: { kind: 'shell', shellCommand: 'git push origin HEAD', cwd: '/tmp' },
      identity: { pid: 4243, processStartTime: 'trusted-shell', executableFingerprint: 'shell-fingerprint' },
      resourceClaims: [{ resourceKey: `remote:${fx.repoId}`, mode: 'exclusive', repoId: fx.repoId, checkoutId: fx.checkoutId, workId: fx.workId }],
    }));
    createProcessRecord(processRecord(fx.controllerHome, {
      processId: 'proc-untrusted-push',
      command: { kind: 'argv', executable: 'git', args: ['push', 'origin', 'HEAD'], cwd: '/tmp' },
      identity: { pid: 4244, processStartTime: 'untrusted', executableFingerprint: 'git-fingerprint' },
      identityUntrusted: true,
      resourceClaims: [{ resourceKey: `remote:${fx.repoId}`, mode: 'exclusive', repoId: fx.repoId, checkoutId: fx.checkoutId, workId: fx.workId }],
    }));
    createProcessRecord(processRecord(fx.controllerHome, {
      processId: 'proc-no-remote-lease',
      command: { kind: 'argv', executable: 'git', args: ['push', 'origin', 'HEAD'], cwd: '/tmp' },
      identity: { pid: 4245, processStartTime: 'trusted-no-lease', executableFingerprint: 'git-fingerprint' },
      resourceClaims: [],
    }));

    const evidence = listWorkBoundRepositoryRemoteEffectProcessEvidence(fx);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      processId: 'proc-trusted-git-push',
      commandId: 'command-trusted-git-push',
      authority: 'repository_process',
      actionId: 'git_push',
      requestId: 'request-trusted-git-push',
    });
    expect(evidence[0]?.semanticKey).toHaveLength(64);
    expect(evidence[0]?.resultDigest).toHaveLength(64);
  });

});
