import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  bindControllerSessionToCurrentRuntime,
  claimControllerSession,
  controllerSessionAuthorityMatches,
  controllerSessionBlocksRecovery,
  getControllerSession,
  mintControllerSessionAuthority,
  resumeControllerSession,
} from '../../src/runtime/control-plane/facade/controller-session-store';
import { bindControllerOwnershipForInvocation, recoverDirectControllerAuthority } from '../../src/runtime/control-plane/execution/controller-authority-recovery';
import { invalidateExecutionSession, startExecutionSession } from '../../src/runtime/control-plane/execution/session-store';
import { createWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { acknowledgeControllerRoundClaim, beginInitialControllerRoundDispatch, claimStalledControllerRoundRelays, finishControllerRoundRelayDispatch, getControllerRoundRelay } from '../../packages/kernel/controller/api/index';

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

  test('stalled round recovery fences a stale live owner before rotating relay authority', () => {
    const home = controllerHome();
    const observedNow = Date.now();
    const staleAt = new Date(observedNow - 10 * 60_000).toISOString();
    const staleStore = { controllerHome: home, repoId: 'repo-a', now: () => staleAt };
    const currentStore = { controllerHome: home, repoId: 'repo-a', now: () => new Date(observedNow).toISOString() };
    createWorkContract(staleStore, {
      workId: 'work-owner',
      repoId: 'repo-a',
      objective: 'recover one stalled ControllerRound without splitting relay and owner authority',
      acceptanceCriteria: ['stale owner is fenced before round capability rotation'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const opened = beginInitialControllerRoundDispatch(staleStore, {
      workId: 'work-owner',
      occurrenceId: 'occurrence-stalled-owner',
      identity: {
        controllerId: 'principal-a',
        controllerType: 'chatgpt',
        principalId: 'principal-a',
        controllerInstanceId: 'runtime-old',
        sessionId: 'session-old',
      },
      maxRepeatedState: 3,
    });
    finishControllerRoundRelayDispatch(staleStore, { workId: 'work-owner', ok: true });
    const owner = claimControllerSession(staleStore, {
      ...claimInput('session-old', 'principal-a', 'runtime-old'),
      leaseMs: 60 * 60_000,
    });
    expect(acknowledgeControllerRoundClaim(staleStore, { workId: 'work-owner', session: owner })?.status).toBe('claimed');
    expect(Date.parse(owner.leaseExpiresAt)).toBeGreaterThan(observedNow);
    expect(controllerSessionBlocksRecovery(currentStore, 'work-owner', { nowMs: observedNow, graceMs: 5 * 60_000 })).toBe(false);

    const recovered = claimStalledControllerRoundRelays(currentStore, {
      nowMs: observedNow,
      graceMs: 5 * 60_000,
      controllerTypes: ['chatgpt'],
    });

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      originWorkId: 'work-owner',
      status: 'dispatching',
      lastError: 'CONTROLLER_RELAY_CLAIMED_ROUND_UNCLOSED',
    });
    expect(recovered[0]!.authorityId).not.toBe(opened.authorityId);
    expect(getControllerSession(currentStore, 'work-owner')).toBeUndefined();
    expect(getControllerRoundRelay(currentStore, 'work-owner')?.authorityId).toBe(recovered[0]!.authorityId);
  });

  test('rejects claim and resume for an existing terminal Work before persisting ownership', () => {
    const home = controllerHome();
    const store = { controllerHome: home, repoId: 'repo-a' };
    createWorkContract(store, {
      workId: 'work-owner',
      repoId: 'repo-a',
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
    const authority = mintControllerSessionAuthority();
    const first = claimControllerSession(store, {
      ...claimInput('session-old', 'principal-a', 'runtime-old'),
      authorityDigest: authority.authorityDigest,
    });

    const migrated = bindControllerSessionToCurrentRuntime(store, {
      ...claimInput('session-new', 'principal-a', 'runtime-new'),
      currentRuntimeInstanceId: 'runtime-new',
    });
    expect(migrated.controllerInstanceId).toBe('runtime-new');
    expect(migrated.sessionId).toBe('session-new');
    expect(migrated.claimGeneration).toBe((first.claimGeneration ?? 1) + 1);
    expect(migrated.authorityDigest).toBe(first.authorityDigest);
    expect(controllerSessionAuthorityMatches(migrated, authority.authorityId)).toBe(true);

    expect(() => bindControllerSessionToCurrentRuntime(store, {
      ...claimInput('session-stale', 'principal-a', 'runtime-old'),
      currentRuntimeInstanceId: 'runtime-new',
    })).toThrow(/WORK_CONTROLLER_INSTANCE_MISMATCH/);
    expect(getControllerSession(store, 'work-owner')?.controllerInstanceId).toBe('runtime-new');
  });

  test('keeps exact relay authority while rebinding the same principal to the positively current Runtime', () => {
    const home = controllerHome();
    const store = { controllerHome: home, repoId: 'repo-a' };
    createWorkContract(store, {
      workId: 'work-owner',
      repoId: 'repo-a',
      objective: 'preserve exact ControllerRound authority across Runtime rotation',
      acceptanceCriteria: ['only the replaceable Work owner binding moves to the new Runtime'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const opened = beginInitialControllerRoundDispatch(store, {
      workId: 'work-owner',
      occurrenceId: 'occurrence-runtime-rotation',
      identity: {
        controllerId: 'principal-a',
        controllerType: 'chatgpt',
        principalId: 'principal-a',
        controllerInstanceId: 'runtime-old',
        sessionId: 'session-old',
      },
    });
    finishControllerRoundRelayDispatch(store, { workId: 'work-owner', ok: true });
    const oldOwner = claimControllerSession(store, claimInput('session-old', 'principal-a', 'runtime-old'));
    expect(acknowledgeControllerRoundClaim(store, { workId: 'work-owner', session: oldOwner })?.status).toBe('claimed');

    const rebound = bindControllerOwnershipForInvocation({
      ...store,
      workId: 'work-owner',
      relayScopeId: opened.relayScopeId,
      identity: {
        controllerId: 'principal-a',
        controllerType: 'chatgpt',
        principalId: 'principal-a',
        controllerInstanceId: 'runtime-new',
        sessionId: 'session-new',
        controllerAuthorityId: opened.authorityId,
      },
      runtime: { running: true, runtimeInstanceId: 'runtime-new' },
    });

    expect(rebound).toMatchObject({
      workId: 'work-owner',
      controllerId: 'principal-a',
      principalId: 'principal-a',
      controllerInstanceId: 'runtime-new',
      sessionId: 'session-new',
      claimGeneration: (oldOwner.claimGeneration ?? 1) + 1,
    });
    expect(getControllerRoundRelay(store, 'work-owner')?.authorityId).toBe(opened.authorityId);

    expect(() => bindControllerOwnershipForInvocation({
      ...store,
      workId: 'work-owner',
      relayScopeId: opened.relayScopeId,
      identity: {
        controllerId: 'principal-a',
        controllerType: 'chatgpt',
        principalId: 'principal-a',
        controllerInstanceId: 'runtime-old',
        sessionId: 'session-stale',
        controllerAuthorityId: opened.authorityId,
      },
      runtime: { running: true, runtimeInstanceId: 'runtime-new' },
    })).toThrow(/WORK_CONTROLLER_INSTANCE_MISMATCH/);
    expect(getControllerRoundRelay(store, 'work-owner')?.authorityId).toBe(opened.authorityId);
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

  test('direct authority recovery fails before mutating durable ownership when the replacement ExecutionSession is invalidated', () => {
    const home = controllerHome();
    const store = { controllerHome: home, repoId: 'repo-a' };
    createWorkContract(store, {
      workId: 'work-owner', repoId: 'repo-a', objective: 'preserve authority on recovery failure',
      acceptanceCriteria: ['failed recovery does not rotate durable authority'], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    startExecutionSession(home, { sessionId: 'session-old', principalId: 'principal-a', controllerInstanceId: 'instance-a' });
    const originalAuthority = mintControllerSessionAuthority();
    const claimed = claimControllerSession(store, {
      ...claimInput('session-old', 'principal-a', 'instance-a'),
      authorityDigest: originalAuthority.authorityDigest,
    });
    invalidateExecutionSession(home, 'session-old', 'mcp_transport_capacity_eviction');
    const before = getControllerSession(store, 'work-owner')!;

    expect(() => recoverDirectControllerAuthority({
      controllerHome: home,
      repoId: 'repo-a',
      workId: 'work-owner',
      requestedBy: 'user',
      identity: {
        controllerId: 'principal-a', controllerType: 'chatgpt', sessionId: 'session-old',
        principalId: 'principal-a', controllerInstanceId: 'instance-a',
      },
      runtime: { running: true, runtimeInstanceId: 'instance-a' },
    })).toThrow(/SESSION_INVALIDATED: mcp_transport_capacity_eviction/);

    const after = getControllerSession(store, 'work-owner')!;
    expect(after).toEqual(before);
    expect(after.authorityDigest).toBe(originalAuthority.authorityDigest);
    expect(after.sessionId).toBe(claimed.sessionId);
    expect(after.claimGeneration).toBe(claimed.claimGeneration);
  });

  test('direct authority recovery validates a fresh ExecutionSession before rotating only the opaque capability', () => {
    const home = controllerHome();
    const store = { controllerHome: home, repoId: 'repo-a' };
    createWorkContract(store, {
      workId: 'work-owner', repoId: 'repo-a', objective: 'recover direct controller authority',
      acceptanceCriteria: ['same semantic owner survives transport loss'], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    startExecutionSession(home, { sessionId: 'session-old', principalId: 'principal-a', controllerInstanceId: 'instance-a' });
    const originalAuthority = mintControllerSessionAuthority();
    const claimed = claimControllerSession(store, {
      ...claimInput('session-old', 'principal-a', 'instance-a'),
      authorityDigest: originalAuthority.authorityDigest,
    });
    invalidateExecutionSession(home, 'session-old', 'mcp_transport_capacity_eviction');

    const recovered = recoverDirectControllerAuthority({
      controllerHome: home,
      repoId: 'repo-a',
      workId: 'work-owner',
      requestedBy: 'user',
      identity: {
        controllerId: 'principal-a', controllerType: 'chatgpt', sessionId: 'session-recovery',
        principalId: 'principal-a', controllerInstanceId: 'instance-a',
      },
      runtime: { running: true, runtimeInstanceId: 'instance-a' },
    });

    expect(recovered.authorityRecovered).toBe(true);
    expect(recovered.controllerAuthorityCarrier).toBe('controller_authority_id_or_session_id_compat');
    expect(recovered.controllerAuthorityId).toMatch(/^ctrl_[a-f0-9]{32}$/);
    expect(recovered.session).toMatchObject({
      workId: 'work-owner', controllerId: 'principal-a', principalId: 'principal-a',
      sessionId: 'session-recovery', controllerInstanceId: 'instance-a', claimGeneration: claimed.claimGeneration,
    });
    expect(recovered.session.authorityDigest).not.toBe(originalAuthority.authorityDigest);
    expect(controllerSessionAuthorityMatches(recovered.session, recovered.controllerAuthorityId)).toBe(true);
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
