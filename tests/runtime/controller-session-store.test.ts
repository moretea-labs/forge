import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  claimControllerSession,
  resumeControllerSession,
} from '../../src/runtime/control-plane/facade/controller-session-store';
import { startExecutionSession } from '../../src/runtime/control-plane/execution/session-store';

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

  test('does not steal a live same-instance session', () => {
    const home = controllerHome();
    startExecutionSession(home, { sessionId: 'session-a', principalId: 'principal-a', controllerInstanceId: 'instance-a' });
    startExecutionSession(home, { sessionId: 'session-b', principalId: 'principal-a', controllerInstanceId: 'instance-a' });
    const first = claimControllerSession({ controllerHome: home, repoId: 'repo-a' }, claimInput('session-a', 'principal-a', 'instance-a'));

    expect(() => resumeControllerSession({ controllerHome: home, repoId: 'repo-a' }, {
      ...claimInput('session-b', 'principal-a', 'instance-a'),
      expectedClaimGeneration: first.claimGeneration,
    })).toThrow(/WORK_ALREADY_CLAIMED/);
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
});
