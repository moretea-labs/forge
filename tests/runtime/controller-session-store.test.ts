import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  bindControllerSessionToCurrentRuntime,
  claimControllerSession,
  controllerSessionBlocksRecovery,
  getControllerSession,
  resumeControllerSession,
} from '../../src/runtime/control-plane/facade/controller-session-store';
import { invalidateExecutionSession, startExecutionSession } from '../../src/runtime/control-plane/execution/session-store';
import { createWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function controllerHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-controller-claim-'));
  roots.push(root);
  return root;
}

function claimInput(sessionId: string, principalId: string, controllerInstanceId: string) {
  return {
    workId: 'work-owner',
    controllerId: principalId,
    controllerType: 'chatgpt' as const,
    sessionId,
    principalId,
    controllerInstanceId,
    leaseMs: 60_000,
  };
}

describe('controller Work ownership fencing', () => {
  test('keeps generation stable for renewal and increments it on controller epoch recovery', () => {
    const home = controllerHome();
    startExecutionSession(home, { sessionId: 'session-a', principalId: 'principal-a', controllerInstanceId: 'instance-a' });
    startExecutionSession(home, { sessionId: 'session-b', principalId: 'principal-a', controllerInstanceId: 'instance-b' });

    const first = claimControllerSession({ controllerHome: home, repoId: 'repo-a' }, claimInput('session-a', 'principal-a', 'instance-a'));
    const renewed = claimControllerSession({ controllerHome: home, repoId: 'repo-a' }, claimInput('session-a', 'principal-a', 'instance-a'));
    const resumed = resumeControllerSession({ controllerHome: home, repoId: 'repo-a' }, {
      ...claimInput('session-b', 'principal-a', 'instance-b'),
      expectedClaimGeneration: renewed.claimGeneration,
    });

    expect(first.claimGeneration).toBe(1);
    expect(renewed.claimGeneration).toBe(1);
    expect(resumed.claimGeneration).toBe(2);
  });

  test('rotates MCP transport session without moving same-principal ownership', () => {
    const home = controllerHome();
    startExecutionSession(home, { sessionId: 'session-a', principalId: 'principal-a', controllerInstanceId: 'instance-a' });
    startExecutionSession(home, { sessionId: 'session-b', principalId: 'principal-a', controllerInstanceId: 'instance-a' });
    const first = claimControllerSession({ controllerHome: home, repoId: 'repo-a' }, claimInput('session-a', 'principal-a', 'instance-a'));

    const resumed = resumeControllerSession({ controllerHome: home, repoId: 'repo-a' }, {
      ...claimInput('session-b', 'principal-a', 'instance-a'),
      expectedClaimGeneration: first.claimGeneration,
    });
    expect(resumed.sessionId).toBe('session-b');
    expect(resumed.claimGeneration).toBe(first.claimGeneration);
  });

  test('does not cross controller-type ownership boundaries during same-principal resume', () => {
    const home = controllerHome();
    const store = { controllerHome: home, repoId: 'repo-a' };
    startExecutionSession(home, { sessionId: 'session-codex', principalId: 'principal-a', controllerInstanceId: 'instance-a' });
    startExecutionSession(home, { sessionId: 'session-chatgpt', principalId: 'principal-a', controllerInstanceId: 'instance-a' });
    const first = claimControllerSession(store, {
      ...claimInput('session-codex', 'principal-a', 'instance-a'),
      controllerType: 'codex',
    });

    expect(() => resumeControllerSession(store, {
      ...claimInput('session-chatgpt', 'principal-a', 'instance-a'),
      expectedClaimGeneration: first.claimGeneration,
    })).toThrow(/WORK_CONTROLLER_TYPE_MISMATCH: work-owner is owned by codex/);
    expect(getControllerSession(store, 'work-owner')).toMatchObject({
      controllerType: 'codex',
      sessionId: 'session-codex',
      claimGeneration: first.claimGeneration,
    });
  });

  test('preserves principal ownership after MCP invalidation while allowing recovery only after the invalidation grace', () => {
    const home = controllerHome();
    startExecutionSession(home, { sessionId: 'session-a', principalId: 'principal-a', controllerInstanceId: 'instance-a' });
    const store = { controllerHome: home, repoId: 'repo-a' };
    const claimed = claimControllerSession(store, claimInput('session-a', 'principal-a', 'instance-a'));

    expect(getControllerSession(store, claimed.workId)?.sessionId).toBe('session-a');
    const invalidated = invalidateExecutionSession(home, 'session-a', 'mcp_transport_client_delete');
    expect(invalidated?.invalidatedAt).toBeTruthy();
    expect(getControllerSession(store, claimed.workId)?.sessionId).toBe('session-a');
    const invalidatedAtMs = Date.parse(invalidated!.invalidatedAt!);
    expect(controllerSessionBlocksRecovery(store, claimed.workId, { nowMs: invalidatedAtMs + 30_000, graceMs: 60_000 })).toBe(true);
    expect(controllerSessionBlocksRecovery(store, claimed.workId, { nowMs: invalidatedAtMs + 2 * 60_000, graceMs: 60_000 })).toBe(false);
    expect(() => claimControllerSession(store, claimInput('session-b', 'principal-b', 'instance-b'))).toThrow(/WORK_ALREADY_CLAIMED/);
  });

  test('rejects claim and resume for an existing terminal Work before persisting ownership', () => {
    const home = controllerHome();
    const store = { controllerHome: home, repoId: 'repo-a' };
    createWorkContract(store, {
      workId: 'work-owner',
      repoId: 'repo-a',
      mode: 'goal_workloop',
      objective: 'terminal work must not revive',
      acceptanceCriteria: ['terminal ownership is fenced'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'failed',
    });
    startExecutionSession(home, { sessionId: 'session-a', principalId: 'principal-a', controllerInstanceId: 'instance-a' });
    startExecutionSession(home, { sessionId: 'session-b', principalId: 'principal-a', controllerInstanceId: 'instance-a' });

    expect(() => claimControllerSession(store, claimInput('session-a', 'principal-a', 'instance-a')))
      .toThrow(/WORK_CONTROLLER_CLAIM_TERMINAL: work-owner:failed/);
    expect(getControllerSession(store, 'work-owner')).toBeUndefined();
    expect(() => resumeControllerSession(store, claimInput('session-b', 'principal-a', 'instance-a')))
      .toThrow(/WORK_CONTROLLER_CLAIM_TERMINAL: work-owner:failed/);
    expect(getControllerSession(store, 'work-owner')).toBeUndefined();
  });

  test('binds a same-principal Work forward only to the positively current Runtime instance', () => {
    const home = controllerHome();
    const store = { controllerHome: home, repoId: 'repo-a' };
    const first = claimControllerSession(store, claimInput('session-old', 'principal-a', 'runtime-old'));

    const migrated = bindControllerSessionToCurrentRuntime(store, {
      ...claimInput('session-new', 'principal-a', 'runtime-new'),
      currentRuntimeInstanceId: 'runtime-new',
    });
    expect(migrated.controllerInstanceId).toBe('runtime-new');
    expect(migrated.sessionId).toBe('session-new');
    expect(migrated.claimGeneration).toBe((first.claimGeneration ?? 1) + 1);

    expect(() => bindControllerSessionToCurrentRuntime(store, {
      ...claimInput('session-stale', 'principal-a', 'runtime-old'),
      currentRuntimeInstanceId: 'runtime-new',
    })).toThrow(/WORK_CONTROLLER_INSTANCE_MISMATCH/);
    expect(getControllerSession(store, 'work-owner')?.controllerInstanceId).toBe('runtime-new');
  });

  test('rejects another principal and stale recovery generation', () => {
    const home = controllerHome();
    startExecutionSession(home, { sessionId: 'session-a', principalId: 'principal-a', controllerInstanceId: 'instance-a' });
    startExecutionSession(home, { sessionId: 'session-b', principalId: 'principal-b', controllerInstanceId: 'instance-b' });
    const first = claimControllerSession({ controllerHome: home, repoId: 'repo-a' }, claimInput('session-a', 'principal-a', 'instance-a'));

    expect(() => resumeControllerSession({ controllerHome: home, repoId: 'repo-a' }, {
      ...claimInput('session-b', 'principal-b', 'instance-b'),
      expectedClaimGeneration: first.claimGeneration,
    })).toThrow(/WORK_CONTROLLER_PRINCIPAL_MISMATCH/);

    expect(() => resumeControllerSession({ controllerHome: home, repoId: 'repo-a' }, {
      ...claimInput('session-a', 'principal-a', 'instance-a'),
      expectedClaimGeneration: 999,
    })).toThrow(/WORK_CLAIM_GENERATION_MISMATCH/);
  });

  test('allows an explicitly authorized stale recovery to rotate controller ownership after the recovery grace', () => {
    const home = controllerHome();
    let nowMs = Date.now();
    const store = {
      controllerHome: home,
      repoId: 'repo-a',
      now: () => new Date(nowMs).toISOString(),
    };
    const first = claimControllerSession(store, {
      ...claimInput('session-old', 'principal-old', 'instance-old'),
      leaseMs: 60 * 60_000,
    });
    const recovery = {
      ...claimInput('session-chatgpt', 'principal-chatgpt', 'instance-chatgpt'),
      leaseMs: 60 * 60_000,
      expectedClaimGeneration: first.claimGeneration,
      allowStaleRecovery: true,
    };

    expect(() => resumeControllerSession(store, recovery)).toThrow(/WORK_CONTROLLER_PRINCIPAL_MISMATCH/);

    nowMs += 6 * 60_000;
    expect(() => resumeControllerSession(store, {
      ...recovery,
      allowStaleRecovery: false,
    })).toThrow(/WORK_CONTROLLER_PRINCIPAL_MISMATCH/);
    const recovered = resumeControllerSession(store, recovery);
    expect(recovered).toMatchObject({
      controllerId: 'principal-chatgpt',
      principalId: 'principal-chatgpt',
      sessionId: 'session-chatgpt',
      controllerInstanceId: 'instance-chatgpt',
      claimGeneration: (first.claimGeneration ?? 1) + 1,
    });
  });
});
